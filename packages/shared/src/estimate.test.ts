import { describe, expect, test } from "bun:test"
import { estimateConfidence, estimateRun, estimateTokens, formatEstimate } from "./estimate.ts"
import type { ModelPrice } from "./pricing.ts"

/**
 * The cost estimate.
 *
 * The estimate is shown to somebody about to spend money, so the properties
 * worth pinning down are not "is the number right" — it cannot be — but "does
 * it fail honestly": does it understate when a price is missing, does it widen
 * with the panel, and does it say so when it is guessing.
 */

const PRICES: ModelPrice[] = [
  {
    provider: "openai",
    model: "gpt-5.5",
    inputPerMillion: 1_250_000,
    outputPerMillion: 10_000_000,
    effectiveFrom: "2026-01-01",
    verified: true,
  },
  {
    provider: "anthropic",
    model: "claude-opus-5",
    inputPerMillion: 5_000_000,
    outputPerMillion: 25_000_000,
    effectiveFrom: "2026-01-01",
    verified: true,
  },
  {
    provider: "google",
    model: "gemini-3.7-flash",
    inputPerMillion: 300_000,
    outputPerMillion: 2_500_000,
    effectiveFrom: "2026-01-01",
    verified: false,
  },
]

const at = new Date("2026-06-01T00:00:00Z")

describe("token approximation", () => {
  test("scales with length and never returns zero for real text", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("a")).toBe(1)
    expect(estimateTokens("a".repeat(400))).toBe(100)
  })
})

describe("estimating a run", () => {
  test("the evaluator reads every candidate, so its input grows with the panel", () => {
    // This is the term a naive estimate gets badly wrong, and the one a user
    // choosing a panel size most needs to see.
    const one = estimateRun({ prompt: "Why?", providers: ["openai"], at, prices: PRICES })
    const three = estimateRun({
      prompt: "Why?",
      providers: ["openai", "anthropic", "google"],
      at,
      prices: PRICES,
    })

    expect(three.evaluator.inputTokens).toBeGreaterThan(one.evaluator.inputTokens)
    expect(three.costMicroCents).toBeGreaterThan(one.costMicroCents)
  })

  test("an empty panel still prices the evaluator and nothing else", () => {
    const estimate = estimateRun({ prompt: "Why?", providers: [], at, prices: PRICES })
    expect(estimate.candidates).toHaveLength(0)
    expect(estimate.evaluator.costMicroCents).toBeGreaterThan(0)
  })

  test("the band brackets the point estimate", () => {
    const estimate = estimateRun({
      prompt: "Explain Rayleigh scattering.",
      providers: ["openai", "anthropic"],
      at,
      prices: PRICES,
    })
    expect(estimate.lowMicroCents).toBeLessThanOrEqual(estimate.costMicroCents)
    expect(estimate.highMicroCents).toBeGreaterThanOrEqual(estimate.costMicroCents)
  })

  test("an unpriced model is named, and the estimate is flagged as a floor", () => {
    // The dangerous failure is a confident zero. An unpriced model has to make
    // the whole estimate visibly an understatement.
    const estimate = estimateRun({
      prompt: "Why?",
      providers: ["openai"],
      models: { openai: "some-model-nobody-priced" },
      at,
      prices: PRICES,
    })

    expect(estimate.unpricedModels).toContain("some-model-nobody-priced")
    expect(estimateConfidence(estimate)).toBe("unpriced")
    expect(formatEstimate(estimate)).toContain("at least")
  })

  test("an unverified placeholder price is reported as partial confidence", () => {
    const estimate = estimateRun({
      prompt: "Why?",
      providers: ["google"],
      at,
      prices: PRICES,
    })
    expect(estimate.unverified).toBe(true)
    expect(estimateConfidence(estimate)).toBe("partial")
  })

  test("a fully-priced, verified panel reads as a rough estimate", () => {
    const estimate = estimateRun({
      prompt: "Why?",
      providers: ["openai"],
      at,
      prices: PRICES,
    })
    expect(estimate.unverified).toBe(false)
    expect(estimateConfidence(estimate)).toBe("rough")
    expect(formatEstimate(estimate)).toContain("about")
  })

  test("a longer prompt costs more", () => {
    const short = estimateRun({ prompt: "Hi", providers: ["openai"], at, prices: PRICES })
    const long = estimateRun({
      prompt: "word ".repeat(2000),
      providers: ["openai"],
      at,
      prices: PRICES,
    })
    expect(long.costMicroCents).toBeGreaterThan(short.costMicroCents)
  })

  test("the resolved model override is what gets priced", () => {
    // `GET /api/providers` reports the model an install will actually call,
    // which may not be the compiled-in default. Pricing the default would quote
    // for a model nobody is going to use.
    const estimate = estimateRun({
      prompt: "Why?",
      providers: ["openai"],
      models: { openai: "claude-opus-5" },
      at,
      prices: PRICES,
    })
    expect(estimate.candidates[0]?.model).toBe("claude-opus-5")
  })
})

describe("formatting", () => {
  test("a panel with no prices at all says so instead of quoting zero", () => {
    const estimate = estimateRun({
      prompt: "Why?",
      providers: ["openai"],
      models: { openai: "unknown-a" },
      evaluatorModel: "unknown-b",
      at,
      prices: PRICES,
    })
    expect(estimate.costMicroCents).toBe(0)
    expect(formatEstimate(estimate)).toBe("Cost unknown — no price on file for this panel")
  })
})
