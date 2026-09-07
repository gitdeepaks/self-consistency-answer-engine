import { compareThesis } from "./report.ts"
import {
  EVAL_CATEGORIES,
  gateThresholdsSchema,
  SYNTHESIS_SYSTEM,
  type EvalReport,
  type GateFinding,
  type GateResult,
  type GateThresholds,
  type SystemSummary,
} from "./schema.ts"

/**
 * The regression gate.
 *
 * A quality drop should block a release exactly like a failing test, and the
 * only way that survives contact with a team is if the gate is *credible*: it
 * has to fire on real regressions, stay quiet on noise, and say clearly which
 * of the two it thinks it is looking at. Three design choices follow:
 *
 *   **Thresholds, not equality.** The judge is a sampled instrument. A gate
 *   that failed on any decrease at all would fail most nights, and a gate that
 *   fails most nights is a gate somebody comments out.
 *
 *   **Per-category as well as overall.** A two-point fall in the mean can be a
 *   ten-point collapse in coding hidden by a rise everywhere else. The category
 *   check is what catches the change that a prompt edit actually makes.
 *
 *   **The thesis is a gate condition.** If the synthesis stops beating the best
 *   single model in its own panel, the product has stopped being the product.
 *   That is not a warning.
 *
 * A dataset change downgrades every comparison to a warning rather than
 * pretending the numbers are comparable: adding twenty hard questions lowers
 * the mean, and calling that a regression would teach everyone to ignore the
 * gate on exactly the days the set improves.
 */

export interface GateInput {
  report: EvalReport
  /** The last accepted measurement. Null runs the absolute checks only. */
  baseline: EvalReport | null
  thresholds?: Partial<GateThresholds>
}

function synthesisOf(report: EvalReport): SystemSummary | null {
  return report.systems.find((summary) => summary.system === SYNTHESIS_SYSTEM) ?? null
}

export function runGate(input: GateInput): GateResult {
  const thresholds = gateThresholdsSchema.parse(input.thresholds ?? {})
  const findings: GateFinding[] = []

  const current = synthesisOf(input.report)
  const thesis = compareThesis(input.report)

  if (current === null) {
    return {
      passed: false,
      findings: [
        {
          severity: "blocking",
          code: "no-synthesis",
          message:
            "The report contains no graded synthesis answers. Either every run failed or the " +
            "harness never reached the engine — in both cases nothing was measured.",
        },
      ],
      comparison: {
        baselineId: input.baseline?.id ?? "none",
        reportId: input.report.id,
        baselineScore: 0,
        reportScore: 0,
        bestSingleScore: 0,
      },
    }
  }

  /* --------------------------------------------- absolute checks */

  if (current.graded < thresholds.minGraded) {
    findings.push({
      severity: "blocking",
      code: "sample-too-small",
      message:
        `Only ${current.graded} synthesis answers were graded; the gate needs at least ` +
        `${thresholds.minGraded} to distinguish a regression from noise. Check the failures list.`,
    })
  }

  // The product thesis, as a test. Reported even with no baseline, because it
  // is a statement about this report alone.
  if (thesis.edgeOverBestSingle !== null && thesis.edgeOverBestSingle < thresholds.minSynthesisEdge) {
    findings.push({
      severity: "blocking",
      code: "thesis-broken",
      message:
        `Synthesis scored ${(current.meanScore * 100).toFixed(1)}%, which is ` +
        `${(Math.abs(thesis.edgeOverBestSingle) * 100).toFixed(1)} points ` +
        `${thesis.edgeOverBestSingle < 0 ? "below" : "above"} the best single model ` +
        `(\`${thesis.bestSingle?.system ?? "unknown"}\`) — under the required edge of ` +
        `${(thresholds.minSynthesisEdge * 100).toFixed(1)} points. The panel is not currently ` +
        "earning the calls it makes.",
    })
  }

  if (thesis.edgeOverMajority !== null && thesis.edgeOverMajority < 0) {
    findings.push({
      severity: "warning",
      code: "evaluator-not-earning",
      message:
        `Majority vote scored ${(Math.abs(thesis.edgeOverMajority) * 100).toFixed(1)} points above ` +
        "the synthesis. The evaluator is currently an expensive way to pick a winner.",
    })
  }

  /* --------------------------------------------- against the baseline */

  const baseline = input.baseline
  const previous = baseline === null ? null : synthesisOf(baseline)

  if (baseline === null || previous === null) {
    findings.push({
      severity: "warning",
      code: "no-baseline",
      message: "No baseline to compare against; only the absolute checks ran.",
    })
    return {
      passed: findings.every((finding) => finding.severity !== "blocking"),
      findings,
      comparison: {
        baselineId: baseline?.id ?? "none",
        reportId: input.report.id,
        baselineScore: previous?.meanScore ?? 0,
        reportScore: current.meanScore,
        bestSingleScore: thesis.bestSingle?.meanScore ?? 0,
      },
    }
  }

  // A different dataset makes every delta below incomparable. Say so once, and
  // downgrade the rest rather than reporting a regression that is really an
  // edit to the questions.
  const comparable = baseline.dataset.digest === input.report.dataset.digest
  if (!comparable) {
    findings.push({
      severity: "warning",
      code: "dataset-changed",
      message:
        `The dataset changed since the baseline (${baseline.dataset.digest} → ` +
        `${input.report.dataset.digest}). Score movements below are reported as warnings: they ` +
        "measure a different set of questions. Re-baseline once the change is reviewed.",
    })
  }

  const severity = (blocking: boolean): GateFinding["severity"] =>
    blocking && comparable ? "blocking" : "warning"

  const scoreDrop = previous.meanScore - current.meanScore
  if (scoreDrop > thresholds.maxScoreDrop) {
    findings.push({
      severity: severity(true),
      code: "score-regression",
      message:
        `Synthesis fell ${(scoreDrop * 100).toFixed(1)} points ` +
        `(${(previous.meanScore * 100).toFixed(1)}% → ${(current.meanScore * 100).toFixed(1)}%), ` +
        `past the ${(thresholds.maxScoreDrop * 100).toFixed(1)}-point allowance.`,
    })
  }

  const passDrop = previous.passRate - current.passRate
  if (passDrop > thresholds.maxPassRateDrop) {
    findings.push({
      severity: severity(true),
      code: "pass-rate-regression",
      message:
        `Pass rate fell ${(passDrop * 100).toFixed(1)} points ` +
        `(${(previous.passRate * 100).toFixed(1)}% → ${(current.passRate * 100).toFixed(1)}%), ` +
        `past the ${(thresholds.maxPassRateDrop * 100).toFixed(1)}-point allowance.`,
    })
  }

  for (const category of EVAL_CATEGORIES) {
    const before = previous.byCategory[category]
    const after = current.byCategory[category]
    if (before === undefined || after === undefined) continue

    const drop = before - after
    if (drop > thresholds.maxCategoryDrop) {
      findings.push({
        severity: severity(true),
        code: `category-regression:${category}`,
        message:
          `Category "${category}" fell ${(drop * 100).toFixed(1)} points ` +
          `(${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}%), past the ` +
          `${(thresholds.maxCategoryDrop * 100).toFixed(1)}-point allowance.`,
      })
    }
  }

  const eceIncrease =
    input.report.calibration.expectedCalibrationError - baseline.calibration.expectedCalibrationError
  if (eceIncrease > thresholds.maxEceIncrease) {
    findings.push({
      severity: severity(false),
      code: "calibration-regression",
      message:
        `Expected calibration error rose by ${eceIncrease.toFixed(3)} ` +
        `(${baseline.calibration.expectedCalibrationError.toFixed(3)} → ` +
        `${input.report.calibration.expectedCalibrationError.toFixed(3)}). The confidence the ` +
        "product shows means less than it did.",
    })
  }

  return {
    passed: findings.every((finding) => finding.severity !== "blocking"),
    findings,
    comparison: {
      baselineId: baseline.id,
      reportId: input.report.id,
      baselineScore: previous.meanScore,
      reportScore: current.meanScore,
      bestSingleScore: thesis.bestSingle?.meanScore ?? 0,
    },
  }
}

/** The gate as a person reads it in CI output. */
export function renderGate(result: GateResult): string {
  const lines: string[] = []
  const verdict = result.passed ? "PASSED" : "FAILED"

  lines.push(`[evals] gate ${verdict}`)
  lines.push(
    `        ${result.comparison.reportId} scored ${(result.comparison.reportScore * 100).toFixed(1)}% ` +
      `vs baseline ${result.comparison.baselineId} at ${(result.comparison.baselineScore * 100).toFixed(1)}% ` +
      `(best single model: ${(result.comparison.bestSingleScore * 100).toFixed(1)}%)`,
  )

  if (result.findings.length === 0) {
    lines.push("        no findings")
    return lines.join("\n")
  }

  for (const finding of result.findings) {
    const tag = finding.severity === "blocking" ? "BLOCK" : "warn "
    lines.push(`        ${tag} ${finding.code}: ${finding.message}`)
  }
  return lines.join("\n")
}
