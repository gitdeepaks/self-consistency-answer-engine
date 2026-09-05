import { z } from "zod"
import { assertNever } from "./assert.ts"
import { planIdSchema, type PlanId } from "./plans.ts"
import { quotaViolationSchema, type QuotaViolation } from "./quota.ts"
import { runSummarySchema, type RunSummary } from "./schemas.ts"
import { API_VERSION } from "./v1.ts"

/**
 * Outbound webhooks: the contract, and the signature that makes it trustworthy.
 *
 * Not to be confused with `packages/server/src/webhooks.ts`, which is the
 * *inbound* Clerk endpoint. This module is the other direction — us telling a
 * customer's server that their run finished — and the two share nothing but a
 * word.
 *
 * A run can take minutes. Every integration that does not want to hold an SSE
 * connection open for that long ends up polling, and polling a job API is how
 * an integration becomes both slow and expensive. A signed callback is the
 * alternative, and the reason it needs to be *in the contract* rather than in a
 * customer's code is that verifying it correctly is subtle: a naive
 * implementation compares strings with `===` (timing), omits the timestamp
 * (replay), or signs the parsed object rather than the raw body (a JSON
 * round-trip changes the bytes and the signature no longer means anything).
 * `verifyWebhookSignature` below is the one implementation, and the SDK
 * re-exports it so nobody has to write a second.
 *
 * The scheme is Standard Webhooks (standardwebhooks.com) — the same one Svix
 * and therefore Clerk use, which means a customer who already receives Clerk
 * webhooks receives ours with the library they already have.
 */

/* ------------------------------------------------------------ the events */

export const webhookEventTypeSchema = z.enum([
  /** A run reached `COMPLETE`. The synthesised answer is ready to fetch. */
  "run.completed",
  /** A run reached `FAILED`. Carries the reason. */
  "run.failed",
  /** A request was refused by a plan ceiling. Fired at most once per hour. */
  "quota.exceeded",
])
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>

/** Every event type, for a subscription that asks for "all of them". */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = webhookEventTypeSchema.options

/**
 * The envelope shared by every event.
 *
 * `apiVersion` is on the wire rather than only in the URL because a delivery is
 * read months after it was sent, out of a log, by someone reconstructing what
 * happened — and "which shape was this?" is the first question they will have.
 */
const envelope = {
  /** `evt_…`. Stable across retries: the deduplication key for the receiver. */
  id: z.string().min(1),
  apiVersion: z.literal(API_VERSION),
  /** When the event occurred, not when this delivery attempt was made. */
  createdAt: z.string(),
}

/**
 * The run body carried by run events.
 *
 * A summary, not the full run: the answer and every candidate can run to
 * hundreds of kilobytes, and a webhook that large is one a receiver's proxy
 * will eventually reject at a size limit nobody documented. The summary carries
 * everything needed to decide whether to fetch the rest — status, confidence,
 * tags, timing — and `GET /v1/runs/{id}` carries the rest.
 */
export const webhookEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("run.completed"),
    data: z.object({ run: runSummarySchema }),
  }),
  z.object({
    ...envelope,
    type: z.literal("run.failed"),
    data: z.object({ run: runSummarySchema, error: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal("quota.exceeded"),
    data: z.object({ quota: quotaViolationSchema, plan: planIdSchema }),
  }),
])
export type WebhookEvent = z.infer<typeof webhookEventSchema>

/** The payload half of an event, before an id and a timestamp are attached. */
export type WebhookEventBody = Extract<WebhookEvent, { type: WebhookEventType }>["data"]

/* ------------------------------------------------------ event construction */

/**
 * The three constructors, so no call site assembles an envelope by hand.
 *
 * Each mints the `evt_…` id that receivers deduplicate on — except
 * `quotaExceededEvent`, whose id is *derived*. See below.
 */
export function runCompletedEvent(run: RunSummary, now: Date = new Date()): WebhookEvent {
  return {
    id: mintWebhookEventId(),
    type: "run.completed",
    apiVersion: API_VERSION,
    createdAt: now.toISOString(),
    data: { run },
  }
}

export function runFailedEvent(
  run: RunSummary,
  error: string,
  now: Date = new Date(),
): WebhookEvent {
  return {
    id: mintWebhookEventId(),
    type: "run.failed",
    apiVersion: API_VERSION,
    createdAt: now.toISOString(),
    data: { run, error },
  }
}

/**
 * A quota refusal, with a **deterministic** id.
 *
 * A tenant that has hit its monthly run ceiling hits it again on every request
 * for the rest of the month, and a webhook per refusal would turn one exhausted
 * quota into thousands of deliveries — the exact failure mode that gets a
 * sender's IP range blocked by the receiver's infrastructure.
 *
 * Rather than bolt a rate limiter onto the emitter, the id is derived from the
 * tenant, the limit and the hour. The `(endpointId, eventId)` unique index in
 * the database then does the throttling for free: the second refusal in the
 * same hour conflicts on insert and is skipped, with no state to keep, nothing
 * to reset and no drift between replicas. The constraint that already exists to
 * prevent duplicate deliveries turns out to be exactly the right mechanism.
 */
export function quotaExceededEvent(input: {
  tenantId: string
  quota: QuotaViolation
  plan: PlanId
  now?: Date
}): WebhookEvent {
  const now = input.now ?? new Date()
  const hour = now.toISOString().slice(0, 13).replace(/[-:T]/g, "")
  return {
    id: `evt_quota_${input.tenantId}_${input.quota.limit}_${hour}`,
    type: "quota.exceeded",
    apiVersion: API_VERSION,
    createdAt: now.toISOString(),
    data: { quota: input.quota, plan: input.plan },
  }
}

/** A one-line description of an event, for a delivery log or a console. */
export function describeWebhookEvent(event: WebhookEvent): string {
  switch (event.type) {
    case "run.completed":
      return `run ${event.data.run.id} completed`
    case "run.failed":
      return `run ${event.data.run.id} failed: ${event.data.error}`
    case "quota.exceeded":
      return `quota ${event.data.quota.limit} exceeded on the ${event.data.plan} plan`
    default:
      return assertNever(event, "describeWebhookEvent")
  }
}

/* --------------------------------------------------------- the endpoints */

/**
 * A registered receiver.
 *
 * `secret` is absent here on purpose: like an API key, it is returned exactly
 * once by the request that created the endpoint and is unrecoverable
 * afterwards. Unlike an API key it is *stored* rather than hashed, because
 * HMAC signing needs the key material — see the note on `mintWebhookSecret`.
 */
export const webhookEndpointSchema = z.object({
  id: z.string(),
  url: z.url(),
  description: z.string().nullable(),
  /** Event types this endpoint receives. Never empty. */
  eventTypes: z.array(webhookEventTypeSchema),
  /**
   * Set when consecutive failures took the endpoint out of rotation. A disabled
   * endpoint keeps its deliveries in the log so the failure can be diagnosed,
   * and is re-enabled explicitly rather than by a timer.
   */
  disabledAt: z.string().nullable(),
  /** Why it was disabled, in words. Null while it is healthy. */
  disabledReason: z.string().nullable(),
  /** Consecutive failed deliveries. Reset to zero by any success. */
  consecutiveFailures: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>

/** The one response that carries a signing secret. */
export const webhookEndpointCreatedSchema = z.object({
  endpoint: webhookEndpointSchema,
  /** `whsec_…`. Shown once. Store it; it cannot be read back. */
  secret: z.string(),
})
export type WebhookEndpointCreated = z.infer<typeof webhookEndpointCreatedSchema>

/**
 * Registering a receiver.
 *
 * The URL must be absolute and `https` outside development. That is not
 * pedantry: a webhook body carries a customer's prompts and answers, and
 * posting those over plaintext http is a data leak we would be performing on
 * their behalf.
 */
export const createWebhookEndpointInputSchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000, "A webhook URL must be at most 2000 characters"),
  description: z.string().trim().min(1).max(200).optional(),
  /** Omitted means every event type — the reading a person expects. */
  eventTypes: z.array(webhookEventTypeSchema).min(1).optional(),
})
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointInputSchema>

/* ---------------------------------------------------------- the delivery */

export const webhookDeliveryStatusSchema = z.enum([
  /** Queued, or waiting out a backoff between attempts. */
  "PENDING",
  /** The receiver answered 2xx. */
  "DELIVERED",
  /** Attempts are exhausted. Replayable from the delivery log. */
  "FAILED",
])
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>

/**
 * One attempt history for one event to one endpoint.
 *
 * The log is what makes a webhook debuggable from our side rather than only
 * from the receiver's: "we sent it and you 500'd four times" is a different
 * conversation from "we never sent it", and without this table both look
 * identical to everybody.
 */
export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string(),
  eventType: webhookEventTypeSchema,
  status: webhookDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  /** HTTP status of the last attempt. Null when the request never completed. */
  responseStatus: z.number().int().nullable(),
  /** First bytes of the last response body, or the transport error. */
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  /** When the next attempt is due. Null once the delivery is settled. */
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>

/* ---------------------------------------------------------- the signature */

/**
 * Signature header names, per Standard Webhooks.
 *
 * Lowercase because that is how they arrive in a `Headers` object in every
 * runtime, and a receiver reading `req.headers["Webhook-Id"]` in Node gets
 * `undefined` for reasons that take an afternoon to find.
 */
export const WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const

/** How far a delivery's timestamp may be from the receiver's clock. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

const SECRET_PREFIX = "whsec_"
const SECRET_BYTES = 32

export const webhookSecretSchema = z
  .string()
  .startsWith(SECRET_PREFIX, "A signing secret starts with whsec_")
  .refine((value) => value.length > SECRET_PREFIX.length, "A signing secret has a body")

/**
 * Mint a signing secret.
 *
 * Stored in plaintext, alone with the share tokens among this system's secrets,
 * and for a reason that is worth stating rather than assuming: HMAC is
 * symmetric, so signing a delivery *requires* the key material. Hashing it
 * would leave nothing to sign with. What limits the damage instead is that the
 * secret authorises nothing — it proves a payload came from us and grants no
 * access to anything — plus rotation, which is a new endpoint and a deleted
 * old one.
 *
 * Web Crypto rather than `node:crypto`, for the same reason `share.ts` gives:
 * this module is imported by the browser SDK, and one Node-only import at the
 * top of a file poisons every export beside it.
 */
export function mintWebhookSecret(): string {
  const bytes = randomBytes(SECRET_BYTES)
  crypto.getRandomValues(bytes)
  return `${SECRET_PREFIX}${base64Encode(bytes)}`
}

/** Mint the `evt_…` id that a receiver deduplicates on. */
export function mintWebhookEventId(): string {
  const bytes = randomBytes(16)
  return `evt_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Sign one delivery.
 *
 * The signed content is `{id}.{timestamp}.{payload}` and `payload` is the
 * **raw body bytes** — not a re-serialisation of a parsed object. Both halves
 * of this matter: the id and timestamp are inside the signature so a captured
 * delivery cannot be replayed under a new one, and signing the exact bytes is
 * what lets a receiver verify before it parses. (A receiver that parses first
 * and re-stringifies to verify will fail on key order, on unicode escaping, and
 * on nothing else for months.)
 */
export async function signWebhookPayload(input: {
  secret: string
  id: string
  timestampSeconds: number
  payload: string
}): Promise<string> {
  const key = await importSecret(input.secret)
  const content = `${input.id}.${input.timestampSeconds}.${input.payload}`
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(content))
  return `v1,${base64Encode(new Uint8Array(signature))}`
}

/** The three headers a delivery carries. */
export async function webhookSignatureHeaders(input: {
  secret: string
  id: string
  timestampSeconds: number
  payload: string
}): Promise<Record<string, string>> {
  return {
    [WEBHOOK_HEADERS.id]: input.id,
    [WEBHOOK_HEADERS.timestamp]: String(input.timestampSeconds),
    [WEBHOOK_HEADERS.signature]: await signWebhookPayload(input),
  }
}

/** Why a delivery was not accepted. Each one is a different bug to go and fix. */
export type WebhookVerificationFailure =
  | "missing-headers"
  | "malformed-timestamp"
  /** Outside the tolerance window — a replay, or a receiver with a wrong clock. */
  | "stale-timestamp"
  | "no-matching-signature"

export type WebhookVerification =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: WebhookVerificationFailure | "malformed-payload" }

/**
 * Verify a delivery and parse it, in that order.
 *
 * Order is the point: parsing an unverified body means running a schema over
 * bytes a stranger chose. Everything about this function is arranged so that a
 * receiver cannot accidentally do it the other way round — it takes the raw
 * body and returns the *parsed event*, so there is no intermediate value to be
 * tempted by.
 *
 * `headers` is anything with a `get` — a `Headers`, a `Request.headers`, or a
 * small adapter over a framework's own bag — so this works unchanged in Bun,
 * Node, Deno, Cloudflare Workers and a browser.
 */
export async function verifyWebhookSignature(input: {
  secret: string
  payload: string
  headers: { get(name: string): string | null }
  /** Seconds of clock skew tolerated. Defaults to five minutes. */
  toleranceSeconds?: number
  /** Injectable for tests; production reads the wall clock. */
  now?: Date
}): Promise<WebhookVerification> {
  const id = input.headers.get(WEBHOOK_HEADERS.id)
  const timestamp = input.headers.get(WEBHOOK_HEADERS.timestamp)
  const signature = input.headers.get(WEBHOOK_HEADERS.signature)

  if (id === null || timestamp === null || signature === null) {
    return { ok: false, reason: "missing-headers" }
  }

  const seconds = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(seconds)) return { ok: false, reason: "malformed-timestamp" }

  const now = input.now ?? new Date()
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS
  if (Math.abs(Math.floor(now.getTime() / 1000) - seconds) > tolerance) {
    return { ok: false, reason: "stale-timestamp" }
  }

  const expected = await signWebhookPayload({
    secret: input.secret,
    id,
    timestampSeconds: seconds,
    payload: input.payload,
  })

  /*
   * The header may carry several space-delimited signatures — that is how the
   * scheme expresses key rotation, with the old and new secret both signing for
   * a window. Every candidate is compared, and every comparison is constant
   * time: bailing out of the loop on the first match would leak, through
   * timing, which position matched.
   */
  const matched = signature
    .split(" ")
    .map((candidate) => constantTimeEquals(candidate.trim(), expected))
    .reduce((seen, hit) => seen || hit, false)

  if (!matched) return { ok: false, reason: "no-matching-signature" }

  const parsed = webhookEventSchema.safeParse(parseJson(input.payload))
  if (!parsed.success) return { ok: false, reason: "malformed-payload" }

  return { ok: true, event: parsed.data }
}

/* ----------------------------------------------------------------- plumbing */

const encoder = new TextEncoder()

async function importSecret(secret: string): Promise<CryptoKey> {
  // The secret's body is base64 and the *decoded bytes* are the key. Using the
  // printable string as the key instead still produces a stable signature and
  // still verifies against itself, which is exactly why the mistake survives
  // every test a single implementation can write — and fails against every
  // other Standard Webhooks library in existence.
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
  return crypto.subtle.importKey(
    "raw",
    base64Decode(body),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

/**
 * A CSPRNG buffer whose backing store is a plain `ArrayBuffer`.
 *
 * The annotation is load-bearing rather than decorative: `Uint8Array` on its
 * own widens to `Uint8Array<ArrayBufferLike>`, which Web Crypto's `BufferSource`
 * does not accept because it might be a `SharedArrayBuffer`. Naming the narrow
 * type here is what keeps every call below free of an assertion.
 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length))
  crypto.getRandomValues(bytes)
  return bytes
}

function base64Encode(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Compare two signatures without leaking where they diverge.
 *
 * Lengths are compared first and returned as a *result* rather than an early
 * exit, so the loop runs over a fixed span either way. `charCodeAt` past the
 * end is `NaN`, which would poison the XOR, so the shorter string is read
 * modulo its own length — the values are then wrong, which is the correct
 * answer for strings of different lengths.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length, 1)
  let difference = a.length === b.length ? 0 : 1
  for (let index = 0; index < length; index += 1) {
    const left = a.charCodeAt(index % Math.max(a.length, 1))
    const right = b.charCodeAt(index % Math.max(b.length, 1))
    difference |= (Number.isNaN(left) ? 0 : left) ^ (Number.isNaN(right) ? 0 : right)
  }
  return difference === 0
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
