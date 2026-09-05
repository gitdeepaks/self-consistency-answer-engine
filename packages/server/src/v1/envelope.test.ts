import { describe, expect, test } from "bun:test"
import { REQUEST_ID_HEADER, v1ErrorSchema } from "@sce/shared"
import { app } from "../app.ts"

/**
 * The envelope, asserted through the whole stack.
 *
 * These requests carry no credential, so they are refused before any handler,
 * any database and any queue — which is what makes this suite runnable with no
 * infrastructure, and is also the case that matters most. A 401 is the first
 * thing an integrator's error handling meets, it is produced by middleware
 * rather than by a route, and it is therefore exactly the response most likely
 * to escape a contract that is only enforced at the handlers.
 *
 * It also pins down a subtlety that cost an hour to find: Hono's `compose` does
 * not propagate a thrown value up the middleware chain — it calls the app's
 * `onError` at the throw site — so a `try/catch` middleware inside `/v1` looks
 * correct, compiles, and silently never runs. The rendering lives in the root
 * handler for that reason, and this suite is what keeps it there.
 */

describe("the /v1 error envelope", () => {
  test("a request with no credential is refused in the published shape", async () => {
    const response = await app.request("/v1/runs")

    expect(response.status).toBe(401)

    const body = v1ErrorSchema.safeParse(await response.json())
    expect(body.success).toBe(true)
    if (!body.success) return

    expect(body.data.code).toBe("unauthorized")
    // The message says nothing about *why*: telling an anonymous caller whether
    // a key is revoked or unknown tells them which half of a guess was right.
    expect(body.data.message).toBe("Authentication required")
    expect(body.data.requestId.length).toBeGreaterThan(0)
  })

  test("the 401 carries WWW-Authenticate, which is what the status code means", async () => {
    const response = await app.request("/v1/usage")
    expect(response.headers.get("www-authenticate")).toContain("Bearer")
  })

  test("an unknown path under /v1 answers in the same shape", async () => {
    const response = await app.request("/v1/nope")
    expect(v1ErrorSchema.safeParse(await response.json()).success).toBe(true)
  })

  test("every response carries a request id, refusals included", async () => {
    const response = await app.request("/v1/runs")
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
  })

  test("a caller's own correlation id is echoed rather than replaced", async () => {
    const response = await app.request("/v1/runs", {
      headers: { [REQUEST_ID_HEADER]: "trace-abc.123" },
    })
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("trace-abc.123")

    const body = v1ErrorSchema.parse(await response.json())
    // The header and the body agree, or the field is worthless for support.
    expect(body.requestId).toBe("trace-abc.123")
  })

  test("a correlation id outside the allowlist is replaced, not passed through", async () => {
    /*
     * This value is echoed into a response header and written to structured
     * logs, which makes it the textbook vehicle for log forgery. It is replaced
     * rather than rejected: a bad correlation id is not worth failing somebody's
     * request over, and refusing it would only teach clients to stop sending
     * one.
     *
     * The CRLF case — the header-injection one — cannot even be constructed:
     * every runtime's `Headers` refuses a value containing a newline before it
     * reaches us. The parser is the second line of that defence, for the
     * everything-else that is a legal header value and still has no business in
     * a log line.
     */
    const forged = "forged id with spaces <script>"
    const response = await app.request("/v1/runs", {
      headers: { [REQUEST_ID_HEADER]: forged },
    })

    const echoed = response.headers.get(REQUEST_ID_HEADER)
    expect(echoed).not.toBe(forged)
    expect(echoed).toMatch(/^[A-Za-z0-9._:-]+$/)
  })
})

describe("the two surfaces stay apart", () => {
  test("/api keeps its first-party envelope", async () => {
    const response = await app.request("/api/runs")

    expect(response.status).toBe(401)
    // Not the published shape: `/api` ships with its clients and is free to
    // answer in whatever form suits them. Asserting the difference is what stops
    // the two quietly converging and then diverging again.
    const body = await response.json()
    expect(v1ErrorSchema.safeParse(body).success).toBe(false)
    expect(body).toEqual({ error: "Authentication required" })
  })

  test("/api keeps its own 404", async () => {
    const response = await app.request("/api/nope")
    expect(await response.json()).toEqual({ error: "Not found", path: "/api/nope" })
  })

  test("a path that merely starts with the prefix is not the public surface", async () => {
    // `/v1x` is not `/v1`. A naive `startsWith("/v1")` would render an internal
    // failure in the published envelope, which is the wrong promise to make.
    const response = await app.request("/v1x/nope")
    expect(await response.json()).toEqual({ error: "Not found", path: "/v1x/nope" })
  })
})

describe("what is reachable without a credential", () => {
  test.each([
    ["/v1", "the version index"],
    ["/v1/health", "liveness"],
    ["/v1/openapi.json", "the specification"],
  ])("%s — %s", async (route) => {
    const response = await app.request(route)
    expect(response.status).toBe(200)
  })

  test("and nothing else", async () => {
    for (const route of [
      "/v1/runs",
      "/v1/usage",
      "/v1/providers",
      "/v1/shares",
      "/v1/webhooks/endpoints",
      "/v1/webhooks/deliveries",
    ]) {
      const response = await app.request(route)
      expect({ route, status: response.status }).toEqual({ route, status: 401 })
    }
  })
})
