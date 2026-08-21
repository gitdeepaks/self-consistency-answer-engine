import { afterAll, describe, expect, mock, test } from "bun:test"
import type { ProviderId, Run, RunEvent } from "@sce/shared"
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

/** HTTP-surface tests: routing, validation, SSE framing, persistence. */

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

function model(text: string) {
  const result: LanguageModelV4GenerateResult = {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 7, reasoning: 0 },
    },
    warnings: [],
  }
  return new MockLanguageModelV4({ doGenerate: async () => result })
}

const resolved = (id: ProviderId) => ({
  spec: SPECS[id],
  modelId: `mock-${id}`,
  route: "direct" as const,
  model: model(`Answer from ${id}`),
  hint: null,
})

mock.module("./providers.ts", () => ({
  resolveProvider: resolved,
  resolvePanel: (only?: ProviderId[]) =>
    (only ?? (["openai", "anthropic", "google"] as ProviderId[])).map(resolved),
  resolveEvaluator: () => ({
    spec: SPECS.anthropic,
    modelId: "mock-evaluator",
    route: "direct" as const,
    model: model(JSON.stringify(SYNTHESIS)),
    hint: null,
  }),
  toHealth: (r: { spec: { id: ProviderId; label: string; color: string }; modelId: string }) => ({
    id: r.spec.id,
    label: r.spec.label,
    model: r.modelId,
    color: r.spec.color,
    available: true,
    route: "direct",
    hint: null,
  }),
}))

const { app } = await import("./app.ts")
const { deleteRun } = await import("@sce/db")

const created: string[] = []

afterAll(async () => {
  for (const id of created) await deleteRun(id).catch(() => {})
})

async function startRun(prompt: string, extra: Record<string, unknown> = {}) {
  const res = await app.request("/api/runs", {
    method: "POST",
    body: JSON.stringify({ prompt, ...extra }),
    headers: { "Content-Type": "application/json" },
  })
  expect(res.status).toBe(201)
  const { run } = (await res.json()) as { run: Run }
  created.push(run.id)
  return run
}

/** Read an SSE body to completion, returning the decoded events. */
async function readEvents(body: ReadableStream<Uint8Array>): Promise<RunEvent[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const events: RunEvent[] = []
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
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data) events.push(JSON.parse(data) as RunEvent)
    }
  }
  return events
}

describe("http api", () => {
  test("GET /api/health", async () => {
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  test("GET /api/providers lists the panel and the evaluator", async () => {
    const res = await app.request("/api/providers")
    const body = (await res.json()) as {
      panel: { id: string }[]
      evaluator: { role: string; model: string }
    }
    expect(body.panel.map((p) => p.id)).toEqual(["openai", "anthropic", "google"])
    expect(body.evaluator.role).toBe("evaluator")
    expect(body.evaluator.model).toBe("mock-evaluator")
  })

  test("POST /api/runs rejects a too-short prompt", async () => {
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(400)
  })

  test("POST /api/runs returns immediately with seeded candidates", async () => {
    const run = await startRun("What is a monad, briefly?")
    expect(run.candidates).toHaveLength(3)
    expect(run.synthesis).toBeNull()
    expect(["PENDING", "FANNING_OUT"]).toContain(run.status)
  })

  test("SSE replays the full timeline and ends on run.completed", async () => {
    const run = await startRun("Explain event sourcing")

    const res = await app.request(`/api/runs/${run.id}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const events = await readEvents(res.body!)
    const types = events.map((event) => event.type)

    expect(types[0]).toBe("run.snapshot")
    expect(types).toContain("candidate.settled")
    expect(types).toContain("synthesis.settled")
    expect(types.at(-1)).toBe("run.completed")
    // Three panel members, each settling exactly once.
    expect(types.filter((t) => t === "candidate.settled")).toHaveLength(3)
  })

  test("GET /api/runs/:id returns the persisted run once finished", async () => {
    const run = await startRun("Summarise CAP theorem")
    await readEvents((await app.request(`/api/runs/${run.id}/events`)).body!)

    const res = await app.request(`/api/runs/${run.id}`)
    const { run: stored } = (await res.json()) as { run: Run }
    expect(stored.status).toBe("COMPLETE")
    expect(stored.synthesis?.finalAnswer).toBe("The merged answer.")
    expect(stored.candidates.every((c) => c.status === "OK")).toBe(true)
  })

  test("GET /api/runs paginates history newest-first", async () => {
    const res = await app.request("/api/runs?limit=2")
    const body = (await res.json()) as { items: { id: string }[]; nextCursor: string | null }
    expect(body.items.length).toBeLessThanOrEqual(2)
    expect(body).toHaveProperty("nextCursor")
  })

  test("unknown run ids 404 on read, stream and delete", async () => {
    expect((await app.request("/api/runs/nope")).status).toBe(404)
    expect((await app.request("/api/runs/nope/events")).status).toBe(404)
    expect((await app.request("/api/runs/nope", { method: "DELETE" })).status).toBe(404)
  })

  test("DELETE /api/runs/:id removes the run", async () => {
    const run = await startRun("Something disposable")
    await readEvents((await app.request(`/api/runs/${run.id}/events`)).body!)

    expect((await app.request(`/api/runs/${run.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await app.request(`/api/runs/${run.id}`)).status).toBe(404)
  })

  test("unknown paths return a JSON 404", async () => {
    const res = await app.request("/api/nope")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "Not found" })
  })
})
