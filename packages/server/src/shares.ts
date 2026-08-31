import { zValidator } from "@hono/zod-validator"
import {
  createShare,
  getRun,
  listSharesForRun,
  listShares,
  recordAuditSafely,
  resolveShare,
  revokeShare,
} from "@sce/db"
import {
  actorTypeFor,
  assertNever,
  createShareInputSchema,
  shareTokenSchema,
  type ShareRejection,
} from "@sce/shared"
import { Hono } from "hono"
import { z } from "zod"
import { actorOf, authorizeResource, requirePermission, type AuthEnv } from "./auth/middleware.ts"
import { requestProvenance } from "./auth/resolve.ts"

/**
 * Publishing a run, and serving what was published.
 *
 * Two surfaces with opposite guards, which is why they are two routers:
 *
 *   - `shares` is mounted behind `requireAuth` and manages links. Creating one
 *     is `run.delete`-adjacent in consequence — it makes a tenant's answer
 *     world-readable — so it is gated on the resource, not just on the actor:
 *     a `member` may publish their own run and not a colleague's.
 *   - `publicShares` is mounted *outside* the auth wall, because its whole
 *     purpose is to serve somebody with no credential. It reads exactly one
 *     thing, by capability token, and returns the redacted projection the
 *     repository builds.
 *
 * Everything a visitor gets is decided in `toSharedRun`; nothing is assembled
 * here. This file's job is the policy around it.
 */

/**
 * Every failure to resolve a link is a 404.
 *
 * The repository distinguishes revoked, expired, unavailable and never-existed
 * because an operator reading a log needs to, but a visitor must not: telling
 * an anonymous caller that a link *expired* confirms it once existed, and turns
 * a guessed token into an oracle. The reason goes to the log and the status
 * goes to the client, and the two carry different amounts of information on
 * purpose.
 */
const NOT_AVAILABLE = "This link is not available"

function logRejection(reason: ShareRejection): void {
  if (process.env.NODE_ENV === "test") return
  switch (reason) {
    case "not-found":
      // Unbounded: anyone can generate tokens all day. Not worth a log line.
      return
    case "revoked":
    case "expired":
    case "unavailable":
      console.info("[shares] refused a link", { reason })
      return
    default:
      return assertNever(reason, "logRejection")
  }
}

/**
 * The anonymous surface.
 *
 * The token is parsed by a validator rather than handed straight to the
 * repository, so a malformed path segment is refused before it becomes a
 * database predicate — and refused with the *same* 404 a valid-but-unknown
 * token gets, so the shape of the token cannot be probed either.
 */
const publicShares = new Hono().get(
  "/:token",
  zValidator("param", z.object({ token: shareTokenSchema }), (result, c) =>
    result.success ? undefined : c.json({ error: NOT_AVAILABLE, code: "not_found" as const }, 404),
  ),
  async (c) => {
    const resolution = await resolveShare(c.req.valid("param").token)
    if (!resolution.ok) {
      logRejection(resolution.reason)
      return c.json({ error: NOT_AVAILABLE, code: "not_found" as const }, 404)
    }
    return c.json({ run: resolution.run })
  },
)

const shares = new Hono<AuthEnv>()

  /** Every link this workspace has ever published. The "what is public?" audit. */
  .get("/", requirePermission("run.read"), async (c) =>
    c.json({ shares: await listShares({ tenantId: actorOf(c).tenantId }) }),
  )

  /**
   * Turn a link off.
   *
   * Effective immediately — `resolveShare` reads the row on every visit and
   * there is no cache to wait out, the same property that makes API key
   * revocation immediate. A link that was already revoked answers 200 as well:
   * the caller's intent is satisfied either way.
   */
  .delete("/:id", requirePermission("run.delete"), async (c) => {
    const actor = actorOf(c)
    const shareId = c.req.param("id")
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

    return c.json({ ok: true, revoked })
  })

/**
 * The per-run half, mounted under `/runs/:id/shares` so a client never has to
 * hold a run id and a share id at the same time to ask "is this published?".
 */
const runShares = new Hono<AuthEnv>()

  .get("/", requirePermission("run.read"), async (c) => {
    const actor = actorOf(c)
    const runId = c.req.param("id") ?? ""

    // Loaded first so a run in another tenant is a 404 rather than an empty
    // list, which would otherwise confirm the id does not exist *here* — a
    // distinction worth nothing to a legitimate caller and everything to a
    // scanner.
    const run = await getRun(actor.tenantId, runId)
    if (!run) return c.json({ error: "Run not found" }, 404)

    return c.json({ shares: await listSharesForRun(actor.tenantId, runId) })
  })

  /**
   * Publish a run.
   *
   * Gated on the *resource*, not merely on the actor: making an answer
   * world-readable is a destructive-grade act, so it follows the same
   * owner-or-admin rule as deleting one. A `member` publishes their own runs;
   * publishing a colleague's is an admin's decision.
   *
   * A run with no synthesis is refused here rather than producing a link that
   * 404s when somebody opens it — a share of a failed run is almost always a
   * link its author did not mean to send.
   */
  .post("/", requirePermission("run.delete"), zValidator("json", createShareInputSchema), async (c) => {
    const actor = actorOf(c)
    const runId = c.req.param("id") ?? ""

    const run = await getRun(actor.tenantId, runId)
    if (!run) return c.json({ error: "Run not found" }, 404)

    const denied = authorizeResource(c, "run.delete", {
      tenantId: actor.tenantId,
      createdByUserId: run.createdByUserId,
    })
    if (denied) return denied

    if (run.synthesis === null) {
      return c.json(
        {
          error: "This run has no synthesised answer yet, so there is nothing to publish",
          code: "conflict" as const,
        },
        409,
      )
    }

    const share = await createShare({
      tenantId: actor.tenantId,
      runId,
      createdByUserId: actor.userId,
      ...c.req.valid("json"),
    })
    if (share === null) return c.json({ error: "Run not found" }, 404)

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

    return c.json({ share }, 201)
  })

export { publicShares, runShares, shares }
