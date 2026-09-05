import { can, type Actor, type DenialReason, type Permission, type Resource } from "@sce/shared"
import type { Context, MiddlewareHandler } from "hono"
import type { RequestIdEnv } from "../request-id.ts"
import { authenticate } from "./resolve.ts"

/**
 * Authentication and authorization as Hono middleware.
 *
 * Two separate gates, applied in order:
 *
 *   `requireAuth`        — do we know who this is? No → 401.
 *   `requirePermission`  — may they do this? No → 403.
 *
 * Keeping them apart is what makes the difference between "log in" and "you
 * cannot do that" a property of the system rather than of whichever error
 * message a handler happened to write.
 */

/**
 * Request-scoped values.
 *
 * `actor` replaces the `tenantId` the pre-identity middleware set. Handlers
 * read `actor.tenantId` and nothing else as an owner — there is no second
 * source for it, which is what makes the isolation suite's guarantee hold for
 * routes nobody has written yet.
 *
 * `requestId` comes in from `RequestIdEnv` rather than being declared again
 * here, because it is set by a middleware that runs before this one and is read
 * by the public error envelope afterwards — an intersection keeps one
 * definition of it and lets both halves of the request see the same value.
 */
export type AuthEnv = RequestIdEnv & { Variables: { actor: Actor } }

/** The actor for the current request. */
export function actorOf(c: Context<AuthEnv>): Actor {
  return c.get("actor")
}

/**
 * A 401 that says nothing useful to an attacker.
 *
 * `WWW-Authenticate` is there because it is what the status code means: a
 * client that gets one knows to go and authenticate, which is exactly what
 * `sce auth login` keys off. The *reason* goes to the log, never the body —
 * "your key is revoked" versus "no such key" tells someone which half of a
 * guess was right.
 */
function unauthorized(c: Context<AuthEnv>, reason: string): Response {
  // The reason is operational signal, not a response. Suppressed under `bun
  // test` for the same reason the request logger is: the isolation suite
  // rejects credentials by design, and dozens of expected warnings drown the
  // one that is not expected.
  if (process.env.NODE_ENV !== "test") {
    console.warn("[auth] rejected request", {
      path: c.req.path,
      method: c.req.method,
      reason,
    })
  }
  return c.json({ error: "Authentication required" }, 401, {
    "WWW-Authenticate": 'Bearer realm="sce", error="invalid_token"',
  })
}

/** A 403. The caller is known, so naming what was missing is safe and useful. */
function forbidden(c: Context<AuthEnv>, reason: string): Response {
  return c.json({ error: "Forbidden", reason }, 403)
}

/**
 * Reject anonymous requests.
 *
 * Every route that touches tenant data is behind this. The public routes —
 * health, provider availability, the OAuth discovery document the CLI needs
 * *before* it can authenticate — are allowlisted explicitly by simply not
 * mounting this middleware on them, which keeps the allowlist visible in the
 * route table instead of buried in a matcher.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const result = await authenticate(c.req.raw)

  if (!result.ok) {
    return result.status === 401 ? unauthorized(c, result.reason) : forbidden(c, result.reason)
  }

  c.set("actor", result.actor)
  await next()
}

/** Turn a denial into the status that describes it. */
function denialStatus(reason: DenialReason): 403 | 404 {
  switch (reason) {
    // A resource in another tenant must not be distinguishable from one that
    // does not exist. Answering 403 here would confirm the id is real, which
    // turns a list of guessed ids into a census of another tenant's runs.
    case "cross-tenant":
      return 404
    case "role":
    case "scope":
    case "not-owner":
      return 403
  }
}

/**
 * Require a permission that does not depend on a particular resource.
 *
 * `POST /runs` is the shape this fits: whether you may create a run is a fact
 * about you, not about any row. Anything that acts on an existing row uses
 * `authorizeResource` below, after loading it.
 */
export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const decision = can(actorOf(c), permission)
    if (!decision.allowed) {
      return c.json(
        { error: "Forbidden", reason: decision.reason, permission },
        denialStatus(decision.reason),
      )
    }
    await next()
  }
}

/**
 * Check a permission against a loaded resource.
 *
 * Returns the refusal `Response` to return, or null to carry on — so a handler
 * reads as `const denied = authorizeResource(...); if (denied) return denied`,
 * which is hard to write and then forget to act on.
 */
export function authorizeResource(
  c: Context<AuthEnv>,
  permission: Permission,
  resource: Resource,
): Response | null {
  const decision = can(actorOf(c), permission, resource)
  if (decision.allowed) return null

  const status = denialStatus(decision.reason)
  return status === 404
    ? c.json({ error: "Run not found" }, 404)
    : c.json({ error: "Forbidden", reason: decision.reason, permission }, 403)
}
