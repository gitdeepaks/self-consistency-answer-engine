import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { CandidateSeed } from "@sce/db"
import type { ProviderId, RunEvent } from "@sce/shared"
import { MockLanguageModelV4 } from "ai/test"

/**
 * The pipeline, exercised against mock language models.
 *
 * These are the orchestrator tests from before Phase 2, rewritten against the
 * shape the orchestrator now has: two independently-delivered job processors
 * instead of one `async` function. That rewrite is the point — the assertions
 * about fan-out, partial failure, event ordering and persistence are unchanged,
 * which is the evidence that splitting the run across a queue did not change
 * what a run *means*.
 *
 * They then go on to test what only the new shape can do: streaming deltas,
 * redelivery, cancellation and budget ceilings.
 */

type Behaviour = "ok" | "error" | "empty" | "rate-limited" | "slow"

const behaviours: Record<ProviderId, Behaviour> = { openai: "ok", anthropic: "ok", google: "ok" }
let evaluatorAvailable = true
let evaluatorPayload: unknown = null
let lastEvaluatorPrompt = ""
/** Model calls actually issued, so double-charging is observable. */
const calls: ProviderId[] = []

const USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 22, text: 22, reasoning: 0 },
} as const

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  }
}

/** A 429 with a `Retry-After`, the shape the resilience layer classifies. */
class RateLimitedError extends Error {
  readonly statusCode = 429
  readonly responseHeaders = { "retry-after": "1" }

  constructor(provider: ProviderId) {
    super(`${provider} is rate limited`)
    this.name = "RateLimitedError"
  }
}

function streamParts(text: string): LanguageModelV4StreamPart[] {
  // Several deltas, so the delta buffer has something to batch.
  const chunks = text.match(/.{1,6}/g) ?? [text]
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...chunks.map((delta): LanguageModelV4StreamPart => ({ type: "text-delta", id: "0", delta })),
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ]
}

function toStream(parts: readonly LanguageModelV4StreamPart[]) {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

function candidateModel(id: ProviderId) {
  return new MockLanguageModelV4({
    provider: id,
    modelId: `mock-${id}`,
    doStream: async ({ abortSignal }) => {
      calls.push(id)
      const behaviour = behaviours[id]

      if (behaviour === "error") throw new Error(`${id} exploded`)
      if (behaviour === "rate-limited") throw new RateLimitedError(id)
      if (behaviour === "empty") return { stream: toStream(streamParts("   ")) }
      if (behaviour === "slow") {
        // Emits one chunk, then waits to be aborted — the cancellation case.
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({ type: "text-start", id: "0" })
              controller.enqueue({ type: "text-delta", id: "0", delta: "thinking" })
              await new Promise<void>((resolve) => {
                if (abortSignal?.aborted) resolve()
                else abortSignal?.addEventListener("abort", () => resolve(), { once: true })
              })
              controller.error(new DOMException("aborted", "AbortError"))
            },
          }),
        }
      }
      return { stream: toStream(streamParts(`Answer from ${id}`)) }
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

const PANEL: ProviderId[] = ["openai", "anthropic", "google"]

mock.module("./providers.ts", () => ({
  resolveProvider: (id: ProviderId) => ({
    spec: SPECS[id],
    modelId: `mock-${id}`,
    route: "direct",
    model: candidateModel(id),
    hint: null,
  }),
  resolvePanel: (only?: ProviderId[]) =>
    (only ?? PANEL).map((id) => ({
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
}))

const { LocalCancellationBus, LocalRunBus, localJobMeta, setCancellationBus, setRunBus } =
  await import("@sce/queue")
const { cancelRun, createRun, deleteRun, ensureTenant, getRun, listRunEvents } =
  await import("@sce/db")
const { processCandidateJob } = await import("./candidate.ts")
const { processSynthesisJob } = await import("./synthesis.ts")
const { MemoryBreakerStore, setBreakerStore } = await import("./resilience.ts")

// A tenant of its own, so these tests neither see nor disturb the runs the
// HTTP suite creates under the default tenant.
const tenantId = (await ensureTenant("test-pipeline", "Pipeline tests")).id

const SEEDS: CandidateSeed[] = PANEL.map((id) => ({
  provider: id,
  label: SPECS[id].label,
  model: `mock-${id}`,
  status: "PENDING",
}))

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

interface SeedOptions {
  prompt?: string
  providers?: ProviderId[]
  deadlineAt?: Date
  maxTotalTokens?: number
  maxCostMicroCents?: number
}

async function seedRun(options: SeedOptions = {}) {
  const wanted = options.providers ?? PANEL
  return createRun({
    tenantId,
    prompt: options.prompt ?? "Why is the sky blue?",
    candidates: SEEDS.filter((seed) => wanted.includes(seed.provider)),
    deadlineAt: options.deadlineAt ?? new Date(Date.now() + 60_000),
    maxTotalTokens: options.maxTotalTokens ?? 0,
    maxCostMicroCents: options.maxCostMicroCents ?? 0,
  })
}

/**
 * Run the flow the queue would: every candidate concurrently, then synthesis.
 *
 * These are the same processors BullMQ delivers to; only the delivery is
 * different, which is exactly the property that makes the local transport a
 * trustworthy test substrate rather than a second implementation.
 */
async function runFlow(runId: string): Promise<void> {
  const run = await getRun(tenantId, runId)
  if (!run) throw new Error("run vanished")

  await Promise.all(
    run.candidates
      .filter((candidate) => candidate.status === "PENDING")
      .map((candidate) =>
        processCandidateJob(
          { tenantId, runId, candidateId: candidate.id },
          localJobMeta(`cand:${candidate.id}`),
        ),
      ),
  )
  await processSynthesisJob({ tenantId, runId }, localJobMeta(`synth:${runId}`))
}

/** Every event the run persisted, in order. */
async function eventTypes(runId: string): Promise<RunEvent["type"][]> {
  const records = await listRunEvents(tenantId, runId)
  return records.map((record) => record.event.type)
}

beforeAll(() => {
  // Both buses run in-process: these tests are about the pipeline, and the
  // Redis-backed transport has its own suite in @sce/queue.
  setRunBus(new LocalRunBus())
  setCancellationBus(new LocalCancellationBus())
  setBreakerStore(new MemoryBreakerStore())
})

beforeEach(() => {
  behaviours.openai = behaviours.anthropic = behaviours.google = "ok"
  evaluatorAvailable = true
  evaluatorPayload = GOOD_SYNTHESIS
  calls.length = 0
  setBreakerStore(new MemoryBreakerStore())
})

describe("pipeline", () => {
  test("fans out to the whole panel and synthesises a merged answer", async () => {
    const seeded = await seedRun()
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("COMPLETE")
    expect(run?.candidates).toHaveLength(3)
    expect(run?.candidates.every((c) => c.status === "OK")).toBe(true)
    expect(run?.candidates.map((c) => c.content)).toEqual([
      "Answer from openai",
      "Answer from anthropic",
      "Answer from google",
    ])

    expect(run?.synthesis?.finalAnswer).toBe(GOOD_SYNTHESIS.finalAnswer)
    expect(run?.synthesis?.reviews).toHaveLength(3)
    expect(run?.synthesis?.confidence).toBeCloseTo(0.86)

    // The evaluator must see every candidate answer verbatim.
    for (const id of PANEL) expect(lastEvaluatorPrompt).toContain(`Answer from ${id}`)

    const types = await eventTypes(seeded.id)
    expect(types).toContain("candidate.settled")
    expect(types).toContain("synthesis.settled")
    expect(types.at(-1)).toBe("run.completed")

    await deleteRun(tenantId, seeded.id)
  })

  test("streams deltas without writing them to the durable log", async () => {
    const seeded = await seedRun({ providers: ["openai"] })

    const seen: RunEvent[] = []
    const bus = new LocalRunBus()
    const controller = new AbortController()
    setRunBus(bus)

    const reader = (async () => {
      for await (const message of bus.subscribe(tenantId, seeded.id, {
        afterSeq: 0,
        signal: controller.signal,
      })) {
        if (message.kind === "event") seen.push(message.frame.event)
        if (message.kind === "event" && message.frame.event.type === "run.completed") return
      }
    })()

    await runFlow(seeded.id)
    controller.abort()
    await reader

    const deltas = seen.filter((event) => event.type === "candidate.delta")
    expect(deltas.length).toBeGreaterThan(0)
    // The whole answer arrived in pieces, and the pieces reassemble to it.
    const joined = deltas.map((event) => (event.type === "candidate.delta" ? event.text : "")).join("")
    expect(joined).toBe("Answer from openai")

    // Ephemeral by construction: nothing about a delta reaches Postgres.
    expect(await eventTypes(seeded.id)).not.toContain("candidate.delta")

    setRunBus(new LocalRunBus())
    await deleteRun(tenantId, seeded.id)
  })

  test("survives a partial panel failure and still synthesises", async () => {
    behaviours.anthropic = "error"
    behaviours.google = "empty"
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[0]] }

    const seeded = await seedRun({ prompt: "Explain quicksort" })
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("COMPLETE")

    const byProvider = Object.fromEntries((run?.candidates ?? []).map((c) => [c.provider, c]))
    expect(byProvider.openai?.status).toBe("OK")
    expect(byProvider.anthropic?.status).toBe("ERROR")
    expect(byProvider.anthropic?.error).toContain("exploded")
    // An all-whitespace answer is a failure, not a valid candidate.
    expect(byProvider.google?.status).toBe("ERROR")
    expect(byProvider.google?.error).toContain("empty")

    expect(run?.synthesis).not.toBeNull()
    await deleteRun(tenantId, seeded.id)
  })

  test("fails the run when every model fails", async () => {
    behaviours.openai = behaviours.anthropic = behaviours.google = "error"

    const seeded = await seedRun({ prompt: "Anything at all" })
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("FAILED")
    expect(run?.error).toContain("Every model in the panel failed")
    expect(run?.synthesis).toBeNull()
    expect((await eventTypes(seeded.id)).at(-1)).toBe("run.failed")

    await deleteRun(tenantId, seeded.id)
  })

  test("fails cleanly when the evaluator errors, keeping candidates intact", async () => {
    evaluatorPayload = null

    const seeded = await seedRun({ prompt: "Evaluator down" })
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("FAILED")
    expect(run?.error).toContain("Synthesis failed")
    // Candidate work is not thrown away just because synthesis failed.
    expect(run?.candidates.filter((c) => c.status === "OK")).toHaveLength(3)

    await deleteRun(tenantId, seeded.id)
  })

  test("honours a provider subset", async () => {
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[1]] }

    const seeded = await seedRun({ prompt: "Only Claude please", providers: ["anthropic"] })
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.candidates).toHaveLength(1)
    expect(run?.candidates[0]?.provider).toBe("anthropic")
    expect(run?.status).toBe("COMPLETE")

    await deleteRun(tenantId, seeded.id)
  })

  test("backfills a review for any candidate the evaluator ignored", async () => {
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[0]] }

    const seeded = await seedRun({ prompt: "Partial reviews" })
    await runFlow(seeded.id)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.synthesis?.reviews).toHaveLength(3)
    expect(run?.synthesis?.reviews.map((r) => r.provider)).toEqual(PANEL)
    expect(run?.synthesis?.reviews[2]?.weaknesses[0]).toContain("did not return a review")

    await deleteRun(tenantId, seeded.id)
  })
})

describe("redelivery", () => {
  test("a candidate job delivered twice does not call the model twice", async () => {
    const seeded = await seedRun({ providers: ["openai"] })
    const candidateId = seeded.candidates[0]?.id
    expect(candidateId).toBeDefined()
    if (candidateId === undefined) return

    const job = { tenantId, runId: seeded.id, candidateId }
    await processCandidateJob(job, localJobMeta("cand:1"))
    // Exactly what BullMQ does after a worker dies without acknowledging.
    await processCandidateJob(job, localJobMeta("cand:1"))

    expect(calls.filter((id) => id === "openai")).toHaveLength(1)

    const run = await getRun(tenantId, seeded.id)
    expect(run?.candidates[0]?.status).toBe("OK")
    expect(run?.candidates[0]?.attempts).toBe(1)

    await deleteRun(tenantId, seeded.id)
  })

  test("a synthesis job delivered twice does not rewrite a finished run", async () => {
    const seeded = await seedRun({ providers: ["openai"] })
    evaluatorPayload = { ...GOOD_SYNTHESIS, reviews: [GOOD_SYNTHESIS.reviews[0]] }

    await runFlow(seeded.id)
    const first = await getRun(tenantId, seeded.id)

    await processSynthesisJob({ tenantId, runId: seeded.id }, localJobMeta("synth:1"))
    const second = await getRun(tenantId, seeded.id)

    expect(second?.status).toBe("COMPLETE")
    expect(second?.synthesis?.id).toBe(first?.synthesis?.id ?? "")
    expect(second?.completedAt).toBe(first?.completedAt ?? null)

    await deleteRun(tenantId, seeded.id)
  })
})

describe("cancellation", () => {
  test("a canceled run stops before its candidates are called", async () => {
    const seeded = await seedRun({ prompt: "Never mind" })
    await cancelRun(tenantId, seeded.id, "User closed the tab")

    await runFlow(seeded.id)

    expect(calls).toHaveLength(0)
    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("CANCELED")
    expect(run?.candidates.every((c) => c.status === "CANCELED")).toBe(true)
    expect(run?.candidates[0]?.error).toContain("User closed the tab")

    await deleteRun(tenantId, seeded.id)
  })

  test("cancelling mid-stream aborts the model call and keeps the partial answer", async () => {
    behaviours.openai = "slow"
    const seeded = await seedRun({ providers: ["openai"] })
    const candidateId = seeded.candidates[0]?.id
    if (candidateId === undefined) throw new Error("no candidate")

    const cancellation = new LocalCancellationBus()
    setCancellationBus(cancellation)

    const inFlight = processCandidateJob(
      { tenantId, runId: seeded.id, candidateId },
      localJobMeta("cand:1"),
    )

    // Give the stream a moment to emit its first chunk and register its watcher.
    await Bun.sleep(100)
    await cancelRun(tenantId, seeded.id, "Canceled by request")
    await cancellation.request(seeded.id, "Canceled by request")
    await inFlight

    const run = await getRun(tenantId, seeded.id)
    const candidate = run?.candidates[0]
    expect(candidate?.status).toBe("CANCELED")
    expect(candidate?.error).toBe("Canceled by request")
    // Streaming means the work done before the abort is not thrown away.
    expect(candidate?.content).toBe("thinking")

    setCancellationBus(new LocalCancellationBus())
    await deleteRun(tenantId, seeded.id)
  })
})

describe("budgets", () => {
  test("a run past its deadline is skipped rather than called", async () => {
    const seeded = await seedRun({ deadlineAt: new Date(Date.now() - 1_000) })
    await runFlow(seeded.id)

    expect(calls).toHaveLength(0)
    const run = await getRun(tenantId, seeded.id)
    expect(run?.status).toBe("FAILED")
    expect(run?.error).toContain("deadline")
    expect(run?.candidates.every((c) => c.status === "SKIPPED")).toBe(true)

    await deleteRun(tenantId, seeded.id)
  })

  test("a run that has spent its token ceiling stops fanning out", async () => {
    // One candidate first, which records usage; the ceiling then bites.
    const seeded = await seedRun({ maxTotalTokens: 10 })
    const first = seeded.candidates[0]
    if (!first) throw new Error("no candidate")

    await processCandidateJob(
      { tenantId, runId: seeded.id, candidateId: first.id },
      localJobMeta("cand:1"),
    )
    // 33 tokens recorded, ceiling is 10 — every later leg must decline.
    for (const candidate of seeded.candidates.slice(1)) {
      await processCandidateJob(
        { tenantId, runId: seeded.id, candidateId: candidate.id },
        localJobMeta(`cand:${candidate.id}`),
      )
    }

    const run = await getRun(tenantId, seeded.id)
    expect(run?.candidates[0]?.status).toBe("OK")
    expect(run?.candidates.slice(1).every((c) => c.status === "SKIPPED")).toBe(true)
    expect(run?.candidates[1]?.error).toContain("token ceiling")
    expect(calls).toHaveLength(1)

    await deleteRun(tenantId, seeded.id)
  })
})

describe("provider resilience", () => {
  test("a rate-limited provider retries while attempts remain, then settles", async () => {
    behaviours.openai = "rate-limited"
    const seeded = await seedRun({ providers: ["openai"] })
    const candidateId = seeded.candidates[0]?.id
    if (candidateId === undefined) throw new Error("no candidate")

    const job = { tenantId, runId: seeded.id, candidateId }

    // Not the final attempt: a 429 is handed back to the queue's backoff.
    await expect(
      processCandidateJob(job, { id: "c", attempt: 1, maxAttempts: 3, isFinalAttempt: false }),
    ).rejects.toThrow("rate limited")

    // Final attempt: the outcome is recorded while a processor is still alive.
    await processCandidateJob(job, { id: "c", attempt: 3, maxAttempts: 3, isFinalAttempt: true })

    const run = await getRun(tenantId, seeded.id)
    expect(run?.candidates[0]?.status).toBe("ERROR")
    expect(run?.candidates[0]?.error).toContain("attempt 3 of 3")
    expect(run?.candidates[0]?.attempts).toBe(2)

    await deleteRun(tenantId, seeded.id)
  })

  test("an open breaker skips the provider instead of calling it", async () => {
    const breaker = new MemoryBreakerStore()
    setBreakerStore(breaker)
    // Trip it: the threshold is BREAKER_FAILURE_THRESHOLD consecutive failures.
    for (let i = 0; i < 10; i++) await breaker.recordFailure("openai", 60_000)

    const seeded = await seedRun({ providers: ["openai"] })
    await runFlow(seeded.id)

    expect(calls).toHaveLength(0)
    const run = await getRun(tenantId, seeded.id)
    expect(run?.candidates[0]?.status).toBe("SKIPPED")
    expect(run?.candidates[0]?.error).toContain("failing repeatedly")

    await deleteRun(tenantId, seeded.id)
  })
})
