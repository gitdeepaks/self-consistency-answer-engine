"use client"

import { isTerminalRunStatus, type Run } from "@sce/shared"
import { useEffect, useReducer, useRef } from "react"
import { useApi } from "@/lib/api/browser"
import {
  applyRunEvent,
  endsStream,
  initialRunStreamState,
  reconnectDelayMs,
  type RunStreamState,
} from "@/lib/run-stream"

/**
 * Subscribe to a run and keep it up to date.
 *
 * All the interesting *logic* lives in `run-stream.ts` as a pure reducer; this
 * hook is only the part React has to own — the effect, the abort, and the
 * reconnect loop. Keeping them apart is what makes the hard behaviour testable
 * without a browser.
 *
 * Reconnection resumes from the cursor rather than starting over, which is the
 * whole point of Phase 2's durable event log: a laptop that slept through the
 * middle of a run wakes up, asks for everything after sequence 34, and gets it
 * — from whichever replica happens to answer, not the one that started the run.
 */

type Action =
  | { kind: "event"; event: Parameters<typeof applyRunEvent>[1] }
  | { kind: "connection"; connection: RunStreamState["connection"] }
  | { kind: "error"; message: string }
  | { kind: "reset"; run: Run }

function reducer(state: RunStreamState, action: Action): RunStreamState {
  switch (action.kind) {
    case "event":
      return applyRunEvent(state, action.event)
    case "connection":
      // A terminal state is final: a late "reconnecting" from an effect that is
      // still unwinding must not reopen a stream that has already ended.
      return state.connection === "closed" ? state : { ...state, connection: action.connection }
    case "error":
      return { ...state, error: action.message }
    case "reset":
      return initialRunStreamState(action.run)
  }
}

export interface RunStream extends RunStreamState {
  /** True while the run can still produce events. */
  live: boolean
}

export function useRunStream(initialRun: Run): RunStream {
  const api = useApi()
  const [state, dispatch] = useReducer(reducer, initialRun, initialRunStreamState)

  // Read inside the effect without being a dependency of it: the cursor changes
  // on every single event, and depending on it would tear the subscription down
  // and rebuild it thousands of times per run.
  const cursor = useRef(0)
  cursor.current = state.cursor

  const runId = initialRun.id
  const finished = isTerminalRunStatus(state.run.status)

  useEffect(() => {
    if (finished) return

    const controller = new AbortController()
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const run = async (): Promise<void> => {
      while (!stopped && !controller.signal.aborted) {
        dispatch({ kind: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" })

        try {
          for await (const message of api.streamRun(runId, {
            signal: controller.signal,
            afterSeq: cursor.current,
          })) {
            if (stopped) return
            // A frame arrived, so the connection is good — reset the backoff
            // here rather than on connect, because a connection that opens and
            // immediately dies is not a healthy one.
            attempt = 0
            dispatch({ kind: "connection", connection: "live" })
            dispatch({ kind: "event", event: message })
            if (endsStream(message.event)) return
          }
        } catch (error: unknown) {
          if (controller.signal.aborted || stopped) return
          // Reported but not fatal: a dropped stream is the normal consequence
          // of a deploy or a sleeping laptop, and the loop below recovers from
          // it. The message is surfaced only if it keeps happening.
          if (attempt >= 3) {
            dispatch({
              kind: "error",
              message:
                error instanceof Error
                  ? `Lost contact with the run: ${error.message}`
                  : "Lost contact with the run",
            })
          }
        }

        if (stopped || controller.signal.aborted) return

        // The server closes an idle stream and the client comes straight back;
        // the jitter is what stops every tab in an organisation from
        // reconnecting in the same millisecond after a rolling deploy.
        const delay = reconnectDelayMs(attempt)
        attempt += 1
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay)
        })
      }
    }

    void run()

    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }, [api, runId, finished])

  // A different run rendered into the same component — a client-side navigation
  // between two run pages — has to start from *its* snapshot rather than
  // inheriting the previous run's candidates.
  const previousRunId = useRef(runId)
  useEffect(() => {
    if (previousRunId.current !== runId) {
      previousRunId.current = runId
      dispatch({ kind: "reset", run: initialRun })
    }
  }, [runId, initialRun])

  return { ...state, live: !finished }
}
