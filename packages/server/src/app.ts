import { zValidator } from "@hono/zod-validator"
import {
  defaultTenant,
  deleteRun,
  getRun,
  latestEventSeq,
  listRuns,
  usageTotals,
} from "@sce/db"
import { queueConfig, runBus } from "@sce/queue"
import {
  assertNever,
  askInputSchema,
  cancelRunInputSchema,
  eventCursorSchema,
  eventStreamQuerySchema,
  isTerminalEvent,
  listQueriesInputSchema,
  resolveEvaluatorAvailability,
  resolvePanelAvailability,
  runHeadersSchema,
  toHealth,
  type RunEvent,
  type RunStatus,
} from "@sce/shared"
import { Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import { config } from "./env.ts"
import { describeError } from "./errors.ts"
import { cancelRun, startRun } from "./runs.ts"

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
      role: "api",
      transport: queueConfig.RUN_TRANSPORT,
      time: new Date().toISOString(),
    }),
  )

  /**
   * Which panel members are usable right now, and how they are reached.
   *
   * Answered from configuration alone — the API no longer constructs provider
   * clients, because it no longer calls them.
   */
  .get("/providers", (c) => {
    const evaluator = resolveEvaluatorAvailability()
    return c.json({
      panel: resolvePanelAvailability().map(toHealth),
      evaluator: { ...toHealth(evaluator), role: "evaluator" as const },
    })
  })

  /**
   * Start a run.
   *
   * Validate, persist, enqueue, return. Nothing here waits on a model, so this
   * handler's latency is a database write and a Redis round trip regardless of
   * how long the answer takes to produce.
   *
   * An `Idempotency-Key` header makes a retry safe: the same key returns the
   * same run with `200` instead of fanning out a second, identically expensive
   * panel.
   */
  .post(
    "/runs",
    zValidator("json", askInputSchema),
    zValidator("header", runHeadersSchema),
    async (c) => {
      const headers = c.req.valid("header")
      const { run, created } = await startRun(c.get("tenantId"), c.req.valid("json"), {
        idempotencyKey: headers["idempotency-key"] ?? null,
      })
      return c.json({ run }, created ? 201 : 200)
    },
  )

  .get("/runs", zValidator("query", listQueriesInputSchema), async (c) => {
    const { limit, cursor } = c.req.valid("query")
    return c.json(await listRuns({ tenantId: c.get("tenantId"), limit, cursor }))
  })

  .get("/runs/:id", async (c) => {
    const run = await getRun(c.get("tenantId"), c.req.param("id"))
    if (!run) return c.json({ error: "Run not found" }, 404)
    return c.json({ run })
  })

  /**
   * Stop a run.
   *
   * A user closing a tab should stop paying for tokens. The row is flipped
   * first and the fast-path signal published second, so the guarantee does not
   * depend on the signal arriving.
   */
  .post("/runs/:id/cancel", zValidator("json", cancelRunInputSchema), async (c) => {
    const outcome = await cancelRun(
      c.get("tenantId"),
      c.req.param("id"),
      c.req.valid("json").reason ?? "Canceled by request",
    )

    if (outcome.outcome === "not-found") return c.json({ error: "Run not found" }, 404)
    // Already finished is not an error — a client that cancels a run which
    // completed a moment earlier got what it wanted, just not because of this.
    return c.json({ run: outcome.run, canceled: outcome.outcome === "canceled" })
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
   * The cursor design is unchanged from the in-memory version — replay from a
   * position, then follow — but the storage behind it is not, and that is the
   * whole of Phase 2's scale-out. Backfill comes from the durable `RunEvent`
   * log in Postgres and the live tail from a Redis Stream, so **any** replica
   * can serve **any** run's stream, including one that was started on a machine
   * that has since been replaced.
   *
   * A reconnecting client resumes with `Last-Event-ID` (which `EventSource`
   * sends by itself) or `?afterSeq=`. Both are parsed, because both are network
   * input that ends up in a database predicate.
   */
  .get("/runs/:id/events", zValidator("query", eventStreamQuerySchema), async (c) => {
    const tenantId = c.get("tenantId")
    const runId = c.req.param("id")

    const run = await getRun(tenantId, runId)
    if (!run) return c.json({ error: "Run not found" }, 404)

    // `EventSource` resends `Last-Event-ID` by itself; everything else passes
    // `?afterSeq=`. The header wins, because a browser that has one is telling
    // us where it actually got to.
    const header = c.req.header("last-event-id")
    const afterSeq =
      header === undefined ? (c.req.valid("query").afterSeq ?? 0) : eventCursorSchema.parse(header)

    return streamSSE(c, async (stream) => {
      const controller = new AbortController()
      stream.onAbort(() => {
        controller.abort()
      })

      /**
       * The SSE id is the durable sequence number, which is what makes
       * `Last-Event-ID` a resume cursor rather than a counter. Ephemeral events
       * have no position in the log, so they are sent without an id — a client
       * that reconnects after one simply does not ask for it back.
       */
      const send = async (event: RunEvent, seq: number | null): Promise<void> => {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
          ...(seq === null ? {} : { id: String(seq) }),
        })
      }

      try {
        // A run that finished before the durable log existed (or whose events
        // were pruned) has nothing to replay. Synthesise a timeline from the
        // row so a client still sees a beginning and an end.
        const closing = terminalEventFor(run.status, runId, run.error, run.totalLatencyMs)
        if (closing && (await latestEventSeq(tenantId, runId)) <= afterSeq) {
          await send({ type: "run.snapshot", run }, null)
          await send(closing, null)
          return
        }

        for await (const message of runBus().subscribe(tenantId, runId, {
          afterSeq,
          signal: controller.signal,
        })) {
          if (message.kind === "heartbeat") {
            await stream.writeSSE({ data: JSON.stringify({ type: "ping" }), event: "ping" })
            continue
          }
          await send(message.frame.event, message.frame.seq)
          if (isTerminalEvent(message.frame.event)) return
        }
      } finally {
        controller.abort()
      }
    })
  })

/**
 * The closing event for a run that concluded before anyone subscribed, or null
 * when the run is still in flight.
 *
 * Written as an exhaustive switch over `RunStatus` rather than a check against
 * a list, so adding a status is a compile error here — the one place where
 * getting it wrong means a client waits for ever for an event that never comes.
 */
function terminalEventFor(
  status: RunStatus,
  runId: string,
  error: string | null,
  totalLatencyMs: number | null,
): RunEvent | null {
  switch (status) {
    case "FAILED":
      return { type: "run.failed", runId, error: error ?? "Run failed" }
    case "CANCELED":
      return { type: "run.canceled", runId, reason: error ?? "Run was canceled" }
    case "COMPLETE":
      return { type: "run.completed", runId, totalLatencyMs: totalLatencyMs ?? 0 }
    case "PENDING":
    case "QUEUED":
    case "FANNING_OUT":
    case "SYNTHESIZING":
      return null
    default:
      return assertNever(status, "terminalEventFor")
  }
}

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
      "POST /api/runs": "{ prompt, providers?, temperature? } -> queued run (Idempotency-Key)",
      "GET  /api/runs": "?limit&cursor -> run history",
      "GET  /api/runs/:id": "full run with candidates + synthesis",
      "POST /api/runs/:id/cancel": "{ reason? } -> stop a run in flight",
      "GET  /api/runs/:id/events": "SSE progress stream (Last-Event-ID or ?afterSeq)",
      "DEL  /api/runs/:id": "delete a run",
      "GET  /api/usage": "token and cost totals for the calling tenant",
    },
  }),
)

const routes = app.route("/api", api)

export type AppType = typeof routes
export { app }
