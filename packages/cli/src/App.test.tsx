import { afterEach, expect, mock, test } from "bun:test"
import type { AskInput, Run } from "@sce/shared"
import type { StreamedEvent } from "./api.ts"

/**
 * Renders the real TUI against a stubbed backend, so the layout, the event
 * reducer and the tab wiring are all exercised headlessly.
 */

const COMPLETED_RUN: Run = {
  id: "run_1",
  prompt: "Why is the sky blue?",
  status: "COMPLETE",
  error: null,
  totalLatencyMs: 4200,
  temperature: null,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  deadlineAt: null,
  canceledAt: null,
  candidates: [
    {
      id: "c1",
      provider: "openai",
      label: "OpenAI",
      model: "gpt-5.5",
      status: "OK",
      content: "Rayleigh scattering favours short wavelengths.",
      error: null,
      latencyMs: 1400,
      inputTokens: 20,
      outputTokens: 90,
      attempts: 1,
    },
    {
      id: "c2",
      provider: "anthropic",
      label: "Claude",
      model: "claude-sonnet-5",
      status: "OK",
      content: "Shorter wavelengths scatter more strongly in the atmosphere.",
      error: null,
      latencyMs: 1800,
      inputTokens: 20,
      outputTokens: 110,
      attempts: 1,
    },
    {
      id: "c3",
      provider: "google",
      label: "Gemini",
      model: "gemini-3.7-flash",
      status: "ERROR",
      content: null,
      error: "HTTP 429: rate limited",
      latencyMs: 300,
      inputTokens: null,
      outputTokens: null,
      attempts: 3,
    },
  ],
  synthesis: {
    id: "s1",
    model: "claude-opus-5",
    finalAnswer: "# Blue skies\n\nSunlight scatters off air molecules, and short wavelengths win.",
    agreements: ["Scattering explains the colour"],
    disagreements: ["Only one named Rayleigh scattering"],
    reviews: [
      { provider: "openai", score: 8, strengths: ["names the mechanism"], weaknesses: ["terse"] },
      { provider: "anthropic", score: 9, strengths: ["precise"], weaknesses: [] },
    ],
    confidence: 0.92,
    latencyMs: 2000,
    inputTokens: 500,
    outputTokens: 300,
  },
}

const CANDIDATES = COMPLETED_RUN.candidates
const SYNTHESIS = COMPLETED_RUN.synthesis!

const PROVIDERS = {
  panel: [
    {
      id: "openai",
      label: "OpenAI",
      model: "gpt-5.5",
      color: "#10a37f",
      available: true,
      route: "direct",
      hint: null,
    },
    {
      id: "anthropic",
      label: "Claude",
      model: "claude-sonnet-5",
      color: "#d97757",
      available: true,
      route: "direct",
      hint: null,
    },
    {
      id: "google",
      label: "Gemini",
      model: "gemini-3.7-flash",
      color: "#4285f4",
      available: true,
      route: "direct",
      hint: null,
    },
  ],
  evaluator: {
    id: "anthropic",
    label: "Claude",
    model: "claude-opus-5",
    color: "#d97757",
    available: true,
    route: "direct",
    hint: null,
  },
}

/**
 * The stream the stub serves.
 *
 * Written as `{ event, seq }` frames because that is what the real client now
 * yields: durable events carry the sequence number the TUI resumes from, and
 * the ephemeral delta carries `null`. Exercising both here is what keeps the
 * reducer's cursor handling honest.
 */
const STREAM: StreamedEvent[] = [
  {
    seq: 1,
    event: { type: "run.snapshot", run: { ...COMPLETED_RUN, status: "PENDING", synthesis: null } },
  },
  { seq: 2, event: { type: "run.status", runId: "run_1", status: "FANNING_OUT" } },
  { seq: 3, event: { type: "candidate.started", runId: "run_1", candidateId: "c1" } },
  { seq: null, event: { type: "candidate.delta", runId: "run_1", candidateId: "c1", text: "Ray" } },
  { seq: 4, event: { type: "candidate.settled", runId: "run_1", candidate: CANDIDATES[0]! } },
  { seq: 5, event: { type: "candidate.settled", runId: "run_1", candidate: CANDIDATES[1]! } },
  { seq: 6, event: { type: "candidate.settled", runId: "run_1", candidate: CANDIDATES[2]! } },
  { seq: 7, event: { type: "synthesis.settled", runId: "run_1", synthesis: SYNTHESIS } },
  { seq: 8, event: { type: "run.completed", runId: "run_1", totalLatencyMs: 4200 } },
]

mock.module("./api.ts", () => ({
  serverUrl: "http://localhost:8787",
  fetchProviders: async () => PROVIDERS,
  createRun: async (_input: AskInput) => ({ ...COMPLETED_RUN, status: "PENDING", synthesis: null }),
  fetchRun: async () => COMPLETED_RUN,
  fetchHistory: async () => [],
  removeRun: async () => {},
  cancelRun: async () => COMPLETED_RUN,
  streamRun: async function* (
    _id: string,
    _signal: AbortSignal,
    afterSeq = 0,
  ): AsyncGenerator<StreamedEvent> {
    // Honour the cursor, so a resumed follow behaves the way the server does.
    for (const frame of STREAM) {
      if (frame.seq !== null && frame.seq <= afterSeq) continue
      yield frame
    }
  },
}))

const { testRender } = await import("@opentui/react/test-utils")
const { App } = await import("./App.tsx")

let setup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(() => {
  setup?.renderer.destroy()
  setup = null
})

async function settle(times = 12) {
  for (let i = 0; i < times; i++) {
    await setup!.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function press(name: string, sequence: string) {
  // KeyEvent carries a lot of terminal bookkeeping the handlers never read.
  setup!.renderer.keyInput.emit("keypress", {
    name,
    sequence,
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    eventType: "press",
    repeated: false,
  } as never)
}

test("idle screen explains the technique and shows the panel", async () => {
  setup = await testRender(<App />, { width: 120, height: 40 })
  await settle()

  const frame = setup.captureCharFrame()
  expect(frame).toContain("Self-Consistency Answer Engine")
  expect(frame).toContain("OpenAI")
  expect(frame).toContain("Claude")
  expect(frame).toContain("Gemini")
  expect(frame).toContain("Final Answer")
  expect(frame).toContain("Analysis")
})

test("a run streams to completion and renders the merged answer", async () => {
  setup = await testRender(<App initialPrompt="Why is the sky blue?" />, { width: 120, height: 40 })
  await settle(20)

  const frame = setup.captureCharFrame()
  // The final-answer tab is selected by default.
  expect(frame).toContain("Blue skies")
  expect(frame).toContain("short wavelengths win")
  // Panel rows show per-model outcome, including the failure.
  expect(frame).toContain("gpt-5.5")
  expect(frame).toContain("rate limited")
  expect(frame).toContain("confidence 92%")
})

test("right arrow switches to the evaluator analysis tab", async () => {
  setup = await testRender(<App initialPrompt="Why is the sky blue?" />, { width: 120, height: 40 })
  await settle(20)

  press("right", "OC")
  await settle(4)

  const frame = setup.captureCharFrame()
  expect(frame).toContain("Where the models agreed")
  expect(frame).toContain("Scorecard")
  expect(frame).toContain("9.0/10")
})
