import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { jsonValueSchema, WEBHOOK_EVENT_TYPES, type JsonValue } from "@sce/shared"
import { z } from "zod"
import { openApiDocument, v1 } from "./app.ts"

/**
 * The published contract, checked against itself.
 *
 * A specification generated from the code cannot be *wrong* about a shape — that
 * is the whole reason for generating it — but it can very easily be wrong about
 * everything around the shapes: a route documented by hand that no longer
 * exists, an operation with no summary, a POST that forgot `Idempotency-Key`, a
 * collection that answers with a bare array. Those are the things a reader of
 * the documentation trips over, and none of them is caught by a type.
 *
 * The last test here is the one that runs most often: it fails when somebody
 * changes a route and does not regenerate `doc/api/openapi.json`. That file is
 * what puts an API change in a pull request diff, so a stale one is worse than
 * none — it is believed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.join(HERE, "..", "..", "..", "..", "doc", "api", "openapi.json")

/** The document, parsed rather than asserted — it arrives typed as `unknown`. */
const documentSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: z.object({ title: z.string(), version: z.string(), description: z.string() }),
  servers: z.array(z.object({ url: z.string() })).min(1),
  security: z.array(z.record(z.string(), z.array(z.string()))).min(1),
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        parameters: z
          .array(z.object({ name: z.string(), in: z.string(), required: z.boolean().optional() }))
          .optional(),
        requestBody: jsonValueSchema.optional(),
        responses: z.record(z.string(), jsonValueSchema),
      }),
    ),
  ),
  webhooks: z.record(z.string(), jsonValueSchema),
  components: z.object({
    schemas: z.record(z.string(), jsonValueSchema),
    securitySchemes: z.record(z.string(), jsonValueSchema).optional(),
  }),
})

/**
 * The document twice, on purpose.
 *
 * `document` is the *narrowed* view the structural assertions read: `z.object`
 * strips what it does not name, which is exactly what makes those assertions
 * legible. `raw` is everything, and is what the staleness check compares —
 * comparing the narrowed copy would quietly pass while the committed file
 * differed in every field the schema above happens not to mention.
 */
const raw: JsonValue = jsonValueSchema.parse(openApiDocument())
const document = documentSchema.parse(openApiDocument())

/** Every `(path, method, operation)` triple, flattened. */
const operations = Object.entries(document.paths).flatMap(([route, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ route, method, operation })),
)

describe("the published surface", () => {
  test("is served from the version prefix and requires a credential by default", () => {
    expect(document.servers[0]?.url).toBe("/v1")
    expect(document.security).toEqual([{ bearerAuth: [] }])
    expect(document.components.securitySchemes?.["bearerAuth"]).toBeDefined()
  })

  test("covers the resources an integration actually needs", () => {
    const routes = Object.keys(document.paths)
    for (const expected of [
      "/runs",
      "/runs/{runId}",
      "/runs/{runId}/cancel",
      "/runs/{runId}/events",
      "/runs/{runId}/shares",
      "/shares",
      "/usage",
      "/providers",
      "/webhooks/endpoints",
      "/webhooks/deliveries",
    ]) {
      expect(routes).toContain(expected)
    }
  })

  test("deliberately excludes the internal surface", () => {
    // Publishing these would be promising them for twelve months each, and none
    // of them is a promise worth making to a stranger. See ADR-0008.
    const routes = Object.keys(document.paths)
    for (const internal of ["/admin", "/members", "/billing", "/audit", "/keys", "/feedback"]) {
      expect(routes.some((route) => route.startsWith(internal))).toBe(false)
    }
  })

  test("every operation is summarised and tagged", () => {
    const undocumented = operations
      .filter(({ operation }) => operation.summary === undefined || operation.tags === undefined)
      .map(({ method, route }) => `${method.toUpperCase()} ${route}`)

    expect(undocumented).toEqual([])
  })

  test("every operation documents a refusal, not only a success", () => {
    // A reference that lists only the happy path leaves an integrator to
    // discover the error envelope by causing one.
    const missing = operations
      .filter(({ route }) => route !== "/" && route !== "/health")
      .filter(({ operation }) =>
        Object.keys(operation.responses).every((status) => Number(status) < 400),
      )
      .map(({ method, route }) => `${method.toUpperCase()} ${route}`)

    expect(missing).toEqual([])
  })

  test("every write accepts an Idempotency-Key", () => {
    const missing = operations
      .filter(({ method }) => method === "post")
      .filter(({ operation }) =>
        (operation.parameters ?? []).every((parameter) => parameter.name !== "idempotency-key"),
      )
      .map(({ route }) => `POST ${route}`)

    expect(missing).toEqual([])
  })

  test("every paginated collection answers with the page envelope", () => {
    for (const name of ["RunPage", "RunSharePage", "WebhookEndpointPage", "WebhookDeliveryPage"]) {
      const page = document.components.schemas[name]
      expect(page).toBeDefined()

      const shape = z
        .object({ properties: z.object({ data: jsonValueSchema, nextCursor: jsonValueSchema, hasMore: jsonValueSchema }) })
        .safeParse(page)
      expect(shape.success).toBe(true)
    }
  })

  test("the error envelope is a named component with the four promised fields", () => {
    const error = z
      .object({
        properties: z.object({
          code: jsonValueSchema,
          message: jsonValueSchema,
          details: jsonValueSchema,
          requestId: jsonValueSchema,
        }),
        required: z.array(z.string()),
      })
      .safeParse(document.components.schemas["Error"])

    expect(error.success).toBe(true)
    if (!error.success) return
    // `details` is the only optional one: a refusal with nothing to add omits it
    // so that presence is a usable signal.
    expect(error.data.required.sort()).toEqual(["code", "message", "requestId"])
  })

  test("the outbound events are documented, and are exactly the ones we send", () => {
    expect(Object.keys(document.webhooks).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort())
  })

  test("the streaming route is documented as an event stream", () => {
    const stream = document.paths["/runs/{runId}/events"]?.["get"]
    expect(stream).toBeDefined()

    const content = z
      .object({ responses: z.object({ 200: z.object({ content: z.object({ "text/event-stream": jsonValueSchema }) }) }) })
      .safeParse(stream)
    expect(content.success).toBe(true)
  })
})

describe("documentation and reality agree", () => {
  /** `/runs/{runId}` in the document is `/runs/:runId` in the router. */
  const toRouterPath = (route: string): string => route.replace(/\{(\w+)\}/g, ":$1")

  test("every documented route has a handler registered", () => {
    // The check that earns its keep: the SSE route and the webhook events are
    // documented by hand, and a hand-written entry is exactly the kind of thing
    // that outlives the route it describes.
    const registered = new Set(
      v1.routes.map((route) => `${route.method.toLowerCase()} ${route.path}`),
    )

    const orphaned = operations
      .map(({ method, route }) => `${method} ${toRouterPath(route)}`)
      .filter((key) => !registered.has(key))

    expect(orphaned).toEqual([])
  })

  test("every handler is documented", () => {
    const documented = new Set(
      operations.map(({ method, route }) => `${method} ${toRouterPath(route)}`),
    )

    const undocumented = v1.routes
      // Middleware is registered as `ALL /*`; only real handlers are routes a
      // caller can reach, and `/openapi.json` documents itself by being the
      // document.
      .filter((route) => route.method !== "ALL" && route.path !== "/openapi.json")
      .map((route) => `${route.method.toLowerCase()} ${route.path}`)
      .filter((key) => !documented.has(key))

    expect([...new Set(undocumented)]).toEqual([])
  })
})

describe("the committed specification", () => {
  test("is up to date with the routes", () => {
    const committed: JsonValue = jsonValueSchema.parse(
      JSON.parse(readFileSync(SPEC_PATH, "utf8")),
    )
    // Compared as parsed values rather than as text, so this fails on a real
    // difference and not on formatting. `bun run api:check` is the one that
    // insists on byte equality, because that is what makes the diff readable.
    expect(raw).toEqual(committed)
  })
})
