import { z } from "zod"

/**
 * Deciding when two questions are the same question.
 *
 * A panel run is the most expensive thing this product does: three model calls
 * plus an evaluator, every time, whether or not the same question was answered
 * an hour ago. Caching it is the single largest cost lever available, and the
 * only hard part is the definition of "same".
 *
 * Two definitions, in order:
 *
 *   **Identical.** A canonical key over the normalised prompt *and everything
 *   that changes the answer* — the seats, their models, the temperature and the
 *   prompt set. SHA-256, because a collision here serves one customer another
 *   customer's answer, and a 64-bit hash is not a defensible amount of headroom
 *   for that.
 *
 *   **Near-identical.** One cheap filter and two exact tests, inside a *scope*
 *   (the same seats, temperature and prompt set). All three must pass:
 *
 *     1. a 64-bit **simhash**, compared by Hamming distance. This is a
 *        prefilter and nothing more — it makes the candidate set small without
 *        reading every stored prompt, and it is deliberately loose.
 *     2. **token overlap** (Jaccard over the word sets), which rejects a
 *        substitution: "reverse a linked list in Rust" against the Python
 *        answer differ by one decisive word.
 *     3. **shingle overlap** (Jaccard over word triples), which rejects a
 *        reordering: "why is the sky blue and the sunset red" against "why is
 *        the sunset blue and the sky red" have *identical* token sets and
 *        opposite meanings, so nothing in step 2 can tell them apart.
 *
 *   Steps 2 and 3 are exact measures over the actual text, not approximations
 *   of it, and they are what the decision rests on. Measured on real prompts:
 *   a reordering scores 0.11-0.39 on shingles and 1.00 on tokens; a one-word
 *   substitution scores 0.75-0.80 on both; a genuine rewording scores above
 *   0.95 on both. The defaults sit in the gaps those measurements leave, and
 *   `answer-cache.test.ts` pins every one of those cases.
 *
 * Nothing here reads the clock, the database or the environment, so all of it
 * is directly testable — and it is tested, because a cache that is wrong is
 * indistinguishable from a model that is wrong.
 */

/** Fields that must match exactly for two runs to be interchangeable. */
export interface CacheScopeInput {
  /** Provider and model of each seat, in panel order. */
  readonly seats: readonly { readonly provider: string; readonly model: string }[]
  /** Null means "the model default", which is itself a distinct scope. */
  readonly temperature: number | null
  readonly promptSetId: string
}

export interface CacheKeyInput extends CacheScopeInput {
  readonly prompt: string
}

/**
 * The prompt, reduced to what it asks.
 *
 * Case, surrounding whitespace, smart quotes and a trailing question mark do
 * not change an answer, and treating them as though they did turns the cache
 * off for most of the traffic it exists to serve. Everything else is preserved:
 * this is normalisation, not stemming, and a normaliser that discards
 * punctuation would equate two genuinely different questions.
 */
export function normalizePrompt(prompt: string): string {
  return prompt
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** The words of a prompt, for similarity. Order is preserved for shingling. */
export function promptTokens(prompt: string): string[] {
  const matches = normalizePrompt(prompt).match(/[\p{L}\p{N}]+/gu)
  return matches === null ? [] : matches
}

/**
 * Overlapping word triples.
 *
 * Word *sets* call "is a raven like a writing desk" and "is a writing desk like
 * a raven" identical. Shingles keep enough local order to tell them apart while
 * staying insensitive to the edits that do not matter. Prompts shorter than the
 * window fall back to their tokens, so a two-word question still hashes to
 * something.
 */
export function shingles(tokens: readonly string[], size = 3): string[] {
  if (tokens.length < size) return [...tokens]
  const out: string[] = []
  for (let index = 0; index + size <= tokens.length; index += 1) {
    out.push(tokens.slice(index, index + size).join(" "))
  }
  return out
}

const FNV64_OFFSET = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

/** FNV-1a, 64-bit. Fast, well-distributed, and not remotely cryptographic. */
export function fnv1a64(value: string): bigint {
  let hash = FNV64_OFFSET
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * FNV64_PRIME) & MASK64
  }
  return hash
}

/**
 * Simhash: a fingerprint where similar inputs give similar outputs.
 *
 * Each feature votes on all 64 bits, and the sign of each column becomes the
 * bit. Two prompts that share most of their shingles then differ in only a few
 * bits — which is what makes `hammingDistance` a usable prefilter, unlike a
 * cryptographic digest where one changed word changes everything.
 */
export function simhash64(features: readonly string[]): bigint {
  if (features.length === 0) return 0n

  const columns = new Array<number>(64).fill(0)
  for (const feature of features) {
    const hash = fnv1a64(feature)
    for (let bit = 0; bit < 64; bit += 1) {
      const set = (hash >> BigInt(bit)) & 1n
      const column = columns[bit] ?? 0
      columns[bit] = set === 1n ? column + 1 : column - 1
    }
  }

  let result = 0n
  for (let bit = 0; bit < 64; bit += 1) {
    if ((columns[bit] ?? 0) > 0) result |= 1n << BigInt(bit)
  }
  return result
}

export function promptSimhash(prompt: string): bigint {
  return simhash64(shingles(promptTokens(prompt)))
}

export function hammingDistance(left: bigint, right: bigint): number {
  let difference = (left ^ right) & MASK64
  let bits = 0
  while (difference !== 0n) {
    difference &= difference - 1n
    bits += 1
  }
  return bits
}

/**
 * Overlap of two prompts' word triples.
 *
 * The order-sensitive half of the decision. Shingles are what make "A better
 * than B" and "B better than A" different objects, and this is an exact measure
 * over the shingles themselves rather than over a 64-bit summary of them —
 * which is why the fingerprint above can be a loose prefilter rather than a
 * threshold that has to be tuned against two opposing failure modes at once.
 */
export function shingleSimilarity(left: string, right: string): number {
  return jaccard(new Set(shingles(promptTokens(left))), new Set(shingles(promptTokens(right))))
}

/** Jaccard similarity of two token sets: |A ∩ B| / |A ∪ B|, and 1 for two empties. */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const item of left) if (right.has(item)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? 0 : shared / union
}

/**
 * The fingerprint as it is stored: sixteen lowercase hex digits.
 *
 * Text rather than a `BigInt` column because the value is read back into
 * JavaScript to compute Hamming distances anyway, and because a fixed-width hex
 * string is the same sixteen bytes in every database, driver and log line.
 */
export function toSimhashHex(value: bigint): string {
  return (value & MASK64).toString(16).padStart(16, "0")
}

export const simhashHexSchema = z.string().regex(/^[0-9a-f]{16}$/, "A simhash is 16 hex digits")

export function fromSimhashHex(value: string): bigint | null {
  const parsed = simhashHexSchema.safeParse(value)
  return parsed.success ? BigInt(`0x${parsed.data}`) : null
}

/* --------------------------------------------------------------- the keys */

function canonicalScope(input: CacheScopeInput): string {
  // Seats are sorted, so a panel listed in a different order is the same panel.
  // They are *not* deduplicated: two samples of one model is a different panel
  // from one sample of it, and produces a measurably different answer.
  const seats = input.seats
    .map((seat) => `${seat.provider}:${seat.model}`)
    .slice()
    .sort()
    .join(",")
  const temperature = input.temperature === null ? "default" : input.temperature.toFixed(3)
  return `v1|panel=${seats}|temp=${temperature}|prompts=${input.promptSetId}`
}

async function sha256Hex(value: string): Promise<string> {
  // Web Crypto rather than `node:crypto`: this module is reachable from the
  // browser bundle, and one Node-only import there costs a build.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Everything a lookup needs, computed once at the point a run is created.
 *
 * `key` is the exact-match index; `scope` narrows the near-duplicate search to
 * runs that used the same panel; `simhash` is compared inside that scope.
 */
export interface CacheFingerprint {
  readonly key: string
  readonly scope: string
  readonly simhash: string
}

export async function fingerprint(input: CacheKeyInput): Promise<CacheFingerprint> {
  const scope = canonicalScope(input)
  const [key, scopeHash] = await Promise.all([
    sha256Hex(`${scope}|prompt=${normalizePrompt(input.prompt)}`),
    sha256Hex(scope),
  ])
  return { key, scope: scopeHash, simhash: toSimhashHex(promptSimhash(input.prompt)) }
}

/* ------------------------------------------------------- the reuse decision */

export interface NearDuplicateOptions {
  /**
   * Bits of the 64-bit fingerprint that may differ — the prefilter.
   *
   * Loose on purpose: its job is to shrink the candidate set, not to decide.
   * A tight value here would silently do the deciding, and it would do it
   * badly — the same 3-bit move means "one word appended to a long question"
   * and "one decisive word substituted in a short one".
   */
  readonly maxHammingDistance: number
  /** Token-set overlap. Catches a substitution. */
  readonly minJaccard: number
  /** Word-triple overlap. Catches a reordering, which token overlap cannot see. */
  readonly minShingleJaccard: number
}

export const DEFAULT_NEAR_DUPLICATE_OPTIONS: NearDuplicateOptions = {
  maxHammingDistance: 16,
  minJaccard: 0.9,
  minShingleJaccard: 0.8,
}

export interface NearDuplicateCandidate {
  readonly runId: string
  readonly prompt: string
  readonly simhash: string
}

export interface NearDuplicateMatch {
  readonly runId: string
  readonly distance: number
  /** Token overlap with the cached prompt. */
  readonly similarity: number
  /** Word-triple overlap, which is what a reordering fails. */
  readonly phraseSimilarity: number
}

/**
 * The closest acceptable near-duplicate, or null.
 *
 * Both tests have to pass, and neither is redundant: the fingerprint sees word
 * order and the overlap does not, while the overlap sees a decisive
 * substitution that the fingerprint barely registers. Passing one and failing
 * the other is a miss, which costs a model call — the alternative costs
 * somebody the wrong answer, which is the one failure a cache is never allowed
 * to have.
 */
export function findNearDuplicate(
  prompt: string,
  candidates: readonly NearDuplicateCandidate[],
  options: NearDuplicateOptions = DEFAULT_NEAR_DUPLICATE_OPTIONS,
): NearDuplicateMatch | null {
  const target = promptSimhash(prompt)
  const targetTokens = new Set(promptTokens(prompt))

  let best: NearDuplicateMatch | null = null
  for (const candidate of candidates) {
    const hash = fromSimhashHex(candidate.simhash)
    if (hash === null) continue

    const distance = hammingDistance(target, hash)
    if (distance > options.maxHammingDistance) continue

    const similarity = jaccard(targetTokens, new Set(promptTokens(candidate.prompt)))
    if (similarity < options.minJaccard) continue

    const phraseSimilarity = shingleSimilarity(prompt, candidate.prompt)
    if (phraseSimilarity < options.minShingleJaccard) continue

    // Ties go to the higher overlap: distance is the prefilter and the two
    // overlaps are the measurement, so preferring the measurement is what makes
    // adding more candidates to the search monotonically improve the answer.
    const score = similarity + phraseSimilarity
    const bestScore = best === null ? -1 : best.similarity + best.phraseSimilarity
    if (best === null || score > bestScore || (score === bestScore && distance < best.distance)) {
      best = { runId: candidate.runId, distance, similarity, phraseSimilarity }
    }
  }
  return best
}

/** Why a run was, or was not, served from cache. Reported on the run itself. */
export const cacheOutcomeSchema = z.enum(["miss", "exact", "near"])
export type CacheOutcome = z.infer<typeof cacheOutcomeSchema>

/**
 * Response header naming the outcome, on the route that creates a run.
 *
 * A header rather than a body field: it describes how the response was
 * produced, not what the run is. A client that ignores it sees exactly what it
 * saw before the cache existed — and one that reads it can tell a person why
 * their answer arrived in forty milliseconds.
 */
export const CACHE_HEADER = "x-sce-cache"

/**
 * The request header a caller uses to insist on a fresh answer.
 *
 * `Cache-Control: no-store` rather than a bespoke field, because this is
 * exactly what the standard header means and every HTTP client already knows
 * how to send it. `no-cache` is accepted as the same instruction: the
 * distinction the RFC draws between them — revalidate versus do not store — has
 * no analogue here, since there is nothing to revalidate against, and refusing
 * one of the two would be a trap rather than a rule.
 *
 * The evals harness sends it on every run, which is what stops the golden set
 * grading one real answer and then re-grading its own copy for ever.
 */
export const CACHE_CONTROL_HEADER = "cache-control"

export function wantsFreshAnswer(header: string | null | undefined): boolean {
  if (header === null || header === undefined) return false
  return header
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim())
    .some((directive) => directive === "no-store" || directive === "no-cache")
}
