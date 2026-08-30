import { zValidator } from "@hono/zod-validator"
import { createApiKey, listApiKeys, recordAuditSafely, revokeApiKey } from "@sce/db"
import { actorTypeFor, createApiKeyInputSchema, DEFAULT_SCOPES, type Scope } from "@sce/shared"
import { Hono } from "hono"
import { actorOf, requirePermission, type AuthEnv } from "./auth/middleware.ts"
import { requestProvenance } from "./auth/resolve.ts"
import { assertEntitlement, assertWritable, loadBilling } from "./quota.ts"

/**
 * API key lifecycle.
 *
 * These are the credentials CI and the SDK use. A human at a terminal never
 * needs one — `sce auth login` runs the OAuth + PKCE flow instead — so the
 * paths a key exists for are exactly the ones where a browser cannot be opened.
 *
 * The rule that shapes every handler here: the secret is returned once, by the
 * request that created it, and is unrecoverable afterwards. Everything else in
 * the system works from the prefix.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Narrow requested scopes to what the caller actually holds.
 *
 * Privilege escalation through key creation is the obvious attack: a
 * credential with `runs:read` mints one with `keys:write` and promotes itself.
 * Intersecting rather than rejecting keeps the API forgiving about a client
 * that asks for a sensible superset, while making the escalation impossible.
 */
function grantableScopes(held: readonly Scope[], requested: readonly Scope[] | undefined): Scope[] {
  const wanted = requested ?? DEFAULT_SCOPES
  return wanted.filter((scope) => held.includes(scope))
}

const keys = new Hono<AuthEnv>()

  .get("/", requirePermission("key.read"), async (c) =>
    c.json({ keys: await listApiKeys(actorOf(c).tenantId) }),
  )

  /**
   * Mint a key.
   *
   * 201 with the secret in the body — the only response in the whole API that
   * carries one. It is not logged, not stored in plaintext, and not recoverable
   * from any later request.
   */
  .post("/", requirePermission("key.create"), zValidator("json", createApiKeyInputSchema), async (c) => {
    const actor = actorOf(c)
    const input = c.req.valid("json")

    /*
     * Two commercial gates before a credential is minted, and they are
     * different questions:
     *
     *   - is this workspace allowed to *have* API keys at all (a plan feature),
     *   - and is it currently allowed to create anything (an unpaid workspace
     *     is read-only, and a new key is a write).
     *
     * Both are enforced here rather than in the UI, because a key minted by
     * `curl` spends exactly as much money as one minted by a button.
     */
    const billing = await loadBilling(actor.tenantId)
    assertWritable(billing)
    assertEntitlement(billing.plan, "api.keys")

    const scopes = grantableScopes(actor.scopes, input.scopes)
    if (scopes.length === 0) {
      return c.json(
        {
          error: "None of the requested scopes are held by this credential",
          held: actor.scopes,
        },
        403,
      )
    }

    const created = await createApiKey({
      tenantId: actor.tenantId,
      createdByUserId: actor.userId,
      name: input.name,
      scopes,
      expiresAt:
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * DAY_MS),
    })

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "API_KEY_CREATED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "api_key",
      resourceId: created.key.id,
      ip,
      userAgent,
      // The prefix, never the token. An audit log that records secrets is a
      // second place to steal them from.
      metadata: { prefix: created.key.prefix, scopes, name: input.name },
    })

    return c.json(created, 201)
  })

  /**
   * Revoke a key.
   *
   * Effective immediately, because every request resolves its key from the
   * database — there is no cache to wait out. A key that was already revoked
   * answers 200 as well: the caller's intent is satisfied either way.
   */
  .delete("/:id", requirePermission("key.revoke"), async (c) => {
    const actor = actorOf(c)
    const keyId = c.req.param("id")

    const revoked = await revokeApiKey(actor.tenantId, keyId)

    if (revoked) {
      const { ip, userAgent } = requestProvenance(c.req.raw)
      await recordAuditSafely({
        tenantId: actor.tenantId,
        action: "API_KEY_REVOKED",
        actorType: actorTypeFor(actor.credential),
        actorId: actor.userId ?? actor.credentialId,
        resourceType: "api_key",
        resourceId: keyId,
        ip,
        userAgent,
      })
    }

    return c.json({ ok: true, revoked })
  })

export { keys }
