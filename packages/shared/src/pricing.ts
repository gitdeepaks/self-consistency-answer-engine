import { z } from "zod"
import { PROVIDER_IDS, type ProviderId } from "./models.ts"
import { providerIdSchema } from "./schemas.ts"

/**
 * Model pricing, in **micro-cents per 1,000,000 tokens**.
 *
 * A micro-cent is 1e-6 of a US cent (1e-8 USD), which keeps every price and
 * every derived cost an exact integer — no float drift accumulating across a
 * month of usage rollups. `$5.00 per 1M tokens` is `500 * 1e6 = 5e8`.
 *
 * Prices are versioned by `effectiveFrom` rather than overwritten, so a
 * historical `UsageRecord` can always be re-derived from the price that was in
 * force when the call was made.
 */

/** Micro-cents in one US dollar. */
export const MICRO_CENTS_PER_USD = 100 * 1_000_000

/** Convert a published "$X per 1M tokens" figure into the storage unit. */
export function usdPerMillionToMicroCents(usd: number): number {
  return Math.round(usd * MICRO_CENTS_PER_USD)
}

export const modelPriceSchema = z.object({
  provider: providerIdSchema,
  /** Model id exactly as it is sent to the provider. */
  model: z.string().min(1),
  /** Micro-cents per 1M input tokens. */
  inputPerMillion: z.number().int().nonnegative(),
  /** Micro-cents per 1M output tokens. */
  outputPerMillion: z.number().int().nonnegative(),
  /** ISO-8601 date this price took effect. */
  effectiveFrom: z.string(),
  /**
   * False means the figure is a placeholder that has not been checked against
   * the provider's published price list. Unverified prices are still recorded
   * so cost is never silently zero, but they must not be used to bill anyone.
   */
  verified: z.boolean(),
})
export type ModelPrice = z.infer<typeof modelPriceSchema>

function price(
  provider: ProviderId,
  model: string,
  usdIn: number,
  usdOut: number,
  effectiveFrom: string,
  verified: boolean,
): ModelPrice {
  return {
    provider,
    model,
    inputPerMillion: usdPerMillionToMicroCents(usdIn),
    outputPerMillion: usdPerMillionToMicroCents(usdOut),
    effectiveFrom,
    verified,
  }
}

/**
 * The seed price list.
 *
 * Anthropic entries are the published first-party API rates. OpenAI and Google
 * entries are **placeholders** — they are marked `verified: false` and must be
 * replaced with the vendors' published figures before any of this is used to
 * bill a tenant. `bun run db:seed` loads this list into the `ModelPrice` table;
 * later price changes are added as new rows with a newer `effectiveFrom`, never
 * as edits to an existing row.
 */
export const MODEL_PRICES: ModelPrice[] = [
  // Anthropic — https://claude.com/pricing (first-party API rates).
  price("anthropic", "claude-opus-5", 5, 25, "2026-01-01", true),
  price("anthropic", "claude-opus-4-8", 5, 25, "2026-01-01", true),
  price("anthropic", "claude-sonnet-5", 3, 15, "2026-01-01", true),
  price("anthropic", "claude-sonnet-4-6", 3, 15, "2026-01-01", true),
  price("anthropic", "claude-haiku-4-5", 1, 5, "2026-01-01", true),

  // OpenAI — PLACEHOLDER. Verify against OpenAI's published pricing.
  price("openai", "gpt-5.5", 1.25, 10, "2026-01-01", false),

  // Google — PLACEHOLDER. Verify against Google's published pricing.
  price("google", "gemini-3.7-flash", 0.3, 2.5, "2026-01-01", false),
]

/**
 * The price in force for a model at a point in time.
 *
 * Returns null for an unpriced model — the caller records the usage with a zero
 * cost and a null price id, which is what the "unpriced model appeared" alert
 * in Phase 8 watches for. Silently pricing an unknown model at zero without
 * that signal is how cost dashboards go quietly wrong.
 */
export function findModelPrice(
  model: string,
  at: Date = new Date(),
  prices: readonly ModelPrice[] = MODEL_PRICES,
): ModelPrice | null {
  const applicable = prices
    .filter((p) => p.model === model && new Date(p.effectiveFrom) <= at)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  return applicable[0] ?? null
}

/** Cost of a single model call, in micro-cents. */
export function computeCostMicroCents(
  usage: { inputTokens: number | null; outputTokens: number | null },
  price: ModelPrice | null,
): number {
  if (!price) return 0
  const input = ((usage.inputTokens ?? 0) * price.inputPerMillion) / 1_000_000
  const output = ((usage.outputTokens ?? 0) * price.outputPerMillion) / 1_000_000
  return Math.round(input + output)
}

/** Micro-cents rendered as a USD string, for dashboards and CLI output. */
export function formatMicroCentsUsd(microCents: number, fractionDigits = 4): string {
  return `$${(microCents / MICRO_CENTS_PER_USD).toFixed(fractionDigits)}`
}

/** Every provider that has at least one verified price. */
export function providersWithVerifiedPricing(
  prices: readonly ModelPrice[] = MODEL_PRICES,
): ProviderId[] {
  return PROVIDER_IDS.filter((id) => prices.some((p) => p.provider === id && p.verified))
}
