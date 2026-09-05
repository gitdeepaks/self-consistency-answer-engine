import { REQUEST_ID_HEADER, requestIdSchema } from "@sce/shared"
import type { Context, MiddlewareHandler } from "hono"

/**
 * One id per request, echoed to the caller and carried into every error.
 *
 * The public error envelope promises a `requestId` on every refusal, and that
 * promise is only worth anything if the same value reaches the logs. So it is
 * resolved once, here, at the very front of the stack — before authentication,
 * before rate limiting, before anything that can refuse a request — because the
 * errors that most need to be traceable are exactly the ones raised before a
 * handler was ever reached.
 *
 * A client-supplied id is preferred over a generated one. Somebody debugging an
 * integration already has a trace id for the operation that produced this call,
 * and being able to search our logs with *their* id rather than correlating two
 * different ones is most of the value of having the header at all.
 */

export type RequestIdEnv = { Variables: { requestId: string } }

/**
 * The id for the current request. Always set: the middleware runs first.
 *
 * Generic over the environment because Hono's `Context` is invariant in it: a
 * `Context<AuthEnv>` is not a `Context<RequestIdEnv>` even though `AuthEnv`
 * carries everything `RequestIdEnv` does. Constraining the parameter instead of
 * naming it is what lets both surfaces call this without an assertion.
 */
export function requestIdOf<E extends RequestIdEnv>(c: Context<E>): string {
  return c.get("requestId")
}

/**
 * Resolve, store and echo the id.
 *
 * A supplied value is *parsed*, not passed through: it is about to be written
 * into a response header and into structured logs, which makes it the textbook
 * vehicle for header injection and log forgery. A value that does not fit is
 * replaced rather than rejected — a malformed correlation id is not worth
 * failing somebody's request over, and refusing it would only teach clients to
 * stop sending one.
 */
export const requestId: MiddlewareHandler<RequestIdEnv> = async (c, next) => {
  const supplied = requestIdSchema.safeParse(c.req.header(REQUEST_ID_HEADER))
  const id = supplied.success ? supplied.data : crypto.randomUUID()

  c.set("requestId", id)
  // Set before `next()` so it is present on responses produced by middleware
  // further down that never reach a handler — a 401, a 429, a validation 400.
  c.header(REQUEST_ID_HEADER, id)

  await next()
}
