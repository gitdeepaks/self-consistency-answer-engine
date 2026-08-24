import { zValidator } from "@hono/zod-validator"
import { defaultTenant, deleteRun, getRun, listRuns, usageTotals } from "@sce/db"
import {
  askInputSchema,
  isTerminalEvent,
  listQueriesInputSchema,
  type RunEvent,
} from "@sce/shared"
import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import { config } from "./env.ts"
import { describeError } from "./errors.ts"
import { runEvents } from "./event-bus.ts"
import { startRun } from "./orchestrator.ts"
import { resolveEvaluator, resolvePanel, toHealth } from "./providers.ts"

/** Interval between SSE keep-alive frames, in ms. */
const HEARTBEAT_MS = 15_000

/**
 * Request-scoped values. `tenantId` is resolved by middleware and is the only
 * thing route handlers are allowed to pass to the repository as an owner — no
 * handler reads it from anywhere else, so Phase 3 changes how it is derived and
 * nothing downstream moves.
 */
type Env = { Variables: { tenantId: string } }

/**
 * Attach the owning tenant to the request.
 *
 * Until Phase 3 authenticates callers there is exactly one tenant, but every
 * data path below is already written as if there were many — which is what
 * makes adding real identity a change of one middleware rather than a change of
 * every query.
 */
const withTenant: MiddlewareHandler<Env> = async (c, next) => {
  c.set("tenantId", (await defaultTenant()).id)
  await next()
}

const api = new Hono<Env>()
  // Registered before the routes they guard; `/health` and `/providers` stay
  // out of scope deliberately so a liveness probe never touches the database.
  .use("/runs", withTenant)
  .use("/runs/*", withTenant)
  .use("/usage", withTenant)

  .get("/health", (c) =>
    c.json({
      ok: true,
      service: "self-consistency-answer-engine",
      time: new Date().toISOString(),
    }),
  )

  /** Which panel members are usable right now, and how they are reached. */
  .get("/providers", (c) => {
    const evaluator = resolveEvaluator()
    return c.json({
      panel: resolvePanel().map(toHealth),
      evaluator: { ...toHealth(evaluator), role: "evaluator" as const },
    })
  })

  /** Start a run. Returns the seeded run immediately; progress arrives on SSE. */
  .post("/runs", zValidator("json", askInputSchema), async (c) => {
    const run = await startRun(c.get("tenantId"), c.req.valid("json"))
    return c.json({ run }, 201)
  })

  .get("/runs", zValidator("query", listQueriesInputSchema), async (c) => {
    const { limit, cursor } = c.req.valid("query")
    return c.json(await listRuns({ tenantId: c.get("tenantId"), limit, cursor }))
  })

  .get("/runs/:id", async (c) => {
    const run = await getRun(c.get("tenantId"), c.req.param("id"))
    if (!run) return c.json({ error: "Run not found" }, 404)
    return c.json({ run })
  })

  .delete("/runs/:id", async (c) => {
    const deleted = await deleteRun(c.get("tenantId"), c.req.param("id"))
    if (!deleted) return c.json({ error: "Run not found" }, 404)
    return c.json({ ok: true })
  })

  /** Metered spend for the calling tenant. Quota enforcement lands in Phase 4. */
  .get("/usage", async (c) => c.json({ usage: await usageTotals({ tenantId: c.get("tenantId") }) }))

  /**
   * Live progress for a run.
   *
   * The event buffer is append-only, so a cursor over it gives replay and live
   * follow in one loop with no risk of dropping or duplicating an event — which
   * means a client can connect at any point, or reconnect, and still see the
   * whole timeline.
   */
  .get("/runs/:id/events", async (c) => {
    const runId = c.req.param("id")
    const run = await getRun(c.get("tenantId"), runId)
    if (!run) return c.json({ error: "Run not found" }, 404)

    return streamSSE(c, async (stream) => {
      let seq = 0
      const send = (event: RunEvent | { type: "ping" }) =>
        stream.writeSSE({ data: JSON.stringify(event), event: event.type, id: String(seq++) })

      let wake: (() => void) | null = null
      const unsubscribe = runEvents.subscribe(runId, () => {
        wake?.()
      })

      let aborted = false
      stream.onAbort(() => {
        aborted = true
        wake?.()
      })

      try {
        // Nothing buffered: the run predates this process (or its buffer aged
        // out). Replay a synthetic timeline from the database instead.
        if (runEvents.history(runId).length === 0) {
          await send({ type: "run.snapshot", run })
          if (run.status === "FAILED") {
            await send({ type: "run.failed", runId, error: run.error ?? "Run failed" })
          } else {
            await send({ type: "run.completed", runId, totalLatencyMs: run.totalLatencyMs ?? 0 })
          }
          return
        }

        let cursor = 0
        while (!aborted) {
          const buffer = runEvents.history(runId)
          for (; cursor < buffer.length; cursor++) {
            const event = buffer[cursor]!
            await send(event)
            if (isTerminalEvent(event)) return
          }

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, HEARTBEAT_MS)
            wake = () => {
              clearTimeout(timer)
              wake = null
              resolve()
            }
          })
          if (!aborted && runEvents.history(runId).length === cursor) await send({ type: "ping" })
        }
      } finally {
        unsubscribe()
      }
    })
  })

const app = new Hono()

// Bun sets NODE_ENV=test during `bun test`; request logs would drown the output.
if (process.env.NODE_ENV !== "test") app.use(logger())
app.use("/api/*", cors({ origin: config.corsOrigin }))

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404))
app.onError((error, c) => {
  console.error("[server] unhandled error", error)
  return c.json({ error: describeError(error) }, 500)
})

app.get("/", (c) =>
  c.json({
    name: "self-consistency-answer-engine",
    docs: {
      "GET  /api/health": "liveness probe",
      "GET  /api/providers": "panel + evaluator availability",
      "POST /api/runs": "{ prompt, providers?, temperature? } -> seeded run",
      "GET  /api/runs": "?limit&cursor -> run history",
      "GET  /api/runs/:id": "full run with candidates + synthesis",
      "GET  /api/runs/:id/events": "SSE progress stream",
      "DEL  /api/runs/:id": "delete a run",
      "GET  /api/usage": "token and cost totals for the calling tenant",
    },
  }),
)

const routes = app.route("/api", api)

export type AppType = typeof routes
export { app }
