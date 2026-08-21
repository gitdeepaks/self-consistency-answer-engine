import { z } from "zod"
import { PROVIDER_IDS } from "./models.ts"

export const providerIdSchema = z.enum(PROVIDER_IDS)

export const runStatusSchema = z.enum([
  "PENDING",
  "FANNING_OUT",
  "SYNTHESIZING",
  "COMPLETE",
  "FAILED",
])
export type RunStatus = z.infer<typeof runStatusSchema>

export const candidateStatusSchema = z.enum(["PENDING", "RUNNING", "OK", "ERROR", "SKIPPED"])
export type CandidateStatus = z.infer<typeof candidateStatusSchema>

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
})
export type AskInput = z.infer<typeof askInputSchema>

export const listQueriesInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
})

/** ------------------------------------------------------------ evaluator */

export const candidateReviewSchema = z.object({
  provider: providerIdSchema,
  score: z.number().min(0).max(10).describe("Overall quality of this answer, 0-10."),
  strengths: z.array(z.string()).describe("What this answer got right that others missed."),
  weaknesses: z.array(z.string()).describe("Errors, omissions or weak reasoning."),
})

export const synthesisOutputSchema = z.object({
  agreements: z
    .array(z.string())
    .describe("Claims the models independently converged on (high confidence)."),
  disagreements: z
    .array(z.string())
    .describe("Points where the models conflicted, and which reading is correct."),
  reviews: z.array(candidateReviewSchema).describe("One review per candidate answer."),
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
})
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>
export type CandidateReview = z.infer<typeof candidateReviewSchema>

/** ------------------------------------------------------------- entities */

export const usageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
})
export type Usage = z.infer<typeof usageSchema>

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
})
export type Candidate = z.infer<typeof candidateSchema>

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
})
export type Synthesis = z.infer<typeof synthesisSchema>

export const runSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  status: runStatusSchema,
  error: z.string().nullable(),
  totalLatencyMs: z.number().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  candidates: z.array(candidateSchema),
  synthesis: synthesisSchema.nullable(),
})
export type Run = z.infer<typeof runSchema>

export const runSummarySchema = runSchema.omit({ candidates: true, synthesis: true }).extend({
  candidateCount: z.number(),
  hasSynthesis: z.boolean(),
})
export type RunSummary = z.infer<typeof runSummarySchema>

export const providerHealthSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  model: z.string(),
  color: z.string(),
  available: z.boolean(),
  /** "direct" = own API key, "gateway" = routed via AI Gateway, null = unusable. */
  route: z.enum(["direct", "gateway"]).nullable(),
  hint: z.string().nullable(),
})
export type ProviderHealth = z.infer<typeof providerHealthSchema>
