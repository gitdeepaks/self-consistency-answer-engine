import { resolvePromptSet, type Candidate, type PromptSet } from "@sce/shared"

/**
 * Rendering the evaluator's user message, and resolving which prompts to use.
 *
 * The prompt *text* moved to `@sce/shared/prompts.ts` in Phase 7, where every
 * version is an immutable record with an id that is written onto the run. What
 * stays here is the part that is not a version: turning a specific run's
 * candidates into the message the evaluator actually receives.
 */

/**
 * The prompts a run was created under.
 *
 * Throws rather than falling back when the id is unknown, and the distinction
 * matters: a null id means "created before prompts were versioned" and resolves
 * to the default, but an id this build has never heard of means a worker from
 * an older release has picked up a run from a newer one. Answering it with
 * different wording than it was created under would produce an answer nothing
 * could later explain — so the job fails, is retried, and lands on a worker
 * that does know the id.
 */
export function promptsFor(promptSetId: string | null): PromptSet {
  const set = resolvePromptSet(promptSetId)
  if (set === null) {
    throw new Error(
      `This run was created with prompt set "${promptSetId}", which this build does not know. ` +
        "Deploy the release that introduced it, or re-run the question.",
    )
  }
  return set
}

/**
 * Render the candidate answers into the evaluator's user message.
 *
 * Each block leads with the candidate's **label**, because that is what the
 * evaluator is asked to echo back on its review, and since a panel can now draw
 * two samples from one model ("OpenAI #1", "OpenAI #2") the provider alone no
 * longer identifies an answer. The provider and model are still shown: they are
 * useful context for the comparison, and they keep the review's `provider`
 * field answerable.
 */
export function buildEvaluatorPrompt(prompt: string, candidates: readonly Candidate[]): string {
  const blocks = candidates.map((candidate, index) => {
    return [
      `### Candidate ${index + 1}`,
      `- label: ${candidate.label}`,
      `- provider_id: ${candidate.provider}`,
      `- model: ${candidate.model}`,
      "",
      "<answer>",
      candidate.content ?? "",
      "</answer>",
    ].join("\n")
  })

  return [
    "## Original question",
    "",
    "<question>",
    prompt,
    "</question>",
    "",
    "## Candidate answers",
    "",
    blocks.join("\n\n"),
    "",
    "## Your task",
    "",
    "Return exactly one review per candidate, echoing the `label` shown above verbatim " +
      `(${candidates.map((candidate) => candidate.label).join(", ")}) ` +
      "together with that candidate's `provider_id`, plus the merged final answer.",
  ].join("\n")
}
