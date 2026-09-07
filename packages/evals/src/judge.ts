import { resolveProvider } from "@sce/worker/providers"
import { describeError, type ProviderId } from "@sce/shared"
import { generateText, Output, type LanguageModel } from "ai"
import { judgeVerdictSchema, type GoldenItem, type JudgeVerdict } from "./schema.ts"

/**
 * The judge.
 *
 * Grading a few hundred long answers by hand every night is not a thing anyone
 * will keep doing, so a model does it. That makes the judge a measuring
 * instrument, and the three things that make an instrument trustworthy are all
 * design decisions taken here:
 *
 *   **Blind grading.** The judge is never told which system produced the answer.
 *   An LLM told "this is the synthesised answer" scores it higher, and the
 *   comparison the whole report exists to make would then be measuring the
 *   label rather than the text.
 *
 *   **A rubric, not an opinion.** The prompt carries the item's rubric, its
 *   anti-rubric and its reference, and asks which points are covered. "Rate this
 *   answer 1-10" produces a number that drifts with the judge's mood, the
 *   answer's length, and the model release.
 *
 *   **Rotation.** A judge scores answers from its own model family higher.
 *   Rotating judges deterministically across items spreads that bias evenly
 *   over the set instead of handing it to one system, and `agreement.ts`
 *   measures what is left against human labels.
 */

/** The models available to judge, in the order they are rotated through. */
export interface JudgePanel {
  models: readonly { id: string; provider: ProviderId; model: LanguageModel }[]
}

export const DEFAULT_JUDGE_PROVIDERS: readonly ProviderId[] = ["anthropic", "openai", "google"]

export class NoJudgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoJudgeError"
  }
}

/**
 * Build the judge panel from whatever this environment can actually reach.
 *
 * Configured providers only: a judge panel that named an unreachable model
 * would fail a third of the set and report the failures as gaps in the answers.
 * A panel of one is allowed and is noted in the report — it is a weaker
 * measurement, not an invalid one.
 */
export function judgePanel(providers: readonly ProviderId[] = DEFAULT_JUDGE_PROVIDERS): JudgePanel {
  const models: { id: string; provider: ProviderId; model: LanguageModel }[] = []

  for (const provider of providers) {
    const resolved = resolveProvider(provider)
    if (resolved.model === null) continue
    models.push({ id: `${provider}:${resolved.modelId}`, provider, model: resolved.model })
  }

  if (models.length === 0) {
    throw new NoJudgeError(
      "No judge model is reachable. Set at least one provider key (or AI_GATEWAY_API_KEY) — " +
        "an eval run with no judge produces no measurement.",
    )
  }
  return { models }
}

/**
 * Which judge grades this answer.
 *
 * Deterministic in the item and the system, so re-running the same report uses
 * the same judges and two reports are comparable. Hashing the *system* as well
 * as the item is what stops one judge grading every synthesis answer while
 * another grades every single-model one — which would make the report's central
 * comparison a comparison of judges.
 */
export function judgeFor(panel: JudgePanel, itemId: string, system: string): JudgePanel["models"][number] {
  let hash = 0x811c9dc5
  const key = `${itemId}|${system}`
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15

  const chosen = panel.models[(hash >>> 0) % panel.models.length]
  if (chosen === undefined) throw new NoJudgeError("The judge panel is empty")
  return chosen
}

export const JUDGE_SYSTEM_PROMPT = `You are grading one answer to one question against a fixed rubric.

You are a measuring instrument, not a participant. You do not know and must not speculate about who or what produced the answer; judge only the text in front of you.

How to grade:
- **correctness** is about truth, not style. One wrong central claim makes an otherwise excellent answer incorrect. An answer that is right but terse is still right.
- **completeness** is coverage of the rubric, weighted by how much each point matters to the person who asked. An answer that adds correct material beyond the rubric is not penalised; an answer that pads with irrelevance is not rewarded.
- **citationFidelity** is about specifics: names, numbers, dates, quotes, sources, API signatures. Invented specifics are the worst failure a confident answer can have — score this low whenever the answer states something checkable that is wrong or unverifiable. An answer that cites nothing but claims nothing it cannot support scores 1.
- **violations** lists any anti-rubric claim the answer makes, and any stated expectation it fails to meet.
- **verdict** is the practical question: would you be content for this to be sent, unedited, to the person who asked? A single wrong central claim is a fail no matter how good the rest is.

Be concrete in the rationale and name the decisive point. Two sentences at most. Do not rewrite the answer, do not suggest improvements, and do not grade generously because the answer is well written.`

/** Render one grading task. Contains the answer and the rubric — never the system. */
export function buildJudgePrompt(item: GoldenItem, answer: string): string {
  const sections: string[] = [
    "## Question",
    "",
    "<question>",
    item.prompt,
    "</question>",
    "",
    "## Rubric — what a correct answer must contain",
    "",
    item.rubric.map((point, index) => `${index + 1}. ${point}`).join("\n"),
  ]

  if (item.reference !== undefined) {
    sections.push(
      "",
      "## Reference",
      "",
      "A known-good answer, for comparison. The answer under test does not have to match its " +
        "wording, and may be better than it.",
      "",
      "<reference>",
      item.reference,
      "</reference>",
    )
  }

  if (item.antiRubric.length > 0) {
    sections.push(
      "",
      "## Anti-rubric — claims that make an answer wrong",
      "",
      item.antiRubric.map((point) => `- ${point}`).join("\n"),
    )
  }

  if (item.expectation !== undefined) {
    sections.push(
      "",
      "## Expected behaviour",
      "",
      "This question is ambiguous, loaded, or unanswerable as asked. What a good answer *does*:",
      "",
      item.expectation,
    )
  }

  sections.push("", "## The answer under test", "", "<answer>", answer, "</answer>")
  return sections.join("\n")
}

export interface JudgeResult {
  judgeModel: string
  verdict: JudgeVerdict
}

export interface JudgeOptions {
  timeoutMs?: number
  maxOutputTokens?: number
}

export class JudgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JudgeError"
  }
}

/**
 * Grade one answer.
 *
 * Structured output against `judgeVerdictSchema`, so a verdict is a parsed
 * domain object rather than prose somebody has to regex. A truncated response
 * is reported as the token-cap failure it is instead of the "no output
 * generated" the SDK would otherwise surface — the same trap the evaluator hits
 * in `synthesis.ts`, and the same fix.
 */
export async function judgeAnswer(
  judge: JudgePanel["models"][number],
  item: GoldenItem,
  answer: string,
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const maxOutputTokens = options.maxOutputTokens ?? 2_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)

  try {
    const result = await generateText({
      model: judge.model,
      system: JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(item, answer),
      output: Output.object({ schema: judgeVerdictSchema }),
      maxOutputTokens,
      maxRetries: 2,
      abortSignal: controller.signal,
      // Grading has to be as reproducible as a sampled model allows: the same
      // answer graded twice should not swing on temperature.
      temperature: 0,
    })

    if (result.finishReason === "length") {
      throw new JudgeError(
        `The judge hit its ${maxOutputTokens}-token cap before finishing. The rubric or the ` +
          "answer is too long to grade in one pass.",
      )
    }
    return { judgeModel: judge.id, verdict: result.output }
  } catch (error) {
    if (error instanceof JudgeError) throw error
    throw new JudgeError(
      controller.signal.aborted
        ? `The judge (${judge.id}) exceeded its time budget`
        : `The judge (${judge.id}) failed — ${describeError(error)}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The single number a report ranks systems by.
 *
 * Weighted because the dimensions are not equally important: an answer that is
 * wrong is worthless however complete it is, so correctness dominates;
 * completeness is the difference between a usable answer and a technically
 * correct one; and citation fidelity is weighted lowest only because it is
 * scored 1 by default on answers that cite nothing — it is a penalty for
 * invention rather than a reward for sourcing.
 *
 * A violation is subtracted on top, capped, because anti-rubric claims are the
 * specific failures the item was written to catch and a score that averaged
 * them away would miss the point of writing them down.
 */
export const SCORE_WEIGHTS = {
  correctness: 0.6,
  completeness: 0.3,
  citationFidelity: 0.1,
} as const

export const VIOLATION_PENALTY = 0.15
export const MAX_VIOLATION_PENALTY = 0.45

export function scoreVerdict(verdict: JudgeVerdict): number {
  const weighted =
    verdict.correctness * SCORE_WEIGHTS.correctness +
    verdict.completeness * SCORE_WEIGHTS.completeness +
    verdict.citationFidelity * SCORE_WEIGHTS.citationFidelity

  const penalty = Math.min(MAX_VIOLATION_PENALTY, verdict.violations.length * VIOLATION_PENALTY)
  return Math.max(0, Math.min(1, weighted - penalty))
}
