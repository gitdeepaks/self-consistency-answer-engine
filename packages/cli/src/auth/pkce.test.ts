import { createHash } from "node:crypto"
import { afterAll, describe, expect, test } from "bun:test"
import {
  authorizationUrl,
  createPkcePair,
  createState,
  discover,
  exchangeCode,
  refreshTokens,
  statesMatch,
  type AuthorizationServer,
} from "./pkce.ts"
import { startLoopback } from "./loopback.ts"

/**
 * The OAuth 2.0 authorization-code + PKCE flow.
 *
 * Tested against a stub authorization server rather than Clerk, because what
 * needs proving is *our* half of the protocol: that the challenge really is the
 * SHA-256 of the verifier, that a mismatched `state` aborts, that the loopback
 * listener hands back the code exactly once, and that a refresh keeps a
 * non-rotating refresh token. None of that needs a real identity provider, and
 * all of it needs to work offline in CI.
 */

/* ------------------------------------------------ a stub authorization server */

interface StubServer {
  origin: string
  discoveryUrl: string
  /** Verifier presented at the token endpoint on the last exchange. */
  lastVerifier: string | null
  /** Set when the client sent a redirect_uri that did not match the code's. */
  rejected: string | null
  stop: () => void
}

function startStubServer(options: { rotateRefreshToken?: boolean } = {}): StubServer {
  const state: StubServer = {
    origin: "",
    discoveryUrl: "",
    lastVerifier: null,
    rejected: null,
    stop: () => {},
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: state.origin,
          authorization_endpoint: `${state.origin}/oauth/authorize`,
          token_endpoint: `${state.origin}/oauth/token`,
          code_challenge_methods_supported: ["S256"],
        })
      }

      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(await request.text())
        const grant = body.get("grant_type")

        if (grant === "authorization_code") {
          state.lastVerifier = body.get("code_verifier")
          if (body.get("code") !== "the-code") {
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          return Response.json({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-1",
            scope: "runs:read runs:write",
          })
        }

        if (grant === "refresh_token") {
          return Response.json({
            access_token: "access-2",
            token_type: "Bearer",
            expires_in: 3600,
            // A non-rotating server returns no new refresh token; the client
            // has to keep the old one or it logs itself out.
            ...(options.rotateRefreshToken === true ? { refresh_token: "refresh-2" } : {}),
          })
        }

        return Response.json({ error: "unsupported_grant_type" }, { status: 400 })
      }

      return new Response("not found", { status: 404 })
    },
  })

  state.origin = `http://127.0.0.1:${server.port}`
  state.discoveryUrl = `${state.origin}/.well-known/oauth-authorization-server`
  state.stop = () => void server.stop(true)
  return state
}

const stub = startStubServer()
afterAll(() => {
  stub.stop()
})

/* --------------------------------------------------------------------- tests */

describe("pkce", () => {
  test("the challenge is the S256 hash of the verifier", () => {
    const { verifier, challenge } = createPkcePair()

    // Recomputed independently: this is the one property the whole exchange
    // rests on, so it is checked against the definition rather than the code.
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
  })

  test("the verifier is within RFC 7636's length range and URL-safe", () => {
    const { verifier } = createPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test("every login draws fresh values", () => {
    const pairs = Array.from({ length: 50 }, () => createPkcePair().verifier)
    const states = Array.from({ length: 50 }, () => createState())
    expect(new Set(pairs).size).toBe(50)
    expect(new Set(states).size).toBe(50)
  })

  test("state comparison accepts the echo and rejects everything else", () => {
    const state = createState()
    expect(statesMatch(state, state)).toBe(true)
    expect(statesMatch(state, `${state}x`)).toBe(false)
    expect(statesMatch(state, "")).toBe(false)
    expect(statesMatch(state, createState())).toBe(false)
  })
})

describe("discovery", () => {
  test("reads the endpoints from the metadata document", async () => {
    const server = await discover(stub.discoveryUrl)
    expect(server.authorizationEndpoint).toBe(`${stub.origin}/oauth/authorize`)
    expect(server.tokenEndpoint).toBe(`${stub.origin}/oauth/token`)
  })

  test("refuses a server that cannot do S256", async () => {
    const weak = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          issuer: "http://example.test",
          authorization_endpoint: "http://example.test/authorize",
          token_endpoint: "http://example.test/token",
          // Advertising only `plain` would let an interceptor replay the code.
          code_challenge_methods_supported: ["plain"],
        }),
    })

    await expect(discover(`http://127.0.0.1:${weak.port}/meta`)).rejects.toThrow(/S256/)
    await weak.stop(true)
  })

  test("a metadata document missing an endpoint is refused", async () => {
    const broken = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ issuer: "http://example.test" }),
    })

    await expect(discover(`http://127.0.0.1:${broken.port}/meta`)).rejects.toThrow(/not usable/)
    await broken.stop(true)
  })
})

describe("authorization url", () => {
  const server: AuthorizationServer = {
    issuer: "https://clerk.example.com",
    authorizationEndpoint: "https://clerk.example.com/oauth/authorize",
    tokenEndpoint: "https://clerk.example.com/oauth/token",
    revocationEndpoint: null,
  }

  test("carries every parameter the flow depends on", () => {
    const url = new URL(
      authorizationUrl({
        server,
        clientId: "client_123",
        redirectUri: "http://127.0.0.1:54321/callback",
        challenge: "the-challenge",
        state: "the-state",
        scopes: ["runs:read", "runs:write"],
      }),
    )

    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client_123")
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("the-state")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback")

    const scope = url.searchParams.get("scope") ?? ""
    // Without `offline_access` the CLI would need a browser again the moment
    // the access token expires.
    expect(scope).toContain("offline_access")
    expect(scope).toContain("runs:read")
  })

  test("the verifier is never put in the URL", () => {
    const pkce = createPkcePair()
    const url = authorizationUrl({
      server,
      clientId: "client_123",
      redirectUri: "http://127.0.0.1:1/callback",
      challenge: pkce.challenge,
      state: "s",
      scopes: [],
    })
    expect(url).not.toContain(pkce.verifier)
  })
})

describe("loopback listener", () => {
  test("binds to loopback on an ephemeral port", () => {
    const loopback = startLoopback("state")
    try {
      const url = new URL(loopback.redirectUri)
      // RFC 8252 §7.3: the literal address, never the `localhost` name.
      expect(url.hostname).toBe("127.0.0.1")
      expect(Number(url.port)).toBeGreaterThan(0)
      expect(url.pathname).toBe("/callback")
    } finally {
      loopback.close()
    }
  })

  test("hands back a code whose state matches", async () => {
    const state = createState()
    const loopback = startLoopback(state)

    try {
      const response = await fetch(
        `${loopback.redirectUri}?code=the-code&state=${encodeURIComponent(state)}`,
      )
      expect(response.status).toBe(200)
      expect(await loopback.waitForCode()).toMatchObject({ code: "the-code" })
    } finally {
      loopback.close()
    }
  })

  test("refuses a callback whose state does not match", async () => {
    const loopback = startLoopback(createState())

    try {
      // Any local process can hit the loopback port; without the state check it
      // could inject a code this CLI would then redeem as its own.
      await fetch(`${loopback.redirectUri}?code=injected&state=wrong`)
      await expect(loopback.waitForCode()).rejects.toThrow(/state did not match/)
    } finally {
      loopback.close()
    }
  })

  test("surfaces a refusal from the authorization server", async () => {
    const state = createState()
    const loopback = startLoopback(state)

    try {
      await fetch(
        `${loopback.redirectUri}?error=access_denied&error_description=User+said+no&state=${state}`,
      )
      await expect(loopback.waitForCode()).rejects.toThrow(/User said no/)
    } finally {
      loopback.close()
    }
  })
})

describe("token exchange", () => {
  test("redeems a code and presents the verifier", async () => {
    const server = await discover(stub.discoveryUrl)
    const pkce = createPkcePair()

    const tokens = await exchangeCode({
      server,
      clientId: "client_123",
      code: "the-code",
      verifier: pkce.verifier,
      redirectUri: "http://127.0.0.1:1/callback",
      scopes: ["runs:read", "runs:write"],
    })

    expect(stub.lastVerifier).toBe(pkce.verifier)
    expect(tokens.accessToken).toBe("access-1")
    expect(tokens.refreshToken).toBe("refresh-1")
    expect(tokens.scopes).toEqual(["runs:read", "runs:write"])
  })

  test("expires_in becomes an absolute instant", async () => {
    const server = await discover(stub.discoveryUrl)
    const tokens = await exchangeCode({
      server,
      clientId: "client_123",
      code: "the-code",
      verifier: createPkcePair().verifier,
      redirectUri: "http://127.0.0.1:1/callback",
      scopes: [],
    })

    // A relative lifetime is unusable five minutes later; storing the instant
    // is what makes the refresh check survive a laptop suspend.
    const expiresAt = Date.parse(tokens.expiresAt ?? "")
    expect(Number.isNaN(expiresAt)).toBe(false)
    expect(expiresAt).toBeGreaterThan(Date.now())
  })

  test("a rejected code produces a readable error", async () => {
    const server = await discover(stub.discoveryUrl)
    await expect(
      exchangeCode({
        server,
        clientId: "client_123",
        code: "wrong-code",
        verifier: createPkcePair().verifier,
        redirectUri: "http://127.0.0.1:1/callback",
        scopes: [],
      }),
    ).rejects.toThrow(/invalid_grant/)
  })
})

describe("refresh", () => {
  test("keeps the existing refresh token when the server does not rotate", async () => {
    const server = await discover(stub.discoveryUrl)
    const refreshed = await refreshTokens({
      server,
      clientId: "client_123",
      refreshToken: "refresh-1",
      scopes: ["runs:read"],
    })

    expect(refreshed.accessToken).toBe("access-2")
    // Dropping this is how a CLI mysteriously logs itself out after an hour.
    expect(refreshed.refreshToken).toBe("refresh-1")
  })

  test("takes the new refresh token when the server rotates", async () => {
    const rotating = startStubServer({ rotateRefreshToken: true })
    try {
      const server = await discover(rotating.discoveryUrl)
      const refreshed = await refreshTokens({
        server,
        clientId: "client_123",
        refreshToken: "refresh-1",
        scopes: [],
      })
      expect(refreshed.refreshToken).toBe("refresh-2")
    } finally {
      rotating.stop()
    }
  })
})
