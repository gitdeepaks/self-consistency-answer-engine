import { z } from "zod"

/**
 * The prompts, as versioned records.
 *
 * A prompt is the largest untracked variable in this system. Two runs of the
 * same panel, on the same models, at the same temperature, produce different
 * answers when the system prompt changed between them — and until Phase 7 there
 * was no way to tell, because the text lived in a source file that was edited
 * in place. "The answer got worse last Tuesday" was unanswerable.
 *
 * So the text is data now, every version is immutable, and the id of the set a
 * run used is written on the run row. Three properties follow:
 *
 *   - **Traceability.** Any stored answer names the exact prompt that produced
 *     it, for as long as the row exists.
 *   - **Experimentability.** A panel (see `panels.ts`) names a prompt set, so
 *     "does the new evaluator prompt actually help" is an A/B test rather than
 *     an argument.
 *   - **Honesty about the past.** Editing `text` on a published version is
 *     forbidden: it would silently rewrite the history of every run that
 *     already points at it. New wording is a new id.
 *
 * Adding a version is a three-line data edit — append the record, append the id
 * to the `as const` tuple, add a set that uses it — and the compiler routes it
 * everywhere it has to go.
 */

export const promptRoleSchema = z.enum(["candidate", "evaluator"])
export type PromptRole = z.infer<typeof promptRoleSchema>

/**
 * One immutable prompt.
 *
 * `retiredAt` marks a version no new run should be started with while leaving
 * it fully resolvable, because runs that already used it still have to render.
 * Nothing is ever deleted from this registry.
 */
export interface PromptVersion {
  readonly id: string
  readonly role: PromptRole
  readonly summary: string
  readonly introducedAt: string
  readonly retiredAt: string | null
  readonly text: string
}

/* ------------------------------------------------------------- candidates */

export const CANDIDATE_PROMPT_IDS = ["candidate.v1"] as const
export type CandidatePromptId = (typeof CANDIDATE_PROMPT_IDS)[number]

/**
 * Panel members answer independently — they never see each other's output.
 * That independence is what makes the later agreement signal meaningful.
 */
const CANDIDATE_V1_TEXT = `You are an expert assistant answering a user's question as well as you possibly can.

Rules:
- Answer directly and completely. Lead with the answer, then support it.
- Use Markdown: short paragraphs, lists where they help, fenced code blocks with a language tag.
- Show the key reasoning steps for anything non-obvious, but do not pad.
- State assumptions explicitly when the question is ambiguous.
- If you are uncertain or the question depends on facts you may not have, say so plainly instead of guessing.
- Do not mention that you are one of several models, and do not ask the user follow-up questions.`

export const CANDIDATE_PROMPTS: Readonly<Record<CandidatePromptId, PromptVersion>> = {
  "candidate.v1": {
    id: "candidate.v1",
    role: "candidate",
    summary: "The original panel-member prompt: answer directly, show reasoning, admit uncertainty.",
    introducedAt: "2026-08-22",
    retiredAt: null,
    text: CANDIDATE_V1_TEXT,
  },
}

/* ------------------------------------------------------------- evaluators */

export const EVALUATOR_PROMPT_IDS = ["evaluator.v1"] as const
export type EvaluatorPromptId = (typeof EVALUATOR_PROMPT_IDS)[number]

const EVALUATOR_V1_TEXT = `You are the evaluator in a self-consistency answer engine.

Several independent AI models were each given the SAME question with no knowledge of one another. You receive the question and every answer they produced. Your job is to produce one final answer that is better than any individual answer.

Method:
1. Compare the candidates claim by claim. Where they independently agree, confidence is high. Where they conflict, decide which reading is actually correct using your own knowledge and the strength of the reasoning given — majority is evidence, not proof.
2. Score each candidate 0-10 on correctness, completeness and clarity, and record concrete strengths and weaknesses. Be specific: "misses the O(n log n) bound" beats "less detailed".
3. Write the final answer by merging the strongest material from every candidate and correcting what they got wrong.

Hard requirements for the final answer:
- It MUST NOT be a verbatim or near-verbatim copy of any single candidate. Synthesise.
- It must include correct details that only some candidates had.
- It must silently drop claims you judged wrong — never repeat an error just because a candidate made it.
- Write it in Markdown, addressed directly to the user. Never mention the candidates, the models, the scoring, or this evaluation process inside the final answer.
- If every candidate is weak or they all missed the point, answer the question correctly yourself and reflect that in the scores.

Confidence:
- \`confidence\` is a probability, not a mood. Report the share of questions like this one, answered like this one, that you would expect to be fully correct.
- Independent agreement between candidates raises it; unresolved conflict, thin reasoning, or a question that turns on facts you may not have lowers it.
- Reserve values above 0.9 for answers you would defend without qualification, and do not go below 0.1 for an answer you are still willing to publish.`

export const EVALUATOR_PROMPTS: Readonly<Record<EvaluatorPromptId, PromptVersion>> = {
  "evaluator.v1": {
    id: "evaluator.v1",
    role: "evaluator",
    summary:
      "Compare claim by claim, score each candidate, merge the best answer, and report a calibrated confidence.",
    introducedAt: "2026-08-22",
    retiredAt: null,
    text: EVALUATOR_V1_TEXT,
  },
}

/* ---------------------------------------------------------------- the set */

/**
 * A prompt set is what a run actually points at.
 *
 * The candidate prompt and the evaluator prompt are not independent variables:
 * an evaluator prompt is written against the *shape* of the answers the
 * candidate prompt produces. Versioning them separately and pairing them at
 * random would make a regression impossible to attribute, so the pair is the
 * unit that gets an id, and that id is what lands on `Run.promptSetId`.
 */
export const PROMPT_SET_IDS = ["prompts.v1"] as const
export type PromptSetId = (typeof PROMPT_SET_IDS)[number]

export const promptSetIdSchema = z.enum(PROMPT_SET_IDS)

export interface PromptSet {
  readonly id: PromptSetId
  readonly summary: string
  readonly introducedAt: string
  readonly candidate: PromptVersion
  readonly evaluator: PromptVersion
}

export const PROMPT_SETS: Readonly<Record<PromptSetId, PromptSet>> = {
  "prompts.v1": {
    id: "prompts.v1",
    summary: "The prompts this engine shipped with, plus an explicit definition of `confidence`.",
    introducedAt: "2026-08-22",
    candidate: CANDIDATE_PROMPTS["candidate.v1"],
    evaluator: EVALUATOR_PROMPTS["evaluator.v1"],
  },
}

/** The set a run gets when nothing chose one for it. */
export const DEFAULT_PROMPT_SET_ID: PromptSetId = "prompts.v1"

export const DEFAULT_PROMPT_SET: PromptSet = PROMPT_SETS[DEFAULT_PROMPT_SET_ID]

/**
 * Resolve the set a stored run was produced with.
 *
 * Null means "this run predates prompt versioning", and resolves to the default
 * set — the honest answer, since the default *is* the text those runs used.
 *
 * An id this build does not know resolves to `null` rather than falling back,
 * and every caller treats that as an error. A worker from an older release
 * picking up a run created by a newer one must refuse it: silently answering
 * with different wording than the run was created under is exactly the drift
 * this module exists to make impossible.
 */
export function resolvePromptSet(id: string | null): PromptSet | null {
  if (id === null) return DEFAULT_PROMPT_SET
  const parsed = promptSetIdSchema.safeParse(id)
  return parsed.success ? PROMPT_SETS[parsed.data] : null
}

export const PROMPT_SET_LIST: readonly PromptSet[] = PROMPT_SET_IDS.map((id) => PROMPT_SETS[id])
