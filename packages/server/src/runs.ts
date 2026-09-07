import {
  cancelPendingCandidates,
  createCachedRun,
  createRunIdempotent,
  failRun,
  findCachedRun,
  findRunByIdempotencyKey,
  getRun,
  markRunQueued,
  type CancelOutcome,
  type CandidateSeed,
  type CreateRunInput,
  type RunProvenance,
} from "@sce/db"
import { cancelRun as cancelRunRow } from "@sce/db"
import { cancellationBus, runBus, runQueue } from "@sce/queue"
import {
  assignPanel,
  describeError,
  fingerprint,
  narrowPanel,
  panelSeats,
  resolveAvailability,
  resolvePanelConfig,
  type AskInput,
  type CacheOutcome,
  type PanelConfig,
  type PanelSeat,
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
 *
 * Phase 7 added two decisions in front of that, both made here because both
 * have to be recorded on the row before anything is enqueued:
 *
 *   **Which panel.** An experiment may assign this tenant to an arm, and the
 *   arm names a panel — which models, sampled how often, judged by whom, under
 *   which prompts. All of it is written onto the run, so the answer can be
 *   attributed later to the configuration that produced it.
 *
 *   **Whether to generate at all.** If the same question was already answered
 *   by the same panel recently, the answer is copied instead of bought.
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
  /**
   * Skip the answer cache for this request.
   *
   * The escape hatch for a caller who wants a fresh sample of the panel —
   * measuring the engine, rather than asking it something.
   */
  bypassCache?: boolean
}

export interface StartedRun {
  run: Run
  /** False when an identical `Idempotency-Key` had already created this run. */
  created: boolean
  /** How the answer was obtained: generated, or copied from which kind of match. */
  cache: CacheOutcome
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

/**
 * Choose the panel for this run.
 *
 * A caller that named its own providers has opted out of the experiment: their
 * run is not a sample of anything, and counting it in an arm it did not follow
 * would quietly poison the result. Everyone else is assigned by tenant, so a
 * workspace sees one consistent panel rather than a different one per question.
 */
function choosePanel(
  tenantId: string,
  input: AskInput,
  now: Date,
): { panel: PanelConfig; experimentId: string | null; variantId: string | null } {
  const explicit = input.providers !== undefined && input.providers.length > 0

  const assignment = explicit
    ? { panelId: config.panels.defaultPanelId, experimentId: null, variantId: null }
    : assignPanel(config.panels.experiments, tenantId, now, config.panels.defaultPanelId)

  // The registry is validated at boot and an experiment cannot name a panel
  // that is not in it, so this is a total lookup with a defensive tail rather
  // than a branch anybody expects to take.
  const resolved = resolvePanelConfig(assignment.panelId) ?? resolvePanelConfig(null)
  if (resolved === null) throw new Error("No panel is registered; the build is misconfigured")

  const panel = explicit && input.providers ? narrowPanel(resolved, input.providers) : resolved
  return { panel, experimentId: assignment.experimentId, variantId: assignment.variantId }
}

/**
 * Seat the panel, resolving each member to the model that would be called.
 *
 * Unavailable providers are seeded as `SKIPPED` rather than omitted, so the
 * panel a user asked for is visible in the run even where it could not run —
 * and so the reason is on the row rather than only in a log.
 */
function seedPanel(panel: PanelConfig): { seeds: CandidateSeed[]; seats: { seat: PanelSeat; model: string }[] } {
  const seeds: CandidateSeed[] = []
  const seats: { seat: PanelSeat; model: string }[] = []

  for (const seat of panelSeats(panel)) {
    const availability = resolveAvailability(seat.provider, seat.model ?? undefined)
    seeds.push({
      provider: seat.provider,
      label: seat.label,
      model: availability.modelId,
      status: availability.route === null ? "SKIPPED" : "PENDING",
      error: availability.route === null ? availability.hint : null,
      sample: seat.sample,
    })
    seats.push({ seat, model: availability.modelId })
  }

  return { seeds, seats }
}

export async function startRun(
  tenantId: string,
  input: AskInput,
  options: StartRunOptions = {},
): Promise<StartedRun> {
  const now = new Date()
  const { panel, experimentId, variantId } = choosePanel(tenantId, input, now)
  const { seeds, seats } = seedPanel(panel)

  // The temperature a caller asked for wins over the panel's; a panel that sets
  // one (self-consistency raises it deliberately) is a default, not a mandate.
  const temperature = input.temperature ?? panel.temperature ?? null

  const marks = await fingerprint({
    prompt: input.prompt,
    seats: seats.map((entry) => ({ provider: entry.seat.provider, model: entry.model })),
    temperature,
    promptSetId: panel.promptSetId,
  })

  const provenance: RunProvenance = {
    promptSetId: panel.promptSetId,
    panelId: panel.id,
    experimentId,
    variantId,
    cacheKey: marks.key,
    cacheScope: marks.scope,
    promptSimhash: marks.simhash,
  }

  const create = {
    tenantId,
    createdByUserId: options.createdByUserId ?? null,
    prompt: input.prompt,
    ...(temperature === null ? {} : { temperature }),
    candidates: seeds,
    idempotencyKey: options.idempotencyKey ?? null,
    deadlineAt: new Date(now.getTime() + config.runDeadlineMs),
    maxTotalTokens: options.limits?.maxTotalTokens ?? config.runMaxTotalTokens,
    maxCostMicroCents: options.limits?.maxCostMicroCents ?? config.runMaxCostMicroCents,
    provenance,
  }

  const cached = await serveFromCache(tenantId, input, marks, create, options)
  if (cached !== null) return cached

  const { run, created } = await createRunIdempotent(create)

  // A retry of the same request must not fan out a second panel — that is the
  // entire point of the idempotency key, and model calls are what it protects.
  if (!created) return { run, created: false, cache: cacheOutcomeOf(run) }

  const bus = runBus()
  await bus.publish(tenantId, run.id, { type: "run.snapshot", run })

  const runnable = run.candidates.filter((candidate) => candidate.status === "PENDING")
  if (runnable.length === 0) {
    const message =
      "No AI provider is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY and/or " +
      "GOOGLE_GENERATIVE_AI_API_KEY — or a single AI_GATEWAY_API_KEY — and restart the worker."
    await failRun(tenantId, run.id, message)
    await bus.publish(tenantId, run.id, { type: "run.failed", runId: run.id, error: message })
    return { run: (await getRun(tenantId, run.id)) ?? run, created: true, cache: "miss" }
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

  return { run: (await getRun(tenantId, run.id)) ?? run, created: true, cache: "miss" }
}

/** A run that already exists says for itself whether it was ever generated. */
function cacheOutcomeOf(run: Run): CacheOutcome {
  return run.cachedFromRunId === null ? "miss" : "exact"
}

/**
 * Answer from an earlier run, if one is close enough.
 *
 * Returns null on every path that should generate instead — the cache being
 * off, the caller bypassing it, no match, or a match that turned out not to be
 * reusable after all. None of those are errors, and none of them are worth
 * failing a request over: the fallback is to do the work.
 *
 * The idempotency check happens first and separately from `createRunIdempotent`
 * below, because a cached run is written by a different code path: a retried
 * request with a key that already produced a run must return that run rather
 * than mint a second copy of the cached answer.
 */
async function serveFromCache(
  tenantId: string,
  input: AskInput,
  marks: Awaited<ReturnType<typeof fingerprint>>,
  create: CreateRunInput,
  options: StartRunOptions,
): Promise<StartedRun | null> {
  if (options.bypassCache === true) return null
  if (!config.answerCache.enabled) return null

  const key = options.idempotencyKey ?? null
  if (key !== null) {
    const existing = await findRunByIdempotencyKey(tenantId, key)
    if (existing !== null) return { run: existing, created: false, cache: cacheOutcomeOf(existing) }
  }

  const hit = await findCachedRun({
    tenantId,
    key: marks.key,
    scope: marks.scope,
    prompt: input.prompt,
    ttlMs: config.answerCache.ttlMs,
    nearDuplicates: config.answerCache.nearDuplicates,
    nearDuplicateOptions: config.answerCache.thresholds,
    poolSize: config.answerCache.poolSize,
  }).catch((error: unknown) => {
    // A cache that is down is a cache that is missing, never a request that
    // fails: the whole feature is an optimisation over doing the work.
    console.error("[server] answer cache lookup failed", { error: describeError(error) })
    return null
  })
  if (hit === null) return null

  // Any failure here falls through to generating the answer, which is always a
  // correct outcome. That includes the idempotency race: two concurrent retries
  // of one request can both reach this point, and the loser's unique-constraint
  // violation is resolved by `createRunIdempotent` below returning the run the
  // winner created — rather than by a second copy of the cached answer.
  const run = await createCachedRun({ ...create, sourceRunId: hit.runId }).catch(
    (error: unknown) => {
      console.error("[server] could not materialise a cached run", {
        sourceRunId: hit.runId,
        error: describeError(error),
      })
      return null
    },
  )
  if (run === null) return null

  // Published so a client that subscribed before the response landed still sees
  // a terminal event, and so the run's own event log reads the same as a
  // generated one's: a snapshot, then a completion.
  const bus = runBus()
  await bus.publish(tenantId, run.id, { type: "run.snapshot", run }).catch(() => {})
  await bus
    .publish(tenantId, run.id, { type: "run.completed", runId: run.id, totalLatencyMs: 0 })
    .catch(() => {})

  return { run, created: true, cache: hit.outcome }
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
