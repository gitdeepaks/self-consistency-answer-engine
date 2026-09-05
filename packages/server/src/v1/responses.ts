import { z } from "zod"
import { idempotencyKeySchema } from "@sce/shared"
import { ApiError } from "./schemas.ts"

/**
 * The response and request fragments every operation shares.
 *
 * Extracted so that the answer to "what does a 401 look like here?" is the same
 * object in twenty places rather than twenty descriptions that drift. The
 * `contract.test.ts` suite asserts the consequences — every operation documents
 * a refusal, every POST accepts an idempotency key — but a shared fragment is
 * what makes those assertions pass by construction instead of by vigilance.
 */

/** A refusal, rendered in the published envelope. */
export function errorResponse(description: string): {
  description: string
  content: { "application/json": { schema: typeof ApiError } }
} {
  return { description, content: { "application/json": { schema: ApiError } } }
}

/**
 * The four refusals any authenticated route can produce.
 *
 * Not exhaustive — a route that can hit a quota adds a 402 and a 503 of its
 * own — but these four are reachable from every operation behind the auth wall,
 * so listing them per route would be noise that nobody keeps accurate.
 */
export const COMMON_ERRORS = {
  400: errorResponse("The request did not match the expected shape."),
  401: errorResponse("No credential, or one that is expired or revoked."),
  403: errorResponse("The credential lacks the scope or role this route needs."),
  429: errorResponse("A plan ceiling or a per-window request budget was reached."),
} as const

/** `Idempotency-Key`, declared once so every POST documents it identically. */
export const idempotencyHeader: z.ZodObject<{
  "idempotency-key": z.ZodOptional<typeof idempotencyKeySchema>
}> = z.object({ "idempotency-key": idempotencyKeySchema.optional() })
