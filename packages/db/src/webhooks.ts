import {
  mintWebhookEventId,
  mintWebhookSecret,
  webhookDeliveryStatusSchema,
  webhookEventTypeSchema,
  WEBHOOK_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhookEvent,
  type WebhookEventType,
} from "@sce/shared"
import { z } from "zod"
import { prisma } from "./client.ts"

/**
 * Outbound webhooks: endpoints, and the deliveries made to them.
 *
 * The inbound Clerk deduplication table lives in `auth.ts` and shares nothing
 * with this file but a word — see `claimWebhookDelivery` there.
 *
 * The shape that matters here is that **emission and delivery are separate
 * transactions.** `dispatchWebhookEvent` writes one row per subscribed
 * endpoint and returns; a queue job later picks each row up and performs the
 * HTTP request. Doing the request inline would put a customer's unreachable
 * server on the critical path of finishing a run, which is exactly the coupling
 * a webhook exists to avoid — and would make "we tried" unrecoverable state in
 * a process that is about to be redeployed.
 *
 * The `(endpointId, eventId)` unique index is what makes emission itself
 * idempotent: a synthesis job redelivered by the queue after a crash tries to
 * insert the same pair and conflicts, rather than sending a customer a second
 * copy of an event they already handled.
 */

/** How many consecutive failures take an endpoint out of rotation. */
export const WEBHOOK_FAILURE_THRESHOLD = 20

/** Longest error text kept on a delivery row. */
const ERROR_MAX_CHARS = 500

type EndpointRow = Awaited<ReturnType<typeof prisma.webhookEndpoint.findFirstOrThrow>>
type DispatchRow = Awaited<ReturnType<typeof prisma.webhookDispatch.findFirstOrThrow>>

/**
 * Event types, parsed on the way out of the database.
 *
 * The column is `text[]`, so a row written by an older build — or edited in
 * psql — can name an event this build does not have. Unknown entries are
 * dropped rather than rejected: an endpoint subscribed to four things, one of
 * which no longer exists, should keep receiving the other three. Failing closed
 * on the whole row would silently stop a working integration.
 */
const storedEventTypesSchema = z
  .array(z.string())
  .transform((values): WebhookEventType[] =>
    values.flatMap((value) => {
      const parsed = webhookEventTypeSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    }),
  )

export function toWebhookEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: storedEventTypesSchema.parse(row.eventTypes),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toWebhookDelivery(row: DispatchRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    // Parsed rather than passed through: `eventType` is a plain text column,
    // and a value this build cannot name must not reach a client typed as one
    // of the union's members.
    eventType: webhookEventTypeSchema.parse(row.eventType),
    status: webhookDeliveryStatusSchema.parse(row.status),
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/* ------------------------------------------------------------- endpoints */

export interface CreateWebhookEndpointOptions {
  tenantId: string
  createdByUserId: string | null
  url: string
  description?: string
  /** Omitted subscribes the endpoint to every event type. */
  eventTypes?: readonly WebhookEventType[]
}

/**
 * Register a receiver, and mint the secret it will verify with.
 *
 * The secret is returned here and nowhere else, exactly like an API key — but
 * for a different reason. A key is hashed because we never need to reproduce
 * it; a signing secret is *stored* because HMAC is symmetric and signing
 * requires the key material. What makes that acceptable is that the secret
 * authorises nothing: it proves a payload came from us, and grants access to no
 * data at all.
 */
export async function createWebhookEndpoint(
  options: CreateWebhookEndpointOptions,
): Promise<WebhookEndpointCreated> {
  const secret = mintWebhookSecret()
  const row = await prisma.webhookEndpoint.create({
    data: {
      tenantId: options.tenantId,
      createdByUserId: options.createdByUserId,
      url: options.url,
      description: options.description ?? null,
      secret,
      eventTypes: [...(options.eventTypes ?? WEBHOOK_EVENT_TYPES)],
    },
  })
  return { endpoint: toWebhookEndpoint(row), secret }
}

/**
 * A page of endpoints, over-fetched by one.
 *
 * The extra row is how the caller learns there is a next page without a second
 * `count(*)` over a growing table; `toCursorPage` in @sce/shared trims it and
 * turns it into the cursor.
 */
export async function listWebhookEndpoints(options: {
  tenantId: string
  limit: number
  cursor?: string
}): Promise<WebhookEndpoint[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { tenantId: options.tenantId },
    take: options.limit + 1,
    ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    orderBy: { createdAt: "desc" },
  })
  return rows.map(toWebhookEndpoint)
}

export async function getWebhookEndpoint(
  tenantId: string,
  endpointId: string,
): Promise<WebhookEndpoint | null> {
  const row = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, tenantId } })
  return row === null ? null : toWebhookEndpoint(row)
}

/**
 * Delete a receiver.
 *
 * A hard delete, unlike an API key's revocation-as-timestamp, and the asymmetry
 * is deliberate: a revoked key still has to resolve so the audit trail can say
 * which credential did what, whereas a deleted endpoint has no history that
 * needs it — its deliveries cascade away with it, and the audit row records
 * that it existed and who removed it.
 */
export async function deleteWebhookEndpoint(
  tenantId: string,
  endpointId: string,
): Promise<boolean> {
  const result = await prisma.webhookEndpoint.deleteMany({ where: { id: endpointId, tenantId } })
  return result.count > 0
}

/**
 * Put a disabled endpoint back into rotation.
 *
 * Explicit rather than on a timer: an endpoint is disabled after twenty
 * consecutive failures, which means something at the far end is broken, and
 * re-enabling on a schedule would simply resume hammering it. Somebody has to
 * say the far end is fixed.
 */
export async function enableWebhookEndpoint(
  tenantId: string,
  endpointId: string,
): Promise<WebhookEndpoint | null> {
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id: endpointId, tenantId },
    data: { disabledAt: null, disabledReason: null, consecutiveFailures: 0 },
  })
  if (result.count === 0) return null
  return getWebhookEndpoint(tenantId, endpointId)
}

/* ------------------------------------------------------------ deliveries */

/**
 * A dispatch plus the endpoint it is addressed to.
 *
 * Returned as one object because the delivery worker needs all of it — the
 * bytes to send, the URL to send them to, and the secret to sign with — and
 * reading it in one query is what stops a rotated secret from being applied to
 * half of a retry.
 */
export interface PendingWebhookDelivery {
  id: string
  endpointId: string
  eventId: string
  eventType: WebhookEventType
  /** The exact bytes that were signed. Sent verbatim; never re-serialised. */
  payload: string
  attempts: number
  url: string
  secret: string
  /** True when the endpoint has since been disabled or deleted. */
  endpointDisabled: boolean
}

/**
 * Create one dispatch per subscribed, enabled endpoint.
 *
 * Returns the rows that were actually created, which is what the caller
 * enqueues. A conflict on `(endpointId, eventId)` means this exact event was
 * already dispatched to that endpoint — by a redelivery of the job that emitted
 * it — and is skipped rather than raised: at-least-once emission plus a unique
 * index is precisely how at-most-once delivery is obtained.
 */
export async function dispatchWebhookEvent(options: {
  tenantId: string
  event: WebhookEvent
}): Promise<string[]> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      tenantId: options.tenantId,
      disabledAt: null,
      eventTypes: { has: options.event.type },
    },
    select: { id: true },
  })
  if (endpoints.length === 0) return []

  // Serialised once, here, and stored as the bytes that will be signed. A
  // second `JSON.stringify` at delivery time can produce a different string —
  // key order and unicode escaping are not guaranteed stable across builds —
  // and the signature would then verify against nothing.
  const payload = JSON.stringify(options.event)

  const created: string[] = []
  for (const endpoint of endpoints) {
    try {
      const row = await prisma.webhookDispatch.create({
        data: {
          tenantId: options.tenantId,
          endpointId: endpoint.id,
          eventId: options.event.id,
          eventType: options.event.type,
          payload,
          nextAttemptAt: new Date(),
        },
        select: { id: true },
      })
      created.push(row.id)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
  return created
}

/** Load a delivery for an attempt. Null when it has been deleted or settled. */
export async function claimWebhookDispatch(
  tenantId: string,
  deliveryId: string,
): Promise<PendingWebhookDelivery | null> {
  const row = await prisma.webhookDispatch.findFirst({
    where: { id: deliveryId, tenantId },
    include: { endpoint: { select: { url: true, secret: true, disabledAt: true } } },
  })
  if (row === null) return null

  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: webhookEventTypeSchema.parse(row.eventType),
    payload: row.payload,
    attempts: row.attempts,
    url: row.endpoint.url,
    secret: row.endpoint.secret,
    endpointDisabled: row.endpoint.disabledAt !== null,
  }
}

/**
 * Record a 2xx.
 *
 * The endpoint's failure counter is reset in the same call, so a receiver that
 * fails intermittently never accumulates its way to being disabled — only a
 * genuinely consecutive run of failures does.
 */
export async function recordWebhookSuccess(options: {
  tenantId: string
  deliveryId: string
  endpointId: string
  responseStatus: number
  attempts: number
}): Promise<void> {
  await prisma.webhookDispatch.updateMany({
    where: { id: options.deliveryId, tenantId: options.tenantId },
    data: {
      status: "DELIVERED",
      attempts: options.attempts,
      responseStatus: options.responseStatus,
      lastError: null,
      deliveredAt: new Date(),
      nextAttemptAt: null,
    },
  })
  await prisma.webhookEndpoint.updateMany({
    where: { id: options.endpointId, tenantId: options.tenantId },
    data: { consecutiveFailures: 0 },
  })
}

/** What happened to the endpoint as a result of one failed attempt. */
export interface WebhookFailureOutcome {
  /** True when this failure took the endpoint out of rotation. */
  disabled: boolean
  consecutiveFailures: number
}

/**
 * Record a failed attempt.
 *
 * `exhausted` is decided by the caller — the queue knows how many attempts a
 * job has left, and this layer does not — so the row's terminal state is
 * written by the attempt that knows it is the last one, rather than inferred
 * afterwards by something racing the next delivery.
 */
export async function recordWebhookFailure(options: {
  tenantId: string
  deliveryId: string
  endpointId: string
  responseStatus: number | null
  error: string
  attempts: number
  exhausted: boolean
  nextAttemptAt: Date | null
}): Promise<WebhookFailureOutcome> {
  await prisma.webhookDispatch.updateMany({
    where: { id: options.deliveryId, tenantId: options.tenantId },
    data: {
      status: options.exhausted ? "FAILED" : "PENDING",
      attempts: options.attempts,
      responseStatus: options.responseStatus,
      lastError: options.error.slice(0, ERROR_MAX_CHARS),
      nextAttemptAt: options.exhausted ? null : options.nextAttemptAt,
    },
  })

  if (!options.exhausted) return { disabled: false, consecutiveFailures: 0 }

  // Counted only when the delivery gives up entirely. Counting every attempt
  // would disable an endpoint after five genuinely-failed deliveries rather
  // than twenty, because each one contributes its whole retry schedule.
  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: options.endpointId, tenantId: options.tenantId },
    data: { consecutiveFailures: { increment: 1 } },
    select: { consecutiveFailures: true, disabledAt: true },
  })

  if (endpoint.consecutiveFailures < WEBHOOK_FAILURE_THRESHOLD || endpoint.disabledAt !== null) {
    return { disabled: false, consecutiveFailures: endpoint.consecutiveFailures }
  }

  await prisma.webhookEndpoint.updateMany({
    where: { id: options.endpointId, tenantId: options.tenantId },
    data: {
      disabledAt: new Date(),
      disabledReason:
        `Disabled after ${endpoint.consecutiveFailures} consecutive failed deliveries. ` +
        "Fix the receiver and re-enable the endpoint.",
    },
  })
  return { disabled: true, consecutiveFailures: endpoint.consecutiveFailures }
}

export interface WebhookDeliveryFilters {
  endpointId?: string
  status?: WebhookDeliveryStatus
}

/** A page of the delivery log, over-fetched by one. Newest first. */
export async function listWebhookDeliveries(options: {
  tenantId: string
  limit: number
  cursor?: string
  filters?: WebhookDeliveryFilters
}): Promise<WebhookDelivery[]> {
  const filters = options.filters ?? {}
  const rows = await prisma.webhookDispatch.findMany({
    where: {
      tenantId: options.tenantId,
      ...(filters.endpointId === undefined ? {} : { endpointId: filters.endpointId }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
    },
    take: options.limit + 1,
    ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    orderBy: { createdAt: "desc" },
  })
  return rows.map(toWebhookDelivery)
}

export async function getWebhookDelivery(
  tenantId: string,
  deliveryId: string,
): Promise<WebhookDelivery | null> {
  const row = await prisma.webhookDispatch.findFirst({ where: { id: deliveryId, tenantId } })
  return row === null ? null : toWebhookDelivery(row)
}

/**
 * Put a settled delivery back in the queue.
 *
 * The event id and payload are untouched, so a receiver that already processed
 * it deduplicates on `webhook-id` exactly as it is supposed to — a replay is a
 * genuine redelivery of the same event, not a new one that happens to look
 * similar. Attempts are reset because the operator replaying it has, by doing
 * so, asserted that the reason for the previous failures is gone.
 */
export async function replayWebhookDelivery(
  tenantId: string,
  deliveryId: string,
): Promise<WebhookDelivery | null> {
  const result = await prisma.webhookDispatch.updateMany({
    where: { id: deliveryId, tenantId },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: null,
      responseStatus: null,
      deliveredAt: null,
      nextAttemptAt: new Date(),
    },
  })
  if (result.count === 0) return null
  return getWebhookDelivery(tenantId, deliveryId)
}

/**
 * Deliveries that are due to be attempted, across the install.
 *
 * This is the outbox half of the design, and it is what makes emission a single
 * database write rather than a dual write to Postgres *and* Redis. A run
 * finishing writes its dispatch rows and stops caring; the worker's sweeper
 * turns those rows into queue jobs a moment later. If Redis is unreachable at
 * the instant a run completes, the event is not lost — it is simply picked up
 * on the next sweep, which is the difference between a delayed webhook and a
 * missing one.
 *
 * Cross-tenant by construction, so it takes an explicit reason at the call
 * site, the same discipline `MeteringScope` imposes on the cost aggregates.
 */
export async function listDueWebhookDeliveries(options: {
  before: Date
  limit: number
  scope: { kind: "every-tenant"; reason: string }
}): Promise<Array<{ id: string; tenantId: string }>> {
  return prisma.webhookDispatch.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: options.before } },
    take: options.limit,
    orderBy: { nextAttemptAt: "asc" },
    select: { id: true, tenantId: true },
  })
}

/**
 * Delete delivery rows older than a cut-off, across the install.
 *
 * Cross-tenant by construction — a retention sweep that had to be told which
 * workspace to clean would simply never run for the ones nobody remembered —
 * and therefore takes an explicit reason at the call site, the same discipline
 * `MeteringScope` imposes on the cost aggregates.
 */
export async function pruneWebhookDeliveries(options: {
  before: Date
  scope: { kind: "every-tenant"; reason: string }
}): Promise<number> {
  const result = await prisma.webhookDispatch.deleteMany({
    where: { createdAt: { lt: options.before }, status: { in: ["DELIVERED", "FAILED"] } },
  })
  return result.count
}

/**
 * Prisma's known-request errors arrive as `unknown` in a catch block. Parsed
 * with a schema rather than asserted, for the same reason `createRunIdempotent`
 * does it: the one shape check that decides whether a customer receives a
 * duplicate event is not a good place for a claim the compiler cannot verify.
 */
const prismaErrorCodeSchema = z.object({ code: z.string() })

function isUniqueViolation(error: unknown): boolean {
  const parsed = prismaErrorCodeSchema.safeParse(error)
  return parsed.success && parsed.data.code === "P2002"
}

/** Freshly minted event ids, so callers need not import the shared minter. */
export { mintWebhookEventId }
