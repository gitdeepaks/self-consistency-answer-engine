import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  deleteRun,
  getRun,
  latestEventSeq,
  listRuns,
  recordAuditSafely,
  setRunTags,
} from "@sce/db"
import { runBus } from "@sce/queue"
import {
  actorTypeFor,
  assertNever,
  can,
  CONDITIONAL_HEADERS,
  eventCursorInputSchema,
  eventCursorSchema,
  eventStreamQuerySchema,
  isTerminalEvent,
  runSearchQuerySchema,
  type RunEvent,
  type RunStatus,
} from "@sce/shared"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requirePermission } from "./auth.ts"
import { requestProvenance } from "../auth/resolve.ts"
import { config } from "../env.ts"
import { toRunFilters } from "../filters.ts"
import { assertEntitlement, assertRunAllowed } from "../quota.ts"
import { rateLimit } from "../ratelimit.ts"
import { cancelRun, startRun } from "../runs.ts"
import { conditional } from "./etag.ts"
import { forbidden, notFound } from "./errors.ts"
import { idempotent } from "./idempotency.ts"
import { COMMON_ERRORS, errorResponse, idempotencyHeader } from "./responses.ts"
import * as s from "./schemas.ts"

/**
 * Runs, as a public resource.
 *
 * The handlers are thin on purpose: every one of them delegates to the same
 * `startRun` / `cancelRun` / repository functions the first-party `/api`
 * surface uses. What this layer adds is the *contract* — a documented shape,
 * cursor pagination, conditional reads, idempotent writes and the published
 * error envelope — and nothing else. A route here that grew business logic
 * would be a second implementation of the product, which is the failure this
 * whole phase is arranged to avoid.
 */

const runBudget = rateLimit({
  bucket: "runs.create",
  limit: config.rateLimit.runsPerWindow,
  ipLimit: config.rateLimit.runsPerIpPerWindow,
})

const readBudget = rateLimit({ bucket: "reads", limit: config.rateLimit.readsPerWindow })

const runParams = z.object({
  runId: z.string().min(1).meta({ description: "The run's id, as returned by POST /v1/runs." }),
})

export const runs = new OpenAPIHono<AuthEnv>()

runs.openapi(
  createRoute({
    method: "post",
    path: "/runs",
    tags: ["Runs"],
    summary: "Start a run",
    description:
      "Fans a prompt out across the model panel and returns immediately. The run is " +
      "produced asynchronously; follow it with GET /v1/runs/{runId}/events or a " +
      "run.completed webhook.\n\nSend an Idempotency-Key: a retry carrying the same key " +
      "returns the original run with 200 rather than fanning out a second, identically " +
      "expensive panel.",
    middleware: [requirePermission("run.create"), runBudget, idempotent()] as const,
    request: {
      headers: idempotencyHeader,
      body: { content: { "application/json": { schema: s.CreateRunRequest } }, required: true },
    },
    responses: {
      201: { description: "The run was created.", content: { "application/json": { schema: s.Run } } },
      200: {
        description: "An earlier request with the same Idempotency-Key created this run.",
        content: { "application/json": { schema: s.Run } },
      },
      402: errorResponse("The subscription cannot fund new work."),
      503: errorResponse("The install-wide spend guard is engaged."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const input = c.req.valid("json")
    const { ip, userAgent } = requestProvenance(c.req.raw)

    // The spend gate, before anything is persisted or enqueued: the install-wide
    // budget cap, then whether this subscription can fund new work, then the
    // plan's ceilings. Each refusal is a typed `AppError` that the boundary
    // renders with the limit, the usage and the reset time.
    const allowance = await assertRunAllowed(actor, { ip, userAgent })

    // Choosing the panel is a paid capability, enforced here rather than only
    // hidden in a UI — a feature gated in the interface alone is not gated.
    if (input.providers !== undefined) {
      assertEntitlement(allowance.billing.plan, "panel.custom")
    }

    const { run, created } = await startRun(actor.tenantId, input, {
      idempotencyKey: c.req.valid("header")["idempotency-key"] ?? null,
      createdByUserId: actor.userId,
      limits: allowance.limits,
    })

    return created ? c.json(run, 201) : c.json(run, 200)
  },
)

runs.openapi(
  createRoute({
    method: "get",
    path: "/runs",
    tags: ["Runs"],
    summary: "List runs",
    description:
      "Newest first, cursor-paginated. Pass the previous page's `nextCursor` back as " +
      "`cursor`; the value is opaque and must not be constructed by hand.",
    middleware: [requirePermission("run.read"), readBudget] as const,
    request: { query: runSearchQuerySchema },
    responses: {
      200: { description: "A page of runs.", content: { "application/json": { schema: s.RunPage } } },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const query = c.req.valid("query")
    const page = await listRuns({
      tenantId: actor.tenantId,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      filters: toRunFilters(query, actor.userId),
    })

    return c.json(
      { data: page.items, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
      200,
    )
  },
)

runs.openapi(
  createRoute({
    method: "get",
    path: "/runs/{runId}",
    tags: ["Runs"],
    summary: "Fetch a run",
    description:
      "Returns the run with every candidate and the synthesis.\n\nResponses carry an " +
      "`ETag`. A finished run never changes, so a client polling one should send the tag " +
      "back as `If-None-Match` and get a 304 with no body.",
    middleware: [requirePermission("run.read"), readBudget] as const,
    request: {
      params: runParams,
      headers: z.object({ "if-none-match": z.string().optional() }),
    },
    responses: {
      200: { description: "The run.", content: { "application/json": { schema: s.Run } } },
      304: { description: "The run is unchanged since the supplied ETag." },
      404: errorResponse("No such run in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const run = await getRun(actor.tenantId, c.req.valid("param").runId)
    // Already tenant-scoped by the query, so a run belonging to somebody else is
    // indistinguishable from one that does not exist — which is the point.
    if (run === null) notFound("run")

    // Serialised once and hashed, so the tag describes the bytes the caller
    // would actually receive rather than a row version that may or may not
    // correspond to them.
    const body = JSON.stringify(run)
    const { etag, hit } = conditional(c, body)
    if (hit) return c.body(null, 304, { [CONDITIONAL_HEADERS.etag]: etag })

    return c.json(run, 200, { [CONDITIONAL_HEADERS.etag]: etag })
  },
)

runs.openapi(
  createRoute({
    method: "post",
    path: "/runs/{runId}/cancel",
    tags: ["Runs"],
    summary: "Cancel a run",
    description:
      "Stops a run in flight so it stops spending tokens. Cancelling a run that has " +
      "already finished is not an error: `canceled` is false and the run is returned " +
      "unchanged.",
    middleware: [requirePermission("run.cancel"), idempotent()] as const,
    request: {
      params: runParams,
      headers: idempotencyHeader,
      body: { content: { "application/json": { schema: s.CancelRunRequest } }, required: false },
    },
    responses: {
      200: {
        description: "The run's state after the request.",
        content: { "application/json": { schema: s.CancelResult } },
      },
      404: errorResponse("No such run in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const runId = c.req.valid("param").runId
    const reason = c.req.valid("json")?.reason ?? "Canceled by request"

    // Loaded before acting, because cancelling somebody else's run is a question
    // about *that* run's owner — a permission the actor holds in general does
    // not settle it.
    const existing = await getRun(actor.tenantId, runId)
    if (existing === null) notFound("run")

    assertMayAct(c, "run.cancel", existing.createdByUserId)

    const outcome = await cancelRun(actor.tenantId, runId, reason)
    if (outcome.outcome === "not-found") notFound("run")

    if (outcome.outcome === "canceled") {
      const { ip, userAgent } = requestProvenance(c.req.raw)
      await recordAuditSafely({
        tenantId: actor.tenantId,
        action: "RUN_CANCELED",
        actorType: actorTypeFor(actor.credential),
        actorId: actor.userId ?? actor.credentialId,
        resourceType: "run",
        resourceId: runId,
        ip,
        userAgent,
        metadata: { reason },
      })
    }

    return c.json({ run: outcome.run, canceled: outcome.outcome === "canceled" }, 200)
  },
)

runs.openapi(
  createRoute({
    method: "put",
    path: "/runs/{runId}/tags",
    tags: ["Runs"],
    summary: "Replace a run's tags",
    description:
      "Wholesale rather than add/remove: the list you send becomes the run's complete " +
      "tag set. Sending an empty array removes every tag.",
    middleware: [requirePermission("run.create")] as const,
    request: {
      params: runParams,
      body: { content: { "application/json": { schema: s.SetTagsRequest } }, required: true },
    },
    responses: {
      200: {
        description: "The run's tags after the change.",
        content: { "application/json": { schema: z.object({ tags: z.array(z.string()) }) } },
      },
      404: errorResponse("No such run in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const tags = await setRunTags(actor.tenantId, c.req.valid("param").runId, c.req.valid("json").tags)
    if (tags === null) notFound("run")
    return c.json({ tags }, 200)
  },
)

runs.openapi(
  createRoute({
    method: "delete",
    path: "/runs/{runId}",
    tags: ["Runs"],
    summary: "Delete a run",
    description:
      "Permanent. Usage records survive the deletion so billing stays correct, but they " +
      "no longer reference the run.",
    middleware: [requirePermission("run.delete")] as const,
    request: { params: runParams },
    responses: {
      200: { description: "The run was deleted.", content: { "application/json": { schema: s.Deleted } } },
      404: errorResponse("No such run in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const runId = c.req.valid("param").runId

    const existing = await getRun(actor.tenantId, runId)
    if (existing === null) notFound("run")

    assertMayAct(c, "run.delete", existing.createdByUserId)

    const deleted = await deleteRun(actor.tenantId, runId)
    if (!deleted) notFound("run")

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "RUN_DELETED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "run",
      resourceId: runId,
      ip,
      userAgent,
    })

    return c.json({ deleted: true, id: runId } as const, 200)
  },
)

/**
 * The progress stream.
 *
 * Registered for the specification and mounted as a plain route, rather than
 * through `openapi()`, because the two do not fit: `openapi()` type-checks a
 * handler against a JSON response schema, and this handler returns a
 * `text/event-stream` that never ends. Documenting it by hand is honest; the
 * alternative is declaring a body shape the handler does not return.
 *
 * The cursor design is Phase 2's, unchanged: replay from a position, then
 * follow. Backfill comes from the durable `RunEvent` log in Postgres and the
 * live tail from a Redis Stream, so any replica can serve any run's stream —
 * including one started on a machine that has since been replaced.
 */
runs.openAPIRegistry.registerPath({
  method: "get",
  // Relative to the `servers` entry, like every other path in the document —
  // `registerPath` does not get the prefix that `openapi()` applies for us.
  path: "/runs/{runId}/events",
  tags: ["Runs"],
  summary: "Stream a run's progress",
  description:
    "A Server-Sent Events stream of the run's lifecycle. Each frame's `data` is a " +
    "RunEvent and its `id` is the durable sequence number.\n\n" +
    "Resume after a disconnect by sending the last id you saw as `Last-Event-ID` " +
    "(EventSource does this by itself) or as `?afterSeq=`. Events with no id are " +
    "ephemeral — token deltas — and are not replayed.\n\n" +
    "The stream closes after `run.completed`, `run.failed` or `run.canceled`. A `ping` " +
    "event arrives periodically to keep intermediaries from closing an idle connection.",
  security: [{ bearerAuth: [] }],
  request: {
    params: runParams,
    // The documented shape, not the tolerant one the header is parsed with:
    // OpenAPI cannot express "and if it is rubbish, pretend it was zero".
    query: z.object({
      afterSeq: eventCursorInputSchema
        .optional()
        .meta({ description: "Resume after this durable sequence number." }),
    }),
    headers: z.object({ "last-event-id": z.string().optional() }),
  },
  responses: {
    200: {
      description: "The event stream.",
      content: { "text/event-stream": { schema: z.string() } },
    },
    404: errorResponse("No such run in this workspace."),
  },
})

runs.get(
  "/runs/:runId/events",
  requirePermission("run.read"),
  readBudget,
  async (c) => {
    const tenantId = actorOf(c).tenantId
    const runId = c.req.param("runId")

    const run = await getRun(tenantId, runId)
    if (run === null) notFound("run")

    // `EventSource` resends `Last-Event-ID` by itself; everything else passes
    // `?afterSeq=`. The header wins, because a browser that has one is telling
    // us where it actually got to. Both are parsed — they end up in a database
    // predicate.
    const header = c.req.header("last-event-id")
    const query = eventStreamQuerySchema.safeParse({ afterSeq: c.req.query("afterSeq") })
    const afterSeq =
      header === undefined
        ? (query.success ? query.data.afterSeq : undefined) ?? 0
        : eventCursorSchema.parse(header)

    return streamSSE(c, async (stream) => {
      const controller = new AbortController()
      stream.onAbort(() => {
        controller.abort()
      })

      const send = async (event: RunEvent, seq: number | null): Promise<void> => {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
          ...(seq === null ? {} : { id: String(seq) }),
        })
      }

      try {
        // A run that finished before the durable log existed (or whose events
        // were pruned) has nothing to replay. Synthesise a timeline from the row
        // so a client still sees a beginning and an end.
        const closing = terminalEventFor(run.status, runId, run.error, run.totalLatencyMs)
        if (closing !== null && (await latestEventSeq(tenantId, runId)) <= afterSeq) {
          await send({ type: "run.snapshot", run }, null)
          await send(closing, null)
          return
        }

        for await (const message of runBus().subscribe(tenantId, runId, {
          afterSeq,
          signal: controller.signal,
        })) {
          if (message.kind === "heartbeat") {
            await stream.writeSSE({ data: JSON.stringify({ type: "ping" }), event: "ping" })
            continue
          }
          await send(message.frame.event, message.frame.seq)
          if (isTerminalEvent(message.frame.event)) return
        }
      } finally {
        controller.abort()
      }
    })
  },
)

/**
 * Authorize an action against a run that has already been loaded.
 *
 * `authorizeResource` in the auth middleware does the same job for `/api`, but
 * *returns* the first-party error body — so the public surface asks the same
 * question and throws instead, letting the one boundary render it in the
 * published envelope.
 *
 * The `cross-tenant` branch answering 404 is the important one: a resource in
 * another workspace must be indistinguishable from one that does not exist, or
 * a list of guessed ids becomes a census of somebody else's runs.
 */
function assertMayAct(
  c: Context<AuthEnv>,
  permission: Parameters<typeof can>[1],
  createdByUserId: string | null,
): void {
  const actor = actorOf(c)
  const decision = can(actor, permission, { tenantId: actor.tenantId, createdByUserId })
  if (decision.allowed) return

  if (decision.reason === "cross-tenant") notFound("run")
  forbidden("This credential may not perform that action on this run")
}

/**
 * The closing event for a run that concluded before anyone subscribed, or null
 * when the run is still in flight.
 *
 * An exhaustive switch rather than a check against a list, so adding a status is
 * a compile error here — the one place where getting it wrong means a client
 * waits for ever for an event that never comes.
 */
function terminalEventFor(
  status: RunStatus,
  runId: string,
  error: string | null,
  totalLatencyMs: number | null,
): RunEvent | null {
  switch (status) {
    case "FAILED":
      return { type: "run.failed", runId, error: error ?? "Run failed" }
    case "CANCELED":
      return { type: "run.canceled", runId, reason: error ?? "Run was canceled" }
    case "COMPLETE":
      return { type: "run.completed", runId, totalLatencyMs: totalLatencyMs ?? 0 }
    case "PENDING":
    case "QUEUED":
    case "FANNING_OUT":
    case "SYNTHESIZING":
      return null
    default:
      return assertNever(status, "terminalEventFor")
  }
}
