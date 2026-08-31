import { z } from "zod"
import { providerIdSchema, runStatusSchema, type RunStatus } from "./schemas.ts"

/**
 * Filtering and search over a tenant's run history.
 *
 * Two shaping decisions worth stating, because both are visible in every URL
 * the web app produces:
 *
 * **Repeated parameters are comma-separated lists, not repeated keys.** A query
 * validator that accepts `?provider=openai&provider=google` has to type the
 * field as `string | string[]`, and every consumer then branches on which one
 * arrived — a union introduced purely by the transport, in the one place where
 * the value is about to become a database predicate. One string, split and
 * parsed, keeps the domain type a plain array.
 *
 * **Unknown members of a list are dropped, not rejected.** A bookmarked URL
 * naming a provider this build no longer ships is a stale link, not an attack;
 * narrowing the filter is the reading that cannot surprise anybody. An
 * unparseable *scalar* — a malformed date, a confidence of `"high"` — is still
 * a 400, because there is no safe narrowing of it.
 */

/**
 * A comma-separated list of enum members, with unrecognised entries dropped.
 *
 * Generic over the enum so `statuses` and `providers` share one definition and
 * one behaviour; `z.ZodEnum` carries its own option list, so nothing here has
 * to be told what the members are.
 */
function csvEnum<T extends string>(inner: z.ZodType<T>): z.ZodType<T[], string> {
  return z.string().transform((raw): T[] =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .flatMap((part) => {
        const parsed = inner.safeParse(part)
        return parsed.success ? [parsed.data] : []
      }),
  )
}

/** A tag: short, lowercase, and safe in a URL without escaping. */
export const runTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "A tag may contain a-z 0-9 . _ - and must start with a letter or digit")
export type RunTag = z.infer<typeof runTagSchema>

/** The whole tag set for a run, replaced wholesale rather than patched. */
export const setRunTagsInputSchema = z.object({
  tags: z.array(runTagSchema).max(16, "A run may carry at most 16 tags"),
})
export type SetRunTagsInput = z.infer<typeof setRunTagsInputSchema>

/** `YYYY-MM-DD`, the grain the history filters work in. */
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "Not a real date")

/**
 * `GET /api/runs` query parameters.
 *
 * A superset of the old `{ limit, cursor }` pair, and every added field is
 * optional — an existing client's URL keeps meaning exactly what it meant, and
 * the CLI needs no change to keep working.
 */
export const runSearchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),

  /**
   * Free text, matched case-insensitively against the prompt and the
   * synthesised answer.
   *
   * Bounded at 200 characters: this becomes a `LIKE` pattern, and an unbounded
   * one is a cheap way to make the database do expensive work.
   */
  q: z.string().trim().min(1).max(200).optional(),

  status: csvEnum(runStatusSchema).optional(),
  providers: csvEnum(providerIdSchema).optional(),
  tags: csvEnum(runTagSchema).optional(),

  /** Inclusive lower bound on `createdAt`, as a UTC day. */
  from: dateSchema.optional(),
  /** Inclusive upper bound on `createdAt`, as a UTC day. */
  to: dateSchema.optional(),

  /** Only runs whose synthesis reached at least this confidence, 0–1. */
  minConfidence: z.coerce.number().min(0).max(1).optional(),

  /** Only runs the calling user started, rather than the whole workspace. */
  mine: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
})
export type RunSearchQuery = z.infer<typeof runSearchQuerySchema>

/**
 * Does this query ask for anything beyond the first page of everything?
 *
 * The empty-state copy depends on it — "no runs yet" and "nothing matches these
 * filters" are different messages with different buttons, and getting them
 * backwards is the classic way a filtered list looks broken.
 */
export function isFilteredSearch(query: RunSearchQuery): boolean {
  return (
    query.q !== undefined ||
    (query.status?.length ?? 0) > 0 ||
    (query.providers?.length ?? 0) > 0 ||
    (query.tags?.length ?? 0) > 0 ||
    query.from !== undefined ||
    query.to !== undefined ||
    query.minConfidence !== undefined ||
    query.mine === true
  )
}

/**
 * Render a query back into a query string.
 *
 * The single place a history URL is built, so a link the app produces always
 * parses back to the query it came from — the round trip that makes filters
 * shareable and the back button correct.
 */
export function runSearchToParams(query: Partial<RunSearchQuery>): URLSearchParams {
  const params = new URLSearchParams()
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) params.set(key, value)
  }

  if (query.limit !== undefined) put("limit", String(query.limit))
  put("cursor", query.cursor)
  put("q", query.q)
  put("status", query.status?.join(","))
  put("providers", query.providers?.join(","))
  put("tags", query.tags?.join(","))
  put("from", query.from)
  put("to", query.to)
  if (query.minConfidence !== undefined) put("minConfidence", String(query.minConfidence))
  if (query.mine === true) put("mine", "true")

  return params
}

/** Statuses a person thinks of as "still going", for the one-click filter. */
export const IN_FLIGHT_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "QUEUED",
  "FANNING_OUT",
  "SYNTHESIZING",
]
