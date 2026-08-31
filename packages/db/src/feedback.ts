import type { FeedbackSummary, RunFeedback, SubmitFeedbackInput } from "@sce/shared"
import { prisma } from "./client.ts"

/**
 * Human verdicts on runs.
 *
 * The table is small, the queries are boring, and it is one of the highest
 * leverage things in the repository: it is where Phase 7's eval set comes from.
 * Everything here is tenant-scoped like the rest of this layer, and feedback
 * additionally requires a *person* — see `submitFeedback`.
 */

type FeedbackRow = Awaited<ReturnType<typeof prisma.runFeedback.findFirstOrThrow>>

export function toRunFeedback(row: FeedbackRow): RunFeedback {
  return {
    id: row.id,
    runId: row.runId,
    userId: row.userId,
    rating: row.rating,
    reason: row.reason,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface SubmitFeedbackOptions extends SubmitFeedbackInput {
  tenantId: string
  runId: string
  /** Required. A credential with no person behind it cannot leave a verdict. */
  userId: string
}

/**
 * Record — or correct — one person's verdict on one run.
 *
 * An upsert on `[runId, userId]` rather than an insert, because a person who
 * changes their mind is fixing a label. Two contradictory rows from the same
 * reviewer would make the eval set worse than having no feedback at all, and
 * "last write wins" is the only resolution that is defensible without asking
 * them which one they meant.
 *
 * `reason` and `note` are cleared when they are absent from the new submission:
 * a thumbs-up that follows a thumbs-down with "factually wrong" attached must
 * not keep the old explanation, which would then read as the reason for the
 * approval.
 */
export async function submitFeedback(options: SubmitFeedbackOptions): Promise<RunFeedback | null> {
  // The run is resolved under the tenant filter first, so feedback can never be
  // attached to another workspace's run — the unique key is `[runId, userId]`
  // and would otherwise happily accept a foreign run id.
  const run = await prisma.run.findFirst({
    where: { id: options.runId, tenantId: options.tenantId },
    select: { id: true },
  })
  if (run === null) return null

  const values = {
    rating: options.rating,
    reason: options.reason ?? null,
    note: options.note ?? null,
  }

  const row = await prisma.runFeedback.upsert({
    where: { runId_userId: { runId: run.id, userId: options.userId } },
    create: { tenantId: options.tenantId, runId: run.id, userId: options.userId, ...values },
    update: values,
  })
  return toRunFeedback(row)
}

/**
 * The verdict panel for one run: the tally, plus the caller's own vote.
 *
 * One query and one lookup rather than two round trips, because a UI that
 * renders the count and the highlighted thumb from two responses will
 * eventually render them disagreeing.
 */
export async function feedbackFor(options: {
  tenantId: string
  runId: string
  userId: string | null
}): Promise<FeedbackSummary> {
  const rows = await prisma.runFeedback.findMany({
    where: { tenantId: options.tenantId, runId: options.runId },
    orderBy: { createdAt: "desc" },
  })

  const mine =
    options.userId === null ? null : rows.find((row) => row.userId === options.userId)

  return {
    up: rows.filter((row) => row.rating === "up").length,
    down: rows.filter((row) => row.rating === "down").length,
    mine: mine === undefined || mine === null ? null : toRunFeedback(mine),
  }
}

/** One entry of the triage queue: the verdict, and enough of the run to judge it. */
export interface FeedbackEntry {
  feedback: RunFeedback
  runPrompt: string
  runStatus: string
}

/**
 * The triage queue.
 *
 * Defaults to thumbs-down only, because that is the queue somebody actually
 * works through; the parameter exists so the same query can produce the
 * positive set when Phase 7 wants a balanced sample.
 */
export async function listFeedback(options: {
  tenantId: string
  rating?: RunFeedback["rating"]
  limit?: number
}): Promise<FeedbackEntry[]> {
  const rows = await prisma.runFeedback.findMany({
    where: { tenantId: options.tenantId, rating: options.rating ?? "down" },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
    include: { run: { select: { prompt: true, status: true } } },
  })

  return rows.map((row) => ({
    feedback: toRunFeedback(row),
    runPrompt: row.run.prompt,
    runStatus: row.run.status,
  }))
}
