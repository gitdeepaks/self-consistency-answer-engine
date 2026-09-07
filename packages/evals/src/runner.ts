import { Sce } from "@sce/sdk"
import { describeError } from "@sce/shared"
import { systemsFromRun, type RunCandidate } from "./baselines.ts"
import { judgeAnswer, judgeFor, scoreVerdict, type JudgePanel, type JudgeResult } from "./judge.ts"
import type { GoldenItem, ItemResult, SystemId } from "./schema.ts"

/**
 * Running the golden set against a live engine.
 *
 * The runner asks the *product*, over its own public API, rather than calling
 * the orchestrator in-process. That is the point: an eval that bypassed the
 * API would measure a code path no customer uses, and would go on passing after
 * a change to quotas, panels, prompts or the cache broke the one they do.
 *
 * One run per item yields every system under test — the synthesis, each panel
 * member's own answer, and the majority vote — so the comparison the product's
 * central claim rests on costs one panel run per question rather than four.
 */

/** What the harness needs back from whatever produced an answer. */
export interface EngineAnswer {
  runId: string
  synthesis: string
  confidence: number | null
  candidates: RunCandidate[]
}

/**
 * The thing under test.
 *
 * An interface rather than the SDK client directly, so the runner is testable
 * without a network and so a future harness can drive something else — a
 * competitor's API, a local model — through the same grading.
 */
export interface AnswerEngine {
  readonly name: string
  ask(item: GoldenItem): Promise<EngineAnswer>
}

export interface SceEngineOptions {
  baseUrl: string
  apiKey: string
  /** Cap on how long one run may take before it is abandoned. */
  timeoutMs?: number
}

/**
 * The product, over its public API.
 *
 * Every eval run **bypasses the answer cache**, and this is not a detail: the
 * golden set asks the same questions every night, so a cached engine would
 * grade one real run and then re-grade its copy for ever. The report would be
 * perfectly stable and would measure nothing. Cache behaviour is measured
 * separately, by the hit rate and the spend it avoided.
 */
export function sceEngine(options: SceEngineOptions): AnswerEngine {
  const client = new Sce({ apiKey: options.apiKey, baseUrl: options.baseUrl })

  return {
    name: options.baseUrl,
    async ask(item: GoldenItem): Promise<EngineAnswer> {
      const run = await client.ask(
        { prompt: item.prompt },
        {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          // A fresh sample of the panel, every time. See above.
          cache: "no-store",
        },
      )

      if (run.synthesis === null) {
        throw new Error(`Run ${run.id} produced no synthesis (${run.status}): ${run.error ?? "no reason given"}`)
      }

      return {
        runId: run.id,
        synthesis: run.synthesis.finalAnswer,
        confidence: run.synthesis.confidence,
        candidates: run.candidates.flatMap((candidate) =>
          candidate.status === "OK" && candidate.content !== null
            ? [
                {
                  label: candidate.label,
                  provider: candidate.provider,
                  model: candidate.model,
                  content: candidate.content,
                },
              ]
            : [],
        ),
      }
    },
  }
}

/** How one answer is graded. The seam that keeps this file testable offline. */
export type Grader = (
  judge: JudgePanel["models"][number],
  item: GoldenItem,
  answer: string,
) => Promise<JudgeResult>

export interface RunnerOptions {
  engine: AnswerEngine
  judges: JudgePanel
  /** Items in flight at once. Bounded because every one is several model calls. */
  concurrency?: number
  /**
   * Overrides the judge.
   *
   * Present so the runner's own behaviour — concurrency, failure isolation,
   * ordering — can be tested without a model call. A test that had to reach a
   * provider to check that a failed item does not abort the run is a test
   * nobody runs, and this is the one piece of scheduling logic in the harness
   * that a bug would silently corrupt every report through.
   */
  grade?: Grader
  /** Called after each item, for a progress line on a run that takes an hour. */
  onProgress?: (done: number, total: number, item: GoldenItem) => void
}

export interface RunnerOutput {
  results: ItemResult[]
  failures: { itemId: string; system: SystemId; error: string }[]
}

/**
 * Grade every item, bounded.
 *
 * Concurrency is over *items*, not over model calls: each item is already a
 * panel run plus one judge call per system, so a handful in flight saturates
 * every provider's rate limit. Four is a default that finishes a 200-item set
 * in a reasonable evening without tripping a 429 storm; raise it against a
 * gateway with headroom.
 *
 * A failure never stops the run. An item the engine could not answer, or the
 * judge could not grade, is recorded in `failures` and excluded from every
 * mean — an eval that aborts halfway through leaves nothing behind, and an eval
 * that scored failures as zero would let one provider outage read as a quality
 * regression.
 */
export async function runEvals(
  items: readonly GoldenItem[],
  options: RunnerOptions,
): Promise<RunnerOutput> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const grade: Grader = options.grade ?? judgeAnswer
  const results: ItemResult[] = []
  const failures: { itemId: string; system: SystemId; error: string }[] = []

  let cursor = 0
  let done = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined) return

      try {
        const answer = await options.engine.ask(item)
        const systems = systemsFromRun({
          synthesis: answer.synthesis,
          confidence: answer.confidence,
          candidates: answer.candidates,
        })

        for (const system of systems) {
          try {
            const judge = judgeFor(options.judges, item.id, system.system)
            const graded = await grade(judge, item, system.answer)
            results.push({
              itemId: item.id,
              category: item.category,
              system: system.system,
              confidence: system.confidence,
              score: scoreVerdict(graded.verdict),
              judgeModel: graded.judgeModel,
              verdict: graded.verdict,
              error: null,
            })
          } catch (error) {
            failures.push({
              itemId: item.id,
              system: system.system,
              error: describeError(error),
            })
          }
        }
      } catch (error) {
        // The engine failed, so no system produced an answer for this item.
        failures.push({ itemId: item.id, system: "synthesis", error: describeError(error) })
      } finally {
        done += 1
        options.onProgress?.(done, items.length, item)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))

  // Sorted, so two reports of the same set diff cleanly regardless of the order
  // the workers happened to finish in.
  results.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.system.localeCompare(right.system))
  failures.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.system.localeCompare(right.system))

  return { results, failures }
}
