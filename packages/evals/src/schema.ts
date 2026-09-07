import { z } from "zod"

/**
 * The shapes the eval harness reads, writes and gates on.
 *
 * Everything here is persisted — golden items in the repository, reports on
 * disk and in CI artefacts, baselines committed next to the code they gate. So
 * every one of them is a versioned contract in the same sense the public API
 * is, and every one is parsed on the way in: a report file is untrusted input
 * like any other, and a gate that crashed on a malformed baseline would be a
 * gate somebody switches off.
 */

/* ------------------------------------------------------------ the dataset */

/**
 * The five categories, chosen because they fail differently.
 *
 * `factual` catches confident invention; `reasoning` catches plausible steps
 * with a wrong conclusion; `coding` is the one category where correctness is
 * mechanically checkable by a reader; `longform` is where a panel's tendency to
 * merge everything into a mush shows up; and `adversarial` is where a model
 * answers a question that should have been questioned. A set without the last
 * two scores well and tells you nothing.
 */
export const evalCategorySchema = z.enum([
  "factual",
  "reasoning",
  "coding",
  "longform",
  "adversarial",
])
export type EvalCategory = z.infer<typeof evalCategorySchema>

export const EVAL_CATEGORIES: readonly EvalCategory[] = evalCategorySchema.options

/**
 * One graded question.
 *
 * `rubric` is required and non-empty, which is the load-bearing rule of the
 * whole dataset: a prompt with no statement of what a right answer contains is
 * not an eval item, it is a demo. `reference` is optional because for a
 * long-form or adversarial question there is no single correct text — the
 * rubric is the grading criterion and the reference, where it exists, is
 * corroboration.
 *
 * `antiRubric` is the trap list: claims a wrong answer characteristically
 * makes. It is what turns "the model waffled plausibly" into a measurable
 * failure rather than a middling completeness score.
 */
export const goldenItemSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{2,60}$/, "An item id is lowercase, digits and hyphens"),
  category: evalCategorySchema,
  prompt: z.string().trim().min(8).max(8_000),
  /** A known-correct answer, or the key facts one must contain. */
  reference: z.string().trim().min(1).max(8_000).optional(),
  /** What a correct answer must contain. At least one, always. */
  rubric: z.array(z.string().trim().min(3).max(400)).min(1).max(12),
  /** Claims that make an answer wrong. Empty is normal outside `adversarial`. */
  antiRubric: z.array(z.string().trim().min(3).max(400)).max(12).default([]),
  /**
   * For an ambiguous or loaded question: what the *behaviour* should be, as
   * distinct from the content. "Should ask which of the two readings is meant"
   * is not a fact, and grading it as one is how adversarial sets get gamed.
   */
  expectation: z.string().trim().min(3).max(400).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  /** `curated` was written for the set; `feedback` came from a real complaint. */
  source: z.enum(["curated", "feedback"]).default("curated"),
  addedAt: z.string().trim().min(4).max(40),
})
export type GoldenItem = z.infer<typeof goldenItemSchema>

/**
 * A candidate item drawn from a real thumbs-down, before a human finishes it.
 *
 * The same shape with the rubric relaxed to empty, because the export cannot
 * write one: it knows what somebody was asked and that they were unhappy, and
 * what a correct answer must contain is exactly the judgement a person has to
 * supply. Staged items live in `data/staging/` and are never loaded by the
 * runner — promoting one is an edit that adds a rubric and moves the line.
 */
export const stagedItemSchema = goldenItemSchema.extend({
  rubric: z.array(z.string().trim().min(3).max(400)).max(12).default([]),
  source: z.literal("feedback"),
  /** Provenance, so a reviewer can find the run this came from. */
  runId: z.string(),
  feedbackId: z.string(),
  reportedReason: z.string().nullable(),
  reportedNote: z.string().nullable(),
})
export type StagedItem = z.infer<typeof stagedItemSchema>

/* ------------------------------------------------------- systems under test */

/**
 * What produced an answer.
 *
 * Three kinds, and the second is the point of the exercise: one run of the
 * panel yields the synthesis, every individual candidate, and the majority
 * vote, so the comparison that the product's whole thesis rests on costs
 * nothing beyond the run itself. Measuring the single-model baselines by making
 * *separate* calls would be both more expensive and less fair — a different
 * sample of the same model is a different answer.
 */
export const systemIdSchema = z
  .string()
  .trim()
  .regex(/^(synthesis|majority|single:[^\s]{1,60})$/, "A system id is synthesis, majority or single:<label>")
export type SystemId = z.infer<typeof systemIdSchema>

export const SYNTHESIS_SYSTEM: SystemId = "synthesis"
export const MAJORITY_SYSTEM: SystemId = "majority"

export function singleSystem(label: string): SystemId {
  return `single:${label.replace(/\s+/g, "_")}`
}

/* --------------------------------------------------------------- judging */

/**
 * One judge's verdict on one answer.
 *
 * Three scored dimensions, not four. The plan lists calibration alongside the
 * others, and it is measured — but it is not a property a judge can score on a
 * *single* answer: "was 0.8 the right confidence" is only answerable across
 * many answers, by comparing claimed confidence to measured accuracy. So the
 * judge scores what is visible in the text, and calibration is computed in
 * `report.ts` from these verdicts and the confidences that accompanied them.
 * Asking a judge for a calibration score per answer would produce a number, and
 * the number would mean nothing.
 */
export const judgeVerdictSchema = z.object({
  correctness: z
    .number()
    .min(0)
    .max(1)
    .describe("Is what it says true? 1 = every claim correct, 0 = the central claim is wrong."),
  completeness: z
    .number()
    .min(0)
    .max(1)
    .describe("How much of the rubric it covers, weighted by importance."),
  citationFidelity: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Are the specifics it cites — names, numbers, quotes, sources, APIs — real and " +
        "accurately reported? 1 when it cites nothing it cannot support.",
    ),
  rubricHits: z.array(z.string()).describe("Rubric points the answer actually covers."),
  rubricMisses: z.array(z.string()).describe("Rubric points it misses."),
  violations: z
    .array(z.string())
    .describe("Anti-rubric claims it makes, or expectations it fails to meet."),
  verdict: z
    .enum(["pass", "fail"])
    .describe("Would you be happy to send this to the person who asked? A single wrong central claim is a fail."),
  rationale: z.string().max(1_200).describe("Two sentences at most, naming the decisive point."),
})
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>

/** One graded answer: the item, who produced it, and what the judge said. */
export const itemResultSchema = z.object({
  itemId: z.string(),
  category: evalCategorySchema,
  system: systemIdSchema,
  /** Null for a single-model or majority answer: only the panel reports one. */
  confidence: z.number().min(0).max(1).nullable(),
  /** The weighted score in `report.ts`. Stored so a report is self-contained. */
  score: z.number().min(0).max(1),
  judgeModel: z.string(),
  verdict: judgeVerdictSchema,
  /** Set when the engine or the judge failed; the row is then excluded. */
  error: z.string().nullable(),
})
export type ItemResult = z.infer<typeof itemResultSchema>

/* --------------------------------------------------------------- reports */

export const systemSummarySchema = z.object({
  system: systemIdSchema,
  graded: z.number().int().nonnegative(),
  meanScore: z.number(),
  passRate: z.number(),
  meanCorrectness: z.number(),
  meanCompleteness: z.number(),
  meanCitationFidelity: z.number(),
  /**
   * Mean score per category, so a regression can be localised.
   *
   * Partial: a system graded on a subset carries only the categories it was
   * actually measured on. A full record would report a zero for a category
   * nobody asked about, and the gate would read that as a total collapse.
   */
  byCategory: z.partialRecord(evalCategorySchema, z.number()),
})
export type SystemSummary = z.infer<typeof systemSummarySchema>

export const reliabilityBinSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  count: z.number().int().nonnegative(),
  meanConfidence: z.number(),
  accuracy: z.number(),
})

export const calibrationSummarySchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  expectedCalibrationError: z.number(),
  maximumCalibrationError: z.number(),
  brierScore: z.number(),
  baseRate: z.number(),
  bins: z.array(reliabilityBinSchema),
})
export type CalibrationSummary = z.infer<typeof calibrationSummarySchema>

/**
 * A complete measurement of one build against one dataset.
 *
 * Self-contained on purpose: the summaries could be recomputed from `results`,
 * and are stored anyway, because a baseline committed a year ago has to stay
 * readable by a gate whose aggregation weights have changed since. A report is
 * a record of what was measured, not a view over data held elsewhere.
 */
export const evalReportSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  /** Dataset fingerprint: id, size, and the items' content digest. */
  dataset: z.object({
    id: z.string(),
    size: z.number().int().nonnegative(),
    digest: z.string(),
  }),
  /** What was measured: the panel and the prompts it ran under. */
  engine: z.object({
    panelId: z.string().nullable(),
    promptSetId: z.string().nullable(),
    baseUrl: z.string().nullable(),
  }),
  judges: z.array(z.string()),
  systems: z.array(systemSummarySchema),
  /** Confidence against judged correctness, for the synthesis only. */
  calibration: calibrationSummarySchema,
  /** Items the engine or the judge could not produce a verdict for. */
  failures: z.array(z.object({ itemId: z.string(), system: systemIdSchema, error: z.string() })),
  results: z.array(itemResultSchema),
})
export type EvalReport = z.infer<typeof evalReportSchema>

/* ------------------------------------------------------------- the gate */

/**
 * How much a release is allowed to move the numbers.
 *
 * Thresholds rather than "no regression at all", because the judge is itself a
 * sampled measurement: a gate that fired on a 0.3% move would fire on noise
 * every other night, and a gate that fires on noise is a gate that gets
 * disabled. The defaults are set to catch the size of change that a prompt or
 * panel edit actually produces.
 */
export const gateThresholdsSchema = z.object({
  /** How far the synthesis's mean score may fall against the baseline. */
  maxScoreDrop: z.number().min(0).max(1).default(0.02),
  /** The same, per category — a regression in one category hides in the mean. */
  maxCategoryDrop: z.number().min(0).max(1).default(0.05),
  /** How far the pass rate may fall. */
  maxPassRateDrop: z.number().min(0).max(1).default(0.03),
  /**
   * How far the synthesis may fall *below the best single model in the same
   * report*. Zero means "must not lose to a member of its own panel", which is
   * the product thesis stated as a test.
   */
  minSynthesisEdge: z.number().min(-1).max(1).default(0),
  /** How much worse the confidence may become at describing itself. */
  maxEceIncrease: z.number().min(0).max(1).default(0.05),
  /** A report smaller than this is not evidence, and the gate says so. */
  minGraded: z.number().int().positive().default(50),
})
export type GateThresholds = z.infer<typeof gateThresholdsSchema>

export const gateFindingSchema = z.object({
  severity: z.enum(["blocking", "warning"]),
  code: z.string(),
  message: z.string(),
})
export type GateFinding = z.infer<typeof gateFindingSchema>

export const gateResultSchema = z.object({
  passed: z.boolean(),
  findings: z.array(gateFindingSchema),
  /** What was compared, for the message a person reads in CI. */
  comparison: z.object({
    baselineId: z.string(),
    reportId: z.string(),
    baselineScore: z.number(),
    reportScore: z.number(),
    bestSingleScore: z.number(),
  }),
})
export type GateResult = z.infer<typeof gateResultSchema>

/* ------------------------------------------------------- judge agreement */

/**
 * A frozen answer with a human verdict on it.
 *
 * The answer text is stored rather than referenced, and that is the whole point
 * of the file: a label attached to "whatever the engine said for item 12" is
 * worthless the next time the engine says something else. Measuring the judge
 * requires the exact text a person read.
 */
export const humanLabelSchema = z.object({
  itemId: z.string(),
  answer: z.string().trim().min(1),
  verdict: z.enum(["pass", "fail"]),
  /** The labeller's own correctness reading, where they gave one. */
  correctness: z.number().min(0).max(1).optional(),
  note: z.string().max(600).optional(),
  labelledAt: z.string(),
})
export type HumanLabel = z.infer<typeof humanLabelSchema>

export const agreementReportSchema = z.object({
  labels: z.number().int().nonnegative(),
  /** Share of frozen answers where judge and human returned the same verdict. */
  rawAgreement: z.number(),
  /**
   * Cohen's kappa: agreement corrected for what chance alone would produce.
   * On a set where 90% of answers pass, 90% raw agreement is worth nothing, and
   * kappa is what says so.
   */
  kappa: z.number(),
  /** Mean absolute error on correctness, over labels that carry one. */
  correctnessMae: z.number().nullable(),
  perJudge: z.array(z.object({ judge: z.string(), rawAgreement: z.number(), kappa: z.number() })),
})
export type AgreementReport = z.infer<typeof agreementReportSchema>
