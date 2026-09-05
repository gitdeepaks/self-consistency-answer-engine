import { createHash } from "node:crypto"
import { CONDITIONAL_HEADERS, etagMatches } from "@sce/shared"
import type { Context } from "hono"
import type { AuthEnv } from "../auth/middleware.ts"

/**
 * Conditional reads for run bodies.
 *
 * Every integration written against a job API polls it. That is not a failure
 * of documentation — it is what a client does before it discovers the event
 * stream, and what it falls back to when the stream drops — and a completed run
 * is immutable, so nearly all of that polling transfers a body the caller
 * already has. An `ETag` turns it into a 304 with no payload.
 *
 * The tag is a hash of the serialised body rather than a version column,
 * because it is the *response* that has to be identical, not the row. A field
 * added to the projection, a candidate body that finished offloading, a tag
 * edit — each changes what the caller would receive, and each changes the hash
 * without anybody having to remember to bump something.
 *
 * Weak (`W/"…"`) rather than strong, and that is the honest label: a strong tag
 * asserts byte-for-byte equality of the entity, which this cannot promise
 * across a build that reorders JSON keys. `If-None-Match` uses the weak
 * comparison function (RFC 9110 §13.1.2), so weak tags are exactly right here.
 */

/** The entity tag for a body. Deterministic, and cheap next to the query. */
export function etagFor(body: string): string {
  return `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`
}

/** The answer to a conditional read, or null when the caller has nothing cached. */
export interface ConditionalHit {
  etag: string
  hit: boolean
}

/**
 * Compare a caller's `If-None-Match` against a freshly computed tag.
 *
 * Returns both halves because the caller needs both: the tag goes on the 200
 * as well as on the 304, or the next request has nothing to send back and the
 * whole mechanism quietly does nothing.
 */
export function conditional(c: Context<AuthEnv>, body: string): ConditionalHit {
  const etag = etagFor(body)
  return { etag, hit: etagMatches(c.req.header(CONDITIONAL_HEADERS.ifNoneMatch), etag) }
}
