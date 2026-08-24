import { z } from "zod"
import { candidateSchema, runSchema, runStatusSchema, synthesisSchema } from "./schemas.ts"

/**
 * Events emitted while a run is in flight.
 *
 * Defined as a Zod discriminated union rather than a bare TypeScript union so
 * that the same definition covers both halves: `z.infer` gives the compile-time
 * type, and `.parse()` gives the runtime guarantee needed wherever an event
 * crosses a trust boundary — a `RunEvent` row read back out of Postgres, an SSE
 * frame arriving over the network, or a queue payload.
 */
export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.snapshot"), run: runSchema }),
  z.object({ type: z.literal("run.status"), runId: z.string(), status: runStatusSchema }),
  z.object({ type: z.literal("candidate.started"), runId: z.string(), candidateId: z.string() }),
  z.object({ type: z.literal("candidate.settled"), runId: z.string(), candidate: candidateSchema }),
  z.object({ type: z.literal("synthesis.started"), runId: z.string(), model: z.string() }),
  z.object({ type: z.literal("synthesis.settled"), runId: z.string(), synthesis: synthesisSchema }),
  z.object({ type: z.literal("run.completed"), runId: z.string(), totalLatencyMs: z.number() }),
  z.object({ type: z.literal("run.failed"), runId: z.string(), error: z.string() }),
])

/** The wire and storage shape of every in-flight run event. */
export type RunEvent = z.infer<typeof runEventSchema>

export const runEventTypeSchema = z.enum([
  "run.snapshot",
  "run.status",
  "candidate.started",
  "candidate.settled",
  "synthesis.started",
  "synthesis.settled",
  "run.completed",
  "run.failed",
])
export type RunEventType = z.infer<typeof runEventTypeSchema>

/**
 * One row of the durable run event log: the event itself plus the sequence
 * number that makes replay ordered, gap-free and resumable from a cursor.
 */
export const runEventRecordSchema = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  event: runEventSchema,
  createdAt: z.string(),
})
export type RunEventRecord = z.infer<typeof runEventRecordSchema>

export const TERMINAL_EVENTS: RunEventType[] = ["run.completed", "run.failed"]

export function isTerminalEvent(event: RunEvent): boolean {
  return TERMINAL_EVENTS.includes(event.type)
}
