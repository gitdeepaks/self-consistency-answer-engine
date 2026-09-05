import {
  askInputSchema,
  candidateSchema,
  createShareInputSchema,
  createWebhookEndpointInputSchema,
  cursorPageSchema,
  providerHealthSchema,
  runSchema,
  runSummarySchema,
  runShareSchema,
  setRunTagsInputSchema,
  synthesisSchema,
  usageSummarySchema,
  v1ErrorSchema,
  webhookDeliverySchema,
  webhookEndpointCreatedSchema,
  webhookEndpointSchema,
  webhookEventSchema,
} from "@sce/shared"
import { z } from "zod"

/**
 * The published shapes, named.
 *
 * Every schema here is a *clone* of one from `@sce/shared` carrying an
 * OpenAPI component id. Three things follow from doing it this way rather than
 * writing a second set of schemas for the public API:
 *
 *   - The spec cannot drift from the code, because there is only one
 *     definition. Adding a field to `runSchema` changes the API, the SDK's
 *     types and the published document in one edit.
 *   - `.meta()` returns a new schema rather than mutating the original, so the
 *     first-party surface is untouched by anything done for documentation.
 *   - The generator emits `$ref`s instead of inlining every shape at every use,
 *     which is the difference between a reference a person can read and forty
 *     copies of the same object.
 *
 * The ids are part of the contract too — an SDK generator turns them into type
 * names — so they are stable and are covered by the compatibility gate.
 */

export const Candidate = candidateSchema.meta({ id: "Candidate" })
export const Synthesis = synthesisSchema.meta({ id: "Synthesis" })
export const Run = runSchema.meta({ id: "Run" })
export const RunSummary = runSummarySchema.meta({ id: "RunSummary" })
export const ProviderHealth = providerHealthSchema.meta({ id: "ProviderHealth" })
export const RunShare = runShareSchema.meta({ id: "RunShare" })
export const UsageSummary = usageSummarySchema.meta({ id: "UsageSummary" })
export const WebhookEndpoint = webhookEndpointSchema.meta({ id: "WebhookEndpoint" })
export const WebhookEndpointCreated = webhookEndpointCreatedSchema.meta({
  id: "WebhookEndpointCreated",
})
export const WebhookDelivery = webhookDeliverySchema.meta({ id: "WebhookDelivery" })
export const WebhookEvent = webhookEventSchema.meta({ id: "WebhookEvent" })
export const ApiError = v1ErrorSchema.meta({ id: "Error" })

/* ---------------------------------------------------------------- inputs */

export const CreateRunRequest = askInputSchema.meta({ id: "CreateRunRequest" })
export const SetTagsRequest = setRunTagsInputSchema.meta({ id: "SetTagsRequest" })
export const CreateShareRequest = createShareInputSchema.meta({ id: "CreateShareRequest" })
export const CreateWebhookEndpointRequest = createWebhookEndpointInputSchema.meta({
  id: "CreateWebhookEndpointRequest",
})

/**
 * Cancelling a run.
 *
 * Redeclared rather than reused from `cancelRunInputSchema` for one reason: the
 * public route accepts an empty body, and `@hono/zod-openapi` treats a declared
 * request body as required. `.optional()` on every field plus a default makes
 * `POST /v1/runs/{runId}/cancel` with no body at all the documented,
 * type-checked normal case, which is what an integrator will actually send.
 */
export const CancelRunRequest = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .meta({ id: "CancelRunRequest" })

/* -------------------------------------------------------------- envelopes */

/**
 * Every collection answers with the same three fields.
 *
 * Named per item type so the spec carries `RunPage`, `WebhookEndpointPage` and
 * so on rather than one anonymous shape repeated — which is what makes a
 * generated SDK's return types readable instead of `Page<unknown>`.
 */
export const RunPage = cursorPageSchema(RunSummary).meta({ id: "RunPage" })
export const RunSharePage = cursorPageSchema(RunShare).meta({ id: "RunSharePage" })
export const WebhookEndpointPage = cursorPageSchema(WebhookEndpoint).meta({
  id: "WebhookEndpointPage",
})
export const WebhookDeliveryPage = cursorPageSchema(WebhookDelivery).meta({
  id: "WebhookDeliveryPage",
})

/** The panel a run would fan out to, and whether each member is reachable. */
export const ProviderList = z
  .object({
    panel: z.array(ProviderHealth),
    evaluator: ProviderHealth.extend({ role: z.literal("evaluator") }),
  })
  .meta({ id: "ProviderList" })

/** What a caller needs to know about this deployment before writing against it. */
export const VersionIndex = z
  .object({
    version: z.string(),
    /** ISO-8601, or null while no sunset date has been committed to. */
    sunset: z.string().nullable(),
    documentationUrl: z.string(),
    openapiUrl: z.string(),
  })
  .meta({ id: "VersionIndex" })

export const Health = z
  .object({ ok: z.literal(true), service: z.string(), time: z.string() })
  .meta({ id: "Health" })

export const Deleted = z.object({ deleted: z.literal(true), id: z.string() }).meta({ id: "Deleted" })

/** The shape of a cancellation, which is not simply the run. */
export const CancelResult = z
  .object({
    run: Run,
    /** False when the run had already finished — not an error, just a no-op. */
    canceled: z.boolean(),
  })
  .meta({ id: "CancelResult" })
