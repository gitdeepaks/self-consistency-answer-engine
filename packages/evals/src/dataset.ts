import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EVAL_CATEGORIES,
  goldenItemSchema,
  humanLabelSchema,
  stagedItemSchema,
  type EvalCategory,
  type GoldenItem,
  type HumanLabel,
  type StagedItem,
} from "./schema.ts"

/**
 * Loading the golden set.
 *
 * JSONL, one item per line, one file per category. The format is chosen for the
 * review it gets rather than for the parser: adding a question is a one-line
 * diff, a reviewer can see exactly what changed, and a merge conflict affects
 * one item instead of reformatting the file. A single JSON array would put the
 * whole set on one diff hunk every time somebody adds a comma.
 *
 * Every line is parsed, and a malformed one is an error naming its file and
 * line number. A dataset that silently skipped what it could not read would
 * quietly shrink, and a quality gate measured on a shrinking set reports
 * improvements it has not made.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = path.join(HERE, "..", "data")
export const GOLDENS_DIR = path.join(DATA_DIR, "goldens")
export const STAGING_DIR = path.join(DATA_DIR, "staging")
export const HUMAN_LABELS_PATH = path.join(DATA_DIR, "human-labels.jsonl")

/** The dataset's identity, which a report records and a gate compares. */
export interface Dataset {
  id: string
  items: GoldenItem[]
  /** Content digest over every item, so "same size" cannot pass for "same set". */
  digest: string
}

export class DatasetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DatasetError"
  }
}

/** Parse a JSONL file line by line, naming the line that fails. */
async function readJsonl(file: string): Promise<{ line: number; value: unknown }[]> {
  const text = await readFile(file, "utf8")
  const rows: { line: number; value: unknown }[] = []

  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? ""
    if (raw.length === 0 || raw.startsWith("//")) continue

    try {
      rows.push({ line: index + 1, value: JSON.parse(raw) })
    } catch {
      throw new DatasetError(`${path.basename(file)}:${index + 1} is not valid JSON`)
    }
  }
  return rows
}

/**
 * A stable digest of the items, independent of file order and key order.
 *
 * The point is that a report says which *set* it measured. Two runs with the
 * same digest are comparable; two with different digests are not, and the gate
 * downgrades itself to a warning when they differ rather than reporting a
 * regression that is really a dataset edit.
 */
export async function digestItems(items: readonly GoldenItem[]): Promise<string> {
  const canonical = [...items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => `${item.id}|${item.category}|${item.prompt}|${item.rubric.join("~")}`)
    .join("\n")

  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
}

export async function loadDataset(directory: string = GOLDENS_DIR): Promise<Dataset> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort()
  if (files.length === 0) throw new DatasetError(`No .jsonl files in ${directory}`)

  const items: GoldenItem[] = []
  const seen = new Map<string, string>()

  for (const file of files) {
    const full = path.join(directory, file)
    for (const row of await readJsonl(full)) {
      const parsed = goldenItemSchema.safeParse(row.value)
      if (!parsed.success) {
        throw new DatasetError(
          `${file}:${row.line} is not a golden item — ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        )
      }

      const duplicate = seen.get(parsed.data.id)
      if (duplicate !== undefined) {
        throw new DatasetError(
          `${file}:${row.line} repeats the id "${parsed.data.id}", already defined in ${duplicate}. ` +
            "Two items with one id make a report that double-counts one of them.",
        )
      }
      seen.set(parsed.data.id, `${file}:${row.line}`)
      items.push(parsed.data)
    }
  }

  return { id: path.basename(directory), items, digest: await digestItems(items) }
}

/* -------------------------------------------------------------- coverage */

export interface Coverage {
  total: number
  byCategory: Record<EvalCategory, number>
  bySource: { curated: number; feedback: number }
  withReference: number
  withAntiRubric: number
}

export function coverage(items: readonly GoldenItem[]): Coverage {
  // Written out rather than built with `Object.fromEntries`, which produces a
  // `Record<string, number>` that only an assertion turns into this type — and
  // an assertion is the one thing the type rules do not allow. Adding a
  // category makes this a compile error, which is the correct outcome.
  const byCategory: Record<EvalCategory, number> = {
    factual: 0,
    reasoning: 0,
    coding: 0,
    longform: 0,
    adversarial: 0,
  }

  let curated = 0
  let feedback = 0
  let withReference = 0
  let withAntiRubric = 0

  for (const item of items) {
    byCategory[item.category] += 1
    if (item.source === "feedback") feedback += 1
    else curated += 1
    if (item.reference !== undefined) withReference += 1
    if (item.antiRubric.length > 0) withAntiRubric += 1
  }

  return {
    total: items.length,
    byCategory,
    bySource: { curated, feedback },
    withReference,
    withAntiRubric,
  }
}

/**
 * What the set has to satisfy to be worth gating on.
 *
 * These are not style rules. A category with a handful of items produces a
 * per-category mean that swings on one answer, so a gate reading it would fire
 * on noise; and a set with no adversarial items measures a model that is never
 * asked anything difficult. The floors are deliberately low — they describe the
 * point below which the numbers stop meaning anything, not a target.
 */
export const MIN_ITEMS_PER_CATEGORY = 20
export const MIN_ITEMS = 100

export function checkCoverage(items: readonly GoldenItem[]): string[] {
  const problems: string[] = []
  const seen = coverage(items)

  if (seen.total < MIN_ITEMS) {
    problems.push(`the set has ${seen.total} items; a gate needs at least ${MIN_ITEMS}`)
  }
  for (const category of EVAL_CATEGORIES) {
    const count = seen.byCategory[category]
    if (count < MIN_ITEMS_PER_CATEGORY) {
      problems.push(
        `category "${category}" has ${count} items; below ${MIN_ITEMS_PER_CATEGORY} its mean swings on one answer`,
      )
    }
  }
  return problems
}

/* ------------------------------------------------------------- selection */

/**
 * A deterministic subset, for a smaller or faster run.
 *
 * Stratified by category and ordered by a hash of the item id, so `--limit 40`
 * is the same forty items on every machine and every night. A random sample
 * would make two reports incomparable, which is the one thing a regression gate
 * cannot tolerate.
 */
export function sample(items: readonly GoldenItem[], limit: number): GoldenItem[] {
  if (limit >= items.length) return [...items]

  const byCategory = new Map<EvalCategory, GoldenItem[]>()
  for (const item of items) {
    const bucket = byCategory.get(item.category) ?? []
    bucket.push(item)
    byCategory.set(item.category, bucket)
  }

  for (const bucket of byCategory.values()) {
    bucket.sort((left, right) => order(left.id) - order(right.id) || left.id.localeCompare(right.id))
  }

  // Round-robin across categories, so a small sample stays balanced instead of
  // being whichever category sorts first.
  const picked: GoldenItem[] = []
  const categories = [...byCategory.keys()].sort()
  for (let index = 0; picked.length < limit; index += 1) {
    let progressed = false
    for (const category of categories) {
      const item = byCategory.get(category)?.[index]
      if (item === undefined) continue
      progressed = true
      picked.push(item)
      if (picked.length === limit) break
    }
    if (!progressed) break
  }
  return picked
}

/** FNV-1a over the id, with the same avalanche step `hashCohort` explains. */
function order(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  return hash >>> 0
}

/* --------------------------------------------------------- human labels */

export async function loadHumanLabels(file: string = HUMAN_LABELS_PATH): Promise<HumanLabel[]> {
  const labels: HumanLabel[] = []
  for (const row of await readJsonl(file)) {
    const parsed = humanLabelSchema.safeParse(row.value)
    if (!parsed.success) {
      throw new DatasetError(
        `${path.basename(file)}:${row.line} is not a human label — ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    labels.push(parsed.data)
  }
  return labels
}

/* ------------------------------------------------------------- staging */

export async function loadStagedItems(file: string): Promise<StagedItem[]> {
  const staged: StagedItem[] = []
  for (const row of await readJsonl(file)) {
    const parsed = stagedItemSchema.safeParse(row.value)
    if (!parsed.success) {
      throw new DatasetError(
        `${path.basename(file)}:${row.line} is not a staged item — ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    staged.push(parsed.data)
  }
  return staged
}

/**
 * Serialise rows back to JSONL, one object per line.
 *
 * Generic over the row rather than taking `Record<string, unknown>`: the caller
 * always has a domain type here, and widening it at the boundary would be the
 * "unknown flowing inward" the type rules exist to prevent — the parameter
 * would accept anything, and nothing downstream would be better typed for it.
 */
export function toJsonl<T extends object>(rows: readonly T[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
}
