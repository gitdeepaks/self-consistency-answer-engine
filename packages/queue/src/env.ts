import { loadRootEnv } from "@sce/shared"
import { z } from "zod"

// Must run before anything below reads process.env.
loadRootEnv()

/**
 * Configuration for the Redis control plane, parsed once at import time.
 *
 * Every value is validated here rather than coerced at the point of use, so a
 * typo in `REDIS_URL` or a negative `QUEUE_CONCURRENCY` fails the process at
 * boot with the offending field named — instead of surfacing as a worker that
 * silently processes zero jobs, or a stream that silently keeps zero history.
 */

const positiveInt = z.coerce.number().int().positive()

const durationMs = positiveInt.max(24 * 60 * 60 * 1000, "duration must be under 24 hours")

const queueEnvSchema = z.object({
  /** Connection string for the queue and the progress bus. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default("redis://localhost:6379"),

  /**
   * `redis` runs the real Redis-backed queue and bus. `local` keeps both in the
   * process that created them.
   *
   * `local` is the migration flag from Phase 2's risk note: it is the old
   * in-process path, still reachable, so a single-machine deployment or a test
   * can run the exact same processors without Redis. It cannot scale past one
   * replica, and it says so at boot.
   */
  RUN_TRANSPORT: z.enum(["redis", "local"]).default("redis"),

  /** Key prefix, so several environments can share one Redis instance. */
  REDIS_NAMESPACE: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "REDIS_NAMESPACE may only contain A-Z a-z 0-9 _ -")
    .default("sce"),

  /**
   * How many events each run's Redis Stream keeps.
   *
   * The stream is a live tail, not the archive — Postgres is the archive — so
   * this only has to cover the gap between a client disconnecting and
   * reconnecting. Trimming is approximate (`MAXLEN ~`), which is dramatically
   * cheaper and costs nothing but a few extra retained entries.
   */
  RUN_STREAM_MAX_LEN: positiveInt.max(100_000).default(2_000),

  /** How long a finished run's stream lingers before Redis expires it. */
  RUN_STREAM_TTL_MS: durationMs.default(15 * 60_000),

  /** Blocking read timeout; also the interval between SSE keep-alive frames. */
  RUN_STREAM_BLOCK_MS: durationMs.default(15_000),

  /** Candidate jobs processed concurrently by one worker instance. */
  QUEUE_CONCURRENCY: positiveInt.max(256).default(8),

  /** Queue-level delivery attempts per candidate job before it is given up on. */
  QUEUE_MAX_ATTEMPTS: positiveInt.max(20).default(3),

  /** Base delay for the queue's exponential backoff between attempts. */
  QUEUE_BACKOFF_MS: durationMs.default(2_000),

  /** How long a completed job's record is kept, for the operator's benefit. */
  QUEUE_KEEP_COMPLETED: z.coerce.number().int().nonnegative().max(100_000).default(1_000),

  /**
   * Failed jobs kept for inspection and replay. This is the dead-letter queue:
   * BullMQ's failed set with removal disabled, which retains the payload, the
   * failure reason and the stack that produced it.
   */
  QUEUE_KEEP_FAILED: z.coerce.number().int().nonnegative().max(100_000).default(10_000),
})

export type QueueEnv = z.infer<typeof queueEnvSchema>

function parseEnv(source: Readonly<Record<string, string | undefined>>): QueueEnv {
  const parsed = queueEnvSchema.safeParse(source)
  if (parsed.success) return parsed.data

  const report = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  throw new Error(`Invalid queue configuration:\n${report}`)
}

export const queueConfig: QueueEnv = parseEnv(process.env)

/** Exposed so tests can assert the failure report without mutating the process. */
export { parseEnv as parseQueueEnv }
