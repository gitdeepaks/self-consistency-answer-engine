import { z } from "zod";
import { PROVIDER_IDS } from "./models.ts";

export const providerIdSchema = z.enum(PROVIDER_IDS);

/**
 * Lifecycle of a run.
 *
 * `PENDING` is the row the API writes before it enqueues anything; `QUEUED` is
 * the acknowledgement that a job was accepted. Keeping them distinct is what
 * makes "the API took my prompt but no worker ever picked it up" a visible
 * state rather than a run that simply sits there.
 */
export const runStatusSchema = z.enum([
  "PENDING",
  "QUEUED",
  "FANNING_OUT",
  "SYNTHESIZING",
  "COMPLETE",
  "FAILED",
  "CANCELED",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Statuses after which a run produces no further events. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "COMPLETE",
  "FAILED",
  "CANCELED",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const candidateStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "OK",
  "ERROR",
  "SKIPPED",
  "CANCELED",
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

/** ---------------------------------------------------------------- input */

export const askInputSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, "Prompt must be at least 3 characters")
    .max(8000, "Prompt must be at most 8000 characters"),
  /** Optional subset of the panel; defaults to every configured provider. */
  providers: z.array(providerIdSchema).min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type AskInput = z.infer<typeof askInputSchema>;

/**
 * `Idempotency-Key` request header.
 *
 * A retried `POST /api/runs` must return the run the first attempt created
 * rather than fanning out a second panel — model calls cost money, and a mobile
 * client on a flaky connection retries by default. Bounded and character-fenced
 * because the value becomes part of a unique database key.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency-Key must be at least 8 characters")
  .max(255, "Idempotency-Key must be at most 255 characters")
  .regex(
    /^[A-Za-z0-9_.:-]+$/,
    "Idempotency-Key may only contain A-Z a-z 0-9 _ . : -",
  );

export const runHeadersSchema = z.object({
  "idempotency-key": idempotencyKeySchema.optional(),
});

/** Reason recorded when a caller cancels a run. */
export const cancelRunInputSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;

/**
 * SSE resume cursor.
 *
 * The browser's `EventSource` replays the last id it saw in `Last-Event-ID`
 * automatically; other clients pass `?afterSeq=`. Both land here, and both are
 * parsed rather than trusted — the value ends up in a database predicate.
 */
export const eventCursorSchema = z.coerce.number().int().nonnegative().catch(0);

/** `?afterSeq=` on the SSE route, for clients that are not `EventSource`. */
export const eventStreamQuerySchema = z.object({
  afterSeq: eventCursorSchema.optional(),
});

export const listQueriesInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/** ------------------------------------------------------------ evaluator */

export const candidateReviewSchema = z.object({
  provider: providerIdSchema,
  score: z
    .number()
    .min(0)
    .max(10)
    .describe("Overall quality of this answer, 0-10."),
  strengths: z
    .array(z.string())
    .describe("What this answer got right that others missed."),
  weaknesses: z
    .array(z.string())
    .describe("Errors, omissions or weak reasoning."),
});

export const synthesisOutputSchema = z.object({
  agreements: z
    .array(z.string())
    .describe(
      "Claims the models independently converged on (high confidence).",
    ),
  disagreements: z
    .array(z.string())
    .describe(
      "Points where the models conflicted, and which reading is correct.",
    ),
  reviews: z
    .array(candidateReviewSchema)
    .describe("One review per candidate answer."),
  finalAnswer: z
    .string()
    .describe(
      "The best possible answer in Markdown, merged from the strongest parts of every candidate. Never a verbatim copy of one candidate.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident the evaluator is in the final answer, 0-1."),
});
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
export type CandidateReview = z.infer<typeof candidateReviewSchema>;

/** ------------------------------------------------------------- entities */

export const usageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const candidateSchema = z.object({
  id: z.string(),
  provider: providerIdSchema,
  label: z.string(),
  model: z.string(),
  status: candidateStatusSchema,
  content: z.string().nullable(),
  error: z.string().nullable(),
  latencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  /** Queue delivery attempts spent so far. Zero until a worker picks it up. */
  attempts: z.number().int().nonnegative(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const synthesisSchema = z.object({
  id: z.string(),
  model: z.string(),
  finalAnswer: z.string(),
  agreements: z.array(z.string()),
  disagreements: z.array(z.string()),
  reviews: z.array(candidateReviewSchema),
  confidence: z.number(),
  latencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

export const runSchema = z.object({
  id: z.string(),
  /**
   * The person who started the run, or null for one created before identity
   * existed. Present so ownership is a property callers can see and `can()` can
   * check, rather than something only the database knows.
   */
  createdByUserId: z.string().nullable(),
  prompt: z.string(),
  status: runStatusSchema,
  error: z.string().nullable(),
  totalLatencyMs: z.number().nullable(),
  /** Sampling temperature the panel was asked for. Null means the model default. */
  temperature: z.number().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  /** Wall-clock deadline for the whole run. Null means no deadline was set. */
  deadlineAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  candidates: z.array(candidateSchema),
  synthesis: synthesisSchema.nullable(),
});
export type Run = z.infer<typeof runSchema>;

export const runSummarySchema = runSchema
  .omit({ candidates: true, synthesis: true })
  .extend({
    candidateCount: z.number(),
    hasSynthesis: z.boolean(),
  });
export type RunSummary = z.infer<typeof runSummarySchema>;

export const providerHealthSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  model: z.string(),
  color: z.string(),
  available: z.boolean(),
  /** "direct" = own API key, "gateway" = routed via AI Gateway, null = unusable. */
  route: z.enum(["direct", "gateway"]).nullable(),
  hint: z.string().nullable(),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

/** ------------------------------------------------------------- tenancy */

export const memberRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const tenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const membershipSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  role: memberRoleSchema,
  createdAt: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

/** --------------------------------------------------------------- usage */

/** Which leg of a run a metered call belongs to. */
export const usageKindSchema = z.enum(["CANDIDATE", "EVALUATOR"]);
export type UsageKind = z.infer<typeof usageKindSchema>;

export const usageRecordSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  kind: usageKindSchema,
  provider: providerIdSchema,
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Cost in micro-cents (1e-8 USD). Zero when the model has no known price. */
  costMicroCents: z.number(),
  /** Null when no price was found — the "unpriced model" signal. */
  priceId: z.string().nullable(),
  createdAt: z.string(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const usageTotalsSchema = z.object({
  runs: z.number(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costMicroCents: z.number(),
  /** True when at least one call had no price at all — cost is understated. */
  hasUnpricedCalls: z.boolean(),
  /** True when at least one call was priced from an unverified placeholder. */
  hasUnverifiedPricing: z.boolean(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
