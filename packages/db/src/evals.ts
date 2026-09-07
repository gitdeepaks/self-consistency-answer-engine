import type { FeedbackTriageEntry } from "@sce/shared"
import { z } from "zod"
import { prisma } from "./client.ts"
import { toRunFeedback } from "./feedback.ts"

/**
 * Cross-tenant reads for answer quality.
 *
 * Like `admin.ts`, this module deliberately breaks the rule the rest of the
 * data layer is built on — and for the same kind of reason. "Is the panel
 * better than one model", "does the evaluator's confidence mean anything", and
 * "which answers did people tell us were wrong" are questions about the
 * *engine*, and an engine is not a tenant. Answering them one workspace at a
 * time would produce a sample too small to conclude anything from, and a
 * quality gate that concluded nothing would be a gate in name only.
 *
 * The safeguard is the same one: every function takes an `EvalScope` whose
 * `reason` is a closed union of literals, so reaching this file requires typing
 * out which sanctioned purpose the call serves. `repository.scoping.test.ts`
 * scans the file and requires each exemption to be listed with its
 * justification, and the only routes that reach any of it sit behind
 * `requireInstallAdmin`.
 *
 * What is deliberately *not* here: prompts and answers. Every query returns
 * counts, means and ids. The eval harness reads the text of a run through the
 * tenant-scoped `getRun`, with the tenant it was handed — so an aggregate can
 * never become a way to read one customer's content.
 */

export type EvalScope = {
  kind: "every-tenant"
  reason:
    | "the eval set is drawn from every workspace"
    | "the experiment report spans the install"
    | "the calibration sample spans the install"
    | "the cache report spans the install"
}

/* ----------------------------------------------------- parsing raw results */

/**
 * Aggregates come back through `$queryRaw`, which is typed `unknown` — the
 * usual trust boundary, parsed rather than asserted. Counts are cast to
 * `bigint` in SQL because a `COUNT` that silently wrapped an `int4` would be a
 * quality report that lied at exactly the scale where it starts to matter.
 */
const countFromDb = z.union([z.number().int(), z.bigint().transform((value) => Number(value))])

const experimentRowSchema = z.object({
  experimentId: z.string(),
  variantId: z.string().nullable(),
  panelId: z.string().nullable(),
  runs: countFromDb,
  completed: countFromDb,
  failed: countFromDb,
  cached: countFromDb,
  meanConfidence: z.number().nullable(),
  meanCalibratedConfidence: z.number().nullable(),
  meanLatencyMs: z.number().nullable(),
})

const feedbackRowSchema = z.object({
  experimentId: z.string(),
  variantId: z.string().nullable(),
  thumbsUp: countFromDb,
  thumbsDown: countFromDb,
})

const costRowSchema = z.object({
  experimentId: z.string(),
  variantId: z.string().nullable(),
  costMicroCents: countFromDb,
})

/* --------------------------------------------------------- the experiments */

/** One arm of one experiment, measured. */
export interface ExperimentArmStats {
  experimentId: string
  variantId: string | null
  panelId: string | null
  runs: number
  completed: number
  failed: number
  /** Runs served from the answer cache, which cost nothing and judge nothing. */
  cached: number
  meanConfidence: number | null
  meanCalibratedConfidence: number | null
  meanLatencyMs: number | null
  costMicroCents: number
  thumbsUp: number
  thumbsDown: number
}

function armKey(experimentId: string, variantId: string | null): string {
  return `${experimentId} ${variantId ?? ""}`
}

/**
 * Every experiment arm, over a window.
 *
 * Three queries rather than one: runs and their confidences, the human
 * verdicts, and the spend. They are separate because joining feedback and usage
 * in one statement multiplies the rows — a run with three metered calls and two
 * thumbs-up would be counted six times, and the resulting "cost per run" would
 * be wrong in a way that looks entirely plausible.
 */
export async function experimentReport(options: {
  scope: EvalScope
  since: Date
}): Promise<ExperimentArmStats[]> {
  const since = options.since

  const [runRows, feedbackRows, costRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT r."experimentId" AS "experimentId",
             r."variantId" AS "variantId",
             r."panelId" AS "panelId",
             COUNT(*)::bigint AS "runs",
             COUNT(*) FILTER (WHERE r."status" = 'COMPLETE')::bigint AS "completed",
             COUNT(*) FILTER (WHERE r."status" = 'FAILED')::bigint AS "failed",
             COUNT(*) FILTER (WHERE r."cachedFromRunId" IS NOT NULL)::bigint AS "cached",
             AVG(s."confidence")::float8 AS "meanConfidence",
             AVG(s."calibratedConfidence")::float8 AS "meanCalibratedConfidence",
             AVG(r."totalLatencyMs")::float8 AS "meanLatencyMs"
      FROM "Run" r
      LEFT JOIN "Synthesis" s ON s."runId" = r."id"
      WHERE r."experimentId" IS NOT NULL AND r."createdAt" >= ${since}
      GROUP BY r."experimentId", r."variantId", r."panelId"
      ORDER BY r."experimentId", r."variantId"
    `,
    prisma.$queryRaw`
      SELECT r."experimentId" AS "experimentId",
             r."variantId" AS "variantId",
             COUNT(*) FILTER (WHERE f."rating" = 'up')::bigint AS "thumbsUp",
             COUNT(*) FILTER (WHERE f."rating" = 'down')::bigint AS "thumbsDown"
      FROM "RunFeedback" f
      JOIN "Run" r ON r."id" = f."runId"
      WHERE r."experimentId" IS NOT NULL AND r."createdAt" >= ${since}
      GROUP BY r."experimentId", r."variantId"
    `,
    prisma.$queryRaw`
      SELECT r."experimentId" AS "experimentId",
             r."variantId" AS "variantId",
             COALESCE(SUM(u."costMicroCents"), 0)::bigint AS "costMicroCents"
      FROM "UsageRecord" u
      JOIN "Run" r ON r."id" = u."runId"
      WHERE r."experimentId" IS NOT NULL AND r."createdAt" >= ${since}
      GROUP BY r."experimentId", r."variantId"
    `,
  ])

  const runs = z.array(experimentRowSchema).parse(runRows)
  const feedback = new Map(
    z
      .array(feedbackRowSchema)
      .parse(feedbackRows)
      .map((row) => [armKey(row.experimentId, row.variantId), row]),
  )
  const costs = new Map(
    z
      .array(costRowSchema)
      .parse(costRows)
      .map((row) => [armKey(row.experimentId, row.variantId), row.costMicroCents]),
  )

  return runs.map((row) => {
    const key = armKey(row.experimentId, row.variantId)
    const verdicts = feedback.get(key)
    return {
      experimentId: row.experimentId,
      variantId: row.variantId,
      panelId: row.panelId,
      runs: row.runs,
      completed: row.completed,
      failed: row.failed,
      cached: row.cached,
      meanConfidence: row.meanConfidence,
      meanCalibratedConfidence: row.meanCalibratedConfidence,
      meanLatencyMs: row.meanLatencyMs,
      costMicroCents: costs.get(key) ?? 0,
      thumbsUp: verdicts?.thumbsUp ?? 0,
      thumbsDown: verdicts?.thumbsDown ?? 0,
    }
  })
}

/* ---------------------------------------------------------------- the cache */

export interface CacheStats {
  runs: number
  cacheHits: number
  hitRate: number
  /** Mean spend of a run that actually generated its answer, in micro-cents. */
  meanGeneratedCostMicroCents: number
  /**
   * Hits times that mean. An estimate, and labelled as one: the alternative is
   * to claim the exact cost of model calls that were never made.
   */
  estimatedSavedMicroCents: number
}

export async function cacheReport(options: { scope: EvalScope; since: Date }): Promise<CacheStats> {
  const [runs, cacheHits, generatedSpend] = await Promise.all([
    prisma.run.count({ where: { createdAt: { gte: options.since } } }),
    prisma.run.count({ where: { createdAt: { gte: options.since }, cachedFromRunId: { not: null } } }),
    prisma.usageRecord.aggregate({
      where: { createdAt: { gte: options.since }, run: { cachedFromRunId: null } },
      _sum: { costMicroCents: true },
    }),
  ])

  const generated = runs - cacheHits
  const spend = Number(generatedSpend._sum.costMicroCents ?? 0n)
  const meanGenerated = generated <= 0 ? 0 : Math.round(spend / generated)

  return {
    runs,
    cacheHits,
    hitRate: runs === 0 ? 0 : cacheHits / runs,
    meanGeneratedCostMicroCents: meanGenerated,
    estimatedSavedMicroCents: meanGenerated * cacheHits,
  }
}

/* --------------------------------------------------------- the feedback loop */

const TRIAGE_RUN_SELECT = {
  id: true,
  prompt: true,
  status: true,
  createdAt: true,
  panelId: true,
  promptSetId: true,
  synthesis: { select: { confidence: true } },
} as const

interface TriageRunRow {
  run: {
    id: string
    prompt: string
    status: string
    createdAt: Date
    panelId: string | null
    promptSetId: string | null
    synthesis: { confidence: number } | null
  }
}

function toTriageEntry(row: Parameters<typeof toRunFeedback>[0] & TriageRunRow): FeedbackTriageEntry {
  return {
    feedback: toRunFeedback(row),
    runId: row.run.id,
    runPrompt: row.run.prompt,
    runStatus: row.run.status,
    runCreatedAt: row.run.createdAt.toISOString(),
    confidence: row.run.synthesis?.confidence ?? null,
    panelId: row.run.panelId,
    promptSetId: row.run.promptSetId,
  }
}

/**
 * Every thumbs-down confirmed in triage but not yet turned into an eval case.
 *
 * This is the whole of the feedback loop in one query: a customer said an
 * answer was wrong, a reviewer agreed, and this is what hands it to the golden
 * set. Oldest first, because a complaint that has waited longest is the one
 * most likely to describe a failure that is still happening.
 */
export async function listPromotableFeedback(options: {
  scope: EvalScope
  limit?: number
}): Promise<FeedbackTriageEntry[]> {
  const rows = await prisma.runFeedback.findMany({
    where: { rating: "down", triageStatus: "accepted" },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 200,
    include: { run: { select: TRIAGE_RUN_SELECT } },
  })
  return rows.map(toTriageEntry)
}

/**
 * Mark confirmed verdicts as promoted, once an eval case exists for each.
 *
 * Filtered on `accepted` rather than blindly set, so a verdict a reviewer
 * reopened between the export and this call is not marked as promoted by a
 * batch that never included it.
 */
export async function markFeedbackPromoted(options: {
  scope: EvalScope
  feedbackIds: readonly string[]
}): Promise<number> {
  if (options.feedbackIds.length === 0) return 0
  const updated = await prisma.runFeedback.updateMany({
    where: { id: { in: [...options.feedbackIds] }, triageStatus: "accepted" },
    data: { triageStatus: "promoted", triagedAt: new Date() },
  })
  return updated.count
}

/* ------------------------------------------------------------- calibration */

/**
 * Production evidence about the confidence number.
 *
 * A thumbs-up is not a correctness label — people click it for tone, speed and
 * agreement as well as for accuracy — so this is a *weaker* signal than the
 * judged eval set, and the harness treats it that way. It is also free, it
 * arrives continuously, and it is the only calibration evidence that comes from
 * the traffic the product actually serves rather than from a fixed set of
 * questions. Both are used; neither is used alone.
 */
export interface CalibrationSamplePoint {
  runId: string
  confidence: number
  /** True for a thumbs-up. The weak label described above. */
  correct: boolean
  createdAt: string
}

export async function calibrationSample(options: {
  scope: EvalScope
  since: Date
  limit?: number
}): Promise<CalibrationSamplePoint[]> {
  const rows = await prisma.runFeedback.findMany({
    where: {
      createdAt: { gte: options.since },
      run: { status: "COMPLETE", synthesis: { isNot: null } },
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 5_000,
    select: {
      rating: true,
      createdAt: true,
      run: { select: { id: true, synthesis: { select: { confidence: true } } } },
    },
  })

  return rows.flatMap((row) =>
    row.run.synthesis === null
      ? []
      : [
          {
            runId: row.run.id,
            confidence: row.run.synthesis.confidence,
            correct: row.rating === "up",
            createdAt: row.createdAt.toISOString(),
          },
        ],
  )
}
