import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { runEventSchema, runSchema, runSummarySchema, usageTotalsSchema } from "@sce/shared"
import type { ProviderId, Run, RunEvent } from "@sce/shared"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"

/**
 * The HTTP surface: routing, validation, idempotency, cancellation and SSE.
 *
 * The API no longer runs a model — Phase 2 moved that behind the queue — so
 * these tests wire the in-process transport and the real worker processors
 * behind it. That combination is the honest one to test against: the request
 * path is exactly production's (validate → persist → enqueue → 201), and what
 * happens on the other side of the enqueue is the same code a real worker runs.
 */

const PANEL: readonly ProviderId[] = ["openai", "anthropic", "google"]

const SPECS: Record<ProviderId, { id: ProviderId; label: string; color: string }> = {
  openai: { id: "openai", label: "OpenAI", color: "#10a37f" },
  anthropic: { id: "anthropic", label: "Claude", color: "#d97757" },
  google: { id: "google", label: "Gemini", color: "#4285f4" },
}

const SYNTHESIS = {
  agreements: ["they agreed"],
  disagreements: [],
  reviews: [
    { provider: "openai", score: 8, strengths: [], weaknesses: [] },
    { provider: "anthropic", score: 9, strengths: [], weaknesses: [] },
    { provider: "google", score: 7, strengths: [], weaknesses: [] },
  ],
  finalAnswer: "The merged answer.",
  confidence: 0.9,
}

const USAGE = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
} as const

/** A model whose answer arrives as a stream, the way candidates now run. */
function streamingModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "0" })
          controller.enqueue({ type: "text-delta", id: "0", delta: text })
          controller.enqueue({ type: "text-end", id: "0" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: USAGE,
          })
          controller.close()
        },
      }),
    }),
  })
}

/** The evaluator still answers in one shot: it produces structured output. */
function blockingModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  })
}

/**
 * Response envelopes, parsed rather than asserted.
 *
 * A test that casts `await res.json()` into the shape it expects cannot fail
 * when the server stops returning that shape — which is the single most useful
 * thing an HTTP test could tell you. Parsing makes the response schema part of
 * what is under test.
 */
const runEnvelope = z.object({ run: runSchema })
const cancelEnvelope = z.object({ run: runSchema, canceled: z.boolean() })
const historyEnvelope = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})
const providersEnvelope = z.object({
  panel: z.array(z.object({ id: z.string() })),
  evaluator: z.object({ role: z.string(), model: z.string() }),
})
const usageEnvelope = z.object({ usage: usageTotalsSchema })

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json())
}

/** An SSE response always has a body; failing loudly beats a non-null claim. */
function streamBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error(`expected a response body, got HTTP ${response.status}`)
  return response.body
}

const resolved = (id: ProviderId) => ({
  spec: SPECS[id],
  modelId: `mock-${id}`,
  route: "direct" as const,
  model: streamingModel(`Answer from ${id}`),
  hint: null,
})

// The worker's provider factory, mocked by its resolved path so that the
// processors the queue invokes get mock models rather than real credentials.
mock.module("../../worker/src/providers.ts", () => ({
  resolveProvider: resolved,
  resolvePanel: (only?: ProviderId[]) => (only ?? PANEL).map(resolved),
  resolveEvaluator: () => ({
    spec: SPECS.anthropic,
    modelId: "mock-evaluator",
    route: "direct" as const,
    model: blockingModel(JSON.stringify(SYNTHESIS)),
    hint: null,
  }),
}))

const {
  LocalCancellationBus,
  LocalRunBus,
  LocalRunQueue,
  setCancellationBus,
  setLocalRunJobHandlers,
  setRunBus,
  setRunQueue,
} = await import("@sce/queue")
const { runJobHandlers } = await import("../../worker/src/handlers.ts")
const { MemoryBreakerStore, setBreakerStore } = await import("../../worker/src/resilience.ts")

const localQueue = new LocalRunQueue()

beforeAll(() => {
  setRunBus(new LocalRunBus())
  setCancellationBus(new LocalCancellationBus())
  setBreakerStore(new MemoryBreakerStore())
  setLocalRunJobHandlers(runJobHandlers)
  setRunQueue(localQueue)
})

const { app } = await import("./app.ts")
const { defaultTenant, deleteRun } = await import("@sce/db")

// The HTTP surface resolves the default tenant per request, so cleanup has to
// scope itself the same way.
const tenantId = (await defaultTenant()).id

const created: string[] = []

afterAll(async () => {
  // Wait for anything still executing before tearing down its rows.
  await localQueue.close()
  for (const id of created) await deleteRun(tenantId, id).catch(() => {})
  setLocalRunJobHandlers(null)
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  })
}

async function startRun(
  prompt: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await post("/api/runs", { prompt, ...extra }, headers)
  expect(res.status).toBe(201)
  const { run } = await readJson(res, runEnvelope)
  created.push(run.id)
  return run
}

/** Read an SSE body to completion, returning the decoded events and their ids. */
async function readStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ events: RunEvent[]; ids: (string | null)[] }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: RunEvent[] = []
  const ids: (string | null)[] = []
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf("\n\n")

      const lines = frame.split("\n")
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue

      // Parsed with the real union, not narrowed by a hand-written guard: a
      // keep-alive ping and an event this build does not know about are both
      // simply not run events, and the schema is what decides that.
      const parsed = runEventSchema.safeParse(JSON.parse(data))
      if (parsed.success) {
        events.push(parsed.data)
        ids.push(lines.find((line) => line.startsWith("id:"))?.slice(3).trim() ?? null)
      }
    }
  }
  return { events, ids }
}

async function readEvents(body: ReadableStream<Uint8Array>): Promise<RunEvent[]> {
  return (await readStream(body)).events
}

describe("http api", () => {
  test("GET /api/health", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, role: "api" })
  })

  test("GET /api/providers lists the panel and the evaluator", async () => {
    const res = await app.request("/api/providers")
    const providers = await readJson(res, providersEnvelope)
    expect(providers.panel.map((p) => p.id)).toEqual(["openai", "anthropic", "google"])
    expect(providers.evaluator.role).toBe("evaluator")
  })

  test("POST /api/runs rejects a too-short prompt", async () => {
    expect((await post("/api/runs", { prompt: "hi" })).status).toBe(400)
  })

  test("POST /api/runs returns immediately with seeded candidates", async () => {
    const run = await startRun("What is a monad, briefly?")
    expect(run.candidates).toHaveLength(3)
    expect(run.synthesis).toBeNull()
    // The API's job ends at enqueue; nothing has called a model yet.
    expect(["PENDING", "QUEUED"]).toContain(run.status)
    expect(run.deadlineAt).not.toBeNull()
  })

  test("SSE replays the full timeline and ends on run.completed", async () => {
    const run = await startRun("Explain event sourcing")

    const res = await app.request(`/api/runs/${run.id}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const { events, ids } = await readStream(streamBody(res))
    const types = events.map((event) => event.type)

    expect(types[0]).toBe("run.snapshot")
    expect(types).toContain("candidate.settled")
    expect(types).toContain("synthesis.settled")
    expect(types.at(-1)).toBe("run.completed")
    // Three panel members, each settling exactly once.
    expect(types.filter((t) => t === "candidate.settled")).toHaveLength(3)

    // Durable events carry their sequence number as the SSE id, which is what
    // makes `Last-Event-ID` a resume cursor. Deltas carry none.
    const durable = events
      .map((event, index) => ({ event, id: ids[index] }))
      .filter((entry) => entry.event.type !== "candidate.delta")
    expect(durable.every((entry) => entry.id !== null)).toBe(true)
    expect(
      events
        .map((event, index) => ({ event, id: ids[index] }))
        .filter((entry) => entry.event.type === "candidate.delta")
        .every((entry) => entry.id === null),
    ).toBe(true)
  })

  test("SSE resumes from Last-Event-ID without repeating what was seen", async () => {
    const run = await startRun("Resume me")
    const { ids } = await readStream(
      streamBody(await app.request(`/api/runs/${run.id}/events`)),
    )

    const lastId = ids.filter((id): id is string => id !== null).at(-1)
    expect(lastId).toBeDefined()

    // Everything is already delivered, so resuming from the tail yields only
    // the synthetic closing frames — never a replay of the whole timeline.
    const res = await app.request(`/api/runs/${run.id}/events`, {
      headers: { "last-event-id": lastId ?? "0" },
    })
    const events = await readEvents(streamBody(res))
    expect(events.map((event) => event.type)).toEqual(["run.snapshot", "run.completed"])
  })

  test("an Idempotency-Key makes a retried POST return the same run", async () => {
    const key = `test-idem-${Date.now()}`
    const first = await startRun("Only fan out once", {}, { "Idempotency-Key": key })

    const res = await post("/api/runs", { prompt: "Only fan out once" }, { "Idempotency-Key": key })
    // 200, not 201: nothing was created, so nothing was charged for a second time.
    expect(res.status).toBe(200)
    const { run } = await readJson(res, runEnvelope)
    expect(run.id).toBe(first.id)
  })

  test("a malformed Idempotency-Key is rejected rather than stored", async () => {
    const res = await post("/api/runs", { prompt: "Bad key please" }, { "Idempotency-Key": "no" })
    expect(res.status).toBe(400)
  })

  test("POST /api/runs/:id/cancel stops a run and reports it", async () => {
    const run = await startRun("Cancel me")

    const res = await post(`/api/runs/${run.id}/cancel`, { reason: "changed my mind" })
    expect(res.status).toBe(200)
    const outcome = await readJson(res, cancelEnvelope)
    // The run may already have completed — the local queue is fast — but either
    // way the API answers honestly about which of the two happened.
    expect(typeof outcome.canceled).toBe("boolean")
    expect(outcome.canceled ? "CANCELED" : "COMPLETE").toBe(outcome.run.status)
  })

  test("cancelling an unknown run is a 404", async () => {
    expect((await post("/api/runs/nope/cancel", {})).status).toBe(404)
  })

  test("GET /api/runs/:id returns the persisted run once finished", async () => {
    const run = await startRun("Summarise CAP theorem")
    await readEvents(streamBody(await app.request(`/api/runs/${run.id}/events`)))

    const res = await app.request(`/api/runs/${run.id}`)
    const { run: stored } = await readJson(res, runEnvelope)
    expect(stored.status).toBe("COMPLETE")
    expect(stored.synthesis?.finalAnswer).toBe("The merged answer.")
    expect(stored.candidates.every((c) => c.status === "OK")).toBe(true)
  })

  test("GET /api/runs paginates history newest-first", async () => {
    const res = await app.request("/api/runs?limit=2")
    const history = await readJson(res, historyEnvelope)
    expect(history.items.length).toBeLessThanOrEqual(2)
    expect(history).toHaveProperty("nextCursor")
  })

  test("GET /api/usage reports metered spend for the tenant", async () => {
    const res = await app.request("/api/usage")
    expect(res.status).toBe(200)
    const { usage } = await readJson(res, usageEnvelope)
    expect(usage.calls).toBeGreaterThan(0)
  })

  test("unknown run ids 404 on read, stream and delete", async () => {
    expect((await app.request("/api/runs/nope")).status).toBe(404)
    expect((await app.request("/api/runs/nope/events")).status).toBe(404)
    expect((await app.request("/api/runs/nope", { method: "DELETE" })).status).toBe(404)
  })

  test("DELETE /api/runs/:id removes the run", async () => {
    const run = await startRun("Something disposable")
    await readEvents(streamBody(await app.request(`/api/runs/${run.id}/events`)))

    expect((await app.request(`/api/runs/${run.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await app.request(`/api/runs/${run.id}`)).status).toBe(404)
  })

  test("unknown paths return a JSON 404", async () => {
    const res = await app.request("/api/nope")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "Not found" })
  })
})
