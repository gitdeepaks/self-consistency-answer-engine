import { describe, expect, test } from "bun:test"
import {
  looksLikeShareToken,
  mintShareToken,
  shareIsLive,
  shareTokenSchema,
  shareUrl,
  type RunShare,
} from "./share.ts"

/**
 * Share tokens.
 *
 * A share token is a capability: holding the link *is* the authorization. So
 * the properties that matter are that a real one always parses, that a
 * near-miss never does — the token becomes a database predicate and reaches an
 * anonymous route — and that liveness is decided the same way everywhere.
 */

function share(overrides: Partial<RunShare> = {}): RunShare {
  return {
    id: "shr_1",
    runId: "run_1",
    token: mintShareToken(),
    label: null,
    createdByUserId: "user_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    ...overrides,
  }
}

describe("token format", () => {
  test("a minted token parses", () => {
    for (let i = 0; i < 50; i++) {
      const token = mintShareToken()
      expect(shareTokenSchema.safeParse(token).success).toBe(true)
      expect(looksLikeShareToken(token)).toBe(true)
    }
  })

  test("tokens are unique", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintShareToken()))
    expect(seen.size).toBe(500)
  })

  test("near-misses are refused", () => {
    for (const bad of [
      "",
      "sce_share_",
      "sce_share_short",
      "sce_live_a1b2c3d4e5f6_x",
      `sce_share_${"a".repeat(31)}`,
      `sce_share_${"a".repeat(33)}`,
      // Path traversal and injection shapes, which is what an anonymous route
      // will actually be sent.
      "sce_share_../../etc/passwd",
      "sce_share_' OR 1=1--",
      `sce_share_${"a".repeat(5000)}`,
    ]) {
      expect(shareTokenSchema.safeParse(bad).success).toBe(false)
    }
  })

  test("the token carries no padding, so it survives a URL untouched", () => {
    for (let i = 0; i < 50; i++) {
      const token = mintShareToken()
      expect(token).not.toContain("=")
      expect(encodeURIComponent(token)).toBe(token)
    }
  })
})

describe("liveness", () => {
  const now = new Date("2026-06-15T00:00:00.000Z")

  test("a fresh share with no expiry is live", () => {
    expect(shareIsLive(share(), now)).toBe(true)
  })

  test("a revoked share is dead even if it has not expired", () => {
    expect(
      shareIsLive(
        share({ revokedAt: "2026-06-10T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z" }),
        now,
      ),
    ).toBe(false)
  })

  test("an expired share is dead", () => {
    expect(shareIsLive(share({ expiresAt: "2026-06-14T23:59:59.000Z" }), now)).toBe(false)
  })

  test("expiry is exclusive at the boundary", () => {
    expect(shareIsLive(share({ expiresAt: now.toISOString() }), now)).toBe(false)
  })
})

describe("urls", () => {
  test("a trailing slash on the origin does not produce a double slash", () => {
    const token = mintShareToken()
    expect(shareUrl("https://sce.example.com/", token)).toBe(
      `https://sce.example.com/share/${token}`,
    )
    expect(shareUrl("https://sce.example.com", token)).toBe(
      `https://sce.example.com/share/${token}`,
    )
  })
})
