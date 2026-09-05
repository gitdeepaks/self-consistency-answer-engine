import { describe, expect, test } from "bun:test"
import type { ApiError } from "./api-error.ts"
import {
  cursorPageSchema,
  deprecationHeaders,
  etagMatches,
  requestIdSchema,
  toCursorPage,
  toV1Error,
  v1ErrorSchema,
  v1PageQuerySchema,
} from "./v1.ts"
import { z } from "zod"

/**
 * The published contract's own behaviour: the envelope, the page shape and the
 * headers. Everything here is a promise to somebody outside this repository, so
 * these tests are less about correctness than about *stability* — they are what
 * makes a change to any of it a deliberate act.
 */

describe("the error envelope", () => {
  test("an internal refusal projects onto the public shape", () => {
    const internal: ApiError = {
      error: "You have used 50 of 50 runs this month.",
      code: "quota_exceeded",
      quota: {
        limit: "monthly_runs",
        used: 50,
        ceiling: 50,
        remaining: 0,
        resetAt: "2026-10-01T00:00:00.000Z",
        plan: "free",
        upgradeTo: "pro",
        message: "You have used 50 of 50 runs this month.",
      },
    }

    const projected = toV1Error(internal, "req_1")

    expect(v1ErrorSchema.safeParse(projected).success).toBe(true)
    expect(projected.code).toBe("quota_exceeded")
    // `error` becomes `message`; the typed specifics move under `details`, so a
    // new kind of detail later is an additive change to one object rather than
    // a new top-level field.
    expect(projected.message).toBe(internal.error)
    expect(projected.details?.quota?.limit).toBe("monthly_runs")
    expect(projected.requestId).toBe("req_1")
  })

  test("details is omitted rather than empty, so presence is a usable signal", () => {
    const projected = toV1Error({ error: "No such run", code: "not_found" }, "req_2")
    expect("details" in projected).toBe(false)
  })

  test("validation fields survive the projection", () => {
    const projected = toV1Error(
      {
        error: "The request did not match the expected shape",
        code: "validation_failed",
        fields: [{ path: "prompt", message: "Prompt must be at least 3 characters" }],
      },
      "req_3",
    )
    expect(projected.details?.fields).toEqual([
      { path: "prompt", message: "Prompt must be at least 3 characters" },
    ])
  })
})

describe("request ids", () => {
  test("a sane correlation id is accepted", () => {
    expect(requestIdSchema.safeParse("01J8Z-trace.7:2").success).toBe(true)
  })

  test.each([
    ["a newline, which would forge a log line", "req\nGET /admin"],
    ["a carriage return, which would inject a header", "req\r\nX-Admin: true"],
    ["a space", "two words"],
    ["nothing at all", ""],
  ])("%s is rejected so the caller gets a generated id instead", (_why, value) => {
    expect(requestIdSchema.safeParse(value).success).toBe(false)
  })
})

describe("cursor pages", () => {
  test("an over-fetched row set becomes a page with a cursor", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const page = toCursorPage(rows, 2, (row) => row.id)

    expect(page.data).toEqual([{ id: "a" }, { id: "b" }])
    // The cursor is the last item *of the page*, not of the fetch — otherwise
    // the next page silently skips a row.
    expect(page.nextCursor).toBe("b")
    expect(page.hasMore).toBe(true)
  })

  test("the last page has no cursor and says so twice", () => {
    const page = toCursorPage([{ id: "a" }], 2, (row) => row.id)
    expect(page.nextCursor).toBeNull()
    expect(page.hasMore).toBe(false)
  })

  test("an exactly-full page is the last one", () => {
    // The boundary that gets written wrong: two rows and a limit of two means
    // there is no third row, so there is nothing to page to.
    const page = toCursorPage([{ id: "a" }, { id: "b" }], 2, (row) => row.id)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeNull()
  })

  test("the page envelope parses what it describes", () => {
    const schema = cursorPageSchema(z.object({ id: z.string() }))
    expect(schema.safeParse({ data: [{ id: "a" }], nextCursor: null, hasMore: false }).success).toBe(
      true,
    )
    expect(schema.safeParse({ data: [{ id: 1 }], nextCursor: null, hasMore: false }).success).toBe(
      false,
    )
  })

  test("the shared page query defaults and clamps", () => {
    expect(v1PageQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(v1PageQuerySchema.safeParse({ limit: "101" }).success).toBe(false)
    expect(v1PageQuerySchema.parse({ limit: "100" }).limit).toBe(100)
  })
})

describe("conditional reads", () => {
  test("a weak tag matches its own opaque part", () => {
    // RFC 9110 §13.1.2: `If-None-Match` uses the *weak* comparison function, so
    // `W/"x"` and `"x"` match. Getting this wrong in the strict direction is
    // invisible — every response is simply a 200 and the feature does nothing.
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true)
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true)
  })

  test("a list of tags matches if any of them does", () => {
    expect(etagMatches('W/"one", W/"two"', 'W/"two"')).toBe(true)
    expect(etagMatches('W/"one", W/"two"', 'W/"three"')).toBe(false)
  })

  test("a star matches anything", () => {
    expect(etagMatches("*", 'W/"abc"')).toBe(true)
  })

  test("no header is not a match", () => {
    expect(etagMatches(undefined, 'W/"abc"')).toBe(false)
  })
})

describe("deprecation headers", () => {
  const deprecatedAt = new Date("2026-03-05T00:00:00.000Z")
  const sunsetAt = new Date("2027-03-05T00:00:00.000Z")

  test("both dates are IMF-fixdate, which is what the RFCs specify", () => {
    const headers = deprecationHeaders({ deprecatedAt, sunsetAt })
    expect(headers["Deprecation"]).toBe("Thu, 05 Mar 2026 00:00:00 GMT")
    expect(headers["Sunset"]).toBe("Fri, 05 Mar 2027 00:00:00 GMT")
  })

  test("no sunset date means no Sunset header, rather than a null one", () => {
    const headers = deprecationHeaders({ deprecatedAt, sunsetAt: null })
    expect("Sunset" in headers).toBe(false)
  })

  test("the successor and the policy travel as Link relations", () => {
    const headers = deprecationHeaders({
      deprecatedAt,
      sunsetAt,
      successorUrl: "https://api.example.com/v2/runs",
      policyUrl: "https://example.com/versioning",
    })
    expect(headers["Link"]).toContain('rel="successor-version"')
    expect(headers["Link"]).toContain('rel="deprecation"')
  })
})
