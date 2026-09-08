import { logger, metrics, withSpan, markSpanFailed } from "@sce/observability"
import { createMiddleware } from "hono/factory"
import { matchedRoutes } from "hono/route"
import type { AuthEnv } from "./auth/middleware.ts"
import { requestIdOf } from "./request-id.ts"

export const httpTelemetry = createMiddleware<AuthEnv>(async (c, next) => {
  const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(c.req.method) ? c.req.method : "OTHER"
  const route = matchedRoutes(c).filter((entry) => entry.method !== "ALL").at(-1)?.path ?? "unmatched"
  const started = performance.now()
  await withSpan(`http ${method} ${route}`, { method, route }, async () => {
    await next()
    const status_class = `${Math.floor(c.res.status / 100)}xx`
    if (c.res.status >= 500) markSpanFailed()
    metrics.count("sce.http.requests", 1, { method, route, status_class })
    metrics.histogram("sce.http.duration", (performance.now() - started) / 1000, { method, route, status_class })
    if (process.env.NODE_ENV !== "test") logger.info("HTTP request completed", { method, route, status: c.res.status, requestId: requestIdOf(c) })
  }, { traceparent: c.req.header("traceparent") })
})
