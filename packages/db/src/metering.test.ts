import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { GLOBAL_SPEND_SWITCH, usdPerMillionToMicroCents } from "@sce/shared"
import {
  engageKillSwitch,
  ensureUnmeteredPlan,
  getKillSwitch,
  getSubscription,
  releaseKillSwitch,
  upsertSubscription,
} from "./billing.ts"
import { prisma } from "./client.ts"
import {
  countActiveRuns,
  globalSpendSince,
  listUsageDaily,
  rollupUsage,
  spendByTenant,
  tenantQuotaSnapshot,
} from "./metering.ts"
import { completeRun, createRun, recordUsage, upsertModelPrice } from "./repository.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * Metering against a real database.
 *
 * The arithmetic itself is proved without one (`@sce/shared`'s quota suite);
 * what needs Postgres is everything about *shape*: that a rollup recomputes
 * rather than accumulates, that a month window actually excludes last month,
 * and that the kill switch survives being engaged twice by two replicas.
 *
 * Every cross-tenant query here is given a **tenant** scope on purpose. The dev
 * database is shared with other suites and with whatever a developer has been
 * doing, so an assertion on a genuinely install-wide total would be a test that
 * fails for reasons that have nothing to do with the code.
 */

const PREFIX = "test-metering"
const MODEL = "test-metering-model"
const NOW = new Date("2026-08-15T12:00:00.000Z")
const LAST_MONTH = new Date("2026-07-20T09:00:00.000Z")

/** $2 in, $10 out per million tokens — round numbers make the maths readable. */
const INPUT_PER_MILLION = usdPerMillionToMicroCents(2)
const OUTPUT_PER_MILLION = usdPerMillionToMicroCents(10)

let tenantId = ""
let otherTenantId = ""
let activeRunId = ""

/** Cost of one metered call at the seeded price. */
function costOf(inputTokens: number, outputTokens: number): number {
  return Math.floor(
    (inputTokens * INPUT_PER_MILLION + outputTokens * OUTPUT_PER_MILLION) / 1_000_000,
  )
}

beforeAll(async () => {
  await cleanup()

  tenantId = (await ensureTenant(`${PREFIX}-a`, "Metering A")).id
  otherTenantId = (await ensureTenant(`${PREFIX}-b`, "Metering B")).id

  await upsertModelPrice({
    provider: "openai",
    model: MODEL,
    inputPerMillion: INPUT_PER_MILLION,
    outputPerMillion: OUTPUT_PER_MILLION,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    verified: true,
  })

  // Two runs this month, one of them still in flight, plus one last month that
  // must not appear in any of this month's numbers.
  const finished = await createRun({ tenantId, prompt: "finished", candidates: [] })
  await completeRun(tenantId, finished.id, 1_000)

  const active = await createRun({ tenantId, prompt: "in flight", candidates: [] })
  activeRunId = active.id

  const old = await createRun({ tenantId, prompt: "last month", candidates: [] })
  await prisma.run.update({ where: { id: old.id }, data: { createdAt: LAST_MONTH } })
  await completeRun(tenantId, old.id, 1_000)

  await recordUsage({
    tenantId,
    runId: finished.id,
    kind: "CANDIDATE",
    provider: "openai",
    model: MODEL,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    at: NOW,
  })
  await recordUsage({
    tenantId,
    runId: finished.id,
    kind: "EVALUATOR",
    provider: "openai",
    model: MODEL,
    inputTokens: 200_000,
    outputTokens: 100_000,
    at: NOW,
  })
  await recordUsage({
    tenantId,
    runId: old.id,
    kind: "CANDIDATE",
    provider: "openai",
    model: MODEL,
    inputTokens: 999_000,
    outputTokens: 999_000,
    at: LAST_MONTH,
  })
})

afterAll(cleanup)

async function cleanup(): Promise<void> {
  // The switch is install-wide, so a suite that engaged it and walked away
  // would break every other suite in the process.
  await releaseKillSwitch(GLOBAL_SPEND_SWITCH)
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
  await prisma.modelPrice.deleteMany({ where: { model: MODEL } })
}

describe("tenantQuotaSnapshot", () => {
  test("counts this month's runs, tokens and cost", async () => {
    const snapshot = await tenantQuotaSnapshot({ tenantId, now: NOW })

    // Two runs created this month; the July one is excluded.
    expect(snapshot.runs).toBe(2)
    expect(snapshot.tokens).toBe(1_000_000 + 500_000 + 200_000 + 100_000)
    expect(snapshot.costMicroCents).toBe(
      costOf(1_000_000, 500_000) + costOf(200_000, 100_000),
    )
  })

  test("counts runs that have not reached a terminal status", async () => {
    const snapshot = await tenantQuotaSnapshot({ tenantId, now: NOW })
    expect(snapshot.activeRuns).toBe(1)
    expect(await countActiveRuns(tenantId)).toBe(1)
  })

  test("a completed run stops counting against concurrency", async () => {
    await completeRun(tenantId, activeRunId, 500)
    expect(await countActiveRuns(tenantId)).toBe(0)
  })

  test("sees nothing belonging to another tenant", async () => {
    const snapshot = await tenantQuotaSnapshot({ tenantId: otherTenantId, now: NOW })
    expect(snapshot).toEqual({ runs: 0, tokens: 0, costMicroCents: 0, activeRuns: 0 })
  })
})

describe("globalSpendSince", () => {
  test("sums spend from a moment, scoped as the caller asks", async () => {
    const spend = await globalSpendSince({
      since: new Date("2026-08-01T00:00:00.000Z"),
      scope: { kind: "tenant", tenantId },
    })
    expect(spend).toBe(costOf(1_000_000, 500_000) + costOf(200_000, 100_000))
  })

  test("excludes anything before the window", async () => {
    const spend = await globalSpendSince({
      since: new Date("2026-09-01T00:00:00.000Z"),
      scope: { kind: "tenant", tenantId },
    })
    expect(spend).toBe(0)
  })
})

describe("rollupUsage", () => {
  test("summarises a day per tenant, provider and model", async () => {
    const rows = await rollupUsage({
      day: NOW,
      scope: { kind: "tenant", tenantId },
      now: NOW,
    })
    expect(rows).toBe(1)

    const daily = await listUsageDaily({ tenantId, from: NOW, to: NOW })
    expect(daily.entries).toHaveLength(1)
    const entry = daily.entries[0]
    expect(entry?.day).toBe("2026-08-15")
    expect(entry?.model).toBe(MODEL)
    expect(entry?.calls).toBe(2)
    expect(entry?.inputTokens).toBe(1_200_000)
    expect(entry?.outputTokens).toBe(600_000)
    expect(daily.rolledUpAt).not.toBeNull()
  })

  test("is idempotent — recomputing does not double-count", async () => {
    // The whole reason the rollup recomputes instead of incrementing: a retried
    // sweep, a late record and a manual backfill all converge on one answer.
    await rollupUsage({ day: NOW, scope: { kind: "tenant", tenantId }, now: NOW })
    await rollupUsage({ day: NOW, scope: { kind: "tenant", tenantId }, now: NOW })

    const daily = await listUsageDaily({ tenantId, from: NOW, to: NOW })
    expect(daily.entries).toHaveLength(1)
    expect(daily.entries[0]?.calls).toBe(2)
  })

  test("picks up a record that arrived after the first sweep", async () => {
    await recordUsage({
      tenantId,
      runId: null,
      kind: "CANDIDATE",
      provider: "openai",
      model: MODEL,
      inputTokens: 100_000,
      outputTokens: 0,
      at: NOW,
    })
    await rollupUsage({ day: NOW, scope: { kind: "tenant", tenantId }, now: NOW })

    const daily = await listUsageDaily({ tenantId, from: NOW, to: NOW })
    expect(daily.entries[0]?.calls).toBe(3)
    expect(daily.entries[0]?.inputTokens).toBe(1_300_000)
  })

  test("zeroes a summary whose source records have gone", async () => {
    // A dashboard showing spend for usage that no longer exists is worse than
    // one showing none, so an orphaned row is zeroed rather than left stale.
    await prisma.usageRecord.deleteMany({ where: { tenantId, model: MODEL } })
    await rollupUsage({ day: NOW, scope: { kind: "tenant", tenantId }, now: NOW })

    const daily = await listUsageDaily({ tenantId, from: NOW, to: NOW })
    expect(daily.entries[0]?.calls).toBe(0)
    expect(daily.entries[0]?.costMicroCents).toBe(0)
  })
})

describe("spendByTenant", () => {
  test("attributes spend to the workspace that made it", async () => {
    await recordUsage({
      tenantId: otherTenantId,
      runId: null,
      kind: "CANDIDATE",
      provider: "openai",
      model: MODEL,
      inputTokens: 1_000_000,
      outputTokens: 0,
      at: NOW,
    })

    const spend = await spendByTenant({
      scope: { kind: "tenant", tenantId: otherTenantId },
      from: new Date("2026-08-01T00:00:00.000Z"),
    })

    expect(spend).toHaveLength(1)
    expect(spend[0]?.slug).toBe(`${PREFIX}-b`)
    expect(spend[0]?.costMicroCents).toBe(costOf(1_000_000, 0))
  })
})

describe("subscriptions", () => {
  test("a tenant with no row is free and active", async () => {
    const subscription = await getSubscription(otherTenantId)
    expect(subscription.plan).toBe("free")
    expect(subscription.status).toBe("ACTIVE")
    expect(subscription.externalCustomerId).toBeNull()
  })

  test("an update writes only the fields it was given", async () => {
    await upsertSubscription({
      tenantId,
      plan: "pro",
      status: "ACTIVE",
      externalCustomerId: `${PREFIX}-customer`,
    })
    // A payment event knows about dunning and nothing about the plan. It must
    // not blank the plan on its way past.
    await upsertSubscription({ tenantId, status: "PAST_DUE", graceEndsAt: NOW })

    const subscription = await getSubscription(tenantId)
    expect(subscription.plan).toBe("pro")
    expect(subscription.status).toBe("PAST_DUE")
    expect(subscription.externalCustomerId).toBe(`${PREFIX}-customer`)
    expect(subscription.graceEndsAt).toBe(NOW.toISOString())
  })

  test("the unmetered plan does not overwrite a real subscription", async () => {
    await ensureUnmeteredPlan(tenantId)
    const subscription = await getSubscription(tenantId)
    expect(subscription.plan).toBe("pro")
  })

  test("the unmetered plan is applied to a workspace that has none", async () => {
    const fresh = await ensureTenant(`${PREFIX}-c`, "Metering C")
    const subscription = await ensureUnmeteredPlan(fresh.id)
    expect(subscription.plan).toBe("enterprise")
    expect(subscription.status).toBe("ACTIVE")
  })
})

describe("the kill switch", () => {
  test("starts idle without a row existing", async () => {
    const killSwitch = await getKillSwitch(GLOBAL_SPEND_SWITCH)
    expect(killSwitch.engaged).toBe(false)
    expect(killSwitch.scope).toBe(GLOBAL_SPEND_SWITCH)
  })

  test("engaging twice keeps the first reason and timestamp", async () => {
    // Several replicas can observe the same breach in the same second. The
    // second one to arrive must not overwrite what the first recorded.
    const first = await engageKillSwitch(GLOBAL_SPEND_SWITCH, "first reason", NOW)
    const second = await engageKillSwitch(
      GLOBAL_SPEND_SWITCH,
      "second reason",
      new Date(NOW.getTime() + 60_000),
    )

    expect(second.engaged).toBe(true)
    expect(second.reason).toBe("first reason")
    expect(second.engagedAt).toBe(first.engagedAt)
  })

  test("releasing clears it and records when", async () => {
    const released = await releaseKillSwitch(GLOBAL_SPEND_SWITCH, NOW)
    expect(released.engaged).toBe(false)
    expect(released.reason).toBeNull()
    expect(released.releasedAt).toBe(NOW.toISOString())
  })
})
