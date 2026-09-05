import { z } from "zod"
import { SceConfigError, SceTimeoutError } from "./errors.ts"
import { Http, newIdempotencyKey, type FetchLike, type RequestOptions } from "./http.ts"
import {
  cursorPageSchema,
  isTerminalEvent,
  readRunEventStream,
  runSchema,
  runShareSchema,
  runSearchToParams,
  runSummarySchema,
  usageSummarySchema,
  webhookDeliverySchema,
  webhookEndpointCreatedSchema,
  webhookEndpointSchema,
  providerHealthSchema,
  type AskInput,
  type CreateShareInput,
  type CreateWebhookEndpointInput,
  type CursorPage,
  type RateLimitState,
  type Run,
  type RunEvent,
  type RunSearchQuery,
  type RunShare,
  type RunSummary,
  type StreamedRunEvent,
  type UsageSummary,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
} from "./vendor/shared.ts"

/**
 * The client.
 *
 * Shaped around the one thing that makes this API different from a CRUD
 * service: **a run is asynchronous and takes minutes**. Everything else follows
 * from that.
 *
 *   - `runs.create()` returns as soon as the run is queued, which is what the
 *     API does and what a caller building a job pipeline wants.
 *   - `runs.stream()` is an async iterator over the run's events, so following
 *     a run is a `for await` rather than a callback tree.
 *   - `ask()` is the one-liner: create, follow, resolve with the finished run.
 *     It is what most integrations actually want and what a quickstart should
 *     be able to show in five lines.
 *
 * Every response is parsed against the same Zod schema the server validated it
 * with. That is not belt-and-braces: it is what makes the returned types a
 * guarantee rather than a claim, and it turns "this deployment is newer than
 * your SDK" into a clear error instead of a property that is quietly undefined.
 */

export interface SceOptions {
  /**
   * `sce_live_…`, from Settings → API keys.
   *
   * Read it from the environment; never commit one. A key carries scopes, and a
   * key with only `runs:read` cannot start a run — the API says so with a 403
   * and `code: "forbidden"` rather than failing obscurely.
   */
  apiKey: string

  /**
   * Where the API lives, with or without the `/v1` suffix.
   *
   * Required, and deliberately so: this is a product you deploy, not a hosted
   * service with one address, and a default pointing at somebody else's
   * hostname would be a footgun aimed at whoever forgot to override it.
   */
  baseUrl: string

  /** Attempts after the first, for requests that are safe to repeat. */
  maxRetries?: number
  /** Per-attempt wall-clock budget. The stream has no timeout; it is a stream. */
  timeoutMs?: number
  /** Injectable for tests, proxies and runtimes with an unusual global. */
  fetch?: FetchLike
  /** Appended to the User-Agent, so your traffic is identifiable in our logs. */
  appName?: string
  /** Called whenever the API reports a budget, on success as well as on a 429. */
  onRateLimit?: (state: RateLimitState) => void
}

const SDK_VERSION = "0.1.0"

const deletedSchema = z.object({ deleted: z.literal(true), id: z.string() })
const tagsSchema = z.object({ tags: z.array(z.string()) })
const cancelSchema = z.object({ run: runSchema, canceled: z.boolean() })
const providersSchema = z.object({
  panel: z.array(providerHealthSchema),
  evaluator: providerHealthSchema.extend({ role: z.literal("evaluator") }),
})
const healthSchema = z.object({ ok: z.literal(true), service: z.string(), time: z.string() })

const runPageSchema = cursorPageSchema(runSummarySchema)
const sharePageSchema = cursorPageSchema(runShareSchema)
const endpointPageSchema = cursorPageSchema(webhookEndpointSchema)
const deliveryPageSchema = cursorPageSchema(webhookDeliverySchema)

/** What `ask()` reports while a run is in flight. Every callback is optional. */
export interface AskHooks {
  /** A chunk of one candidate's answer, as it is generated. */
  onDelta?: (delta: { candidateId: string; text: string }) => void
  /** Any event at all, for a caller that wants the raw timeline. */
  onEvent?: (event: RunEvent) => void
  /** The run id, as soon as it exists — before the first token. */
  onRunCreated?: (runId: string) => void
}

export interface AskOptions extends RequestOptions, AskHooks {}

export class Sce {
  readonly #http: Http
  #rateLimit: RateLimitState | null = null

  constructor(options: SceOptions) {
    if (options.apiKey.trim() === "") {
      throw new SceConfigError("An API key is required. Create one under Settings → API keys.")
    }

    let baseUrl: string
    try {
      baseUrl = new URL(options.baseUrl).toString().replace(/\/+$/, "")
    } catch {
      throw new SceConfigError(`baseUrl is not a URL: ${options.baseUrl}`)
    }
    // Accepted with or without the version suffix, because both are what people
    // type. Appending it here means one obvious mistake cannot produce a stream
    // of 404s that look like a broken deployment.
    if (!baseUrl.endsWith("/v1")) baseUrl = `${baseUrl}/v1`

    const fetchImpl: FetchLike | undefined = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== "function") {
      throw new SceConfigError(
        "No global fetch in this runtime. Pass one as `fetch` (Node 18+, Bun, Deno and " +
          "browsers all have it built in).",
      )
    }

    this.#http = new Http({
      baseUrl,
      apiKey: options.apiKey,
      fetch: fetchImpl,
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 30_000,
      userAgent:
        options.appName === undefined
          ? `sce-sdk/${SDK_VERSION}`
          : `sce-sdk/${SDK_VERSION} (${options.appName})`,
      onRateLimit: (state) => {
        this.#rateLimit = state
        options.onRateLimit?.(state)
      },
    })
  }

  /**
   * The most recent budget the API reported, or null before the first request.
   *
   * Read it to pace a batch job: the headers arrive on every response, so a
   * caller can slow down before being refused rather than after.
   */
  get rateLimit(): RateLimitState | null {
    return this.#rateLimit
  }

  /* ------------------------------------------------------------ meta */

  async health(options: RequestOptions = {}): Promise<z.infer<typeof healthSchema>> {
    return this.#http.request({ method: "GET", path: "/health", options }, healthSchema)
  }

  /** Which panel members are reachable from this deployment right now. */
  async providers(options: RequestOptions = {}): Promise<z.infer<typeof providersSchema>> {
    return this.#http.request({ method: "GET", path: "/providers", options }, providersSchema)
  }

  /** This month's spend, the plan's ceilings, and how close each one is. */
  async usage(options: RequestOptions = {}): Promise<UsageSummary> {
    return this.#http.request({ method: "GET", path: "/usage", options }, usageSummarySchema)
  }

  /* ------------------------------------------------------------ runs */

  readonly runs = {
    /**
     * Start a run. Returns as soon as it is queued, not when it is answered.
     *
     * An `Idempotency-Key` is generated when the caller does not supply one, so
     * a retry after a network timeout replays the original response instead of
     * fanning out — and paying for — a second panel. Pass your own when the
     * retry might come from a different process.
     */
    create: async (input: AskInput, options: RequestOptions = {}): Promise<Run> =>
      this.#http.request(
        {
          method: "POST",
          path: "/runs",
          body: input,
          options: { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
        },
        runSchema,
      ),

    retrieve: async (runId: string, options: RequestOptions = {}): Promise<Run> =>
      this.#http.request(
        { method: "GET", path: `/runs/${encodeURIComponent(runId)}`, options },
        runSchema,
      ),

    list: async (
      query: Partial<RunSearchQuery> = {},
      options: RequestOptions = {},
    ): Promise<CursorPage<RunSummary>> =>
      this.#http.request(
        { method: "GET", path: "/runs", query: runSearchToParams(query), options },
        runPageSchema,
      ),

    /**
     * Every run matching a query, paged through automatically.
     *
     * A generator rather than an array, because "every run" is unbounded and a
     * convenience method that quietly loads a hundred thousand rows into memory
     * is not a convenience.
     */
    listAll: async function* (
      this: Sce,
      query: Partial<RunSearchQuery> = {},
      options: RequestOptions = {},
    ): AsyncGenerator<RunSummary> {
      let cursor: string | undefined = query.cursor
      for (;;) {
        const page: CursorPage<RunSummary> = await this.runs.list(
          { ...query, ...(cursor === undefined ? {} : { cursor }) },
          options,
        )
        for (const run of page.data) yield run
        if (!page.hasMore || page.nextCursor === null) return
        cursor = page.nextCursor
      }
    }.bind(this),

    cancel: async (
      runId: string,
      reason?: string,
      options: RequestOptions = {},
    ): Promise<z.infer<typeof cancelSchema>> =>
      this.#http.request(
        {
          method: "POST",
          path: `/runs/${encodeURIComponent(runId)}/cancel`,
          body: reason === undefined ? {} : { reason },
          options: { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
        },
        cancelSchema,
      ),

    delete: async (runId: string, options: RequestOptions = {}): Promise<void> => {
      await this.#http.request(
        { method: "DELETE", path: `/runs/${encodeURIComponent(runId)}`, options },
        deletedSchema,
      )
    },

    setTags: async (
      runId: string,
      tags: readonly string[],
      options: RequestOptions = {},
    ): Promise<string[]> => {
      const result = await this.#http.request(
        {
          method: "PUT",
          path: `/runs/${encodeURIComponent(runId)}/tags`,
          body: { tags },
          options,
        },
        tagsSchema,
      )
      return result.tags
    },

    /**
     * Follow a run's progress.
     *
     * An async iterator over decoded, schema-parsed events, resumable from a
     * cursor. `afterSeq` is what a caller passes after a disconnect — every
     * durable event carries its sequence number, so a reconnect replays exactly
     * what was missed rather than the whole run.
     *
     * The stream is read with an explicit `Authorization` header rather than
     * through `EventSource`, which cannot send one, cannot be aborted cleanly
     * and chooses its own resume point.
     */
    stream: (
      runId: string,
      options: RequestOptions & { afterSeq?: number } = {},
    ): AsyncGenerator<StreamedRunEvent> => this.#stream(runId, options),
  }

  async *#stream(
    runId: string,
    options: RequestOptions & { afterSeq?: number },
  ): AsyncGenerator<StreamedRunEvent> {
    const query = new URLSearchParams()
    if (options.afterSeq !== undefined) query.set("afterSeq", String(options.afterSeq))

    const response = await this.#http.send({
      method: "GET",
      path: `/runs/${encodeURIComponent(runId)}/events`,
      query,
      options: {
        ...options,
        // A run can take minutes; the per-request timeout would abort the
        // stream halfway through. The caller's own `signal` is the way out, and
        // the server sends `ping` frames so a dead connection is still noticed.
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
    })

    if (response.body === null) {
      throw new SceTimeoutError("The event stream closed before it delivered anything")
    }

    yield* readRunEventStream(response.body)
  }

  /**
   * Ask a question and wait for the answer.
   *
   * The convenience method, and the one a quickstart shows: it creates the run,
   * follows its stream, reports progress through the callbacks and resolves
   * with the finished run.
   *
   * The run is fetched again at the end rather than assembled from the events,
   * because the events describe *transitions* and the final object is the
   * authority — and because a client that reconstructs state from a stream is a
   * client that disagrees with the API the first time an event is added.
   *
   * Aborting via `signal` stops the stream *and* cancels the run, so a user
   * closing a tab stops paying for tokens rather than merely stopping watching.
   */
  async ask(input: AskInput | string, options: AskOptions = {}): Promise<Run> {
    const ask: AskInput = typeof input === "string" ? { prompt: input } : input
    const created = await this.runs.create(ask, options)
    options.onRunCreated?.(created.id)

    // A run that was already finished when we created it — an idempotent replay
    // of an earlier request — has nothing to follow.
    if (created.status === "COMPLETE" || created.status === "FAILED" || created.status === "CANCELED") {
      return created
    }

    try {
      for await (const { event } of this.runs.stream(created.id, options)) {
        options.onEvent?.(event)
        if (event.type === "candidate.delta") {
          options.onDelta?.({ candidateId: event.candidateId, text: event.text })
        }
        if (isTerminalEvent(event)) break
      }
    } catch (error: unknown) {
      // The caller gave up. Cancelling is the courteous half of that: without
      // it the panel keeps generating, and keeps costing, for a result nobody
      // is waiting for.
      if (options.signal?.aborted === true) {
        await this.runs.cancel(created.id, "Abandoned by the client").catch(() => {})
      }
      throw error
    }

    return this.runs.retrieve(created.id, options)
  }

  /* ---------------------------------------------------------- shares */

  readonly shares = {
    create: async (
      runId: string,
      input: CreateShareInput = {},
      options: RequestOptions = {},
    ): Promise<RunShare> =>
      this.#http.request(
        {
          method: "POST",
          path: `/runs/${encodeURIComponent(runId)}/shares`,
          body: input,
          options: { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
        },
        runShareSchema,
      ),

    listForRun: async (
      runId: string,
      options: RequestOptions = {},
    ): Promise<CursorPage<RunShare>> =>
      this.#http.request(
        { method: "GET", path: `/runs/${encodeURIComponent(runId)}/shares`, options },
        sharePageSchema,
      ),

    list: async (
      query: { limit?: number } = {},
      options: RequestOptions = {},
    ): Promise<CursorPage<RunShare>> =>
      this.#http.request(
        { method: "GET", path: "/shares", query: toQuery(query), options },
        sharePageSchema,
      ),

    revoke: async (shareId: string, options: RequestOptions = {}): Promise<void> => {
      await this.#http.request(
        { method: "DELETE", path: `/shares/${encodeURIComponent(shareId)}`, options },
        deletedSchema,
      )
    },
  }

  /* -------------------------------------------------------- webhooks */

  readonly webhooks = {
    /**
     * Register a receiver.
     *
     * The returned `secret` appears once. Store it before you do anything else
     * with the result — there is no second chance, by design, and a receiver
     * that does not verify signatures accepts events from anyone who read the
     * documentation.
     */
    create: async (
      input: CreateWebhookEndpointInput,
      options: RequestOptions = {},
    ): Promise<WebhookEndpointCreated> =>
      this.#http.request(
        {
          method: "POST",
          path: "/webhooks/endpoints",
          body: input,
          options: { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
        },
        webhookEndpointCreatedSchema,
      ),

    list: async (
      query: { limit?: number; cursor?: string } = {},
      options: RequestOptions = {},
    ): Promise<CursorPage<WebhookEndpoint>> =>
      this.#http.request(
        { method: "GET", path: "/webhooks/endpoints", query: toQuery(query), options },
        endpointPageSchema,
      ),

    retrieve: async (endpointId: string, options: RequestOptions = {}): Promise<WebhookEndpoint> =>
      this.#http.request(
        { method: "GET", path: `/webhooks/endpoints/${encodeURIComponent(endpointId)}`, options },
        webhookEndpointSchema,
      ),

    delete: async (endpointId: string, options: RequestOptions = {}): Promise<void> => {
      await this.#http.request(
        {
          method: "DELETE",
          path: `/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
          options,
        },
        deletedSchema,
      )
    },

    /** Put an endpoint disabled by repeated failures back into rotation. */
    enable: async (endpointId: string, options: RequestOptions = {}): Promise<WebhookEndpoint> =>
      this.#http.request(
        {
          method: "POST",
          path: `/webhooks/endpoints/${encodeURIComponent(endpointId)}/enable`,
          options,
        },
        webhookEndpointSchema,
      ),

    /**
     * The delivery log: what we sent, and what your server said back.
     *
     * The first place to look when an integration is not firing, and the reason
     * that question does not have to become a support ticket.
     */
    deliveries: async (
      query: {
        limit?: number
        cursor?: string
        endpointId?: string
        status?: WebhookDeliveryStatus
      } = {},
      options: RequestOptions = {},
    ): Promise<CursorPage<WebhookDelivery>> =>
      this.#http.request(
        { method: "GET", path: "/webhooks/deliveries", query: toQuery(query), options },
        deliveryPageSchema,
      ),

    delivery: async (deliveryId: string, options: RequestOptions = {}): Promise<WebhookDelivery> =>
      this.#http.request(
        { method: "GET", path: `/webhooks/deliveries/${encodeURIComponent(deliveryId)}`, options },
        webhookDeliverySchema,
      ),

    /** Re-send an event with its original id, so receivers can deduplicate. */
    replay: async (deliveryId: string, options: RequestOptions = {}): Promise<WebhookDelivery> =>
      this.#http.request(
        {
          method: "POST",
          path: `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
          options: { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
        },
        webhookDeliverySchema,
      ),
  }
}

/** Turn a sparse options object into a query string, dropping absent values. */
function toQuery(input: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params
}
