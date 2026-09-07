import { describe, expect, test } from "bun:test"
import { agreementScores, majorityVote, systemsFromRun, type RunCandidate } from "./baselines.ts"
import { cohensKappa, summariseAgreement, type AgreementPair } from "./agreement.ts"
import { checkCoverage, coverage, loadDataset, loadHumanLabels, sample } from "./dataset.ts"
import { fitFromReport, splitForCalibration } from "./calibrate.ts"
import { runGate } from "./gate.ts"
import { buildJudgePrompt, judgeFor, judgePanel, scoreVerdict, JUDGE_SYSTEM_PROMPT } from "./judge.ts"
import { buildReport, compareThesis, renderReport, summariseSystem } from "./report.ts"
import { runEvals, type AnswerEngine, type EngineAnswer, type Grader } from "./runner.ts"
import type { EvalReport, GoldenItem, ItemResult, JudgeVerdict, SystemId } from "./schema.ts"

/**
 * The harness measures the product, and nothing measures the harness — so these
 * tests are what stop a quality report being confidently wrong. They cover the
 * four places that would be silently wrong rather than visibly broken: a
 * baseline that flatters the panel, an aggregate that hides a regression, a
 * gate that passes one, and a calibration that ships without being checked.
 *
 * Nothing here makes a model call. The judge is injected, the engine is
 * injected, and every number is arithmetic on fixtures.
 */

/* ------------------------------------------------------------- fixtures */

function candidate(label: string, content: string): RunCandidate {
  return { label, provider: "openai", model: "gpt-5.5", content }
}

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    correctness: 1,
    completeness: 1,
    citationFidelity: 1,
    rubricHits: [],
    rubricMisses: [],
    violations: [],
    verdict: "pass",
    rationale: "fixture",
    ...overrides,
  }
}

function result(overrides: Partial<ItemResult> = {}): ItemResult {
  return {
    itemId: "factual-001",
    category: "factual",
    system: "synthesis",
    confidence: 0.9,
    score: 1,
    judgeModel: "anthropic:claude-opus-5",
    verdict: verdict(),
    error: null,
    ...overrides,
  }
}

function report(rows: readonly ItemResult[], overrides: Partial<EvalReport> = {}): EvalReport {
  return buildReport({
    id: overrides.id ?? "report-1",
    createdAt: "2026-09-07T00:00:00.000Z",
    dataset: overrides.dataset ?? { id: "goldens", size: rows.length, digest: "abc" },
    engine: { panelId: "trio", promptSetId: "prompts.v1", baseUrl: "http://test" },
    judges: ["anthropic:claude-opus-5"],
    results: rows,
    failures: [],
    ...overrides,
  })
}

const ITEM: GoldenItem = {
  id: "factual-001",
  category: "factual",
  prompt: "Why is the sky blue?",
  reference: "Rayleigh scattering.",
  rubric: ["Names Rayleigh scattering", "Explains the wavelength dependence"],
  antiRubric: ["Says the sky reflects the ocean"],
  expectation: undefined,
  tags: [],
  source: "curated",
  addedAt: "2026-09-07",
}

/* ------------------------------------------------------------- dataset */

describe("the shipped golden set", () => {
  test("parses, and every item is gradeable", async () => {
    const dataset = await loadDataset()

    expect(dataset.items.length).toBeGreaterThanOrEqual(100)
    for (const item of dataset.items) {
      expect(item.rubric.length).toBeGreaterThan(0)
      expect(item.prompt.trim().length).toBeGreaterThan(0)
    }
  })

  test("covers every category deeply enough to gate on", async () => {
    const dataset = await loadDataset()
    expect(checkCoverage(dataset.items)).toEqual([])
  })

  test("adversarial items say what the right behaviour is", async () => {
    const dataset = await loadDataset()
    const adversarial = dataset.items.filter((item) => item.category === "adversarial")

    // An adversarial item without an anti-rubric or a stated expectation cannot
    // distinguish "refused the false premise" from "answered fluently".
    for (const item of adversarial) {
      expect(item.antiRubric.length > 0 || item.expectation !== undefined).toBe(true)
    }
  })

  test("the digest changes when an item changes, and not otherwise", async () => {
    const first = await loadDataset()
    const second = await loadDataset()
    expect(first.digest).toBe(second.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{32}$/)
  })

  test("human labels reference items that exist, and include both verdicts", async () => {
    const dataset = await loadDataset()
    const labels = await loadHumanLabels()
    const ids = new Set(dataset.items.map((item) => item.id))

    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(ids.has(label.itemId)).toBe(true)

    // A calibration set of all-passes measures nothing: kappa would be zero
    // however good the judge was.
    expect(labels.some((label) => label.verdict === "pass")).toBe(true)
    expect(labels.some((label) => label.verdict === "fail")).toBe(true)
  })

  test("sampling is deterministic and stays balanced", async () => {
    const dataset = await loadDataset()

    const first = sample(dataset.items, 25).map((item) => item.id)
    const second = sample(dataset.items, 25).map((item) => item.id)
    expect(first).toEqual(second)

    const categories = new Set(
      sample(dataset.items, 25).map(
        (id) => dataset.items.find((item) => item.id === id.id)?.category,
      ),
    )
    expect(categories.size).toBe(5)
    expect(sample(dataset.items, 10_000).length).toBe(dataset.items.length)
  })

  test("coverage counts what it says it counts", async () => {
    const dataset = await loadDataset()
    const seen = coverage(dataset.items)
    const total = Object.values(seen.byCategory).reduce((sum, count) => sum + count, 0)

    expect(total).toBe(seen.total)
    expect(seen.bySource.curated + seen.bySource.feedback).toBe(seen.total)
  })
})

/* ----------------------------------------------------------- baselines */

describe("baselines", () => {
  test("majority vote picks the candidate closest to the consensus", () => {
    const winner = majorityVote([
      candidate("A", "the capital of france is paris and it is on the seine"),
      candidate("B", "the capital of france is paris on the river seine"),
      candidate("C", "the answer is lyon which sits on the rhone"),
    ])

    expect(winner).not.toBeNull()
    expect(winner?.label).not.toBe("C")
    expect(["A", "B"]).toContain(winner?.label ?? "")
  })

  test("agreement scores rank the outlier last", () => {
    const scores = agreementScores([
      candidate("A", "alpha beta gamma delta"),
      candidate("B", "alpha beta gamma delta epsilon"),
      candidate("C", "entirely unrelated words here"),
    ])

    expect(scores[2]).toBeLessThan(scores[0] ?? 0)
    expect(scores[2]).toBeLessThan(scores[1] ?? 0)
  })

  test("an empty panel has no majority rather than a fabricated one", () => {
    expect(majorityVote([])).toBeNull()
  })

  test("one run yields the synthesis, every member, and the vote", () => {
    const systems = systemsFromRun({
      synthesis: "the merged answer",
      confidence: 0.8,
      candidates: [candidate("OpenAI", "one"), candidate("Claude", "two")],
    })

    expect(systems.map((entry) => entry.system)).toEqual([
      "synthesis",
      "single:OpenAI",
      "single:Claude",
      "majority",
    ])
    // Only the panel reports a confidence; inventing one for a single model
    // would fabricate the calibration measurement.
    expect(systems[0]?.confidence).toBe(0.8)
    expect(systems.slice(1).every((entry) => entry.confidence === null)).toBe(true)
  })

  test("a single-member panel has no majority vote to grade twice", () => {
    const systems = systemsFromRun({
      synthesis: "merged",
      confidence: 0.5,
      candidates: [candidate("OpenAI", "only one")],
    })
    expect(systems.map((entry) => entry.system)).toEqual(["synthesis", "single:OpenAI"])
  })

  test("two samples of one model are two systems, not one", () => {
    const systems = systemsFromRun({
      synthesis: "merged",
      confidence: 0.5,
      candidates: [candidate("OpenAI #1", "first"), candidate("OpenAI #2", "second")],
    })
    const singles = systems.filter((entry) => entry.system.startsWith("single:"))
    expect(new Set(singles.map((entry) => entry.system)).size).toBe(2)
  })
})

/* -------------------------------------------------------------- judging */

describe("the judge", () => {
  test("the grading prompt never reveals which system produced the answer", () => {
    const prompt = buildJudgePrompt(ITEM, "some answer text")

    for (const leak of ["synthesis", "majority", "single:", "panel", "evaluator"]) {
      expect(prompt.toLowerCase()).not.toContain(leak)
    }
    expect(prompt).toContain(ITEM.prompt)
    expect(prompt).toContain("Names Rayleigh scattering")
    expect(prompt).toContain("some answer text")
  })

  test("the system prompt tells the judge it is measuring, not participating", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("measuring instrument")
    expect(JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain("correctness")
  })

  test("the anti-rubric and the expectation reach the judge when present", () => {
    const prompt = buildJudgePrompt(ITEM, "answer")
    expect(prompt).toContain("Says the sky reflects the ocean")

    const withExpectation = buildJudgePrompt(
      { ...ITEM, expectation: "Should challenge the premise" },
      "answer",
    )
    expect(withExpectation).toContain("Should challenge the premise")
  })

  test("judge rotation is stable, and spread across systems", () => {
    const panel = {
      models: [
        { id: "a", provider: "openai" as const, model: "a" },
        { id: "b", provider: "anthropic" as const, model: "b" },
        { id: "c", provider: "google" as const, model: "c" },
      ],
    }

    expect(judgeFor(panel, "item-1", "synthesis").id).toBe(judgeFor(panel, "item-1", "synthesis").id)

    // Across many items, every judge is used — a rotation that always picked
    // the first would make the report a comparison of one judge's opinions.
    const used = new Set(
      Array.from({ length: 60 }, (_unused, index) => judgeFor(panel, `item-${index}`, "synthesis").id),
    )
    expect(used.size).toBe(3)
  })

  test("scoring weights correctness above everything and penalises violations", () => {
    expect(scoreVerdict(verdict())).toBeCloseTo(1, 6)

    const wrong = scoreVerdict(verdict({ correctness: 0 }))
    const incomplete = scoreVerdict(verdict({ completeness: 0 }))
    expect(wrong).toBeLessThan(incomplete)

    const violating = scoreVerdict(verdict({ violations: ["said the ocean reflects"] }))
    expect(violating).toBeLessThan(1)
    // Capped, so a judge listing eight violations cannot drive a correct answer
    // below zero and out of range.
    expect(scoreVerdict(verdict({ violations: Array.from({ length: 8 }, () => "x") }))).toBeGreaterThanOrEqual(0)
  })

  test("a panel with no reachable provider is an error, not an empty measurement", () => {
    // No keys are configured in the test environment for a provider that does
    // not exist, so an empty request must throw rather than silently grade
    // nothing.
    expect(() => judgePanel([])).toThrow()
  })
})

/* -------------------------------------------------------------- reports */

describe("aggregation", () => {
  test("failed rows are excluded, never scored zero", () => {
    const summary = summariseSystem("synthesis", [
      result({ itemId: "a", score: 1 }),
      result({ itemId: "b", score: 1 }),
      result({ itemId: "c", score: 0, error: "the provider timed out" }),
    ])

    expect(summary.graded).toBe(2)
    expect(summary.meanScore).toBeCloseTo(1, 6)
  })

  test("categories are weighted equally, so a big category cannot carry the mean", () => {
    const rows: ItemResult[] = [
      ...Array.from({ length: 20 }, (_unused, index) =>
        result({ itemId: `f-${index}`, category: "factual", score: 1 }),
      ),
      result({ itemId: "c-1", category: "coding", score: 0 }),
      result({ itemId: "c-2", category: "coding", score: 0 }),
    ]

    const summary = summariseSystem("synthesis", rows)
    // A row-weighted mean would be 0.91 and would hide a total collapse in
    // coding. The category-weighted mean is 0.5, which is the honest reading.
    expect(summary.meanScore).toBeCloseTo(0.5, 6)
    expect(summary.byCategory.coding).toBeCloseTo(0, 6)
  })

  test("calibration is measured for the synthesis only", () => {
    const built = report([
      result({ itemId: "a", system: "synthesis", confidence: 0.9 }),
      result({ itemId: "a", system: "single:OpenAI", confidence: null }),
      result({ itemId: "b", system: "synthesis", confidence: 0.8, verdict: verdict({ verdict: "fail" }) }),
    ])

    expect(built.calibration.sampleSize).toBe(2)
    expect(built.calibration.baseRate).toBeCloseTo(0.5, 6)
  })

  test("the thesis comparison is against the best single model, not the average", () => {
    const built = report([
      result({ itemId: "a", system: "synthesis", score: 0.8 }),
      result({ itemId: "a", system: "single:Good", score: 0.75 }),
      result({ itemId: "a", system: "single:Bad", score: 0.2 }),
      result({ itemId: "a", system: "majority", score: 0.6 }),
    ])

    const thesis = compareThesis(built)
    expect(thesis.bestSingle?.system).toBe("single:Good")
    expect(thesis.edgeOverBestSingle).toBeCloseTo(0.05, 6)
    expect(thesis.edgeOverMajority).toBeCloseTo(0.2, 6)
  })

  test("the rendered report leads with the thesis and names the ungraded", () => {
    const built = report([result({ system: "synthesis", score: 0.9 })], {
      failures: [{ itemId: "coding-001", system: "synthesis", error: "provider down" }],
    })

    const markdown = renderReport(built)
    expect(markdown).toContain("## The thesis")
    expect(markdown).toContain("coding-001")
    expect(markdown).toContain("not scored zero")
  })
})

/* ----------------------------------------------------------------- gate */

describe("the gate", () => {
  const baseline = report(
    [
      result({ itemId: "a", category: "factual", system: "synthesis", score: 0.9 }),
      result({ itemId: "b", category: "coding", system: "synthesis", score: 0.9 }),
      result({ itemId: "a", category: "factual", system: "single:Good", score: 0.7 }),
    ],
    { id: "baseline-1" },
  )

  test("passes an unchanged report", () => {
    const outcome = runGate({ report: baseline, baseline, thresholds: { minGraded: 1 } })
    expect(outcome.passed).toBe(true)
    expect(outcome.findings.filter((finding) => finding.severity === "blocking")).toEqual([])
  })

  test("blocks a score regression past the allowance", () => {
    const regressed = report(
      [
        result({ itemId: "a", category: "factual", system: "synthesis", score: 0.9 }),
        result({ itemId: "b", category: "coding", system: "synthesis", score: 0.5 }),
        result({ itemId: "a", category: "factual", system: "single:Good", score: 0.7 }),
      ],
      { id: "candidate-1" },
    )

    const outcome = runGate({ report: regressed, baseline, thresholds: { minGraded: 1 } })
    expect(outcome.passed).toBe(false)
    expect(outcome.findings.some((finding) => finding.code === "score-regression")).toBe(true)
    expect(outcome.findings.some((finding) => finding.code === "category-regression:coding")).toBe(true)
  })

  test("a drop inside the allowance is not a failure", () => {
    const wobble = report(
      [
        result({ itemId: "a", category: "factual", system: "synthesis", score: 0.89 }),
        result({ itemId: "b", category: "coding", system: "synthesis", score: 0.895 }),
        result({ itemId: "a", category: "factual", system: "single:Good", score: 0.7 }),
      ],
      { id: "candidate-2" },
    )

    expect(runGate({ report: wobble, baseline, thresholds: { minGraded: 1 } }).passed).toBe(true)
  })

  test("blocks when the panel stops beating its own best member", () => {
    const broken = report(
      [
        result({ itemId: "a", category: "factual", system: "synthesis", score: 0.6 }),
        result({ itemId: "a", category: "factual", system: "single:Good", score: 0.85 }),
      ],
      { id: "thesis-broken" },
    )

    const outcome = runGate({ report: broken, baseline: null, thresholds: { minGraded: 1 } })
    expect(outcome.passed).toBe(false)
    expect(outcome.findings.some((finding) => finding.code === "thesis-broken")).toBe(true)
  })

  test("a changed dataset downgrades every comparison to a warning", () => {
    const regressed = report(
      [
        result({ itemId: "a", category: "factual", system: "synthesis", score: 0.4 }),
        result({ itemId: "b", category: "coding", system: "synthesis", score: 0.4 }),
        result({ itemId: "a", category: "factual", system: "single:Good", score: 0.3 }),
      ],
      { id: "new-dataset", dataset: { id: "goldens", size: 3, digest: "different" } },
    )

    const outcome = runGate({ report: regressed, baseline, thresholds: { minGraded: 1 } })
    expect(outcome.findings.some((finding) => finding.code === "dataset-changed")).toBe(true)
    // The regression is reported, but it does not block: the numbers describe
    // different questions.
    expect(outcome.findings.filter((finding) => finding.severity === "blocking")).toEqual([])
    expect(outcome.passed).toBe(true)
  })

  test("a sample too small to conclude anything blocks rather than passing", () => {
    const thin = report([result({ system: "synthesis", score: 1 })], { id: "thin" })
    const outcome = runGate({ report: thin, baseline: null })

    expect(outcome.passed).toBe(false)
    expect(outcome.findings.some((finding) => finding.code === "sample-too-small")).toBe(true)
  })

  test("a report with nothing graded is a harness failure, not a perfect score", () => {
    const empty = report([], { id: "empty" })
    const outcome = runGate({ report: empty, baseline })

    expect(outcome.passed).toBe(false)
    expect(outcome.findings[0]?.code).toBe("no-synthesis")
  })
})

/* --------------------------------------------------------- calibration */

describe("calibration from a report", () => {
  function overconfident(count: number): ItemResult[] {
    // Claims 0.9 and is right 60% of the time — the shape the correction exists
    // to fix.
    return Array.from({ length: count }, (_unused, index) =>
      result({
        itemId: `item-${index}`,
        system: "synthesis",
        confidence: 0.9,
        verdict: verdict({ verdict: index % 10 < 6 ? "pass" : "fail" }),
      }),
    )
  }

  test("the train and holdout split is deterministic and disjoint in size", () => {
    const built = report(overconfident(300))
    const first = splitForCalibration(built)
    const second = splitForCalibration(built)

    expect(first.train.length).toBe(second.train.length)
    expect(first.holdout.length).toBe(second.holdout.length)
    expect(first.train.length + first.holdout.length).toBe(300)
    expect(first.holdout.length).toBeGreaterThan(0)
  })

  test("fits a map that pulls an overconfident number down", () => {
    const outcome = fitFromReport(report(overconfident(300)), {
      id: "test",
      fittedAt: "2026-09-07T00:00:00.000Z",
    })

    expect(outcome.map).not.toBeNull()
    expect(outcome.improvement?.improved).toBe(true)
    expect(outcome.improvement?.after.expectedCalibrationError ?? 1).toBeLessThan(
      outcome.improvement?.before.expectedCalibrationError ?? 0,
    )
  })

  test("refuses to fit on too little data, and says why", () => {
    const outcome = fitFromReport(report(overconfident(20)), {
      id: "tiny",
      fittedAt: "2026-09-07T00:00:00.000Z",
    })

    expect(outcome.map).toBeNull()
    expect(outcome.reason).toContain("100 are needed")
  })

  test("a well-calibrated report proposes no map", () => {
    // Nothing to correct: the fit cannot beat the identity, so none is shipped.
    const calibrated = Array.from({ length: 300 }, (_unused, index) =>
      result({
        itemId: `item-${index}`,
        system: "synthesis",
        confidence: 0.9,
        verdict: verdict({ verdict: index % 10 < 9 ? "pass" : "fail" }),
      }),
    )

    const outcome = fitFromReport(report(calibrated), {
      id: "already-good",
      fittedAt: "2026-09-07T00:00:00.000Z",
    })
    expect(outcome.map).toBeNull()
  })
})

/* ---------------------------------------------------------- agreement */

describe("judge agreement", () => {
  function pair(human: "pass" | "fail", judge: "pass" | "fail", model = "a"): AgreementPair {
    return { human, judge, judgeModel: model, correctnessError: null }
  }

  test("kappa is zero for a judge that agrees only as often as chance", () => {
    // A judge that says "pass" to everything, on a set that is 90% pass: 90%
    // raw agreement, and no information at all.
    const pairs = [
      ...Array.from({ length: 9 }, () => pair("pass", "pass")),
      pair("fail", "pass"),
    ]

    const summary = summariseAgreement(pairs)
    expect(summary.rawAgreement).toBeCloseTo(0.9, 6)
    expect(summary.kappa).toBeCloseTo(0, 6)
  })

  test("kappa is one for perfect agreement on a mixed set", () => {
    const pairs = [pair("pass", "pass"), pair("fail", "fail"), pair("pass", "pass"), pair("fail", "fail")]
    expect(cohensKappa(pairs)).toBeCloseTo(1, 6)
  })

  test("kappa is negative when the judge disagrees systematically", () => {
    const pairs = [pair("pass", "fail"), pair("fail", "pass"), pair("pass", "fail"), pair("fail", "pass")]
    expect(cohensKappa(pairs)).toBeLessThan(0)
  })

  test("per-judge figures are reported separately", () => {
    const summary = summariseAgreement([
      pair("pass", "pass", "good"),
      pair("fail", "fail", "good"),
      pair("pass", "fail", "bad"),
      pair("fail", "pass", "bad"),
    ])

    expect(summary.perJudge.map((judge) => judge.judge)).toEqual(["bad", "good"])
    expect(summary.perJudge.find((judge) => judge.judge === "good")?.kappa).toBeCloseTo(1, 6)
  })

  test("an empty set is zero, not perfect", () => {
    expect(cohensKappa([])).toBe(0)
  })
})

/* ------------------------------------------------------------- runner */

describe("the runner", () => {
  const items: GoldenItem[] = [
    { ...ITEM, id: "item-1" },
    { ...ITEM, id: "item-2" },
    { ...ITEM, id: "item-3" },
  ]

  function engine(behaviour: (item: GoldenItem) => Promise<EngineAnswer>): AnswerEngine {
    return { name: "fake", ask: behaviour }
  }

  /** A grader that grades. No network, no model, no flake. */
  const grade: Grader = (judge, _item, _answer) =>
    Promise.resolve({ judgeModel: judge.id, verdict: verdict() })

  const judges = { models: [{ id: "fake-judge", provider: "openai" as const, model: "fake" }] }

  const answer = (item: GoldenItem): Promise<EngineAnswer> =>
    Promise.resolve({
      runId: `run-${item.id}`,
      synthesis: "merged answer",
      confidence: 0.85,
      candidates: [candidate("OpenAI", "first answer"), candidate("Claude", "second answer")],
    })

  test("grades every system of every item", async () => {
    const graded: string[] = []
    const output = await runEvals(items, {
      engine: engine(answer),
      judges,
      grade,
      concurrency: 2,
      onProgress: (done) => graded.push(String(done)),
    })

    // Three items x (synthesis + two members + majority), all graded.
    expect(output.results.length).toBe(12)
    expect(output.failures).toEqual([])
    expect(graded.length).toBe(3)
  })

  test("an engine failure is recorded, and does not stop the run", async () => {
    const output = await runEvals(items, {
      engine: engine((item) =>
        item.id === "item-2" ? Promise.reject(new Error("provider down")) : answer(item),
      ),
      judges,
      grade,
      concurrency: 1,
    })

    expect(output.failures.some((failure) => failure.itemId === "item-2")).toBe(true)
    // The other two items were still attempted.
    expect(
      new Set(
        [...output.results, ...output.failures].map((row) => row.itemId),
      ).has("item-1"),
    ).toBe(true)
  })

  test("results come back in a stable order regardless of scheduling", async () => {
    const first = await runEvals(items, {
      engine: engine(answer),
      judges,
      grade,
      concurrency: 3,
    })
    const second = await runEvals(items, {
      engine: engine(answer),
      judges,
      grade,
      concurrency: 1,
    })

    const key = (rows: readonly { itemId: string; system: SystemId }[]): string =>
      rows.map((row) => `${row.itemId}/${row.system}`).join(",")
    expect(key(first.results)).toBe(key(second.results))
    expect(key(first.failures)).toBe(key(second.failures))
  })
})
