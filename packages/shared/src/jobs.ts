import { z } from "zod";

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
export const traceCarrierSchema = z.object({
  traceparent: z.string().regex(/^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/).optional(),
  tracestate: z.string().max(512).refine((value) => {
    const entries = value.split(",").map((entry) => entry.trim())
    return entries.length <= 32 && new Set(entries.map((entry) => entry.split("=")[0])).size === entries.length && entries.every((entry) => /^(?:[a-z][a-z0-9_*\/-]{0,255}|[a-z0-9][a-z0-9_*\/-]{0,240}@[a-z][a-z0-9_*\/-]{0,13})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/.test(entry))
  }).optional(),
});

export const candidateJobSchema = z.object({
  traceContext: traceCarrierSchema.optional(),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  candidateId: z.string().min(1),
});
export type CandidateJob = z.infer<typeof candidateJobSchema>;

/** Compare the settled candidates and write the final answer. One per run. */
export const synthesisJobSchema = z.object({
  traceContext: traceCarrierSchema.optional(),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
});
export type SynthesisJob = z.infer<typeof synthesisJobSchema>;

/** Job names, used for logs, metrics and the BullMQ dashboard. */
export const CANDIDATE_JOB_NAME = "candidate";
export const SYNTHESIS_JOB_NAME = "synthesis";

/**
 * Deliver one outbound webhook.
 *
 * The payload is an identifier, like every other job in this file: the event
 * body, the target URL and the signing secret all live on the `WebhookDispatch`
 * row, so a delivery retried an hour later signs with the secret that is
 * current then rather than replaying one that has since been rotated away.
 */
export const webhookJobSchema = z.object({
  traceContext: traceCarrierSchema.optional(),
  tenantId: z.string().min(1),
  deliveryId: z.string().min(1),
});
export type WebhookJob = z.infer<typeof webhookJobSchema>;

export const WEBHOOK_JOB_NAME = "webhook";
