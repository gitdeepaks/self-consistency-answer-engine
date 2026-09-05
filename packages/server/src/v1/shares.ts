import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createShare,
  getRun,
  listShares,
  listSharesForRun,
  recordAuditSafely,
  revokeShare,
} from "@sce/db"
import { actorTypeFor, can, toCursorPage } from "@sce/shared"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requirePermission } from "./auth.ts"
import { requestProvenance } from "../auth/resolve.ts"
import { conflict, forbidden, notFound } from "./errors.ts"
import { idempotent } from "./idempotency.ts"
import { COMMON_ERRORS, errorResponse, idempotencyHeader } from "./responses.ts"
import * as s from "./schemas.ts"

/**
 * Public links, as a public resource.
 *
 * The capability the token grants is documented here and the token itself is
 * returned in full, because that is the entire feature: an integration that
 * publishes a run wants a URL to put in a message. What is *not* here is the
 * anonymous read side — `GET /api/shared/{token}` — and that omission is
 * deliberate. Serving a share link is a browser's job against the web app's
 * origin, not an SDK call, and putting it in `/v1` would create an
 * unauthenticated route inside an otherwise uniformly authenticated surface,
 * which is exactly the kind of exception that later gets generalised by
 * accident.
 */

export const shares = new OpenAPIHono<AuthEnv>()

const shareParams = z.object({ shareId: z.string().min(1) })
const runParams = z.object({ runId: z.string().min(1) })

shares.openapi(
  createRoute({
    method: "post",
    path: "/runs/{runId}/shares",
    tags: ["Shares"],
    summary: "Publish a run",
    description:
      "Mints a public, read-only link to a finished run. The link carries the synthesised " +
      "answer and nothing that identifies the person, the workspace or the spend behind " +
      "it.\n\nThe token is returned once here and is readable from the link list " +
      "afterwards — it is a capability, not a secret to be hashed. Revoke it with " +
      "DELETE /v1/shares/{shareId}, which takes effect on the next visit.",
    middleware: [requirePermission("run.delete"), idempotent()] as const,
    request: {
      params: runParams,
      headers: idempotencyHeader,
      body: { content: { "application/json": { schema: s.CreateShareRequest } }, required: false },
    },
    responses: {
      201: { description: "The link.", content: { "application/json": { schema: s.RunShare } } },
      404: errorResponse("No such run in this workspace."),
      409: errorResponse("The run has no synthesised answer, so there is nothing to publish."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const runId = c.req.valid("param").runId

    const run = await getRun(actor.tenantId, runId)
    if (run === null) notFound("run")

    // Gated on the *resource*, not merely on the actor: making an answer
    // world-readable is a destructive-grade act, so it follows the same
    // owner-or-admin rule as deleting one.
    const decision = can(actor, "run.delete", {
      tenantId: actor.tenantId,
      createdByUserId: run.createdByUserId,
    })
    if (!decision.allowed) {
      if (decision.reason === "cross-tenant") notFound("run")
      forbidden("This credential may not publish this run")
    }

    // Refused here rather than producing a link that 404s when somebody opens
    // it — a share of a failed run is almost always a link its author did not
    // mean to send.
    if (run.synthesis === null) {
      conflict("This run has no synthesised answer yet, so there is nothing to publish")
    }

    const share = await createShare({
      tenantId: actor.tenantId,
      runId,
      createdByUserId: actor.userId,
      ...(c.req.valid("json") ?? {}),
    })
    if (share === null) notFound("run")

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "RUN_SHARED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "run",
      resourceId: runId,
      ip,
      userAgent,
      // The share id and its expiry, never the token: an audit log that records
      // capability secrets is a second place to steal them from.
      metadata: { shareId: share.id, expiresAt: share.expiresAt },
    })

    return c.json(share, 201)
  },
)

shares.openapi(
  createRoute({
    method: "get",
    path: "/runs/{runId}/shares",
    tags: ["Shares"],
    summary: "List a run's links",
    middleware: [requirePermission("run.read")] as const,
    request: { params: runParams },
    responses: {
      200: {
        description: "Every link published for this run.",
        content: { "application/json": { schema: s.RunSharePage } },
      },
      404: errorResponse("No such run in this workspace."),
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const runId = c.req.valid("param").runId

    // Loaded first so a run in another tenant is a 404 rather than an empty
    // list, which would otherwise confirm the id does not exist *here*.
    const run = await getRun(actor.tenantId, runId)
    if (run === null) notFound("run")

    const links = await listSharesForRun(actor.tenantId, runId)
    // A run's links are few by construction, so this page is always the last
    // one. Shaped as a page anyway: a collection that answers with a bare array
    // is the one an SDK has to special-case for ever.
    return c.json({ data: links, nextCursor: null, hasMore: false }, 200)
  },
)

shares.openapi(
  createRoute({
    method: "get",
    path: "/shares",
    tags: ["Shares"],
    summary: "List every published link",
    description: "The 'what have we made public?' audit for the whole workspace.",
    middleware: [requirePermission("run.read")] as const,
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
    responses: {
      200: {
        description: "A page of links.",
        content: { "application/json": { schema: s.RunSharePage } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const { limit } = c.req.valid("query")
    const rows = await listShares({ tenantId: actorOf(c).tenantId, limit: limit + 1 })
    return c.json(toCursorPage(rows, limit, (share) => share.id), 200)
  },
)

shares.openapi(
  createRoute({
    method: "delete",
    path: "/shares/{shareId}",
    tags: ["Shares"],
    summary: "Revoke a link",
    description:
      "Effective immediately — the link is resolved from the database on every visit, so " +
      "there is no cache to wait out. Revoking a link that was already revoked succeeds " +
      "as well: the caller's intent is satisfied either way.",
    middleware: [requirePermission("run.delete")] as const,
    request: { params: shareParams },
    responses: {
      200: {
        description: "The link is revoked.",
        content: { "application/json": { schema: s.Deleted } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => {
    const actor = actorOf(c)
    const shareId = c.req.valid("param").shareId
    const revoked = await revokeShare(actor.tenantId, shareId)

    if (revoked) {
      const { ip, userAgent } = requestProvenance(c.req.raw)
      await recordAuditSafely({
        tenantId: actor.tenantId,
        action: "RUN_SHARE_REVOKED",
        actorType: actorTypeFor(actor.credential),
        actorId: actor.userId ?? actor.credentialId,
        resourceType: "run_share",
        resourceId: shareId,
        ip,
        userAgent,
      })
    }

    return c.json({ deleted: true, id: shareId } as const, 200)
  },
)
