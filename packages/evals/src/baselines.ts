import { jaccard, promptTokens } from "@sce/shared"
import { singleSystem, type SystemId } from "./schema.ts"

/**
 * The baselines the panel has to beat.
 *
 * The product's claim is that comparing several independent answers and
 * synthesising them produces a better answer than any one model. That claim has
 * exactly two honest comparisons, and this module builds both out of the run
 * that was already paid for:
 *
 *   **Each single model.** Every candidate is an answer that one model gave to
 *   this question, in this run, at this temperature. Measuring it costs nothing
 *   extra and is fairer than re-asking the model separately, which would be a
 *   different sample.
 *
 *   **Majority vote.** The cheap alternative to an evaluator: pick the
 *   candidate that most agrees with the others and ship it verbatim. If
 *   synthesis cannot beat *that*, the evaluator is an expensive way to pick a
 *   winner and the architecture should be reconsidered — which is precisely why
 *   this baseline is in the report and not left out of it.
 */

export interface RunCandidate {
  label: string
  provider: string
  model: string
  content: string
}

export interface SystemAnswer {
  system: SystemId
  answer: string
  /** Only the panel reports one; a single model and a vote do not. */
  confidence: number | null
}

/**
 * Mean similarity of each candidate to the others, as token-set overlap.
 *
 * Jaccard over word sets rather than an embedding: it needs no model call, it
 * is deterministic, and the property being measured — "which of these answers
 * is closest to what the others said" — is coarse enough that a cheap measure
 * is the right one. An embedding baseline would be more sensitive and would
 * also make the baseline itself something that has to be paid for and versioned.
 */
export function agreementScores(candidates: readonly RunCandidate[]): number[] {
  const tokens = candidates.map((candidate) => new Set(promptTokens(candidate.content)))

  return tokens.map((own, index) => {
    if (tokens.length < 2) return 1
    let total = 0
    for (let other = 0; other < tokens.length; other += 1) {
      if (other === index) continue
      const compared = tokens[other]
      if (compared === undefined) continue
      total += jaccard(own, compared)
    }
    return total / (tokens.length - 1)
  })
}

/**
 * The medoid candidate: the one closest to the consensus.
 *
 * Ties break on panel order, which is stable for a given panel, so the majority
 * baseline is reproducible across runs of the same report. Returns null for an
 * empty panel — a run where every model failed has no baseline, and inventing
 * one would put a zero into the comparison that no model earned.
 */
export function majorityVote(candidates: readonly RunCandidate[]): RunCandidate | null {
  if (candidates.length === 0) return null

  const scores = agreementScores(candidates)
  let bestIndex = 0
  let bestScore = -1

  for (let index = 0; index < candidates.length; index += 1) {
    const score = scores[index] ?? 0
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return candidates[bestIndex] ?? null
}

/**
 * Every system a single run can be scored as.
 *
 * The synthesis, each candidate, and the vote — from one run, so all of them
 * answered the same question under the same conditions. The vote is skipped
 * when the panel had one member: "the majority of one" is that member's answer
 * again, and grading it twice would silently double its weight in the report.
 */
export function systemsFromRun(input: {
  synthesis: string
  confidence: number | null
  candidates: readonly RunCandidate[]
}): SystemAnswer[] {
  const systems: SystemAnswer[] = [
    { system: "synthesis", answer: input.synthesis, confidence: input.confidence },
  ]

  for (const candidate of input.candidates) {
    systems.push({
      system: singleSystem(candidate.label),
      answer: candidate.content,
      confidence: null,
    })
  }

  if (input.candidates.length > 1) {
    const winner = majorityVote(input.candidates)
    if (winner !== null) {
      systems.push({ system: "majority", answer: winner.content, confidence: null })
    }
  }

  return systems
}
