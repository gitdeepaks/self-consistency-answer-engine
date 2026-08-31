import {
  assertNever,
  isTerminalRunStatus,
  type Candidate,
  type Run,
  type RunEvent,
  type StreamedRunEvent,
} from "@sce/shared"

/**
 * Turning a stream of events back into a run.
 *
 * Written as a pure reducer, separate from the effect that feeds it, for one
 * reason above the others: this is the part with the interesting behaviour —
 * out-of-order arrival, replay after a reconnect, a delta for a candidate that
 * already settled — and a reducer can be tested for all three without a browser,
 * a network or a running API. `run-stream.test.ts` does exactly that.
 *
 * The invariants it maintains:
 *
 *   - **The snapshot is authoritative; deltas are decoration.** Token deltas are
 *     ephemeral — the server never writes them to the durable log — so a
 *     reconnecting client can miss any number of them. `candidate.settled`
 *     carries the complete text, and applying it clears the partial buffer. A
 *     client that displayed the accumulated deltas *instead of* the settled
 *     body would show a truncated answer after every reconnect.
 *   - **Replay is idempotent.** After a reconnect the server resends from the
 *     cursor; every reduction here is an assignment rather than an append, so
 *     applying the same event twice is indistinguishable from applying it once.
 *   - **The cursor only moves forward.** An ephemeral event carries no sequence
 *     number and must not reset it.
 */

/** How the subscription is doing, for the connection indicator. */
export type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "closed"

export interface RunStreamState {
  run: Run
  /**
   * Partial answer text per candidate id, while it is still being generated.
   * Cleared for a candidate the moment it settles.
   */
  streaming: Readonly<Record<string, string>>
  /** The evaluator's model, once synthesis has begun. Null before that. */
  synthesizingWith: string | null
  /** Highest durable sequence number applied. The resume cursor. */
  cursor: number
  connection: ConnectionState
  /** A terminal failure the user should see, or null. */
  error: string | null
}

export function initialRunStreamState(run: Run): RunStreamState {
  return {
    run,
    streaming: {},
    synthesizingWith: null,
    cursor: 0,
    // A run that is already finished has nothing to subscribe to, so the state
    // starts closed rather than spending a connection to learn that.
    connection: isTerminalRunStatus(run.status) ? "closed" : "idle",
    error: null,
  }
}

/** Replace one candidate by id, leaving the panel's order untouched. */
function withCandidate(run: Run, candidate: Candidate): Run {
  const known = run.candidates.some((existing) => existing.id === candidate.id)
  return {
    ...run,
    candidates: known
      ? run.candidates.map((existing) => (existing.id === candidate.id ? candidate : existing))
      : [...run.candidates, candidate],
  }
}

function withoutStreaming(
  streaming: Readonly<Record<string, string>>,
  candidateId: string,
): Readonly<Record<string, string>> {
  if (!(candidateId in streaming)) return streaming
  const next = { ...streaming }
  // `delete` rather than setting to "": an empty string is a real state (a
  // candidate that has started and produced nothing yet) and the UI renders a
  // cursor for it, which would then never go away.
  delete next[candidateId]
  return next
}

/**
 * Apply one event.
 *
 * An exhaustive switch with `assertNever` in the default branch, so adding a
 * variant to `RunEvent` is a compile error *here* — in the one place where
 * silently ignoring a new event type means a UI that stops updating for reasons
 * nobody can see.
 */
export function applyRunEvent(state: RunStreamState, incoming: StreamedRunEvent): RunStreamState {
  const { event, seq } = incoming
  // Ephemeral events carry no position in the durable log, so they must not
  // move the cursor — resuming from one would ask the server for a sequence
  // number that does not exist.
  const cursor = seq === null ? state.cursor : Math.max(state.cursor, seq)
  const next: RunStreamState = { ...state, cursor }

  switch (event.type) {
    case "run.snapshot":
      // The full row, sent first on every subscription. It wins over whatever
      // was rendered from a server component moments earlier.
      return { ...next, run: event.run }

    case "run.status":
      return { ...next, run: { ...next.run, status: event.status } }

    case "candidate.started":
      return {
        ...next,
        run: {
          ...next.run,
          candidates: next.run.candidates.map((candidate) =>
            candidate.id === event.candidateId ? { ...candidate, status: "RUNNING" } : candidate,
          ),
        },
        streaming: { ...next.streaming, [event.candidateId]: next.streaming[event.candidateId] ?? "" },
      }

    case "candidate.delta": {
      // Dropped once the candidate has settled: after a reconnect the live tail
      // can deliver a delta that the settled body already contains, and
      // appending it would duplicate a paragraph on screen.
      const settled = next.run.candidates.find(
        (candidate) => candidate.id === event.candidateId,
      )?.content
      if (settled !== null && settled !== undefined) return next

      return {
        ...next,
        streaming: {
          ...next.streaming,
          [event.candidateId]: (next.streaming[event.candidateId] ?? "") + event.text,
        },
      }
    }

    case "candidate.settled":
      return {
        ...next,
        run: withCandidate(next.run, event.candidate),
        streaming: withoutStreaming(next.streaming, event.candidate.id),
      }

    case "synthesis.started":
      return {
        ...next,
        synthesizingWith: event.model,
        run: { ...next.run, status: "SYNTHESIZING" },
      }

    case "synthesis.settled":
      return { ...next, run: { ...next.run, synthesis: event.synthesis } }

    case "run.completed":
      return {
        ...next,
        connection: "closed",
        run: {
          ...next.run,
          status: "COMPLETE",
          totalLatencyMs: event.totalLatencyMs,
          completedAt: next.run.completedAt ?? new Date().toISOString(),
        },
      }

    case "run.failed":
      return {
        ...next,
        connection: "closed",
        error: event.error,
        run: { ...next.run, status: "FAILED", error: event.error },
      }

    case "run.canceled":
      return {
        ...next,
        connection: "closed",
        run: {
          ...next.run,
          status: "CANCELED",
          error: event.reason,
          canceledAt: next.run.canceledAt ?? new Date().toISOString(),
        },
      }

    default:
      return assertNever(event, "applyRunEvent")
  }
}

/** Does this event end the stream? Re-exported shape of the shared guard. */
export function endsStream(event: RunEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.canceled"
}

/**
 * How long to wait before reconnecting, in milliseconds.
 *
 * Exponential with full jitter. The jitter is the part that matters: a deploy
 * drops every open stream at the same instant, and a fixed backoff would bring
 * all of them back in one synchronised wave — which is how a rolling restart
 * turns into an outage. Capped, because a run in flight is worth retrying for
 * as long as the tab is open.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
  return Math.round(ceiling * (0.5 + random() * 0.5))
}
