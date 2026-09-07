import { z } from "zod"

/**
 * Making the confidence number mean something.
 *
 * The evaluator reports a confidence with every answer, and until it has been
 * measured that number is a mood: an LLM asked how sure it is reliably says
 * "0.85" whether it is right nine times in ten or six. A number the product
 * displays and — through the Phase 7 gate — makes decisions on has to be
 * *calibrated*: of the answers reported at 0.8, about 80% should be correct.
 *
 * This module is the measurement and the correction, and it is deliberately
 * pure arithmetic: no model calls, no clock, no storage. The evals harness
 * measures a fitted map against held-out data, the worker applies whichever map
 * is configured, and the raw number is stored alongside the corrected one for
 * ever — because a calibration fitted on last month's data has to be
 * re-checkable against the answers it was applied to.
 */

/** One graded answer: what the evaluator claimed, and whether it was right. */
export const calibrationPointSchema = z.object({
  confidence: z.number().min(0).max(1),
  correct: z.boolean(),
})
export type CalibrationPoint = z.infer<typeof calibrationPointSchema>

export interface ReliabilityBin {
  readonly lower: number
  readonly upper: number
  readonly count: number
  /** Mean claimed confidence inside the bin. NaN is impossible: empty bins are 0. */
  readonly meanConfidence: number
  /** Share of the bin that was actually correct. */
  readonly accuracy: number
}

export interface ReliabilityReport {
  readonly count: number
  readonly bins: readonly ReliabilityBin[]
  /**
   * Expected calibration error: the bin-size-weighted mean gap between claimed
   * confidence and measured accuracy. Zero is perfect; 0.1 means the number is
   * off by ten points on average, which is enough to stop showing it.
   */
  readonly expectedCalibrationError: number
  /** The worst single bin, which is what an average hides. */
  readonly maximumCalibrationError: number
  /** Brier score: mean squared error of the probability. Lower is better. */
  readonly brierScore: number
  /** Base rate of correctness — the accuracy a constant predictor would get. */
  readonly baseRate: number
}

export const DEFAULT_RELIABILITY_BINS = 10

/**
 * Bin the answers by claimed confidence and measure each bin.
 *
 * Equal-width bins rather than equal-count ones, because the question being
 * asked is "what does 0.8 mean", and that is a question about the *value*, not
 * about the quantile it happens to fall in. The cost is that a bin nobody
 * lands in is empty, which is reported honestly as a zero count rather than
 * smoothed away.
 */
export function reliability(
  points: readonly CalibrationPoint[],
  binCount: number = DEFAULT_RELIABILITY_BINS,
): ReliabilityReport {
  const bins = Math.max(1, Math.trunc(binCount))
  const buckets: { total: number; correct: number; confidence: number }[] = Array.from(
    { length: bins },
    () => ({ total: 0, correct: 0, confidence: 0 }),
  )

  let squaredError = 0
  let correctTotal = 0

  for (const point of points) {
    // The top edge belongs to the last bin: a confidence of exactly 1 is a
    // claim, not an out-of-range index.
    const index = Math.min(bins - 1, Math.floor(point.confidence * bins))
    const bucket = buckets[index]
    if (bucket === undefined) continue

    bucket.total += 1
    bucket.confidence += point.confidence
    if (point.correct) {
      bucket.correct += 1
      correctTotal += 1
    }
    squaredError += (point.confidence - (point.correct ? 1 : 0)) ** 2
  }

  const count = points.length
  let weightedGap = 0
  let worstGap = 0

  const report: ReliabilityBin[] = buckets.map((bucket, index) => {
    const meanConfidence = bucket.total === 0 ? 0 : bucket.confidence / bucket.total
    const accuracy = bucket.total === 0 ? 0 : bucket.correct / bucket.total
    if (bucket.total > 0) {
      const gap = Math.abs(meanConfidence - accuracy)
      weightedGap += (bucket.total / count) * gap
      worstGap = Math.max(worstGap, gap)
    }
    return {
      lower: index / bins,
      upper: (index + 1) / bins,
      count: bucket.total,
      meanConfidence,
      accuracy,
    }
  })

  return {
    count,
    bins: report,
    expectedCalibrationError: count === 0 ? 0 : weightedGap,
    maximumCalibrationError: worstGap,
    brierScore: count === 0 ? 0 : squaredError / count,
    baseRate: count === 0 ? 0 : correctTotal / count,
  }
}

/* ------------------------------------------------------------ the mapping */

/**
 * A monotone piecewise-linear correction, stored as its knots.
 *
 * Isotonic regression is the standard non-parametric calibrator, and the reason
 * to prefer it here over Platt scaling is that it assumes only *monotonicity* —
 * a higher claimed confidence should not mean a lower true accuracy — rather
 * than a sigmoid the evaluator has no reason to follow. Storing the fitted
 * function as knots keeps it inspectable: an operator can read the map and see
 * that "the evaluator's 0.9 is really 0.72" without running anything.
 */
export const calibrationKnotSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
})
export type CalibrationKnot = z.infer<typeof calibrationKnotSchema>

export const calibrationMapSchema = z
  .object({
    /** Names the data it was fitted on, e.g. "goldens.v1@2026-09-07". */
    id: z.string().trim().min(1).max(120),
    fittedAt: z.iso.datetime(),
    sampleCount: z.number().int().nonnegative(),
    knots: z.array(calibrationKnotSchema).min(2).max(64),
  })
  .refine((map) => map.knots.every((knot, index) => index === 0 || knot.x > (map.knots[index - 1]?.x ?? -1)), {
    message: "Knots must be strictly increasing in x",
    path: ["knots"],
  })
  .refine((map) => map.knots.every((knot, index) => index === 0 || knot.y >= (map.knots[index - 1]?.y ?? 0)), {
    message: "Knots must be non-decreasing in y — a calibration map has to be monotone",
    path: ["knots"],
  })
export type CalibrationMap = z.infer<typeof calibrationMapSchema>

/** The map that changes nothing. What a build runs with until one is fitted. */
export const IDENTITY_CALIBRATION: CalibrationMap = {
  id: "identity",
  fittedAt: "2026-09-07T00:00:00.000Z",
  sampleCount: 0,
  knots: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
}

/**
 * Apply a map: piecewise-linear interpolation between its knots.
 *
 * Values outside the fitted range are clamped to the nearest knot rather than
 * extrapolated. Extrapolating an isotonic fit past its data is how a
 * calibration ends up reporting a confidence no measurement supports.
 */
export function applyCalibration(map: CalibrationMap, raw: number): number {
  const clamped = Math.min(1, Math.max(0, raw))
  const knots = map.knots

  const first = knots[0]
  const last = knots[knots.length - 1]
  if (first === undefined || last === undefined) return clamped
  if (clamped <= first.x) return first.y
  if (clamped >= last.x) return last.y

  for (let index = 1; index < knots.length; index += 1) {
    const left = knots[index - 1]
    const right = knots[index]
    if (left === undefined || right === undefined) continue
    if (clamped <= right.x) {
      const span = right.x - left.x
      if (span <= 0) return right.y
      const t = (clamped - left.x) / span
      return left.y + t * (right.y - left.y)
    }
  }
  return last.y
}

/**
 * Fit a calibration map by isotonic regression (pool adjacent violators).
 *
 * The algorithm is the whole of the method: sort the observations by claimed
 * confidence, then repeatedly merge any adjacent block whose mean accuracy is
 * lower than the block before it, until the sequence is non-decreasing. What
 * comes out is the monotone step function closest to the data in squared error,
 * and its steps become the knots.
 *
 * Returns null below `minSamples`. A map fitted on forty answers is noise
 * dressed as a correction, and shipping one would make the number *less*
 * trustworthy than the raw output it replaced.
 */
export function fitCalibration(
  points: readonly CalibrationPoint[],
  options: { id: string; fittedAt: string; minSamples?: number },
): CalibrationMap | null {
  const minSamples = options.minSamples ?? 100
  if (points.length < minSamples) return null

  const sorted = [...points].sort((left, right) => left.confidence - right.confidence)

  /** A pooled run of observations, and the span of confidences it covers. */
  interface Block {
    weight: number
    sumCorrect: number
    minConfidence: number
    maxConfidence: number
  }

  const blocks: Block[] = []
  for (const point of sorted) {
    blocks.push({
      weight: 1,
      sumCorrect: point.correct ? 1 : 0,
      minConfidence: point.confidence,
      maxConfidence: point.confidence,
    })

    // Pool while the last block violates monotonicity against the one before it.
    for (;;) {
      const last = blocks[blocks.length - 1]
      const previous = blocks[blocks.length - 2]
      if (last === undefined || previous === undefined) break
      if (previous.sumCorrect / previous.weight <= last.sumCorrect / last.weight) break

      blocks.length -= 2
      blocks.push({
        weight: previous.weight + last.weight,
        sumCorrect: previous.sumCorrect + last.sumCorrect,
        minConfidence: previous.minConfidence,
        maxConfidence: last.maxConfidence,
      })
    }
  }

  /**
   * Each block becomes a *flat segment*, not a point.
   *
   * Emitting one knot at a block's mean confidence would put a ramp where the
   * fit says there is none: every observation inside a pooled block shares one
   * measured accuracy, and interpolating between block means would report a
   * different correction for two confidences the data could not tell apart.
   * Two knots — the block's first and last confidence — is what preserves that.
   */
  const knots: CalibrationKnot[] = []
  const push = (x: number, y: number): void => {
    const previous = knots[knots.length - 1]
    // Equal confidences in two blocks: keep the later, higher-accuracy reading.
    if (previous !== undefined && previous.x >= x) knots.length -= 1
    knots.push({ x, y })
  }

  for (const block of blocks) {
    const accuracy = block.sumCorrect / block.weight
    push(block.minConfidence, accuracy)
    if (block.maxConfidence > block.minConfidence) push(block.maxConfidence, accuracy)
  }

  // Anchor the ends so the map is total over [0, 1] without extrapolating.
  const first = knots[0]
  const last = knots[knots.length - 1]
  if (first === undefined || last === undefined) return null
  if (first.x > 0) knots.unshift({ x: 0, y: first.y })
  if (last.x < 1) knots.push({ x: 1, y: last.y })

  const parsed = calibrationMapSchema.safeParse({
    id: options.id,
    fittedAt: options.fittedAt,
    sampleCount: points.length,
    knots: thin(knots),
  })
  return parsed.success ? parsed.data : null
}

/**
 * Keep the map under the 64-knot cap by dropping the least informative knots.
 *
 * A pooled fit on a few hundred points rarely produces more than a dozen
 * blocks, so this is a guard rather than a routine step — but "the fit was
 * silently rejected by its own schema" is not an acceptable failure mode, and
 * dropping collinear interior knots changes the function by nothing.
 */
function thin(knots: readonly CalibrationKnot[], limit = 64): CalibrationKnot[] {
  if (knots.length <= limit) return [...knots]

  const kept: CalibrationKnot[] = []
  const stride = (knots.length - 1) / (limit - 1)
  for (let index = 0; index < limit; index += 1) {
    const knot = knots[Math.min(knots.length - 1, Math.round(index * stride))]
    const previous = kept[kept.length - 1]
    if (knot === undefined) continue
    if (previous !== undefined && previous.x >= knot.x) continue
    kept.push(knot)
  }
  return kept
}

/**
 * The improvement a map buys, on data it was not fitted on.
 *
 * Reported by the evals harness and by the gate. A map that does not reduce
 * expected calibration error on held-out answers is not shipped, which is the
 * only thing that stops calibration becoming a second unmeasured number on top
 * of the first.
 */
export interface CalibrationImprovement {
  readonly before: ReliabilityReport
  readonly after: ReliabilityReport
  readonly eceDelta: number
  readonly brierDelta: number
  readonly improved: boolean
}

export function measureCalibration(
  map: CalibrationMap,
  heldOut: readonly CalibrationPoint[],
  binCount: number = DEFAULT_RELIABILITY_BINS,
): CalibrationImprovement {
  const before = reliability(heldOut, binCount)
  const after = reliability(
    heldOut.map((point) => ({ confidence: applyCalibration(map, point.confidence), correct: point.correct })),
    binCount,
  )
  const eceDelta = after.expectedCalibrationError - before.expectedCalibrationError
  const brierDelta = after.brierScore - before.brierScore
  return { before, after, eceDelta, brierDelta, improved: eceDelta < 0 && brierDelta <= 0 }
}
