import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as db from "@sce/db";
import * as observation from "@sce/observability";
import { localJobMeta } from "@sce/queue";
import type { Candidate, Run } from "@sce/shared";
import { MockLanguageModelV4 } from "ai/test";
import * as context from "./context.ts";
import * as providers from "./providers.ts";
import { runJobHandlers } from "./handlers.ts";
import { MemoryBreakerStore, setBreakerStore } from "./resilience.ts";
import { providerCompleted, runCompleted } from "./telemetry.ts";

const candidate: Candidate = {
  id: "candidate-private", provider: "openai", label: "OpenAI", model: "mock",
  status: "PENDING", content: null, error: null, latencyMs: null,
  inputTokens: null, outputTokens: null, attempts: 0,
};
let run: Run;
const job = { tenantId: "tenant-private", runId: "run-private", candidateId: candidate.id };
const meta = localJobMeta("job-private");

beforeEach(() => {
  run = {
    id: job.runId, createdByUserId: null, prompt: "PRIVATE PROMPT", status: "QUEUED",
    error: null, totalLatencyMs: null, temperature: null,
    createdAt: new Date(Date.now() - 2000).toISOString(), completedAt: null,
    deadlineAt: null, canceledAt: null, promptSetId: null, panelId: null,
    experimentId: null, variantId: null, cachedFromRunId: null, tags: [],
    candidates: [{ ...candidate }], synthesis: null,
  };
  spyOn(db, "getRun").mockImplementation(async () => run);
  spyOn(db, "setRunStatus").mockResolvedValue(undefined);
  spyOn(db, "setCandidateRunning").mockResolvedValue({ ...candidate, status: "RUNNING" });
  spyOn(context, "checkStop").mockResolvedValue(null);
  spyOn(context, "contextFor").mockReturnValue({ ...job, emit: async () => {} });
  spyOn(context, "cancellationSignal").mockResolvedValue({
    signal: new AbortController().signal, clear: async () => {},
  });
  setBreakerStore(new MemoryBreakerStore());
  const provider = providers.resolveProvider("openai", "mock");
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "0" });
          controller.enqueue({ type: "text-delta", id: "0", delta: "PRIVATE ANSWER" });
          controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {
            inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 22, text: 22, reasoning: 0 },
          } });
          controller.close();
        },
      }),
    }),
  });
  spyOn(providers, "resolveProvider").mockReturnValue({ ...provider, model });
  spyOn(providers, "resolveEvaluator").mockReturnValue({
    ...provider, model: new MockLanguageModelV4({ doGenerate: async () => { throw new Error("PRIVATE provider error"); } }),
  });
  spyOn(db, "recordUsage").mockResolvedValue({
    id: "usage-private", runId: job.runId,
    kind: "CANDIDATE", provider: "openai", model: "mock", inputTokens: 11,
    outputTokens: 22, costMicroCents: 123, priceId: null, createdAt: run.createdAt,
  });
  spyOn(db, "settleCandidate").mockImplementation(async () => {
    const settled: Candidate = { ...candidate, status: "OK" };
    run.candidates = [settled];
    return settled;
  });
  // `failRun`/`completeRun` return whether *this* call won the terminal
  // transition; the completion metrics are gated on that, so a mock that
  // resolves `undefined` silently suppresses every completion count.
  spyOn(db, "failRun").mockImplementation(async () => {
    const won = run.status !== "FAILED";
    run.status = "FAILED";
    return won;
  });
  spyOn(db, "dispatchWebhookEvent").mockResolvedValue([]);
});

afterEach(() => { mock.restore(); setBreakerStore(null); });

test("candidate success and synthesis failure are distinct; redelivery adds no completions", async () => {
  const calls = spyOn(observation.metrics, "count");
  await runJobHandlers.candidate(job, meta);
  await runJobHandlers.synthesis(job, meta);
  expect(calls).toHaveBeenCalledWith("sce.candidate.completed", 1, { outcome: "OK" });
  expect(calls).toHaveBeenCalledWith("sce.synthesis.completed", 1, { outcome: "failure" });
  expect(calls).toHaveBeenCalledWith("sce.run.completed", 1, { outcome: "failed" });
  expect(calls).toHaveBeenCalledWith("sce.provider.calls", 1, { provider: "openai", operation: "candidate", outcome: "success" });
  expect(calls).toHaveBeenCalledWith("sce.provider.calls", 1, { provider: "openai", operation: "synthesis", outcome: "failure" });
  expect(calls).toHaveBeenCalledWith("sce.tokens", 11, { provider: "openai", direction: "input" });
  expect(calls).toHaveBeenCalledWith("sce.cost.microcents", 123, { provider: "openai" });
  const before = calls.mock.calls.length;
  await runJobHandlers.candidate(job, meta);
  await runJobHandlers.synthesis(job, meta);
  expect(calls.mock.calls).toHaveLength(before);
  expect(JSON.stringify(calls.mock.calls)).not.toContain("private");
  expect(JSON.stringify(calls.mock.calls)).not.toContain("PRIVATE");
});

test("candidate persistence failure does not become a provider failure or completion", async () => {
  const calls = spyOn(observation.metrics, "count");
  spyOn(db, "settleCandidate").mockRejectedValue(new Error("PRIVATE database error"));
  await expect(runJobHandlers.candidate(job, meta)).rejects.toThrow("PRIVATE database error");
  expect(calls.mock.calls.filter(([name]) => name === "sce.provider.calls")).toEqual([
    ["sce.provider.calls", 1, { provider: "openai", operation: "candidate", outcome: "success" }],
  ]);
  expect(calls.mock.calls.filter(([name]) => name === "sce.candidate.completed")).toHaveLength(0);
});

test("usage persistence errors log no raw error and do not fabricate cost", async () => {
  spyOn(db, "recordUsage").mockRejectedValue(new Error("PRIVATE PROMPT and provider credentials"));
  const log = spyOn(observation.logger, "error").mockImplementation(() => {});
  const calls = spyOn(observation.metrics, "count");
  await runJobHandlers.candidate(job, meta);
  expect(calls).toHaveBeenCalledWith("sce.candidate.completed", 1, { outcome: "OK" });
  expect(calls.mock.calls.filter(([name]) => name === "sce.cost.microcents")).toHaveLength(0);
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
});

test("deliveries nest under the delivery span and carry no prompt data", async () => {
  spyOn(db, "getRun").mockResolvedValue(null);
  const spans = spyOn(observation, "withSpan");
  const traceContext = { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" };
  await runJobHandlers.candidate({ ...job, traceContext }, { ...meta, attempt: 2 });
  expect(spans.mock.calls[0]?.[0]).toBe("worker.candidate");
  expect(spans.mock.calls[0]?.[1]).toMatchObject({ "job.attempt": 2, "run.id": job.runId, "candidate.id": candidate.id });
  /*
   * The carrier is extracted exactly once per delivery, by the `queue.*` span
   * that `@sce/queue` opens around this handler. Passing it a second time here
   * would re-parent `worker.candidate` onto the *enqueue* span, making it a
   * sibling of the delivery span that wraps it in wall-clock time — same trace,
   * wrong flame graph. Inheriting the ambient context is what keeps the run's
   * trace nested API -> enqueue -> delivery -> worker -> provider.
   */
  expect(spans.mock.calls[0]?.[3]).toBeUndefined();
  expect(JSON.stringify(spans.mock.calls[0]?.[1])).not.toContain("PRIVATE");
});

test("cached or already failed runs do not count worker completions", async () => {
  const calls = spyOn(observation.metrics, "count");
  run.status = "COMPLETE";
  run.cachedFromRunId = "cached-private";
  await runJobHandlers.synthesis(job, meta);
  run.status = "FAILED";
  await runJobHandlers.synthesis(job, meta);
  expect(calls).not.toHaveBeenCalled();
});

test("synthesis persistence failure preserves provider success and retries infrastructure", async () => {
  run.candidates = [{ ...candidate, status: "OK", content: "answer" }];
  const provider = providers.resolveProvider("openai", "mock");
  spyOn(providers, "resolveEvaluator").mockReturnValue({
    ...provider,
    model: new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({
        finalAnswer: "answer", agreements: [], disagreements: [], reviews: [], confidence: 0.8,
      }) }],
      finishReason: { unified: "stop", raw: "stop" }, warnings: [],
      usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 22, text: 22, reasoning: 0 } },
    }) }),
  });
  spyOn(db, "saveSynthesis").mockRejectedValue(new Error("PRIVATE storage error"));
  const calls = spyOn(observation.metrics, "count");
  await expect(runJobHandlers.synthesis(job, meta)).rejects.toThrow("PRIVATE storage error");
  expect(calls.mock.calls.filter(([name]) => name === "sce.provider.calls")).toEqual([
    ["sce.provider.calls", 1, { provider: "openai", operation: "synthesis", outcome: "success" }],
  ]);
  expect(calls.mock.calls.filter(([name]) => name === "sce.synthesis.completed" || name === "sce.run.completed")).toHaveLength(0);
  expect(run.status).toBe("QUEUED");
});

test("failed terminal persistence emits no completion", async () => {
  run.candidates = [];
  spyOn(db, "failRun").mockRejectedValue(new Error("storage unavailable"));
  const calls = spyOn(observation.metrics, "count");
  await expect(runJobHandlers.synthesis(job, meta)).rejects.toThrow("storage unavailable");
  expect(calls).not.toHaveBeenCalled();
});

test("redelivery resumes persisted synthesis without another provider call or synthesis completion", async () => {
  run.candidates = [{ ...candidate, status: "OK" }];
  run.synthesis = {
    id: "synthesis-private", model: "mock", finalAnswer: "PRIVATE ANSWER",
    agreements: [], disagreements: [], reviews: [], confidence: 0.8,
    calibratedConfidence: null, latencyMs: 10, inputTokens: 11, outputTokens: 22,
  };
  spyOn(db, "completeRun").mockImplementation(async () => {
    const won = run.status !== "COMPLETE";
    run.status = "COMPLETE";
    return won;
  });
  const calls = spyOn(observation.metrics, "count");
  await runJobHandlers.synthesis(job, meta);
  await runJobHandlers.synthesis(job, meta);
  expect(calls.mock.calls).toEqual([["sce.run.completed", 1, { outcome: "complete" }]]);
});

test("duration metrics use seconds and low-cardinality attributes", () => {
  const histogram = spyOn(observation.metrics, "histogram");
  providerCompleted("openai", "candidate", "success", performance.now() - 2000);
  runCompleted("complete", new Date(Date.now() - 2000).toISOString());
  expect(histogram.mock.calls).toHaveLength(2);
  for (const [, seconds] of histogram.mock.calls) {
    expect(seconds).toBeGreaterThanOrEqual(2);
    expect(seconds).toBeLessThan(3);
  }
  expect(histogram.mock.calls[0]?.[2]).toEqual({ provider: "openai", operation: "candidate" });
});
