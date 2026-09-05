import { z } from "zod"
import { assertNever } from "./assert.ts"
import { accessSchema } from "./billing.ts"
import { killSwitchSchema } from "./budget.ts"
import { quotaViolationSchema } from "./quota.ts"
import { rateLimitStateSchema } from "./ratelimit.ts"

/**
 * The error envelope every refusal shares.
 *
 * Two audiences, one body. `error` is a sentence for a person; `code` is a
 * stable string for a program, and is the only part a client should ever branch
 * on — an HTTP status cannot distinguish "you are out of monthly runs" from
 * "you have too many in flight", and both are 429.
 *
 * The typed detail fields are what make a limit *actionable* rather than merely
 * reported: a client that receives `quota` knows which ceiling it hit, what it
 * has used, when it resets and which plan would raise it, without parsing
 * prose. Each one is optional and each one is a schema — there is no
 * `details: unknown` here, because the whole point is that the caller can parse
 * it.
 */

export const errorCodeSchema = z.enum([
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  /** A plan ceiling was reached. 429, with `quota`. */
  "quota_exceeded",
  /** A per-window request budget was exhausted. 429, with `rateLimit`. */
  "rate_limited",
  /** The subscription cannot fund new work. 402, with `billing`. */
  "payment_required",
  /** The plan does not include this capability. 403, with `feature`. */
  "feature_unavailable",
  /** The global spend kill switch is engaged. 503, with `killSwitch`. */
  "budget_exhausted",
  "provider_unavailable",
  "not_configured",
  "internal_error",
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const apiErrorSchema = z.object({
  /** Human-readable, user-safe. Never contains an internal detail. */
  error: z.string(),
  code: errorCodeSchema,
  /** Present on `quota_exceeded`. */
  quota: quotaViolationSchema.optional(),
  /** Present on `rate_limited`. */
  rateLimit: rateLimitStateSchema.optional(),
  /** Present on `payment_required`. */
  billing: accessSchema.optional(),
  /** Present on `feature_unavailable`: the capability that is missing. */
  feature: z.string().optional(),
  /** Present on `budget_exhausted`. */
  killSwitch: killSwitchSchema.optional(),
  /**
   * Present on `validation_failed`: which fields, and what was wrong with them.
   *
   * A 400 that says "validation failed" leaves an integrator diffing their
   * payload against the documentation; one that says `prompt: must be at least
   * 3 characters` is a fix. Optional rather than required because some
   * validation failures are about the request as a whole.
   */
  fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})
export type ApiError = z.infer<typeof apiErrorSchema>

/**
 * HTTP status for a code.
 *
 * Kept beside the codes rather than at each throw site so that two routes
 * cannot answer the same condition with two different statuses — the drift
 * that makes an API's error handling impossible to write a client against.
 */
export function statusForErrorCode(code: ErrorCode): 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503 {
  switch (code) {
    case "validation_failed":
      return 400
    case "unauthorized":
      return 401
    case "payment_required":
      return 402
    case "forbidden":
    case "feature_unavailable":
      return 403
    case "not_found":
      return 404
    case "conflict":
      return 409
    case "quota_exceeded":
    case "rate_limited":
      return 429
    case "provider_unavailable":
      return 502
    case "budget_exhausted":
    case "not_configured":
      return 503
    case "internal_error":
      return 500
    default:
      return assertNever(code, "statusForErrorCode")
  }
}
