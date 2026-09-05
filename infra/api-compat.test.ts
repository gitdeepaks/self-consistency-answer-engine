import { describe, expect, test } from "bun:test";
import { jsonValueSchema, type JsonValue } from "@sce/shared";
import { canonicalise } from "./api-spec.ts";
import { classifySchemas, compare, type Finding } from "./api-compat.ts";

/**
 * The gate that stops `/v1` being broken by accident.
 *
 * Two properties have to hold, and the second is the one that decides whether
 * anybody keeps it switched on:
 *
 *   - it catches every change that would break a caller;
 *   - it stays quiet about every change that would not.
 *
 * A gate with false positives gets bypassed, and then it protects nothing. So
 * roughly half of these tests assert that something is *allowed*.
 */

/** A minimal document: one request shape, one response shape, one webhook. */
function spec(overrides: {
  paths?: JsonValue;
  schemas?: JsonValue;
  webhooks?: JsonValue;
}): JsonValue {
  return jsonValueSchema.parse({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: overrides.paths ?? {
      "/runs": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateRun" },
              },
            },
          },
          responses: {
            201: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Run" },
                },
              },
            },
            429: { description: "limited" },
          },
        },
      },
    },
    webhooks: overrides.webhooks ?? {
      "run.completed": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Run" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: overrides.schemas ?? {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    },
  });
}

const breaking = (findings: readonly Finding[]): string[] =>
  findings
    .filter((finding) => finding.severity === "breaking")
    .map((finding) => finding.at);

describe("direction classification", () => {
  test("a schema is tagged by the side of the wire it travels on", () => {
    const usage = classifySchemas(spec({}));

    expect(usage.get("CreateRun")).toEqual({ request: true, response: false });
    // `Run` is a response body *and* an outbound webhook body — both are things
    // we send and a caller reads, so both obey the response rules.
    expect(usage.get("Run")).toEqual({ request: false, response: true });
  });
});

describe("changes that break a caller", () => {
  test("a removed path", () => {
    const findings = compare(spec({}), spec({ paths: {} }));
    expect(breaking(findings)).toContain("paths./runs");
  });

  test("a removed operation", () => {
    const after = spec({
      paths: { "/runs": { get: { responses: { 200: {} } } } },
    });
    expect(breaking(compare(spec({}), after))).toContain("paths./runs.post");
  });

  test("a removed response status a caller had a branch for", () => {
    const after = spec({
      paths: {
        "/runs": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateRun" },
                },
              },
            },
            responses: { 201: {} },
          },
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "paths./runs.post.responses.429",
    );
  });

  test("a field removed from a response", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "components.schemas.Run.properties.status",
    );
  });

  test("a new required field on a request", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
            panel: { type: "string" },
          },
          required: ["prompt", "panel"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "components.schemas.CreateRun.properties.panel",
    );
  });

  test("an optional request field becoming required", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["prompt", "temperature"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "components.schemas.CreateRun.properties.temperature",
    );
  });

  test("a value a request enum used to accept, removed", () => {
    const before = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            mode: { type: "string", enum: ["fast", "deep"] },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    });
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            mode: { type: "string", enum: ["fast"] },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    });
    expect(breaking(compare(before, after))).toContain(
      "components.schemas.CreateRun.properties.mode.enum",
    );
  });

  test("a type change", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "string" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "components.schemas.CreateRun.properties.temperature.type",
    );
  });

  test("a removed webhook event type", () => {
    expect(breaking(compare(spec({}), spec({ webhooks: {} })))).toContain(
      "webhooks.run.completed",
    );
  });

  test("a removed component schema", () => {
    const after = spec({
      schemas: {
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toContain(
      "components.schemas.CreateRun",
    );
  });
});

describe("changes that break nobody", () => {
  test("adding a field to a response", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
            tags: { type: "array" },
          },
          required: ["id", "status", "tags"],
        },
      },
    });
    // Required on a *response* is a stronger promise, not a weaker one — this
    // is the case a naive differ flags, and flagging it is what gets a gate
    // switched off.
    expect(breaking(compare(spec({}), after))).toEqual([]);
  });

  test("adding an optional field to a request", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
            seed: { type: "number" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["QUEUED", "COMPLETE"] },
          },
          required: ["id", "status"],
        },
      },
    });
    expect(breaking(compare(spec({}), after))).toEqual([]);
  });

  test("adding a new path, and a new response status", () => {
    const after = spec({
      paths: {
        "/runs": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateRun" },
                },
              },
            },
            responses: {
              201: {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Run" },
                  },
                },
              },
              429: { description: "limited" },
              503: { description: "budget" },
            },
          },
          get: { responses: { 200: {} } },
        },
        "/usage": { get: { responses: { 200: {} } } },
      },
    });
    expect(breaking(compare(spec({}), after))).toEqual([]);
  });

  test("adding a value to a response enum is a warning, not a failure", () => {
    const after = spec({
      schemas: {
        CreateRun: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["prompt"],
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: {
              type: "string",
              enum: ["QUEUED", "COMPLETE", "CANCELED"],
            },
          },
          required: ["id", "status"],
        },
      },
    });
    const findings = compare(spec({}), after);

    expect(breaking(findings)).toEqual([]);
    // Still reported: a consumer with an exhaustive switch will not handle it,
    // and being told is the whole reason the severity exists.
    expect(findings.some((finding) => finding.severity === "warning")).toBe(
      true,
    );
  });

  test("an unchanged document produces nothing at all", () => {
    expect(compare(spec({}), spec({}))).toEqual([]);
  });
});

describe("canonicalisation", () => {
  test("object key order is normalised so a diff is the semantic change", () => {
    const a = canonicalise({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalise({ a: { c: 3, d: 2 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("array order is preserved, because in OpenAPI it sometimes means something", () => {
    expect(canonicalise({ servers: ["a", "b"] })).toEqual({
      servers: ["a", "b"],
    });
  });
});
