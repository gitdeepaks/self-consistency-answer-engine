import { z } from "zod"
import { accessSchema, subscriptionSchema } from "./billing.ts"
import { featureSchema, planIdSchema } from "./plans.ts"
import { quotaStatusSchema } from "./quota.ts"
import { providerIdSchema, usageTotalsSchema } from "./schemas.ts"

/**
 * What the metering surface returns.
 *
 * One response answers the three questions a client actually has — *what have I
 * spent*, *what am I allowed*, and *what may I do* — because answering them
 * separately guarantees a UI that shows a usage bar computed from one request
 * and an upgrade prompt decided by another.
 *
 * The quota figures come from the same `quotaStatuses()` that refuses the next
 * request, so the number a user reads and the number that blocks them are one
 * calculation, not two implementations of the same rule.
 */

export const usagePeriodSchema = z.object({
  /** Inclusive start of the billing month, UTC, ISO-8601. */
  from: z.string(),
  /** Exclusive end — also when every monthly counter resets. */
  to: z.string(),
})
export type UsagePeriod = z.infer<typeof usagePeriodSchema>

export const usageSummarySchema = z.object({
  /** Exact totals for the current month, summed from `UsageRecord`. */
  usage: usageTotalsSchema,
  period: usagePeriodSchema,
  /** The plan whose limits are actually being applied right now. */
  plan: planIdSchema,
  quotas: z.array(quotaStatusSchema),
  entitlements: z.array(featureSchema),
  subscription: subscriptionSchema,
  access: accessSchema,
})
export type UsageSummary = z.infer<typeof usageSummarySchema>

/**
 * One day of metered spend for one model.
 *
 * Rolled up from `UsageRecord` by the worker rather than aggregated on read:
 * a cost dashboard that scans every row of the metering table is the query that
 * takes the database down on the day the dashboard matters most.
 */
export const usageDayEntrySchema = z.object({
  /** `YYYY-MM-DD`, UTC. */
  day: z.string(),
  provider: providerIdSchema,
  model: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicroCents: z.number().int().nonnegative(),
})
export type UsageDayEntry = z.infer<typeof usageDayEntrySchema>

export const usageDailySchema = z.object({
  from: z.string(),
  to: z.string(),
  entries: z.array(usageDayEntrySchema),
  /**
   * How stale the figures may be: rollups run on an interval, so today's row
   * lags reality by up to that long. Stated rather than implied, because a
   * dashboard that quietly disagrees with the invoice is worse than one that
   * says when it was last computed.
   */
  rolledUpAt: z.string().nullable(),
})
export type UsageDaily = z.infer<typeof usageDailySchema>

/**
 * `?from=&to=` on the daily breakdown, as `YYYY-MM-DD`.
 *
 * Dates rather than timestamps because the rollup's grain is a UTC day: a
 * caller who could ask for half a day would get a whole one back, and an API
 * that silently widens what was asked for is worse than one that only accepts
 * what it can answer.
 */
export const usageDailyQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
})
export type UsageDailyQuery = z.infer<typeof usageDailyQuerySchema>

/** How far back the daily breakdown looks when the caller does not say. */
export const USAGE_DAILY_DEFAULT_DAYS = 30

/** The widest window the daily breakdown will answer in one request. */
export const USAGE_DAILY_MAX_DAYS = 366

/** Spend attributed to one tenant, for the operator-facing cost report. */
export const tenantSpendSchema = z.object({
  tenantId: z.string(),
  slug: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costMicroCents: z.number().int().nonnegative(),
})
export type TenantSpend = z.infer<typeof tenantSpendSchema>
