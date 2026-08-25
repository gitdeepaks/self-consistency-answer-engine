import {
  getRun,
  recordUsage,
  setCandidateRunning,
  setRunStatus,
  settleCandidate,
  settleCandidatePartial,
  type CandidateResult,
} from "@sce/db"
import type { JobMeta } from "@sce/queue"
import {
  assertNever,
  describeError,
  errorFacts,
  type Candidate,
  type CandidateJob,
  type ProviderId,
} from "@sce/shared"
import { streamText } from "ai"
import {
  anySignal,
  cancellationSignal,
  checkStop,
  contextFor,
  timeoutSignal,
  type RunContext,
  type StopReason,
} from "./context.ts"
import { workerConfig } from "./env.ts"
import { CANDIDATE_SYSTEM_PROMPT } from "./prompts.ts"
import { resolveProvider, type ResolvedProvider } from "./providers.ts"
import { breakerState, classify, recordProviderOutcome, withBulkhead } from "./resilience.ts"

/**
 * One panel member's answer.
 *
 * This is the unit of work the fan-out was split into. A worker that dies here
 * loses one candidate, and the queue redelivers exactly that candidate — the
 * others keep streaming on whichever machines are running them.
 *
 * The processor's contract with the queue is deliberate and worth stating,
 * because it is what keeps the dead-letter queue meaningful:
 *
 *   - A **provider** failure is a normal outcome. It is written to the
 *     candidate row and the job **succeeds**, so the run's synthesis still
 *     happens with whoever did answer.
 *   - A **retryable** provider failure throws, so the queue retries it with
 *     backoff — but only while attempts remain. On the final attempt it settles
 *     the row instead, so the outcome is recorded while there is still a
 *     processor alive to record it.
 *   - Only an **infrastructure** failure is allowed to exhaust its attempts and
 *     reach the DLQ. That is why the DLQ is short and worth reading.
 */

/** A candidate that is already settled must never be paid for twice. */
function alreadySettled(candidate: Candidate): boolean {
  return candidate.status !== "PENDING" && candidate.status !== "RUNNING"
}

function stopToResult(stop: StopReason): CandidateResult | null {
  switch (stop.kind) {
    case "canceled":
      return { status: "CANCELED", error: stop.message }
    case "deadline":
    case "budget":
      return { status: "SKIPPED", error: stop.message }
    case "finished":
    case "missing":
      // Nothing to record: the run is gone or already concluded elsewhere.
      return null
    default:
      return assertNever(stop, "stopToResult")
  }
}

export async function processCandidateJob(job: CandidateJob, meta: JobMeta): Promise<void> {
  const { tenantId, runId, candidateId } = job
  const ctx = contextFor(tenantId, runId)

  const run = await getRun(tenantId, runId)
  if (!run) return

  const candidate = run.candidates.find((entry) => entry.id === candidateId)
  if (!candidate) return
  // A redelivered job for a candidate that already produced an answer is the
  // most expensive kind of duplicate. Stop before the model call, not after.
  if (alreadySettled(candidate)) return

  const stop = await checkStop(tenantId, runId)
  if (stop) {
    const result = stopToResult(stop)
    if (result) await settleAndEmit(ctx, candidateId, result)
    return
  }

  const provider = resolveProvider(candidate.provider, candidate.model)
  if (!provider.model) {
    await settleAndEmit(ctx, candidateId, {
      status: "SKIPPED",
      error: provider.hint ?? "Provider is not configured",
    })
    return
  }

  const breaker = await breakerState(candidate.provider)
  if (breaker.state === "open") {
    await settleAndEmit(ctx, candidateId, {
      status: "SKIPPED",
      error:
        `${provider.spec.label} is failing repeatedly; calls are paused until ` +
        `${breaker.until.toISOString()}`,
    })
    return
  }

  // The first candidate to reach this point moves the run out of QUEUED. The
  // update is status-filtered, so several candidates racing here is harmless.
  await setRunStatus(tenantId, runId, "FANNING_OUT")
  await ctx.emit({ type: "run.status", runId, status: "FANNING_OUT" })

  await withBulkhead(candidate.provider, () =>
    generate(ctx, meta, candidate, provider, run.prompt, run.temperature),
  )
}

/* ----------------------------------------------------------- the model call */

async function generate(
  ctx: RunContext,
  meta: JobMeta,
  candidate: Candidate,
  provider: ResolvedProvider,
  prompt: string,
  temperature: number | null,
): Promise<void> {
  const model = provider.model
  if (!model) throw new Error("generate called without a model")

  await ctx.emit({ type: "candidate.started", runId: ctx.runId, candidateId: candidate.id })
  await setCandidateRunning(ctx.tenantId, ctx.runId, candidate.id)

  const startedAt = performance.now()
  const timeout = timeoutSignal(
    workerConfig.PER_MODEL_TIMEOUT_MS,
    `${provider.spec.label} call`,
  )
  const cancellation = await cancellationSignal(ctx.tenantId, ctx.runId)
  const combined = anySignal([timeout.signal, cancellation.signal])

  const deltas = new DeltaBuffer(ctx, candidate.id)
  let text = ""

  try {
    const result = streamText({
      model,
      system: CANDIDATE_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: workerConfig.MAX_OUTPUT_TOKENS,
      maxRetries: workerConfig.MAX_RETRIES,
      abortSignal: combined.signal,
      ...(temperature === null ? {} : { temperature }),
    })

    // `fullStream` surfaces provider errors as parts rather than rejections, so
    // consuming only `textStream` would quietly yield a truncated answer on a
    // mid-stream failure. Re-throwing the error part is what makes the failure
    // reach the classifier below instead of being mistaken for a short answer.
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text
        await deltas.push(part.text)
      } else if (part.type === "error") {
        throw part.error
      }
    }
    await deltas.flush()

    const trimmed = text.trim()
    if (trimmed.length === 0) throw new EmptyAnswerError()

    const usage = await result.usage
    const settled = await settleCandidate(ctx.tenantId, ctx.runId, candidate.id, {
      status: "OK",
      content: trimmed,
      latencyMs: Math.round(performance.now() - startedAt),
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })

    await recordProviderOutcome(candidate.provider, { ok: true })
    await meter(ctx, {
      candidateId: candidate.id,
      provider: candidate.provider,
      model: provider.modelId,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })

    await ctx.emit({ type: "candidate.settled", runId: ctx.runId, candidate: settled })
  } catch (error) {
    await deltas.discard()
    await handleFailure(ctx, meta, candidate, provider, {
      error,
      partial: text,
      latencyMs: Math.round(performance.now() - startedAt),
      timedOut: timeout.signal.aborted,
      canceled: cancellation.signal.aborted,
    })
  } finally {
    timeout.clear()
    combined.clear()
    await cancellation.clear()
  }
}

/** An answer of pure whitespace is a failure, not a zero-length success. */
class EmptyAnswerError extends Error {
  constructor() {
    super("Model returned an empty answer")
    this.name = "EmptyAnswerError"
  }
}

interface Failure {
  error: unknown
  partial: string
  latencyMs: number
  timedOut: boolean
  canceled: boolean
}

/**
 * Decide between "let the queue try again" and "record this and move on".
 *
 * The `isFinalAttempt` branch is the load-bearing one. Writing the terminal
 * state from a `failed` event handler instead would race the next job and could
 * leave a candidate stuck at `RUNNING` for ever if the process died between the
 * throw and the handler.
 */
async function handleFailure(
  ctx: RunContext,
  meta: JobMeta,
  candidate: Candidate,
  provider: ResolvedProvider,
  failure: Failure,
): Promise<void> {
  // An abort carries our own reason — the timeout's, or the cancellation's —
  // which is far more useful on the row than the SDK's generic AbortError.
  const reason = failure.canceled
    ? "Canceled by request"
    : failure.timedOut
      ? `${provider.spec.label} call exceeded its ${Math.round(
          workerConfig.PER_MODEL_TIMEOUT_MS / 1000,
        )}s budget`
      : describeError(failure.error)

  await recordProviderOutcome(candidate.provider, { ok: false, error: failure.error })

  const retryable =
    !failure.canceled &&
    !failure.timedOut &&
    !(failure.error instanceof EmptyAnswerError) &&
    classify(failure.error).kind === "retryable"

  if (retryable && !meta.isFinalAttempt) {
    // Thrown, so BullMQ applies its backoff and redelivers. The candidate row
    // stays RUNNING with its attempt count already incremented.
    throw failure.error
  }

  const status = failure.canceled ? "CANCELED" : "ERROR"
  // The attempt count explains a *failure*; on a cancellation it is noise, and
  // worse, it reads as though the cancellation were something that had been
  // retried. A caller who stopped the run does not need the retry budget.
  const attemptNote =
    failure.canceled || meta.maxAttempts <= 1
      ? ""
      : ` (attempt ${meta.attempt} of ${meta.maxAttempts})`
  const message = `${reason}${attemptNote}`

  // Streaming makes a partial answer possible for the first time: a call that
  // used to yield nothing on timeout now yields what it produced, kept as
  // evidence next to the reason it stopped.
  const settled =
    failure.partial.trim().length > 0
      ? await settleCandidatePartial(ctx.tenantId, ctx.runId, candidate.id, {
          status,
          error: message,
          latencyMs: failure.latencyMs,
          partial: failure.partial,
        })
      : await settleCandidate(ctx.tenantId, ctx.runId, candidate.id, {
          status,
          error: message,
          latencyMs: failure.latencyMs,
        })

  await ctx.emit({ type: "candidate.settled", runId: ctx.runId, candidate: settled })
}

async function settleAndEmit(
  ctx: RunContext,
  candidateId: string,
  result: CandidateResult,
): Promise<void> {
  const settled = await settleCandidate(ctx.tenantId, ctx.runId, candidateId, result)
  await ctx.emit({ type: "candidate.settled", runId: ctx.runId, candidate: settled })
}

/* -------------------------------------------------------------- delta buffer */

/**
 * Batching for `candidate.delta` events.
 *
 * A model emits thousands of tokens per answer. Publishing one bus frame each
 * would make the progress bus cost more than the generation it is reporting on,
 * and would flood an SSE client with frames far faster than a browser can
 * render them. Flushing on whichever of "enough characters" or "enough time"
 * comes first keeps a fast model cheap and a slow model responsive.
 */
class DeltaBuffer {
  #pending = ""
  #lastFlushAt = performance.now()
  readonly #ctx: RunContext
  readonly #candidateId: string

  constructor(ctx: RunContext, candidateId: string) {
    this.#ctx = ctx
    this.#candidateId = candidateId
  }

  async push(text: string): Promise<void> {
    this.#pending += text
    const elapsed = performance.now() - this.#lastFlushAt
    if (
      this.#pending.length >= workerConfig.CANDIDATE_DELTA_FLUSH_CHARS ||
      elapsed >= workerConfig.CANDIDATE_DELTA_FLUSH_MS
    ) {
      await this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) return
    const text = this.#pending
    this.#pending = ""
    this.#lastFlushAt = performance.now()

    // A delta is decoration. Losing one must never fail the answer that the
    // model is in the middle of producing.
    try {
      await this.#ctx.emit({
        type: "candidate.delta",
        runId: this.#ctx.runId,
        candidateId: this.#candidateId,
        text,
      })
    } catch (error) {
      console.error("[worker] failed to publish candidate delta", {
        runId: this.#ctx.runId,
        candidateId: this.#candidateId,
        error: describeError(error),
      })
    }
  }

  /** Drop anything unflushed. The failure path publishes the reason instead. */
  async discard(): Promise<void> {
    this.#pending = ""
  }
}

/* ------------------------------------------------------------------ metering */

/** Metering must never be able to fail a call that already produced an answer. */
async function meter(
  ctx: RunContext,
  input: {
    candidateId: string
    provider: ProviderId
    model: string
    inputTokens: number | null
    outputTokens: number | null
  },
): Promise<void> {
  try {
    await recordUsage({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      candidateId: input.candidateId,
      kind: "CANDIDATE",
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    })
  } catch (error) {
    console.error("[worker] failed to record usage", {
      runId: ctx.runId,
      model: input.model,
      error: describeError(error),
      facts: errorFacts(error),
    })
  }
}
