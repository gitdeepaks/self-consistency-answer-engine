import { describe, expect, test } from "bun:test"
import {
  applyCalibration,
  fitCalibration,
  IDENTITY_CALIBRATION,
  measureCalibration,
  reliability,
  type CalibrationPoint,
} from "./calibration.ts"

/**
 * Calibration is arithmetic that decides what a number shown to a user means,
 * which makes it exactly the kind of code that is easy to write plausibly and
 * wrong. The tests below are the four ways that happens: a metric that reads
 * zero on badly calibrated data, a fit that is not monotone, a map that
 * extrapolates past its evidence, and a "correction" that makes things worse
 * while reporting success.
 */

/** A generator with no randomness in it: `share` of the points are correct. */
function points(confidence: number, count: number, share: number): CalibrationPoint[] {
  const correct = Math.round(count * share)
  return Array.from({ length: count }, (_unused, index) => ({
    confidence,
    correct: index < correct,
  }))
}

describe("reliability", () => {
  test("a perfectly calibrated set has no calibration error", () => {
    const report = reliability([
      ...points(0.25, 100, 0.25),
      ...points(0.55, 100, 0.55),
      ...points(0.95, 100, 0.95),
    ])

    expect(report.count).toBe(300)
    expect(report.expectedCalibrationError).toBeCloseTo(0, 6)
    expect(report.maximumCalibrationError).toBeCloseTo(0, 6)
    expect(report.baseRate).toBeCloseTo(0.5833, 3)
  })

  test("systematic overconfidence shows up as the gap it is", () => {
    // Claims 0.9, delivers 0.6 — the failure mode this whole module exists for.
    const report = reliability(points(0.9, 200, 0.6))

    expect(report.expectedCalibrationError).toBeCloseTo(0.3, 6)
    expect(report.brierScore).toBeCloseTo(0.6 * 0.01 + 0.4 * 0.81, 6)
  })

  test("a confidence of exactly 1 lands in the last bin, not off the end", () => {
    const report = reliability(points(1, 10, 1), 10)
    const last = report.bins[report.bins.length - 1]

    expect(last?.count).toBe(10)
    expect(report.bins.reduce((total, bin) => total + bin.count, 0)).toBe(10)
  })

  test("an empty set is reported as empty rather than as perfect", () => {
    const report = reliability([])
    expect(report.count).toBe(0)
    expect(report.bins.every((bin) => bin.count === 0)).toBe(true)
  })
})

describe("fitCalibration", () => {
  test("refuses to fit on too little data", () => {
    expect(fitCalibration(points(0.9, 40, 0.5), { id: "tiny", fittedAt: "2026-09-07T00:00:00.000Z" })).toBeNull()
  })

  test("pools adjacent violators into a monotone map", () => {
    // 0.4 outperforms 0.6, which is impossible for a calibrated scorer — the
    // fit has to merge them rather than reproduce the inversion.
    const map = fitCalibration(
      [...points(0.2, 100, 0.1), ...points(0.4, 100, 0.8), ...points(0.6, 100, 0.4), ...points(0.9, 100, 0.95)],
      { id: "inverted", fittedAt: "2026-09-07T00:00:00.000Z" },
    )

    expect(map).not.toBeNull()
    if (map === null) return

    for (let index = 1; index < map.knots.length; index += 1) {
      const previous = map.knots[index - 1]
      const knot = map.knots[index]
      expect(previous).toBeDefined()
      expect(knot).toBeDefined()
      if (previous === undefined || knot === undefined) continue
      expect(knot.x).toBeGreaterThan(previous.x)
      expect(knot.y).toBeGreaterThanOrEqual(previous.y)
    }

    // The pooled block covering 0.4 and 0.6 sits at their combined accuracy.
    expect(applyCalibration(map, 0.4)).toBeCloseTo(0.6, 6)
    expect(applyCalibration(map, 0.6)).toBeCloseTo(0.6, 6)
  })

  test("a map fitted on overconfident answers pulls them down", () => {
    const map = fitCalibration([...points(0.3, 200, 0.3), ...points(0.9, 200, 0.6)], {
      id: "overconfident",
      fittedAt: "2026-09-07T00:00:00.000Z",
    })

    expect(map).not.toBeNull()
    if (map === null) return
    expect(applyCalibration(map, 0.9)).toBeCloseTo(0.6, 6)
    expect(map.sampleCount).toBe(400)
  })
})

describe("applyCalibration", () => {
  test("the identity map changes nothing", () => {
    for (const raw of [0, 0.13, 0.5, 0.87, 1]) {
      expect(applyCalibration(IDENTITY_CALIBRATION, raw)).toBeCloseTo(raw, 9)
    }
  })

  test("interpolates between knots and clamps outside them", () => {
    const map = {
      id: "test",
      fittedAt: "2026-09-07T00:00:00.000Z",
      sampleCount: 100,
      knots: [
        { x: 0.2, y: 0.1 },
        { x: 0.8, y: 0.7 },
      ],
    }

    expect(applyCalibration(map, 0.5)).toBeCloseTo(0.4, 6)
    // Clamped, not extrapolated: below 0.2 there is no evidence to extend.
    expect(applyCalibration(map, 0)).toBeCloseTo(0.1, 6)
    expect(applyCalibration(map, 1)).toBeCloseTo(0.7, 6)
  })

  test("input outside 0..1 is clamped rather than trusted", () => {
    expect(applyCalibration(IDENTITY_CALIBRATION, 1.7)).toBe(1)
    expect(applyCalibration(IDENTITY_CALIBRATION, -3)).toBe(0)
  })
})

describe("measureCalibration", () => {
  test("reports the improvement on held-out answers", () => {
    const training = [...points(0.3, 200, 0.3), ...points(0.9, 200, 0.6)]
    const heldOut = [...points(0.3, 100, 0.3), ...points(0.9, 100, 0.6)]

    const map = fitCalibration(training, { id: "held-out", fittedAt: "2026-09-07T00:00:00.000Z" })
    expect(map).not.toBeNull()
    if (map === null) return

    const improvement = measureCalibration(map, heldOut)
    expect(improvement.before.expectedCalibrationError).toBeGreaterThan(0.1)
    expect(improvement.after.expectedCalibrationError).toBeCloseTo(0, 6)
    expect(improvement.improved).toBe(true)
  })

  test("a map that does not help is not reported as an improvement", () => {
    const heldOut = points(0.5, 200, 0.5)
    const wrong = {
      id: "wrong",
      fittedAt: "2026-09-07T00:00:00.000Z",
      sampleCount: 500,
      knots: [
        { x: 0, y: 0.9 },
        { x: 1, y: 1 },
      ],
    }

    expect(measureCalibration(wrong, heldOut).improved).toBe(false)
  })
})
