import { afterEach, expect, mock, test } from "bun:test"
import type { AskInput, Run, RunEvent } from "@sce/shared"

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
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
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

mock.module("./api.ts", () => ({
  serverUrl: "http://localhost:8787",
  fetchProviders: async () => PROVIDERS,
  createRun: async (_input: AskInput) => ({ ...COMPLETED_RUN, status: "PENDING", synthesis: null }),
  fetchRun: async () => COMPLETED_RUN,
  fetchHistory: async () => [],
  removeRun: async () => {},
  streamRun: async function* (): AsyncGenerator<RunEvent> {
    yield { type: "run.snapshot", run: { ...COMPLETED_RUN, status: "PENDING", synthesis: null } }
    yield { type: "run.status", runId: "run_1", status: "FANNING_OUT" }
    yield { type: "candidate.settled", runId: "run_1", candidate: COMPLETED_RUN.candidates[0]! }
    yield { type: "candidate.settled", runId: "run_1", candidate: COMPLETED_RUN.candidates[1]! }
    yield { type: "candidate.settled", runId: "run_1", candidate: COMPLETED_RUN.candidates[2]! }
    yield { type: "synthesis.settled", runId: "run_1", synthesis: COMPLETED_RUN.synthesis! }
    yield { type: "run.completed", runId: "run_1", totalLatencyMs: 4200 }
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
