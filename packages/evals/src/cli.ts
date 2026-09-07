#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertNever, describeError, loadRootEnv, PANELS, type ProviderId } from "@sce/shared"
import { z } from "zod"
import { fitFromReport, renderCalibration } from "./calibrate.ts"
import { measureJudges, renderAgreement } from "./agreement.ts"
import {
  checkCoverage,
  coverage,
  GOLDENS_DIR,
  loadDataset,
  loadHumanLabels,
  sample,
  STAGING_DIR,
  toJsonl,
} from "./dataset.ts"
import { renderGate, runGate } from "./gate.ts"
import { DEFAULT_JUDGE_PROVIDERS, judgePanel, NoJudgeError } from "./judge.ts"
import { buildReport, compareThesis, renderReport } from "./report.ts"
import { runEvals, sceEngine } from "./runner.ts"
import { evalReportSchema, gateThresholdsSchema, type EvalReport } from "./schema.ts"
import { exportAcceptedFeedback, markExported } from "./triage.ts"

// The harness reads provider keys and the API base URL from the same `.env` the
// rest of the workspace uses, so `bun run evals run` needs no extra setup.
loadRootEnv()

/**
 * The eval harness, as a command.
 *
 *     bun run evals dataset                   validate the golden set
 *     bun run evals run --out report.json     measure a deployment
 *     bun run evals report report.json        render one as Markdown
 *     bun run evals gate --report r.json      block a release on a regression
 *     bun run evals calibrate --report r.json fit the confidence correction
 *     bun run evals judges                    measure the judge against humans
 *     bun run evals triage                    turn complaints into eval cases
 *
 * Every command that measures anything writes a **file**, and every command
 * that decides anything reads one. That split is deliberate: a nightly run
 * produces an artefact a person can open a week later and argue with, and the
 * gate is a pure function of two such artefacts — so a disputed result can be
 * re-checked without re-running anything, and a baseline can be committed next
 * to the code it gates.
 */

interface Flags {
  readonly values: ReadonlyMap<string, string>
  readonly booleans: ReadonlySet<string>
}

/** `--key value`, `--key=value`, and `--flag`. No dependency, no surprises. */
function parseFlags(argv: readonly string[]): Flags {
  const values = new Map<string, string>()
  const booleans = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined || !token.startsWith("--")) continue

    const body = token.slice(2)
    const equals = body.indexOf("=")
    if (equals !== -1) {
      values.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next)
      index += 1
    } else {
      booleans.add(body)
    }
  }

  return { values, booleans }
}

function flagNumber(flags: Flags, name: string, fallback: number): number {
  const raw = flags.values.get(name)
  if (raw === undefined) return fallback

  const parsed = z.coerce.number().finite().safeParse(raw)
  if (!parsed.success) throw new UsageError(`--${name} must be a number, got "${raw}"`)
  return parsed.data
}

class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** Read and parse a report file. Untrusted input like any other. */
async function readReport(file: string): Promise<EvalReport> {
  let document: unknown
  try {
    document = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    throw new UsageError(`${file} could not be read as JSON — ${describeError(error)}`)
  }

  const parsed = evalReportSchema.safeParse(document)
  if (!parsed.success) {
    throw new UsageError(
      `${file} is not an eval report — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return parsed.data
}

/* ------------------------------------------------------------- commands */

async function commandDataset(flags: Flags): Promise<number> {
  const directory = flags.values.get("dir") ?? GOLDENS_DIR
  const dataset = await loadDataset(directory)
  const seen = coverage(dataset.items)

  console.log(`[evals] ${dataset.items.length} items in ${directory}`)
  console.log(`        digest ${dataset.digest}`)
  for (const [category, count] of Object.entries(seen.byCategory)) {
    console.log(`        ${category.padEnd(12)} ${count}`)
  }
  console.log(
    `        ${seen.bySource.curated} curated, ${seen.bySource.feedback} from feedback; ` +
      `${seen.withReference} with a reference, ${seen.withAntiRubric} with an anti-rubric`,
  )

  const problems = checkCoverage(dataset.items)
  for (const problem of problems) console.error(`[evals] coverage: ${problem}`)
  return problems.length === 0 ? 0 : 1
}

async function commandRun(flags: Flags): Promise<number> {
  const baseUrl = flags.values.get("base-url") ?? process.env.SCE_BASE_URL ?? "http://localhost:8787"
  const apiKey = flags.values.get("api-key") ?? process.env.SCE_API_KEY ?? ""
  if (apiKey === "") {
    throw new UsageError(
      "An API key is required: pass --api-key, or set SCE_API_KEY. Create one under " +
        "Settings → API keys, or with `bun run auth:bootstrap`.",
    )
  }

  const dataset = await loadDataset(flags.values.get("dir") ?? GOLDENS_DIR)
  const limit = flagNumber(flags, "limit", dataset.items.length)
  const items = sample(dataset.items, limit)

  const judgeProviders = flags.values.get("judges")
  const judges = judgePanel(
    judgeProviders === undefined ? DEFAULT_JUDGE_PROVIDERS : parseProviders(judgeProviders),
  )

  const panelId = flags.values.get("panel") ?? null
  if (panelId !== null && !(panelId in PANELS)) {
    throw new UsageError(`--panel must name a registered panel (${Object.keys(PANELS).join(", ")})`)
  }

  console.log(
    `[evals] grading ${items.length} items against ${baseUrl} with judges ` +
      judges.models.map((judge) => judge.id).join(", "),
  )
  if (panelId !== null) {
    console.log(
      `[evals] note: --panel records ${panelId} in the report. The deployment decides which ` +
        "panel actually answers, through DEFAULT_PANEL or an experiment.",
    )
  }

  const started = Date.now()
  const { results, failures } = await runEvals(items, {
    engine: sceEngine({
      baseUrl,
      apiKey,
      timeoutMs: flagNumber(flags, "timeout-ms", 10 * 60_000),
    }),
    judges,
    concurrency: flagNumber(flags, "concurrency", 4),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) console.log(`[evals] ${done}/${total}`)
    },
  })

  const report = buildReport({
    id: flags.values.get("id") ?? `eval-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    createdAt: new Date().toISOString(),
    dataset: { id: dataset.id, size: items.length, digest: dataset.digest },
    engine: { panelId, promptSetId: flags.values.get("prompt-set") ?? null, baseUrl },
    judges: judges.models.map((judge) => judge.id),
    results,
    failures,
  })

  const out = flags.values.get("out") ?? "eval-report.json"
  await mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  const thesis = compareThesis(report)
  console.log(
    `[evals] finished in ${Math.round((Date.now() - started) / 1000)}s — ` +
      `synthesis ${((thesis.synthesis?.meanScore ?? 0) * 100).toFixed(1)}%, ` +
      `best single ${((thesis.bestSingle?.meanScore ?? 0) * 100).toFixed(1)}%, ` +
      `${failures.length} ungraded`,
  )
  console.log(`[evals] wrote ${out}`)

  // A run that graded nothing is a failure of the harness, not a bad score.
  return report.results.length === 0 ? 1 : 0
}

function parseProviders(raw: string): ProviderId[] {
  const parsed = z
    .array(z.enum(["openai", "anthropic", "google"]))
    .safeParse(raw.split(",").map((value) => value.trim()))
  if (!parsed.success) throw new UsageError(`--judges must be a comma-separated list of provider ids`)
  return parsed.data
}

async function commandReport(flags: Flags, positional: readonly string[]): Promise<number> {
  const file = positional[0] ?? flags.values.get("report")
  if (file === undefined) throw new UsageError("Usage: evals report <report.json>")

  const report = await readReport(file)
  const markdown = renderReport(report)

  const out = flags.values.get("out")
  if (out === undefined) {
    console.log(markdown)
  } else {
    await writeFile(out, markdown, "utf8")
    console.log(`[evals] wrote ${out}`)
  }
  return 0
}

async function commandGate(flags: Flags): Promise<number> {
  const reportFile = flags.values.get("report")
  if (reportFile === undefined) throw new UsageError("Usage: evals gate --report <file> [--baseline <file>]")

  const report = await readReport(reportFile)
  const baselineFile = flags.values.get("baseline")
  const baseline = baselineFile === undefined ? null : await readReport(baselineFile)

  const thresholds = gateThresholdsSchema.parse({
    ...(flags.values.has("max-score-drop") ? { maxScoreDrop: flagNumber(flags, "max-score-drop", 0) } : {}),
    ...(flags.values.has("max-category-drop")
      ? { maxCategoryDrop: flagNumber(flags, "max-category-drop", 0) }
      : {}),
    ...(flags.values.has("min-graded") ? { minGraded: flagNumber(flags, "min-graded", 50) } : {}),
    ...(flags.values.has("min-edge") ? { minSynthesisEdge: flagNumber(flags, "min-edge", 0) } : {}),
  })

  const result = runGate({ report, baseline, thresholds })
  console.log(renderGate(result))

  const summary = flags.values.get("summary")
  if (summary !== undefined) {
    await writeFile(summary, `${renderGate(result)}\n\n${renderReport(report)}`, "utf8")
  }

  // `--warn-only` exists for the first nights of a new dataset, when the
  // baseline is not yet trustworthy. It is not a flag CI should carry for long.
  if (flags.booleans.has("warn-only")) return 0
  return result.passed ? 0 : 1
}

async function commandCalibrate(flags: Flags): Promise<number> {
  const reportFile = flags.values.get("report")
  if (reportFile === undefined) throw new UsageError("Usage: evals calibrate --report <file> [--out <file>]")

  const report = await readReport(reportFile)
  const outcome = fitFromReport(report, {
    id: `${report.dataset.id}@${report.createdAt.slice(0, 10)}`,
    fittedAt: new Date().toISOString(),
    minSamples: flagNumber(flags, "min-samples", 100),
  })

  console.log(renderCalibration(outcome))
  if (outcome.map === null) return 1

  const out = flags.values.get("out")
  if (out !== undefined) {
    await writeFile(out, `${JSON.stringify(outcome.map, null, 2)}\n`, "utf8")
    console.log(`[evals] wrote ${out}`)
  }
  return 0
}

async function commandJudges(flags: Flags): Promise<number> {
  const dataset = await loadDataset(flags.values.get("dir") ?? GOLDENS_DIR)
  const labels = await loadHumanLabels(flags.values.get("labels") ?? undefined)

  if (labels.length === 0) {
    console.error("[evals] no human labels; there is nothing to measure the judge against")
    return 1
  }

  const judges = judgePanel(
    flags.values.has("judges") ? parseProviders(flags.values.get("judges") ?? "") : DEFAULT_JUDGE_PROVIDERS,
  )

  const report = await measureJudges({
    labels,
    items: dataset.items,
    judges,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) console.log(`[evals] ${done}/${total}`)
    },
  })

  console.log(renderAgreement(report))

  const out = flags.values.get("out")
  if (out !== undefined) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  // Below 0.6 the judge cannot support a gate, and saying so with an exit code
  // is what stops that fact being noticed only after a bad release.
  return report.kappa >= 0.6 ? 0 : 1
}

async function commandTriage(flags: Flags): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const staged = await exportAcceptedFeedback({
    today,
    ...(flags.values.has("limit") ? { limit: flagNumber(flags, "limit", 200) } : {}),
  })

  if (staged.length === 0) {
    console.log("[evals] nothing accepted in triage is waiting to be turned into an eval case")
    return 0
  }

  await mkdir(STAGING_DIR, { recursive: true })
  const out = flags.values.get("out") ?? path.join(STAGING_DIR, `from-feedback-${today}.jsonl`)
  await writeFile(out, toJsonl(staged), "utf8")

  console.log(`[evals] wrote ${staged.length} staged items to ${out}`)
  console.log("        Each one needs a rubric before it can grade anything. Add one, choose the")
  console.log("        right category, and move the line into data/goldens/.")

  if (flags.booleans.has("promote")) {
    const marked = await markExported(staged)
    console.log(`[evals] marked ${marked} verdicts promoted; they will not be exported again`)
  } else {
    console.log("        Re-run with --promote once the file is committed.")
  }
  return 0
}

/* ----------------------------------------------------------------- main */

const COMMANDS = ["dataset", "run", "report", "gate", "calibrate", "judges", "triage", "help"] as const
type Command = (typeof COMMANDS)[number]

function parseCommand(raw: string | undefined): Command {
  const parsed = z.enum(COMMANDS).safeParse(raw)
  if (!parsed.success) {
    throw new UsageError(
      `Unknown command "${raw ?? ""}". Expected one of: ${COMMANDS.join(", ")}`,
    )
  }
  return parsed.data
}

function usage(): void {
  console.log(`sce-evals — the answer-quality harness

  dataset    [--dir <path>]                       validate the golden set and report coverage
  run        [--base-url] [--api-key] [--limit]   grade a deployment, writing a report
             [--judges openai,anthropic,google] [--concurrency] [--out <file>]
  report     <report.json> [--out <file>]         render a report as Markdown
  gate       --report <file> [--baseline <file>]  fail on a regression
             [--max-score-drop] [--min-edge] [--warn-only] [--summary <file>]
  calibrate  --report <file> [--out <file>]       fit the confidence correction
  judges     [--labels <file>] [--out <file>]     measure the judge against human labels
  triage     [--promote] [--limit] [--out]        export accepted complaints as eval cases
`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const positional = argv.filter((token) => !token.startsWith("--"))
  const flags = parseFlags(argv)
  const command = parseCommand(positional[0])

  switch (command) {
    case "dataset":
      return commandDataset(flags)
    case "run":
      return commandRun(flags)
    case "report":
      return commandReport(flags, positional.slice(1))
    case "gate":
      return commandGate(flags)
    case "calibrate":
      return commandCalibrate(flags)
    case "judges":
      return commandJudges(flags)
    case "triage":
      return commandTriage(flags)
    case "help":
      usage()
      return 0
    default:
      return assertNever(command, "evals cli")
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError || error instanceof NoJudgeError) {
      console.error(`[evals] ${error.message}`)
    } else {
      console.error(`[evals] ${describeError(error)}`)
    }
    process.exitCode = 1
  })
