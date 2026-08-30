import { rateLimiter, rateLimitKey } from "@sce/queue"
import { rateLimitHeaders, toRateLimitState, type RateLimitState } from "@sce/shared"
import type { MiddlewareHandler } from "hono"
import { actorOf, type AuthEnv } from "./auth/middleware.ts"
import { requestProvenance } from "./auth/resolve.ts"
import { config } from "./env.ts"
import { RateLimitedError } from "./errors.ts"

/**
 * Rate limiting as middleware.
 *
 * Quotas are commercial and monthly; this is operational and per-minute. They
 * answer different questions and neither substitutes for the other — a tenant
 * well inside its monthly plan can still take the API down with a loop, and a
 * tenant pacing itself perfectly can still be out of runs for the month.
 *
 * Two keys are consumed for the expensive route, and the distinction matters:
 *
 *   - **the credential** — an API key id, or a user id for a session. This is
 *     the budget that belongs to *you*.
 *   - **the client IP** — the budget that belongs to *where you are calling
 *     from*, which is the only thing that sees somebody minting fresh
 *     credentials in a loop.
 *
 * The window is a sliding one (see `@sce/queue`), because a fixed window lets a
 * caller spend two full budgets across its boundary in two seconds — and for
 * `POST /runs` a budget is model spend.
 */

/** One route's allowance. */
export interface RouteBudget {
  /** Namespace for the Redis key, and the `bucket` a client sees on a 429. */
  bucket: string
  limit: number
  /** Additionally limit by client IP, at this allowance. */
  ipLimit?: number
  /**
   * Override `RATE_LIMIT_ENABLED` for this budget.
   *
   * Exists so the middleware can be tested on a build where limiting is
   * switched off globally — which is how `bun test` runs, because a sliding
   * window keyed on a credential outlives the suite that spent it.
   */
  enabled?: boolean
}

/**
 * The subject a budget is charged to.
 *
 * The credential *id* — never the credential. A raw API key in a Redis key name
 * would appear in `SLOWLOG`, in `MONITOR` output and in every latency trace
 * that touched it, which turns a rate limiter into a place secrets leak from.
 */
function subjectFor(c: Parameters<MiddlewareHandler<AuthEnv>>[0]): string {
  const actor = actorOf(c)
  const credential = actor.credentialId ?? actor.userId
  return credential === null || credential === undefined
    ? `tenant:${actor.tenantId}`
    : `cred:${credential}`
}

/** The client address, or a stable placeholder when there is none to read. */
function ipFor(request: Request): string {
  return requestProvenance(request).ip ?? "unknown"
}

/** One budget's verdict: whether it admitted the request, and its state. */
interface Consumption {
  allowed: boolean
  state: RateLimitState
}

async function consume(
  bucket: string,
  subject: string,
  limit: number,
  now: number,
): Promise<Consumption> {
  const result = await rateLimiter().consume({
    key: rateLimitKey(bucket, subject),
    limit,
    windowMs: config.rateLimit.windowMs,
    now,
  })

  return {
    allowed: result.allowed,
    state: toRateLimitState({
      bucket,
      limit: result.limit,
      remaining: result.remaining,
      resetAtMs: result.resetAtMs,
      now,
    }),
  }
}

/**
 * Enforce a budget, and say so in the headers either way.
 *
 * The `X-RateLimit-*` headers go on successful responses too: a client that can
 * see it has four requests left can pace itself, and one that only ever learns
 * about the limit by being refused cannot. `Retry-After` is added on the 429 by
 * `RateLimitedError`, which is also what maps it to a typed body.
 */
export function rateLimit(budget: RouteBudget): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!(budget.enabled ?? config.rateLimit.enabled)) return next()

    const now = Date.now()
    const consumed: Consumption[] = [
      await consume(budget.bucket, subjectFor(c), budget.limit, now),
    ]

    if (budget.ipLimit !== undefined) {
      consumed.push(
        await consume(`${budget.bucket}.ip`, `ip:${ipFor(c.req.raw)}`, budget.ipLimit, now),
      )
    }

    // The tightest budget is the one a client should pace itself against, so
    // that is the one the headers describe — reporting the roomier of two
    // limits would tell a caller it has requests left that it does not.
    const tightest = consumed.reduce((worst, entry) =>
      entry.state.remaining < worst.state.remaining ? entry : worst,
    )

    for (const [name, value] of Object.entries(rateLimitHeaders(tightest.state))) {
      c.header(name, value)
    }

    // The limiter's own verdict decides, not the remaining count: `remaining`
    // hits zero on the request that *used* the last slot as well as on the one
    // refused after it, and refusing the former would give every caller one
    // fewer request than their budget says.
    const refused = consumed.find((entry) => !entry.allowed)
    if (refused) throw new RateLimitedError(refused.state)

    await next()
  }
}
