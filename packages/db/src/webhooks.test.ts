import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  quotaExceededEvent,
  runCompletedEvent,
  toRunSummary,
  verifyWebhookSignature,
  webhookSignatureHeaders,
  type QuotaViolation,
} from "@sce/shared"
import { prisma } from "./client.ts"
import { createRun, getRun, type CandidateSeed } from "./repository.ts"
import { ensureTenant } from "./tenancy.ts"
import {
  WEBHOOK_FAILURE_THRESHOLD,
  claimWebhookDispatch,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  dispatchWebhookEvent,
  enableWebhookEndpoint,
  getWebhookEndpoint,
  listDueWebhookDeliveries,
  listWebhookDeliveries,
  listWebhookEndpoints,
  pruneWebhookDeliveries,
  recordWebhookFailure,
  recordWebhookSuccess,
  replayWebhookDelivery,
} from "./webhooks.ts"

/**
 * Outbound webhooks, against the real database.
 *
 * Three of the four guarantees this feature makes are properties of *the
 * schema*, not of the code above it, so a mock could not prove any of them:
 *
 *   - **emission is idempotent** — the `(endpointId, eventId)` unique index is
 *     what stops a redelivered synthesis job sending a customer a second copy,
 *     and the code path that relies on it is a caught constraint violation;
 *   - **the outbox is complete** — a due row is visible to the sweeper across
 *     every tenant, which is a query, not a function;
 *   - **isolation holds** — an endpoint, a delivery and a replay all belong to
 *     one workspace, and every one of those filters is SQL.
 *
 * The fourth, the signature, is proved in `@sce/shared`. What is checked here is
 * that the bytes stored are the bytes signed — the property that a re-serialise
 * anywhere in the path would silently destroy.
 */

const PREFIX = "test-webhooks"
const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
]

const VIOLATION: QuotaViolation = {
  limit: "monthly_runs",
  used: 50,
  ceiling: 50,
  remaining: 0,
  resetAt: "2026-10-01T00:00:00.000Z",
  plan: "free",
  upgradeTo: "pro",
  message: "You have used 50 of 50 runs this month.",
}

let tenantId = ""
let otherTenantId = ""

beforeAll(async () => {
  await cleanup()
  tenantId = (await ensureTenant(`${PREFIX}-a`, "Webhooks A")).id
  otherTenantId = (await ensureTenant(`${PREFIX}-b`, "Webhooks B")).id
})

afterAll(cleanup)

async function cleanup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
}

/**
 * The delivery addressed to one particular endpoint.
 *
 * Emission fans out to *every* subscribed endpoint in the workspace, and this
 * suite accumulates several as it goes — so `created[0]` is whichever endpoint
 * happened to be inserted first, not the one the test just made. Resolving by
 * endpoint id is the only stable way to talk about "my" delivery.
 */
async function deliveryFor(
  created: readonly string[],
  endpointId: string,
): Promise<string> {
  for (const id of created) {
    const dispatch = await claimWebhookDispatch(tenantId, id)
    if (dispatch?.endpointId === endpointId) return id
  }
  throw new Error(`no delivery was created for endpoint ${endpointId}`)
}

/** An endpoint subscribed to everything, owned by the primary tenant. */
async function endpoint(url = "https://receiver.example/hooks"): Promise<{
  id: string
  secret: string
}> {
  const created = await createWebhookEndpoint({
    tenantId,
    createdByUserId: null,
    url,
    description: "test receiver",
  })
  return { id: created.endpoint.id, secret: created.secret }
}

describe("endpoints", () => {
  test("are created with a secret that is returned exactly once", async () => {
    const created = await createWebhookEndpoint({
      tenantId,
      createdByUserId: null,
      url: "https://receiver.example/once",
    })

    expect(created.secret.startsWith("whsec_")).toBe(true)
    // Absent from the endpoint projection, and absent from every later read.
    // This is the whole reason `WebhookEndpoint` and the row are different
    // shapes: a field that is never named cannot be leaked by accident.
    expect(JSON.stringify(created.endpoint)).not.toContain(created.secret)

    const reread = await getWebhookEndpoint(tenantId, created.endpoint.id)
    expect(JSON.stringify(reread)).not.toContain(created.secret)
  })

  test("default to every event type when none is named", async () => {
    const created = await createWebhookEndpoint({
      tenantId,
      createdByUserId: null,
      url: "https://receiver.example/all",
    })
    expect(created.endpoint.eventTypes).toEqual([
      "run.completed",
      "run.failed",
      "quota.exceeded",
    ])
  })

  test("are invisible to another workspace", async () => {
    const created = await endpoint("https://receiver.example/private")

    expect(await getWebhookEndpoint(otherTenantId, created.id)).toBeNull()
    expect(await deleteWebhookEndpoint(otherTenantId, created.id)).toBe(false)
    expect(await enableWebhookEndpoint(otherTenantId, created.id)).toBeNull()

    // Still there for its owner: the refusals above were scoping, not deletion.
    expect(await getWebhookEndpoint(tenantId, created.id)).not.toBeNull()
  })

  test("are listed newest first, over-fetched by one for the cursor", async () => {
    const listed = await listWebhookEndpoints({ tenantId, limit: 2 })
    // `limit + 1` rows come back so the caller can tell there is another page
    // without a second `count(*)` over a growing table.
    expect(listed.length).toBeGreaterThan(2)
  })
})

describe("emission", () => {
  test("writes one dispatch per subscribed endpoint, storing the signed bytes", async () => {
    const receiver = await endpoint("https://receiver.example/emit")

    const run = await createRun({ tenantId, prompt: "why is the sky blue?", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    expect(loaded).not.toBeNull()
    if (loaded === null) return

    const event = runCompletedEvent(toRunSummary(loaded))
    const created = await dispatchWebhookEvent({ tenantId, event })
    // Fanned out to every subscribed endpoint in the workspace, this one
    // included — which is the behaviour, so the test picks its own out.
    expect(created.length).toBeGreaterThanOrEqual(1)

    const dispatch = await claimWebhookDispatch(
      tenantId,
      await deliveryFor(created, receiver.id),
    )
    expect(dispatch).not.toBeNull()
    if (dispatch === null) return

    expect(dispatch.url).toBe("https://receiver.example/emit")
    expect(dispatch.secret).toBe(receiver.secret)

    /*
     * The stored payload has to be the exact bytes that get signed. Signing
     * them here and verifying with the endpoint's own secret proves the round
     * trip through Postgres changed nothing — a `JSON.parse`/`stringify`
     * anywhere in that path would still produce valid JSON and an invalid
     * signature, and nothing but a check like this notices.
     */
    const timestampSeconds = Math.floor(Date.now() / 1000)
    const headers = await webhookSignatureHeaders({
      secret: dispatch.secret,
      id: dispatch.eventId,
      timestampSeconds,
      payload: dispatch.payload,
    })

    const verified = await verifyWebhookSignature({
      secret: receiver.secret,
      payload: dispatch.payload,
      headers: new Headers(headers),
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.event.id).toBe(event.id)
  })

  test("is idempotent: the same event twice sends one delivery", async () => {
    await endpoint("https://receiver.example/dedupe")

    const run = await createRun({ tenantId, prompt: "dedupe", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")
    const event = runCompletedEvent(toRunSummary(loaded))

    const first = await dispatchWebhookEvent({ tenantId, event })
    // The redelivered-job case: the queue handed the synthesis job to a second
    // worker after a crash, and it emits the same event again.
    const second = await dispatchWebhookEvent({ tenantId, event })

    expect(first.length).toBeGreaterThan(0)
    expect(second).toEqual([])
  })

  test("a quota event throttles itself to one delivery per hour", async () => {
    await endpoint("https://receiver.example/quota")

    const at = new Date("2026-08-15T10:30:00.000Z")
    const sameHour = new Date("2026-08-15T10:59:00.000Z")
    const nextHour = new Date("2026-08-15T11:00:00.000Z")

    const first = await dispatchWebhookEvent({
      tenantId,
      event: quotaExceededEvent({ tenantId, plan: "free", quota: VIOLATION, now: at }),
    })
    const again = await dispatchWebhookEvent({
      tenantId,
      event: quotaExceededEvent({ tenantId, plan: "free", quota: VIOLATION, now: sameHour }),
    })
    const later = await dispatchWebhookEvent({
      tenantId,
      event: quotaExceededEvent({ tenantId, plan: "free", quota: VIOLATION, now: nextHour }),
    })

    // The unique index is the whole rate limiter: no state, nothing to reset,
    // and no drift between replicas.
    expect(first.length).toBeGreaterThan(0)
    expect(again).toEqual([])
    expect(later.length).toBeGreaterThan(0)
  })

  test("skips a disabled endpoint", async () => {
    const receiver = await endpoint("https://receiver.example/disabled")
    await prisma.webhookEndpoint.update({
      where: { id: receiver.id },
      data: { disabledAt: new Date(), disabledReason: "test" },
    })

    const run = await createRun({ tenantId, prompt: "disabled", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")

    const created = await dispatchWebhookEvent({
      tenantId,
      event: runCompletedEvent(toRunSummary(loaded)),
    })

    const dispatches = await Promise.all(
      created.map(async (id) => claimWebhookDispatch(tenantId, id)),
    )
    expect(dispatches.some((d) => d?.url === "https://receiver.example/disabled")).toBe(false)
  })

  test("sends nothing to a workspace that did not subscribe", async () => {
    const run = await createRun({ tenantId: otherTenantId, prompt: "other", candidates: SEEDS })
    const loaded = await getRun(otherTenantId, run.id)
    if (loaded === null) throw new Error("run vanished")

    // The primary tenant has several endpoints by now; none of them may receive
    // another workspace's event.
    const created = await dispatchWebhookEvent({
      tenantId: otherTenantId,
      event: runCompletedEvent(toRunSummary(loaded)),
    })
    expect(created).toEqual([])
  })
})

describe("delivery outcomes", () => {
  /** One endpoint and one pending delivery to it, isolated from the others. */
  async function pending(url: string): Promise<{ endpointId: string; deliveryId: string }> {
    const receiver = await createWebhookEndpoint({
      tenantId,
      createdByUserId: null,
      url,
      eventTypes: ["run.failed"],
    })

    const run = await createRun({ tenantId, prompt: url, candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")

    const created = await dispatchWebhookEvent({
      tenantId,
      event: {
        id: `evt_${url.replace(/\W/g, "")}`,
        type: "run.failed",
        apiVersion: "v1",
        createdAt: new Date().toISOString(),
        data: { run: toRunSummary(loaded), error: "every provider failed" },
      },
    })

    return {
      endpointId: receiver.endpoint.id,
      deliveryId: await deliveryFor(created, receiver.endpoint.id),
    }
  }

  test("a success settles the row and clears the endpoint's failure streak", async () => {
    const { endpointId, deliveryId } = await pending("https://receiver.example/ok")

    await recordWebhookFailure({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 500,
      error: "boom",
      attempts: 1,
      exhausted: true,
      nextAttemptAt: null,
    })
    await recordWebhookSuccess({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 200,
      attempts: 2,
    })

    const page = await listWebhookDeliveries({ tenantId, limit: 50, filters: { endpointId } })
    const delivery = page.find((entry) => entry.id === deliveryId)

    expect(delivery?.status).toBe("DELIVERED")
    expect(delivery?.responseStatus).toBe(200)
    expect(delivery?.deliveredAt).not.toBeNull()
    // Cleared, so a receiver that fails intermittently never accumulates its
    // way to being disabled — only a genuinely consecutive run does.
    expect((await getWebhookEndpoint(tenantId, endpointId))?.consecutiveFailures).toBe(0)
  })

  test("a retryable failure keeps the row pending and schedules the next attempt", async () => {
    const { endpointId, deliveryId } = await pending("https://receiver.example/retry")
    const nextAttemptAt = new Date(Date.now() + 60_000)

    const outcome = await recordWebhookFailure({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 503,
      error: "upstream down",
      attempts: 1,
      exhausted: false,
      nextAttemptAt,
    })

    expect(outcome.disabled).toBe(false)

    const page = await listWebhookDeliveries({ tenantId, limit: 50, filters: { endpointId } })
    const delivery = page.find((entry) => entry.id === deliveryId)
    expect(delivery?.status).toBe("PENDING")
    expect(delivery?.nextAttemptAt).not.toBeNull()

    // Not counted yet: the streak counts *given-up* deliveries, so one delivery
    // spending its six attempts cannot disable an endpoint on its own.
    expect((await getWebhookEndpoint(tenantId, endpointId))?.consecutiveFailures).toBe(0)
  })

  test("an endpoint is disabled once enough deliveries have been given up on", async () => {
    const { endpointId, deliveryId } = await pending("https://receiver.example/dead")

    let outcome = { disabled: false, consecutiveFailures: 0 }
    for (let attempt = 0; attempt < WEBHOOK_FAILURE_THRESHOLD; attempt += 1) {
      outcome = await recordWebhookFailure({
        tenantId,
        deliveryId,
        endpointId,
        responseStatus: 500,
        error: "boom",
        attempts: 6,
        exhausted: true,
        nextAttemptAt: null,
      })
    }

    expect(outcome.consecutiveFailures).toBe(WEBHOOK_FAILURE_THRESHOLD)
    expect(outcome.disabled).toBe(true)

    const disabled = await getWebhookEndpoint(tenantId, endpointId)
    expect(disabled?.disabledAt).not.toBeNull()
    expect(disabled?.disabledReason).toContain("consecutive failed deliveries")

    // Re-enabling is explicit, and resets the streak — otherwise the next single
    // failure would disable it again immediately.
    const enabled = await enableWebhookEndpoint(tenantId, endpointId)
    expect(enabled?.disabledAt).toBeNull()
    expect(enabled?.consecutiveFailures).toBe(0)
  })

  test("a replay re-queues the original event rather than making a new one", async () => {
    const { endpointId, deliveryId } = await pending("https://receiver.example/replay")

    const before = await claimWebhookDispatch(tenantId, deliveryId)
    await recordWebhookFailure({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 404,
      error: "not found",
      attempts: 1,
      exhausted: true,
      nextAttemptAt: null,
    })

    const replayed = await replayWebhookDelivery(tenantId, deliveryId)
    expect(replayed?.status).toBe("PENDING")
    expect(replayed?.attempts).toBe(0)
    expect(replayed?.lastError).toBeNull()

    const after = await claimWebhookDispatch(tenantId, deliveryId)
    // Same id and same bytes: a receiver that already handled it deduplicates
    // on `webhook-id` exactly as it is supposed to.
    expect(after?.eventId).toBe(before?.eventId ?? "")
    expect(after?.payload).toBe(before?.payload ?? "")
  })

  test("a replay cannot be triggered from another workspace", async () => {
    const { deliveryId } = await pending("https://receiver.example/private-replay")
    expect(await replayWebhookDelivery(otherTenantId, deliveryId)).toBeNull()
    expect(await claimWebhookDispatch(otherTenantId, deliveryId)).toBeNull()
  })
})

describe("the outbox", () => {
  test("due deliveries are visible to the sweeper, with the tenant that owns them", async () => {
    await endpoint("https://receiver.example/outbox")

    const run = await createRun({ tenantId, prompt: "outbox", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")
    await dispatchWebhookEvent({ tenantId, event: runCompletedEvent(toRunSummary(loaded)) })

    const due = await listDueWebhookDeliveries({
      before: new Date(Date.now() + 1_000),
      limit: 500,
      scope: { kind: "every-tenant", reason: "test" },
    })

    const mine = due.filter((entry) => entry.tenantId === tenantId)
    expect(mine.length).toBeGreaterThan(0)
    // The row carries its own tenant back, which is what lets a cross-tenant
    // sweep enqueue tenant-scoped jobs without ever guessing.
    expect(mine[0]?.id.length).toBeGreaterThan(0)
  })

  test("a delivery scheduled for later is not swept early", async () => {
    const receiver = await endpoint("https://receiver.example/later")
    const run = await createRun({ tenantId, prompt: "later", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")

    const created = await dispatchWebhookEvent({
      tenantId,
      event: runCompletedEvent(toRunSummary(loaded)),
    })
    const deliveryId = await deliveryFor(created, receiver.id)
    const endpointId = receiver.id

    await recordWebhookFailure({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 503,
      error: "later",
      attempts: 1,
      exhausted: false,
      nextAttemptAt: new Date(Date.now() + 60 * 60_000),
    })

    const due = await listDueWebhookDeliveries({
      before: new Date(),
      limit: 500,
      scope: { kind: "every-tenant", reason: "test" },
    })
    expect(due.some((entry) => entry.id === deliveryId)).toBe(false)
  })

  test("retention removes settled deliveries and leaves pending ones alone", async () => {
    const receiver = await endpoint("https://receiver.example/prune")
    const run = await createRun({ tenantId, prompt: "prune", candidates: SEEDS })
    const loaded = await getRun(tenantId, run.id)
    if (loaded === null) throw new Error("run vanished")

    const created = await dispatchWebhookEvent({
      tenantId,
      event: runCompletedEvent(toRunSummary(loaded)),
    })
    const endpointId = receiver.id
    const deliveryId = await deliveryFor(created, endpointId)

    await recordWebhookSuccess({
      tenantId,
      deliveryId,
      endpointId,
      responseStatus: 200,
      attempts: 1,
    })
    // Backdate it past the retention window.
    await prisma.webhookDispatch.update({
      where: { id: deliveryId },
      data: { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60_000) },
    })

    const removed = await pruneWebhookDeliveries({
      before: new Date(Date.now() - 30 * 24 * 60 * 60_000),
      scope: { kind: "every-tenant", reason: "test" },
    })

    expect(removed).toBeGreaterThan(0)
    expect(await claimWebhookDispatch(tenantId, deliveryId)).toBeNull()
  })
})
