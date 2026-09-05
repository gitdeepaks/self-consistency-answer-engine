import { z } from "zod"
import { errorCodeSchema, type ApiError } from "./api-error.ts"
import { accessSchema } from "./billing.ts"
import { killSwitchSchema } from "./budget.ts"
import { quotaViolationSchema } from "./quota.ts"
import { rateLimitStateSchema } from "./ratelimit.ts"

/**
 * The public API contract.
 *
 * Everything in this module is a *promise*, not an implementation detail: the
 * version prefix, the error envelope, the pagination shape and the deprecation
 * headers are the parts of the surface that third-party code will be written
 * against and that therefore cannot be changed on a whim. They live in
 * `@sce/shared` for the usual reason — one definition serves the server that
 * emits them, the SDK that parses them and the spec generator that documents
 * them — and the schema-diff gate in CI is what stops any of them drifting.
 *
 * The distinction that matters throughout Phase 6: `/api` is the first-party
 * surface the web app and the TUI talk to, and it may change with them because
 * it ships with them. `/v1` is the *product*, and it changes only under the
 * policy in `doc/api/versioning.md`.
 */

/** The version this build serves. Every public route is mounted beneath it. */
export const API_VERSION = "v1"

/** Versions this build answers on. Grows when `/v2` lands; nothing is removed. */
export const API_VERSIONS: readonly string[] = [API_VERSION]

/**
 * Correlation id, echoed on every response.
 *
 * Accepted from the client when it supplies one, because a caller that already
 * has a trace id for the surrounding operation gets a great deal more from
 * seeing *their* id in our logs than from being handed a fresh one. Generated
 * when they do not.
 */
export const REQUEST_ID_HEADER = "x-request-id"

/**
 * A supplied request id, bounded and character-fenced.
 *
 * This value is echoed in a response header and written to structured logs, so
 * it is exactly the kind of attacker-controlled string that turns into header
 * injection or log forgery when it is passed through unparsed. Anything that
 * does not fit is replaced with a generated id rather than rejected — a bad
 * correlation id is not worth failing a request over.
 */
export const requestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "A request id may only contain A-Z a-z 0-9 . _ : -")

/* --------------------------------------------------------------- errors */

/**
 * The typed half of a refusal.
 *
 * Each field is a schema rather than a free-form blob, which is the whole
 * argument for having a `details` object at all: a client that receives
 * `details.quota` knows which ceiling it hit, what it has spent and when the
 * window resets, without parsing an English sentence. There is deliberately no
 * `[key: string]: unknown` escape hatch — a detail nobody can parse is a detail
 * that should not have been sent.
 */
export const v1ErrorDetailsSchema = z.object({
  /** Present on `quota_exceeded`. */
  quota: quotaViolationSchema.optional(),
  /** Present on `rate_limited`. */
  rateLimit: rateLimitStateSchema.optional(),
  /** Present on `payment_required`. */
  billing: accessSchema.optional(),
  /** Present on `feature_unavailable`: the capability the plan is missing. */
  feature: z.string().optional(),
  /** Present on `budget_exhausted`. */
  killSwitch: killSwitchSchema.optional(),
  /** Present on `validation_failed`: which fields, and what was wrong. */
  fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})
export type V1ErrorDetails = z.infer<typeof v1ErrorDetailsSchema>

/**
 * The one error body every `/v1` route returns.
 *
 * Four fields, and each one has a distinct audience:
 *
 *   `code`      — the stable string a program branches on. An HTTP status
 *                 cannot tell "out of monthly runs" from "too many requests a
 *                 minute", and both are 429.
 *   `message`   — a sentence for a person. User-safe by construction; internals
 *                 never reach it.
 *   `details`   — the machine-readable specifics, typed above.
 *   `requestId` — what a user pastes into a support conversation, and what an
 *                 operator greps the logs for. Always present, because an error
 *                 nobody can trace is an error nobody can fix.
 */
export const v1ErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: v1ErrorDetailsSchema.optional(),
  requestId: z.string(),
})
export type V1Error = z.infer<typeof v1ErrorSchema>

/**
 * Project an internal refusal onto the public envelope.
 *
 * The internal `ApiError` carries its typed fields at the top level, which suits
 * a first-party client that already knows the shape. The public envelope nests
 * them under `details` so that adding a *new* kind of detail later is an
 * additive change to one object rather than a new top-level field — the
 * difference between a minor version and an argument.
 *
 * `details` is omitted entirely when empty rather than sent as `{}`, so a
 * caller can branch on its presence instead of on its emptiness.
 */
export function toV1Error(body: ApiError, requestId: string): V1Error {
  const details: V1ErrorDetails = {
    ...(body.quota === undefined ? {} : { quota: body.quota }),
    ...(body.rateLimit === undefined ? {} : { rateLimit: body.rateLimit }),
    ...(body.billing === undefined ? {} : { billing: body.billing }),
    ...(body.feature === undefined ? {} : { feature: body.feature }),
    ...(body.killSwitch === undefined ? {} : { killSwitch: body.killSwitch }),
    ...(body.fields === undefined ? {} : { fields: body.fields }),
  }

  return {
    code: body.code,
    message: body.error,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    requestId,
  }
}

/* ----------------------------------------------------------- pagination */

/**
 * One page of a collection.
 *
 * Cursor-based, everywhere, with no offset alternative — and that is a decision
 * rather than an omission. Offsets over a table that is being written to skip
 * and repeat rows as the underlying set shifts under the reader, which is
 * exactly what a run history does while runs are being created. An opaque
 * cursor cannot express "page 7", and it also cannot silently lie about it.
 *
 * `hasMore` is redundant with `nextCursor !== null` and is sent anyway: it is
 * the field people actually write their loop condition against, and a client
 * that gets the redundancy wrong writes an infinite loop.
 */
export interface CursorPage<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * The page envelope for a given item schema.
 *
 * A factory rather than a generic type alias because the *runtime* schema is
 * what the spec generator reads and what the SDK parses with — a type alone
 * would give the compile-time half and leave the wire unvalidated.
 */
export function cursorPageSchema<T extends z.ZodType>(
  item: T,
): z.ZodType<CursorPage<z.infer<T>>> {
  return z.object({
    data: z.array(item),
    /** Opaque. Pass it back verbatim as `?cursor=`; never construct one. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
}

/** Query parameters every paginated `/v1` collection accepts. */
export const v1PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(255).optional(),
})
export type V1PageQuery = z.infer<typeof v1PageQuerySchema>

/** Assemble a page from one over-fetched row set. */
export function toCursorPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (item: T) => string,
): CursorPage<T> {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const hasMore = rows.length > limit
  return {
    data: [...page],
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
    hasMore,
  }
}

/* ---------------------------------------------------------- deprecation */

/**
 * Sunset signalling, per RFC 9745 (`Deprecation`) and RFC 8594 (`Sunset`).
 *
 * The policy — twelve months' notice, both headers for the whole of it, a
 * `Link` to what replaces the endpoint — is written out in
 * `doc/api/versioning.md`. What lives here is the machinery, so that honouring
 * the policy is a one-line middleware rather than a memo.
 *
 * Nothing in `/v1` is deprecated today. That is the point of building this at
 * the same time as the version it protects: the first deprecation should be a
 * configuration change, not a project.
 */
export const DEPRECATION_HEADERS = {
  /** RFC 9745. An IMF-fixdate in the past means "already deprecated". */
  deprecation: "Deprecation",
  /** RFC 8594. An IMF-fixdate: when the endpoint stops answering. */
  sunset: "Sunset",
  /** RFC 8288 relations pointing at the successor and the policy. */
  link: "Link",
} as const

export interface DeprecationNotice {
  /** When the endpoint was announced deprecated. */
  deprecatedAt: Date
  /** When it stops answering. Null while a date has not been committed to. */
  sunsetAt: Date | null
  /** Absolute URL of the endpoint that replaces it, if there is one. */
  successorUrl?: string
  /** Absolute URL of the human-readable notice. */
  policyUrl?: string
}

/**
 * The headers announcing a deprecation.
 *
 * Both dates are IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), which is what
 * both RFCs specify and what `new Date().toUTCString()` already produces — one
 * of the rare cases where the platform's default format is the correct one.
 */
export function deprecationHeaders(notice: DeprecationNotice): Record<string, string> {
  const links = [
    ...(notice.successorUrl === undefined ? [] : [`<${notice.successorUrl}>; rel="successor-version"`]),
    ...(notice.policyUrl === undefined ? [] : [`<${notice.policyUrl}>; rel="deprecation"; type="text/html"`]),
  ]

  return {
    [DEPRECATION_HEADERS.deprecation]: notice.deprecatedAt.toUTCString(),
    ...(notice.sunsetAt === null
      ? {}
      : { [DEPRECATION_HEADERS.sunset]: notice.sunsetAt.toUTCString() }),
    ...(links.length === 0 ? {} : { [DEPRECATION_HEADERS.link]: links.join(", ") }),
  }
}

/* ---------------------------------------------------------------- ETag */

/**
 * Header names for conditional reads.
 *
 * A finished run is immutable, and a client polling one — which is what every
 * integration written against a job API does before it discovers the event
 * stream — should pay for the round trip and not for the body. `ETag` plus
 * `If-None-Match` turns that poll into a 304 with no payload.
 */
export const CONDITIONAL_HEADERS = {
  etag: "ETag",
  ifNoneMatch: "If-None-Match",
} as const

/**
 * Does a client's `If-None-Match` cover this entity tag?
 *
 * Handles the list form (`"a", "b"`) and `*`, and compares weak tags by their
 * opaque part — RFC 9110 §13.1.2 specifies the *weak* comparison function for
 * `If-None-Match`, so `W/"x"` and `"x"` match. Getting this wrong in the strict
 * direction is invisible: every response is simply a 200, and the feature
 * quietly does nothing.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false

  const opaque = (tag: string): string => tag.trim().replace(/^W\//, "")
  const wanted = opaque(etag)

  return ifNoneMatch
    .split(",")
    .map(opaque)
    .some((candidate) => candidate === "*" || candidate === wanted)
}
