import {
  cancelPendingCandidates,
  completeRun,
  failRun,
  getRun,
  recordUsage,
  saveSynthesis,
  setRunStatus,
} from "@sce/db";
import type { JobMeta } from "@sce/queue";
import {
  applyCalibration,
  assertNever,
  describeError,
  isTerminalRunStatus,
  resolvePanelConfig,
  synthesisOutputSchema,
  type Candidate,
  type CandidateReview,
  type PanelConfig,
  type Run,
  type SynthesisJob,
} from "@sce/shared";
import { Output, generateText } from "ai";
import { aiTelemetry, logger, metrics, withSpan } from "@sce/observability";
import { providerCompleted, runCompleted, usageRecorded } from "./telemetry.ts";
import {
  anySignal,
  cancellationSignal,
  checkStop,
  contextFor,
  timeoutSignal,
  type RunContext,
} from "./context.ts";
import { workerConfig } from "./env.ts";
import { emitRunWebhook } from "./webhooks.ts";
import { buildEvaluatorPrompt, promptsFor } from "./prompts.ts";
import { resolveEvaluator } from "./providers.ts";
import { classify, recordProviderOutcome, withBulkhead } from "./resilience.ts";

/**
 * Compare the candidates and write the final answer.
 *
 * This is the flow's parent job: the queue holds it until every candidate has
 * settled, then delivers it once. It reads the run back from the database
 * rather than from its children's return values, which is what makes it
 * resumable — a synthesis retried an hour after a worker crash sees exactly the
 * candidates that exist now, not a snapshot of what existed then.
 */
export async function processSynthesisJob(
  job: SynthesisJob,
  meta: JobMeta,
): Promise<void> {
  const { tenantId, runId } = job;
  const ctx = contextFor(tenantId, runId);

  const run = await getRun(tenantId, runId);
  if (!run) return;
  // A redelivery after the run already concluded must not rewrite its outcome.
  if (isTerminalRunStatus(run.status)) {
    await announce(tenantId, runId);
    return;
  }

  // A durable synthesis needs no more spending, but cancellation/deadline still apply.
  const stop = await checkStop(tenantId, runId, new Date(), run.synthesis === null);
  if (stop) {
    switch (stop.kind) {
      case "canceled":
        await cancelPendingCandidates(tenantId, runId, stop.message);
        await ctx.emit({ type: "run.canceled", runId, reason: stop.message });
        return;
      case "deadline":
      case "budget":
      case "halted":
        await concludeFailed(ctx, stop.message);
        return;
      case "finished":
        await announce(tenantId, runId);
        return;
      case "missing":
        return;
      default:
        return assertNever(stop, "processSynthesisJob");
    }
  }

  const succeeded = run.candidates.filter(
    (candidate) => candidate.status === "OK",
  );
  if (run.synthesis === null && succeeded.length === 0) {
    await concludeFailed(
      ctx,
      `Every model in the panel failed — ${reasons(run.candidates)}`,
    );
    return;
  }

  if (run.synthesis === null) {
    await setRunStatus(tenantId, runId, "SYNTHESIZING");
    await ctx.emit({ type: "run.status", runId, status: "SYNTHESIZING" });
  }

  let synthesis: Awaited<ReturnType<typeof saveSynthesis>>;
  try {
    // Resume after a persisted synthesis rather than paying for it again.
    synthesis = run.synthesis ?? await synthesize(ctx, meta, run, succeeded);
  } catch (error) {
    if (error instanceof RetrySynthesis) throw error.cause;
    await concludeFailed(ctx, describeError(error));
    return;
  }
  await ctx.emit({ type: "synthesis.settled", runId, synthesis });
  const totalLatencyMs = Date.now() - new Date(run.createdAt).getTime();
  const won = await withSpan("worker.run.persist", { "run.id": runId }, () => completeRun(tenantId, runId, totalLatencyMs));
  if (won) runCompleted("complete", run.createdAt);
  try {
    if (won) await ctx.emit({ type: "run.completed", runId, totalLatencyMs });
  } finally {
    await announce(tenantId, runId);
  }
}

/** Thrown to hand a retryable evaluator failure back to the queue's backoff. */
class RetrySynthesis extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("synthesis is retryable");
    this.name = "RetrySynthesis";
    this.cause = cause;
  }
}

function reasons(candidates: readonly Candidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.label}: ${candidate.error ?? "unknown error"}`,
    )
    .join(" | ");
}

async function concludeFailed(ctx: RunContext, message: string): Promise<void> {
  const run = await getRun(ctx.tenantId, ctx.runId);
  if (!run) return;
  const won = await withSpan("worker.run.persist", { "run.id": ctx.runId }, () => failRun(ctx.tenantId, ctx.runId, message));
  if (won) {
    if (run.synthesis === null) metrics.count("sce.synthesis.completed", 1, { outcome: "failure" });
    runCompleted("failed", run.createdAt);
  }
  try {
    if (won) await ctx.emit({ type: "run.failed", runId: ctx.runId, error: message });
  } finally {
    await announce(ctx.tenantId, ctx.runId);
  }
}

/**
 * Tell any registered webhook endpoint that the run reached its end.
 *
 * The run is re-read rather than assembled from what this function happens to
 * know, so the summary a customer receives is the same one `GET /v1/runs/{id}`
 * would return a moment later — a webhook that disagrees with the API it points
 * at is worse than no webhook.
 *
 * Retry a failed outbox write, not a failed HTTP delivery. Terminal redelivery
 * comes straight here without paying for the evaluator again. Dispatch uses a
 * stable event ID and a unique endpoint/event key, so retries are idempotent.
 */
async function announce(tenantId: string, runId: string): Promise<void> {
  const run = await getRun(tenantId, runId);
  if (run !== null) await emitRunWebhook(run, tenantId, true);
}

/* ------------------------------------------------------------ the evaluator */

async function synthesize(
  ctx: RunContext,
  meta: JobMeta,
  run: Run,
  candidates: readonly Candidate[],
): ReturnType<typeof saveSynthesis> {
  // The panel names the evaluator, and the prompt set names the wording — both
  // are properties of the run, not of whatever this worker's environment says
  // today. An unknown id in either is an error rather than a fallback, for the
  // same reason: the alternative silently answers the question a different way
  // than the run recorded.
  const panel = panelFor(run.panelId);
  const prompts = promptsFor(run.promptSetId);

  const evaluator = resolveEvaluator(panel);
  if (!evaluator.model) {
    throw new Error(
      evaluator.hint ??
        "No evaluator model is configured; cannot synthesise a final answer.",
    );
  }
  const model = evaluator.model;

  await ctx.emit({
    type: "synthesis.started",
    runId: ctx.runId,
    model: evaluator.modelId,
  }).catch((error) => {
    throw new RetrySynthesis(error);
  });

  let startedAt = 0;
  let providerFinished = false;
  const timeout = timeoutSignal(
    workerConfig.EVALUATOR_TIMEOUT_MS,
    "Evaluator call",
  );
  const cancellation = await cancellationSignal(ctx.tenantId, ctx.runId).catch((error) => {
    timeout.clear();
    throw new RetrySynthesis(error);
  });
  const combined = anySignal([timeout.signal, cancellation.signal]);
  const outputTokenCap = workerConfig.MAX_OUTPUT_TOKENS * 2;

  try {
    const result = await withBulkhead(evaluator.spec.id, () => {
      startedAt = performance.now();
      return generateText({
        model,
        experimental_telemetry: aiTelemetry("worker.synthesis"),
        system: prompts.evaluator.text,
        prompt: buildEvaluatorPrompt(run.prompt, [...candidates]),
        output: Output.object({ schema: synthesisOutputSchema }),
        maxOutputTokens: outputTokenCap,
        maxRetries: workerConfig.MAX_RETRIES,
        abortSignal: combined.signal,
      });
    });

    // Structured output is only parsed on a clean stop. Hitting the token cap
    // yields a truncated JSON object, which surfaces as an unhelpful
    // "no output generated" — name the real cause instead.
    if (result.finishReason === "length") {
      throw new Error(
        `Evaluator hit the ${outputTokenCap} output-token cap before finishing. ` +
          "Raise MAX_OUTPUT_TOKENS or ask a narrower question.",
      );
    }

    const { output, usage } = result;
    const finalAnswer = output.finalAnswer.trim();
    if (finalAnswer.length === 0)
      throw new Error("Evaluator returned an empty final answer");

    providerFinished = true;
    const latencyMs = Math.round(performance.now() - startedAt);
    providerCompleted(evaluator.spec.id, "synthesis", "success", startedAt);
    await recordProviderOutcome(evaluator.spec.id, { ok: true });
    await meterEvaluator(ctx, evaluator.spec.id, evaluator.modelId, usage);

    // The raw confidence is stored unchanged and the corrected reading beside
    // it. Replacing one with the other would make the correction impossible to
    // ever check — and the map is refitted from exactly this column.
    const calibration = workerConfig.CONFIDENCE_CALIBRATION;

    const synthesis = await withSpan("worker.synthesis.persist", { "run.id": ctx.runId }, () => saveSynthesis(ctx.tenantId, ctx.runId, {
      model: evaluator.modelId,
      finalAnswer,
      agreements: output.agreements,
      disagreements: output.disagreements,
      reviews: normaliseReviews(output.reviews, candidates),
      confidence: output.confidence,
      calibratedConfidence:
        calibration === null ? null : applyCalibration(calibration, output.confidence),
      calibrationId: calibration?.id ?? null,
      latencyMs,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    }));
    metrics.count("sce.synthesis.completed", 1, { outcome: "success" });
    return synthesis;
  } catch (error) {
    // Storage/breaker failures belong to queue retry, not provider health.
    if (providerFinished) throw new RetrySynthesis(error);
    providerCompleted(evaluator.spec.id, "synthesis", cancellation.signal.aborted ? "canceled" : timeout.signal.aborted ? "timeout" : "failure", startedAt);
    await recordProviderOutcome(evaluator.spec.id, { ok: false, error }).catch((storageError) => {
      throw new RetrySynthesis(storageError);
    });

    if (cancellation.signal.aborted) {
      throw new Error("Synthesis canceled by request");
    }
    // A retryable evaluator failure is worth another attempt: unlike the
    // fan-out, there is no partial result to preserve and no second evaluator
    // to fall back on, so giving up early throws the whole run away.
    if (
      !timeout.signal.aborted &&
      !meta.isFinalAttempt &&
      classify(error).kind === "retryable"
    ) {
      throw new RetrySynthesis(error);
    }

    const reason = timeout.signal.aborted
      ? `Evaluator call exceeded its ${Math.round(workerConfig.EVALUATOR_TIMEOUT_MS / 1000)}s budget`
      : describeError(error);
    throw new Error(`Synthesis failed — ${reason}`);
  } finally {
    timeout.clear();
    combined.clear();
    await cancellation.clear().catch((error) => { throw new RetrySynthesis(error); });
  }
}

/**
 * Keep exactly one review per candidate, so a UI can align them 1:1.
 *
 * Matched on the **label**, falling back to the provider. Provider alone stopped
 * identifying a candidate when a panel became able to draw two samples from one
 * model: "OpenAI" is then two answers with two different scores, and keying a
 * map on it silently discards one of them and shows the other twice. The
 * fallback covers an evaluator that echoed the provider id where a label was
 * asked for, and consumes each matched review so two candidates from one
 * provider cannot both fall back onto the same one.
 */
function normaliseReviews(
  reviews: readonly CandidateReview[],
  candidates: readonly Candidate[],
): CandidateReview[] {
  const byLabel = new Map(reviews.map((review) => [review.label, review]));
  const unmatched = reviews.filter((review) => !candidates.some((c) => c.label === review.label));

  return candidates.map((candidate) => {
    const matched = byLabel.get(candidate.label);
    if (matched !== undefined) return { ...matched, provider: candidate.provider };

    const index = unmatched.findIndex((review) => review.provider === candidate.provider);
    const fallback = index === -1 ? undefined : unmatched.splice(index, 1)[0];
    if (fallback !== undefined) return { ...fallback, label: candidate.label };

    return {
      provider: candidate.provider,
      label: candidate.label,
      score: 0,
      strengths: [],
      weaknesses: ["The evaluator did not return a review for this candidate."],
    };
  });
}

/**
 * The panel a run was created under.
 *
 * Null means "created before panels existed", which resolves to the default —
 * the panel those runs actually used. An unknown id is an error, exactly as an
 * unknown prompt set is: it means this worker is older than the run.
 */
function panelFor(panelId: string | null): PanelConfig {
  const panel = resolvePanelConfig(panelId);
  if (panel === null) {
    throw new Error(
      `This run was created with panel "${panelId}", which this build does not know. ` +
        "Deploy the release that introduced it, or re-run the question.",
    );
  }
  return panel;
}

async function meterEvaluator(
  ctx: RunContext,
  provider: Parameters<typeof recordUsage>[0]["provider"],
  model: string,
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
  },
): Promise<void> {
  try {
    const recorded = await withSpan("worker.usage.persist", { "run.id": ctx.runId }, () => recordUsage({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      kind: "EVALUATOR",
      provider,
      model,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    }));
    usageRecorded(recorded);
  } catch {
    logger.error("[worker] failed to record evaluator usage", {
      runId: ctx.runId,
      model,
    });
  }
}
