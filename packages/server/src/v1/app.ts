import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  API_VERSION,
  deprecationHeaders,
  WEBHOOK_HEADERS,
  webhookEventTypeSchema,
  type DeprecationNotice,
} from "@sce/shared"
import type { MiddlewareHandler } from "hono"
import type { AuthEnv } from "../auth/middleware.ts"
import { requireAuth } from "./auth.ts"
import { account } from "./account.ts"
import { errorBody, invalid, renderError } from "./errors.ts"
import { runs } from "./runs.ts"
import * as s from "./schemas.ts"
import { shares } from "./shares.ts"
import { webhooks } from "./webhooks.ts"

/**
 * `/v1` — the API as a product.
 *
 * The distinction from `/api` is the whole of Phase 6 and is worth stating
 * plainly, because both surfaces serve the same data:
 *
 *   `/api` is **first-party**. The web app and the TUI are deployed with the
 *   server, so the contract between them can change in the same commit. It is
 *   not documented, not versioned, and nobody outside this repository should
 *   write against it.
 *
 *   `/v1` is **published**. Its shapes are in the OpenAPI document, its
 *   breaking changes are blocked in CI by the schema-diff gate, and removing
 *   anything from it costs twelve months of notice under
 *   `doc/api/versioning.md`. It is therefore deliberately *narrower* than the
 *   internal surface: administration, billing internals and membership
 *   management are absent, because they are not promises worth keeping to
 *   strangers.
 *
 * Everything below the version prefix requires a credential. There is no
 * anonymous route here at all — not health, not the panel list — because an
 * exception in a uniformly authenticated surface is what later gets generalised
 * by accident. The two genuinely public things, the liveness probe and the
 * share-link reader, stay on `/api` where their exceptional status is visible.
 */

/** The spec's own metadata. `version` is the *document's*, not the API's. */
const OPENAPI_INFO = {
  title: "Self-Consistency Answer Engine API",
  version: "1.0.0",
  description:
    "Ask several frontier models the same question, then have an evaluator merge their " +
    "answers into one — with the agreements, the disagreements and a confidence score " +
    "attached.\n\n" +
    "**Authentication.** Every route takes `Authorization: Bearer sce_live_…`. Create a " +
    "key in the web app under Settings → API keys. A key carries scopes; a request that " +
    "needs one the key lacks is refused with 403 and `code: \"forbidden\"`.\n\n" +
    "**Errors.** Every refusal is `{ code, message, details?, requestId }`. Branch on " +
    "`code`, never on the HTTP status alone — 429 covers both a plan ceiling and a " +
    "per-window request budget, and `details` tells them apart.\n\n" +
    "**Retries.** Send an `Idempotency-Key` on every POST. A retry carrying the same key " +
    "replays the original response instead of performing the write twice.\n\n" +
    "**Runs are asynchronous.** `POST /v1/runs` returns as soon as the run is queued. " +
    "Follow it with the SSE stream, or register a webhook and be told.",
  contact: { name: "API support", url: "https://github.com/gitdeepaks/self-consistency-answer-engine" },
  license: { name: "MIT" },
} as const

/**
 * Announce a deprecation on a route.
 *
 * Nothing in `/v1` is deprecated today, and building this alongside the version
 * it protects is the point: the first deprecation should be a configuration
 * change rather than a project. `doc/api/versioning.md` is the policy this
 * implements, and `v1.versioning.test.ts` holds the header format to it.
 */
export function deprecated(notice: DeprecationNotice): MiddlewareHandler<AuthEnv> {
  const headers = deprecationHeaders(notice)
  return async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(headers)) c.header(name, value)
  }
}

/**
 * The `/v1` application.
 *
 * `defaultHook` is what makes the envelope a guarantee rather than a
 * convention: every validator in every route funnels its failure through one
 * function, so a route cannot accidentally answer a 400 in a shape the SDK
 * cannot parse.
 */
const v1 = new OpenAPIHono<AuthEnv>({
  /*
   * Every validator in every route funnels its failure through one function, so
   * a route cannot accidentally answer a 400 in a shape the SDK cannot parse.
   * It throws rather than returning, which puts it on the same path as every
   * other refusal — the boundary below renders all of them.
   */
  defaultHook: (result) => {
    if (!result.success) invalid(result.error)
    return undefined
  },
})

/**
 * Where refusals are rendered — and where they are not.
 *
 * There is no error-catching middleware here, and that is worth stating because
 * writing one is the obvious thing to do and it silently does nothing. Hono's
 * `compose` does not let a thrown value propagate up the middleware chain as an
 * exception: it calls the application's `onError` at the throw site and returns
 * the resulting response, so an outer `try { await next() }` never sees it.
 *
 * A sub-application's own `onError` is not carried over by `route()` either. So
 * the one handler that actually runs is the root app's, and `app.ts` dispatches
 * on the path prefix: `/v1` gets `renderError` from `./errors.ts` and the
 * published envelope, everything else gets the first-party one.
 *
 * `v1.errorRenderer` is exported for it rather than reached for across module
 * boundaries, so the coupling is visible from both ends.
 */

/**
 * The version index and the specification, ahead of the auth wall.
 *
 * A developer discovering the API has no key yet, and making them get one
 * before they can read what it does is the small friction that stops people
 * evaluating a product. Neither route reveals anything about any tenant: one is
 * two URLs and a sunset date, the other is a description of shapes.
 */
v1.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Meta"],
    summary: "Version index",
    description: "What this version is, where it is documented, and when it stops answering.",
    responses: {
      200: {
        description: "This version.",
        content: { "application/json": { schema: s.VersionIndex } },
      },
    },
  }),
  (c) =>
    c.json(
      {
        version: API_VERSION,
        // Null, and expected to stay null for a long time. A version with a
        // sunset date announces it here first, twelve months ahead, before any
        // route starts sending `Sunset` headers.
        sunset: null,
        documentationUrl: "https://github.com/gitdeepaks/self-consistency-answer-engine/tree/main/doc/api",
        openapiUrl: "/v1/openapi.json",
      },
      200,
    ),
)

v1.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["Meta"],
    summary: "Liveness",
    description:
      "Answers without touching the database, the queue or the identity provider, so it " +
      "reports on *this process* rather than on everything behind it.",
    responses: {
      200: { description: "Alive.", content: { "application/json": { schema: s.Health } } },
    },
  }),
  (c) =>
    c.json(
      {
        ok: true as const,
        service: "self-consistency-answer-engine",
        time: new Date().toISOString(),
      },
      200,
    ),
)

/**
 * The specification itself, ahead of the wall.
 *
 * A developer discovering the API has no key yet, and making them get one
 * before they can read what the API does is the small friction that ends an
 * evaluation. The document describes shapes and reveals no tenant's anything.
 */
v1.get("/openapi.json", (c) => c.json(document))

/*
 * The auth wall.
 *
 * Applied as a wildcard rather than route by route, and the two public routes
 * above are exempt by being registered *before* it — so a route added anywhere
 * below is authenticated by default. The `/api` surface makes the opposite
 * trade, allowlisting each protected prefix, because it grew a public surface
 * first; here there is nothing to grandfather in.
 */
v1.use("*", requireAuth)

v1.route("/", runs)
v1.route("/", shares)
v1.route("/", webhooks)
v1.route("/", account)

/*
 * The outbound events, in the specification's `webhooks` section.
 *
 * OpenAPI 3.1 added this precisely so that "what we send you" lives in the same
 * document as "what you send us", and a generator can produce receiver types
 * from it. Registered by hand because these are not routes on this server —
 * they are requests this server makes to somebody else's.
 */
for (const eventType of webhookEventTypeSchema.options) {
  v1.openAPIRegistry.registerWebhook({
    method: "post",
    path: eventType,
    summary: `${eventType} delivered to a registered endpoint`,
    description:
      `Sent to every endpoint subscribed to \`${eventType}\`.\n\n` +
      `Verify before you parse: the signature covers the raw body, and re-serialising a ` +
      `parsed object changes the bytes. Compare \`${WEBHOOK_HEADERS.signature}\` against ` +
      `an HMAC-SHA256 of \`{${WEBHOOK_HEADERS.id}}.{${WEBHOOK_HEADERS.timestamp}}.{body}\` ` +
      `keyed with the endpoint's \`whsec_…\` secret — or call \`verifyWebhookSignature\` ` +
      `from \`@sce/sdk\`, which does exactly that.\n\n` +
      `Answer 2xx quickly and do the work afterwards: a delivery that takes longer than ` +
      `ten seconds is treated as failed and retried.\n\n` +
      `Deliveries are at-least-once. Deduplicate on \`${WEBHOOK_HEADERS.id}\`.`,
    request: {
      headers: z.object({
        [WEBHOOK_HEADERS.id]: z.string().meta({ description: "Unique per event; stable across retries." }),
        [WEBHOOK_HEADERS.timestamp]: z.string().meta({ description: "Unix seconds when the attempt was signed." }),
        [WEBHOOK_HEADERS.signature]: z.string().meta({ description: "Space-delimited `v1,<base64>` signatures." }),
      }),
      body: { content: { "application/json": { schema: s.WebhookEvent } } },
    },
    responses: {
      200: { description: "Acknowledged. Any 2xx settles the delivery." },
      500: { description: "Anything else is retried with exponential backoff." },
    },
  })
}

/**
 * The specification, generated from the routes above.
 *
 * Computed once and reused: the document is a pure function of the route table,
 * the route table is fixed at import time, and re-walking every schema on each
 * request would be a needless cost on a route that documentation tools poll.
 */
const document = (() => {
  v1.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "An API key: `Authorization: Bearer sce_live_…`. A browser session token from Clerk " +
      "is also accepted, which is what the web app's playground uses.",
  })

  return v1.getOpenAPI31Document({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    servers: [{ url: "/v1", description: "This deployment" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Meta", description: "Version discovery and liveness." },
      { name: "Runs", description: "Ask a panel a question, and follow the answer." },
      { name: "Shares", description: "Publish a finished run as a public link." },
      { name: "Webhooks", description: "Be told when a run finishes, instead of polling." },
      { name: "Account", description: "Panel availability, usage and plan limits." },
    ],
  })
})()

/** The published specification. */
export function openApiDocument(): unknown {
  return document
}

/**
 * Anything else under `/v1`.
 *
 * Registered last, and needed because a sub-application mounted with `route()`
 * does not inherit the parent's `notFound` either — without it, a typo in a path
 * would fall through to the root handler and answer in the internal envelope,
 * which is the one shape a published API must never produce.
 */
v1.all("*", (c) =>
  c.json(errorBody(c, "not_found", `No such endpoint: ${c.req.method} ${c.req.path}`), 404),
)

/**
 * Render a refusal in the published envelope.
 *
 * Re-exported through this module because `app.ts` is the only caller, and a
 * root error handler reaching directly into `v1/errors.ts` would hide the fact
 * that the two are one mechanism.
 */
export { renderError as renderV1Error }

export { v1 }
