import { describe, expect, test } from "bun:test"
import { Sce } from "./client.ts"
import type { FetchLike } from "./http.ts"
import {
  SceApiError,
  SceConfigError,
  SceConnectionError,
  SceResponseError,
  isSceApiError,
} from "./errors.ts"
import type { Run, RunSummary, V1Error } from "./vendor/shared.ts"

/**
 * The client, against a fetch we control.
 *
 * No network and no server: what is being tested is the *client's* judgement —
 * which failures it retries, which it does not, whether a refusal keeps its
 * machine-readable body, and whether a response that does not match its schema
 * is caught rather than handed to the caller with fields that quietly do not
 * exist. Those are the behaviours an integrator depends on and never sees.
 */

const BASE = "https://api.example.test"

const RUN: Run = {
  id: "run_1",
  createdByUserId: "user_1",
  prompt: "Why is the sky blue?",
  status: "QUEUED",
  error: null,
  totalLatencyMs: null,
  temperature: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  completedAt: null,
  deadlineAt: null,
  canceledAt: null,
  tags: [],
  candidates: [],
  synthesis: null,
}

const SUMMARY: RunSummary = {
  id: "run_1",
  createdByUserId: "user_1",
  prompt: "Why is the sky blue?",
  status: "COMPLETE",
  error: null,
  totalLatencyMs: 1_000,
  temperature: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  completedAt: "2026-09-05T10:00:01.000Z",
  deadlineAt: null,
  canceledAt: null,
  tags: [],
  candidateCount: 3,
  hasSynthesis: true,
  confidence: 0.9,
}

interface Call {
  url: string
  method: string
  headers: Headers
  body: string | null
}

/** A fetch that returns the given responses in order, recording every call. */
function stub(responses: readonly (() => Response)[]): {
  fetch: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  let index = 0

  const impl: FetchLike = async (input, init) => {
    const request = new Request(input, init)
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: init?.body === undefined || init.body === null ? null : String(init.body),
    })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next === undefined) throw new Error("no stubbed response")
    return next()
  }

  return { fetch: impl, calls }
}

function json(body: unknown, init: ResponseInit = {}): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    })
}

function client(fetchImpl: FetchLike, overrides: { maxRetries?: number } = {}): Sce {
  return new Sce({
    apiKey: "sce_test_key",
    baseUrl: BASE,
    fetch: fetchImpl,
    maxRetries: overrides.maxRetries ?? 2,
  })
}

describe("configuration", () => {
  test("the version prefix is appended when it is missing, and not doubled", async () => {
    for (const baseUrl of [BASE, `${BASE}/`, `${BASE}/v1`]) {
      const { fetch, calls } = stub([json({ ok: true, service: "sce", time: "now" })])
      await new Sce({ apiKey: "k", baseUrl, fetch }).health()
      expect(calls[0]?.url).toBe(`${BASE}/v1/health`)
    }
  })

  test("a missing key or a nonsense URL fails at construction, not at first call", () => {
    expect(() => new Sce({ apiKey: "  ", baseUrl: BASE })).toThrow(SceConfigError)
    expect(() => new Sce({ apiKey: "k", baseUrl: "not a url" })).toThrow(SceConfigError)
  })

  test("the credential travels as a bearer token", async () => {
    const { fetch, calls } = stub([json({ ok: true, service: "sce", time: "now" })])
    await client(fetch).health()
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sce_test_key")
  })
})

describe("refusals", () => {
  const quotaError: V1Error = {
    code: "quota_exceeded",
    message: "You have used 50 of 50 runs this month.",
    details: {
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
    },
    requestId: "req_1",
  }

  test("keep their machine-readable body", async () => {
    const { fetch } = stub([json(quotaError, { status: 429 })])

    // A quota refusal is not retried into oblivion: it is thrown on the first
    // response, because no amount of waiting inside one request will help.
    const caught = await client(fetch, { maxRetries: 0 })
      .runs.create({ prompt: "hello there" })
      .catch((error: unknown) => error)

    expect(isSceApiError(caught)).toBe(true)
    if (!(caught instanceof SceApiError)) return

    expect(caught.code).toBe("quota_exceeded")
    expect(caught.status).toBe(429)
    expect(caught.requestId).toBe("req_1")
    // The whole point of preserving `details`: a client can say "resets on the
    // 1st" instead of "429".
    expect(caught.details?.quota?.remaining).toBe(0)
  })

  test("a body that is not our envelope becomes a shape error, not a fake code", async () => {
    const { fetch } = stub([
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ])

    const caught = await client(fetch, { maxRetries: 0 })
      .usage()
      .catch((error: unknown) => error)

    // Not an `SceApiError`: there is no `code` to branch on, and pretending
    // otherwise would make every caller's error handling silently wrong.
    expect(caught).toBeInstanceOf(SceResponseError)
    expect(isSceApiError(caught)).toBe(false)
  })

  test("a 2xx that does not match its schema is caught rather than passed on", async () => {
    // The deployment is newer than the SDK, or a proxy rewrote the body. Either
    // way the caller must not receive an object whose fields do not exist.
    const { fetch } = stub([json({ id: "run_1" })])

    const caught = await client(fetch)
      .runs.retrieve("run_1")
      .catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(SceResponseError)
  })

  test("`Retry-After` is understood in both of its forms", async () => {
    for (const header of ["30", new Date(Date.now() + 30_000).toUTCString()]) {
      const { fetch } = stub([
        json({ code: "rate_limited", message: "slow down", requestId: "r" }, {
          status: 429,
          headers: { "retry-after": header },
        }),
      ])

      const caught = await client(fetch, { maxRetries: 0 })
        .usage()
        .catch((error: unknown) => error)

      expect(caught).toBeInstanceOf(SceApiError)
      if (!(caught instanceof SceApiError)) return
      // Both forms have to work: ours sends seconds, an intermediary may
      // rewrite it as a date, and a client that understands only one silently
      // ignores the other — which turns a polite retry into a hot loop.
      expect(caught.retryAfterSeconds).toBeGreaterThanOrEqual(29)
      expect(caught.retryAfterSeconds).toBeLessThanOrEqual(31)
    }
  })
})

describe("retries", () => {
  test("a 500 is retried and the eventual success is returned", async () => {
    const { fetch, calls } = stub([
      json({ code: "internal_error", message: "boom", requestId: "r" }, { status: 500 }),
      json({ ok: true, service: "sce", time: "now" }),
    ])

    const result = await client(fetch).health()

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test("a 400 is not retried, because it will fail identically", async () => {
    const { fetch, calls } = stub([
      json({ code: "validation_failed", message: "bad", requestId: "r" }, { status: 400 }),
    ])

    await client(fetch)
      .usage()
      .catch(() => undefined)

    expect(calls).toHaveLength(1)
  })

  test("a transport failure is retried, then surfaces as a connection error", async () => {
    let attempts = 0
    const impl: FetchLike = async () => {
      attempts += 1
      throw new TypeError("fetch failed")
    }

    const caught = await client(impl, { maxRetries: 1 })
      .health()
      .catch((error: unknown) => error)

    expect(attempts).toBe(2)
    expect(caught).toBeInstanceOf(SceConnectionError)
  })

  test("a write carries a generated Idempotency-Key, which is what makes it safe to retry", async () => {
    const { fetch, calls } = stub([
      json({ code: "internal_error", message: "boom", requestId: "r" }, { status: 500 }),
      json(RUN, { status: 201 }),
    ])

    await client(fetch).runs.create({ prompt: "hello there" })

    expect(calls).toHaveLength(2)
    const key = calls[0]?.headers.get("idempotency-key")
    expect(key).toBeTruthy()
    // The *same* key on the retry. A fresh one would make the second attempt a
    // second run, which is the exact failure the header exists to prevent.
    expect(calls[1]?.headers.get("idempotency-key")).toBe(key ?? "")
  })

  test("a caller's own key is used rather than a generated one", async () => {
    const { fetch, calls } = stub([json(RUN, { status: 201 })])
    await client(fetch).runs.create({ prompt: "hello there" }, { idempotencyKey: "mine-12345678" })
    expect(calls[0]?.headers.get("idempotency-key")).toBe("mine-12345678")
  })
})

describe("rate limits", () => {
  test("are reported on success, so a batch can pace itself before being refused", async () => {
    const seen: number[] = []
    const { fetch } = stub([
      json(
        { ok: true, service: "sce", time: "now" },
        {
          headers: {
            "x-ratelimit-limit": "20",
            "x-ratelimit-remaining": "3",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
          },
        },
      ),
    ])

    const sce = new Sce({
      apiKey: "k",
      baseUrl: BASE,
      fetch,
      onRateLimit: (state) => {
        seen.push(state.remaining)
      },
    })
    await sce.health()

    expect(seen).toEqual([3])
    expect(sce.rateLimit?.limit).toBe(20)
    expect(sce.rateLimit?.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe("pagination", () => {
  test("listAll walks every page and stops", async () => {
    const { fetch, calls } = stub([
      json({ data: [SUMMARY], nextCursor: "run_1", hasMore: true }),
      json({ data: [{ ...SUMMARY, id: "run_2" }], nextCursor: null, hasMore: false }),
    ])

    const seen: string[] = []
    for await (const run of client(fetch).runs.listAll({ limit: 1 })) seen.push(run.id)

    expect(seen).toEqual(["run_1", "run_2"])
    // The second request carries the first page's cursor — the property that
    // makes this a walk rather than an infinite loop over page one.
    expect(calls[1]?.url).toContain("cursor=run_1")
  })
})

describe("ask", () => {
  /**
   * An SSE body, framed the way the server frames one — one chunk per entry, so
   * a test can put a frame boundary wherever it likes.
   *
   * The bytes are copied into a plain `ArrayBuffer` because `TextEncoder`
   * returns `Uint8Array<ArrayBufferLike>`, which a `BodyInit` will not accept:
   * it might be a `SharedArrayBuffer`. Naming the narrow type is what keeps
   * this free of an assertion.
   */
  function eventStream(frames: readonly string[]): () => Response {
    const bytes = (text: string): Uint8Array<ArrayBuffer> => {
      const encoded = new TextEncoder().encode(text)
      const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength))
      copy.set(encoded)
      return copy
    }

    return () =>
      new Response(
        new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            for (const frame of frames) controller.enqueue(bytes(frame))
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
  }

  test("creates, follows, and resolves with the finished run", async () => {
    const completed: Run = { ...RUN, status: "COMPLETE", totalLatencyMs: 1_000 }

    const { fetch, calls } = stub([
      json(RUN, { status: 201 }),
      eventStream([
        `event: candidate.delta\ndata: {"type":"candidate.delta","runId":"run_1","candidateId":"c1","text":"Sun"}\n\n`,
        `event: candidate.delta\ndata: {"type":"candidate.delta","runId":"run_1","candidateId":"c1","text":"light"}\n\n`,
        `event: run.completed\nid: 9\ndata: {"type":"run.completed","runId":"run_1","totalLatencyMs":1000}\n\n`,
      ]),
      json(completed),
    ])

    const deltas: string[] = []
    // An array rather than a `let`, because TypeScript narrows a variable
    // assigned only inside a callback to its initial type — which would make
    // the assertion below a compile error about comparing a string to null.
    const announced: string[] = []

    const run = await client(fetch).ask("Why is the sky blue?", {
      onRunCreated: (runId) => {
        announced.push(runId)
      },
      onDelta: ({ text }) => {
        deltas.push(text)
      },
    })

    expect(announced).toEqual(["run_1"])
    expect(deltas.join("")).toBe("Sunlight")
    // Re-fetched rather than reconstructed from the events: the events describe
    // transitions and the final object is the authority.
    expect(run.status).toBe("COMPLETE")
    expect(calls).toHaveLength(3)
    expect(calls[1]?.url).toContain("/runs/run_1/events")
  })

  test("a run that was already finished is not followed", async () => {
    // The idempotent-replay case: an earlier identical request produced this
    // run, and there is no stream left to open.
    const { fetch, calls } = stub([json({ ...RUN, status: "COMPLETE" }, { status: 200 })])

    const run = await client(fetch).ask({ prompt: "Why is the sky blue?" })

    expect(run.status).toBe("COMPLETE")
    expect(calls).toHaveLength(1)
  })

  test("a frame split across chunks is decoded once, not twice", async () => {
    const { fetch } = stub([
      json(RUN, { status: 201 }),
      eventStream([
        `event: run.completed\nid: 9\ndata: {"type":"run.compl`,
        `eted","runId":"run_1","totalLatencyMs":1000}\n\n`,
      ]),
      json({ ...RUN, status: "COMPLETE" }),
    ])

    const events: string[] = []
    await client(fetch).ask("Why is the sky blue?", {
      onEvent: (event) => {
        events.push(event.type)
      },
    })

    // One TCP read can carry half a frame. Anything that parses per chunk works
    // perfectly on localhost and corrupts under real latency.
    expect(events).toEqual(["run.completed"])
  })
})
