import { describe, expect, test } from "bun:test"
import type { Candidate, Run, StreamedRunEvent, Synthesis } from "@sce/shared"
import {
  applyRunEvent,
  endsStream,
  initialRunStreamState,
  reconnectDelayMs,
} from "./run-stream"

/**
 * The run reducer.
 *
 * This is the part of the live view with genuinely interesting behaviour —
 * replay after a reconnect, ephemeral deltas that must not outlive the settled
 * body, a cursor that only moves forward — and it is a pure function precisely
 * so all of it can be checked without a browser, a network or a running API.
 *
 * Each test below corresponds to a way the UI could silently show the wrong
 * answer, which is worse than showing an error.
 */

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand_1",
    provider: "openai",
    label: "OpenAI",
    model: "gpt-5.5",
    status: "PENDING",
    content: null,
    error: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    attempts: 0,
    ...overrides,
  }
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    createdByUserId: "user_1",
    prompt: "Why is the sky blue?",
    status: "FANNING_OUT",
    error: null,
    totalLatencyMs: null,
    temperature: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    deadlineAt: null,
    canceledAt: null,
    tags: [],
    candidates: [candidate()],
    synthesis: null,
    ...overrides,
  }
}

const synthesis: Synthesis = {
  id: "syn_1",
  model: "claude-opus-5",
  finalAnswer: "Rayleigh scattering.",
  agreements: ["Shorter wavelengths scatter more."],
  disagreements: [],
  reviews: [],
  confidence: 0.9,
  latencyMs: 1200,
  inputTokens: 900,
  outputTokens: 120,
}

function frame(event: StreamedRunEvent["event"], seq: number | null): StreamedRunEvent {
  return { event, seq }
}

describe("cursor", () => {
  test("a durable event advances the resume cursor", () => {
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.status", runId: "run_1", status: "FANNING_OUT" }, 4),
    )
    expect(state.cursor).toBe(4)
  })

  test("an ephemeral delta does not move the cursor", () => {
    // A delta was never written to the durable log, so it has no position in
    // it. Resuming from one would ask the server for a sequence that does not
    // exist — and the server would replay from the wrong place.
    let state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.status", runId: "run_1", status: "FANNING_OUT" }, 7),
    )
    state = applyRunEvent(
      state,
      frame({ type: "candidate.delta", runId: "run_1", candidateId: "cand_1", text: "Ray" }, null),
    )
    expect(state.cursor).toBe(7)
  })

  test("the cursor never moves backwards", () => {
    // After a reconnect the server replays from the cursor, so events already
    // applied arrive again. Taking the newest seq blindly would rewind.
    let state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.status", runId: "run_1", status: "SYNTHESIZING" }, 9),
    )
    state = applyRunEvent(
      state,
      frame({ type: "run.status", runId: "run_1", status: "FANNING_OUT" }, 3),
    )
    expect(state.cursor).toBe(9)
  })
})

describe("token deltas", () => {
  test("deltas accumulate while a candidate is running", () => {
    let state = initialRunStreamState(run())
    for (const text of ["Ray", "leigh ", "scattering."]) {
      state = applyRunEvent(
        state,
        frame({ type: "candidate.delta", runId: "run_1", candidateId: "cand_1", text }, null),
      )
    }
    expect(state.streaming["cand_1"]).toBe("Rayleigh scattering.")
  })

  test("settling clears the partial buffer and installs the full body", () => {
    // The settled body is the truth; the accumulated deltas are decoration. A
    // client that kept showing the buffer would display a truncated answer
    // whenever it had missed a delta.
    let state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "candidate.delta", runId: "run_1", candidateId: "cand_1", text: "Ray" }, null),
    )
    state = applyRunEvent(
      state,
      frame(
        {
          type: "candidate.settled",
          runId: "run_1",
          candidate: candidate({ status: "OK", content: "Rayleigh scattering, in full." }),
        },
        2,
      ),
    )

    expect(state.streaming["cand_1"]).toBeUndefined()
    expect(state.run.candidates[0]?.content).toBe("Rayleigh scattering, in full.")
  })

  test("a late delta for a settled candidate is discarded", () => {
    // The live tail can deliver a delta the settled body already contains.
    // Appending it would duplicate a paragraph on screen.
    let state = applyRunEvent(
      initialRunStreamState(run()),
      frame(
        {
          type: "candidate.settled",
          runId: "run_1",
          candidate: candidate({ status: "OK", content: "Complete answer." }),
        },
        2,
      ),
    )
    state = applyRunEvent(
      state,
      frame({ type: "candidate.delta", runId: "run_1", candidateId: "cand_1", text: " and more" }, null),
    )

    expect(state.streaming["cand_1"]).toBeUndefined()
    expect(state.run.candidates[0]?.content).toBe("Complete answer.")
  })
})

describe("replay", () => {
  test("applying the same event twice is indistinguishable from once", () => {
    const settled = frame(
      {
        type: "candidate.settled",
        runId: "run_1",
        candidate: candidate({ status: "OK", content: "Answer." }),
      },
      2,
    )

    const once = applyRunEvent(initialRunStreamState(run()), settled)
    const twice = applyRunEvent(once, settled)

    expect(twice.run.candidates).toHaveLength(1)
    expect(twice).toEqual(once)
  })

  test("a snapshot replaces whatever was rendered before it", () => {
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.snapshot", run: run({ status: "SYNTHESIZING", tags: ["infra"] }) }, 1),
    )
    expect(state.run.status).toBe("SYNTHESIZING")
    expect(state.run.tags).toEqual(["infra"])
  })

  test("a candidate the client has not seen is added rather than dropped", () => {
    // A client that subscribed mid-run receives settled candidates it never saw
    // start. Matching only on existing ids would lose them entirely.
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame(
        {
          type: "candidate.settled",
          runId: "run_1",
          candidate: candidate({ id: "cand_2", provider: "google", status: "OK", content: "Also." }),
        },
        3,
      ),
    )
    expect(state.run.candidates).toHaveLength(2)
  })
})

describe("terminal events", () => {
  test("completion closes the stream and stamps the run", () => {
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.completed", runId: "run_1", totalLatencyMs: 4200 }, 12),
    )
    expect(state.connection).toBe("closed")
    expect(state.run.status).toBe("COMPLETE")
    expect(state.run.totalLatencyMs).toBe(4200)
  })

  test("failure surfaces the reason on the run and in the error slot", () => {
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "run.failed", runId: "run_1", error: "Every provider refused" }, 12),
    )
    expect(state.error).toBe("Every provider refused")
    expect(state.run.error).toBe("Every provider refused")
    expect(state.run.status).toBe("FAILED")
  })

  test("synthesis settles onto the run", () => {
    const state = applyRunEvent(
      initialRunStreamState(run()),
      frame({ type: "synthesis.settled", runId: "run_1", synthesis }, 11),
    )
    expect(state.run.synthesis?.finalAnswer).toBe("Rayleigh scattering.")
  })

  test("a finished run opens no connection at all", () => {
    expect(initialRunStreamState(run({ status: "COMPLETE" })).connection).toBe("closed")
    expect(initialRunStreamState(run({ status: "FANNING_OUT" })).connection).toBe("idle")
  })

  test("endsStream agrees with the terminal variants", () => {
    expect(endsStream({ type: "run.completed", runId: "r", totalLatencyMs: 1 })).toBe(true)
    expect(endsStream({ type: "run.failed", runId: "r", error: "x" })).toBe(true)
    expect(endsStream({ type: "run.canceled", runId: "r", reason: "x" })).toBe(true)
    expect(endsStream({ type: "run.status", runId: "r", status: "QUEUED" })).toBe(false)
  })
})

describe("reconnect backoff", () => {
  test("grows exponentially and is capped", () => {
    const worst = () => 1
    expect(reconnectDelayMs(0, worst)).toBeLessThanOrEqual(500)
    expect(reconnectDelayMs(3, worst)).toBeLessThanOrEqual(4000)
    expect(reconnectDelayMs(50, worst)).toBeLessThanOrEqual(30_000)
  })

  test("is jittered, so a deploy does not bring every tab back at once", () => {
    // Full jitter: the delay spans [ceiling/2, ceiling]. Without it, a rolling
    // restart drops every open stream at the same instant and they all return
    // in one synchronised wave.
    const low = reconnectDelayMs(4, () => 0)
    const high = reconnectDelayMs(4, () => 1)
    expect(low).toBeLessThan(high)
    expect(low).toBeGreaterThanOrEqual(Math.floor(high / 2))
  })
})
