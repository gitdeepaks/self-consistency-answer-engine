import {
  cancelPendingCandidates,
  completeRun,
  failRun,
  getRun,
  recordUsage,
  saveSynthesis,
  setRunStatus,
} from "@sce/db"
import type { JobMeta } from "@sce/queue"
import {
  assertNever,
  describeError,
  isTerminalRunStatus,
  synthesisOutputSchema,
  type Candidate,
  type CandidateReview,
  type Run,
  type SynthesisJob,
} from "@sce/shared"
import { Output, generateText } from "ai"
import {
  anySignal,
  cancellationSignal,
  checkStop,
  contextFor,
  timeoutSignal,
  type RunContext,
} from "./context.ts"
import { workerConfig } from "./env.ts"
import { EVALUATOR_SYSTEM_PROMPT, buildEvaluatorPrompt } from "./prompts.ts"
import { resolveEvaluator } from "./providers.ts"
import { classify, recordProviderOutcome, withBulkhead } from "./resilience.ts"

/**
 * Compare the candidates and write the final answer.
 *
 * This is the flow's parent job: the queue holds it until every candidate has
 * settled, then delivers it once. It reads the run back from the database
 * rather than from its children's return values, which is what makes it
 * resumable — a synthesis retried an hour after a worker crash sees exactly the
 * candidates that exist now, not a snapshot of what existed then.
 */
export async function processSynthesisJob(job: SynthesisJob, meta: JobMeta): Promise<void> {
  const { tenantId, runId } = job
  const ctx = contextFor(tenantId, runId)

  const run = await getRun(tenantId, runId)
  if (!run) return
  // A redelivery after the run already concluded must not rewrite its outcome.
  if (isTerminalRunStatus(run.status)) return

  const stop = await checkStop(tenantId, runId)
  if (stop) {
    switch (stop.kind) {
      case "canceled":
        await cancelPendingCandidates(tenantId, runId, stop.message)
        await ctx.emit({ type: "run.canceled", runId, reason: stop.message })
        return
      case "deadline":
      case "budget":
        await concludeFailed(ctx, stop.message)
        return
      case "finished":
      case "missing":
        return
      default:
        return assertNever(stop, "processSynthesisJob")
    }
  }

  const succeeded = run.candidates.filter((candidate) => candidate.status === "OK")
  if (succeeded.length === 0) {
    await concludeFailed(ctx, `Every model in the panel failed — ${reasons(run.candidates)}`)
    return
  }

  await setRunStatus(tenantId, runId, "SYNTHESIZING")
  await ctx.emit({ type: "run.status", runId, status: "SYNTHESIZING" })

  try {
    const synthesis = await synthesize(ctx, meta, run, succeeded)
    await ctx.emit({ type: "synthesis.settled", runId, synthesis })

    const totalLatencyMs = Date.now() - new Date(run.createdAt).getTime()
    await completeRun(tenantId, runId, totalLatencyMs)
    await ctx.emit({ type: "run.completed", runId, totalLatencyMs })
  } catch (error) {
    if (error instanceof RetrySynthesis) throw error.cause
    await concludeFailed(ctx, describeError(error))
  }
}

/** Thrown to hand a retryable evaluator failure back to the queue's backoff. */
class RetrySynthesis extends Error {
  override readonly cause: unknown

  constructor(cause: unknown) {
    super("synthesis is retryable")
    this.name = "RetrySynthesis"
    this.cause = cause
  }
}

function reasons(candidates: readonly Candidate[]): string {
  return candidates
    .map((candidate) => `${candidate.label}: ${candidate.error ?? "unknown error"}`)
    .join(" | ")
}

async function concludeFailed(ctx: RunContext, message: string): Promise<void> {
  await failRun(ctx.tenantId, ctx.runId, message).catch((error: unknown) => {
    console.error("[worker] failed to mark run failed", { runId: ctx.runId, error })
  })
  await ctx.emit({ type: "run.failed", runId: ctx.runId, error: message })
}

/* ------------------------------------------------------------ the evaluator */

async function synthesize(
  ctx: RunContext,
  meta: JobMeta,
  run: Run,
  candidates: readonly Candidate[],
): ReturnType<typeof saveSynthesis> {
  const evaluator = resolveEvaluator()
  if (!evaluator.model) {
    throw new Error(
      evaluator.hint ?? "No evaluator model is configured; cannot synthesise a final answer.",
    )
  }
  const model = evaluator.model

  await ctx.emit({ type: "synthesis.started", runId: ctx.runId, model: evaluator.modelId })

  const startedAt = performance.now()
  const timeout = timeoutSignal(workerConfig.EVALUATOR_TIMEOUT_MS, "Evaluator call")
  const cancellation = await cancellationSignal(ctx.tenantId, ctx.runId)
  const combined = anySignal([timeout.signal, cancellation.signal])
  const outputTokenCap = workerConfig.MAX_OUTPUT_TOKENS * 2

  try {
    const result = await withBulkhead(evaluator.spec.id, () =>
      generateText({
        model,
        system: EVALUATOR_SYSTEM_PROMPT,
        prompt: buildEvaluatorPrompt(run.prompt, [...candidates]),
        output: Output.object({ schema: synthesisOutputSchema }),
        maxOutputTokens: outputTokenCap,
        maxRetries: workerConfig.MAX_RETRIES,
        abortSignal: combined.signal,
      }),
    )

    // Structured output is only parsed on a clean stop. Hitting the token cap
    // yields a truncated JSON object, which surfaces as an unhelpful
    // "no output generated" — name the real cause instead.
    if (result.finishReason === "length") {
      throw new Error(
        `Evaluator hit the ${outputTokenCap} output-token cap before finishing. ` +
          "Raise MAX_OUTPUT_TOKENS or ask a narrower question.",
      )
    }

    const { output, usage } = result
    const finalAnswer = output.finalAnswer.trim()
    if (finalAnswer.length === 0) throw new Error("Evaluator returned an empty final answer")

    await recordProviderOutcome(evaluator.spec.id, { ok: true })

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

    await meterEvaluator(ctx, evaluator.spec.id, evaluator.modelId, usage)
    return synthesis
  } catch (error) {
    await recordProviderOutcome(evaluator.spec.id, { ok: false, error })

    if (cancellation.signal.aborted) {
      throw new Error("Synthesis canceled by request")
    }
    // A retryable evaluator failure is worth another attempt: unlike the
    // fan-out, there is no partial result to preserve and no second evaluator
    // to fall back on, so giving up early throws the whole run away.
    if (
      !timeout.signal.aborted &&
      !meta.isFinalAttempt &&
      classify(error).kind === "retryable"
    ) {
      throw new RetrySynthesis(error)
    }

    const reason = timeout.signal.aborted
      ? `Evaluator call exceeded its ${Math.round(workerConfig.EVALUATOR_TIMEOUT_MS / 1000)}s budget`
      : describeError(error)
    throw new Error(`Synthesis failed — ${reason}`)
  } finally {
    timeout.clear()
    combined.clear()
    await cancellation.clear()
  }
}

/** Keep exactly one review per candidate, so a UI can align them 1:1. */
function normaliseReviews(
  reviews: readonly CandidateReview[],
  candidates: readonly Candidate[],
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

async function meterEvaluator(
  ctx: RunContext,
  provider: Parameters<typeof recordUsage>[0]["provider"],
  model: string,
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined },
): Promise<void> {
  try {
    await recordUsage({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      kind: "EVALUATOR",
      provider,
      model,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    })
  } catch (error) {
    console.error("[worker] failed to record evaluator usage", {
      runId: ctx.runId,
      model,
      error: describeError(error),
    })
  }
}
