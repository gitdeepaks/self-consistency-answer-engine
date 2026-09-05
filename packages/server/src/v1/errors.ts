import { statusForErrorCode, toV1Error, type ErrorCode, type V1Error } from "@sce/shared"
import type { Context } from "hono"
import type { ZodError } from "zod"
import type { AuthEnv } from "../auth/middleware.ts"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RequestValidationError,
  describeError,
  isAppError,
} from "../errors.ts"
import { requestIdOf } from "../request-id.ts"

/**
 * One place that turns anything at all into a `/v1` refusal.
 *
 * The internal surface has `app.onError`, which is enough for a first-party
 * client that ships with the server. The public surface needs more than a
 * central handler — it needs a *guarantee*, because the envelope is part of the
 * published contract and a route that answers `{ error: "Run not found" }`
 * instead of `{ code, message, details, requestId }` has broken it for every
 * SDK that parses the response.
 *
 * So no handler under `/v1` constructs an error body, and none *returns* one
 * either. They throw — `notFound()`, `forbidden()`, `conflict()` — and the
 * boundary middleware in `app.ts` renders whatever comes out. Two things follow
 * from that, and the second is the reason it is done this way:
 *
 *   - there is exactly one renderer, so the envelope cannot drift;
 *   - a handler's signature describes only what it does when it *succeeds*,
 *     which is what lets `@hono/zod-openapi` check the success path against the
 *     schema the specification publishes. A handler returning `Response` for
 *     its error paths defeats that check entirely.
 */

/** The resource is absent, or in another workspace. The caller cannot tell. */
export function notFound(what: string): never {
  throw new NotFoundError(what)
}

/** The caller is known and may not do this. */
export function forbidden(message: string): never {
  throw new ForbiddenError(message)
}

/** The request contradicts the resource's current state. */
export function conflict(message: string): never {
  throw new ConflictError(message)
}

/**
 * A validation failure, with the offending fields named.
 *
 * Paths are joined with dots so they read the way the JSON does — `providers.0`
 * rather than `["providers", 0]`, which is the form somebody can search their
 * own payload for.
 */
export function invalid(error: ZodError): never {
  throw new RequestValidationError(
    "The request did not match the expected shape",
    error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    })),
  )
}

/** A validation failure about one named field. */
export function invalidField(path: string, message: string): never {
  throw new RequestValidationError(message, [{ path, message }])
}

/**
 * Build the envelope.
 *
 * Exported for the one caller that cannot throw — the catch-all route, which is
 * matched rather than raised — and for the tests that assert the shape.
 */
export function errorBody(c: Context<AuthEnv>, code: ErrorCode, message: string): V1Error {
  return { code, message, requestId: requestIdOf(c) }
}

/**
 * Render a thrown value.
 *
 * An `AppError` is a decision this code made on purpose — a quota, a rate
 * limit, an unpaid subscription, the spend kill switch, a missing resource. It
 * already carries a machine-readable code, the headers a client needs to act on
 * it and a typed body, so it is projected onto the public envelope rather than
 * reinterpreted, and it is *not* logged: it is expected traffic, not a fault.
 *
 * Anything else is a bug. It is logged in full with the request id — so the log
 * line and the caller's complaint can be joined — and answered with a generic
 * 500, because the internals of an unexpected failure are precisely what must
 * not reach a stranger.
 */
export function renderError(c: Context<AuthEnv>, error: unknown): Response {
  const requestId = requestIdOf(c)

  if (isAppError(error)) {
    return c.json(toV1Error(error.body(), requestId), error.status, error.headers())
  }

  console.error("[v1] unhandled error", {
    requestId,
    path: c.req.path,
    method: c.req.method,
    error: describeError(error),
  })

  return c.json(
    errorBody(c, "internal_error", "The request could not be completed"),
    statusForErrorCode("internal_error"),
  )
}
