import {
  planFor,
  rateLimitHeaders,
  retryAfterSeconds,
  statusForErrorCode,
  type Access,
  type ApiError,
  type ErrorCode,
  type Feature,
  type KillSwitch,
  type PlanId,
  type QuotaViolation,
  type RateLimitState,
} from "@sce/shared"

/**
 * The typed refusals this API can produce.
 *
 * Error description itself lives in `@sce/shared` — the same thrown provider
 * object has to read the same way whether it surfaces on an HTTP response or on
 * a candidate row written by a worker three machines away — and is re-exported
 * here so existing imports keep working.
 *
 * What is added here is the *hierarchy*: an `AppError` knows its machine-
 * readable code, the status that code maps to, the headers a client needs to
 * act on it, and a body that parses against `apiErrorSchema`. Handlers throw
 * one and stop thinking about HTTP; `onError` maps it. That is what keeps two
 * routes from answering the same condition with two different statuses, and
 * what makes "429" distinguishable between "out of monthly runs" and "too many
 * requests per minute" — which it is not, from the status alone.
 */
export { describeError, errorFacts, type ErrorFacts } from "@sce/shared"

/** Statuses an `AppError` can carry. Narrow, so `c.json` accepts it directly. */
export type AppErrorStatus = ReturnType<typeof statusForErrorCode>

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode

  /** The response body. Typed, so a refusal cannot drift from its schema. */
  abstract body(): ApiError

  get status(): AppErrorStatus {
    return statusForErrorCode(this.code)
  }

  /** Headers that carry the machine-readable part of the refusal. */
  headers(): Record<string, string> {
    return {}
  }

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A plan ceiling was reached. Refused *before* any provider call. */
export class QuotaExceededError extends AppError {
  readonly code = "quota_exceeded" as const
  readonly violation: QuotaViolation

  constructor(violation: QuotaViolation) {
    super(violation.message)
    this.violation = violation
  }

  override headers(): Record<string, string> {
    return { "Retry-After": String(retryAfterSeconds(this.violation)) }
  }

  body(): ApiError {
    return { error: this.message, code: this.code, quota: this.violation }
  }
}

/** A per-window request budget was exhausted. */
export class RateLimitedError extends AppError {
  readonly code = "rate_limited" as const
  readonly state: RateLimitState

  constructor(state: RateLimitState) {
    super(
      `Rate limit exceeded — ${state.limit} requests per window on ${state.bucket}. ` +
        `Retry in ${state.retryAfterSeconds}s.`,
    )
    this.state = state
  }

  override headers(): Record<string, string> {
    return {
      ...rateLimitHeaders(this.state),
      "Retry-After": String(this.state.retryAfterSeconds),
    }
  }

  body(): ApiError {
    return { error: this.message, code: this.code, rateLimit: this.state }
  }
}

/**
 * The subscription cannot fund new work.
 *
 * 402 rather than 403: the caller is who they say they are and is allowed to do
 * this in principle — what is missing is a payment, and that distinction is the
 * difference between a support ticket and a self-serve fix.
 */
export class PaymentRequiredError extends AppError {
  readonly code = "payment_required" as const
  readonly access: Access

  constructor(access: Access) {
    super(access.message)
    this.access = access
  }

  body(): ApiError {
    return { error: this.message, code: this.code, billing: this.access }
  }
}

/** The plan does not include this capability. */
export class FeatureUnavailableError extends AppError {
  readonly code = "feature_unavailable" as const
  readonly feature: Feature

  constructor(feature: Feature, plan: PlanId) {
    super(`The ${planFor(plan).label} plan does not include ${feature}.`)
    this.feature = feature
  }

  body(): ApiError {
    return { error: this.message, code: this.code, feature: this.feature }
  }
}

/**
 * The global spend kill switch is engaged.
 *
 * 503, because this is the install being unavailable rather than the caller
 * being at fault — nothing about their request or their plan would change the
 * answer, and a 4xx would send them off to fix something that is not broken.
 */
export class BudgetExhaustedError extends AppError {
  readonly code = "budget_exhausted" as const
  readonly killSwitch: KillSwitch

  constructor(killSwitch: KillSwitch) {
    super(
      killSwitch.reason ??
        "New runs are paused by an operator while spend is investigated.",
    )
    this.killSwitch = killSwitch
  }

  body(): ApiError {
    return { error: this.message, code: this.code, killSwitch: this.killSwitch }
  }
}

/** Is this thrown value one of ours? */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
