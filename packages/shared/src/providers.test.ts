import { describe, expect, test } from "bun:test"
import {
  resolveAvailability,
  resolveEvaluatorAvailability,
  resolvePanelAvailability,
  toHealth,
  type EnvSource,
} from "./providers.ts"

/**
 * Provider resolution, decided from configuration alone.
 *
 * The environment is injected rather than read from `process.env`, so these
 * assertions are about the rule and not about whichever keys happen to be in
 * the developer's `.env`.
 */

const NO_ENV: EnvSource = {}

describe("provider availability", () => {
  test("prefers a provider's own key over the gateway", () => {
    const availability = resolveAvailability("openai", undefined, {
      OPENAI_API_KEY: "sk-direct",
      AI_GATEWAY_API_KEY: "gw",
    })
    expect(availability.route).toBe("direct")
    expect(availability.hint).toBeNull()
  })

  test("falls back to the gateway when the provider has no key of its own", () => {
    const availability = resolveAvailability("google", undefined, { AI_GATEWAY_API_KEY: "gw" })
    expect(availability.route).toBe("gateway")
  })

  test("reports unavailable with a hint naming the variable to set", () => {
    const availability = resolveAvailability("anthropic", undefined, NO_ENV)
    expect(availability.route).toBeNull()
    expect(availability.hint).toContain("ANTHROPIC_API_KEY")
    expect(toHealth(availability).available).toBe(false)
  })

  test("a whitespace-only key is not a key", () => {
    expect(resolveAvailability("openai", undefined, { OPENAI_API_KEY: "   " }).route).toBeNull()
  })

  test("the per-provider model override wins over the default", () => {
    expect(
      resolveAvailability("openai", undefined, { OPENAI_MODEL: "gpt-tiny", OPENAI_API_KEY: "k" })
        .modelId,
    ).toBe("gpt-tiny")
  })

  test("narrows the panel to the providers asked for, in registry order", () => {
    const panel = resolvePanelAvailability(["google", "openai"], NO_ENV)
    expect(panel.map((entry) => entry.spec.id)).toEqual(["openai", "google"])
  })

  test("an empty subset means the whole panel", () => {
    expect(resolvePanelAvailability([], NO_ENV)).toHaveLength(3)
  })
})

describe("evaluator resolution", () => {
  /**
   * The regression this test exists for: the evaluator shares a vendor with a
   * panel member, so resolving it without an explicit model id lets
   * `ANTHROPIC_MODEL` silently demote it to whatever the *panel's* Claude is.
   * The evaluator is deliberately the stronger model, and that has to survive
   * configuration.
   */
  test("uses its own default, not the panel member's, when nothing is set", () => {
    expect(resolveEvaluatorAvailability(NO_ENV).modelId).toBe("claude-opus-5")
  })

  test("ignores ANTHROPIC_MODEL, which configures the panel member", () => {
    expect(
      resolveEvaluatorAvailability({ ANTHROPIC_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "k" })
        .modelId,
    ).toBe("claude-opus-5")
  })

  test("honours EVALUATOR_MODEL", () => {
    expect(
      resolveEvaluatorAvailability({ EVALUATOR_MODEL: "claude-opus-4-8", ANTHROPIC_API_KEY: "k" })
        .modelId,
    ).toBe("claude-opus-4-8")
  })
})
