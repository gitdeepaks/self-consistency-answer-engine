import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createApiKey,
  ensureMembership,
  ensureTenant,
  ensureUser,
  engageKillSwitch,
  prisma,
  releaseKillSwitch,
  upsertSubscription,
} from "@sce/db"
import { LocalRunBus, setRunBus, setRunQueue, type RunQueue } from "@sce/queue"
import {
  ALL_SCOPES,
  apiErrorSchema,
  GLOBAL_SPEND_SWITCH,
  usageSummarySchema,
} from "@sce/shared"
import { app } from "./app.ts"
import { resetBudgetCache } from "./quota.ts"

/**
 * The spend gate, over HTTP.
 *
 * Every test here asserts the same thing from a different angle: **the refusal
 * happens before the money is spent**. Nothing below reaches a provider, and
 * nothing below reaches the queue — which is the point, and is why the queue is
 * a stub that records rather than a worker that runs.
 *
 * The tenant is deliberately left on the free plan: no `Subscription` row at
 * all, which is exactly what a workspace that has never been billed looks like.
 * `app.test.ts` covers the other side of that line, on the unmetered plan the
 * install's own workspace gets.
 */

const PREFIX = "test-quota"

/** A queue that accepts everything and does nothing. */
class RecordingQueue implements RunQueue {
  readonly enqueued: string[] = []

  async enqueueRun(input: { runId: string }): Promise<void> {
    this.enqueued.push(input.runId)
  }

  async close(): Promise<void> {}
}

const queue = new RecordingQueue()

let tenantId = ""
let token = ""

beforeAll(async () => {
  await cleanup()
  setRunBus(new LocalRunBus())
  setRunQueue(queue)

  const tenant = await ensureTenant(`${PREFIX}-a`, "Quota tenant")
  tenantId = tenant.id

  const user = await ensureUser({ email: `owner@${PREFIX}.test`, displayName: "Owner" })
  await ensureMembership({ tenantId, userId: user.id, role: "owner" })

  const key = await createApiKey({
    tenantId,
    createdByUserId: user.id,
    name: `${PREFIX} key`,
    scopes: ALL_SCOPES,
    expiresAt: null,
  })
  token = key.token
})

afterAll(async () => {
  await cleanup()
})

async function cleanup(): Promise<void> {
  // The switch is install-wide: leaving it engaged would fail every later suite
  // for a reason that has nothing to do with it.
  await releaseKillSwitch(GLOBAL_SPEND_SWITCH)
  resetBudgetCache()
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { contains: `@${PREFIX}.test` } } })
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function ask(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/runs", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify(body),
  })
}

/** Refusals are parsed with the real error schema, never read field by field. */
async function readError(response: Response) {
  return apiErrorSchema.parse(await response.json())
}

describe("plan quotas", () => {
  test("a free tenant may start its first run", async () => {
    const response = await ask({ prompt: "the first one is free" })
    expect(response.status).toBe(201)
    expect(queue.enqueued).toHaveLength(1)
  })

  test("the concurrency ceiling refuses the second, before it is queued", async () => {
    // The free plan allows one run in flight. The run above is still PENDING,
    // because nothing in this suite consumes the queue.
    const enqueuedBefore = queue.enqueued.length
    const response = await ask({ prompt: "and the second one is not" })

    expect(response.status).toBe(429)
    const body = await readError(response)
    expect(body.code).toBe("quota_exceeded")
    expect(body.quota?.limit).toBe("concurrent_runs")
    expect(body.quota?.ceiling).toBe(1)
    expect(body.quota?.upgradeTo).toBe("pro")

    // Nothing was enqueued and no run row was created: the refusal is *before*
    // the spend, which is the entire distinction between a quota and a report.
    expect(queue.enqueued).toHaveLength(enqueuedBefore)
    expect(await prisma.run.count({ where: { tenantId } })).toBe(1)
  })

  test("the 429 carries a Retry-After a client can obey", async () => {
    const response = await ask({ prompt: "again" })
    const retryAfter = Number(response.headers.get("Retry-After"))
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
  })

  test("the refusal is recorded in the audit trail", async () => {
    const events = await prisma.auditEvent.findMany({
      where: { tenantId, action: "QUOTA_EXCEEDED" },
    })
    expect(events.length).toBeGreaterThan(0)
  })

  test("finishing the run frees the concurrency slot", async () => {
    await prisma.run.updateMany({ where: { tenantId }, data: { status: "COMPLETE" } })
    const response = await ask({ prompt: "room again" })
    expect(response.status).toBe(201)

    await prisma.run.updateMany({ where: { tenantId }, data: { status: "COMPLETE" } })
  })
})

describe("feature gating", () => {
  test("a free tenant may not choose the panel", async () => {
    const response = await ask({ prompt: "just openai please", providers: ["openai"] })

    expect(response.status).toBe(403)
    const body = await readError(response)
    expect(body.code).toBe("feature_unavailable")
    expect(body.feature).toBe("panel.custom")
  })

  test("a paid tenant may", async () => {
    await upsertSubscription({ tenantId, plan: "pro", status: "ACTIVE" })
    const response = await ask({ prompt: "just openai please", providers: ["openai"] })
    expect(response.status).toBe(201)

    await prisma.run.updateMany({ where: { tenantId }, data: { status: "COMPLETE" } })
  })

  test("minting an API key is a paid capability", async () => {
    await upsertSubscription({ tenantId, plan: "free", status: "ACTIVE" })
    const response = await app.request("/api/keys", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "ci" }),
    })

    expect(response.status).toBe(403)
    expect((await readError(response)).feature).toBe("api.keys")
  })
})

describe("dunning", () => {
  test("a past-due tenant inside its grace period is unaffected", async () => {
    await upsertSubscription({
      tenantId,
      plan: "pro",
      status: "PAST_DUE",
      graceEndsAt: new Date(Date.now() + 60_000),
    })

    const response = await ask({ prompt: "still working" })
    expect(response.status).toBe(201)

    await prisma.run.updateMany({ where: { tenantId }, data: { status: "COMPLETE" } })
  })

  test("once the grace period expires, writes stop and reads do not", async () => {
    await upsertSubscription({
      tenantId,
      plan: "pro",
      status: "PAST_DUE",
      graceEndsAt: new Date(Date.now() - 1),
    })

    const refused = await ask({ prompt: "not any more" })
    expect(refused.status).toBe(402)
    const body = await readError(refused)
    expect(body.code).toBe("payment_required")
    expect(body.billing?.mode).toBe("read-only")

    // The distinction that matters: nothing has been hidden or deleted.
    const history = await app.request("/api/runs", { headers: auth() })
    expect(history.status).toBe(200)
  })

  test("a canceled subscription is read-only, and reports the free plan's limits", async () => {
    await upsertSubscription({ tenantId, plan: "team", status: "CANCELED", graceEndsAt: null })

    const response = await app.request("/api/usage", { headers: auth() })
    const summary = usageSummarySchema.parse(await response.json())

    expect(summary.access.mode).toBe("read-only")
    expect(summary.plan).toBe("free")
    // The row still says what they were on; the *applied* plan is what changed.
    expect(summary.subscription.plan).toBe("team")
  })
})

describe("the global spend kill switch", () => {
  test("refuses new runs everywhere while it is engaged", async () => {
    await upsertSubscription({ tenantId, plan: "pro", status: "ACTIVE", graceEndsAt: null })
    await engageKillSwitch(GLOBAL_SPEND_SWITCH, "tripped on purpose in a test")
    resetBudgetCache()

    const response = await ask({ prompt: "not while the switch is on" })
    expect(response.status).toBe(503)

    const body = await readError(response)
    expect(body.code).toBe("budget_exhausted")
    expect(body.killSwitch?.engaged).toBe(true)
    expect(body.error).toContain("tripped on purpose")
  })

  test("reads keep working — the switch stops spend, not access", async () => {
    const response = await app.request("/api/runs", { headers: auth() })
    expect(response.status).toBe(200)
  })

  test("releasing it lets runs through again", async () => {
    await releaseKillSwitch(GLOBAL_SPEND_SWITCH)
    resetBudgetCache()

    const response = await ask({ prompt: "back in business" })
    expect(response.status).toBe(201)

    await prisma.run.updateMany({ where: { tenantId }, data: { status: "COMPLETE" } })
  })
})

describe("GET /api/usage", () => {
  test("reports spend, limits and entitlements in one response", async () => {
    const response = await app.request("/api/usage", { headers: auth() })
    expect(response.status).toBe(200)

    const summary = usageSummarySchema.parse(await response.json())
    expect(summary.plan).toBe("pro")
    expect(summary.quotas).toHaveLength(4)
    expect(summary.entitlements).toContain("api.keys")
    expect(summary.period.from.endsWith("T00:00:00.000Z")).toBe(true)

    const runs = summary.quotas.find((quota) => quota.limit === "monthly_runs")
    expect(runs?.used).toBeGreaterThan(0)
    expect(runs?.remaining).toBe((runs?.ceiling ?? 0) - (runs?.used ?? 0))
  })

  test("the daily breakdown is gated on the plan", async () => {
    await upsertSubscription({ tenantId, plan: "free", status: "ACTIVE" })
    const refused = await app.request("/api/usage/daily", { headers: auth() })
    expect(refused.status).toBe(403)

    await upsertSubscription({ tenantId, plan: "pro", status: "ACTIVE" })
    const allowed = await app.request("/api/usage/daily", { headers: auth() })
    expect(allowed.status).toBe(200)
  })
})

describe("GET /api/billing", () => {
  test("returns the subscription, the access mode and the catalogue", async () => {
    const response = await app.request("/api/billing", { headers: auth() })
    expect(response.status).toBe(200)

    const body = await response.json()
    const parsed = usageSummarySchema
      .pick({ plan: true, subscription: true, access: true })
      .parse(body)

    expect(parsed.plan).toBe("pro")
    expect(parsed.access.mode).toBe("full")
  })
})
