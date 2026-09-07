import { z } from "zod"
import { assertNever } from "./assert.ts"

/**
 * Human judgement on a run.
 *
 * This is the cheapest ground truth the product will ever get, and its purpose
 * is not a satisfaction metric — it is the input to Phase 7's eval set. A
 * thumbs-down with a sentence attached is a labelled failure case that cost
 * nothing to collect, which is why the note is stored verbatim and the triage
 * queue below exists.
 *
 * One verdict per person per run, upserted rather than appended: a user who
 * changes their mind is correcting a label, not adding a second one, and a
 * table of contradictory opinions from the same person is not a dataset.
 */

export const feedbackRatingSchema = z.enum(["up", "down"])
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>

/**
 * Why an answer was wrong, in the coarse buckets a person will actually pick.
 *
 * `off_topic` rather than the prettier `off-topic` because these labels are
 * also the Postgres enum, and a Prisma enum member cannot contain a hyphen. The
 * alternative is a `@map` and therefore a mapping layer between the database
 * and this union — which is exactly where the two would eventually drift, the
 * same argument `ProviderId` and `AuditAction` are spelled out under in
 * `schema.prisma`. The wire format follows the storage here, not the other way
 * round.
 */
export const feedbackReasonSchema = z.enum([
  "incorrect",
  "incomplete",
  "off_topic",
  "unsafe",
  "formatting",
  "other",
])
export type FeedbackReason = z.infer<typeof feedbackReasonSchema>

/** A sentence for the triage queue, so a reason is a heading and not a mystery. */
export function describeFeedbackReason(reason: FeedbackReason): string {
  switch (reason) {
    case "incorrect":
      return "Factually wrong"
    case "incomplete":
      return "Missed part of the question"
    case "off_topic":
      return "Answered something else"
    case "unsafe":
      return "Unsafe or inappropriate"
    case "formatting":
      return "Badly formatted"
    case "other":
      return "Something else"
    default:
      return assertNever(reason, "describeFeedbackReason")
  }
}

/**
 * Where a verdict has got to in the eval triage queue.
 *
 * A thumbs-down is a lead, not a conclusion. Somebody has to read it and decide
 * whether the answer really was wrong — and that decision is the thing worth
 * recording, because an untriaged pile of complaints is not a dataset either.
 *
 *   `open`       nobody has looked at it yet;
 *   `accepted`   a real failure, and worth a golden-set entry;
 *   `dismissed`  the answer was fine, or the report is unusable;
 *   `promoted`   an eval case has been written from it — the terminal state.
 *
 * Lowercase to match `rating` and `reason` above: these three enums are read
 * together in the same queue, and a mixed-case family reads as an accident.
 */
export const feedbackTriageStatusSchema = z.enum(["open", "accepted", "dismissed", "promoted"])
export type FeedbackTriageStatus = z.infer<typeof feedbackTriageStatusSchema>

export function describeFeedbackTriageStatus(status: FeedbackTriageStatus): string {
  switch (status) {
    case "open":
      return "Not yet reviewed"
    case "accepted":
      return "Confirmed failure"
    case "dismissed":
      return "Not a failure"
    case "promoted":
      return "Added to the eval set"
    default:
      return assertNever(status, "describeFeedbackTriageStatus")
  }
}

export const runFeedbackSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Null for feedback left by a key-only credential, which has no person. */
  userId: z.string().nullable(),
  rating: feedbackRatingSchema,
  reason: feedbackReasonSchema.nullable(),
  note: z.string().nullable(),
  /** Where this verdict has got to in triage. `open` until somebody reads it. */
  triageStatus: feedbackTriageStatusSchema,
  triagedAt: z.string().nullable(),
  /** The reviewer, not the person who left the verdict. */
  triagedByUserId: z.string().nullable(),
  /** What the reviewer concluded — the sentence the golden-set entry is built from. */
  triageNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RunFeedback = z.infer<typeof runFeedbackSchema>

/**
 * What a client submits.
 *
 * `reason` and `note` are optional on purpose: the click is the signal worth
 * capturing, and a form that demands an explanation before it accepts a
 * thumbs-down collects far fewer thumbs-downs. Detail is invited, never
 * required.
 */
export const submitFeedbackInputSchema = z.object({
  rating: feedbackRatingSchema,
  reason: feedbackReasonSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
})
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackInputSchema>

/** Aggregate verdict on a run, for a list view that cannot show every note. */
export const feedbackSummarySchema = z.object({
  up: z.number().int().nonnegative(),
  down: z.number().int().nonnegative(),
  /** The calling user's own verdict, or null if they have not given one. */
  mine: runFeedbackSchema.nullable(),
})
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>

/**
 * A triage decision.
 *
 * Separate from `submitFeedbackInput` because it is a different act by a
 * different person: the customer says an answer was wrong, and somebody on the
 * team decides whether it was. Conflating the two would let a reviewer's
 * conclusion overwrite the report it was drawn from.
 */
export const triageFeedbackInputSchema = z.object({
  status: feedbackTriageStatusSchema,
  note: z.string().trim().min(1).max(2000).optional(),
})
export type TriageFeedbackInput = z.infer<typeof triageFeedbackInputSchema>

/** Filters on the triage queue. Defaults to the queue somebody actually works. */
export const feedbackQueueQuerySchema = z.object({
  rating: feedbackRatingSchema.default("down"),
  status: feedbackTriageStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type FeedbackQueueQuery = z.infer<typeof feedbackQueueQuerySchema>

/**
 * One row of the triage queue.
 *
 * Carries enough of the run to judge the verdict without a second request — the
 * prompt that was asked, what the engine said, and how sure it claimed to be.
 * The confidence is here because "wrong, and confident about it" is the
 * category worth reading first, and it is the pairing Phase 7's calibration
 * work is built on.
 */
export const feedbackTriageEntrySchema = z.object({
  feedback: runFeedbackSchema,
  runId: z.string(),
  runPrompt: z.string(),
  runStatus: z.string(),
  runCreatedAt: z.string(),
  confidence: z.number().nullable(),
  panelId: z.string().nullable(),
  promptSetId: z.string().nullable(),
})
export type FeedbackTriageEntry = z.infer<typeof feedbackTriageEntrySchema>
