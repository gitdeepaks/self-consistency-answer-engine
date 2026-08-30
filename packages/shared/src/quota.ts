import { z } from "zod"
import { assertNever } from "./assert.ts"
import { nextPlanUp, planFor, planIdSchema, type PlanId, type PlanLimits } from "./plans.ts"
import { formatMicroCentsUsd } from "./pricing.ts"

/**
 * Quotas: what a plan allows, measured against what a tenant has already spent.
 *
 * Every function here is pure. The API reads counters out of Postgres and hands
 * them to `evaluateQuota`, which decides; nothing in this file talks to a
 * database, which is what makes the whole limit matrix testable without one and
 * makes the *same* decision reproducible in the worker, the CLI and (later) the
 * web app.
 *
 * The check happens **before** the spend. A quota discovered after three
 * provider calls have already been paid for is a report, not a limit.
 */

/** Which ceiling was reached. Stable strings — clients switch on them. */
export const quotaLimitSchema = z.enum([
  "monthly_runs",
  "monthly_tokens",
  "monthly_cost",
  "concurrent_runs",
])
export type QuotaLimit = z.infer<typeof quotaLimitSchema>

export const QUOTA_LIMITS: readonly QuotaLimit[] = quotaLimitSchema.options

/**
 * What a tenant has used, as of now.
 *
 * `runs`, `tokens` and `costMicroCents` are the calendar-month totals;
 * `activeRuns` is the instantaneous count of runs that have not reached a
 * terminal status. The caller measures all four in one place so a decision is
 * made against one consistent reading rather than four staggered ones.
 */
export const quotaSnapshotSchema = z.object({
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costMicroCents: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
})
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>

/** One limit, with the tenant's position against it. */
export const quotaStatusSchema = z.object({
  limit: quotaLimitSchema,
  used: z.number().int().nonnegative(),
  /** The ceiling, or null when this plan does not impose one. */
  ceiling: z.number().int().nonnegative().nullable(),
  /** `ceiling - used`, floored at zero. Null when there is no ceiling. */
  remaining: z.number().int().nonnegative().nullable(),
  /**
   * When the counter goes back to zero, ISO-8601. Null for `concurrent_runs`,
   * which is not a window — it frees up when a run finishes, and telling a
   * client to wait until next month for it would be a lie.
   */
  resetAt: z.string().nullable(),
})
export type QuotaStatus = z.infer<typeof quotaStatusSchema>

/** A limit that has been reached, in the shape the 429 body carries. */
export const quotaViolationSchema = quotaStatusSchema.extend({
  plan: planIdSchema,
  /** The next plan up, or null when there is nothing above this one. */
  upgradeTo: planIdSchema.nullable(),
  /** A sentence safe to show a user. */
  message: z.string(),
})
export type QuotaViolation = z.infer<typeof quotaViolationSchema>

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; violation: QuotaViolation }

/* ------------------------------------------------------------------ window */

/** The calendar month containing `now`, in UTC: `[from, to)`. */
export interface MonthWindow {
  from: Date
  to: Date
}

/**
 * Monthly counters are UTC calendar months.
 *
 * Not "the last 30 days", and not the tenant's local month: a rolling window
 * makes "when does this reset?" unanswerable, and a local one makes two
 * replicas in different regions disagree about which month a run belongs to.
 */
export function monthWindow(now: Date = new Date()): MonthWindow {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { from, to }
}

/* ------------------------------------------------------------- evaluation */

/** The ceiling this plan sets for one limit. */
function ceilingFor(limits: PlanLimits, limit: QuotaLimit): number | null {
  switch (limit) {
    case "monthly_runs":
      return limits.monthlyRuns
    case "monthly_tokens":
      return limits.monthlyTokens
    case "monthly_cost":
      return limits.monthlyCostMicroCents
    case "concurrent_runs":
      return limits.concurrentRuns
    default:
      return assertNever(limit, "ceilingFor")
  }
}

/** How much of one limit the tenant has consumed. */
function usedFor(snapshot: QuotaSnapshot, limit: QuotaLimit): number {
  switch (limit) {
    case "monthly_runs":
      return snapshot.runs
    case "monthly_tokens":
      return snapshot.tokens
    case "monthly_cost":
      return snapshot.costMicroCents
    case "concurrent_runs":
      return snapshot.activeRuns
    default:
      return assertNever(limit, "usedFor")
  }
}

/** The human half of a 429, with the number that actually blocked the request. */
function describeLimit(limit: QuotaLimit, used: number, ceiling: number, plan: PlanId): string {
  const label = planFor(plan).label
  switch (limit) {
    case "monthly_runs":
      return `Monthly run limit reached — ${used} of ${ceiling} runs on the ${label} plan.`
    case "monthly_tokens":
      return `Monthly token limit reached — ${used} of ${ceiling} tokens on the ${label} plan.`
    case "monthly_cost":
      return (
        `Monthly spend limit reached — ${formatMicroCentsUsd(used, 2)} of ` +
        `${formatMicroCentsUsd(ceiling, 2)} on the ${label} plan.`
      )
    case "concurrent_runs":
      return (
        `Too many runs in flight — ${used} of ${ceiling} concurrent runs on the ` +
        `${label} plan. Wait for one to finish.`
      )
    default:
      return assertNever(limit, "describeLimit")
  }
}

/** When a limit's counter resets, or null when it is not a windowed limit. */
function resetAtFor(limit: QuotaLimit, window: MonthWindow): string | null {
  return limit === "concurrent_runs" ? null : window.to.toISOString()
}

/**
 * Every limit and the tenant's position against it.
 *
 * This is what `GET /api/usage` returns, so a client can show "37 of 50 runs"
 * without re-deriving the arithmetic — and so the number a user sees is
 * produced by the same function that will refuse their next request.
 */
export function quotaStatuses(
  plan: PlanId,
  snapshot: QuotaSnapshot,
  now: Date = new Date(),
): QuotaStatus[] {
  const window = monthWindow(now)
  const limits = planFor(plan).limits

  return QUOTA_LIMITS.map((limit) => {
    const ceiling = ceilingFor(limits, limit)
    const used = usedFor(snapshot, limit)
    return {
      limit,
      used,
      ceiling,
      remaining: ceiling === null ? null : Math.max(0, ceiling - used),
      resetAt: resetAtFor(limit, window),
    }
  })
}

/**
 * May this tenant start another run?
 *
 * Limits are checked in the order of `QUOTA_LIMITS` and the first one that is
 * reached wins, so the message names a single, actionable number rather than a
 * list. A ceiling of zero blocks everything, which is the point of it being
 * distinct from `null`.
 */
export function evaluateQuota(
  plan: PlanId,
  snapshot: QuotaSnapshot,
  now: Date = new Date(),
): QuotaDecision {
  for (const status of quotaStatuses(plan, snapshot, now)) {
    if (status.ceiling === null || status.used < status.ceiling) continue

    return {
      allowed: false,
      violation: {
        ...status,
        plan,
        upgradeTo: nextPlanUp(plan),
        message: describeLimit(status.limit, status.used, status.ceiling, plan),
      },
    }
  }
  return { allowed: true }
}

/** Seconds until a violated limit resets, for a `Retry-After` header. */
export function retryAfterSeconds(violation: QuotaViolation, now: Date = new Date()): number {
  // A concurrency limit has no reset time; it frees up when a run finishes, and
  // a short, honest "try again shortly" beats a month-long one.
  if (violation.resetAt === null) return 30

  const resetAt = Date.parse(violation.resetAt)
  if (Number.isNaN(resetAt)) return 30
  return Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000))
}
