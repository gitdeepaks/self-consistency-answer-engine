import type { RunJobHandlers } from "@sce/queue";
import { withSpan } from "@sce/observability";
import type { CandidateJob, SynthesisJob } from "@sce/shared";
import { processCandidateJob } from "./candidate.ts";
import { processSynthesisJob } from "./synthesis.ts";

/**
 * The two processors, as one object.
 *
 * Both the queued path (BullMQ workers) and the in-process path
 * (`RUN_TRANSPORT=local`) execute *these* functions. Sharing them is what makes
 * the local path a genuine migration flag rather than a second implementation
 * that drifts: a behaviour proven under `local` in a test is the same behaviour
 * that runs in production under `redis`.
 */
export const runJobHandlers = {
  candidate: (job: CandidateJob, meta) =>
    withSpan("worker.candidate", {
      "run.id": job.runId, "candidate.id": job.candidateId,
      "job.id": meta.id, "job.attempt": meta.attempt, "job.max_attempts": meta.maxAttempts,
    }, () => processCandidateJob(job, meta)),
  synthesis: (job: SynthesisJob, meta) =>
    withSpan("worker.synthesis", {
      "run.id": job.runId, "job.id": meta.id,
      "job.attempt": meta.attempt, "job.max_attempts": meta.maxAttempts,
    }, () => processSynthesisJob(job, meta)),
} satisfies RunJobHandlers;

export { processCandidateJob, processSynthesisJob };
