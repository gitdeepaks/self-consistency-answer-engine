import { Redis, type RedisOptions } from "ioredis"
import { queueConfig } from "./env.ts"

/**
 * Redis connections, pooled by role.
 *
 * Redis multiplexes ordinary commands on one socket, but a connection that is
 * blocked in `XREAD BLOCK` or subscribed to a channel can do nothing else. So
 * there are three roles, and mixing them is the bug that turns "one slow SSE
 * client" into "the whole process stops issuing commands":
 *
 *   - `shared`   — ordinary commands (XADD, PUBLISH, breaker counters)
 *   - `blocking` — one per live subscriber, blocked in XREAD
 *   - `bullmq`   — handed to BullMQ, which owns its own lifecycle
 */

/**
 * `maxRetriesPerRequest: null` is required by BullMQ and is right for the rest
 * of the system too: a command issued during a brief Redis blip should wait for
 * the reconnect rather than fail the request that issued it.
 */
const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy(times: number): number {
    return Math.min(times * 200, 5_000)
  },
}

let shared: Redis | null = null

/** Long-lived connection for non-blocking commands. Created on first use. */
export function redis(): Redis {
  shared ??= createRedis()
  return shared
}

/**
 * A fresh connection.
 *
 * Callers that block (stream tails, pub/sub subscribers) must own one of these
 * and close it when they are done, because a blocked connection cannot serve
 * anybody else.
 */
export function createRedis(): Redis {
  return new Redis(queueConfig.REDIS_URL, baseOptions)
}

/** Close the shared connection. Used by graceful shutdown and by tests. */
export async function closeRedis(): Promise<void> {
  const connection = shared
  shared = null
  if (connection) await connection.quit()
}

/**
 * Fail fast if Redis is not reachable.
 *
 * Called at boot by both the API and the worker: a process that cannot enqueue
 * or cannot subscribe is not healthy, and finding that out on the first user
 * request is strictly worse than finding it out on startup.
 */
export async function pingRedis(): Promise<void> {
  await redis().ping()
}
