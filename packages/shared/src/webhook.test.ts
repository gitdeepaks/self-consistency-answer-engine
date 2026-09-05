import { describe, expect, test } from "bun:test"
import {
  WEBHOOK_HEADERS,
  mintWebhookSecret,
  quotaExceededEvent,
  runCompletedEvent,
  runFailedEvent,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookEventSchema,
  webhookSignatureHeaders,
} from "./webhook.ts"
import type { QuotaViolation } from "./quota.ts"
import type { RunSummary } from "./schemas.ts"

/**
 * The signature is the whole security boundary of the webhook feature: it is
 * the only thing that distinguishes an event from us from a POST by anybody who
 * read the documentation. So these tests are less about "does it sign" than
 * about the four mistakes that make a *plausible* implementation worthless —
 * every one of which produces a signature that verifies happily against itself.
 */

const RUN: RunSummary = {
  id: "run_1",
  createdByUserId: "user_1",
  prompt: "Why is the sky blue?",
  status: "COMPLETE",
  error: null,
  totalLatencyMs: 18_400,
  temperature: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  completedAt: "2026-09-05T10:00:18.400Z",
  deadlineAt: null,
  canceledAt: null,
  tags: ["physics"],
  candidateCount: 3,
  hasSynthesis: true,
  confidence: 0.86,
}

const VIOLATION: QuotaViolation = {
  limit: "monthly_runs",
  used: 50,
  ceiling: 50,
  remaining: 0,
  resetAt: "2026-10-01T00:00:00.000Z",
  plan: "free",
  upgradeTo: "pro",
  message: "You have used 50 of 50 runs this month on the Free plan.",
}

/** A `Headers` from a plain record, since that is what a receiver actually has. */
function headersOf(record: Record<string, string>): Headers {
  return new Headers(record)
}

async function deliver(
  secret: string,
  payload: string,
  now = new Date(),
): Promise<{ payload: string; headers: Headers }> {
  const headers = await webhookSignatureHeaders({
    secret,
    id: "evt_test",
    timestampSeconds: Math.floor(now.getTime() / 1000),
    payload,
  })
  return { payload, headers: headersOf(headers) }
}

describe("webhook signatures", () => {
  test("a delivery we signed verifies, and parses into a typed event", async () => {
    const secret = mintWebhookSecret()
    const event = runCompletedEvent(RUN)
    const { payload, headers } = await deliver(secret, JSON.stringify(event))

    const result = await verifyWebhookSignature({ secret, payload, headers })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe("run.completed")
    // Narrowed by the discriminant, with no assertion in sight.
    if (result.event.type === "run.completed") {
      expect(result.event.data.run.id).toBe("run_1")
    }
  })

  test("a secret is base64 after the prefix, so every library agrees on the key", () => {
    const secret = mintWebhookSecret()
    expect(secret.startsWith("whsec_")).toBe(true)
    // 32 bytes of base64 is 44 characters with padding. Using the *printable*
    // string as the HMAC key instead of these decoded bytes is the mistake that
    // verifies against itself and against nothing else in existence.
    expect(secret.slice("whsec_".length)).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(atob(secret.slice("whsec_".length)).length).toBe(32)
  })

  test("a tampered body does not verify", async () => {
    const secret = mintWebhookSecret()
    const event = runCompletedEvent(RUN)
    const { headers } = await deliver(secret, JSON.stringify(event))

    const tampered = JSON.stringify({ ...event, data: { run: { ...RUN, id: "run_2" } } })
    const result = await verifyWebhookSignature({ secret, payload: tampered, headers })

    expect(result).toEqual({ ok: false, reason: "no-matching-signature" })
  })

  test("a re-serialised body does not verify — which is why receivers must not parse first", async () => {
    const secret = mintWebhookSecret()
    // Same object, different bytes: the keys are in a different order, exactly
    // as a JSON round trip through another language would produce.
    const signed = '{"a":1,"b":2}'
    const reserialised = '{"b":2,"a":1}'

    const { headers } = await deliver(secret, signed)
    const result = await verifyWebhookSignature({ secret, payload: reserialised, headers })

    expect(result.ok).toBe(false)
  })

  test("the wrong secret does not verify", async () => {
    const { payload, headers } = await deliver(mintWebhookSecret(), '{"hello":"world"}')
    const result = await verifyWebhookSignature({
      secret: mintWebhookSecret(),
      payload,
      headers,
    })
    expect(result).toEqual({ ok: false, reason: "no-matching-signature" })
  })

  test("a stale timestamp is refused, so a captured delivery cannot be replayed", async () => {
    const secret = mintWebhookSecret()
    const signedAt = new Date("2026-09-05T10:00:00.000Z")
    const { payload, headers } = await deliver(secret, '{"hello":"world"}', signedAt)

    const tenMinutesLater = new Date(signedAt.getTime() + 10 * 60_000)
    expect(await verifyWebhookSignature({ secret, payload, headers, now: tenMinutesLater })).toEqual(
      { ok: false, reason: "stale-timestamp" },
    )

    // Inside the tolerance window it is fine.
    const oneMinuteLater = new Date(signedAt.getTime() + 60_000)
    const fresh = await verifyWebhookSignature({ secret, payload, headers, now: oneMinuteLater })
    expect(fresh.ok).toBe(false) // the payload is not a WebhookEvent…
    if (!fresh.ok) expect(fresh.reason).toBe("malformed-payload") // …but the signature was accepted
  })

  test("the timestamp is inside the signature, so it cannot be edited on the way past", async () => {
    const secret = mintWebhookSecret()
    const event = runCompletedEvent(RUN)

    // Captured an hour ago. On its own it would be refused as stale, so an
    // attacker replaying it has to forge a fresh timestamp — which is exactly
    // what putting the timestamp inside the signed content prevents.
    const anHourAgo = new Date(Date.now() - 60 * 60_000)
    const { payload, headers } = await deliver(secret, JSON.stringify(event), anHourAgo)

    headers.set(WEBHOOK_HEADERS.timestamp, String(Math.floor(Date.now() / 1000)))

    const result = await verifyWebhookSignature({ secret, payload, headers })
    expect(result).toEqual({ ok: false, reason: "no-matching-signature" })
  })

  test("missing headers are refused by name rather than by exception", async () => {
    const secret = mintWebhookSecret()
    const result = await verifyWebhookSignature({
      secret,
      payload: "{}",
      headers: headersOf({}),
    })
    expect(result).toEqual({ ok: false, reason: "missing-headers" })
  })

  test("a malformed timestamp is refused rather than coerced to zero", async () => {
    const secret = mintWebhookSecret()
    const result = await verifyWebhookSignature({
      secret,
      payload: "{}",
      headers: headersOf({
        [WEBHOOK_HEADERS.id]: "evt_1",
        [WEBHOOK_HEADERS.timestamp]: "not-a-number",
        [WEBHOOK_HEADERS.signature]: "v1,abc",
      }),
    })
    expect(result).toEqual({ ok: false, reason: "malformed-timestamp" })
  })

  test("several space-delimited signatures verify, which is what makes rotation possible", async () => {
    const oldSecret = mintWebhookSecret()
    const newSecret = mintWebhookSecret()
    const payload = JSON.stringify(runCompletedEvent(RUN))
    const timestampSeconds = Math.floor(Date.now() / 1000)

    const both = [
      await signWebhookPayload({ secret: oldSecret, id: "evt_1", timestampSeconds, payload }),
      await signWebhookPayload({ secret: newSecret, id: "evt_1", timestampSeconds, payload }),
    ].join(" ")

    const headers = headersOf({
      [WEBHOOK_HEADERS.id]: "evt_1",
      [WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
      [WEBHOOK_HEADERS.signature]: both,
    })

    // A receiver holding either secret accepts the delivery, which is what lets
    // both run during the window where a rotation is half-deployed.
    expect((await verifyWebhookSignature({ secret: oldSecret, payload, headers })).ok).toBe(true)
    expect((await verifyWebhookSignature({ secret: newSecret, payload, headers })).ok).toBe(true)
  })

  test("a body that is not an event is refused after the signature passes", async () => {
    const secret = mintWebhookSecret()
    const { payload, headers } = await deliver(secret, JSON.stringify({ type: "run.imagined" }))
    expect(await verifyWebhookSignature({ secret, payload, headers })).toEqual({
      ok: false,
      reason: "malformed-payload",
    })
  })

  test("a non-ASCII prompt round-trips, which byte-length shortcuts break", async () => {
    const secret = mintWebhookSecret()
    const event = runCompletedEvent({ ...RUN, prompt: "Warum ist der Himmel blau? 🌤️ 天空" })
    const { payload, headers } = await deliver(secret, JSON.stringify(event))
    expect((await verifyWebhookSignature({ secret, payload, headers })).ok).toBe(true)
  })
})

describe("event construction", () => {
  test("run events carry a fresh id each time", () => {
    const first = runCompletedEvent(RUN)
    const second = runCompletedEvent(RUN)
    expect(first.id).not.toBe(second.id)
    expect(first.id.startsWith("evt_")).toBe(true)
  })

  test("every constructed event parses against the published schema", () => {
    for (const event of [
      runCompletedEvent(RUN),
      runFailedEvent({ ...RUN, status: "FAILED" }, "every provider failed"),
      quotaExceededEvent({
        tenantId: "tenant_1",
        plan: "free",
        quota: VIOLATION,
      }),
    ]) {
      expect(webhookEventSchema.safeParse(event).success).toBe(true)
    }
  })

  test("a quota event's id is stable within the hour and changes across it", () => {
    const quota = VIOLATION

    const at = (iso: string): string =>
      quotaExceededEvent({ tenantId: "tenant_1", plan: "free", quota, now: new Date(iso) }).id

    // The same id inside one hour is what makes the `(endpointId, eventId)`
    // unique index throttle these to one delivery per hour — with no rate
    // limiter, no state to reset, and no drift between replicas.
    expect(at("2026-09-05T10:00:00.000Z")).toBe(at("2026-09-05T10:59:59.000Z"))
    expect(at("2026-09-05T10:00:00.000Z")).not.toBe(at("2026-09-05T11:00:00.000Z"))

    // And distinct per tenant, so one workspace's exhausted quota cannot
    // suppress another's.
    const other = quotaExceededEvent({
      tenantId: "tenant_2",
      plan: "free",
      quota,
      now: new Date("2026-09-05T10:00:00.000Z"),
    })
    expect(other.id).not.toBe(at("2026-09-05T10:00:00.000Z"))
  })
})
