import { getUserById } from "@sce/db"
import type { Actor } from "@sce/shared"
import type { MiddlewareHandler } from "hono"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { config } from "../env.ts"

/**
 * The install-operator gate.
 *
 * This is the only guard in the codebase that is not derived from a row, and
 * that is the entire point. Tenant roles answer "what may this person do inside
 * their workspace"; they must never answer "may this person see every
 * workspace". If `owner` implied operator, every customer's account owner would
 * hold a cross-tenant view of every other customer — an escalation available to
 * anyone who can sign up.
 *
 * So operator status is resolved from `SCE_ADMIN_EMAILS`, a value only somebody
 * with deploy access can set. Nothing a user does, nothing a Clerk webhook
 * writes, and nothing a billing provider reports can grant it.
 *
 * Three properties worth stating, because each is a decision:
 *
 *   - **Keyed by email, not user id.** An id is a cuid that changes when a
 *     database is reset or an identity provider is swapped; an operator's
 *     address does not. The allowlist has to survive both.
 *   - **Empty means nobody.** An install that has not configured this has no
 *     console, which is the right default for a surface that reads every
 *     tenant's data.
 *   - **404, not 403.** An unauthorised caller is told the console does not
 *     exist rather than that they may not use it. There is nothing here for a
 *     customer to appeal, and a 403 advertises an attack surface.
 */

/**
 * Memoised operator decisions, keyed by local user id.
 *
 * The lookup is one indexed read, but it would otherwise run on every request
 * to every console route — and the console is polled by a dashboard. The cache
 * is bounded by the number of *operators plus deniers seen*, which is not
 * bounded by anything an attacker controls… so denials are deliberately **not**
 * cached: only positive decisions are, which caps the map at the size of the
 * allowlist. Removing somebody from the list takes effect on the next deploy,
 * which is when the variable changes anyway.
 */
const operators = new Map<string, true>()

/** Drop the memoised decisions. Tests use this; production restarts instead. */
export function resetAdminCache(): void {
  operators.clear()
}

/** Is the person behind this actor an install operator? */
export async function isInstallAdmin(actor: Actor): Promise<boolean> {
  // An operator is a person. A key-bound credential has none, and the console
  // is deliberately not reachable by API key: it is an interactive surface,
  // and a long-lived cross-tenant credential is exactly what should not exist.
  if (actor.userId === null) return false
  if (config.adminEmails.length === 0) return false
  if (operators.has(actor.userId)) return true

  const user = await getUserById(actor.userId)
  if (user === null) return false

  const allowed = config.adminEmails.includes(user.email.trim().toLowerCase())
  if (allowed) operators.set(actor.userId, true)
  return allowed
}

/**
 * Refuse anyone who is not an install operator.
 *
 * Mounted *after* `requireAuth`, so by the time it runs there is an actor to
 * check — an anonymous caller has already been answered with a 401 and never
 * reaches here.
 */
export const requireInstallAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!(await isInstallAdmin(actorOf(c)))) {
    // Deliberately indistinguishable from a route that does not exist.
    return c.json({ error: "Not found", path: c.req.path }, 404)
  }
  await next()
}
