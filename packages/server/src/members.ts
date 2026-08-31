import { listMemberships, listTenantMembers } from "@sce/db"
import { Hono } from "hono"
import { actorOf, requirePermission, type AuthEnv } from "./auth/middleware.ts"

/**
 * Who is in this workspace, and which workspaces the caller can act inside.
 *
 * Read-only, and deliberately so. Clerk owns identity: invitations, removals
 * and role changes happen in Clerk's organization UI and arrive here through
 * the webhook that already syncs them. A second write path would let this
 * database and Clerk disagree about who works at a company — precisely the
 * drift Phase 3's nightly reconciliation job exists to *detect*, which would be
 * a strange thing to then go and cause on purpose.
 *
 * What this API adds is the join Clerk cannot do: a roster annotated with what
 * each person has actually done here.
 */

const members = new Hono<AuthEnv>()

  .get("/", requirePermission("member.read"), async (c) => {
    const actor = actorOf(c)
    const roster = await listTenantMembers({
      tenantId: actor.tenantId,
      selfUserId: actor.userId,
    })
    return c.json({ members: roster })
  })

  /**
   * The workspaces this person belongs to, for the org switcher.
   *
   * `active` is resolved from the actor the auth layer already produced, rather
   * than from anything the client passes — so the switcher can never highlight
   * a workspace different from the one requests are actually being served
   * against, which is the failure mode that makes a switcher untrustworthy.
   *
   * A key-bound credential has no person, and therefore no set of workspaces to
   * choose between: it is bound to exactly one, and the answer is that one.
   */
  .get("/workspaces", requirePermission("member.read"), async (c) => {
    const actor = actorOf(c)

    if (actor.userId === null) {
      return c.json({ workspaces: [], reason: "credential-bound-to-one-workspace" as const })
    }

    const memberships = await listMemberships(actor.userId)
    return c.json({
      workspaces: memberships.map((membership) => ({
        id: membership.tenant.id,
        slug: membership.tenant.slug,
        name: membership.tenant.name,
        role: membership.role,
        active: membership.tenant.id === actor.tenantId,
      })),
      reason: null,
    })
  })

export { members }
