import { WEBHOOK_JOB_NAME, webhookJobSchema, type WebhookJob } from "@sce/shared"
import { Queue, Worker, type Job, type JobsOptions } from "bullmq"
import { redis } from "./connection.ts"
import { queueConfig } from "./env.ts"
import { WEBHOOK_QUEUE, webhookJobId } from "./names.ts"
import { localJobMeta, type JobMeta } from "./queues.ts"

/**
 * The delivery queue for outbound webhooks.
 *
 * Deliberately a *separate* queue from the run flow, and the reason is the one
 * thing that goes wrong with webhooks at scale: a delivery waits on a stranger's
 * server, and a stranger's server can be slow for hours. Sharing concurrency
 * with the candidate queue would let one customer's unreachable endpoint occupy
 * the slots every other customer's run needs to finish. Separate queues make
 * that impossible rather than unlikely.
 *
 * Retries are the queue's, not this module's: BullMQ's exponential backoff is
 * the same mechanism the run flow uses, already tested and already visible in
 * the operator's dashboard. What the *processor* adds — see
 * `packages/worker/src/webhooks.ts` — is the decision about which failures are
 * worth retrying at all, because retrying a 400 six times only teaches the
 * receiver that we do not read their responses.
 */

export interface WebhookQueue {
  /** Enqueue one delivery. Idempotent for a given delivery id. */
  enqueue(job: WebhookJob): Promise<void>
  close(): Promise<void>
}

function webhookJobOptions(): JobsOptions {
  return {
    attempts: queueConfig.WEBHOOK_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: queueConfig.WEBHOOK_BACKOFF_MS },
    removeOnComplete: { count: queueConfig.QUEUE_KEEP_COMPLETED },
    /*
     * Deliveries do not accumulate in the failed set, because they do not fail:
     * a processor that has exhausted its attempts records `FAILED` on the
     * delivery row and returns normally. The delivery log is a better
     * dead-letter queue than BullMQ's failed set could be here — it is per
     * endpoint, per event, replayable, and visible to the customer whose
     * integration is broken. The small retention below is for genuine
     * processor bugs, which do still throw.
     */
    removeOnFail: { count: 1_000 },
  }
}

let webhookQueueHandleRef: Queue<WebhookJob> | null = null

/** Handle for inspection and depth metrics. The queue below owns the writes. */
export function webhookQueueHandle(): Queue<WebhookJob> {
  webhookQueueHandleRef ??= new Queue<WebhookJob>(WEBHOOK_QUEUE, { connection: redis() })
  return webhookQueueHandleRef
}

export class BullWebhookQueue implements WebhookQueue {
  async enqueue(job: WebhookJob): Promise<void> {
    await webhookQueueHandle().add(WEBHOOK_JOB_NAME, job, {
      ...webhookJobOptions(),
      jobId: webhookJobId(job.deliveryId),
    })
  }

  async close(): Promise<void> {
    await webhookQueueHandleRef?.close()
    webhookQueueHandleRef = null
  }
}

/**
 * What a delivery actually does. Supplied by `@sce/worker`, so this package
 * never has to know what an HMAC is.
 */
export type WebhookJobHandler = (job: WebhookJob, meta: JobMeta) => Promise<void>

let localWebhookHandler: WebhookJobHandler | null = null

/** Register the in-process processor used by `RUN_TRANSPORT=local`. */
export function setLocalWebhookJobHandler(handler: WebhookJobHandler | null): void {
  localWebhookHandler = handler
}

/**
 * In-process delivery, for `RUN_TRANSPORT=local` and for tests.
 *
 * One attempt, no backoff — which the processor is told through `JobMeta`, so
 * it records a failure as terminal rather than waiting for a retry that will
 * never come. A local delivery that fails is still in the log and still
 * replayable; it simply does not get its five automatic second chances.
 */
export class LocalWebhookQueue implements WebhookQueue {
  readonly #inFlight = new Set<Promise<void>>()

  async enqueue(job: WebhookJob): Promise<void> {
    const handler = localWebhookHandler
    // Not an error: an install running the API without a worker still records
    // its deliveries, and an operator replays them once a worker exists.
    // Throwing here would fail the run that emitted the event.
    if (handler === null) return

    const task = handler(job, localJobMeta(webhookJobId(job.deliveryId)))
      .catch((error: unknown) => {
        console.error("[queue:local] webhook handler threw", {
          deliveryId: job.deliveryId,
          error,
        })
      })
      .finally(() => {
        this.#inFlight.delete(task)
      })
    this.#inFlight.add(task)
  }

  async close(): Promise<void> {
    await Promise.all([...this.#inFlight])
  }
}

let queue: WebhookQueue | null = null

export function webhookQueue(): WebhookQueue {
  queue ??= queueConfig.RUN_TRANSPORT === "local" ? new LocalWebhookQueue() : new BullWebhookQueue()
  return queue
}

/** Swap the implementation. Tests use this; production reads the env instead. */
export function setWebhookQueue(next: WebhookQueue): void {
  queue = next
}

/**
 * The consumer.
 *
 * The payload is parsed before the processor sees it, exactly as the run
 * queue's factories do: job data is whatever was serialised into Redis,
 * possibly by an older build, so a processor's parameter type has to be a
 * guarantee rather than a hope.
 */
export function createWebhookWorker(
  process: (job: WebhookJob, meta: JobMeta) => Promise<void>,
): Worker<WebhookJob, void> {
  return new Worker<WebhookJob, void>(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookJob, void>) => {
      await process(webhookJobSchema.parse(job.data), webhookJobMeta(job))
    },
    { connection: redis(), concurrency: queueConfig.WEBHOOK_CONCURRENCY },
  )
}

function webhookJobMeta(job: Job<WebhookJob, void>): JobMeta {
  const maxAttempts = job.opts.attempts ?? 1
  const attempt = job.attemptsMade + 1
  return { id: job.id ?? "unknown", attempt, maxAttempts, isFinalAttempt: attempt >= maxAttempts }
}
