import { EVALUATOR, PROVIDERS, type ProviderId } from "./models.ts"
import {
  computeCostMicroCents,
  findModelPrice,
  formatMicroCentsUsd,
  type ModelPrice,
} from "./pricing.ts"

/**
 * What a run is likely to cost, before it is started.
 *
 * The point of showing this in the composer is not accuracy — it is that a
 * person about to fan a 6,000-word prompt across four models sees the number
 * *first*. An estimate that is right to within a factor of two changes
 * behaviour; an exact figure delivered afterwards does not.
 *
 * So the honest framing is baked into the output: every estimate carries the
 * assumptions it was made under and a `confidence` that says plainly when it is
 * guessing, and the UI is expected to render it as a range rather than a price.
 *
 * Two sources of error dominate, and both are named in the result rather than
 * hidden:
 *
 *   - **Output length is unknowable in advance.** A panel member decides how
 *     much to write. `EXPECTED_OUTPUT_TOKENS` is a prior, and the low/high band
 *     is the honest width around it.
 *   - **Some models are unpriced or priced from a placeholder.** `pricing.ts`
 *     ships unverified figures for two of the three providers, and an estimate
 *     built on those must say so — see `unpricedModels` and `unverified`.
 */

/**
 * Characters per token.
 *
 * A deliberately crude approximation, and crude is the right choice here: a
 * real tokenizer is per-provider, ships megabytes of vocabulary, and would have
 * to run in the browser on every keystroke to serve this feature. Four is the
 * long-standing English-prose rule of thumb and is within ~15% for the prompts
 * this composer sees, which is well inside the band the estimate is quoted at.
 */
const CHARS_PER_TOKEN = 4

/** Tokens the system prompt adds to every candidate call. Measured, not guessed. */
const CANDIDATE_SYSTEM_TOKENS = 220

/** Tokens the evaluator's instructions add on top of the candidates it reads. */
const EVALUATOR_SYSTEM_TOKENS = 480

/** Prior on how long an answer runs, and the band around it. */
const EXPECTED_OUTPUT_TOKENS = 700
const OUTPUT_LOW_FACTOR = 0.35
const OUTPUT_HIGH_FACTOR = 2.5

/** Rough token count for a piece of text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** One panel member's share of the estimate. */
export interface ProviderEstimate {
  provider: ProviderId
  model: string
  inputTokens: number
  outputTokens: number
  costMicroCents: number
  /** False when no price is known for this model at all. */
  priced: boolean
  /** True when the price exists but has not been checked against the vendor. */
  unverified: boolean
}

export interface RunEstimate {
  /** Per-candidate breakdown, in panel order. */
  candidates: ProviderEstimate[]
  /** The synthesis call, which reads every candidate and is usually the largest. */
  evaluator: ProviderEstimate
  totalInputTokens: number
  totalOutputTokens: number
  /** Point estimate, in micro-cents. */
  costMicroCents: number
  /** The band the point estimate sits in, from the output-length prior. */
  lowMicroCents: number
  highMicroCents: number
  /** Models with no price at all — the estimate is an *understatement*. */
  unpricedModels: string[]
  /** True when any contributing price is an unverified placeholder. */
  unverified: boolean
}

/** How much to trust the number, in the three words a UI can show. */
export type EstimateConfidence = "rough" | "partial" | "unpriced"

export function estimateConfidence(estimate: RunEstimate): EstimateConfidence {
  if (estimate.unpricedModels.length > 0) return "unpriced"
  return estimate.unverified ? "partial" : "rough"
}

/** Which model a provider would actually be called with. */
function modelFor(provider: ProviderId, overrides: Readonly<Partial<Record<ProviderId, string>>>): string {
  return overrides[provider] ?? PROVIDERS[provider].defaultModel
}

function estimateCall(
  provider: ProviderId,
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: Date,
  prices: readonly ModelPrice[] | undefined,
): ProviderEstimate {
  const price = prices === undefined ? findModelPrice(model, at) : findModelPrice(model, at, prices)
  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    costMicroCents: computeCostMicroCents({ inputTokens, outputTokens }, price),
    priced: price !== null,
    unverified: price !== null && !price.verified,
  }
}

export interface EstimateInput {
  prompt: string
  /** The panel that will answer. Empty is allowed and yields a zero estimate. */
  providers: readonly ProviderId[]
  /**
   * Model ids per provider, when the caller knows them — `GET /api/providers`
   * reports the resolved ids, which may differ from the compiled-in defaults.
   */
  models?: Readonly<Partial<Record<ProviderId, string>>>
  /** The evaluator's model id, when it is known to differ from the default. */
  evaluatorModel?: string
  at?: Date
  /** Injectable price list, so the estimator is testable without the registry. */
  prices?: readonly ModelPrice[]
}

/**
 * Estimate a run.
 *
 * The evaluator's input is the interesting term and the one a naive estimate
 * gets badly wrong: it reads *every* candidate answer plus the original prompt,
 * so its input grows with the size of the panel. On a four-model panel the
 * synthesis call is typically the single most expensive call in the run, which
 * is exactly the thing a user choosing a panel size should be able to see.
 */
export function estimateRun(input: EstimateInput): RunEstimate {
  const at = input.at ?? new Date()
  const models = input.models ?? {}
  const promptTokens = estimateTokens(input.prompt)

  const candidates = input.providers.map((provider) =>
    estimateCall(
      provider,
      modelFor(provider, models),
      promptTokens + CANDIDATE_SYSTEM_TOKENS,
      EXPECTED_OUTPUT_TOKENS,
      at,
      input.prices,
    ),
  )

  const candidateOutput = candidates.reduce((sum, c) => sum + c.outputTokens, 0)
  const evaluator = estimateCall(
    EVALUATOR.provider,
    input.evaluatorModel ?? EVALUATOR.defaultModel,
    promptTokens + candidateOutput + EVALUATOR_SYSTEM_TOKENS,
    EXPECTED_OUTPUT_TOKENS,
    at,
    input.prices,
  )

  const calls = [...candidates, evaluator]
  const costMicroCents = calls.reduce((sum, call) => sum + call.costMicroCents, 0)

  // The band comes from scaling the *output* prior only: input length is known
  // from the prompt the user has already typed, so widening it would be
  // pretending to an uncertainty that does not exist.
  const scale = (factor: number): number =>
    calls.reduce(
      (sum, call) =>
        sum +
        Math.round(
          (call.costMicroCents * (call.inputTokens + call.outputTokens * factor)) /
            Math.max(1, call.inputTokens + call.outputTokens),
        ),
      0,
    )

  return {
    candidates,
    evaluator,
    totalInputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    totalOutputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    costMicroCents,
    lowMicroCents: Math.min(costMicroCents, scale(OUTPUT_LOW_FACTOR)),
    highMicroCents: Math.max(costMicroCents, scale(OUTPUT_HIGH_FACTOR)),
    unpricedModels: calls.filter((call) => !call.priced).map((call) => call.model),
    unverified: calls.some((call) => call.unverified),
  }
}

/**
 * The estimate as one line of prose.
 *
 * Deliberately a range with a qualifier — "about $0.03–$0.09" — because a
 * single figure to four decimal places reads as a quote, and this is not one.
 */
export function formatEstimate(estimate: RunEstimate): string {
  if (estimate.unpricedModels.length > 0 && estimate.costMicroCents === 0) {
    return "Cost unknown — no price on file for this panel"
  }
  const low = formatMicroCentsUsd(estimate.lowMicroCents, 3)
  const high = formatMicroCentsUsd(estimate.highMicroCents, 3)
  const range = low === high ? low : `${low}–${high}`
  return estimate.unpricedModels.length > 0 ? `at least ${range}` : `about ${range}`
}
