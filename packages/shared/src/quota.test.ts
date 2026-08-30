import { describe, expect, test } from "bun:test"
import { planFor } from "./plans.ts"
import {
  evaluateQuota,
  monthWindow,
  quotaStatuses,
  quotaViolationSchema,
  retryAfterSeconds,
  type QuotaSnapshot,
} from "./quota.ts"

/**
 * The limit matrix, decided without a database.
 *
 * This is the payoff for keeping `evaluateQuota` pure: every boundary — one
 * under, exactly on, one over, unlimited, zero — is a table row here rather
 * than a fixture that has to be manufactured in Postgres. The integration
 * suites then only have to prove that the right numbers reach this function.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z")

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return { runs: 0, tokens: 0, costMicroCents: 0, activeRuns: 0, ...overrides }
}

describe("monthWindow", () => {
  test("is the UTC calendar month containing the instant", () => {
    const window = monthWindow(NOW)
    expect(window.from.toISOString()).toBe("2026-08-01T00:00:00.000Z")
    expect(window.to.toISOString()).toBe("2026-09-01T00:00:00.000Z")
  })

  test("rolls the year over in December", () => {
    const window = monthWindow(new Date("2026-12-31T23:59:59.999Z"))
    expect(window.to.toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })

  test("the first millisecond of a month belongs to that month", () => {
    const window = monthWindow(new Date("2026-08-01T00:00:00.000Z"))
    expect(window.from.toISOString()).toBe("2026-08-01T00:00:00.000Z")
  })
})

describe("evaluateQuota", () => {
  test("allows a tenant that has used nothing", () => {
    expect(evaluateQuota("free", snapshot(), NOW).allowed).toBe(true)
  })

  test("allows the request that lands exactly on the last unit", () => {
    // 49 used of 50 allowed: this request is the fiftieth and must go through.
    // Off-by-one here means every plan silently sells one fewer run than it says.
    const ceiling = planFor("free").limits.monthlyRuns ?? 0
    expect(evaluateQuota("free", snapshot({ runs: ceiling - 1 }), NOW).allowed).toBe(true)
  })

  test("refuses the request after the ceiling is reached", () => {
    const ceiling = planFor("free").limits.monthlyRuns ?? 0
    const decision = evaluateQuota("free", snapshot({ runs: ceiling }), NOW)

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.violation.limit).toBe("monthly_runs")
    expect(decision.violation.used).toBe(ceiling)
    expect(decision.violation.ceiling).toBe(ceiling)
    expect(decision.violation.upgradeTo).toBe("pro")
    expect(() => quotaViolationSchema.parse(decision.violation)).not.toThrow()
  })

  test("names the token ceiling when that is what was reached", () => {
    const tokens = planFor("free").limits.monthlyTokens ?? 0
    const decision = evaluateQuota("free", snapshot({ tokens }), NOW)

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.violation.limit).toBe("monthly_tokens")
    expect(decision.violation.resetAt).toBe("2026-09-01T00:00:00.000Z")
  })

  test("names the spend ceiling, in dollars, in the message", () => {
    const cost = planFor("free").limits.monthlyCostMicroCents ?? 0
    const decision = evaluateQuota("free", snapshot({ costMicroCents: cost }), NOW)

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.violation.limit).toBe("monthly_cost")
    expect(decision.violation.message).toContain("$5.00")
  })

  test("concurrency is a limit with no reset time", () => {
    const decision = evaluateQuota("free", snapshot({ activeRuns: 1 }), NOW)

    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.violation.limit).toBe("concurrent_runs")
    // A concurrency limit frees up when a run finishes. Telling a client to
    // come back next month for it would be a lie with a timestamp on it.
    expect(decision.violation.resetAt).toBeNull()
  })

  test("an unlimited plan is not stopped by any usage", () => {
    const decision = evaluateQuota(
      "enterprise",
      snapshot({ runs: 10_000_000, tokens: 10_000_000_000, costMicroCents: 10_000_000_000 }),
      NOW,
    )
    expect(decision.allowed).toBe(true)
  })

  test("but the enterprise concurrency ceiling still applies", () => {
    const ceiling = planFor("enterprise").limits.concurrentRuns ?? 0
    const decision = evaluateQuota("enterprise", snapshot({ activeRuns: ceiling }), NOW)
    expect(decision.allowed).toBe(false)
  })

  test("the first limit reached is the one reported", () => {
    // Both are over. The message has to name one number a user can act on, and
    // it is the first in `QUOTA_LIMITS` order — not a list of everything wrong.
    const limits = planFor("free").limits
    const decision = evaluateQuota(
      "free",
      snapshot({ runs: limits.monthlyRuns ?? 0, tokens: limits.monthlyTokens ?? 0 }),
      NOW,
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.violation.limit).toBe("monthly_runs")
  })
})

describe("quotaStatuses", () => {
  test("reports every limit, used and remaining", () => {
    const statuses = quotaStatuses("free", snapshot({ runs: 12 }), NOW)
    const runs = statuses.find((status) => status.limit === "monthly_runs")

    expect(statuses).toHaveLength(4)
    expect(runs?.used).toBe(12)
    expect(runs?.remaining).toBe((planFor("free").limits.monthlyRuns ?? 0) - 12)
  })

  test("remaining never goes negative", () => {
    // Usage can overshoot a ceiling — a run that was allowed can still spend
    // more than the remainder — and a UI showing "-3 runs left" is nonsense.
    const statuses = quotaStatuses("free", snapshot({ runs: 999 }), NOW)
    const runs = statuses.find((status) => status.limit === "monthly_runs")
    expect(runs?.remaining).toBe(0)
  })

  test("an unlimited ceiling reports null rather than a number", () => {
    const statuses = quotaStatuses("enterprise", snapshot({ runs: 5 }), NOW)
    const runs = statuses.find((status) => status.limit === "monthly_runs")
    expect(runs?.ceiling).toBeNull()
    expect(runs?.remaining).toBeNull()
  })
})

describe("retryAfterSeconds", () => {
  test("counts the seconds to the reset for a windowed limit", () => {
    const decision = evaluateQuota("free", snapshot({ runs: 50 }), NOW)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return

    const seconds = retryAfterSeconds(decision.violation, NOW)
    // 2026-08-15T12:00Z to 2026-09-01T00:00Z is 16.5 days.
    expect(seconds).toBe(Math.ceil((16.5 * 24 * 60 * 60 * 1000) / 1000))
  })

  test("gives a short, honest wait for a concurrency limit", () => {
    const decision = evaluateQuota("free", snapshot({ activeRuns: 1 }), NOW)
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(retryAfterSeconds(decision.violation, NOW)).toBe(30)
  })
})
