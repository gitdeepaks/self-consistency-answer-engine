import { describe, expect, test } from "bun:test"
import {
  DEFAULT_NEAR_DUPLICATE_OPTIONS,
  findNearDuplicate,
  fingerprint,
  fromSimhashHex,
  hammingDistance,
  jaccard,
  normalizePrompt,
  promptSimhash,
  promptTokens,
  shingles,
  toSimhashHex,
} from "./answer-cache.ts"

/**
 * A cache that returns the wrong answer is worse than no cache: the answer is
 * confident, plausible, and about a different question. So the tests that
 * matter here are the negative ones — the pairs that must *not* match — and
 * every knob that would change what "the same question" means.
 */

const OPENAI_SEAT = { provider: "openai", model: "gpt-5.5" }
const CLAUDE_SEAT = { provider: "anthropic", model: "claude-sonnet-5" }
const SEATS = [OPENAI_SEAT, CLAUDE_SEAT]

const BASE = { seats: SEATS, temperature: null, promptSetId: "prompts.v1" }

describe("normalizePrompt", () => {
  test("ignores case, padding and typographic quotes", () => {
    expect(normalizePrompt("  What’s   a MONAD?  ")).toBe("what's a monad?")
  })

  test("strips zero-width characters a copy-paste drags in", () => {
    expect(normalizePrompt("hel​lo﻿ world")).toBe("hello world")
  })

  test("keeps punctuation that changes the question", () => {
    expect(normalizePrompt("Let's eat, grandma")).not.toBe(normalizePrompt("Let's eat grandma"))
  })
})

describe("tokens and shingles", () => {
  test("tokens drop punctuation, shingles keep local order", () => {
    expect(promptTokens("Reverse a linked list, in Rust.")).toEqual([
      "reverse",
      "a",
      "linked",
      "list",
      "in",
      "rust",
    ])
    expect(shingles(["a", "b", "c", "d"])).toEqual(["a b c", "b c d"])
  })

  test("a prompt shorter than the window still produces features", () => {
    expect(shingles(["why", "though"])).toEqual(["why", "though"])
    expect(shingles([])).toEqual([])
  })
})

describe("simhash", () => {
  test("similar prompts land close together, unrelated ones do not", () => {
    const near = hammingDistance(
      promptSimhash("How do I reverse a linked list in Rust?"),
      promptSimhash("how do i reverse a linked list in rust"),
    )
    const far = hammingDistance(
      promptSimhash("How do I reverse a linked list in Rust?"),
      promptSimhash("What were the causes of the Thirty Years' War?"),
    )

    expect(near).toBe(0)
    expect(far).toBeGreaterThan(DEFAULT_NEAR_DUPLICATE_OPTIONS.maxHammingDistance)
  })

  test("round-trips through its stored hex form", () => {
    const hash = promptSimhash("Explain the CAP theorem")
    const hex = toSimhashHex(hash)

    expect(hex).toMatch(/^[0-9a-f]{16}$/)
    expect(fromSimhashHex(hex)).toBe(hash)
  })

  test("a malformed stored fingerprint is rejected, not coerced", () => {
    expect(fromSimhashHex("not-a-hash")).toBeNull()
    expect(fromSimhashHex("ABCDEF0123456789")).toBeNull()
    expect(fromSimhashHex("")).toBeNull()
  })
})

describe("jaccard", () => {
  test("measures overlap, and calls two empty sets equal", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 6)
    expect(jaccard(new Set(), new Set())).toBe(1)
    expect(jaccard(new Set(["a"]), new Set())).toBe(0)
  })
})

describe("fingerprint", () => {
  test("the same question on the same panel is the same key", async () => {
    const left = await fingerprint({ ...BASE, prompt: "Why is the sky blue?" })
    const right = await fingerprint({ ...BASE, prompt: "  why is the SKY blue?  " })

    expect(left.key).toBe(right.key)
    expect(left.scope).toBe(right.scope)
  })

  test("panel order does not matter, but panel membership does", async () => {
    const forward = await fingerprint({ ...BASE, prompt: "Why is the sky blue?" })
    const reversed = await fingerprint({
      ...BASE,
      seats: [...SEATS].reverse(),
      prompt: "Why is the sky blue?",
    })
    const extra = await fingerprint({
      ...BASE,
      seats: [...SEATS, { provider: "google", model: "gemini-3.7-flash" }],
      prompt: "Why is the sky blue?",
    })

    expect(forward.key).toBe(reversed.key)
    expect(forward.key).not.toBe(extra.key)
    expect(forward.scope).not.toBe(extra.scope)
  })

  test("a second sample of one model is a different panel", async () => {
    const once = await fingerprint({ ...BASE, seats: [OPENAI_SEAT], prompt: "Why?" })
    const twice = await fingerprint({
      ...BASE,
      seats: [OPENAI_SEAT, OPENAI_SEAT],
      prompt: "Why?",
    })

    expect(once.key).not.toBe(twice.key)
  })

  test("temperature, model and prompt set all change the key", async () => {
    const base = await fingerprint({ ...BASE, prompt: "Why is the sky blue?" })

    const warmer = await fingerprint({ ...BASE, temperature: 0.7, prompt: "Why is the sky blue?" })
    const newerModel = await fingerprint({
      ...BASE,
      seats: [{ provider: "openai", model: "gpt-6" }, CLAUDE_SEAT],
      prompt: "Why is the sky blue?",
    })
    const newerPrompts = await fingerprint({ ...BASE, promptSetId: "prompts.v2", prompt: "Why is the sky blue?" })

    for (const other of [warmer, newerModel, newerPrompts]) {
      expect(other.key).not.toBe(base.key)
      expect(other.scope).not.toBe(base.scope)
    }
  })

  test("a temperature of zero is not the same as no temperature at all", async () => {
    const unset = await fingerprint({ ...BASE, prompt: "Why?" })
    const zero = await fingerprint({ ...BASE, temperature: 0, prompt: "Why?" })

    expect(unset.key).not.toBe(zero.key)
  })
})

describe("findNearDuplicate", () => {
  const entry = (runId: string, prompt: string) => ({
    runId,
    prompt,
    simhash: toSimhashHex(promptSimhash(prompt)),
  })

  test("finds a reworded question", () => {
    const match = findNearDuplicate("How do I reverse a linked list in Rust?", [
      entry("run_far", "What caused the fall of the Western Roman Empire?"),
      entry("run_near", "How do I reverse a linked list in Rust"),
    ])

    expect(match?.runId).toBe("run_near")
    expect(match?.similarity).toBeGreaterThanOrEqual(DEFAULT_NEAR_DUPLICATE_OPTIONS.minJaccard)
  })

  test("refuses a reordering, which the token overlap cannot see", () => {
    // Identical token sets, opposite questions. Jaccard is 1.0 here, so the
    // fingerprint is the only thing standing between this and the wrong answer.
    const match = findNearDuplicate("Explain why the sky is blue and the sunset is red", [
      entry("run_swapped", "Explain why the sunset is blue and the sky is red"),
    ])

    expect(match).toBeNull()
  })

  test("refuses a swapped comparison", () => {
    const match = findNearDuplicate("Does caching improve latency more than batching?", [
      entry("run_swapped", "Does batching improve latency more than caching?"),
    ])

    expect(match).toBeNull()
  })

  test("accepts a genuine rewording of a long prompt", () => {
    // One word appended to a long question: the fingerprint barely moves and
    // the overlap stays high. This is the case near matching exists for.
    const prompt =
      "Explain how the transformer attention mechanism works in plain terms for a software " +
      "engineer who has never read the original paper but understands linear algebra"
    const match = findNearDuplicate(`${prompt} please`, [entry("run_long", prompt)])

    expect(match?.runId).toBe("run_long")
  })

  test("refuses a near-miss that changes the answer", () => {
    // One token apart by distance, a different language by meaning. This is the
    // case a simhash-only cache gets wrong, and the Jaccard gate is why it does
    // not: the token sets differ by exactly the word that matters.
    const match = findNearDuplicate("How do I reverse a linked list in Rust?", [
      entry("run_python", "How do I reverse a linked list in Python?"),
    ])

    expect(match).toBeNull()
  })

  test("an empty or unusable candidate set is a miss, not a crash", () => {
    expect(findNearDuplicate("anything", [])).toBeNull()
    expect(
      findNearDuplicate("anything", [{ runId: "run_bad", prompt: "anything", simhash: "zzzz" }]),
    ).toBeNull()
  })

  test("prefers the most similar candidate, not the first", () => {
    const match = findNearDuplicate("Explain the CAP theorem in distributed systems", [
      entry("run_looser", "Explain the CAP theorem in distributed systems briefly"),
      entry("run_exact", "explain the cap theorem in distributed systems"),
    ])

    expect(match?.runId).toBe("run_exact")
    expect(match?.similarity).toBe(1)
  })

  test("every threshold can reject on its own", () => {
    const candidates = [entry("run_near", "Explain the CAP theorem in distributed systems briefly")]
    const prompt = "Explain the CAP theorem in distributed systems"
    const loose = { maxHammingDistance: 20, minJaccard: 0.8, minShingleJaccard: 0.8 }

    expect(findNearDuplicate(prompt, candidates, loose)?.runId).toBe("run_near")
    // Each gate, tightened alone, is enough to refuse.
    expect(findNearDuplicate(prompt, candidates, { ...loose, maxHammingDistance: 0 })).toBeNull()
    expect(findNearDuplicate(prompt, candidates, { ...loose, minJaccard: 1 })).toBeNull()
    expect(findNearDuplicate(prompt, candidates, { ...loose, minShingleJaccard: 1 })).toBeNull()
  })

  test("a match reports both overlaps, not just the fingerprint distance", () => {
    const prompt =
      "Explain how the transformer attention mechanism works in plain terms for a software " +
      "engineer who has never read the original paper but understands linear algebra"
    const match = findNearDuplicate(`${prompt} please`, [entry("run_long", prompt)])

    expect(match).not.toBeNull()
    expect(match?.similarity ?? 0).toBeGreaterThanOrEqual(0.9)
    expect(match?.phraseSimilarity ?? 0).toBeGreaterThanOrEqual(0.8)
  })
})
