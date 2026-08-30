import {
  cancelPendingCandidates,
  createRunIdempotent,
  failRun,
  getRun,
  markRunQueued,
  type CancelOutcome,
  type CandidateSeed,
} from "@sce/db"
import { cancelRun as cancelRunRow } from "@sce/db"
import { cancellationBus, runBus, runQueue } from "@sce/queue"
import {
  describeError,
  resolvePanelAvailability,
  type AskInput,
  type Run,
} from "@sce/shared"
import { config } from "./env.ts"

/**
 * What the API does with a run, now that it does not execute one.
 *
 * The whole of Phase 2's structural change is visible in this file: the API's
 * job ends at *validate, persist, enqueue, return*. It never calls a model, so
 * a deploy that restarts every API replica mid-run costs nothing — the workers
 * holding those runs are a separate fleet, and the client's SSE stream
 * reconnects to whichever replica answers next.
 */

/**
 * Per-run ceilings, stamped onto the row for the worker to enforce.
 *
 * Supplied by the caller rather than read from configuration here, because by
 * the time a request reaches this function the quota gate has already worked
 * out how much of the tenant's monthly allowance is left — and *that* is the
 * number a single run must not exceed. Zero means "no ceiling", matching what
 * the worker reads.
 */
export interface RunLimits {
  maxTotalTokens: number
  maxCostMicroCents: number
}

export interface StartRunOptions {
  idempotencyKey?: string | null
  createdByUserId?: string | null
  /** Omitted falls back to the process-wide ceilings from `env.ts`. */
  limits?: RunLimits
}

export interface StartedRun {
  run: Run
  /** False when an identical `Idempotency-Key` had already created this run. */
  created: boolean
}

/** Raised when the run row exists but its jobs could not be queued. */
export class EnqueueFailedError extends Error {
  readonly runId: string

  constructor(runId: string, cause: unknown) {
    super(`Could not enqueue run ${runId}: ${describeError(cause)}`)
    this.name = "EnqueueFailedError"
    this.runId = runId
  }
}

export async function startRun(
  tenantId: string,
  input: AskInput,
  options: StartRunOptions = {},
): Promise<StartedRun> {
  const panel = resolvePanelAvailability(input.providers)

  // Unavailable providers are seeded as SKIPPED rather than omitted, so the
  // panel a user asked for is visible in the run even where it could not run.
  const seeds: CandidateSeed[] = panel.map((provider) => ({
    provider: provider.spec.id,
    label: provider.spec.label,
    model: provider.modelId,
    status: provider.route === null ? "SKIPPED" : "PENDING",
    error: provider.route === null ? provider.hint : null,
  }))

  const { run, created } = await createRunIdempotent({
    tenantId,
    createdByUserId: options.createdByUserId ?? null,
    prompt: input.prompt,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    candidates: seeds,
    idempotencyKey: options.idempotencyKey ?? null,
    deadlineAt: new Date(Date.now() + config.runDeadlineMs),
    maxTotalTokens: options.limits?.maxTotalTokens ?? config.runMaxTotalTokens,
    maxCostMicroCents: options.limits?.maxCostMicroCents ?? config.runMaxCostMicroCents,
  })

  // A retry of the same request must not fan out a second panel — that is the
  // entire point of the idempotency key, and model calls are what it protects.
  if (!created) return { run, created: false }

  const bus = runBus()
  await bus.publish(tenantId, run.id, { type: "run.snapshot", run })

  const runnable = run.candidates.filter((candidate) => candidate.status === "PENDING")
  if (runnable.length === 0) {
    const message =
      "No AI provider is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY and/or " +
      "GOOGLE_GENERATIVE_AI_API_KEY — or a single AI_GATEWAY_API_KEY — and restart the worker."
    await failRun(tenantId, run.id, message)
    await bus.publish(tenantId, run.id, { type: "run.failed", runId: run.id, error: message })
    return { run: (await getRun(tenantId, run.id)) ?? run, created: true }
  }

  try {
    await runQueue().enqueueRun({
      tenantId,
      runId: run.id,
      candidateIds: runnable.map((candidate) => candidate.id),
    })
  } catch (error) {
    // The row already exists, so leaving it at PENDING would be a run that
    // nobody is working on and nobody is told about. Fail it loudly instead.
    const message = `Could not enqueue this run — ${describeError(error)}`
    await failRun(tenantId, run.id, message).catch(() => {})
    await bus
      .publish(tenantId, run.id, { type: "run.failed", runId: run.id, error: message })
      .catch(() => {})
    throw new EnqueueFailedError(run.id, error)
  }

  await markRunQueued(tenantId, run.id)
  await bus.publish(tenantId, run.id, { type: "run.status", runId: run.id, status: "QUEUED" })

  return { run: (await getRun(tenantId, run.id)) ?? run, created: true }
}

/**
 * Cancel a run.
 *
 * Three things have to happen, in this order, and the order is the design:
 *
 *   1. the database row is flipped — authoritative, survives everything;
 *   2. candidates that never started are closed out, so the panel does not sit
 *      at PENDING for ever once its jobs are discarded;
 *   3. the cancellation is published, which is what makes an *already streaming*
 *      model call abort now rather than at its next checkpoint.
 *
 * Step 3 is an optimisation and is allowed to fail: a worker that never
 * receives it still stops at its next checkpoint, because step 1 already
 * happened.
 */
export async function cancelRun(
  tenantId: string,
  runId: string,
  reason: string,
): Promise<CancelOutcome> {
  const outcome = await cancelRunRow(tenantId, runId, reason)
  if (outcome.outcome !== "canceled") return outcome

  await cancelPendingCandidates(tenantId, runId, reason)
  await cancellationBus()
    .request(runId, reason)
    .catch((error: unknown) => {
      console.error("[server] failed to publish cancellation", {
        runId,
        error: describeError(error),
      })
    })
  await runBus().publish(tenantId, runId, { type: "run.canceled", runId, reason })

  const refreshed = await getRun(tenantId, runId)
  return { outcome: "canceled", run: refreshed ?? outcome.run }
}
