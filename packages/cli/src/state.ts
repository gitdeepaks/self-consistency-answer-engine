import { assertNever, type Candidate, type Run, type RunEvent } from "@sce/shared"

export type Phase = "idle" | "starting" | "running" | "done" | "failed"

export interface EngineState {
  run: Run | null
  phase: Phase
  /** One-line description of what the engine is doing right now. */
  stage: string
  error: string | null
  /**
   * Text streamed for each candidate that has not settled yet, keyed by
   * candidate id.
   *
   * Kept beside the run rather than written into `candidate.content`, because
   * a partial answer is not an answer: the settled row is the source of truth,
   * and merging the two would make "still generating" indistinguishable from
   * "finished and short".
   */
  streaming: Record<string, string>
}

export const initialState: EngineState = {
  run: null,
  phase: "idle",
  stage: "Ready",
  error: null,
  streaming: {},
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
  const settled = run.candidates.filter(
    (c) => c.status === "OK" || c.status === "ERROR" || c.status === "CANCELED",
  ).length
  const total = run.candidates.filter((c) => c.status !== "SKIPPED").length

  switch (run.status) {
    case "PENDING":
      return "Queued"
    case "QUEUED":
      return "Waiting for a worker"
    case "FANNING_OUT":
      return `Querying the panel — ${settled}/${total} answered`
    case "SYNTHESIZING":
      return "Evaluator is comparing the answers"
    case "COMPLETE":
      return "Final answer ready"
    case "FAILED":
      return "Run failed"
    case "CANCELED":
      return "Run canceled"
    default:
      return assertNever(run.status, "stageForRun")
  }
}

export function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case "reset":
      return initialState

    case "starting":
      return { run: null, phase: "starting", stage: "Starting run", error: null, streaming: {} }

    case "loaded": {
      const phase: Phase =
        action.run.status === "COMPLETE"
          ? "done"
          : action.run.status === "FAILED" || action.run.status === "CANCELED"
            ? "failed"
            : "running"
      return {
        run: action.run,
        phase,
        stage: stageForRun(action.run),
        error: action.run.error,
        streaming: {},
      }
    }

    case "error":
      return { ...state, phase: "failed", stage: "Error", error: action.message }

    case "event": {
      const event = action.event

      if (event.type === "run.snapshot") {
        return {
          run: event.run,
          phase: "running",
          stage: stageForRun(event.run),
          error: null,
          streaming: {},
        }
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
          return {
            ...state,
            run: next,
            stage: stageForRun(next),
            streaming: { ...state.streaming, [event.candidateId]: "" },
          }
        }
        case "candidate.delta": {
          const before = state.streaming[event.candidateId] ?? ""
          return {
            ...state,
            streaming: { ...state.streaming, [event.candidateId]: before + event.text },
          }
        }
        case "candidate.settled": {
          const next = patchCandidate(run, event.candidate.id, event.candidate)
          // The settled row carries the full text, so the buffer has done its job.
          const { [event.candidate.id]: _settled, ...streaming } = state.streaming
          return { ...state, run: next, stage: stageForRun(next), streaming }
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
          return { run: next, phase: "done", stage: stageForRun(next), error: null, streaming: {} }
        }
        case "run.failed": {
          const next: Run = { ...run, status: "FAILED", error: event.error }
          return {
            run: next,
            phase: "failed",
            stage: "Run failed",
            error: event.error,
            streaming: {},
          }
        }
        case "run.canceled": {
          const next: Run = {
            ...run,
            status: "CANCELED",
            error: event.reason,
            canceledAt: new Date().toISOString(),
          }
          return {
            run: next,
            phase: "failed",
            stage: "Run canceled",
            error: event.reason,
            streaming: {},
          }
        }
        default:
          return assertNever(event, "engineReducer")
      }
    }

    default:
      return assertNever(action, "engineReducer")
  }
}
