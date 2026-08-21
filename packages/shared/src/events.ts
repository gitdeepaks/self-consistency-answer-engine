import type { Candidate, Run, RunStatus, Synthesis } from "./schemas.ts"

/**
 * Events emitted while a run is in flight. The server buffers these per run
 * and replays them to any SSE subscriber, so a client that connects late (or
 * reconnects) still sees the whole timeline.
 */
export type RunEvent =
  | { type: "run.snapshot"; run: Run }
  | { type: "run.status"; runId: string; status: RunStatus }
  | { type: "candidate.started"; runId: string; candidateId: string }
  | { type: "candidate.settled"; runId: string; candidate: Candidate }
  | { type: "synthesis.started"; runId: string; model: string }
  | { type: "synthesis.settled"; runId: string; synthesis: Synthesis }
  | { type: "run.completed"; runId: string; totalLatencyMs: number }
  | { type: "run.failed"; runId: string; error: string }

export type RunEventType = RunEvent["type"]

export const TERMINAL_EVENTS: RunEventType[] = ["run.completed", "run.failed"]

export function isTerminalEvent(event: RunEvent): boolean {
  return TERMINAL_EVENTS.includes(event.type)
}
