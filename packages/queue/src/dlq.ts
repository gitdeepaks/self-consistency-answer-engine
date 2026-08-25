import type { CandidateJob, SynthesisJob } from "@sce/shared"
import type { Job, Queue } from "bullmq"
import { CANDIDATE_QUEUE, SYNTHESIS_QUEUE } from "./names.ts"
import { candidateQueueHandle, synthesisQueueHandle } from "./queues.ts"

/**
 * The dead-letter queue.
 *
 * There is no separate DLQ topic, because BullMQ already has one: a job that
 * exhausts its attempts moves to the queue's failed set, taking its payload,
 * its failure reason, its stack trace and its full attempt history with it.
 * Routing those jobs to a second queue would only lose the linkage back to the
 * flow they belonged to. What was missing was not the storage — it was a way to
 * *look at it* and *put it back*, which is what this module is.
 *
 * Note what does **not** arrive here. A model that returns an error is not a
 * failed job: the candidate processor records it on the candidate row and
 * returns successfully, because a provider having a bad day is a normal
 * outcome. Only infrastructure failures — the database unreachable, the payload
 * unparseable, a bug in the processor — exhaust their attempts and land in the
 * dead-letter queue. That distinction is what keeps this list worth reading.
 */

export type DeadLetterQueueName = typeof CANDIDATE_QUEUE | typeof SYNTHESIS_QUEUE

export interface DeadLetter {
  queue: DeadLetterQueueName
  jobId: string
  name: string
  /** The job payload, exactly as the processor would have received it. */
  data: CandidateJob | SynthesisJob
  attemptsMade: number
  failedReason: string
  stacktrace: string[]
  failedAt: string | null
}

function describe(
  queue: DeadLetterQueueName,
  job: Job<CandidateJob | SynthesisJob, void>,
): DeadLetter {
  return {
    queue,
    jobId: job.id ?? "unknown",
    name: job.name,
    data: job.data,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason ?? "unknown",
    stacktrace: job.stacktrace ?? [],
    failedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn).toISOString(),
  }
}

interface Target {
  name: DeadLetterQueueName
  handle: () => Queue<CandidateJob> | Queue<SynthesisJob>
}

const TARGETS: readonly Target[] = [
  { name: CANDIDATE_QUEUE, handle: candidateQueueHandle },
  { name: SYNTHESIS_QUEUE, handle: synthesisQueueHandle },
]

function targetFor(queue: DeadLetterQueueName): Target {
  const found = TARGETS.find((target) => target.name === queue)
  if (!found) throw new Error(`Unknown queue: ${queue}`)
  return found
}

/** Every failed job across both queues, newest first. */
export async function listDeadLetters(options: { limit?: number } = {}): Promise<DeadLetter[]> {
  const limit = options.limit ?? 50

  const perQueue = await Promise.all(
    TARGETS.map(async (target) => {
      const jobs = await target.handle().getFailed(0, limit - 1)
      return jobs.map((job) => describe(target.name, job))
    }),
  )

  return perQueue
    .flat()
    .sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? ""))
    .slice(0, limit)
}

/**
 * Put one dead letter back on the queue.
 *
 * `retry()` resets the attempt counter and re-queues the *same* job id, so the
 * flow parent it belonged to is still waiting for it. Replaying is therefore
 * safe with respect to double-charging: the candidate row it targets is read
 * fresh, and a candidate that already settled `OK` is left alone by the
 * processor's own idempotency check.
 */
export async function replayDeadLetter(
  queue: DeadLetterQueueName,
  jobId: string,
): Promise<boolean> {
  const job = await targetFor(queue).handle().getJob(jobId)
  if (!job) return false
  await job.retry("failed")
  return true
}

/** Replay every dead letter. Returns how many were re-queued. */
export async function replayAllDeadLetters(options: { limit?: number } = {}): Promise<number> {
  const letters = await listDeadLetters(options)
  const results = await Promise.all(
    letters.map((letter) => replayDeadLetter(letter.queue, letter.jobId)),
  )
  return results.filter(Boolean).length
}

/**
 * Discard dead letters permanently.
 *
 * Separate from replay and never automatic: throwing away the record of what
 * broke is a decision an operator makes on purpose, after reading it.
 */
export async function purgeDeadLetters(olderThan?: Date): Promise<number> {
  const graceMs = olderThan === undefined ? 0 : Math.max(0, Date.now() - olderThan.getTime())
  const cleaned = await Promise.all(
    TARGETS.map((target) => target.handle().clean(graceMs, 10_000, "failed")),
  )
  return cleaned.reduce((total, ids) => total + ids.length, 0)
}

/** Queue depth and health, for the operator and for Phase 8's metrics. */
export interface QueueDepth {
  queue: DeadLetterQueueName
  waiting: number
  active: number
  delayed: number
  failed: number
  completed: number
  waitingChildren: number
}

export async function queueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    TARGETS.map(async (target) => {
      const counts = await target
        .handle()
        .getJobCounts("waiting", "active", "delayed", "failed", "completed", "waiting-children")
      return {
        queue: target.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
        waitingChildren: counts["waiting-children"] ?? 0,
      }
    }),
  )
}
