import { errorFacts, type ProviderId } from "@sce/shared";
import { breakerKey, redis } from "@sce/queue";
import { z } from "zod";
import { workerConfig } from "./env.ts";

/**
 * Keeping one sick provider from taking the panel down with it.
 *
 * Three mechanisms, each answering a different failure:
 *
 *   - **Bulkhead** — a bounded number of concurrent calls per provider, so a
 *     provider that has started answering in 90 seconds instead of 5 cannot
 *     occupy every worker slot and starve the two providers that are healthy.
 *   - **Circuit breaker** — after N consecutive failures the provider is
 *     skipped outright for a cooldown. Retrying against a service that is down
 *     is not resilience; it is a slower way to fail, paid for in latency and,
 *     when the call is metered, in money.
 *   - **Retry classification** — a 429 or a 503 is worth another attempt; a 400
 *     or a 401 will fail identically forever, and retrying it three times with
 *     exponential backoff turns a fast error into a slow one.
 */

/* ---------------------------------------------------------------- bulkhead */

/** A counting semaphore. Fair: waiters are released in arrival order. */
class Semaphore {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#release();
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      // Guard against a double release returning a permit that was never held.
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#available += 1;
    };
  }
}

const bulkheads = new Map<ProviderId, Semaphore>();

/**
 * Run `work` with a permit for this provider held for its duration.
 *
 * Per-worker rather than fleet-wide, deliberately: the bulkhead protects *this
 * process's* slots, and a distributed permit would add a Redis round trip to
 * the hot path to solve a problem the fleet-wide circuit breaker below already
 * covers.
 */
export async function withBulkhead<T>(
  provider: ProviderId,
  work: () => Promise<T>,
): Promise<T> {
  let semaphore = bulkheads.get(provider);
  if (!semaphore) {
    semaphore = new Semaphore(workerConfig.PROVIDER_MAX_CONCURRENCY);
    bulkheads.set(provider, semaphore);
  }

  const release = await semaphore.acquire();
  try {
    return await work();
  } finally {
    release();
  }
}

/* --------------------------------------------------------- circuit breaker */

export type BreakerState =
  | { state: "closed" }
  /** Calls are refused until `until`. */
  | { state: "open"; until: Date };

export interface BreakerStore {
  /** Consecutive failure count and open-until timestamp for a provider. */
  read(
    provider: ProviderId,
  ): Promise<{ failures: number; openUntilMs: number }>;
  recordFailure(
    provider: ProviderId,
    thresholdReachedCooldownMs: number,
  ): Promise<void>;
  recordSuccess(provider: ProviderId): Promise<void>;
}

const breakerRowSchema = z.object({
  failures: z.coerce.number().int().nonnegative().catch(0),
  openUntil: z.coerce.number().int().nonnegative().catch(0),
});

/**
 * Breaker state in Redis, shared by the whole worker fleet.
 *
 * Fleet-wide is the point: with per-process state, ten workers each need their
 * own N failures before they stop calling a provider that is already down —
 * ten times the wasted calls and, on a metered API, ten times the wasted spend.
 */
export class RedisBreakerStore implements BreakerStore {
  async read(
    provider: ProviderId,
  ): Promise<{ failures: number; openUntilMs: number }> {
    const raw = await redis().hgetall(breakerKey(provider));
    const parsed = breakerRowSchema.safeParse(raw);
    if (!parsed.success) return { failures: 0, openUntilMs: 0 };
    return {
      failures: parsed.data.failures,
      openUntilMs: parsed.data.openUntil,
    };
  }

  async recordFailure(provider: ProviderId, cooldownMs: number): Promise<void> {
    const key = breakerKey(provider);
    const failures = await redis().hincrby(key, "failures", 1);

    if (failures >= workerConfig.BREAKER_FAILURE_THRESHOLD) {
      await redis().hset(key, "openUntil", Date.now() + cooldownMs);
    }
    // The whole record expires well after the cooldown, so a provider that
    // recovers quietly does not carry a stale failure count for ever.
    await redis().pexpire(key, cooldownMs * 4);
  }

  async recordSuccess(provider: ProviderId): Promise<void> {
    await redis().del(breakerKey(provider));
  }
}

/** Per-process breaker state, used when `RUN_TRANSPORT=local`. */
export class MemoryBreakerStore implements BreakerStore {
  readonly #rows = new Map<
    ProviderId,
    { failures: number; openUntilMs: number }
  >();

  async read(
    provider: ProviderId,
  ): Promise<{ failures: number; openUntilMs: number }> {
    return this.#rows.get(provider) ?? { failures: 0, openUntilMs: 0 };
  }

  async recordFailure(provider: ProviderId, cooldownMs: number): Promise<void> {
    const row = this.#rows.get(provider) ?? { failures: 0, openUntilMs: 0 };
    row.failures += 1;
    if (row.failures >= workerConfig.BREAKER_FAILURE_THRESHOLD) {
      row.openUntilMs = Date.now() + cooldownMs;
    }
    this.#rows.set(provider, row);
  }

  async recordSuccess(provider: ProviderId): Promise<void> {
    this.#rows.delete(provider);
  }
}

let breakerStore: BreakerStore | null = null;

export function setBreakerStore(store: BreakerStore | null): void {
  breakerStore = store;
}

function store(): BreakerStore {
  breakerStore ??= new RedisBreakerStore();
  return breakerStore;
}

export async function breakerState(
  provider: ProviderId,
): Promise<BreakerState> {
  const { openUntilMs } = await store().read(provider);
  if (openUntilMs > Date.now())
    return { state: "open", until: new Date(openUntilMs) };
  return { state: "closed" };
}

/**
 * Record the outcome of a call against a provider.
 *
 * Only failures that suggest the *provider* is unwell count. A 400 means our
 * request was wrong, and letting a malformed prompt trip the breaker for every
 * other tenant would turn one bad input into an outage.
 */
export async function recordProviderOutcome(
  provider: ProviderId,
  outcome: { ok: true } | { ok: false; error: unknown },
): Promise<void> {
  if (outcome.ok) {
    await store().recordSuccess(provider);
    return;
  }
  if (classify(outcome.error).kind === "permanent") return;
  await store().recordFailure(provider, workerConfig.BREAKER_COOLDOWN_MS);
}

/* --------------------------------------------------- retry classification */

export type Classification =
  /** Worth another attempt; `retryAfterMs` is the provider's own hint, if given. */
  | { kind: "retryable"; retryAfterMs: number | null; reason: string }
  /** Will fail identically next time. Retrying only converts fast into slow. */
  | { kind: "permanent"; reason: string };

const RETRYABLE_STATUSES = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 529,
]);

/**
 * Network-level failures the SDK surfaces as an ordinary `Error` with no status.
 * Matched on the code words rather than the whole message, which varies by
 * runtime.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /\bEAI_AGAIN\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork (error|request failed)\b/i,
  /\bfetch failed\b/i,
];

export function classify(error: unknown): Classification {
  const facts = errorFacts(error);

  // An abort is our own decision — a timeout, a deadline or a cancellation.
  // Whoever made it decides what happens next; the queue must not second-guess it.
  if (facts.name === "AbortError" || facts.name === "TimeoutError") {
    return { kind: "permanent", reason: "aborted" };
  }

  if (facts.status !== null) {
    return RETRYABLE_STATUSES.has(facts.status)
      ? {
          kind: "retryable",
          retryAfterMs: facts.retryAfterMs,
          reason: `HTTP ${facts.status}`,
        }
      : { kind: "permanent", reason: `HTTP ${facts.status}` };
  }

  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(facts.message))) {
    return {
      kind: "retryable",
      retryAfterMs: null,
      reason: "transient network error",
    };
  }

  return { kind: "permanent", reason: facts.name };
}

/**
 * How long the queue should wait before the next attempt.
 *
 * The provider's own `Retry-After` wins when it sent one — it knows when its
 * rate-limit window resets and we do not, and ignoring it is how a 429 becomes
 * a longer 429.
 */
export function retryDelayMs(error: unknown, fallbackMs: number): number {
  const classification = classify(error);
  if (classification.kind === "permanent") return fallbackMs;
  return classification.retryAfterMs ?? fallbackMs;
}
