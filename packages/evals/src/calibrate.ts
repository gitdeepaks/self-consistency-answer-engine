import {
  fitCalibration,
  measureCalibration,
  type CalibrationImprovement,
  type CalibrationMap,
  type CalibrationPoint,
} from "@sce/shared"
import { calibrationPoints } from "./report.ts"
import type { EvalReport } from "./schema.ts"

/**
 * Fitting the confidence correction, and refusing to ship a bad one.
 *
 * The evaluator reports a confidence with every answer. Whether that number
 * means anything is an empirical question, and this is where it is answered:
 * pair each confidence with the judge's verdict on the same answer, fit a
 * monotone correction on part of the data, and *measure it on the part that was
 * held out*.
 *
 * The held-out split is the whole discipline. A calibration map evaluated on
 * the data it was fitted to always looks excellent — it is, by construction,
 * the best fit to those points — and shipping on that basis is how a
 * "calibrated" number ends up less trustworthy than the raw one it replaced.
 */

/**
 * Deterministic train/holdout split, keyed on the item id.
 *
 * By item rather than at random, so the split is identical on every machine and
 * every night: two fits of the same report have to produce the same map, or
 * "the calibration changed" becomes an untraceable event. Roughly a third is
 * held out, which is enough to measure with while leaving most of a few hundred
 * answers to fit on.
 */
export const HOLDOUT_SHARE = 1 / 3

function bucket(itemId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < itemId.length; index += 1) {
    hash = Math.imul(hash ^ itemId.charCodeAt(index), 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  return (hash >>> 0) / 0x1_0000_0000
}

export interface CalibrationSplit {
  train: CalibrationPoint[]
  holdout: CalibrationPoint[]
}

export function splitForCalibration(report: EvalReport): CalibrationSplit {
  const train: CalibrationPoint[] = []
  const holdout: CalibrationPoint[] = []

  for (const row of report.results) {
    if (row.error !== null || row.confidence === null || row.system !== "synthesis") continue
    const point: CalibrationPoint = {
      confidence: row.confidence,
      correct: row.verdict.verdict === "pass",
    }
    if (bucket(row.itemId) < HOLDOUT_SHARE) holdout.push(point)
    else train.push(point)
  }

  return { train, holdout }
}

export interface CalibrationOutcome {
  /** Null when there was too little data, or the fit did not help. */
  map: CalibrationMap | null
  /** Present whenever a map was fitted, whether or not it was accepted. */
  improvement: CalibrationImprovement | null
  trainSize: number
  holdoutSize: number
  /** Why no map is being proposed, in a sentence a person can act on. */
  reason: string | null
}

export interface FitOptions {
  /** Names the data the map was fitted on. Recorded in the map itself. */
  id: string
  fittedAt: string
  /** Answers required before a fit is attempted at all. */
  minSamples?: number
}

/**
 * Fit a map, measure it on held-out answers, and accept it only if it helps.
 *
 * "Helps" means both expected calibration error and Brier score improve. A map
 * that lowers one at the other's expense has moved the error around rather than
 * reduced it, and the honest response is to keep reporting the raw number.
 */
export function fitFromReport(report: EvalReport, options: FitOptions): CalibrationOutcome {
  const { train, holdout } = splitForCalibration(report)
  const minSamples = options.minSamples ?? 100

  if (train.length + holdout.length < minSamples) {
    return {
      map: null,
      improvement: null,
      trainSize: train.length,
      holdoutSize: holdout.length,
      reason:
        `Only ${train.length + holdout.length} graded synthesis answers carried a confidence; ` +
        `${minSamples} are needed. A map fitted on fewer is noise dressed as a correction.`,
    }
  }

  const fitted = fitCalibration(train, {
    id: options.id,
    fittedAt: options.fittedAt,
    minSamples: Math.max(1, Math.floor(minSamples * (1 - HOLDOUT_SHARE))),
  })

  if (fitted === null) {
    return {
      map: null,
      improvement: null,
      trainSize: train.length,
      holdoutSize: holdout.length,
      reason: "The fit produced no usable map — the training half is too small or degenerate.",
    }
  }

  if (holdout.length === 0) {
    return {
      map: null,
      improvement: null,
      trainSize: train.length,
      holdoutSize: 0,
      reason: "Nothing was held out, so the map cannot be checked. An unchecked map is not shipped.",
    }
  }

  const improvement = measureCalibration(fitted, holdout)
  if (!improvement.improved) {
    return {
      map: null,
      improvement,
      trainSize: train.length,
      holdoutSize: holdout.length,
      reason:
        "The fitted map did not improve both calibration error and Brier score on held-out " +
        "answers. The raw confidence stays.",
    }
  }

  return {
    map: fitted,
    improvement,
    trainSize: train.length,
    holdoutSize: holdout.length,
    reason: null,
  }
}

/** How a fit reads in a terminal, and in the pull request that ships it. */
export function renderCalibration(outcome: CalibrationOutcome): string {
  const lines: string[] = []
  lines.push(
    `[evals] calibration fitted on ${outcome.trainSize} answers, checked on ${outcome.holdoutSize} held out`,
  )

  if (outcome.improvement !== null) {
    const { before, after } = outcome.improvement
    lines.push(
      `        expected calibration error ${before.expectedCalibrationError.toFixed(3)} → ` +
        `${after.expectedCalibrationError.toFixed(3)}, ` +
        `Brier ${before.brierScore.toFixed(3)} → ${after.brierScore.toFixed(3)}`,
    )
  }

  if (outcome.map === null) {
    lines.push(`        no map proposed — ${outcome.reason ?? "unknown reason"}`)
    return lines.join("\n")
  }

  lines.push(`        map "${outcome.map.id}" with ${outcome.map.knots.length} knots:`)
  for (const knot of outcome.map.knots) {
    lines.push(`          claimed ${knot.x.toFixed(2)} → ${knot.y.toFixed(2)}`)
  }
  lines.push("        Deploy it as CONFIDENCE_CALIBRATION on the worker.")
  return lines.join("\n")
}

/** The report's own confidence signal, for a summary line. */
export function confidenceSample(report: EvalReport): CalibrationPoint[] {
  return calibrationPoints(report.results)
}
