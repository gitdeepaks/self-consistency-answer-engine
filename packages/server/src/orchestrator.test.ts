import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { ProviderId } from "@sce/shared"
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

/**
 * The orchestrator is exercised against mock language models, so these tests
 * cover the fan-out / synthesis wiring — concurrency, partial failure, event
 * ordering, persistence — without spending a token.
 */

type Behaviour = "ok" | "error" | "empty"

const behaviours: Record<ProviderId, Behaviour> = { openai: "ok", anthropic: "ok", google: "ok" }
let evaluatorAvailable = true
let evaluatorPayload: unknown = null
let lastEvaluatorPrompt = ""

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 22, text: 22, reasoning: 0 },
    },
    warnings: [],
  }
}

function candidateModel(id: ProviderId) {
  return new MockLanguageModelV4({
    provider: id,
    modelId: `mock-${id}`,
    doGenerate: async () => {
      const behaviour = behaviours[id]
      if (behaviour === "error") throw new Error(`${id} exploded`)
      if (behaviour === "empty") return textResult("   ")
      return textResult(`Answer from ${id}`)
    },
  })
}

function evaluatorModel() {
  return new MockLanguageModelV4({
    provider: "anthropic",
    modelId: "mock-evaluator",
    doGenerate: async (options) => {
      lastEvaluatorPrompt = JSON.stringify(options.prompt)
      if (evaluatorPayload === null) throw new Error("evaluator exploded")
      return textResult(JSON.stringify(evaluatorPayload))
    },
  })
}

const SPECS: Record<ProviderId, { id: ProviderId; label: string; color: string }> = {
  openai: { id: "openai", label: "OpenAI", color: "#10a37f" },
  anthropic: { id: "anthropic", label: "Claude", color: "#d97757" },
  google: { id: "google", label: "Gemini", color: "#4285f4" },
}

mock.module("./providers.ts", () => ({
  resolveProvider: (id: ProviderId) => ({
    spec: SPECS[id],
    modelId: `mock-${id}`,
    route: "direct",
    model: candidateModel(id),
    hint: null,
  }),
  resolvePanel: (only?: ProviderId[]) =>
    (only ?? (["openai", "anthropic", "google"] as ProviderId[])).map((id) => ({
      spec: SPECS[id],
      modelId: `mock-${id}`,
      route: "direct",
      model: candidateModel(id),
      hint: null,
    })),
  resolveEvaluator: () => ({
    spec: SPECS.anthropic,
    modelId: "mock-evaluator",
    route: "direct",
    model: evaluatorAvailable ? evaluatorModel() : null,
    hint: evaluatorAvailable ? null : "Set ANTHROPIC_API_KEY",
  }),
  toHealth: (r: { spec: { id: ProviderId } }) => ({ id: r.spec.id }),
}))

const { startRun } = await import("./orchestrator.ts")
const { runEvents } = await import("./event-bus.ts")
const { getRun, deleteRun } = await import("@sce/db")

/** Drain the event bus until the run reaches a terminal event. */
async function waitForRun(runId: string, timeoutMs = 5_000) {
  const events: string[] = []
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run ${runId} did not finish`)), timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const unsubscribe = runEvents.subscribe(runId, (event) => {
      events.push(event.type)
      if (event.type === "run.completed" || event.type === "run.failed") finish()
    })
    for (const event of runEvents.history(runId)) {
      events.push(event.type)
      if (event.type === "run.completed" || event.type === "run.failed") finish()
    }
  })
  const run = await getRun(runId)
  if (!run) throw new Error("run vanished")
  return { run, events }
}

const GOOD_SYNTHESIS = {
  agreements: ["All three agreed the sky scatters blue light"],
  disagreements: ["Only one mentioned Rayleigh scattering by name"],
  reviews: [
    { provider: "openai", score: 8, strengths: ["clear"], weaknesses: ["shallow"] },
    { provider: "anthropic", score: 9, strengths: ["precise"], weaknesses: [] },
    { provider: "google", score: 7, strengths: ["concise"], weaknesses: ["missed detail"] },
  ],
  finalAnswer: "A merged answer that belongs to none of them.",
  confidence: 0.86,
}

beforeAll(() => {
  process.env.MAX_RETRIES = "1"
})

describe("orchestrator", () => {
  test("fans out to the whole panel and synthesises a merged answer", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "ok"
    evaluatorAvailable = true
    evaluatorPayload = GOOD_SYNTHESIS

    const seeded = await startRun({ prompt: "Why is the sky blue?" })
    const { run, events } = await waitForRun(seeded.id)

    expect(run.status).toBe("COMPLETE")
    expect(run.candidates).toHaveLength(3)
    expect(run.candidates.every((c) => c.status === "OK")).toBe(true)
    expect(run.candidates.map((c) => c.content)).toEqual([
      "Answer from openai",
      "Answer from anthropic",
      "Answer from google",
    ])

    expect(run.synthesis?.finalAnswer).toBe(GOOD_SYNTHESIS.finalAnswer)
    expect(run.synthesis?.reviews).toHaveLength(3)
    expect(run.synthesis?.confidence).toBeCloseTo(0.86)
    expect(run.totalLatencyMs).toBeGreaterThanOrEqual(0)

    // The evaluator must see every candidate answer verbatim.
    for (const id of ["openai", "anthropic", "google"]) {
      expect(lastEvaluatorPrompt).toContain(`Answer from ${id}`)
    }

    expect(events).toContain("candidate.settled")
    expect(events).toContain("synthesis.settled")
    expect(events.at(-1)).toBe("run.completed")

    await deleteRun(run.id)
  })

  test("survives a partial panel failure and still synthesises", async () => {
    behaviours.openai = "ok"
    behaviours.anthropic = "error"
    behaviours.google = "empty"
    evaluatorAvailable = true
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[0]] }

    const seeded = await startRun({ prompt: "Explain quicksort" })
    const { run } = await waitForRun(seeded.id)

    expect(run.status).toBe("COMPLETE")
    const byProvider = Object.fromEntries(run.candidates.map((c) => [c.provider, c]))
    expect(byProvider.openai?.status).toBe("OK")
    expect(byProvider.anthropic?.status).toBe("ERROR")
    expect(byProvider.anthropic?.error).toContain("exploded")
    // An all-whitespace answer is a failure, not a valid candidate.
    expect(byProvider.google?.status).toBe("ERROR")
    expect(byProvider.google?.error).toContain("empty")

    expect(run.synthesis).not.toBeNull()
    await deleteRun(run.id)
  })

  test("fails the run when every model fails", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "error"
    evaluatorAvailable = true
    evaluatorPayload = GOOD_SYNTHESIS

    const seeded = await startRun({ prompt: "Anything at all" })
    const { run, events } = await waitForRun(seeded.id)

    expect(run.status).toBe("FAILED")
    expect(run.error).toContain("Every model in the panel failed")
    expect(run.synthesis).toBeNull()
    expect(events.at(-1)).toBe("run.failed")

    await deleteRun(run.id)
  })

  test("fails cleanly when the evaluator errors, keeping candidates intact", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "ok"
    evaluatorAvailable = true
    evaluatorPayload = null

    const seeded = await startRun({ prompt: "Evaluator down" })
    const { run } = await waitForRun(seeded.id)

    expect(run.status).toBe("FAILED")
    expect(run.error).toContain("Synthesis failed")
    // Candidate work is not thrown away just because synthesis failed.
    expect(run.candidates.filter((c) => c.status === "OK")).toHaveLength(3)

    await deleteRun(run.id)
  })

  test("honours a provider subset", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "ok"
    evaluatorAvailable = true
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[1]] }

    const seeded = await startRun({ prompt: "Only Claude please", providers: ["anthropic"] })
    const { run } = await waitForRun(seeded.id)

    expect(run.candidates).toHaveLength(1)
    expect(run.candidates[0]?.provider).toBe("anthropic")
    expect(run.status).toBe("COMPLETE")

    await deleteRun(run.id)
  })

  test("backfills a review for any candidate the evaluator ignored", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "ok"
    evaluatorAvailable = true
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[0]] }

    const seeded = await startRun({ prompt: "Partial reviews" })
    const { run } = await waitForRun(seeded.id)

    expect(run.synthesis?.reviews).toHaveLength(3)
    expect(run.synthesis?.reviews.map((r) => r.provider)).toEqual([
      "openai",
      "anthropic",
      "google",
    ])
    expect(run.synthesis?.reviews[2]?.weaknesses[0]).toContain("did not return a review")

    await deleteRun(run.id)
  })
})
