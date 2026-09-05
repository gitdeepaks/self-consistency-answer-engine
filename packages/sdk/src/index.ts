/**
 * `@sce/sdk` — the TypeScript client for the Self-Consistency Answer Engine.
 *
 * ```ts
 * import { Sce } from "@sce/sdk"
 *
 * const sce = new Sce({ apiKey: process.env.SCE_API_KEY!, baseUrl: "https://your-host" })
 *
 * const run = await sce.ask("Why is the sky blue?", {
 *   onDelta: ({ text }) => process.stdout.write(text),
 * })
 *
 * console.log(run.synthesis?.finalAnswer)
 * ```
 *
 * Three things about this package are worth knowing before reading further:
 *
 * **The types are not generated.** They are the same Zod schemas the server
 * validates requests with, vendored through `src/vendor/shared.ts`. A field
 * added to a run is a field in your editor's autocomplete in the same commit,
 * with no codegen step to run and nothing to drift.
 *
 * **Every response is parsed, not cast.** A body that does not match its schema
 * raises `SceResponseError` rather than resolving to an object whose fields
 * silently do not exist. That is what makes the return types a guarantee.
 *
 * **One build, every runtime.** Nothing here imports a Node builtin — signing
 * and hashing go through Web Crypto — so the same bundle runs in Node, Bun,
 * Deno, Cloudflare Workers and a browser.
 */

export { Sce, type AskHooks, type AskOptions, type SceOptions } from "./client.ts"
export { newIdempotencyKey, type FetchLike, type RequestOptions } from "./http.ts"
export {
  SceApiError,
  SceConfigError,
  SceConnectionError,
  SceError,
  SceResponseError,
  SceTimeoutError,
  isSceApiError,
} from "./errors.ts"

/**
 * Webhook verification.
 *
 * The same implementation the server signs with, so a receiver cannot be
 * subtly wrong in a way that only shows up under a rotated secret or a
 * non-ASCII prompt. Verify *before* parsing: the signature covers the raw
 * bytes, and re-serialising a parsed object changes them.
 *
 * ```ts
 * const result = await verifyWebhookSignature({
 *   secret: process.env.SCE_WEBHOOK_SECRET!,
 *   payload: await request.text(),
 *   headers: request.headers,
 * })
 * if (!result.ok) return new Response("bad signature", { status: 400 })
 * // result.event is a fully typed, discriminated WebhookEvent
 * ```
 */
export {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
  WEBHOOK_TOLERANCE_SECONDS,
  describeWebhookEvent,
  verifyWebhookSignature,
  webhookEventSchema,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookVerification,
  type WebhookVerificationFailure,
} from "./vendor/shared.ts"

/**
 * The domain types and their schemas.
 *
 * Exported so a caller can validate their own persisted copies, narrow a union
 * exhaustively, or type a function that takes a run without importing the
 * client. The schema and the type always come in a pair, because having one
 * without the other is how a boundary ends up unchecked.
 */
export {
  API_VERSION,
  IN_FLIGHT_STATUSES,
  TERMINAL_RUN_STATUSES,
  candidateSchema,
  cursorPageSchema,
  isEphemeralEvent,
  isTerminalEvent,
  isTerminalRunStatus,
  providerHealthSchema,
  readRunEventStream,
  runEventSchema,
  runSchema,
  runShareSchema,
  runSummarySchema,
  synthesisSchema,
  toRunSummary,
  usageSummarySchema,
  v1ErrorSchema,
  webhookDeliverySchema,
  webhookEndpointSchema,
  type AskInput,
  type Candidate,
  type CandidateReview,
  type CandidateStatus,
  type CreateShareInput,
  type CreateWebhookEndpointInput,
  type CursorPage,
  type ErrorCode,
  type PlanId,
  type ProviderHealth,
  type ProviderId,
  type QuotaStatus,
  type QuotaViolation,
  type RateLimitState,
  type Run,
  type RunEvent,
  type RunEventType,
  type RunSearchQuery,
  type RunShare,
  type RunStatus,
  type RunSummary,
  type StreamedRunEvent,
  type Synthesis,
  type UsageSummary,
  type V1Error,
  type V1ErrorDetails,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
} from "./vendor/shared.ts"
