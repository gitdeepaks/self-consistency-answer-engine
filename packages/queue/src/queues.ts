import {
  CANDIDATE_JOB_NAME,
  SYNTHESIS_JOB_NAME,
  candidateJobSchema,
  synthesisJobSchema,
  type CandidateJob,
  type SynthesisJob,
} from "@sce/shared"
import { FlowProducer, Queue, Worker, type Job, type JobsOptions } from "bullmq"
import { redis } from "./connection.ts"
import { queueConfig } from "./env.ts"
import {
  CANDIDATE_QUEUE,
  SYNTHESIS_QUEUE,
  candidateJobId,
  synthesisJobId,
} from "./names.ts"

/**
 * The run queue.
 *
 * A run is not one job. It is a **flow**: one synthesis job that is the parent
 * of one candidate job per panel member. BullMQ holds the parent in
 * `waiting-children` until every child settles, which buys three properties the
 * previous single `async` function could not have:
 *
 *   - a worker that dies mid-fan-out loses **one candidate**, not the run;
 *   - candidates spread across the whole worker pool instead of one process;
 *   - the synthesis step is itself retryable, independently of the fan-out that
 *     produced its input.
 *
 * Children are added with `ignoreDependencyOnFailure` so that a candidate which
 * exhausts its attempts cannot strand the parent forever. That is the queue-level
 * expression of the same rule the orchestrator has always had: one panel member
 * failing is a partial result, not a failed run.
 */

export interface EnqueueRunInput {
  tenantId: string
  runId: string
  /** Candidate rows to fan out. Already-skipped panel members are not included. */
  candidateIds: readonly string[]
}

export interface RunQueue {
  /** Enqueue a run's fan-out and synthesis. Idempotent for a given run id. */
  enqueueRun(input: EnqueueRunInput): Promise<void>
  close(): Promise<void>
}

/**
 * Job options shared by both queues.
 *
 * `removeOnFail: false` (expressed as a retained count) is deliberate: BullMQ's
 * failed set *is* the dead-letter queue. Keeping the payload, the failure
 * reason and the stack is what makes `sce-worker dlq replay` possible at all.
 */
function jobOptions(attempts: number): JobsOptions {
  return {
    attempts,
    backoff: { type: "exponential", delay: queueConfig.QUEUE_BACKOFF_MS },
    removeOnComplete: { count: queueConfig.QUEUE_KEEP_COMPLETED },
    removeOnFail: { count: queueConfig.QUEUE_KEEP_FAILED },
  }
}

/* ------------------------------------------------------------- bullmq queue */

let flowProducer: FlowProducer | null = null
let candidateQueue: Queue<CandidateJob> | null = null
let synthesisQueue: Queue<SynthesisJob> | null = null

function flow(): FlowProducer {
  flowProducer ??= new FlowProducer({ connection: redis() })
  return flowProducer
}

/** Handles for inspection and replay. The producers above own the writes. */
export function candidateQueueHandle(): Queue<CandidateJob> {
  candidateQueue ??= new Queue<CandidateJob>(CANDIDATE_QUEUE, { connection: redis() })
  return candidateQueue
}

export function synthesisQueueHandle(): Queue<SynthesisJob> {
  synthesisQueue ??= new Queue<SynthesisJob>(SYNTHESIS_QUEUE, { connection: redis() })
  return synthesisQueue
}

export class BullRunQueue implements RunQueue {
  async enqueueRun(input: EnqueueRunInput): Promise<void> {
    const children = input.candidateIds.map((candidateId) => ({
      name: CANDIDATE_JOB_NAME,
      queueName: CANDIDATE_QUEUE,
      data: { tenantId: input.tenantId, runId: input.runId, candidateId },
      opts: {
        ...jobOptions(queueConfig.QUEUE_MAX_ATTEMPTS),
        // Deterministic id: a retried enqueue of the same run is a no-op rather
        // than a second, identically expensive fan-out.
        jobId: candidateJobId(input.runId, candidateId),
        // A child that gives up must not strand the parent in waiting-children.
        ignoreDependencyOnFailure: true,
      },
    }))

    await flow().add({
      name: SYNTHESIS_JOB_NAME,
      queueName: SYNTHESIS_QUEUE,
      data: { tenantId: input.tenantId, runId: input.runId },
      opts: { ...jobOptions(queueConfig.QUEUE_MAX_ATTEMPTS), jobId: synthesisJobId(input.runId) },
      children,
    })
  }

  async close(): Promise<void> {
    await Promise.all([
      flowProducer?.close(),
      candidateQueue?.close(),
      synthesisQueue?.close(),
    ])
    flowProducer = null
    candidateQueue = null
    synthesisQueue = null
  }
}

/* -------------------------------------------------------------- local queue */

/**
 * What a job actually does. Supplied by `@sce/worker`, so this package never
 * has to know what a model call is.
 */
export interface RunJobHandlers {
  candidate(job: CandidateJob, meta: JobMeta): Promise<void>
  synthesis(job: SynthesisJob, meta: JobMeta): Promise<void>
}

let localHandlers: RunJobHandlers | null = null

/** Register the in-process processors used by `RUN_TRANSPORT=local`. */
export function setLocalRunJobHandlers(handlers: RunJobHandlers | null): void {
  localHandlers = handlers
}

/**
 * In-process execution of the same flow.
 *
 * This is the migration flag from Phase 2's risk note and the path tests take:
 * identical processors, identical ordering (all candidates, then synthesis),
 * no Redis. It does not survive a restart and cannot be scaled — which is the
 * entire reason the Redis path exists, and why this one announces itself at boot.
 */
export class LocalRunQueue implements RunQueue {
  /** In-flight runs, so a graceful shutdown can wait for them. */
  readonly #inFlight = new Set<Promise<void>>()

  async enqueueRun(input: EnqueueRunInput): Promise<void> {
    const handlers = localHandlers
    if (!handlers) {
      throw new Error(
        "RUN_TRANSPORT=local but no job handlers are registered. " +
          "Import @sce/worker in this process, or set RUN_TRANSPORT=redis and run a worker.",
      )
    }

    const task = this.#execute(handlers, input).finally(() => {
      this.#inFlight.delete(task)
    })
    this.#inFlight.add(task)
  }

  async #execute(handlers: RunJobHandlers, input: EnqueueRunInput): Promise<void> {
    // Candidates settle their own rows and never reject, mirroring the queue
    // path where a failed child is ignored rather than fatal.
    await Promise.all(
      input.candidateIds.map((candidateId) =>
        handlers
          .candidate(
            { tenantId: input.tenantId, runId: input.runId, candidateId },
            localJobMeta(candidateJobId(input.runId, candidateId)),
          )
          .catch((error: unknown) => {
            console.error("[queue:local] candidate handler threw", { candidateId, error })
          }),
      ),
    )

    await handlers
      .synthesis(
        { tenantId: input.tenantId, runId: input.runId },
        localJobMeta(synthesisJobId(input.runId)),
      )
      .catch((error: unknown) => {
        console.error("[queue:local] synthesis handler threw", { runId: input.runId, error })
      })
  }

  /** Wait for every in-flight run. The local analogue of draining a worker. */
  async close(): Promise<void> {
    await Promise.all([...this.#inFlight])
  }
}

/* --------------------------------------------------------------- selection */

let queue: RunQueue | null = null

export function runQueue(): RunQueue {
  queue ??= queueConfig.RUN_TRANSPORT === "local" ? new LocalRunQueue() : new BullRunQueue()
  return queue
}

/** Swap the implementation. Tests use this; production reads the env instead. */
export function setRunQueue(next: RunQueue): void {
  queue = next
}

/* ---------------------------------------------------------------- workers */

/**
 * Job data arrives as whatever was serialised into Redis, possibly by an older
 * build. Both worker factories parse it before the processor sees it, so a
 * processor's parameter type is a guarantee rather than a hope.
 */
export function createCandidateWorker(
  process: (job: CandidateJob, meta: JobMeta) => Promise<void>,
): Worker<CandidateJob, void> {
  return new Worker<CandidateJob, void>(
    CANDIDATE_QUEUE,
    async (job: Job<CandidateJob, void>) => {
      await process(candidateJobSchema.parse(job.data), jobMeta(job))
    },
    { connection: redis(), concurrency: queueConfig.QUEUE_CONCURRENCY },
  )
}

export function createSynthesisWorker(
  process: (job: SynthesisJob, meta: JobMeta) => Promise<void>,
): Worker<SynthesisJob, void> {
  return new Worker<SynthesisJob, void>(
    SYNTHESIS_QUEUE,
    async (job: Job<SynthesisJob, void>) => {
      await process(synthesisJobSchema.parse(job.data), jobMeta(job))
    },
    // Synthesis is one call per run and gates the run's completion; a lower
    // ceiling than the fan-out keeps a burst of finishing runs from crowding
    // out the candidates still generating.
    { connection: redis(), concurrency: Math.max(1, Math.ceil(queueConfig.QUEUE_CONCURRENCY / 2)) },
  )
}

/**
 * What the processor needs to know about *this delivery* of the job, as opposed
 * to the work itself.
 *
 * `isFinalAttempt` is the important one: it lets a processor decide between
 * "throw, so the queue retries with backoff" and "this is the last chance, so
 * record the failure on the row while I still can". Without it, the terminal
 * state of a candidate would have to be written from a `failed` event handler,
 * racing the next job.
 */
export interface JobMeta {
  id: string
  attempt: number
  maxAttempts: number
  isFinalAttempt: boolean
}

function jobMeta(job: Job<CandidateJob | SynthesisJob, void>): JobMeta {
  const maxAttempts = job.opts.attempts ?? 1
  const attempt = job.attemptsMade + 1
  return { id: job.id ?? "unknown", attempt, maxAttempts, isFinalAttempt: attempt >= maxAttempts }
}

/** The meta a locally-executed job reports: one shot, no queue retries. */
export function localJobMeta(id: string): JobMeta {
  return { id, attempt: 1, maxAttempts: 1, isFinalAttempt: true }
}
