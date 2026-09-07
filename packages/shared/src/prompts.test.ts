import { describe, expect, test } from "bun:test"
import {
  CANDIDATE_PROMPTS,
  DEFAULT_PROMPT_SET,
  DEFAULT_PROMPT_SET_ID,
  EVALUATOR_PROMPTS,
  PROMPT_SETS,
  PROMPT_SET_LIST,
  promptSetIdSchema,
  resolvePromptSet,
} from "./prompts.ts"

/**
 * The registry's value is entirely in its invariants: ids that never change
 * meaning, and a resolver that refuses to guess. Both are cheap to break by
 * editing a record in place, and neither breaks anything visible at the time —
 * which is what these tests are for.
 */

describe("the registry", () => {
  test("every set resolves, and names prompts of the right role", () => {
    for (const set of PROMPT_SET_LIST) {
      expect(resolvePromptSet(set.id)).toBe(set)
      expect(set.candidate.role).toBe("candidate")
      expect(set.evaluator.role).toBe("evaluator")
      expect(set.candidate.text.trim().length).toBeGreaterThan(0)
      expect(set.evaluator.text.trim().length).toBeGreaterThan(0)
    }
  })

  test("prompt ids are unique across roles", () => {
    const ids = [
      ...Object.values(CANDIDATE_PROMPTS).map((prompt) => prompt.id),
      ...Object.values(EVALUATOR_PROMPTS).map((prompt) => prompt.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("each record's key matches the id inside it", () => {
    for (const [key, prompt] of Object.entries({ ...CANDIDATE_PROMPTS, ...EVALUATOR_PROMPTS })) {
      expect(prompt.id).toBe(key)
    }
    for (const [key, set] of Object.entries(PROMPT_SETS)) {
      // Compared as strings: `Object.entries` widens the key, and the point of
      // the check is that the record's own id agrees with where it is filed.
      expect(String(set.id)).toBe(key)
    }
  })

  test("the default set is registered", () => {
    expect(PROMPT_SETS[DEFAULT_PROMPT_SET_ID]).toBe(DEFAULT_PROMPT_SET)
    expect(promptSetIdSchema.safeParse(DEFAULT_PROMPT_SET_ID).success).toBe(true)
  })
})

describe("resolvePromptSet", () => {
  test("a run from before prompt versioning resolves to the default", () => {
    expect(resolvePromptSet(null)).toBe(DEFAULT_PROMPT_SET)
  })

  test("an id this build does not know is null, never a fallback", () => {
    // A worker from an older release must refuse a run created by a newer one
    // rather than answer it with different wording than it was created under.
    expect(resolvePromptSet("prompts.v99")).toBeNull()
    expect(resolvePromptSet("")).toBeNull()
  })
})

describe("the evaluator prompt", () => {
  test("defines what the confidence number means", () => {
    // The calibration work in Phase 7 measures this number against measured
    // accuracy. That is only meaningful if the evaluator was told to report a
    // probability rather than a feeling.
    const text = DEFAULT_PROMPT_SET.evaluator.text
    expect(text).toContain("probability")
    expect(text.toLowerCase()).toContain("confidence")
  })

  test("still forbids copying a single candidate verbatim", () => {
    expect(DEFAULT_PROMPT_SET.evaluator.text).toContain("MUST NOT be a verbatim")
  })
})
