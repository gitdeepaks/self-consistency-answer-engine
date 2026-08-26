import { describe, expect, test } from "bun:test"
import {
  apiKeySecretMatches,
  hashApiKeySecret,
  looksLikeApiKey,
  maskApiKey,
  mintApiKey,
  parseApiKey,
} from "./apikey.ts"

/**
 * The credential format.
 *
 * These are cheap tests guarding an expensive failure: every one of them is
 * about a way a valid key could be rejected or an invalid one accepted, and
 * both of those are outages.
 */

describe("api key format", () => {
  test("a minted key round-trips through the parser", () => {
    const minted = mintApiKey("live")
    const parsed = parseApiKey(minted.token)

    expect(parsed).not.toBeNull()
    expect(parsed?.prefix).toBe(minted.prefix)
    expect(parsed?.secret).toBe(minted.secret)
    expect(parsed?.environment).toBe("live")
  })

  /**
   * The regression that made this file exist.
   *
   * base64url's alphabet ends in `-` and `_`, so a large fraction of secrets
   * contain an underscore. An earlier parser split the token on `_` and
   * truncated exactly those, rejecting perfectly valid keys perhaps half the
   * time — the failure rate that looks like flakiness rather than a bug.
   */
  test("a secret containing _ and - parses whole", () => {
    const secret = "NQLV3I8pFTts4Xiz5MIDiiczRgWJV9_r8inw9Xr-cUE"
    expect(secret).toHaveLength(43)

    const parsed = parseApiKey(`sce_test_91421ac7a66e_${secret}`)
    expect(parsed?.secret).toBe(secret)
    expect(parsed?.prefix).toBe("sce_test_91421ac7a66e")
  })

  test("every minted key parses, whatever randomness it drew", () => {
    // 200 draws makes a secret containing `_` or `-` a near-certainty, so this
    // fails loudly rather than intermittently if the parser regresses again.
    for (let i = 0; i < 200; i++) {
      const minted = mintApiKey("test")
      expect(parseApiKey(minted.token)?.secret).toBe(minted.secret)
    }
  })

  test.each([
    ["empty", ""],
    ["another vendor's key", "sk_live_91421ac7a66e_" + "a".repeat(43)],
    ["unknown environment", "sce_staging_91421ac7a66e_" + "a".repeat(43)],
    ["public id too short", "sce_live_91421ac7a66_" + "a".repeat(43)],
    ["public id not hex", "sce_live_91421ac7a66z_" + "a".repeat(43)],
    ["secret too short", "sce_live_91421ac7a66e_" + "a".repeat(42)],
    ["secret too long", "sce_live_91421ac7a66e_" + "a".repeat(44)],
    ["secret has an illegal character", "sce_live_91421ac7a66e_" + "a".repeat(42) + "!"],
    ["prefix only", "sce_live_91421ac7a66e"],
    ["absurdly long", "sce_live_91421ac7a66e_" + "a".repeat(5000)],
  ])("rejects %s", (_label, token) => {
    expect(parseApiKey(token)).toBeNull()
  })

  test("looksLikeApiKey routes ours here and everyone else's to Clerk", () => {
    expect(looksLikeApiKey(mintApiKey().token)).toBe(true)
    // A Clerk session JWT must not be mistaken for a key, or it would be
    // refused locally instead of being verified upstream.
    expect(looksLikeApiKey("eyJhbGciOiJSUzI1NiIsImtpZCI6Imluc18x")).toBe(false)
  })
})

describe("api key verification", () => {
  test("the stored hash accepts the real secret and nothing else", () => {
    const minted = mintApiKey()

    expect(apiKeySecretMatches(minted.secret, minted.hash)).toBe(true)
    expect(apiKeySecretMatches(`${minted.secret}x`, minted.hash)).toBe(false)
    expect(apiKeySecretMatches(mintApiKey().secret, minted.hash)).toBe(false)
  })

  test("a corrupt or empty stored hash matches nothing", () => {
    const minted = mintApiKey()
    expect(apiKeySecretMatches(minted.secret, "")).toBe(false)
    expect(apiKeySecretMatches(minted.secret, "not-hex")).toBe(false)
    // Truncated digest: a length mismatch must fail rather than compare a prefix.
    expect(apiKeySecretMatches(minted.secret, minted.hash.slice(0, 32))).toBe(false)
  })

  test("hashing is deterministic and does not echo the secret", () => {
    const minted = mintApiKey()
    expect(hashApiKeySecret(minted.secret)).toBe(minted.hash)
    expect(minted.hash).toHaveLength(64)
    expect(minted.hash).not.toContain(minted.secret)
  })

  test("two keys minted in the same millisecond are different", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintApiKey().token))
    expect(tokens.size).toBe(50)
  })
})

describe("display", () => {
  test("a masked key shows the prefix and no secret", () => {
    const minted = mintApiKey()
    const masked = maskApiKey(minted.prefix)

    expect(masked.startsWith(minted.prefix)).toBe(true)
    expect(masked).not.toContain(minted.secret)
  })
})
