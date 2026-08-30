import { zValidator } from "@hono/zod-validator"
import { listUsageDaily } from "@sce/db"
import {
  dayStart,
  PLANS,
  usageDailyQuerySchema,
  USAGE_DAILY_DEFAULT_DAYS,
  USAGE_DAILY_MAX_DAYS,
} from "@sce/shared"
import { Hono } from "hono"
import { actorOf, requirePermission, type AuthEnv } from "./auth/middleware.ts"
import { assertEntitlement, loadBilling, usageSummaryFor } from "./quota.ts"

/**
 * The metering surface.
 *
 * Everything here is a read, and every one of them is scoped to the calling
 * tenant by `actorOf(c).tenantId` — there is no parameter anywhere that lets a
 * caller name a different one, which is what keeps "show me my spend" from
 * being one path traversal away from "show me theirs".
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the requested window, in whole UTC days.
 *
 * Clamped rather than rejected at the far end: a client asking for two years is
 * asking a reasonable question badly, and a truncated answer with its own
 * `from` and `to` in the body is more useful than a 400. The stated window in
 * the response is always the one that was actually served.
 */
function resolveWindow(query: { from?: string; to?: string }, now: Date): { from: Date; to: Date } {
  const to = query.to === undefined ? dayStart(now) : dayStart(new Date(`${query.to}T00:00:00Z`))
  const requestedFrom =
    query.from === undefined
      ? new Date(to.getTime() - (USAGE_DAILY_DEFAULT_DAYS - 1) * DAY_MS)
      : dayStart(new Date(`${query.from}T00:00:00Z`))

  const earliest = new Date(to.getTime() - (USAGE_DAILY_MAX_DAYS - 1) * DAY_MS)
  const from = requestedFrom < earliest ? earliest : requestedFrom

  // An inverted range is a client bug, not a query: answer for the single day
  // they named rather than an empty set that looks like "you spent nothing".
  return from > to ? { from: to, to } : { from, to }
}

const usage = new Hono<AuthEnv>()

  /**
   * Spend, limits and entitlements for the calling tenant.
   *
   * One response, because the three questions a client has — what have I spent,
   * what am I allowed, what may I do — are asked together and answering them
   * from three requests guarantees a UI whose usage bar and upgrade prompt
   * disagree.
   */
  .get("/", requirePermission("usage.read"), async (c) =>
    c.json(await usageSummaryFor(actorOf(c).tenantId)),
  )

  /**
   * Per-day, per-model spend.
   *
   * Served from the rollup table rather than aggregated on read — see
   * `@sce/db`'s metering module for why — and gated on `usage.daily`, which is
   * enforced here rather than only hidden in a UI.
   */
  .get(
    "/daily",
    requirePermission("usage.read"),
    zValidator("query", usageDailyQuerySchema),
    async (c) => {
      const tenantId = actorOf(c).tenantId
      const billing = await loadBilling(tenantId)
      assertEntitlement(billing.plan, "usage.daily")

      const window = resolveWindow(c.req.valid("query"), new Date())
      return c.json(await listUsageDaily({ tenantId, ...window }))
    },
  )

/**
 * Billing state, and the price list.
 *
 * The catalogue is served from the same `PLANS` record the API enforces
 * against, so a pricing page cannot advertise a limit the API does not apply.
 * It is public information — no tenant's data is in it — but it rides on the
 * authenticated route because the interesting part of the response is *which*
 * plan the caller is on.
 */
const billing = new Hono<AuthEnv>().get("/", requirePermission("usage.read"), async (c) => {
  const snapshot = await loadBilling(actorOf(c).tenantId)
  return c.json({
    plan: snapshot.plan,
    subscription: snapshot.subscription,
    access: snapshot.access,
    plans: Object.values(PLANS),
  })
})

export { billing, usage }
