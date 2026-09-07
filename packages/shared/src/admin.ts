import { z } from "zod"
import { accessSchema, subscriptionSchema } from "./billing.ts"
import { globalBudgetSchema } from "./budget.ts"
import { candidateJobSchema, synthesisJobSchema } from "./jobs.ts"
import { planIdSchema } from "./plans.ts"
import { runSummarySchema } from "./schemas.ts"
import { tenantSpendSchema } from "./usage.ts"

/**
 * The internal operations surface.
 *
 * Everything here is **cross-tenant by construction**, which makes it the one
 * part of the API where this codebase's central rule — every query is scoped to
 * the caller's tenant — does not apply. That is precisely why it is a separate
 * module with a separate guard rather than a role on the existing routes:
 *
 *   - Tenant roles (`owner`, `admin`) are authority *inside* a workspace. An
 *     owner of one tenant must never be able to reach another, no matter how
 *     senior they are to their own colleagues. Reusing `owner` for this would
 *     make every customer's account owner an operator of the whole install.
 *   - So install administration is a **separate axis**, resolved from
 *     configuration (`SCE_ADMIN_EMAILS`) rather than from any row a user or a
 *     webhook can write. Nothing a tenant does can grant it.
 *
 * The surface is deliberately shallow: read almost everything, write only the
 * two things an incident actually needs — release the spend kill switch, and
 * replay the dead-letter queue. Anything more destructive stays in the `ops`
 * CLI, where it is a deliberate act at a terminal rather than a button.
 */

/** A workspace as an operator sees it: identity, plan, and what it costs. */
export const adminTenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  plan: planIdSchema,
  subscription: subscriptionSchema,
  access: accessSchema,
  memberCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  /** Spend inside the window the request asked for. */
  costMicroCents: z.number().int().nonnegative(),
})
export type AdminTenant = z.infer<typeof adminTenantSchema>

/** `?q=` on the tenant lookup: a slug, an id, or part of a name. */
export const adminTenantQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Days of spend to attribute to each tenant. */
  days: z.coerce.number().int().min(1).max(90).default(30),
})
export type AdminTenantQuery = z.infer<typeof adminTenantQuerySchema>

/**
 * The run inspector.
 *
 * An operator answering "why did this customer's run fail" needs the run and
 * the tenant it belongs to, and needs them without impersonating anybody. The
 * lookup is by run id alone — which is why it lives here and not on the
 * tenant-scoped route.
 */
export const adminRunSchema = z.object({
  run: runSummarySchema,
  tenant: z.object({ id: z.string(), slug: z.string() }),
  /** Every metered call the run made, so cost and failure sit side by side. */
  costMicroCents: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
})
export type AdminRun = z.infer<typeof adminRunSchema>

/* -------------------------------------------------------------- the queues */

export const queueDepthSchema = z.object({
  queue: z.string(),
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  waitingChildren: z.number().int().nonnegative(),
})
export type QueueDepthView = z.infer<typeof queueDepthSchema>

/**
 * One dead-lettered job.
 *
 * The payload is parsed against the job union rather than passed through: this
 * response is rendered in a browser, and a job body read out of Redis is
 * untrusted input like any other. A stack trace is included because a DLQ entry
 * without one is unactionable, and it is capped because a browser rendering a
 * ten-thousand-frame trace helps nobody.
 */
export const deadLetterSchema = z.object({
  queue: z.string(),
  jobId: z.string(),
  name: z.string(),
  data: z.union([candidateJobSchema, synthesisJobSchema]),
  attemptsMade: z.number().int().nonnegative(),
  failedReason: z.string(),
  stacktrace: z.array(z.string()),
  failedAt: z.string().nullable(),
})
export type DeadLetterView = z.infer<typeof deadLetterSchema>

/** How many stack frames of a dead letter reach the browser. */
export const DEAD_LETTER_TRACE_FRAMES = 20

export const replayDeadLetterInputSchema = z.object({
  queue: z.string().trim().min(1).max(60),
  jobId: z.string().trim().min(1).max(120),
})
export type ReplayDeadLetterInput = z.infer<typeof replayDeadLetterInputSchema>

/* ------------------------------------------------------------- the overview */

/**
 * The operator's front page.
 *
 * One request, because the four questions an operator opens this page with —
 * is spend under control, is the queue moving, is anything dead-lettered, are
 * the providers up — are asked together, and four separate requests guarantee a
 * dashboard whose panels disagree about what time it is.
 */
export const adminOverviewSchema = z.object({
  budget: globalBudgetSchema,
  queues: z.array(queueDepthSchema),
  deadLetters: z.number().int().nonnegative(),
  /** Today's spend, by tenant, biggest first. */
  topSpenders: z.array(tenantSpendSchema),
  tenantCount: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  generatedAt: z.string(),
})
export type AdminOverview = z.infer<typeof adminOverviewSchema>

/** Releasing the spend kill switch is the one write worth an explicit reason. */
export const releaseKillSwitchInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
})
export type ReleaseKillSwitchInput = z.infer<typeof releaseKillSwitchInputSchema>

/* ------------------------------------------------------- answer quality */

/**
 * The quality console.
 *
 * The operator page for Phase 7's three continuous questions: is the
 * experiment saying anything yet, is the cache paying for itself, and does the
 * confidence number mean what it claims. All three are cross-tenant by
 * construction — an engine is not a workspace — which is why they live behind
 * the same install-admin guard as everything else in this module.
 *
 * Every number here is an aggregate. No prompt and no answer body crosses this
 * boundary: an operator who needs to read one run reads it through the run
 * inspector, which is tenant-scoped and audited.
 */

export const experimentArmSchema = z.object({
  variantId: z.string().nullable(),
  panelId: z.string().nullable(),
  runs: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Runs served from the cache. They cost nothing and judge nothing. */
  cached: z.number().int().nonnegative(),
  meanConfidence: z.number().nullable(),
  meanCalibratedConfidence: z.number().nullable(),
  meanLatencyMs: z.number().nullable(),
  costMicroCents: z.number().int().nonnegative(),
  thumbsUp: z.number().int().nonnegative(),
  thumbsDown: z.number().int().nonnegative(),
})
export type ExperimentArm = z.infer<typeof experimentArmSchema>

export const adminExperimentSchema = z.object({
  id: z.string(),
  label: z.string(),
  hypothesis: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  /** False once the window has closed; the arms are still reported. */
  active: z.boolean(),
  arms: z.array(experimentArmSchema),
})
export type AdminExperiment = z.infer<typeof adminExperimentSchema>

export const adminCacheSchema = z.object({
  runs: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
  meanGeneratedCostMicroCents: z.number().int().nonnegative(),
  /** Hits times that mean. An estimate, and named as one. */
  estimatedSavedMicroCents: z.number().int().nonnegative(),
})
export type AdminCache = z.infer<typeof adminCacheSchema>

export const adminReliabilityBinSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  count: z.number().int().nonnegative(),
  meanConfidence: z.number(),
  accuracy: z.number(),
})

/**
 * How well the confidence number tracked what people thought of the answer.
 *
 * The label is a thumbs-up, which is a *weak* signal for correctness — people
 * click it for tone and speed too — so this is the continuously-available
 * approximation, not the judged measurement. The eval harness produces the
 * real one against the golden set, and the console says which is which.
 */
export const adminCalibrationSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  expectedCalibrationError: z.number(),
  brierScore: z.number(),
  baseRate: z.number(),
  bins: z.array(adminReliabilityBinSchema),
})
export type AdminCalibration = z.infer<typeof adminCalibrationSchema>

export const adminPanelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  promptSetId: z.string(),
  /** Provider and model of each seat, in panel order. */
  seats: z.array(z.object({ provider: z.string(), label: z.string(), model: z.string() })),
  evaluator: z.object({ provider: z.string(), model: z.string() }),
  /** True for the panel this install answers with when no experiment applies. */
  isDefault: z.boolean(),
})
export type AdminPanel = z.infer<typeof adminPanelSchema>

export const adminQualitySchema = z.object({
  windowDays: z.number().int().positive(),
  panels: z.array(adminPanelSchema),
  experiments: z.array(adminExperimentSchema),
  cache: adminCacheSchema,
  calibration: adminCalibrationSchema,
  /** The prompt sets this build knows, so a run's id can be read as a name. */
  promptSets: z.array(z.object({ id: z.string(), summary: z.string(), introducedAt: z.string() })),
  generatedAt: z.string(),
})
export type AdminQuality = z.infer<typeof adminQualitySchema>

/** `?days=` on the quality console. */
export const adminQualityQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
})
export type AdminQualityQuery = z.infer<typeof adminQualityQuerySchema>
