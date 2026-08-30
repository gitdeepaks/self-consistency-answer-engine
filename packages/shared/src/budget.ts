import { z } from "zod"
import { formatMicroCentsUsd } from "./pricing.ts"

/**
 * The global spend guard and its kill switch.
 *
 * Per-tenant quotas stop one customer from spending too much. This stops
 * *everyone* from spending too much at once — a bug that fans out a thousand
 * runs, a leaked key used by fifty machines, a price change that makes every
 * call ten times dearer. Those failure modes have nothing to do with any single
 * tenant's plan, so they need a control that sits above plans entirely.
 *
 * It is a switch rather than a limit because of what happens after it trips:
 * the system stays stopped until an operator looks at it. Automatically
 * resuming spend after a runaway would be the same incident, one hour later.
 */

/**
 * Named switches. An enum rather than a free string so that a typo cannot
 * quietly create a second, unwatched switch that nothing ever reads.
 */
export const killSwitchScopeSchema = z.enum(["global.spend"])
export type KillSwitchScope = z.infer<typeof killSwitchScopeSchema>

/** The switch that the daily budget cap trips. */
export const GLOBAL_SPEND_SWITCH: KillSwitchScope = "global.spend"

export const killSwitchSchema = z.object({
  scope: killSwitchScopeSchema,
  engaged: z.boolean(),
  /** Why it was engaged — the sentence an operator reads first at 3am. */
  reason: z.string().nullable(),
  engagedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type KillSwitch = z.infer<typeof killSwitchSchema>

/** A switch that has never been touched. Not an error: it is the normal state. */
export function idleKillSwitch(scope: KillSwitchScope, now: Date = new Date()): KillSwitch {
  return {
    scope,
    engaged: false,
    reason: null,
    engagedAt: null,
    releasedAt: null,
    updatedAt: now.toISOString(),
  }
}

export const globalBudgetSchema = z.object({
  /** The daily ceiling in micro-cents. Zero means the cap is disabled. */
  capMicroCents: z.number().int().nonnegative(),
  /** Metered spend since `since`, across every tenant. */
  spentMicroCents: z.number().int().nonnegative(),
  /** `cap - spent`, floored at zero. Null when the cap is disabled. */
  remainingMicroCents: z.number().int().nonnegative().nullable(),
  /** Start of the UTC day the figures cover. */
  since: z.string(),
  killSwitch: killSwitchSchema,
})
export type GlobalBudget = z.infer<typeof globalBudgetSchema>

/** Start of the UTC day containing `now`. The budget window is a calendar day. */
export function dayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The UTC day containing `now`, as `YYYY-MM-DD` — the key daily rollups use. */
export function dayKey(now: Date = new Date()): string {
  return dayStart(now).toISOString().slice(0, 10)
}

/** Has today's spend reached the cap? A cap of zero is disabled, never "no spend". */
export function budgetExhausted(cap: number, spent: number): boolean {
  return cap > 0 && spent >= cap
}

/** The sentence that goes into the kill switch's reason, and into the page. */
export function budgetTrippedMessage(cap: number, spent: number, since: Date): string {
  return (
    `Global daily spend of ${formatMicroCentsUsd(spent, 2)} reached the ` +
    `${formatMicroCentsUsd(cap, 2)} cap for the day beginning ${since.toISOString()}. ` +
    `New runs are refused until an operator releases the switch.`
  )
}
