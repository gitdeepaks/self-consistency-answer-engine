import { describe, expect, test } from "bun:test"
import {
  accessSchema,
  effectivePlan,
  freeSubscription,
  graceDeadline,
  resolveAccess,
  subscriptionSchema,
  type Subscription,
  type SubscriptionStatus,
} from "./billing.ts"

/**
 * Dunning, stated as tests.
 *
 * The rule these pin down is the one that is easy to get wrong in a hurry and
 * expensive to get wrong at all: **a billing problem stops writes and never
 * touches reads.** Every case below either keeps full access or drops to
 * read-only; none of them makes data disappear, and if a future change makes
 * one of them do so, it fails here.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z")

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return { ...freeSubscription(NOW), ...overrides }
}

describe("freeSubscription", () => {
  test("is what a tenant nobody has ever billed looks like", () => {
    const free = freeSubscription(NOW)
    expect(free.plan).toBe("free")
    expect(free.status).toBe("ACTIVE")
    expect(() => subscriptionSchema.parse(free)).not.toThrow()
    expect(resolveAccess(free, NOW).mode).toBe("full")
  })
})

describe("resolveAccess", () => {
  test("active and trialing both have full access", () => {
    for (const status of ["ACTIVE", "TRIALING"] satisfies SubscriptionStatus[]) {
      const access = resolveAccess(subscription({ status }), NOW)
      expect(access.mode).toBe("full")
      expect(access.reason).toBeNull()
      expect(() => accessSchema.parse(access)).not.toThrow()
    }
  })

  test("past due keeps working while the grace period runs", () => {
    const access = resolveAccess(
      subscription({
        status: "PAST_DUE",
        graceEndsAt: new Date(NOW.getTime() + 60_000).toISOString(),
      }),
      NOW,
    )

    // The whole point of dunning: the customer is told, and keeps working.
    expect(access.mode).toBe("full")
    expect(access.reason).toBe("payment_past_due")
    expect(access.graceEndsAt).not.toBeNull()
  })

  test("past due goes read-only once the grace period expires", () => {
    const access = resolveAccess(
      subscription({
        status: "PAST_DUE",
        graceEndsAt: new Date(NOW.getTime() - 1).toISOString(),
      }),
      NOW,
    )
    expect(access.mode).toBe("read-only")
    expect(access.reason).toBe("payment_past_due")
    expect(access.message).toContain("read-only")
  })

  test("past due with no grace date is treated as expired", () => {
    // Failing open here would make dunning unenforceable: any event that lost
    // the date would silently restore full spend to an unpaid workspace.
    expect(resolveAccess(subscription({ status: "PAST_DUE" }), NOW).mode).toBe("read-only")
  })

  test("canceled and paused are read-only, never data loss", () => {
    for (const status of ["CANCELED", "PAUSED"] satisfies SubscriptionStatus[]) {
      const access = resolveAccess(subscription({ status }), NOW)
      expect(access.mode).toBe("read-only")
      // Read-only means *readable*. There is no mode that hides history.
      expect(access.message).not.toContain("deleted")
    }
  })

  test("a grace date that cannot be parsed is not treated as time remaining", () => {
    const access = resolveAccess(
      subscription({ status: "PAST_DUE", graceEndsAt: "not a date" }),
      NOW,
    )
    expect(access.mode).toBe("read-only")
  })
})

describe("effectivePlan", () => {
  test("is the plan on the row while access is full", () => {
    expect(effectivePlan(subscription({ plan: "team", status: "ACTIVE" }), NOW)).toBe("team")
  })

  test("falls back to free once access is restricted", () => {
    // The row keeps `team` — that is the history of what they were on — but the
    // limits that apply once the money stops are the free plan's.
    expect(effectivePlan(subscription({ plan: "team", status: "CANCELED" }), NOW)).toBe("free")
  })

  test("keeps the paid plan during the grace period", () => {
    const graceEndsAt = new Date(NOW.getTime() + 60_000).toISOString()
    expect(
      effectivePlan(subscription({ plan: "pro", status: "PAST_DUE", graceEndsAt }), NOW),
    ).toBe("pro")
  })
})

describe("graceDeadline", () => {
  test("adds whole days to the failure", () => {
    expect(graceDeadline(NOW, 7).toISOString()).toBe("2026-08-22T12:00:00.000Z")
  })

  test("zero days means the failure restricts access immediately", () => {
    const deadline = graceDeadline(NOW, 0)
    expect(deadline.getTime()).toBe(NOW.getTime())
    expect(
      resolveAccess(
        subscription({ status: "PAST_DUE", graceEndsAt: deadline.toISOString() }),
        NOW,
      ).mode,
    ).toBe("read-only")
  })
})
