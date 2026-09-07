import type {
  FeedbackQueueQuery,
  FeedbackSummary,
  FeedbackTriageEntry,
  FeedbackTriageStatus,
  RunFeedback,
  SubmitFeedbackInput,
} from "@sce/shared"
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
    triageStatus: row.triageStatus,
    triagedAt: row.triagedAt?.toISOString() ?? null,
    triagedByUserId: row.triagedByUserId,
    triageNote: row.triageNote,
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

  /**
   * A corrected verdict re-enters the queue.
   *
   * Somebody who dismissed a thumbs-down last week decided about the report as
   * it read then. A person who then rewrites it — a different rating, or the
   * explanation they did not give the first time — has produced new evidence,
   * and leaving it marked `dismissed` would hide exactly the reports that
   * somebody cared enough to come back to.
   *
   * `promoted` is the exception: an eval case has already been written from it,
   * and that case does not stop existing because the reporter edited their
   * note.
   */
  const reopen = {
    triageStatus: "open",
    triagedAt: null,
    triagedByUserId: null,
    triageNote: null,
  } as const

  // Filtered on the tenant as well as the unique pair. The run above already
  // proves ownership, but a read in this layer that does not name the tenant is
  // a read the next person copies into somewhere it matters.
  const existing = await prisma.runFeedback.findFirst({
    where: { tenantId: options.tenantId, runId: run.id, userId: options.userId },
    select: { triageStatus: true },
  })
  const alreadyPromoted = existing?.triageStatus === "promoted"

  const row = await prisma.runFeedback.upsert({
    where: { runId_userId: { runId: run.id, userId: options.userId } },
    create: { tenantId: options.tenantId, runId: run.id, userId: options.userId, ...values },
    update: alreadyPromoted ? values : { ...values, ...reopen },
  })
  return toRunFeedback(row)
}

/**
 * Record what a reviewer concluded about one verdict.
 *
 * Scoped by tenant *and* by feedback id in one `updateMany`, rather than a
 * `findFirst` followed by an `update`: the two-step version is a check that can
 * be raced, and this is a write that decides what enters the eval set.
 */
export async function triageFeedback(options: {
  tenantId: string
  feedbackId: string
  status: FeedbackTriageStatus
  note?: string | null
  reviewerUserId: string | null
}): Promise<RunFeedback | null> {
  const updated = await prisma.runFeedback.updateMany({
    where: { id: options.feedbackId, tenantId: options.tenantId },
    data: {
      triageStatus: options.status,
      // Reverting to `open` clears the decision rather than leaving a reviewer
      // and a timestamp attached to a conclusion that no longer exists.
      triagedAt: options.status === "open" ? null : new Date(),
      triagedByUserId: options.status === "open" ? null : options.reviewerUserId,
      triageNote: options.status === "open" ? null : (options.note ?? null),
    },
  })
  if (updated.count === 0) return null

  const row = await prisma.runFeedback.findFirst({
    where: { id: options.feedbackId, tenantId: options.tenantId },
  })
  return row === null ? null : toRunFeedback(row)
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

/**
 * The triage queue.
 *
 * Defaults to thumbs-down, because that is the queue somebody actually works
 * through; the filters exist so the same query can produce the positive set
 * when a balanced sample is wanted, and so a reviewer can ask for what is still
 * open rather than re-reading what they have already decided.
 *
 * Ordered oldest-first when a status filter is applied and newest-first
 * otherwise: a backlog is drained from the front, but "what did we get wrong
 * lately" is a question about the recent past.
 */
export async function listFeedback(options: {
  tenantId: string
  rating?: FeedbackQueueQuery["rating"]
  status?: FeedbackTriageStatus
  limit?: number
}): Promise<FeedbackTriageEntry[]> {
  const rows = await prisma.runFeedback.findMany({
    where: {
      tenantId: options.tenantId,
      rating: options.rating ?? "down",
      ...(options.status === undefined ? {} : { triageStatus: options.status }),
    },
    orderBy: { createdAt: options.status === undefined ? "desc" : "asc" },
    take: options.limit ?? 50,
    include: {
      run: {
        select: {
          id: true,
          prompt: true,
          status: true,
          createdAt: true,
          panelId: true,
          promptSetId: true,
          synthesis: { select: { confidence: true } },
        },
      },
    },
  })

  return rows.map((row) => ({
    feedback: toRunFeedback(row),
    runId: row.run.id,
    runPrompt: row.run.prompt,
    runStatus: row.run.status,
    runCreatedAt: row.run.createdAt.toISOString(),
    confidence: row.run.synthesis?.confidence ?? null,
    panelId: row.run.panelId,
    promptSetId: row.run.promptSetId,
  }))
}
