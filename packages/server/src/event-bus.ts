import { isTerminalEvent, type RunEvent } from "@sce/shared"
import { config } from "./env.ts"

type Listener = (event: RunEvent) => void

/**
 * In-process pub/sub for run progress.
 *
 * Every event is buffered per run, so an SSE client that connects after the run
 * started (or reconnects mid-run) can replay the full timeline and then keep
 * following live updates. Buffers are dropped a while after the run ends.
 */
class RunEventBus {
  #buffers = new Map<string, RunEvent[]>()
  #listeners = new Map<string, Set<Listener>>()
  #finished = new Map<string, ReturnType<typeof setTimeout>>()

  emit(runId: string, event: RunEvent): void {
    const buffer = this.#buffers.get(runId)
    if (buffer) buffer.push(event)
    else this.#buffers.set(runId, [event])

    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(event)
      } catch (error) {
        console.error("[event-bus] listener threw", error)
      }
    }

    if (isTerminalEvent(event)) this.#scheduleEviction(runId)
  }

  /** Buffered events so far, for replay on subscribe. */
  history(runId: string): RunEvent[] {
    return [...(this.#buffers.get(runId) ?? [])]
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.#listeners.get(runId) ?? new Set<Listener>()
    set.add(listener)
    this.#listeners.set(runId, set)

    return () => {
      const current = this.#listeners.get(runId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.#listeners.delete(runId)
    }
  }

  /** True while the run is still producing events. */
  isLive(runId: string): boolean {
    return this.#buffers.has(runId) && !this.#finished.has(runId)
  }

  #scheduleEviction(runId: string): void {
    clearTimeout(this.#finished.get(runId))
    const timer = setTimeout(() => {
      this.#buffers.delete(runId)
      this.#listeners.delete(runId)
      this.#finished.delete(runId)
    }, config.eventBufferTtlMs)
    // Do not hold the process open just to clean up a buffer.
    timer.unref?.()
    this.#finished.set(runId, timer)
  }
}

export const runEvents = new RunEventBus()
