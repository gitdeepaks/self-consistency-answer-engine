import { listPromotableFeedback, markFeedbackPromoted } from "@sce/db"
import { describeFeedbackReason, feedbackReasonSchema } from "@sce/shared"
import { stagedItemSchema, type StagedItem } from "./schema.ts"

/**
 * Closing the loop from a complaint to a test.
 *
 * A thumbs-down with a sentence attached is the cheapest labelled failure this
 * product will ever get: a real user, a real question, and a statement that the
 * answer was wrong. The path from there to a regression test has three steps,
 * and only the middle one requires a person:
 *
 *   1. a customer clicks thumbs-down;
 *   2. somebody reads it and marks it `accepted` — this answer really was wrong;
 *   3. this module exports the accepted ones as **staged items**, and marks them
 *      promoted so they are never exported twice.
 *
 * A staged item is deliberately *not* a golden item: it has no rubric, because
 * the export cannot write one. Knowing what a correct answer must contain is
 * exactly the judgement the person adding it supplies, and a generated rubric
 * would produce a test that passes whenever the model repeats itself.
 *
 * So the file this writes is a to-do list with the boring parts filled in. A
 * reviewer adds the rubric and moves the line into `data/goldens/`, which is
 * the point at which it starts gating releases.
 */

export interface ExportOptions {
  /** Ceiling on one export, so a backlog arrives in reviewable batches. */
  limit?: number
  /** Today, as the `addedAt` stamp. Injected so the output is reproducible. */
  today: string
}

/**
 * Turn accepted verdicts into staged items.
 *
 * Reads only — nothing is marked promoted here. `markExported` is a separate
 * call the CLI makes *after* the file is written, so a crash between the two
 * re-exports the batch rather than silently dropping it.
 */
export async function exportAcceptedFeedback(options: ExportOptions): Promise<StagedItem[]> {
  const entries = await listPromotableFeedback({
    scope: { kind: "every-tenant", reason: "the eval set is drawn from every workspace" },
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })

  return entries.map((entry) => {
    const reason = feedbackReasonSchema.safeParse(entry.feedback.reason)

    // A hint at the rubric, never a rubric. The reviewer writes the real one,
    // and the coarse reason plus the reporter's own words are what they need to
    // do it without opening the run.
    const notes = [
      reason.success ? `Reported as: ${describeFeedbackReason(reason.data)}` : null,
      entry.feedback.note === null ? null : `Reporter said: ${entry.feedback.note}`,
      entry.feedback.triageNote === null ? null : `Reviewer said: ${entry.feedback.triageNote}`,
      entry.confidence === null
        ? null
        : `The engine claimed ${(entry.confidence * 100).toFixed(0)}% confidence in the answer it got wrong.`,
    ].filter((line): line is string => line !== null)

    return stagedItemSchema.parse({
      // Prefixed and derived from the feedback id, so re-exporting the same
      // verdict twice produces the same item id and a diff a reviewer can see.
      id: `feedback-${entry.feedback.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`,
      // Uncategorised work is worse than miscategorised work: `reasoning` is
      // the broadest bucket and the reviewer re-files it while writing the
      // rubric, which is the moment they know which category it belongs in.
      category: "reasoning",
      prompt: entry.runPrompt,
      rubric: [],
      antiRubric: [],
      tags: ["from-feedback"],
      source: "feedback",
      addedAt: options.today,
      runId: entry.runId,
      feedbackId: entry.feedback.id,
      reportedReason: entry.feedback.reason,
      reportedNote: notes.length === 0 ? null : notes.join(" | "),
    })
  })
}

/** Mark an exported batch promoted, so the next export does not repeat it. */
export async function markExported(items: readonly StagedItem[]): Promise<number> {
  return markFeedbackPromoted({
    scope: { kind: "every-tenant", reason: "the eval set is drawn from every workspace" },
    feedbackIds: items.map((item) => item.feedbackId),
  })
}
