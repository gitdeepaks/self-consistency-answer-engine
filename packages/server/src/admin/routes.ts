import { zValidator } from "@hono/zod-validator"
import {
  ACTIVE_RUN_STATUSES,
  adminFindRun,
  adminInstallCounts,
  adminTenantRows,
  getRun,
  recordAuditSafely,
  releaseKillSwitch,
  spendByTenant,
} from "@sce/db"
import {
  listDeadLetters,
  queueDepths,
  replayDeadLetter,
  type DeadLetterQueueName,
} from "@sce/queue"
import {
  actorTypeFor,
  adminTenantQuerySchema,
  DEAD_LETTER_TRACE_FRAMES,
  dayStart,
  effectivePlan,
  GLOBAL_SPEND_SWITCH,
  releaseKillSwitchInputSchema,
  replayDeadLetterInputSchema,
  resolveAccess,
  type AdminTenant,
  type DeadLetterView,
} from "@sce/shared"
import { Hono } from "hono"
import { actorOf, type AuthEnv } from "../auth/middleware.ts"
import { requestProvenance } from "../auth/resolve.ts"
import { config } from "../env.ts"
import { globalBudgetStatus, resetBudgetCache } from "../quota.ts"
import { requireInstallAdmin } from "./guard.ts"

/**
 * The internal operations console.
 *
 * Everything here spans tenants, which is why it is a separate router behind a
 * separate guard — see `guard.ts` for why install administration is a different
 * axis from tenant roles rather than the top of the same one.
 *
 * The surface is deliberately shallow. It reads almost everything and writes
 * exactly two things: releasing the spend kill switch, and replaying a
 * dead-lettered job. Both are the things an incident actually needs at three in
 * the morning, both are audited, and anything more destructive stays in the
 * `ops` CLI where it is a deliberate act at a terminal rather than a button
 * somebody can hit by accident.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A dead letter, trimmed for a browser.
 *
 * The payload is parsed against the job union by `deadLetterSchema` at the
 * schema layer; here the stack trace is capped, because a DLQ entry without one
 * is unactionable and a browser rendering ten thousand frames helps nobody.
 */
function toDeadLetterView(letter: {
  queue: DeadLetterQueueName
  jobId: string
  name: string
  data: DeadLetterView["data"]
  attemptsMade: number
  failedReason: string
  stacktrace: string[]
  failedAt: string | null
}): DeadLetterView {
  return {
    queue: letter.queue,
    jobId: letter.jobId,
    name: letter.name,
    data: letter.data,
    attemptsMade: letter.attemptsMade,
    failedReason: letter.failedReason,
    stacktrace: letter.stacktrace.slice(0, DEAD_LETTER_TRACE_FRAMES),
    failedAt: letter.failedAt,
  }
}

const admin = new Hono<AuthEnv>()

  .use("*", requireInstallAdmin)

  /**
   * The front page.
   *
   * One request, because the four questions an operator opens this page with —
   * is spend under control, is the queue moving, is anything dead-lettered, how
   * much is in flight — are asked together, and four separate requests
   * guarantee a dashboard whose panels disagree about what time it is.
   *
   * Queue reads are tolerant of Redis being unreachable: a console that goes
   * blank exactly when the infrastructure is broken is a console that is never
   * there when it matters. A failed panel reports as empty and the rest of the
   * page still renders.
   */
  .get("/overview", async (c) => {
    const now = new Date()
    const [budget, queues, deadLetters, topSpenders, counts] = await Promise.all([
      globalBudgetStatus(now),
      queueDepths().catch(() => []),
      listDeadLetters({ limit: 200 })
        .then((letters) => letters.length)
        .catch(() => 0),
      spendByTenant({
        scope: { kind: "every-tenant", reason: "the operator cost report is cross-tenant by definition" },
        from: dayStart(now),
        limit: 10,
      }),
      adminInstallCounts({
        scope: { kind: "every-tenant", reason: "the operations console counts the whole install" },
        activeStatuses: ACTIVE_RUN_STATUSES,
      }),
    ])

    return c.json({
      budget,
      queues,
      deadLetters,
      topSpenders,
      tenantCount: counts.tenants,
      activeRuns: counts.activeRuns,
      generatedAt: now.toISOString(),
    })
  })

  /** Workspace lookup: by slug, id, or part of a name. */
  .get("/tenants", zValidator("query", adminTenantQuerySchema), async (c) => {
    const { q, limit, days } = c.req.valid("query")
    const now = new Date()
    const from = new Date(dayStart(now).getTime() - (days - 1) * DAY_MS)

    const rows = await adminTenantRows({
      scope: { kind: "every-tenant", reason: "the operations console lists every workspace" },
      ...(q === undefined ? {} : { q }),
      limit,
      from,
    })

    // Plan and access are derived with the *same* pure functions the API
    // enforces with, so the console can never show a workspace as active while
    // the API is refusing its writes.
    const tenants: AdminTenant[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      createdAt: row.createdAt,
      plan: effectivePlan(row.subscription, now),
      subscription: row.subscription,
      access: resolveAccess(row.subscription, now),
      memberCount: row.memberCount,
      runCount: row.runCount,
      costMicroCents: row.costMicroCents,
    }))

    return c.json({ tenants, window: { from: from.toISOString(), to: now.toISOString() } })
  })

  /**
   * The run inspector.
   *
   * Two steps on purpose: the id is resolved to its owning tenant by the
   * operator query, and the run's *contents* are then read through the ordinary
   * tenant-scoped `getRun`. So even here, a customer's prompt comes out of the
   * same function every other caller uses — there is no second read path that
   * could drift from it.
   */
  .get("/runs/:id", async (c) => {
    const located = await adminFindRun({
      scope: {
        kind: "every-tenant",
        reason: "the run inspector resolves a run without knowing its tenant",
      },
      runId: c.req.param("id"),
    })
    if (located === null) return c.json({ error: "Run not found" }, 404)

    const run = await getRun(located.tenantId, located.runId)
    if (run === null) return c.json({ error: "Run not found" }, 404)

    return c.json({
      run,
      tenant: { id: located.tenantId, slug: located.tenantSlug },
      costMicroCents: located.costMicroCents,
      calls: located.calls,
    })
  })

  /* ------------------------------------------------------------- the queue */

  .get("/dlq", async (c) => {
    const letters = await listDeadLetters({ limit: 100 }).catch(() => [])
    return c.json({ deadLetters: letters.map(toDeadLetterView) })
  })

  /**
   * Replay one dead letter.
   *
   * Safe to press twice: the candidate row the job targets is re-read by the
   * processor, and one that already settled `OK` is left alone by its own
   * idempotency check — so a double replay cannot double-charge.
   */
  .post("/dlq/replay", zValidator("json", replayDeadLetterInputSchema), async (c) => {
    const actor = actorOf(c)
    const { queue, jobId } = c.req.valid("json")

    // The queue name arrives from a browser. It is checked against the two the
    // process actually owns rather than passed through, because it selects
    // which Redis key is written to.
    const known = (await queueDepths().catch(() => [])).map((depth) => depth.queue)
    const target = known.find((name) => name === queue)
    if (target === undefined) {
      return c.json({ error: "Unknown queue", code: "validation_failed" as const }, 400)
    }

    const replayed = await replayDeadLetter(target, jobId)

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      // An operator action belongs to no workspace, which is exactly what the
      // nullable tenant on `AuditEvent` is for.
      tenantId: null,
      action: "DLQ_REPLAYED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "job",
      resourceId: jobId,
      ip,
      userAgent,
      metadata: { queue: target, replayed },
    })

    return c.json({ ok: true, replayed })
  })

  /* ----------------------------------------------------------- the switches */

  /**
   * Release the global spend kill switch.
   *
   * The reason is required and is stored: this is the control that stopped the
   * install from spending money, and "who turned it back on, when, and why" is
   * the first question anybody asks afterwards. The cached spend reading is
   * dropped at the same time so the next `POST /runs` re-measures rather than
   * tripping again on a fifteen-second-old figure.
   */
  .post("/budget/release", zValidator("json", releaseKillSwitchInputSchema), async (c) => {
    const actor = actorOf(c)
    const { reason } = c.req.valid("json")

    // The switch row itself clears its reason on release — it records why it
    // *engaged*. Why somebody turned it back on belongs in the append-only
    // audit trail below, which is the log that cannot be overwritten by the
    // next incident.
    const killSwitch = await releaseKillSwitch(GLOBAL_SPEND_SWITCH)
    resetBudgetCache()

    const { ip, userAgent } = requestProvenance(c.req.raw)
    await recordAuditSafely({
      tenantId: null,
      action: "KILL_SWITCH_RELEASED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "kill_switch",
      resourceId: GLOBAL_SPEND_SWITCH,
      ip,
      userAgent,
      metadata: { reason },
    })

    return c.json({ killSwitch, budget: await globalBudgetStatus(new Date()) })
  })

  /** Whether this install has a console at all, and who the caller is. */
  .get("/whoami", (c) => {
    const actor = actorOf(c)
    return c.json({
      userId: actor.userId,
      tenantId: actor.tenantId,
      /** The count only — never the addresses, which are operator identities. */
      operatorCount: config.adminEmails.length,
    })
  })

export { admin }
