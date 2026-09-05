import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsonValueSchema, type JsonValue } from "@sce/shared";
import { renderSpec } from "./api-spec.ts";

/**
 * The compatibility gate.
 *
 *     bun run api:check                 # against origin/main
 *     bun run api:check -- HEAD~1       # against any ref
 *     ALLOW_BREAKING_API_CHANGE=1 …     # report, do not fail
 *
 * Publishing a contract makes it expensive to change, and the expense is only
 * bounded if breaking it is *hard to do by accident*. A schema in
 * `packages/shared` is edited for a first-party reason — a field renamed for
 * the web app, a status added for the worker — and the fact that it is also the
 * shape somebody's production integration parses is nowhere near the edit. This
 * script is what puts it there.
 *
 * Two checks run, and they fail for different reasons:
 *
 *   **Staleness.** The generated document must match `doc/api/openapi.json`
 *   exactly. A committed spec is what makes an API change visible in a pull
 *   request diff at all; one that silently drifts is worse than none, because
 *   it is believed.
 *
 *   **Compatibility.** The generated document is compared against the one on
 *   the base ref, and anything that would break a caller written against the
 *   old shape is reported with its JSON path.
 *
 * Direction matters, and getting it right is what makes the gate trustworthy
 * rather than noisy. Adding a required field to a **request** breaks every
 * existing caller; adding one to a **response** breaks nobody. Removing a field
 * from a **response** breaks every reader; removing one from a request is
 * merely permissive. So each component schema is classified by whether it is
 * reachable from a request body, a response body, or both — and the rules are
 * applied accordingly. A gate that flags safe changes gets switched off, and
 * then it protects nothing.
 */

const SPEC_PATH = path.join(
  import.meta.dir,
  "..",
  "doc",
  "api",
  "openapi.json",
);
const SPEC_REPO_PATH = "doc/api/openapi.json";

/* ------------------------------------------------------------- findings */

export type Severity = "breaking" | "warning";

export interface Finding {
  severity: Severity;
  /** Where in the document, as a JSON path a person can search the file for. */
  at: string;
  message: string;
}

/** Which side of the wire a schema is used on. Both is possible and common. */
interface Usage {
  request: boolean;
  response: boolean;
}

/* ------------------------------------------------------------- plumbing */

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(value: JsonValue, key: string): JsonValue | undefined {
  return isObject(value) ? value[key] : undefined;
}

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return value !== undefined && isObject(value) ? value : {};
}

function asStrings(value: JsonValue | undefined): string[] {
  if (value === undefined || !Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Every component schema a subtree references, followed through `$ref`.
 *
 * Recursive schemas would loop for ever without the `seen` set — and the
 * `RunEvent` union does contain a run, which contains candidates. Following
 * refs at all is what lets the gate know that `Run` is a response shape and
 * `CreateRunRequest` is a request one, which is the whole basis for applying
 * different rules to them.
 */
function collectRefs(
  node: JsonValue | undefined,
  schemas: { [key: string]: JsonValue },
  seen: Set<string>,
): void {
  if (node === undefined) return;

  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, schemas, seen);
    return;
  }
  if (!isObject(node)) return;

  const ref = node["$ref"];
  if (typeof ref === "string") {
    const name = ref.replace("#/components/schemas/", "");
    if (!seen.has(name)) {
      seen.add(name);
      collectRefs(schemas[name], schemas, seen);
    }
    return;
  }

  for (const value of Object.values(node)) collectRefs(value, schemas, seen);
}

/** Classify every component schema by the direction it travels in. */
export function classifySchemas(document: JsonValue): Map<string, Usage> {
  const schemas = asObject(
    child(asObject(child(document, "components")), "schemas"),
  );
  const usage = new Map<string, Usage>();

  const mark = (names: Set<string>, side: keyof Usage): void => {
    for (const name of names) {
      const existing = usage.get(name) ?? { request: false, response: false };
      usage.set(name, { ...existing, [side]: true });
    }
  };

  for (const operations of Object.values(asObject(child(document, "paths")))) {
    for (const operation of Object.values(asObject(operations))) {
      const requests = new Set<string>();
      collectRefs(child(operation, "requestBody"), schemas, requests);
      collectRefs(child(operation, "parameters"), schemas, requests);
      mark(requests, "request");

      const responses = new Set<string>();
      collectRefs(child(operation, "responses"), schemas, responses);
      mark(responses, "response");
    }
  }

  // Outbound webhooks travel the other way: their body is something *we* send
  // and a customer parses, so it obeys the response rules despite living under
  // `requestBody` in the document.
  for (const operations of Object.values(
    asObject(child(document, "webhooks")),
  )) {
    for (const operation of Object.values(asObject(operations))) {
      const sent = new Set<string>();
      collectRefs(child(operation, "requestBody"), schemas, sent);
      mark(sent, "response");
    }
  }

  // A schema referenced by nothing is still published. Treated as both, which
  // is the conservative reading.
  for (const name of Object.keys(schemas)) {
    if (!usage.has(name)) usage.set(name, { request: true, response: true });
  }

  return usage;
}

/* --------------------------------------------------------- the comparison */

/** Compare two documents and report everything that breaks a caller. */
export function compare(before: JsonValue, after: JsonValue): Finding[] {
  const findings: Finding[] = [];

  comparePaths(before, after, findings);
  compareWebhooks(before, after, findings);
  compareSchemas(before, after, findings);

  return findings;
}

function comparePaths(
  before: JsonValue,
  after: JsonValue,
  findings: Finding[],
): void {
  const oldPaths = asObject(child(before, "paths"));
  const newPaths = asObject(child(after, "paths"));

  for (const [route, operations] of Object.entries(oldPaths)) {
    const current = newPaths[route];
    if (current === undefined) {
      findings.push({
        severity: "breaking",
        at: `paths.${route}`,
        message: "the path was removed",
      });
      continue;
    }

    for (const [method, operation] of Object.entries(asObject(operations))) {
      const currentOperation = asObject(current)[method];
      if (currentOperation === undefined) {
        findings.push({
          severity: "breaking",
          at: `paths.${route}.${method}`,
          message: "the operation was removed",
        });
        continue;
      }

      compareOperation(
        `paths.${route}.${method}`,
        operation,
        currentOperation,
        findings,
      );
    }
  }
}

function compareOperation(
  at: string,
  before: JsonValue,
  after: JsonValue,
  findings: Finding[],
): void {
  // A status a caller had a branch for, gone. Their branch is now dead code and
  // whatever they get instead is unhandled.
  for (const status of Object.keys(asObject(child(before, "responses")))) {
    if (asObject(child(after, "responses"))[status] === undefined) {
      findings.push({
        severity: "breaking",
        at: `${at}.responses.${status}`,
        message: "the response was removed",
      });
    }
  }

  const oldParams = parameterMap(child(before, "parameters"));
  const newParams = parameterMap(child(after, "parameters"));

  for (const [name, required] of oldParams) {
    const now = newParams.get(name);
    if (now === undefined) {
      findings.push({
        severity: "warning",
        at: `${at}.parameters.${name}`,
        message:
          "the parameter was removed — callers still sending it will be ignored",
      });
      continue;
    }
    if (now && !required) {
      findings.push({
        severity: "breaking",
        at: `${at}.parameters.${name}`,
        message: "an optional parameter became required",
      });
    }
  }

  for (const [name, required] of newParams) {
    if (required && !oldParams.has(name)) {
      findings.push({
        severity: "breaking",
        at: `${at}.parameters.${name}`,
        message: "a new required parameter was added",
      });
    }
  }
}

function parameterMap(parameters: JsonValue | undefined): Map<string, boolean> {
  const map = new Map<string, boolean>();
  if (parameters === undefined || !Array.isArray(parameters)) return map;

  for (const parameter of parameters) {
    const name = child(parameter, "name");
    if (typeof name !== "string") continue;
    map.set(name, child(parameter, "required") === true);
  }
  return map;
}

function compareWebhooks(
  before: JsonValue,
  after: JsonValue,
  findings: Finding[],
): void {
  for (const event of Object.keys(asObject(child(before, "webhooks")))) {
    if (asObject(child(after, "webhooks"))[event] === undefined) {
      findings.push({
        severity: "breaking",
        at: `webhooks.${event}`,
        message:
          "the event type was removed — receivers subscribed to it stop being called",
      });
    }
  }
}

function compareSchemas(
  before: JsonValue,
  after: JsonValue,
  findings: Finding[],
): void {
  const oldSchemas = asObject(
    child(asObject(child(before, "components")), "schemas"),
  );
  const newSchemas = asObject(
    child(asObject(child(after, "components")), "schemas"),
  );
  const usage = classifySchemas(after);

  for (const [name, schema] of Object.entries(oldSchemas)) {
    const current = newSchemas[name];
    if (current === undefined) {
      findings.push({
        severity: "breaking",
        at: `components.schemas.${name}`,
        message: "the schema was removed",
      });
      continue;
    }

    // A schema that no longer appears in the new document is classified as
    // both, which is the conservative reading for something being removed from
    // circulation while still named.
    const direction = usage.get(name) ?? { request: true, response: true };
    compareSchema(
      `components.schemas.${name}`,
      schema,
      current,
      direction,
      findings,
    );
  }
}

/**
 * Compare one schema, recursively.
 *
 * The four rules, and who each protects:
 *
 *   `type` changed                    — everyone. A string that became a number
 *                                       breaks the reader and the writer alike.
 *   property removed from a response  — every reader of that field.
 *   required property added to a request — every existing caller, immediately.
 *   enum value removed                — a request's callers (their value is now
 *                                       rejected) or, for a response, nobody:
 *                                       a narrower set still fits the old type.
 */
function compareSchema(
  at: string,
  before: JsonValue,
  after: JsonValue,
  usage: Usage,
  findings: Finding[],
): void {
  const oldType = child(before, "type");
  const newType = child(after, "type");
  if (
    oldType !== undefined &&
    JSON.stringify(oldType) !== JSON.stringify(newType)
  ) {
    findings.push({
      severity: "breaking",
      at: `${at}.type`,
      message: `the type changed from ${JSON.stringify(oldType)} to ${JSON.stringify(newType)}`,
    });
  }

  const oldEnum = asStrings(child(before, "enum"));
  const newEnum = asStrings(child(after, "enum"));
  if (oldEnum.length > 0 && newEnum.length > 0) {
    const removed = oldEnum.filter((value) => !newEnum.includes(value));
    if (removed.length > 0 && usage.request) {
      findings.push({
        severity: "breaking",
        at: `${at}.enum`,
        message: `values a caller may still send were removed: ${removed.join(", ")}`,
      });
    }

    const added = newEnum.filter((value) => !oldEnum.includes(value));
    if (added.length > 0 && usage.response) {
      findings.push({
        severity: "warning",
        at: `${at}.enum`,
        message:
          `new values a reader has no branch for: ${added.join(", ")} — additive, but a ` +
          "consumer with an exhaustive switch will not handle them",
      });
    }
  }

  const oldProperties = asObject(child(before, "properties"));
  const newProperties = asObject(child(after, "properties"));
  const oldRequired = new Set(asStrings(child(before, "required")));
  const newRequired = new Set(asStrings(child(after, "required")));

  for (const [property, schema] of Object.entries(oldProperties)) {
    const current = newProperties[property];

    if (current === undefined) {
      if (usage.response) {
        findings.push({
          severity: "breaking",
          at: `${at}.properties.${property}`,
          message: "a field readers depend on was removed from a response",
        });
      }
      continue;
    }

    if (
      usage.response &&
      oldRequired.has(property) &&
      !newRequired.has(property)
    ) {
      findings.push({
        severity: "breaking",
        at: `${at}.properties.${property}`,
        message: "a response field that was always present became optional",
      });
    }

    if (
      usage.request &&
      !oldRequired.has(property) &&
      newRequired.has(property)
    ) {
      findings.push({
        severity: "breaking",
        at: `${at}.properties.${property}`,
        message: "an optional request field became required",
      });
    }

    compareSchema(
      `${at}.properties.${property}`,
      schema,
      current,
      usage,
      findings,
    );
  }

  for (const property of newRequired) {
    if (!oldProperties[property] && usage.request) {
      findings.push({
        severity: "breaking",
        at: `${at}.properties.${property}`,
        message: "a new required request field was added",
      });
    }
  }
}

/* ------------------------------------------------------------- the script */

/** Read the committed spec from a git ref, or null when it did not exist there. */
async function specAtRef(ref: string): Promise<JsonValue | null> {
  const shown = Bun.spawn(["git", "show", `${ref}:${SPEC_REPO_PATH}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(shown.stdout).text();
  if ((await shown.exited) !== 0) return null;

  const parsed = jsonValueSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
}

/** Does `ref` exist in this clone? Shallow CI checkouts often lack `origin/main`. */
async function refExists(ref: string): Promise<boolean> {
  const rev = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", ref], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await rev.exited) === 0;
}

if (import.meta.main) {
  const generated = renderSpec();

  /* ---- staleness ---- */

  const committed = await readFile(SPEC_PATH, "utf8").catch(() => null);
  if (committed === null) {
    console.error(`[api] ${SPEC_REPO_PATH} is missing. Run: bun run api:spec`);
    process.exit(1);
  }
  if (committed !== generated) {
    console.error(
      `[api] ${SPEC_REPO_PATH} is out of date with the routes.\n` +
        "      Run: bun run api:spec — and review the diff, because it is the\n" +
        "      change your callers will see.",
    );
    process.exit(1);
  }

  /* ---- compatibility ---- */

  /*
   * The base to compare against, most specific first.
   *
   * `GITHUB_BASE_REF` is the branch a pull request targets, which is the only
   * correct answer on a pull request — comparing against `main` when the PR
   * targets a release branch would report every difference between the two as a
   * breaking change. The fallbacks exist so this is still useful locally.
   */
  const requested = process.argv[2];
  const baseRefEnv = process.env["GITHUB_BASE_REF"];
  const candidates =
    requested !== undefined
      ? [requested]
      : [
          ...(baseRefEnv === undefined || baseRefEnv === ""
            ? []
            : [`origin/${baseRefEnv}`]),
          "origin/main",
          "main",
          "HEAD~1",
        ];

  let baseRef: string | null = null;
  for (const candidate of candidates) {
    if (await refExists(candidate)) {
      baseRef = candidate;
      break;
    }
  }

  if (baseRef === null) {
    console.log("[api] no base ref to compare against; spec is up to date");
    process.exit(0);
  }

  const before = await specAtRef(baseRef);
  if (before === null) {
    // The first commit that introduces the spec has nothing to compare with,
    // and that is not a failure — it is the baseline being established.
    console.log(
      `[api] ${SPEC_REPO_PATH} does not exist at ${baseRef}; recording the baseline`,
    );
    process.exit(0);
  }

  const after = jsonValueSchema.parse(JSON.parse(generated));
  const findings = compare(before, after);

  const breaking = findings.filter(
    (finding) => finding.severity === "breaking",
  );
  const warnings = findings.filter((finding) => finding.severity === "warning");

  for (const finding of warnings)
    console.warn(
      `[api] warning  ${finding.at}\n            ${finding.message}`,
    );
  for (const finding of breaking)
    console.error(
      `[api] BREAKING ${finding.at}\n            ${finding.message}`,
    );

  if (breaking.length === 0) {
    console.log(
      `[api] no breaking changes against ${baseRef} (${warnings.length} warnings)`,
    );
    process.exit(0);
  }

  if (process.env["ALLOW_BREAKING_API_CHANGE"] === "1") {
    console.warn(
      `\n[api] ${breaking.length} breaking change(s) allowed by ALLOW_BREAKING_API_CHANGE=1.\n` +
        "      This is the override described in doc/api/versioning.md. It is for a\n" +
        "      deliberate, announced break — not for making a red build green.",
    );
    process.exit(0);
  }

  console.error(
    `\n[api] ${breaking.length} breaking change(s) against ${baseRef}.\n` +
      "      /v1 is published. Breaking it costs twelve months of notice — see\n" +
      "      doc/api/versioning.md.\n\n" +
      "      Make the change additive, or introduce it under a new version. If the\n" +
      "      break is genuinely intended and has been announced, re-run with\n" +
      "      ALLOW_BREAKING_API_CHANGE=1 and say so in the pull request.",
  );
  process.exit(1);
}
