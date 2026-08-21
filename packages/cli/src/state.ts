import type { Candidate, Run, RunEvent } from "@sce/shared"

export type Phase = "idle" | "starting" | "running" | "done" | "failed"

export interface EngineState {
  run: Run | null
  phase: Phase
  /** One-line description of what the engine is doing right now. */
  stage: string
  error: string | null
}

export const initialState: EngineState = {
  run: null,
  phase: "idle",
  stage: "Ready",
  error: null,
}

export type EngineAction =
  | { type: "reset" }
  | { type: "starting"; prompt: string }
  | { type: "event"; event: RunEvent }
  | { type: "loaded"; run: Run }
  | { type: "error"; message: string }

function patchCandidate(run: Run, id: string, patch: Partial<Candidate>): Run {
  return {
    ...run,
    candidates: run.candidates.map((candidate) =>
      candidate.id === id ? { ...candidate, ...patch } : candidate,
    ),
  }
}

function stageForRun(run: Run): string {
  const done = run.candidates.filter((c) => c.status === "OK" || c.status === "ERROR").length
  const total = run.candidates.filter((c) => c.status !== "SKIPPED").length
  switch (run.status) {
    case "PENDING":
      return "Queued"
    case "FANNING_OUT":
      return `Querying the panel — ${done}/${total} answered`
    case "SYNTHESIZING":
      return "Evaluator is comparing the answers"
    case "COMPLETE":
      return "Final answer ready"
    case "FAILED":
      return "Run failed"
  }
}

export function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case "reset":
      return initialState

    case "starting":
      return { run: null, phase: "starting", stage: "Starting run", error: null }

    case "loaded": {
      const phase: Phase =
        action.run.status === "COMPLETE"
          ? "done"
          : action.run.status === "FAILED"
            ? "failed"
            : "running"
      return {
        run: action.run,
        phase,
        stage: stageForRun(action.run),
        error: action.run.error,
      }
    }

    case "error":
      return { ...state, phase: "failed", stage: "Error", error: action.message }

    case "event": {
      const event = action.event

      if (event.type === "run.snapshot") {
        return { run: event.run, phase: "running", stage: stageForRun(event.run), error: null }
      }

      const run = state.run
      if (!run || ("runId" in event && event.runId !== run.id)) return state

      switch (event.type) {
        case "run.status": {
          const next = { ...run, status: event.status }
          return { ...state, run: next, stage: stageForRun(next) }
        }
        case "candidate.started": {
          const next = patchCandidate(run, event.candidateId, { status: "RUNNING" })
          return { ...state, run: next, stage: stageForRun(next) }
        }
        case "candidate.settled": {
          const next = patchCandidate(run, event.candidate.id, event.candidate)
          return { ...state, run: next, stage: stageForRun(next) }
        }
        case "synthesis.started":
          return { ...state, stage: `Evaluator (${event.model}) is comparing the answers` }
        case "synthesis.settled":
          return { ...state, run: { ...run, synthesis: event.synthesis } }
        case "run.completed": {
          const next: Run = {
            ...run,
            status: "COMPLETE",
            totalLatencyMs: event.totalLatencyMs,
            completedAt: new Date().toISOString(),
          }
          return { run: next, phase: "done", stage: stageForRun(next), error: null }
        }
        case "run.failed": {
          const next: Run = { ...run, status: "FAILED", error: event.error }
          return { run: next, phase: "failed", stage: "Run failed", error: event.error }
        }
      }
    }
  }
}
