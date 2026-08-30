import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PLAN_ID,
  entitlementsFor,
  featureSchema,
  hasEntitlement,
  nextPlanUp,
  planFor,
  planRank,
  PLANS,
  PLAN_IDS,
  planSchema,
} from "./plans.ts"

/**
 * The plan table is data, so these are assertions about the *shape* of that
 * data rather than about branching logic. That is deliberate: the value of
 * plans-as-records is that a pricing mistake is a wrong number in one file, and
 * a test that reads the file back is what turns "wrong number" into "failing
 * build".
 */

describe("the plan table", () => {
  test("every plan parses against its own schema", () => {
    for (const id of PLAN_IDS) {
      expect(() => planSchema.parse(planFor(id))).not.toThrow()
    }
  })

  test("each plan's id matches the key it is filed under", () => {
    // A mismatch here would make `planFor("pro").id === "team"` — and every
    // error message, audit row and upgrade prompt downstream would lie.
    for (const id of PLAN_IDS) {
      expect(planFor(id).id).toBe(id)
    }
  })

  test("limits are monotonic up the ladder", () => {
    const ordered = [...PLAN_IDS].sort((a, b) => planRank(a) - planRank(b))

    for (let i = 1; i < ordered.length; i++) {
      const lower = planFor(ordered[i - 1] ?? "free").limits
      const upper = planFor(ordered[i] ?? "free").limits

      // `null` is unlimited, so it satisfies any lower bound. A paid plan that
      // allowed *fewer* runs than a free one is the kind of mistake nobody
      // notices until a customer upgrades and gets less.
      expect(upper.monthlyRuns === null || upper.monthlyRuns >= (lower.monthlyRuns ?? 0)).toBe(true)
      expect(upper.monthlyTokens === null || upper.monthlyTokens >= (lower.monthlyTokens ?? 0)).toBe(
        true,
      )
      expect(
        upper.concurrentRuns === null || upper.concurrentRuns >= (lower.concurrentRuns ?? 0),
      ).toBe(true)
    }
  })

  test("features accumulate up the ladder", () => {
    const ordered = [...PLAN_IDS].sort((a, b) => planRank(a) - planRank(b))

    for (let i = 1; i < ordered.length; i++) {
      for (const feature of entitlementsFor(ordered[i - 1] ?? "free")) {
        // Losing a capability by paying more is a support ticket, not a plan.
        expect(hasEntitlement(ordered[i] ?? "free", feature)).toBe(true)
      }
    }
  })

  test("every declared feature is granted by at least one plan", () => {
    for (const feature of featureSchema.options) {
      const granted = PLAN_IDS.some((id) => hasEntitlement(id, feature))
      expect(granted).toBe(true)
    }
  })

  test("the free plan is the default and grants nothing paid", () => {
    expect(DEFAULT_PLAN_ID).toBe("free")
    expect(entitlementsFor("free")).toHaveLength(0)
    expect(PLANS.free.priceMicroCentsPerMonth).toBe(0)
  })

  test("ranks are unique, so `nextPlanUp` is unambiguous", () => {
    const ranks = PLAN_IDS.map(planRank)
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  test("nextPlanUp walks the ladder and stops at the top", () => {
    expect(nextPlanUp("free")).toBe("pro")
    expect(nextPlanUp("pro")).toBe("team")
    expect(nextPlanUp("team")).toBe("enterprise")
    expect(nextPlanUp("enterprise")).toBeNull()
  })
})

describe("hasEntitlement", () => {
  test("gates the paid capabilities on the free plan", () => {
    expect(hasEntitlement("free", "api.keys")).toBe(false)
    expect(hasEntitlement("free", "panel.custom")).toBe(false)
    expect(hasEntitlement("free", "usage.daily")).toBe(false)
  })

  test("grants them from pro upwards", () => {
    expect(hasEntitlement("pro", "api.keys")).toBe(true)
    expect(hasEntitlement("team", "webhooks")).toBe(true)
    expect(hasEntitlement("enterprise", "priority.queue")).toBe(true)
  })

  test("webhooks are a team capability, not a pro one", () => {
    expect(hasEntitlement("pro", "webhooks")).toBe(false)
  })
})
