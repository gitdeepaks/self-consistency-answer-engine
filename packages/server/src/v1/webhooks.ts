import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  enableWebhookEndpoint,
  getWebhookDelivery,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  recordAuditSafely,
  replayWebhookDelivery,
} from "@sce/db"
import { webhookQueue } from "@sce/queue"
import {
  actorTypeFor,
  describeError,
  toCursorPage,
  v1PageQuerySchema,
  webhookDeliveryStatusSchema,
} from "@sce/shared"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requirePermission } from "./auth.ts"
import { requestProvenance } from "../auth/resolve.ts"
import { config } from "../env.ts"
import { invalidField, notFound } from "./errors.ts"
import { idempotent } from "./idempotency.ts"
import { COMMON_ERRORS, errorResponse, idempotencyHeader } from "./responses.ts"
import * as s from "./schemas.ts"

/**
 * Managing webhook endpoints, and reading what was delivered to them.
 *
 * The delivery log is not a nicety. Without it, a customer whose integration is
 * not firing has exactly two hypotheses — "they never sent it" and "we dropped
 * it" — and no way to tell them apart, which turns every webhook question into
 * a support ticket that ends in somebody reading a server log. With it, the
 * customer can see the attempt, the status their own server returned and the
 * body it returned with, and answer the question themselves.
 *
 * Gated on `key.create` / `key.read` rather than on a permission of their own.
 * Registering an endpoint is the same kind of act as minting an API key: it
 * establishes a standing channel out of the workspace, and the people who
 * should be allowed to do one are exactly the people who should be allowed to
 * do the other.
 */

export const webhooks = new OpenAPIHono<AuthEnv>()

const endpointParams = z.object({ endpointId: z.string().min(1) })
const deliveryParams = z.object({ deliveryId: z.string().min(1) })

webhooks.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/endpoints",
    tags: ["Webhooks"],
    summary: "Register an endpoint",
    description:
      "Registers a URL to receive signed events.\n\nThe response carries a `whsec_…` " +
      "signing secret **once**. Store it: it is never returned again, and verifying it on " +
      "every delivery is the only thing that distinguishes an event from us from a POST by " +
      "somebody who read these docs. Rotate by registering a new endpoint and deleting " +
      "the old one.",
    middleware: [requirePermission("key.create"), idempotent()] as const,
    request: {
      headers: idempotencyHeader,
      body: {
        content: { "application/json": { schema: s.CreateWebhookEndpointRequest } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "The endpoint, and its signing secret.",
        content: { "application/json": { schema: s.WebhookEndpointCreated } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const input = c.req.valid("json")

    // A webhook body carries prompts and answers. Posting those over plaintext
    // http would be a data leak performed on the customer's behalf, so it is
    // refused outside development — where a local receiver has no certificate
    // and refusing it would only stop people trying the feature.
    if (input.url.startsWith("http://") && config.isProduction) {
      invalidField("url", "A webhook URL must use https outside development")
    }

    const created = await createWebhookEndpoint({
      tenantId: actor.tenantId,
      createdByUserId: actor.userId,
      url: input.url,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
    })

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "WEBHOOK_ENDPOINT_CREATED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "webhook_endpoint",
      resourceId: created.endpoint.id,
      ip,
      userAgent,
      // The URL and the subscription, never the secret. An audit log that
      // records signing material is a second place to steal it from.
      metadata: { url: created.endpoint.url, eventTypes: created.endpoint.eventTypes },
    })

    return c.json(created, 201)
  },
)

webhooks.openapi(
  createRoute({
    method: "get",
    path: "/webhooks/endpoints",
    tags: ["Webhooks"],
    summary: "List endpoints",
    middleware: [requirePermission("key.read")] as const,
    request: { query: v1PageQuerySchema },
    responses: {
      200: {
        description: "A page of endpoints. Signing secrets are never included.",
        content: { "application/json": { schema: s.WebhookEndpointPage } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const { limit, cursor } = c.req.valid("query")
    const rows = await listWebhookEndpoints({
      tenantId: actorOf(c).tenantId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    })
    return c.json(toCursorPage(rows, limit, (endpoint) => endpoint.id), 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "get",
    path: "/webhooks/endpoints/{endpointId}",
    tags: ["Webhooks"],
    summary: "Fetch an endpoint",
    middleware: [requirePermission("key.read")] as const,
    request: { params: endpointParams },
    responses: {
      200: { description: "The endpoint.", content: { "application/json": { schema: s.WebhookEndpoint } } },
      404: errorResponse("No such endpoint in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const endpoint = await getWebhookEndpoint(actorOf(c).tenantId, c.req.valid("param").endpointId)
    if (endpoint === null) notFound("webhook endpoint")
    return c.json(endpoint, 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "delete",
    path: "/webhooks/endpoints/{endpointId}",
    tags: ["Webhooks"],
    summary: "Delete an endpoint",
    description: "Permanent, and takes its delivery history with it. Effective immediately.",
    middleware: [requirePermission("key.revoke")] as const,
    request: { params: endpointParams },
    responses: {
      200: {
        description: "The endpoint is gone.",
        content: { "application/json": { schema: s.Deleted } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const endpointId = c.req.valid("param").endpointId
    const deleted = await deleteWebhookEndpoint(actor.tenantId, endpointId)

    if (deleted) {
      const { ip, userAgent } = requestProvenance(c.req.raw)
      await recordAuditSafely({
        tenantId: actor.tenantId,
        action: "WEBHOOK_ENDPOINT_DELETED",
        actorType: actorTypeFor(actor.credential),
        actorId: actor.userId ?? actor.credentialId,
        resourceType: "webhook_endpoint",
        resourceId: endpointId,
        ip,
        userAgent,
      })
    }

    return c.json({ deleted: true, id: endpointId } as const, 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/endpoints/{endpointId}/enable",
    tags: ["Webhooks"],
    summary: "Re-enable a disabled endpoint",
    description:
      "An endpoint is taken out of rotation after twenty consecutive failed deliveries. " +
      "Re-enabling is explicit rather than automatic: something at the far end is broken, " +
      "and resuming on a timer would only resume hammering it. Deliveries that failed " +
      "while it was disabled can be replayed from the delivery log.",
    middleware: [requirePermission("key.create"), idempotent()] as const,
    request: { params: endpointParams, headers: idempotencyHeader },
    responses: {
      200: {
        description: "The endpoint, back in rotation.",
        content: { "application/json": { schema: s.WebhookEndpoint } },
      },
      404: errorResponse("No such endpoint in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const endpoint = await enableWebhookEndpoint(
      actorOf(c).tenantId,
      c.req.valid("param").endpointId,
    )
    if (endpoint === null) notFound("webhook endpoint")
    return c.json(endpoint, 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "get",
    path: "/webhooks/deliveries",
    tags: ["Webhooks"],
    summary: "List deliveries",
    description:
      "Every attempt made to every endpoint in this workspace, newest first — with the " +
      "status the receiver returned and the first bytes of its response body.",
    middleware: [requirePermission("key.read")] as const,
    request: {
      query: v1PageQuerySchema.extend({
        endpointId: z.string().min(1).optional(),
        status: webhookDeliveryStatusSchema.optional(),
      }),
    },
    responses: {
      200: {
        description: "A page of deliveries.",
        content: { "application/json": { schema: s.WebhookDeliveryPage } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const { limit, cursor, endpointId, status } = c.req.valid("query")
    const rows = await listWebhookDeliveries({
      tenantId: actorOf(c).tenantId,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      filters: {
        ...(endpointId === undefined ? {} : { endpointId }),
        ...(status === undefined ? {} : { status }),
      },
    })
    return c.json(toCursorPage(rows, limit, (delivery) => delivery.id), 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "get",
    path: "/webhooks/deliveries/{deliveryId}",
    tags: ["Webhooks"],
    summary: "Fetch a delivery",
    middleware: [requirePermission("key.read")] as const,
    request: { params: deliveryParams },
    responses: {
      200: { description: "The delivery.", content: { "application/json": { schema: s.WebhookDelivery } } },
      404: errorResponse("No such delivery in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const delivery = await getWebhookDelivery(actorOf(c).tenantId, c.req.valid("param").deliveryId)
    if (delivery === null) notFound("webhook delivery")
    return c.json(delivery, 200)
  },
)

webhooks.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/deliveries/{deliveryId}/replay",
    tags: ["Webhooks"],
    summary: "Replay a delivery",
    description:
      "Re-sends the original event, bytes unchanged, with its original `webhook-id`. A " +
      "receiver that already handled it should deduplicate on that id — this is a genuine " +
      "redelivery, not a new event that happens to look similar.",
    middleware: [requirePermission("key.create"), idempotent()] as const,
    request: { params: deliveryParams, headers: idempotencyHeader },
    responses: {
      202: {
        description: "The delivery is queued for another attempt.",
        content: { "application/json": { schema: s.WebhookDelivery } },
      },
      404: errorResponse("No such delivery in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const deliveryId = c.req.valid("param").deliveryId

    const delivery = await replayWebhookDelivery(actor.tenantId, deliveryId)
    if (delivery === null) notFound("webhook delivery")

    // Best-effort, because the row is already `PENDING` and due: if the queue is
    // unreachable the outbox sweeper picks it up within a couple of seconds, so
    // failing the request here would report a problem that has already been
    // handled.
    await webhookQueue()
      .enqueue({ tenantId: actor.tenantId, deliveryId })
      .catch((error: unknown) => {
        console.warn("[v1] replay left for the sweeper", {
          deliveryId,
          error: describeError(error),
        })
      })

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "WEBHOOK_REPLAYED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "webhook_delivery",
      resourceId: deliveryId,
      ip,
      userAgent,
      metadata: { endpointId: delivery.endpointId, eventType: delivery.eventType },
    })

    return c.json(delivery, 202)
  },
)
