import { describe, expect, test } from "bun:test"
import { isFilteredSearch, runSearchQuerySchema, runSearchToParams, runTagSchema } from "./search.ts"

/**
 * History search parsing.
 *
 * The query string is the state of the history view, so these tests are about
 * one property above all: a URL this app builds must parse back to the query it
 * came from. Break that and filters stop being shareable, the back button
 * starts lying, and a reload silently drops what somebody had narrowed to.
 */

describe("list parameters", () => {
  test("comma-separated lists parse into arrays", () => {
    const parsed = runSearchQuerySchema.parse({ providers: "openai,google", status: "COMPLETE" })
    expect(parsed.providers).toEqual(["openai", "google"])
    expect(parsed.status).toEqual(["COMPLETE"])
  })

  test("an unrecognised list member is dropped, not rejected", () => {
    // A bookmarked URL naming a provider this build no longer ships is a stale
    // link, not an attack. Narrowing the filter is the only reading that cannot
    // surprise anybody.
    const parsed = runSearchQuerySchema.parse({ providers: "openai,mistral,google" })
    expect(parsed.providers).toEqual(["openai", "google"])
  })

  test("whitespace and empty entries are tolerated", () => {
    const parsed = runSearchQuerySchema.parse({ status: " COMPLETE , ,FAILED " })
    expect(parsed.status).toEqual(["COMPLETE", "FAILED"])
  })
})

describe("scalar parameters", () => {
  test("a malformed date is rejected rather than narrowed", () => {
    // There is no safe narrowing of a broken scalar — unlike a list, dropping
    // it would silently widen the result set instead.
    expect(runSearchQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false)
    expect(runSearchQuerySchema.safeParse({ from: "2026-13-45" }).success).toBe(false)
    expect(runSearchQuerySchema.safeParse({ from: "2026-03-01" }).success).toBe(true)
  })

  test("confidence is bounded to the 0–1 range the schema stores", () => {
    expect(runSearchQuerySchema.safeParse({ minConfidence: "0.75" }).success).toBe(true)
    expect(runSearchQuerySchema.safeParse({ minConfidence: "75" }).success).toBe(false)
  })

  test("limit is clamped by the schema and defaults sensibly", () => {
    expect(runSearchQuerySchema.parse({}).limit).toBe(20)
    expect(runSearchQuerySchema.safeParse({ limit: "500" }).success).toBe(false)
  })

  test("`mine` becomes a boolean rather than the string 'false'", () => {
    expect(runSearchQuerySchema.parse({ mine: "true" }).mine).toBe(true)
    expect(runSearchQuerySchema.parse({ mine: "false" }).mine).toBe(false)
  })
})

describe("round trip", () => {
  test("a serialized query parses back to itself", () => {
    const original = runSearchQuerySchema.parse({
      q: "postgres",
      providers: "openai,anthropic",
      status: "COMPLETE,FAILED",
      tags: "infra,urgent",
      from: "2026-03-01",
      to: "2026-03-31",
      minConfidence: "0.5",
      mine: "true",
      limit: "50",
    })

    const round = runSearchQuerySchema.parse(
      Object.fromEntries(runSearchToParams(original).entries()),
    )

    expect(round).toEqual(original)
  })

  test("an empty query serializes to nothing", () => {
    const params = runSearchToParams({})
    expect(params.toString()).toBe("")
  })

  test("`mine: false` is omitted rather than written out", () => {
    // Writing `mine=false` would make a default state look like a deliberate
    // filter in the URL, and `isFilteredSearch` would then be wrong about it.
    expect(runSearchToParams({ mine: false }).toString()).toBe("")
  })
})

describe("distinguishing empty from unmatched", () => {
  test("a bare query is not a filtered search", () => {
    expect(isFilteredSearch(runSearchQuerySchema.parse({}))).toBe(false)
  })

  test("any filter makes it one", () => {
    // The empty state depends on this: "no runs yet" and "nothing matches" are
    // different messages with different buttons, and swapping them makes a
    // working filter look broken.
    expect(isFilteredSearch(runSearchQuerySchema.parse({ q: "x" }))).toBe(true)
    expect(isFilteredSearch(runSearchQuerySchema.parse({ tags: "infra" }))).toBe(true)
    expect(isFilteredSearch(runSearchQuerySchema.parse({ mine: "true" }))).toBe(true)
  })

  test("an all-unknown list does not count as a filter", () => {
    // Every member was dropped, so nothing is actually being constrained —
    // telling the user "nothing matches your filters" would be a lie.
    expect(isFilteredSearch(runSearchQuerySchema.parse({ providers: "mistral" }))).toBe(false)
  })
})

describe("tags", () => {
  test("tags are lowercased and fenced", () => {
    expect(runTagSchema.parse("  Infra  ")).toBe("infra")
    expect(runTagSchema.safeParse("has space").success).toBe(false)
    expect(runTagSchema.safeParse("-leading").success).toBe(false)
    expect(runTagSchema.safeParse("v1.2_beta-x").success).toBe(true)
    expect(runTagSchema.safeParse("a".repeat(33)).success).toBe(false)
  })
})
