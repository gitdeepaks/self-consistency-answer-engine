import { queueConfig } from "./env.ts"

/**
 * Every Redis key and queue name the system uses, in one place.
 *
 * Derived from `REDIS_NAMESPACE` so staging and production can share an
 * instance without a staging worker ever claiming a production job — the class
 * of mistake that is obvious in hindsight and invisible at the call site when
 * key names are string-concatenated wherever they are needed.
 */

const ns = queueConfig.REDIS_NAMESPACE

/** Fan-out jobs: one per panel member per run. */
export const CANDIDATE_QUEUE = `${ns}.candidate`

/** Synthesis jobs: one per run, parent of that run's candidate jobs. */
export const SYNTHESIS_QUEUE = `${ns}.synthesis`

/**
 * Outbound webhook deliveries.
 *
 * A separate queue rather than a job type on an existing one, because the two
 * have opposite shapes: a candidate job is expensive, bounded and internal,
 * while a delivery is cheap, unbounded in count and waits on a stranger's
 * server. Sharing a queue would let one slow receiver's backlog occupy the
 * concurrency a run needs to finish.
 */
export const WEBHOOK_QUEUE = `${ns}.webhook`

/** Live progress tail for one run. Postgres holds the durable copy. */
export function runStreamKey(runId: string): string {
  return `${ns}:run:${runId}:events`
}

/**
 * Pub/sub channel that carries a cancellation to whichever worker holds the run.
 *
 * The database flag is authoritative; this only makes the news travel fast
 * enough to abort a model call that is already streaming, rather than waiting
 * for the next checkpoint between steps.
 */
export function runCancelChannel(runId: string): string {
  return `${ns}:run:${runId}:cancel`
}

/**
 * A rate-limit window for one caller against one route budget.
 *
 * The caller half is a credential id, a user id or an IP — never a raw API key,
 * which would put a live secret in a Redis key name and in every `SLOWLOG`
 * entry that touched it.
 */
export function rateLimitKey(bucket: string, subject: string): string {
  return `${ns}:ratelimit:${bucket}:${subject}`
}

/** Per-provider circuit breaker state, shared across the worker fleet. */
export function breakerKey(providerId: string): string {
  return `${ns}:breaker:${providerId}`
}

/**
 * Deterministic job ids.
 *
 * BullMQ treats an add with an existing job id as a no-op, so a retried enqueue
 * of the same run cannot fan out a second panel. This is the queue half of
 * idempotency; the `Run.idempotencyKey` unique index is the API half.
 *
 * The separator is `-`, not `:`. BullMQ reserves colons in a custom job id for
 * its own repeatable-job encoding and rejects anything else that uses them, so
 * the obvious-looking `cand:<run>:<candidate>` fails at enqueue time. Run and
 * candidate ids are cuids — alphanumeric — so a hyphen cannot collide either.
 */
export function candidateJobId(runId: string, candidateId: string): string {
  return `cand-${runId}-${candidateId}`
}

export function synthesisJobId(runId: string): string {
  return `synth-${runId}`
}

/**
 * One job per delivery row.
 *
 * The delivery id already identifies exactly one event addressed to exactly one
 * endpoint — the `(endpointId, eventId)` unique index guarantees it — so this
 * makes a redelivered emission job a no-op at the queue as well as at the
 * database, which is belt and braces on the one guarantee a customer notices
 * when it is missing.
 */
export function webhookJobId(deliveryId: string): string {
  return `hook-${deliveryId}`
}
