import { describe, expect, test } from "bun:test";
import { describeError, errorFacts } from "./errors.ts";

/**
 * The AI SDK's retry wrapper, reproduced in the shape that matters: no status
 * of its own, the real failures hung off `errors` / `lastError`.
 */
function apiCallError(
  status: number,
  message: string,
  retryAfter?: string,
): Error {
  const error = new Error(message);
  error.name = "AI_APICallError";
  return Object.assign(error, {
    statusCode: status,
    ...(retryAfter === undefined
      ? {}
      : { responseHeaders: { "retry-after": retryAfter } }),
  });
}

function retryError(attempts: readonly Error[]): Error {
  const error = new Error("Failed after 3 attempts.");
  error.name = "AI_RetryError";
  return Object.assign(error, {
    errors: [...attempts],
    lastError: attempts.at(-1),
  });
}

describe("errorFacts", () => {
  test("reads a status straight off an unwrapped provider error", () => {
    expect(errorFacts(apiCallError(429, "quota exceeded")).status).toBe(429);
  });

  test("finds the status inside the AI SDK's retry wrapper", () => {
    const wrapped = retryError([
      apiCallError(429, "quota exceeded"),
      apiCallError(429, "quota exceeded"),
    ]);

    const facts = errorFacts(wrapped);
    // Without unwrapping this is `null`, which classifies a 429 as permanent:
    // the breaker never trips and the provider's retry hint is thrown away.
    expect(facts.status).toBe(429);
    expect(facts.message).toBe("quota exceeded");
  });

  test("recovers the provider's retry hint from the last attempt", () => {
    const wrapped = retryError([
      apiCallError(429, "slow down", "1"),
      apiCallError(429, "slow down", "36"),
    ]);
    expect(errorFacts(wrapped).retryAfterMs).toBe(36_000);
  });

  test("walks a plain `cause` chain too", () => {
    const outer = new Error("wrapped", {
      cause: apiCallError(503, "upstream is down"),
    });
    expect(errorFacts(outer).status).toBe(503);
  });

  test("leaves an error with no status anywhere untouched", () => {
    const empty = new Error("Model returned an empty answer");
    empty.name = "EmptyAnswerError";
    const facts = errorFacts(new Error("outer", { cause: empty }));

    expect(facts.status).toBeNull();
    expect(facts.name).toBe("Error");
    expect(facts.message).toBe("outer");
  });

  test("survives a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.assign(a, { cause: b });
    expect(errorFacts(a).status).toBeNull();
  });
});

describe("describeError", () => {
  test("names the status of a wrapped provider failure", () => {
    const wrapped = retryError([
      apiCallError(429, "You exceeded your current quota"),
    ]);
    expect(describeError(wrapped)).toBe(
      "HTTP 429: You exceeded your current quota",
    );
  });
});
