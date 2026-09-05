import { can, type Permission } from "@sce/shared"
import type { MiddlewareHandler } from "hono"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { authenticate } from "../auth/resolve.ts"
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors.ts"
import { requestIdOf } from "../request-id.ts"

/**
 * The auth wall, rendering the published envelope.
 *
 * The `/api` middleware in `auth/middleware.ts` *returns* its refusals as
 * `{ error, reason }`, which is fine for a client that ships with the server
 * and wrong for a published contract: `/v1` promises that every refusal —
 * including the ones raised before a handler is reached — is
 * `{ code, message, details?, requestId }`. A 401 in a different shape is the
 * first thing an integrator's error handling meets, and the one most likely to
 * be met at three in the morning.
 *
 * What is duplicated here is only the *rendering*. The decisions are the same
 * two functions both surfaces call — `authenticate()` resolves a credential to
 * a principal, `can()` answers whether a principal may act — so there is no
 * second implementation of anything that could disagree. That split is the
 * point: one place decides, each surface says so in its own words.
 */

/**
 * Reject anonymous requests.
 *
 * Throws rather than returns, so it lands on the same boundary that renders
 * every other refusal — which is what makes the envelope a guarantee rather
 * than something each middleware remembers to honour.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const result = await authenticate(c.req.raw)

  if (!result.ok) {
    // The reason is operational signal, not a response. Logged against the
    // request id so the caller's complaint and this line can be joined;
    // suppressed under `bun test`, where the isolation suite rejects
    // credentials by design and dozens of expected warnings would drown the one
    // that is not expected.
    if (process.env["NODE_ENV"] !== "test") {
      console.warn("[v1] rejected request", {
        requestId: requestIdOf(c),
        path: c.req.path,
        method: c.req.method,
        reason: result.reason,
      })
    }

    // 401 says nothing; 403 names what was missing. By the time we can answer
    // 403 we know who is asking, so telling them is safe and useful.
    if (result.status === 401) throw new UnauthorizedError()
    throw new ForbiddenError(result.reason)
  }

  c.set("actor", result.actor)
  await next()
}

/**
 * Require a permission that does not depend on a particular resource.
 *
 * `cross-tenant` answers 404 rather than 403, here as everywhere: a resource in
 * another workspace must be indistinguishable from one that does not exist, or
 * a list of guessed ids becomes a census of somebody else's runs.
 */
export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const decision = can(actorOf(c), permission)

    if (!decision.allowed) {
      if (decision.reason === "cross-tenant") throw new NotFoundError("resource")
      throw new ForbiddenError(`This credential may not ${permission}`)
    }

    await next()
  }
}
