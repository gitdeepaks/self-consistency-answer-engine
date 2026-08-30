import { zValidator } from "@hono/zod-validator"
import {
  deleteRun,
  getRun,
  latestEventSeq,
  listAuditEvents,
  listRuns,
  recordAuditSafely,
} from "@sce/db"
import { queueConfig, runBus } from "@sce/queue"
import {
  actorTypeFor,
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
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { streamSSE } from "hono/streaming"
import {
  actorOf,
  authorizeResource,
  requireAuth,
  requirePermission,
  type AuthEnv,
} from "./auth/middleware.ts"
import { requestProvenance, TENANT_HEADER } from "./auth/resolve.ts"
import { clerkConfigured, config } from "./env.ts"
import { describeError, isAppError } from "./errors.ts"
import { keys } from "./keys.ts"
import { assertEntitlement, assertRunAllowed } from "./quota.ts"
import { rateLimit } from "./ratelimit.ts"
import { cancelRun, startRun } from "./runs.ts"
import { billing, usage } from "./usage.ts"
import { webhooks } from "./webhooks.ts"

/**
 * Request-scoped values.
 *
 * `actor` is resolved once, by `requireAuth`, and is the only thing a route
 * handler may pass to the repository as an owner. No handler reads a tenant
 * from a header, a query parameter or a body — which is what makes the
 * isolation guarantee hold for routes nobody has written yet, and what
 * `isolation.test.ts` exists to keep true.
 */
type Env = AuthEnv

/**
 * Per-route request budgets.
 *
 * Two, because the routes are not alike: starting a run buys model calls, and
 * reading one reads a row. A single shared budget would either throttle reads
 * pointlessly or let writes through far too fast, which is the failure mode of
 * every "N requests per minute, globally" limiter.
 *
 * Run creation is additionally limited per client IP, because a credential-only
 * limiter cannot see one address minting fresh credentials in a loop.
 */
const runBudget = rateLimit({
  bucket: "runs.create",
  limit: config.rateLimit.runsPerWindow,
  ipLimit: config.rateLimit.runsPerIpPerWindow,
})

const readBudget = rateLimit({ bucket: "reads", limit: config.rateLimit.readsPerWindow })

/**
 * Routes that serve no tenant data, and therefore need no principal.
 *
 * This is the complete public surface, and it is short on purpose:
 *
 *   `/health`      — a liveness probe must not touch the database or Clerk.
 *   `/providers`   — answered from configuration; reveals no tenant's anything.
 *   `/auth/config` — the OAuth discovery document `sce auth login` reads
 *                    *before* it has a credential. Chicken and egg: it cannot
 *                    be authenticated.
 *   `/webhooks/*`  — authenticated by Svix signature instead, since the caller
 *                    is Clerk rather than a user.
 *
 * Everything else is behind `requireAuth`. The allowlist lives here, in the
 * route table, rather than in a path matcher somewhere else — a route added
 * below without a thought is protected, which is the right default.
 */
const api = new Hono<Env>()
  .use("/runs", requireAuth)
  .use("/runs/*", requireAuth)
  .use("/usage", requireAuth)
  .use("/usage/*", requireAuth)
  .use("/billing", requireAuth)
  .use("/keys", requireAuth)
  .use("/keys/*", requireAuth)
  .use("/audit", requireAuth)
  .use("/auth/whoami", requireAuth)

  /**
   * What a client needs to authenticate, before it can authenticate.
   *
   * `sce auth login` reads this to discover the authorization server and the
   * public OAuth client id, so the CLI works against any deployment without
   * being configured for it. Everything here is public by construction: a
   * public OAuth client has no secret, and the issuer is the address of a login
   * page.
   */
  .get("/auth/config", (c) => {
    const { issuer, oauthClientId } = config.clerk
    return c.json({
      // False means this install accepts API keys only. The CLI reads it and
      // says so, instead of opening a browser to a URL that does not exist.
      interactiveLoginAvailable: clerkConfigured() && issuer !== null && oauthClientId !== null,
      issuer,
      clientId: oauthClientId,
      /** RFC 8414 discovery. The CLI reads the real endpoints from here. */
      discoveryUrl: issuer === null ? null : `${issuer}/.well-known/oauth-authorization-server`,
      tenantHeader: TENANT_HEADER,
    })
  })

  /** Who the current credential resolves to. The CLI's `sce auth status`. */
  .get("/auth/whoami", (c) => {
    const actor = actorOf(c)
    return c.json({
      credential: actor.credential,
      tenantId: actor.tenantId,
      userId: actor.userId,
      role: actor.role,
      scopes: actor.scopes,
    })
  })

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
    requirePermission("run.create"),
    runBudget,
    zValidator("json", askInputSchema),
    zValidator("header", runHeadersSchema),
    async (c) => {
      const actor = actorOf(c)
      const headers = c.req.valid("header")
      const input = c.req.valid("json")
      const { ip, userAgent } = requestProvenance(c.req.raw)

      /*
       * The spend gate, before anything is persisted or enqueued.
       *
       * Order matters and it is the order of blast radius: the install-wide
       * budget cap, then whether this subscription can fund new work, then the
       * plan's own ceilings. Each refusal is a typed `AppError` that `onError`
       * renders with the limit, the usage and the reset time — a 429 that only
       * says "429" leaves a client with nothing to do but retry blindly.
       */
      const allowance = await assertRunAllowed(actor, { ip, userAgent })

      // Choosing the panel is a paid capability. Enforced here rather than only
      // hidden in a UI, because a feature gated in the interface alone is not
      // gated at all.
      if (input.providers !== undefined) {
        assertEntitlement(allowance.billing.plan, "panel.custom")
      }

      const { run, created } = await startRun(actor.tenantId, input, {
        idempotencyKey: headers["idempotency-key"] ?? null,
        // Ownership is recorded at creation, which is what lets `can()` answer
        // "your run or a colleague's?" later without a second lookup.
        createdByUserId: actor.userId,
        // Narrowed to what is left of the month, so one enormous run cannot
        // spend an allowance that the pre-flight check just found room in.
        limits: allowance.limits,
      })
      return c.json({ run }, created ? 201 : 200)
    },
  )

  .get(
    "/runs",
    requirePermission("run.read"),
    readBudget,
    zValidator("query", listQueriesInputSchema),
    async (c) => {
      const { limit, cursor } = c.req.valid("query")
      return c.json(await listRuns({ tenantId: actorOf(c).tenantId, limit, cursor }))
    },
  )

  .get("/runs/:id", requirePermission("run.read"), readBudget, async (c) => {
    const actor = actorOf(c)
    const run = await getRun(actor.tenantId, c.req.param("id"))
    // Already tenant-scoped by the query, so a run belonging to somebody else
    // is indistinguishable from one that does not exist — which is the point.
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
  .post(
    "/runs/:id/cancel",
    requirePermission("run.cancel"),
    zValidator("json", cancelRunInputSchema),
    async (c) => {
      const actor = actorOf(c)
      const runId = c.req.param("id")
      const reason = c.req.valid("json").reason ?? "Canceled by request"

      // Loaded before acting, because cancelling somebody else's run is a
      // question about *that* run's owner — a permission the actor holds in
      // general does not settle it.
      const existing = await getRun(actor.tenantId, runId)
      if (!existing) return c.json({ error: "Run not found" }, 404)

      const denied = authorizeResource(c, "run.cancel", {
        tenantId: actor.tenantId,
        createdByUserId: existing.createdByUserId,
      })
      if (denied) return denied

      const outcome = await cancelRun(actor.tenantId, runId, reason)
      if (outcome.outcome === "not-found") return c.json({ error: "Run not found" }, 404)

      if (outcome.outcome === "canceled") {
        const { ip, userAgent } = requestProvenance(c.req.raw)
        await recordAuditSafely({
          tenantId: actor.tenantId,
          action: "RUN_CANCELED",
          actorType: actorTypeFor(actor.credential),
          actorId: actor.userId ?? actor.credentialId,
          resourceType: "run",
          resourceId: runId,
          ip,
          userAgent,
          metadata: { reason },
        })
      }

      // Already finished is not an error — a client that cancels a run which
      // completed a moment earlier got what it wanted, just not because of this.
      return c.json({ run: outcome.run, canceled: outcome.outcome === "canceled" })
    },
  )

  .delete("/runs/:id", requirePermission("run.delete"), async (c) => {
    const actor = actorOf(c)
    const runId = c.req.param("id")

    const existing = await getRun(actor.tenantId, runId)
    if (!existing) return c.json({ error: "Run not found" }, 404)

    const denied = authorizeResource(c, "run.delete", {
      tenantId: actor.tenantId,
      createdByUserId: existing.createdByUserId,
    })
    if (denied) return denied

    const deleted = await deleteRun(actor.tenantId, runId)
    if (!deleted) return c.json({ error: "Run not found" }, 404)

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "RUN_DELETED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "run",
      resourceId: runId,
      ip,
      userAgent,
    })

    return c.json({ ok: true })
  })

  /** The append-only audit trail. Owners and admins only, by role. */
  .get("/audit", requirePermission("audit.read"), async (c) =>
    c.json({ events: await listAuditEvents({ tenantId: actorOf(c).tenantId }) }),
  )

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
  .get(
    "/runs/:id/events",
    requirePermission("run.read"),
    readBudget,
    zValidator("query", eventStreamQuerySchema),
    async (c) => {
    const tenantId = actorOf(c).tenantId
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
    },
  )

  // Mounted rather than inlined: both are self-contained surfaces with their
  // own guards — `keys` behind `requireAuth` above, `webhooks` behind a Svix
  // signature instead of a principal — and the RPC types propagate through
  // `.route()` exactly as they do for a chained handler.
  .route("/keys", keys)
  .route("/usage", usage)
  .route("/billing", billing)
  .route("/webhooks", webhooks)

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
/**
 * CORS.
 *
 * The wildcard default is gone in anything but development (`env.ts` refuses to
 * boot with it in production). The header allowlist is explicit because a
 * browser will not send `Authorization` or the tenant selector unless it is
 * named here, and `credentials: true` is what lets Clerk's session cookie reach
 * the API from the web app's origin.
 */
app.use(
  "/api/*",
  cors({
    origin: config.corsOrigin,
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", TENANT_HEADER],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["WWW-Authenticate"],
    credentials: config.corsOrigin !== "*",
    maxAge: 600,
  }),
)

app.notFound((c) => c.json({ error: "Not found", path: c.req.path }, 404))

/**
 * One place that turns a thrown value into a response.
 *
 * An `AppError` is a decision this code made on purpose — a quota, a rate
 * limit, an unpaid subscription, the spend kill switch — so it renders with its
 * own status, its machine-readable `code`, the headers a client needs to act on
 * it, and a typed body that parses against `apiErrorSchema`. It is expected
 * traffic, not a fault, and is not logged as one.
 *
 * Anything else is a bug: it is logged in full and answered with a generic 500,
 * because the internals of an unexpected failure are exactly what must not
 * reach a caller.
 */
app.onError((error, c) => {
  if (isAppError(error)) {
    return c.json(error.body(), error.status, error.headers())
  }
  console.error("[server] unhandled error", error)
  return c.json({ error: describeError(error), code: "internal_error" }, 500)
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
      "GET  /api/usage": "spend, plan limits and entitlements for the calling tenant",
      "GET  /api/usage/daily": "?from&to -> per-day, per-model spend breakdown",
      "GET  /api/billing": "subscription, access mode and the plan catalogue",
      "GET  /api/audit": "append-only audit trail for the calling tenant",
      "GET  /api/auth/config": "OAuth issuer + public client id for `sce auth login`",
      "GET  /api/auth/whoami": "the principal behind the current credential",
      "GET  /api/keys": "list API keys (secrets are never returned)",
      "POST /api/keys": "{ name, scopes?, expiresInDays? } -> a key, shown once",
      "DEL  /api/keys/:id": "revoke a key, effective immediately",
      "POST /api/webhooks/clerk": "Clerk -> Postgres identity sync (Svix-signed)",
    },
  }),
)

const routes = app.route("/api", api)

export type AppType = typeof routes
export { app }
