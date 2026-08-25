import { z } from "zod"

/**
 * Queue job payloads.
 *
 * A job payload is a trust boundary: it is written by one process, serialised
 * through Redis, and read minutes or hours later by a different process running
 * a possibly different build. So it is parsed on the way in, exactly like an
 * HTTP body — never trusted because "we wrote it ourselves".
 *
 * These payloads are deliberately **minimal identifiers, not snapshots**. The
 * prompt, the panel, the temperature and the deadline all live on the `Run`
 * row, so a job that is retried after a crash reads current state rather than
 * replaying a stale copy of it. That is what makes the pipeline resumable: the
 * database is the single source of truth and the queue only says *what to do
 * next*, never *what the world looked like*.
 */

/** Fan out one panel member. One of these per candidate row. */
export const candidateJobSchema = z.object({
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  candidateId: z.string().min(1),
})
export type CandidateJob = z.infer<typeof candidateJobSchema>

/** Compare the settled candidates and write the final answer. One per run. */
export const synthesisJobSchema = z.object({
  tenantId: z.string().min(1),
  runId: z.string().min(1),
})
export type SynthesisJob = z.infer<typeof synthesisJobSchema>

/** Job names, used for logs, metrics and the BullMQ dashboard. */
export const CANDIDATE_JOB_NAME = "candidate"
export const SYNTHESIS_JOB_NAME = "synthesis"
