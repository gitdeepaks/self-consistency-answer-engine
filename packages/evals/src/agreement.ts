import { judgeAnswer, type JudgePanel } from "./judge.ts"
import type { AgreementReport, GoldenItem, HumanLabel } from "./schema.ts"

/**
 * Measuring the judge.
 *
 * The judge grades every answer in every report, so its bias is a bias in every
 * number the gate reads. The only way to know how big that bias is, is to have
 * people grade a subset and compare — which is what the human-labelled file
 * exists for and what this module computes.
 *
 * The metric is **Cohen's kappa**, not raw agreement, and the difference
 * matters: on a set where 85% of answers pass, a judge that said "pass" to
 * everything would agree with the humans 85% of the time and be worthless.
 * Kappa subtracts what chance alone would produce, so that judge scores zero.
 *
 *   κ ≥ 0.8   the judge can be trusted with the gate
 *   0.6-0.8   usable, with the caveat stated in the report
 *   < 0.6     the rubric or the judge prompt is the problem, not the answers
 */

export type Verdict = "pass" | "fail"

export interface AgreementPair {
  human: Verdict
  judge: Verdict
  /** The judge that graded this one, so bias can be attributed. */
  judgeModel: string
  /** Absolute error on correctness, where the human supplied one. */
  correctnessError: number | null
}

/**
 * Cohen's kappa for two binary raters.
 *
 * Returns 0 rather than NaN in the degenerate case where both raters gave the
 * same verdict to everything: chance agreement is then 1, the formula divides
 * by zero, and "no information" is the honest reading — not "perfect".
 */
export function cohensKappa(pairs: readonly AgreementPair[]): number {
  if (pairs.length === 0) return 0

  let agreed = 0
  let humanPass = 0
  let judgePass = 0

  for (const pair of pairs) {
    if (pair.human === pair.judge) agreed += 1
    if (pair.human === "pass") humanPass += 1
    if (pair.judge === "pass") judgePass += 1
  }

  const total = pairs.length
  const observed = agreed / total
  const pPass = (humanPass / total) * (judgePass / total)
  const pFail = (1 - humanPass / total) * (1 - judgePass / total)
  const expected = pPass + pFail

  if (expected >= 1) return 0
  return (observed - expected) / (1 - expected)
}

export function rawAgreement(pairs: readonly AgreementPair[]): number {
  if (pairs.length === 0) return 0
  return pairs.filter((pair) => pair.human === pair.judge).length / pairs.length
}

export function summariseAgreement(pairs: readonly AgreementPair[]): AgreementReport {
  const errors = pairs.flatMap((pair) => (pair.correctnessError === null ? [] : [pair.correctnessError]))

  const judges = [...new Set(pairs.map((pair) => pair.judgeModel))].sort()

  return {
    labels: pairs.length,
    rawAgreement: rawAgreement(pairs),
    kappa: cohensKappa(pairs),
    correctnessMae:
      errors.length === 0 ? null : errors.reduce((total, value) => total + value, 0) / errors.length,
    perJudge: judges.map((judge) => {
      const own = pairs.filter((pair) => pair.judgeModel === judge)
      return { judge, rawAgreement: rawAgreement(own), kappa: cohensKappa(own) }
    }),
  }
}

export interface MeasureJudgeOptions {
  labels: readonly HumanLabel[]
  items: readonly GoldenItem[]
  judges: JudgePanel
  /** Called per label, so a slow run shows progress. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Re-grade the frozen answers with every judge, and compare to the humans.
 *
 * *Every* judge, unlike a report run where each answer is graded once: the
 * whole purpose here is to compare judges against a fixed truth, and rotating
 * would give each of them a different subset to be measured on. This set is
 * small by design — a few dozen answers — so grading it three times is
 * affordable in a way grading the whole golden set three times is not.
 */
export async function measureJudges(options: MeasureJudgeOptions): Promise<AgreementReport> {
  const byId = new Map(options.items.map((item) => [item.id, item]))
  const pairs: AgreementPair[] = []
  let done = 0

  for (const label of options.labels) {
    const item = byId.get(label.itemId)
    if (item === undefined) {
      throw new Error(
        `Human label references item "${label.itemId}", which is not in the dataset. ` +
          "A label whose question has been deleted cannot measure anything.",
      )
    }

    for (const judge of options.judges.models) {
      const graded = await judgeAnswer(judge, item, label.answer)
      pairs.push({
        human: label.verdict,
        judge: graded.verdict.verdict,
        judgeModel: judge.id,
        correctnessError:
          label.correctness === undefined
            ? null
            : Math.abs(label.correctness - graded.verdict.correctness),
      })
    }

    done += 1
    options.onProgress?.(done, options.labels.length)
  }

  return summariseAgreement(pairs)
}

/** How the agreement report reads, and what to do about each band. */
export function renderAgreement(report: AgreementReport): string {
  const lines: string[] = []
  lines.push(
    `[evals] judge agreement over ${report.labels} human-labelled answers: ` +
      `κ=${report.kappa.toFixed(3)}, raw=${(report.rawAgreement * 100).toFixed(1)}%` +
      (report.correctnessMae === null ? "" : `, correctness MAE=${report.correctnessMae.toFixed(3)}`),
  )

  for (const judge of report.perJudge) {
    lines.push(
      `        ${judge.judge}: κ=${judge.kappa.toFixed(3)}, ` +
        `raw=${(judge.rawAgreement * 100).toFixed(1)}%`,
    )
  }

  lines.push(
    report.kappa >= 0.8
      ? "        The judge tracks human verdicts closely enough to gate releases on."
      : report.kappa >= 0.6
        ? "        Usable, but state the caveat: some of every reported movement is judge noise."
        : "        Too low to gate on. Fix the rubric or the judge prompt before trusting the numbers.",
  )
  return lines.join("\n")
}
