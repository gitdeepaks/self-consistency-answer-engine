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

export const runFeedbackSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** Null for feedback left by a key-only credential, which has no person. */
  userId: z.string().nullable(),
  rating: feedbackRatingSchema,
  reason: feedbackReasonSchema.nullable(),
  note: z.string().nullable(),
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
