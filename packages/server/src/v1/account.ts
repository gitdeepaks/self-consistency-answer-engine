import { createRoute, OpenAPIHono } from "@hono/zod-openapi"
import { resolveEvaluatorAvailability, resolvePanelAvailability, toHealth } from "@sce/shared"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requirePermission } from "./auth.ts"
import { usageSummaryFor } from "../quota.ts"
import { COMMON_ERRORS } from "./responses.ts"
import * as s from "./schemas.ts"

/**
 * The two questions a client asks before it asks anything else.
 *
 * **Which models are up?** — so a caller choosing a panel finds out before it
 * spends money on a member that is unreachable, rather than by reading a
 * `SKIPPED` candidate afterwards.
 *
 * **How much have I used?** — the same figures that refuse the next request,
 * from the same `quotaStatuses()` call, so the number a client reads and the
 * number that blocks it are one calculation rather than two implementations of
 * the same rule. An API with quotas and no way to read them forces every client
 * to discover its limits by hitting them.
 */

export const account = new OpenAPIHono<AuthEnv>()

account.openapi(
  createRoute({
    method: "get",
    path: "/providers",
    tags: ["Account"],
    summary: "Panel availability",
    description:
      "The model panel a run fans out to, and whether each member is reachable from this " +
      "deployment. A member with `available: false` is seeded as a SKIPPED candidate " +
      "rather than silently dropped, so the panel you asked for is always visible in the " +
      "run you get back.",
    middleware: [requirePermission("run.read")] as const,
    responses: {
      200: {
        description: "The panel and the evaluator.",
        content: { "application/json": { schema: s.ProviderList } },
      },
      ...COMMON_ERRORS,
    },
  }),
  (c) => {
    const evaluator = resolveEvaluatorAvailability()
    return c.json(
      {
        panel: resolvePanelAvailability().map(toHealth),
        evaluator: { ...toHealth(evaluator), role: "evaluator" as const },
      },
      200,
    )
  },
)

account.openapi(
  createRoute({
    method: "get",
    path: "/usage",
    tags: ["Account"],
    summary: "Usage and limits",
    description:
      "This calendar month's spend, the plan's ceilings and how close each one is. Poll " +
      "this rather than discovering a limit by being refused at it — every quota here is " +
      "the same figure the pre-flight check on POST /v1/runs consults.",
    middleware: [requirePermission("usage.read")] as const,
    responses: {
      200: {
        description: "Usage, quotas and entitlements for the calling workspace.",
        content: { "application/json": { schema: s.UsageSummary } },
      },
      ...COMMON_ERRORS,
    },
  }),
  async (c) => c.json(await usageSummaryFor(actorOf(c).tenantId), 200),
)
