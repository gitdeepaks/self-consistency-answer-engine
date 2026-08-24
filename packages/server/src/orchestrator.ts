import {
  appendRunEvent,
  completeRun,
  createRun,
  failRun,
  getRun,
  recordUsage,
  saveSynthesis,
  setCandidateRunning,
  setRunStatus,
  settleCandidate,
  type CandidateSeed,
} from "@sce/db"
import {
  synthesisOutputSchema,
  type AskInput,
  type Candidate,
  type CandidateReview,
  type ProviderId,
  type Run,
  type RunEvent,
  type Synthesis,
} from "@sce/shared"
import { generateText, Output } from "ai"
import { config } from "./env.ts"
import { describeError } from "./errors.ts"
import { runEvents } from "./event-bus.ts"
import { buildEvaluatorPrompt, CANDIDATE_SYSTEM_PROMPT, EVALUATOR_SYSTEM_PROMPT } from "./prompts.ts"
import { resolveEvaluator, resolvePanel, type ResolvedProvider } from "./providers.ts"

/* --------------------------------------------------------------- helpers */

/**
 * Everything a run's legs need to know about who owns it and how to report
 * progress. Carrying the tenant explicitly — rather than reading it from an
 * ambient context — is what makes every persistence call in this file scoped by
 * construction.
 */
interface RunContext {
  tenantId: string
  runId: string
  emit: (event: RunEvent) => void
}

function contextFor(tenantId: string, runId: string): RunContext {
  return {
    tenantId,
    runId,
    emit(event) {
      // The in-process bus is what the SSE handler still reads; the table is
      // what survives a restart. Persistence is fire-and-forget so a slow
      // database cannot stall the pipeline — Phase 2 makes the durable log the
      // primary path and the buffer the cache.
      runEvents.emit(runId, event)
      void appendRunEvent(tenantId, runId, event).catch((error: unknown) => {
        console.error("[orchestrator] failed to persist run event", {
          runId,
          type: event.type,
          error: describeError(error),
        })
      })
    },
  }
}

/**
 * `AbortSignal.timeout` alone reports as a generic AbortError, which is
 * indistinguishable from a client disconnect. Pairing it with an explicit
 * reason keeps the persisted error message useful.
 */
function timeoutSignal(ms: number, what: string): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`${what} exceeded ${Math.round(ms / 1000)}s budget`))
  }, ms)
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  return controller.signal
}

function abortReason(signal: AbortSignal, fallback: unknown): unknown {
  return signal.aborted ? (signal.reason ?? fallback) : fallback
}

/** Metering must never be able to fail a run that already produced an answer. */
async function meter(
  ctx: RunContext,
  input: Parameters<typeof recordUsage>[0],
): Promise<void> {
  try {
    await recordUsage(input)
  } catch (error) {
    console.error("[orchestrator] failed to record usage", {
      runId: ctx.runId,
      model: input.model,
      error: describeError(error),
    })
  }
}

/* ------------------------------------------------------------ fan-out leg */

async function runCandidate(
  ctx: RunContext,
  candidate: Candidate,
  provider: ResolvedProvider,
  temperature: number | undefined,
  prompt: string,
): Promise<Candidate> {
  ctx.emit({ type: "candidate.started", runId: ctx.runId, candidateId: candidate.id })
  await setCandidateRunning(ctx.tenantId, ctx.runId, candidate.id)

  const startedAt = performance.now()
  const signal = timeoutSignal(config.perModelTimeoutMs, `${provider.spec.label} call`)

  let settled: Candidate
  try {
    if (!provider.model) throw new Error(provider.hint ?? "Provider is not configured")

    const result = await generateText({
      model: provider.model,
      system: CANDIDATE_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: config.maxOutputTokens,
      maxRetries: config.maxRetries,
      abortSignal: signal,
      ...(temperature === undefined ? {} : { temperature }),
    })

    const text = result.text.trim()
    if (text.length === 0) throw new Error("Model returned an empty answer")

    settled = await settleCandidate(ctx.tenantId, ctx.runId, candidate.id, {
      status: "OK",
      content: text,
      latencyMs: Math.round(performance.now() - startedAt),
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
    })

    await meter(ctx, {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      candidateId: candidate.id,
      kind: "CANDIDATE",
      provider: provider.spec.id,
      model: provider.modelId,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
    })
  } catch (error) {
    settled = await settleCandidate(ctx.tenantId, ctx.runId, candidate.id, {
      status: "ERROR",
      error: describeError(abortReason(signal, error)),
      latencyMs: Math.round(performance.now() - startedAt),
    })
  }

  ctx.emit({ type: "candidate.settled", runId: ctx.runId, candidate: settled })
  return settled
}

/* ----------------------------------------------------------- synthesis leg */

/** Keep exactly one review per candidate, so the CLI can align them 1:1. */
function normaliseReviews(
  reviews: CandidateReview[],
  candidates: Candidate[],
): CandidateReview[] {
  const byProvider = new Map(reviews.map((review) => [review.provider, review]))
  return candidates.map(
    (candidate) =>
      byProvider.get(candidate.provider) ?? {
        provider: candidate.provider,
        score: 0,
        strengths: [],
        weaknesses: ["The evaluator did not return a review for this candidate."],
      },
  )
}

async function synthesize(
  ctx: RunContext,
  prompt: string,
  candidates: Candidate[],
): Promise<Synthesis> {
  const evaluator = resolveEvaluator()
  if (!evaluator.model) {
    throw new Error(
      evaluator.hint ?? "No evaluator model is configured; cannot synthesise a final answer.",
    )
  }

  ctx.emit({ type: "synthesis.started", runId: ctx.runId, model: evaluator.modelId })

  const startedAt = performance.now()
  const signal = timeoutSignal(config.evaluatorTimeoutMs, "Evaluator call")

  try {
    const result = await generateText({
      model: evaluator.model,
      system: EVALUATOR_SYSTEM_PROMPT,
      prompt: buildEvaluatorPrompt(prompt, candidates),
      output: Output.object({ schema: synthesisOutputSchema }),
      maxOutputTokens: config.maxOutputTokens * 2,
      maxRetries: config.maxRetries,
      abortSignal: signal,
    })

    // Structured output is only parsed on a clean stop. Hitting the token cap
    // yields a truncated JSON object, which surfaces as an unhelpful
    // "no output generated" — name the real cause instead.
    if (result.finishReason === "length") {
      throw new Error(
        `Evaluator hit the ${config.maxOutputTokens * 2} output-token cap before finishing. ` +
          "Raise MAX_OUTPUT_TOKENS or ask a narrower question.",
      )
    }

    const { output, usage } = result
    const finalAnswer = output.finalAnswer.trim()
    if (finalAnswer.length === 0) throw new Error("Evaluator returned an empty final answer")

    const synthesis = await saveSynthesis(ctx.tenantId, ctx.runId, {
      model: evaluator.modelId,
      finalAnswer,
      agreements: output.agreements,
      disagreements: output.disagreements,
      reviews: normaliseReviews(output.reviews, candidates),
      confidence: output.confidence,
      latencyMs: Math.round(performance.now() - startedAt),
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })

    await meter(ctx, {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      kind: "EVALUATOR",
      provider: evaluator.spec.id,
      model: evaluator.modelId,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })

    return synthesis
  } catch (error) {
    throw new Error(`Synthesis failed — ${describeError(abortReason(signal, error))}`)
  }
}

/* ---------------------------------------------------------------- the run */

async function executeRun(
  ctx: RunContext,
  run: Run,
  panel: Map<ProviderId, ResolvedProvider>,
  temperature: number | undefined,
): Promise<void> {
  const startedAt = performance.now()

  try {
    await setRunStatus(ctx.tenantId, run.id, "FANNING_OUT")
    ctx.emit({ type: "run.status", runId: run.id, status: "FANNING_OUT" })

    // Every model is called concurrently and independently; one failure must
    // never take down the panel, so each leg settles its own candidate row.
    const legs: Promise<Candidate>[] = []
    for (const candidate of run.candidates) {
      const provider = panel.get(candidate.provider)
      if (provider) legs.push(runCandidate(ctx, candidate, provider, temperature, run.prompt))
    }
    const settled = await Promise.all(legs)

    const succeeded = settled.filter((candidate) => candidate.status === "OK")
    if (succeeded.length === 0) {
      const reasons = settled
        .map((candidate) => `${candidate.label}: ${candidate.error ?? "unknown error"}`)
        .join(" | ")
      throw new Error(`Every model in the panel failed — ${reasons}`)
    }

    await setRunStatus(ctx.tenantId, run.id, "SYNTHESIZING")
    ctx.emit({ type: "run.status", runId: run.id, status: "SYNTHESIZING" })

    const synthesis = await synthesize(ctx, run.prompt, succeeded)
    ctx.emit({ type: "synthesis.settled", runId: run.id, synthesis })

    const totalLatencyMs = Math.round(performance.now() - startedAt)
    await completeRun(ctx.tenantId, run.id, totalLatencyMs)
    ctx.emit({ type: "run.completed", runId: run.id, totalLatencyMs })
  } catch (error) {
    const message = describeError(error)
    await failRun(ctx.tenantId, run.id, message).catch(() => {})
    ctx.emit({ type: "run.failed", runId: run.id, error: message })
  }
}

/**
 * Create a run, seed one candidate row per panel member, and kick the pipeline
 * off in the background. Returns immediately with the seeded run so the caller
 * can subscribe to `/api/runs/:id/events` and watch it unfold.
 */
export async function startRun(
  tenantId: string,
  input: AskInput,
  createdByUserId: string | null = null,
): Promise<Run> {
  const resolved = resolvePanel(input.providers)

  const seeds: CandidateSeed[] = resolved.map((provider) => ({
    provider: provider.spec.id,
    label: provider.spec.label,
    model: provider.modelId,
    status: provider.model ? "PENDING" : "SKIPPED",
    error: provider.model ? null : provider.hint,
  }))

  const run = await createRun({
    tenantId,
    createdByUserId,
    prompt: input.prompt,
    temperature: input.temperature,
    candidates: seeds,
  })

  const ctx = contextFor(tenantId, run.id)
  ctx.emit({ type: "run.snapshot", run })

  const available = resolved.filter((provider) => provider.model !== null)
  if (available.length === 0) {
    const message =
      "No AI provider is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY and/or " +
      "GOOGLE_GENERATIVE_AI_API_KEY — or a single AI_GATEWAY_API_KEY — and restart the server."
    await failRun(tenantId, run.id, message)
    ctx.emit({ type: "run.failed", runId: run.id, error: message })
    return (await getRun(tenantId, run.id)) ?? run
  }

  const panel = new Map(available.map((provider) => [provider.spec.id, provider]))
  void executeRun(ctx, run, panel, input.temperature).catch((error: unknown) => {
    console.error("[orchestrator] unhandled run failure", error)
  })

  return run
}
