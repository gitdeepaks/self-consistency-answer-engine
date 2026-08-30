import { z } from "zod"
import { assertNever } from "./assert.ts"

/**
 * Plans, limits and entitlements — as data.
 *
 * The whole of Phase 4 rests on one decision: a plan is a *record*, not a
 * branch. Nothing anywhere asks "is this tenant on Pro?" — it asks for the
 * plan's limits, or for a named entitlement, and the answer comes from the
 * table below. That is what keeps a pricing change to an edit of one file
 * instead of a hunt through routes, and what lets the same definition drive the
 * API's enforcement and the UI's affordances without the two drifting.
 *
 * Money is in **micro-cents** (1e-8 USD) everywhere, matching
 * `UsageRecord.costMicroCents`, so every comparison is exact integer
 * arithmetic — see `pricing.ts` for why floats are not an option here.
 */

export const planIdSchema = z.enum(["free", "pro", "team", "enterprise"])
export type PlanId = z.infer<typeof planIdSchema>

export const PLAN_IDS: readonly PlanId[] = planIdSchema.options

/**
 * A capability a plan either grants or withholds.
 *
 * Deliberately coarse and few. A feature flag per button is how entitlement
 * lists rot; these are the handful of things that genuinely differ between what
 * somebody pays for.
 */
export const featureSchema = z.enum([
  /** Choose which panel members answer, rather than taking the default panel. */
  "panel.custom",
  /** Mint API keys for CI and the SDK. */
  "api.keys",
  /** Per-day, per-model spend breakdown rather than a single total. */
  "usage.daily",
  /** Outbound run webhooks (Phase 6). Declared here so the plan table is whole. */
  "webhooks",
  /** Runs are enqueued ahead of lower plans when the queue is backed up. */
  "priority.queue",
])
export type Feature = z.infer<typeof featureSchema>

/**
 * A ceiling, or `null` for "this plan does not impose one".
 *
 * `null` rather than `0` because zero is a real, meaningful ceiling — "you may
 * not run anything" — and a scheme where the most permissive value and the most
 * restrictive one are the same number is one typo away from an incident.
 */
export const planLimitSchema = z.number().int().nonnegative().nullable()

export const planLimitsSchema = z.object({
  /** Runs created per calendar month, UTC. */
  monthlyRuns: planLimitSchema,
  /** Input + output tokens metered per calendar month, UTC. */
  monthlyTokens: planLimitSchema,
  /** Metered spend per calendar month, in micro-cents. */
  monthlyCostMicroCents: planLimitSchema,
  /** Runs allowed to be in flight simultaneously. */
  concurrentRuns: planLimitSchema,
})
export type PlanLimits = z.infer<typeof planLimitsSchema>

export const planSchema = z.object({
  id: planIdSchema,
  label: z.string(),
  /** List price in micro-cents per month. Zero for a free plan. */
  priceMicroCentsPerMonth: z.number().int().nonnegative(),
  /** Null means "talk to us" — the price is not self-serve. */
  selfServe: z.boolean(),
  limits: planLimitsSchema,
  features: z.array(featureSchema).readonly(),
})
export type Plan = z.infer<typeof planSchema>

/** Micro-cents in one US dollar, repeated from `pricing.ts` for readability. */
const USD = 100 * 1_000_000

/**
 * The price list.
 *
 * `satisfies` rather than an annotation: the literal keeps its narrow type — so
 * `PLANS.free.features` is a tuple of the exact features free actually has —
 * while still being checked against `Plan`. This is the §3 rule about
 * `satisfies` in the one place it earns the most.
 */
export const PLANS = {
  free: {
    id: "free",
    label: "Free",
    priceMicroCentsPerMonth: 0,
    selfServe: true,
    limits: {
      monthlyRuns: 50,
      monthlyTokens: 500_000,
      monthlyCostMicroCents: 5 * USD,
      concurrentRuns: 1,
    },
    features: [],
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceMicroCentsPerMonth: 29 * USD,
    selfServe: true,
    limits: {
      monthlyRuns: 1_000,
      monthlyTokens: 20_000_000,
      monthlyCostMicroCents: 100 * USD,
      concurrentRuns: 5,
    },
    features: ["panel.custom", "api.keys", "usage.daily"],
  },
  team: {
    id: "team",
    label: "Team",
    priceMicroCentsPerMonth: 199 * USD,
    selfServe: true,
    limits: {
      monthlyRuns: 10_000,
      monthlyTokens: 200_000_000,
      monthlyCostMicroCents: 1_000 * USD,
      concurrentRuns: 20,
    },
    features: ["panel.custom", "api.keys", "usage.daily", "webhooks", "priority.queue"],
  },
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    priceMicroCentsPerMonth: 0,
    selfServe: false,
    limits: {
      // Unlimited by plan. The global daily budget cap still applies — it is an
      // operational blast-radius control, not a commercial one, and no contract
      // turns it off.
      monthlyRuns: null,
      monthlyTokens: null,
      monthlyCostMicroCents: null,
      concurrentRuns: 100,
    },
    features: ["panel.custom", "api.keys", "usage.daily", "webhooks", "priority.queue"],
  },
} as const satisfies Record<PlanId, Plan>

/** The plan record for an id. Total by construction — no lookup can miss. */
export function planFor(id: PlanId): Plan {
  return PLANS[id]
}

/** The default for a tenant that has never subscribed to anything. */
export const DEFAULT_PLAN_ID: PlanId = "free"

/**
 * Does this plan grant this capability?
 *
 * The single entitlement question in the system. Routes call it, and so does
 * the UI — through the same plan record served by `GET /api/usage` — because a
 * feature that is only hidden in the interface is not gated at all.
 */
export function hasEntitlement(plan: PlanId, feature: Feature): boolean {
  return planFor(plan).features.some((granted) => granted === feature)
}

/** Every feature a plan grants, for a client that wants to render affordances. */
export function entitlementsFor(plan: PlanId): readonly Feature[] {
  return planFor(plan).features
}

/**
 * Commercial ordering, used only to suggest the next plan up in an error.
 *
 * An exhaustive switch rather than an array index so that adding a plan is a
 * compile error here, where somebody has to decide where it sits.
 */
export function planRank(plan: PlanId): number {
  switch (plan) {
    case "free":
      return 0
    case "pro":
      return 1
    case "team":
      return 2
    case "enterprise":
      return 3
    default:
      return assertNever(plan, "planRank")
  }
}

/** The next plan up, or null at the top. Used to make a 429 actionable. */
export function nextPlanUp(plan: PlanId): PlanId | null {
  const rank = planRank(plan)
  const candidates = PLAN_IDS.filter((id) => planRank(id) === rank + 1)
  return candidates[0] ?? null
}
