import type { RunJobHandlers } from "@sce/queue"
import { processCandidateJob } from "./candidate.ts"
import { processSynthesisJob } from "./synthesis.ts"

/**
 * The two processors, as one object.
 *
 * Both the queued path (BullMQ workers) and the in-process path
 * (`RUN_TRANSPORT=local`) execute *these* functions. Sharing them is what makes
 * the local path a genuine migration flag rather than a second implementation
 * that drifts: a behaviour proven under `local` in a test is the same behaviour
 * that runs in production under `redis`.
 */
export const runJobHandlers: RunJobHandlers = {
  candidate: processCandidateJob,
  synthesis: processSynthesisJob,
}

export { processCandidateJob, processSynthesisJob }
