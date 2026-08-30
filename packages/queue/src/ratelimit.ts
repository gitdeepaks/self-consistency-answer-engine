import type { Redis } from "ioredis"
import { z } from "zod"
import { redis } from "./connection.ts"
import { queueConfig } from "./env.ts"
import { rateLimitKey } from "./names.ts"

/**
 * A sliding-window rate limiter.
 *
 * Fixed windows are the usual shortcut and they are wrong in a way that matters
 * here: a client that spends its whole budget in the last second of one window
 * and again in the first second of the next has just done twice the allowance
 * in two seconds, which for `POST /runs` is twice the model spend. So this
 * keeps a *log* of recent hits in a sorted set and counts the ones inside the
 * trailing window — exact, at the cost of one small key per caller per route.
 *
 * The whole decision runs as one Lua script, which is what makes it correct
 * across replicas: trim, count, admit and record happen atomically, so two API
 * instances cannot both read "one slot left" and both take it.
 */

export interface RateLimitRequest {
  /** Identifies the caller and the budget — see `rateLimitKey`. */
  key: string
  /** Requests allowed per window. */
  limit: number
  windowMs: number
  /** How many slots this request consumes. Defaults to one. */
  cost?: number
  now?: number
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  /** Slots left after this decision, floored at zero. */
  remaining: number
  /** When the oldest hit in the window falls out of it, in epoch milliseconds. */
  resetAtMs: number
}

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitResult>
  /** Forget a caller's history. Used by tests and by an operator un-blocking one. */
  reset(key: string): Promise<void>
}

/**
 * Trim, count, admit, record — atomically.
 *
 * `ZREMRANGEBYSCORE` drops hits that have aged out, `ZCARD` counts what is
 * left, and the entry is only added when the request is admitted: a refused
 * request must not extend its own window, or a client hammering a limit would
 * never be let back in.
 *
 * Members are `<timestamp>-<nonce>` so two hits in the same millisecond are two
 * entries rather than one overwriting the other.
 */
const CONSUME_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])
local nonce  = ARGV[5]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local used = tonumber(redis.call('ZCARD', key))
local allowed = 0

if used + cost <= limit then
  allowed = 1
  for i = 1, cost do
    redis.call('ZADD', key, now, now .. '-' .. nonce .. '-' .. i)
  end
  used = used + cost
end

redis.call('PEXPIRE', key, window)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + window
if oldest[2] then
  resetAt = math.floor(tonumber(oldest[2]) + window)
end

return { allowed, used, resetAt }
`

/** Redis returns integers as JS numbers, but the reply is `unknown` — parse it. */
const consumeReplySchema = z.tuple([z.coerce.number(), z.coerce.number(), z.coerce.number()])

export class RedisRateLimiter implements RateLimiter {
  readonly #redis: () => Redis

  constructor(connection: () => Redis = redis) {
    this.#redis = connection
  }

  async consume(request: RateLimitRequest): Promise<RateLimitResult> {
    const now = request.now ?? Date.now()
    const cost = request.cost ?? 1
    const nonce = Math.random().toString(36).slice(2, 10)

    const reply: unknown = await this.#redis().eval(
      CONSUME_SCRIPT,
      1,
      request.key,
      String(now),
      String(request.windowMs),
      String(request.limit),
      String(cost),
      nonce,
    )

    const [allowed, used, resetAtMs] = consumeReplySchema.parse(reply)
    return {
      allowed: allowed === 1,
      limit: request.limit,
      remaining: Math.max(0, request.limit - used),
      resetAtMs,
    }
  }

  async reset(key: string): Promise<void> {
    await this.#redis().del(key)
  }
}

/**
 * The same semantics, in one process.
 *
 * For `RUN_TRANSPORT=local`, for tests, and for a single-machine deployment.
 * It limits per replica rather than per fleet — which is the honest behaviour
 * when there is no shared store, and is announced as such at boot rather than
 * pretended away.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #hits = new Map<string, number[]>()

  async consume(request: RateLimitRequest): Promise<RateLimitResult> {
    const now = request.now ?? Date.now()
    const cost = request.cost ?? 1
    const cutoff = now - request.windowMs

    const kept = (this.#hits.get(request.key) ?? []).filter((at) => at > cutoff)
    const allowed = kept.length + cost <= request.limit
    if (allowed) {
      for (let i = 0; i < cost; i++) kept.push(now)
    }
    this.#hits.set(request.key, kept)

    const oldest = kept[0]
    return {
      allowed,
      limit: request.limit,
      remaining: Math.max(0, request.limit - kept.length),
      resetAtMs: oldest === undefined ? now + request.windowMs : oldest + request.windowMs,
    }
  }

  async reset(key: string): Promise<void> {
    this.#hits.delete(key)
  }
}

let limiter: RateLimiter | null = null

/**
 * The limiter this process uses.
 *
 * Chosen the same way the queue and the bus are: Redis when there is a Redis,
 * in-process when the transport says there is not. Nothing outside this module
 * decides, so a test and a deployment differ in one environment variable.
 */
export function rateLimiter(): RateLimiter {
  limiter ??= queueConfig.RUN_TRANSPORT === "redis" ? new RedisRateLimiter() : new MemoryRateLimiter()
  return limiter
}

/** Swap the limiter. Tests use this; production sets it once, at boot, or never. */
export function setRateLimiter(next: RateLimiter | null): void {
  limiter = next
}

export { rateLimitKey }
