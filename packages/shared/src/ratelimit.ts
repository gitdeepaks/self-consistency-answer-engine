import { z } from "zod"

/**
 * The wire shape of a rate-limit decision.
 *
 * The limiter itself lives in `@sce/queue`, because it needs Redis; what lives
 * here is the vocabulary every surface shares — the headers, the state a client
 * can parse out of a 429, and the arithmetic that turns one into the other.
 * Splitting it this way is what lets the CLI and the SDK understand a limit
 * without depending on Redis.
 */

export const rateLimitStateSchema = z.object({
  /** Which budget was consumed — `runs.create`, `default`, and so on. */
  bucket: z.string(),
  /** Requests allowed in the window. */
  limit: z.number().int().positive(),
  /** Requests left in the current window, floored at zero. */
  remaining: z.number().int().nonnegative(),
  /** When the window frees up, ISO-8601. */
  resetAt: z.string(),
  /** Whole seconds until then, for `Retry-After`. Always at least 1. */
  retryAfterSeconds: z.number().int().positive(),
})
export type RateLimitState = z.infer<typeof rateLimitStateSchema>

/**
 * Header names, in one place.
 *
 * The `X-RateLimit-*` trio is the de-facto convention every HTTP client and
 * SDK already understands; `Retry-After` is the standardised one (RFC 9110
 * §10.2.3) and is the only one a 429 is actually *required* to carry. Both are
 * sent: the first three let a well-behaved client pace itself before it is
 * refused, the last tells a refused one when to come back.
 */
export const RATE_LIMIT_HEADERS = {
  limit: "X-RateLimit-Limit",
  remaining: "X-RateLimit-Remaining",
  /** Unix seconds, not a date — every limiter in the wild uses seconds here. */
  reset: "X-RateLimit-Reset",
  retryAfter: "Retry-After",
} as const

/** The headers describing a decision. Sent on success as well as on a 429. */
export function rateLimitHeaders(state: RateLimitState): Record<string, string> {
  return {
    [RATE_LIMIT_HEADERS.limit]: String(state.limit),
    [RATE_LIMIT_HEADERS.remaining]: String(state.remaining),
    [RATE_LIMIT_HEADERS.reset]: String(Math.ceil(Date.parse(state.resetAt) / 1000)),
  }
}

/** Turn a limiter's raw numbers into the shape clients see. */
export function toRateLimitState(input: {
  bucket: string
  limit: number
  remaining: number
  resetAtMs: number
  now?: number
}): RateLimitState {
  const now = input.now ?? Date.now()
  return {
    bucket: input.bucket,
    limit: input.limit,
    remaining: Math.max(0, input.remaining),
    resetAt: new Date(input.resetAtMs).toISOString(),
    // Rounded up and floored at one: a `Retry-After: 0` is an invitation to
    // retry immediately, which is precisely what a limiter is refusing.
    retryAfterSeconds: Math.max(1, Math.ceil((input.resetAtMs - now) / 1000)),
  }
}
