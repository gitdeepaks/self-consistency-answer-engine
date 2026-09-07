import { reliability, type CalibrationPoint } from "@sce/shared"
import {
  EVAL_CATEGORIES,
  SYNTHESIS_SYSTEM,
  type CalibrationSummary,
  type EvalCategory,
  type EvalReport,
  type ItemResult,
  type SystemId,
  type SystemSummary,
} from "./schema.ts"

/**
 * Turning verdicts into the four numbers a release decision is made on.
 *
 * Aggregation is where an eval harness quietly stops being honest, so the rules
 * are stated rather than implied:
 *
 *   - **Only graded rows count.** An item the engine or the judge failed on is
 *     excluded, never scored zero. Scoring failures as zero makes a provider
 *     outage read as a quality regression, and makes the fix "retry until the
 *     number comes back" rather than "find out what broke".
 *   - **Categories are means of means, never means of rows.** Otherwise the
 *     category with the most items decides the headline, and adding twenty
 *     factual questions would "improve quality" without a single answer
 *     changing.
 *   - **Calibration is measured for the synthesis alone.** It is the only
 *     system that reports a confidence; a single model's answer has none, and
 *     inventing one would be fabricating the measurement.
 */

const EMPTY_BY_CATEGORY: Record<EvalCategory, number> = {
  factual: 0,
  reasoning: 0,
  coding: 0,
  longform: 0,
  adversarial: 0,
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

/** Summarise one system's rows. Categories with no rows are simply absent. */
export function summariseSystem(system: SystemId, rows: readonly ItemResult[]): SystemSummary {
  const graded = rows.filter((row) => row.error === null)

  const byCategory: Record<EvalCategory, number> = { ...EMPTY_BY_CATEGORY }
  const present: EvalCategory[] = []
  for (const category of EVAL_CATEGORIES) {
    const inCategory = graded.filter((row) => row.category === category)
    if (inCategory.length === 0) continue
    byCategory[category] = mean(inCategory.map((row) => row.score))
    present.push(category)
  }

  return {
    system,
    graded: graded.length,
    // The mean of the category means, so a large category cannot decide the
    // headline on its own. With one category present the two are identical.
    meanScore: mean(present.map((category) => byCategory[category])),
    passRate: graded.length === 0 ? 0 : graded.filter((row) => row.verdict.verdict === "pass").length / graded.length,
    meanCorrectness: mean(graded.map((row) => row.verdict.correctness)),
    meanCompleteness: mean(graded.map((row) => row.verdict.completeness)),
    meanCitationFidelity: mean(graded.map((row) => row.verdict.citationFidelity)),
    byCategory: Object.fromEntries(present.map((category) => [category, byCategory[category]])),
  }
}

/**
 * Confidence against judged correctness, for the synthesis.
 *
 * The label is the judge's pass/fail rather than its correctness score, and
 * that is deliberate: calibration is a statement about a *binary* event — "this
 * answer was right" — and interpolating a 0.7 correctness into "70% of a
 * correct answer" would make the reliability curve meaningless.
 */
export function calibrationPoints(rows: readonly ItemResult[]): CalibrationPoint[] {
  return rows.flatMap((row) =>
    row.error !== null || row.confidence === null || row.system !== SYNTHESIS_SYSTEM
      ? []
      : [{ confidence: row.confidence, correct: row.verdict.verdict === "pass" }],
  )
}

export function summariseCalibration(rows: readonly ItemResult[]): CalibrationSummary {
  const measured = reliability(calibrationPoints(rows))
  return {
    sampleSize: measured.count,
    expectedCalibrationError: measured.expectedCalibrationError,
    maximumCalibrationError: measured.maximumCalibrationError,
    brierScore: measured.brierScore,
    baseRate: measured.baseRate,
    bins: measured.bins.map((bin) => ({
      lower: bin.lower,
      upper: bin.upper,
      count: bin.count,
      meanConfidence: bin.meanConfidence,
      accuracy: bin.accuracy,
    })),
  }
}

export interface BuildReportInput {
  id: string
  createdAt: string
  dataset: EvalReport["dataset"]
  engine: EvalReport["engine"]
  judges: readonly string[]
  results: readonly ItemResult[]
  failures: readonly { itemId: string; system: SystemId; error: string }[]
}

export function buildReport(input: BuildReportInput): EvalReport {
  const systems = [...new Set(input.results.map((row) => row.system))].sort()

  return {
    id: input.id,
    createdAt: input.createdAt,
    dataset: input.dataset,
    engine: input.engine,
    judges: [...input.judges],
    systems: systems.map((system) =>
      summariseSystem(
        system,
        input.results.filter((row) => row.system === system),
      ),
    ),
    calibration: summariseCalibration(input.results),
    failures: [...input.failures],
    results: [...input.results],
  }
}

/* --------------------------------------------------------- the comparison */

export interface ThesisComparison {
  synthesis: SystemSummary | null
  /** The strongest individual panel member in this report. */
  bestSingle: SystemSummary | null
  /** Pick-the-most-agreed-with-candidate, with no evaluator. */
  majority: SystemSummary | null
  /** Synthesis minus best single. Positive is the product's claim holding. */
  edgeOverBestSingle: number | null
  /** Synthesis minus majority vote. Positive is the evaluator earning its cost. */
  edgeOverMajority: number | null
}

/**
 * The claim, as a number.
 *
 * Against the *best* single model rather than the average of them, because the
 * average is a straw man: nobody deploys a random member of the panel, they
 * deploy the one they think is best. A synthesis that beats the mean and loses
 * to the leader has not earned three model calls.
 */
export function compareThesis(report: EvalReport): ThesisComparison {
  const find = (predicate: (summary: SystemSummary) => boolean): SystemSummary | null =>
    report.systems.find(predicate) ?? null

  const synthesis = find((summary) => summary.system === SYNTHESIS_SYSTEM)
  const majority = find((summary) => summary.system === "majority")

  const singles = report.systems.filter((summary) => summary.system.startsWith("single:"))
  const bestSingle = singles.reduce<SystemSummary | null>(
    (best, summary) => (best === null || summary.meanScore > best.meanScore ? summary : best),
    null,
  )

  return {
    synthesis,
    bestSingle,
    majority,
    edgeOverBestSingle:
      synthesis === null || bestSingle === null ? null : synthesis.meanScore - bestSingle.meanScore,
    edgeOverMajority: synthesis === null || majority === null ? null : synthesis.meanScore - majority.meanScore,
  }
}

/* ------------------------------------------------------------- rendering */

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function signed(value: number | null): string {
  if (value === null) return "n/a"
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pts`
}

/**
 * The report as Markdown, for a pull request comment or a nightly summary.
 *
 * Ordered so the first three lines answer the only question most readers have:
 * did the panel beat its best member, did it beat the cheap alternative, and
 * did anything regress.
 */
export function renderReport(report: EvalReport): string {
  const thesis = compareThesis(report)
  const lines: string[] = []

  lines.push(`# Eval report ${report.id}`)
  lines.push("")
  lines.push(
    `Dataset \`${report.dataset.id}\` (${report.dataset.size} items, digest \`${report.dataset.digest}\`) · ` +
      `panel \`${report.engine.panelId ?? "default"}\` · prompts \`${report.engine.promptSetId ?? "default"}\` · ` +
      `judges ${report.judges.map((judge) => `\`${judge}\``).join(", ")}`,
  )
  lines.push("")

  lines.push("## The thesis")
  lines.push("")
  if (thesis.synthesis === null) {
    lines.push("No synthesis rows were graded, so nothing can be concluded.")
  } else {
    lines.push(
      `- Synthesis scored **${pct(thesis.synthesis.meanScore)}**, ` +
        `passing ${pct(thesis.synthesis.passRate)} of items.`,
    )
    lines.push(
      `- Against the best single model (\`${thesis.bestSingle?.system ?? "none"}\`, ` +
        `${thesis.bestSingle === null ? "n/a" : pct(thesis.bestSingle.meanScore)}): ` +
        `**${signed(thesis.edgeOverBestSingle)}**.`,
    )
    lines.push(
      `- Against majority vote (${thesis.majority === null ? "n/a" : pct(thesis.majority.meanScore)}): ` +
        `**${signed(thesis.edgeOverMajority)}**.`,
    )
  }
  lines.push("")

  lines.push("## Systems")
  lines.push("")
  lines.push("| System | Graded | Score | Pass | Correct | Complete | Citations |")
  lines.push("| ------ | -----: | ----: | ---: | ------: | -------: | --------: |")
  for (const summary of [...report.systems].sort((left, right) => right.meanScore - left.meanScore)) {
    lines.push(
      `| \`${summary.system}\` | ${summary.graded} | ${pct(summary.meanScore)} | ${pct(summary.passRate)} | ` +
        `${pct(summary.meanCorrectness)} | ${pct(summary.meanCompleteness)} | ${pct(summary.meanCitationFidelity)} |`,
    )
  }
  lines.push("")

  lines.push("## By category")
  lines.push("")
  const categories = EVAL_CATEGORIES.filter((category) =>
    report.systems.some((summary) => summary.byCategory[category] !== undefined),
  )
  lines.push(`| System | ${categories.join(" | ")} |`)
  lines.push(`| ------ | ${categories.map(() => "---:").join(" | ")} |`)
  for (const summary of report.systems) {
    const cells = categories.map((category) => {
      const value = summary.byCategory[category]
      return value === undefined ? "—" : pct(value)
    })
    lines.push(`| \`${summary.system}\` | ${cells.join(" | ")} |`)
  }
  lines.push("")

  lines.push("## Confidence calibration")
  lines.push("")
  lines.push(
    `Expected calibration error **${report.calibration.expectedCalibrationError.toFixed(3)}**, ` +
      `worst bin ${report.calibration.maximumCalibrationError.toFixed(3)}, ` +
      `Brier ${report.calibration.brierScore.toFixed(3)}, ` +
      `over ${report.calibration.sampleSize} answers with a base rate of ${pct(report.calibration.baseRate)}.`,
  )
  lines.push("")
  lines.push("| Claimed | Answers | Mean claimed | Actually right |")
  lines.push("| ------- | ------: | -----------: | -------------: |")
  for (const bin of report.calibration.bins) {
    if (bin.count === 0) continue
    lines.push(
      `| ${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)} | ${bin.count} | ` +
        `${pct(bin.meanConfidence)} | ${pct(bin.accuracy)} |`,
    )
  }

  if (report.failures.length > 0) {
    lines.push("")
    lines.push(`## Ungraded (${report.failures.length})`)
    lines.push("")
    lines.push("Excluded from every mean above — not scored zero.")
    lines.push("")
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`- \`${failure.itemId}\` / \`${failure.system}\` — ${failure.error}`)
    }
    if (report.failures.length > 20) {
      lines.push(`- …and ${report.failures.length - 20} more.`)
    }
  }

  return lines.join("\n") + "\n"
}
