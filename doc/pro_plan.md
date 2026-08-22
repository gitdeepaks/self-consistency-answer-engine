# Production Plan — Self-Consistency Answer Engine

**Status:** draft · **Owner:** @gitdeepaks · **Created:** 2026-08-22
**Target:** turn the current 4-package prototype into a multi-surface production system —
**web app + API + CLI**, with a **public API and TypeScript SDK**.

---

## 0. Scope, assumptions, and how to read this

### What you chose

| Decision | Answer |
| -------- | ------ |
| Surfaces | Web app **+** API **+** CLI, plus a versioned **public API + SDK** |

### What I assumed (change these and the plan flexes)

| Assumption | Value | Where it bites if wrong |
| ---------- | ----- | ----------------------- |
| **Tenancy** | Multi-tenant SaaS: users, organizations, RBAC | Phase 3 shrinks to near-zero if single-tenant |
| **Monetization** | Usage metering + plans + billing (a public API needs quotas anyway) | Phase 4 becomes "quotas only" without billing |
| **Infra** | Postgres + Redis + containers, Fly.io as the baseline (extends the existing `fly.toml`), portable to any Docker host | Phase 1/2 tooling changes for serverless; Terraform appears if AWS |
| **Team** | 2–3 engineers | Timeline scales roughly linearly |

> These are assumptions, not decisions. Flag any that are wrong before Phase 1 starts — Phases 0–2 are
> correct under all four options, so work can begin immediately regardless.

### How the phases relate

```
 P0 Foundations ──┬─► P1 Data platform ──► P2 Durable orchestration ──┬─► P5 Web app
                  │                                                   ├─► P6 Public API + SDK
                  └─► P3 Identity & tenancy ──► P4 Metering & billing ─┘
                                                                       │
 P7 Answer quality  ────────── runs in parallel from P2 onward ────────┤
 P8 Observability   ────────── runs in parallel from P0 onward ────────┤
 P9 Security & launch ───────────────────── gates GA ──────────────────┘
```

P0–P2 are strictly sequential and are the real backbone. P3/P7/P8 can be parallelised across people.
P9 is a gate, not a phase you "get to at the end" — its checklist accumulates from P0.

---

## 1. Where the code actually is today

Facts, from reading the repo — this is the baseline every phase is measured against.

| Area | Today | Production gap |
| ---- | ----- | -------------- |
| Packages | `shared`, `db`, `server`, `cli` (~1,300 LOC src) | No `web`, no `worker`, no `sdk` |
| API | Hono, 7 routes, `packages/server/src/app.ts` | Unversioned, unauthenticated, no rate limits, no OpenAPI |
| Orchestration | `startRun()` fires background work **inside the HTTP process** (`orchestrator.ts:1`) | A restart or crash orphans every in-flight run; cannot scale past one instance |
| Progress | In-memory append-only buffer + cursor (`event-bus.ts`), TTL `EVENT_BUFFER_TTL_MS` | Instance-local: a second replica cannot serve the SSE stream for a run it did not start |
| Model calls | `generateText` (blocking, whole answer at once) | Web UI wants token-level streaming; no partial output on timeout |
| DB | SQLite/libSQL, **`prisma db push`, no migration history** | No migrations, no Postgres, JSON stored as `String` columns (`Synthesis.agreements`, `.disagreements`, `.reviews`) |
| Tenancy | None. Every run is global and public | No user, org, ownership, or isolation anywhere in the schema |
| Cost | Tokens recorded per candidate; **no price, no budget, no cap** | Unbounded spend from a single unauthenticated `POST /api/runs` |
| Observability | `hono/logger` + `console.error` | No structured logs, traces, metrics, or alerting |
| Config | Hand-rolled `num()` parser in `env.ts`, no validation | Bad env fails at request time instead of boot |
| CI/CD | **None** (no `.github/`) | No gate on `bun test` / `typecheck` before deploy |
| Lint/format | **None** (no Biome/ESLint config) — mixed semicolon style already visible between `app.ts` and `orchestrator.ts` | Style drift compounds with team size |
| Type safety | `strict` + `noUncheckedIndexedAccess` already on, but `skipLibCheck: true`, no lint gate against `any`/`as`, and 9 assertions in source — including `JSON.parse(data) as RunEvent` on unvalidated SSE input (`cli/src/api.ts:119`) | See §3 — the rules, the gates, and the fix list |
| Tests | 27, all mocked via `MockLanguageModelV4`, no network | No integration, load, E2E, or answer-quality tests |
| Deploy | `Dockerfile` + `fly.toml`, single machine | No staging, no migrations-on-deploy, no rollback story |
| Security | `CORS_ORIGIN` defaults to `*`; no authn/z, no abuse controls, no prompt-injection defence | Not deployable on a public network as-is |

**What is already good and should be preserved:** the typed end-to-end contract (`hc<AppType>()`),
the shared Zod schema package as single source of truth, per-candidate failure isolation, the
cursor-over-append-only-buffer replay design (right idea, wrong storage), and the fully-mocked test
suite that runs with no keys.

---

## 2. Target architecture

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │   Web app    │   │  OpenTUI CLI │   │  Public API  │   │   @sce/sdk   │
   │  (Next.js)   │   │              │   │   consumers  │   │  (TS client) │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          └──────────────────┴─────────┬────────┴──────────────────┘
                                       │  HTTPS · session cookie or API key
                            ┌──────────┴──────────┐
                            │   Edge / CDN · WAF  │  rate limit, bot defence
                            └──────────┬──────────┘
                            ┌──────────┴──────────┐
                            │   API (Hono, N×)    │  stateless, horizontally scaled
                            │  authn/z · quotas   │
                            └─────┬────────┬──────┘
                     enqueue job  │        │  subscribe to run stream
                            ┌─────┴───┐ ┌──┴──────────────┐
                            │  Queue  │ │  Redis Streams  │  durable progress bus
                            │ (Redis) │ │  + replay from  │  (replaces event-bus.ts)
                            └─────┬───┘ │      Postgres   │
                                  │     └─────────────────┘
                     ┌────────────┴────────────┐
                     │   Worker pool (M×)      │  runs the orchestrator
                     │  fan-out → synthesis    │  retries, cancellation, resume
                     └───┬────────────┬────────┘
        ┌────────────────┼────────────┼─────────────────┐
   ┌────┴───┐      ┌─────┴──┐    ┌────┴───┐        ┌────┴─────┐
   │ OpenAI │      │ Claude │    │ Gemini │  …     │ Evaluator│
   └────────┘      └────────┘    └────────┘        └──────────┘
                     ┌───────────┴───────────┐
                     │  Postgres (primary)   │  tenants, runs, events, usage
                     │  + object store       │  large answer bodies
                     └───────────────────────┘
                     ┌───────────────────────┐
                     │ OTel → traces/metrics │  logs, dashboards, alerts
                     └───────────────────────┘
```

### Repo layout after the plan

```
packages/
  shared/      Zod schemas, domain types, model registry, event union   (exists — grows)
  db/          Prisma schema, migrations, typed repository              (exists — Postgres)
  server/      Hono API: routes, authn/z, quotas, SSE fan-in            (exists — split)
  worker/      NEW  queue consumer, orchestrator, retries, cancellation
  web/         NEW  Next.js app: ask, stream, history, share, admin
  sdk/         NEW  published TypeScript client for the public API
  cli/         OpenTUI client, now auth-aware                           (exists — grows)
  evals/       NEW  golden set, judge harness, regression gate
infra/         NEW  compose, deploy manifests, migration jobs, dashboards
doc/           this plan, ADRs, runbooks, API reference
.github/       NEW  CI: typecheck, test, lint, migrate-check, deploy
```

---

## 3. Engineering standard: bulletproof types

**Rule:** no `any`, no leaked `unknown`, no type assertions. This is not a phase — it is a constraint
every phase is built under, enforced by the compiler and CI rather than by review discipline. It is
listed before the phases because retrofitting type safety costs several times what building under it
does.

### 3.1 What is banned

| Banned | Why | Use instead |
| ------ | --- | ----------- |
| `any` (explicit or implicit) | Disables checking silently and spreads through every expression it touches | A real type, a generic, or a parsed schema |
| `unknown` flowing inward | Defers the problem to the call site, which then reaches for a cast | Parse at the boundary; pass the parsed type |
| `as` / `as unknown as` | A claim the compiler cannot verify — the exact place bugs hide | `z.parse()`, a type guard, or `satisfies` |
| Non-null `!` | Same claim, shorter syntax. `noUncheckedIndexedAccess` makes array access honest | An explicit check, or a total lookup |
| `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` | Turns the gate off exactly where it was about to fire | Fix the type, or the one escape hatch in §3.5 |
| `Function`, `object`, `{}` | Type-shaped but meaningless | A precise signature or interface |
| `as any` in tests | The most common leak; tests are production code for this purpose | Typed factories and builders |

**The one carve-out** — `unknown` is permitted as the *input parameter* of a validator, because
`JSON.parse`, `process.env`, and provider SDK responses cannot be typed any other way. It may not
escape that function: a validator takes `unknown` and returns a domain type. Everything downstream
sees the domain type. If you want this tightened further, say so and the parsers get their own
lint-exempt module.

### 3.2 Compiler settings

`tsconfig.base.json` already sets `strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`,
and `verbatimModuleSyntax` — a better starting point than most repos, and `useUnknownInCatchVariables`
comes free with `strict`. The delta to close:

```jsonc
{
  "compilerOptions": {
    "exactOptionalPropertyTypes": true,     // `x?: string` never silently accepts undefined
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noPropertyAccessFromIndexSignature": true,
    "isolatedDeclarations": true,           // exported API must state its types explicitly
    "skipLibCheck": false                   // currently true — see §3.4.6
  }
}
```

`isolatedDeclarations` is the strongest of these: every exported symbol must declare its type, so a
package's public surface can never be an inferred `any` leaking across a workspace boundary.
`skipLibCheck: false` is the one most likely to fight the toolchain — if a dependency's own `.d.ts`
files are broken, that is what the ambient declarations in §3.4.6 are for.

### 3.3 How types are actually obtained

Every type in the system comes from one of four sources, none of which is a cast:

1. **Zod schemas in `packages/shared`** — the existing pattern. `z.infer` gives the TypeScript type;
   `.parse()` gives the runtime guarantee. One definition, both halves.
2. **Generated clients** — Prisma for the database, `hc<AppType>()` for the RPC surface,
   `@hono/zod-openapi` for the public API and therefore for the SDK. Generated types are never
   hand-copied or re-declared.
3. **Discriminated unions with exhaustive switches.** The `RunEvent` union and `isTerminalEvent`
   guard are already the right shape; extend the pattern with an `assertNever(x: never)` in every
   default branch so adding an event type is a compile error at every site that must handle it.
4. **Branded types for identifiers** — `RunId`, `TenantId`, `UserId`, `CandidateId` as branded
   strings, constructed only by their parsers. This makes the P3 tenant-isolation rule partly a
   compile-time property: a `TenantId` cannot be passed where a `RunId` is expected, so a whole class
   of cross-tenant bug stops compiling.

Two more rules that remove the usual reasons people cast:

- **Parse at every trust boundary** — HTTP body, query, and headers; `process.env`; Prisma `Json`
  columns; provider responses; webhook payloads; queue job payloads; SSE frames on the client. This
  is why P1.3 moves the JSON-in-`String` columns to real `Json` parsed with Zod, and why P0.3
  replaces the hand-rolled env parser.
- **`satisfies`, never `as`, for config literals** — it checks the value against the type while
  keeping the narrow inferred type, which is what people actually wanted from `as` every time.

### 3.4 Enforcement in CI

Part of P0, and a merge blocker from that point on:

1. `bun run typecheck` — `tsc --noEmit` across every package, already wired, now with the settings above.
2. **Biome** for the fast rules: `noExplicitAny`, `noNonNullAssertion`, `noImplicitAnyLet`.
3. **typescript-eslint, type-aware**, for the rules that need the program: `no-unsafe-assignment`,
   `-argument`, `-call`, `-member-access`, `-return`, plus
   `consistent-type-assertions: { assertionStyle: "never" }`, `no-unnecessary-condition`, and
   `no-unnecessary-type-assertion`. Biome's type-aware coverage is still thinner than
   typescript-eslint's here, so both run — Biome on every save, ESLint in CI.
4. **`type-coverage --strict --at-least 99.9`** as a hard gate, so implicit `any` from third-party
   packages shows up as a number that cannot drift downward unnoticed.
5. **A banned-token check** on the diff for `@ts-ignore`, `@ts-nocheck`, `as any`, and `as unknown as`
   — cheap, and it catches the cases that slip past the linters.
6. **No `skipLibCheck` cheating.** If a dependency ships broken types, it gets an ambient declaration
   in `types/` that is written and reviewed, not a global check-disable.

### 3.5 The single escape hatch

Bad third-party types occasionally make a cast genuinely unavoidable. When that happens it does not
get scattered through the codebase:

- It lives in `packages/shared/src/unsafe/`, the only lint-exempt directory in the repo.
- It is wrapped in a function that validates at runtime and returns a domain type — so the cast is
  paid for with a check.
- It carries a comment naming the upstream issue, and a test proving the runtime shape.
- Adding a file there requires review from a second engineer. The directory should stay nearly empty;
  if it grows, that is a signal to fix or replace the dependency.

### 3.6 What has to change in the code that exists today

Every one of these is a real assertion in the current source, and each is fixed by a step already in
the plan — the type rule is what makes them non-optional rather than nice-to-have:

| Location | Today | Fix |
| -------- | ----- | --- |
| `db/src/repository.ts:45,48,78,240` | `row.provider as ProviderId`, `row.status as RunStatus` | P1.4 — Prisma enums make the cast unnecessary |
| `db/src/repository.ts:29` | List fields round-trip through text and are re-parsed | P1.3 — native `Json` columns parsed by Zod |
| `cli/src/api.ts:42` | `(await response.json()) as T` | Parse against the shared response schema |
| `cli/src/api.ts:119` | `JSON.parse(data) as RunEvent` | **The important one** — unvalidated network input asserted into the event union. Parse with the `RunEvent` schema; a malformed frame should be a handled error, not a mis-typed object flowing into the UI |
| `cli/src/api.ts:35` | `JSON.parse(body) as { error?: string }` | Parse against the shared error envelope from P0.8 |
| `server/src/errors.ts:9–10` | `(error as { statusCode?: number }).statusCode` | Parse the `unknown` catch value with a small Zod schema |
| `db/src/client.ts:20` | `globalThis as unknown as { __scePrisma?: PrismaClient }` | A `declare global` augmentation — typed, not asserted |
| `shared/src/models.ts:62` | `"anthropic" as ProviderId` | `satisfies ProviderId` |
| `cli/src/components/PromptBar.tsx:13` | Cast around an OpenTUI intersection signature | The one plausible `unsafe/` candidate — wrap, validate, test, and link the upstream issue |
| Test files | `as any` in mocks | Typed factories in a shared test-support module |

That is nine assertions in ~1,300 lines. Fixing them is roughly a day, and it is the whole
retrofit — which is precisely why §3 sits before the phases instead of after them.

### 3.7 Exit criteria

`type-coverage` reports ≥ 99.9% strict; zero `any`, `as`, `!`, or `@ts-*` suppressions outside
`packages/shared/src/unsafe/`; every external input reaches domain code through a Zod parser; ids are
branded; `isolatedDeclarations` passes on every package.

---

## 4. The phases

Each phase lists **goal → steps → exit criteria → risks**. Steps are ordered; a step is done when it
is merged with tests. Durations assume 2–3 engineers.

---

### Phase 0 — Engineering foundations (1 week)

**Goal:** make the repo safe to change quickly with more than one person in it. Everything after this
phase depends on a green pipeline existing — and on the §3 type rules being mechanically enforced
before there is a large codebase to retrofit.

**Steps**

1. **Adopt Biome** (`biome.json` at root) for lint + format. Run it once across the tree to settle the
   semicolon inconsistency between `app.ts` and `orchestrator.ts`. Add `bun run lint` / `lint:fix`.
2. **Close the compiler-settings delta from §3.2** in `tsconfig.base.json` — `strict` and
   `noUncheckedIndexedAccess` are already on, so the additions are `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `noImplicitReturns`, `noPropertyAccessFromIndexSignature`,
   `isolatedDeclarations`, and turning `skipLibCheck` off. Then clear the nine existing assertions
   listed in §3.6. Doing this at ~1,300 lines takes about a day; doing it at 20,000 does not.
3. **Wire the type gates** described in §3.4: Biome's `noExplicitAny` / `noNonNullAssertion`,
   type-aware typescript-eslint (`no-unsafe-*`, `consistent-type-assertions: never`),
   `type-coverage --strict --at-least 99.9`, and the banned-token check on the diff. Create
   `packages/shared/src/unsafe/` with a README stating the §3.5 rules, and leave it empty.
4. **Add branded id types and `assertNever`** to `packages/shared`: `RunId`, `TenantId`, `UserId`,
   `CandidateId`, constructed only by their parsers, plus an `assertNever(x: never)` used in every
   exhaustive switch. Both are cheap now and load-bearing for P3's isolation guarantees.
5. **CI workflow** `.github/workflows/ci.yml`: on push/PR — `bun install --frozen-lockfile`,
   `bun run lint`, `bun run typecheck`, `bun run lint:types` (the type-aware pass),
   `bun run type-coverage`, `bun test`, `docker build`. Branch protection requires all of them.
6. **Validate config at boot.** Replace the hand-rolled `num()` in `packages/server/src/env.ts` with a
   Zod schema (`serverEnvSchema`) that parses `process.env` once and fails fast with a readable
   report. Export a typed `config` — this is also the first application of the parse-at-the-boundary
   rule. Do the same for the worker and web packages.
7. **Structured logging.** Introduce `packages/shared/src/logger.ts` (pino or Bun-native JSON) with
   `runId` / `tenantId` / `requestId` fields. Replace `console.error` in `app.ts:onError` and
   `orchestrator.ts`. Add a request-id middleware that echoes `x-request-id`.
8. **Error taxonomy.** Extend `packages/server/src/errors.ts` into a typed `AppError` hierarchy
   (`ValidationError`, `ProviderError`, `QuotaError`, `AuthError`, `InternalError`) each with an HTTP
   status, a stable machine-readable `code`, and a user-safe message. `onError` maps them; internals
   never leak. With `useUnknownInCatchVariables` on, `describeError` becomes a real parser rather than
   a cast — which is the point.
9. **ADR directory** `doc/adr/`, seeded with the four decisions in §0 (Postgres, queue, tenancy model,
   web framework) plus ADR-000 recording the §3 type policy and its one carve-out.
10. **Contributor docs**: `CONTRIBUTING.md` (branch naming, commit style, review rules, the type rules
    and the escape-hatch process) and `doc/runbooks/local-setup.md`.
11. **Secret hygiene:** confirm `.env` stays git-ignored (it is), add `gitleaks` to CI, and document
    which secrets live in which environment's secret store.

**Exit criteria** — CI blocks merges on lint + typecheck + type-aware lint + type-coverage + test +
build; a bad env var fails at boot with a named field; every log line is JSON with a request id;
`type-coverage --strict` reports ≥ 99.9% with an empty `unsafe/` directory; ADRs exist for the five
load-bearing choices.

**Risks** — Biome's first pass is a large diff; land it as one isolated commit before any feature
work. `exactOptionalPropertyTypes` and `isolatedDeclarations` can each surface a surprising amount of
churn in generated Prisma types and AI SDK signatures — if either fights the toolchain, turn that one
flag off, record why in ADR-000, and keep the rest. Budget 2–3 extra days for the retrofit.

---

### Phase 1 — Data platform: Postgres, migrations, real types (1.5 weeks)

**Goal:** a durable, migratable, multi-tenant-ready schema. This is the hardest thing to change later,
so it is done second.

**Steps**

1. **Switch the datasource to Postgres.** `packages/db/prisma/schema.prisma`: `provider = "postgresql"`.
   Drop the libSQL adapter (`@prisma/adapter-libsql`, `@libsql/client`) in favour of the Postgres driver
   adapter. Keep `resolveDatabaseUrl()` in `src/url.ts` but narrow it to Postgres URLs + a clear error
   for leftover `file:` URLs.
2. **Introduce migration history.** Replace `db:push` with `prisma migrate dev` locally and
   `prisma migrate deploy` in CI/CD. Generate the initial migration from the current schema. Remove
   `db:reset --force-reset` from anything that can touch a non-local database.
3. **Fix the JSON columns.** `Synthesis.agreements`, `.disagreements`, `.reviews` are JSON-encoded
   `String` today. Move them to native `Json` columns with Zod parsing at the repository boundary
   (`packages/db/src/repository.ts`). Write a data migration for existing rows.
4. **Replace status strings with enums.** `Run.status` and `Candidate.status` are free-text with the
   allowed values only in a doc comment. Promote both to Prisma `enum`s so the database rejects
   invalid states; keep the shared Zod unions aligned.
5. **Add the tenancy columns now, use them in Phase 3.** `Tenant`, `User`, `Membership`, and
   `Run.tenantId` / `Run.createdByUserId` (nullable at first, backfilled, then required). Index every
   tenant-scoped query path: `@@index([tenantId, createdAt])`.
6. **Add the durable event log.** A `RunEvent` table (`runId`, `seq`, `type`, `payload Json`,
   `createdAt`, unique `[runId, seq]`) so progress survives a restart and any replica can replay a
   stream it did not start. This is the storage the current in-memory buffer is missing.
7. **Add usage and cost tables.** `UsageRecord` (tenant, run, provider, model, input/output tokens,
   cost in micro-cents, timestamp) and a `ModelPrice` registry keyed by model id + effective date.
   Extend `packages/shared/src/models.ts` with per-model pricing.
8. **Large-body strategy.** Answers can be long. Set a size threshold; beyond it, store the body in
   object storage (S3/R2) and keep a pointer column. Keep it behind the repository so callers do not
   care.
9. **Repository hardening.** Every function in `repository.ts` takes an explicit `tenantId` and filters
   on it — no exceptions, enforced by a lint rule or a test that greps for unscoped queries.
10. **Local infra.** `infra/docker-compose.yml` with Postgres + Redis so `bun run dev` has real
    services. Seed script for a demo tenant and a handful of runs.
11. **Backups.** Automated daily snapshots + PITR on the managed Postgres, and a **documented, tested**
    restore procedure in `doc/runbooks/restore.md`. Untested backups are not backups.

**Exit criteria** — `prisma migrate deploy` runs clean from empty to head; every repository call is
tenant-scoped; a restore from snapshot has been performed once against staging and timed.

**Risks** — Postgres + Prisma driver adapters on Bun: verify the exact adapter/driver combination on a
spike branch before committing the whole schema move.

---

### Phase 2 — Durable orchestration and scale-out (2 weeks)

**Goal:** a run survives a deploy, a crash, and a scale event. This is the single biggest structural
change in the plan.

**Steps**

1. **Extract the orchestrator into `packages/worker`.** Move `orchestrator.ts`, `prompts.ts`, and
   `providers.ts` out of `server`. The API's only job becomes: validate → authorize → check quota →
   persist the run → enqueue → return 201.
2. **Pick and wire the queue.** Redis-backed (BullMQ) is the default recommendation — mature retries,
   backoff, scheduling, and a usable dashboard. Alternative if you want one fewer service: a Postgres
   job table with `SELECT … FOR UPDATE SKIP LOCKED` (record the decision in an ADR either way).
3. **Idempotency.** Every job carries an idempotency key; `POST /api/runs` accepts an
   `Idempotency-Key` header. A retried enqueue must never fan out twice — model calls cost money.
4. **Make the pipeline resumable.** Split the run into per-candidate jobs plus a synthesis job that
   waits on them, instead of one monolithic async function. A worker dying mid-fan-out then loses one
   candidate, not the whole run. Persist state transitions before and after each external call.
5. **Move progress onto a durable bus.** Writes go to the `RunEvent` table **and** a Redis Stream. The
   SSE handler in `app.ts` keeps its cursor design but reads from Postgres for backfill and the Redis
   Stream for live tail — so any replica can serve any run's stream. Delete the in-process
   `event-bus.ts` and its TTL.
6. **Token streaming.** Switch candidate calls from `generateText` to `streamText`, emitting
   `candidate.delta` events. The web UI renders tokens live; the CLI can too. A timeout now yields a
   partial answer instead of nothing.
7. **Cancellation.** `POST /api/runs/:id/cancel` sets a cancellation flag the worker observes between
   steps and via `AbortSignal`, so a user closing a tab stops paying for tokens.
8. **Per-provider resilience.** Wrap each provider in a circuit breaker + bulkhead: bounded
   concurrency per provider, open the breaker after N consecutive failures, and mark candidates
   `SKIPPED` with a reason rather than hammering a down API. Respect `Retry-After` on 429s.
9. **Timeouts and budgets end to end.** Keep `PER_MODEL_TIMEOUT_MS` / `EVALUATOR_TIMEOUT_MS`, add a
   whole-run deadline and a per-run token/cost ceiling enforced in the worker.
10. **Graceful shutdown.** SIGTERM: stop accepting jobs, finish or checkpoint in-flight work, close
    the pool. Deploys must not orphan runs — verify by deploying during a load test.
11. **Dead-letter queue + replay.** Failed jobs land in a DLQ with the full context; a documented
    operator command replays them.
12. **Horizontal scale test.** Run 3 API replicas + 3 workers; assert that a run started on replica A
    streams correctly to a client connected to replica C.

**Exit criteria** — killing a worker mid-run loses no work and the run still completes; a rolling
deploy during 50 concurrent runs completes them all; SSE works across replicas; duplicate enqueues
provably do not double-charge.

**Risks** — This is the phase most likely to slip. Keep the old in-process path behind a feature flag
until the queued path passes the chaos tests.

---

### Phase 3 — Identity, tenancy, and access control (1.5 weeks)

**Goal:** know who is asking, and never let one tenant see another's data.

**Steps**

1. **Adopt Clerk** for user identity (web sessions, social + email, MFA), with organizations mapped to
   `Tenant`. Sync users/orgs into Postgres via Clerk webhooks so the database stays the authority for
   ownership and joins.
2. **API authentication middleware** in `packages/server`: verify the session token (web) or an API key
   (CLI, SDK, public API), resolve `{ userId, tenantId, scopes }`, and attach it to the Hono context.
   Anonymous requests get 401 — with a narrow, explicitly-allowlisted set of public routes.
3. **API keys.** `ApiKey` table storing a hash (never the key), prefix, label, scopes, `lastUsedAt`,
   `expiresAt`, `revokedAt`. Show the secret exactly once at creation. Rotation and revocation UI in
   the web app, `sce auth login` / `sce keys` in the CLI.
4. **RBAC.** Roles `owner | admin | member | viewer` on `Membership`, with a single `can(actor, action,
   resource)` helper in `packages/shared`. Authorize in one place, not scattered through routes.
5. **Tenant isolation tests.** A test suite that, for every route, asserts tenant B cannot read, list,
   stream, or delete tenant A's run. This suite is the thing that lets you sleep.
6. **CLI auth.** Device-code or PAT flow, credentials in the OS keychain (falling back to
   `~/.config/sce/credentials.json` with `0600`), `SCE_API_KEY` for CI use.
7. **Lock down CORS.** Replace the `*` default in `env.ts` with an explicit allowlist per environment;
   `*` becomes an error outside development.
8. **Audit log.** Append-only `AuditEvent` for auth, key lifecycle, role changes, deletions, and admin
   actions — with actor, IP, and user agent.

**Exit criteria** — no route serves data without an authenticated principal; the isolation suite is
green and runs in CI; keys can be rotated and revoked with immediate effect.

**Risks** — Webhook-based user sync can drift; add a nightly reconciliation job and alert on mismatch.

---

### Phase 4 — Metering, quotas, and billing (1.5 weeks)

**Goal:** every token is attributed and priced; nobody can bankrupt you with a `curl` loop.

**Steps**

1. **Meter everything.** The worker writes a `UsageRecord` per model call (candidate *and* evaluator)
   with tokens and computed cost from the `ModelPrice` registry. Roll up per tenant per day.
2. **Enforce quotas before the spend.** A pre-flight check in the API: monthly run count, monthly
   token/cost ceiling, and concurrent-run limit per plan. Exceeded → `429` with a typed `QuotaError`
   naming the limit, the current usage, and the reset time.
3. **Rate limits.** Sliding-window limiter in Redis, keyed by API key and by IP, with distinct
   per-route budgets (`POST /runs` is expensive; `GET /runs` is not). Return
   `X-RateLimit-*` + `Retry-After` headers.
4. **Plans and billing.** Free / Pro / Team / Enterprise as data, not code. Clerk Billing (or Stripe)
   for checkout, subscription lifecycle, and invoices; report metered usage for overage. Handle
   webhooks idempotently.
5. **Feature gating.** One `hasEntitlement(tenant, feature)` helper drives both UI affordances and API
   enforcement — never the UI alone.
6. **Cost dashboard.** Per-tenant and global spend by provider/model/day, in the admin surface, with
   a *hard* global daily budget cap that trips a kill switch and pages an operator.
7. **Grace and dunning.** Payment failure → grace period → read-only mode, never silent data loss.

**Exit criteria** — a synthetic tenant hitting its cap is blocked *before* any provider call; reported
usage reconciles with provider invoices to within a documented tolerance; the global cap has been
tripped once on purpose in staging.

**Risks** — Provider price changes silently break cost math. Version `ModelPrice` by effective date and
alert when an unpriced model id appears.

---

### Phase 5 — Web application (3 weeks)

**Goal:** the primary surface. Everything the TUI does, plus what a terminal cannot: sharing, deep
history, side-by-side diffing, and team collaboration.

**Steps**

1. **Scaffold `packages/web`** — Next.js (App Router) inside the Bun workspace, consuming the API
   through the existing typed `hc<AppType>()` client so the contract stays single-sourced.
2. **Design system.** Tailwind + shadcn/ui, tokens for light/dark, a real empty/loading/error state for
   every view. Keep the TUI's visual identity (per-provider accent colours already live in
   `PROVIDERS[].color`).
3. **The ask flow.** Prompt composer with model-panel selection, temperature, and a live cost estimate
   before submitting.
4. **Live run view.** SSE (or WebSocket) subscription rendering per-candidate token streams
   side by side, then the synthesis: final answer, agreements, disagreements, per-model scorecard,
   confidence. Reconnect-safe via the event cursor from Phase 2.
5. **Answer view.** Markdown with syntax highlighting, per-claim provenance back to the candidate that
   supported it, copy/export (MD, PDF), and a **candidate diff** view.
6. **History and search.** Paginated, filterable (date, provider set, confidence, cost), full-text
   search over prompts and answers, folders/tags, and a per-run permalink.
7. **Sharing.** Public read-only share links with optional expiry and revocation — a genuine growth
   loop for a product whose output is a good answer.
8. **Feedback capture.** Thumbs up/down + freeform note per run, stored and fed straight into the
   Phase 7 eval set. This is your cheapest source of ground truth.
9. **Team surfaces.** Org switcher, member management, shared run library, usage/billing pages.
10. **Admin console** (internal): tenant lookup, run inspector, provider health, cost dashboard, kill
    switches, DLQ replay.
11. **Accessibility and performance.** WCAG 2.1 AA, keyboard-first (mirror the TUI's shortcuts), Core
    Web Vitals budget in CI via Lighthouse.
12. **E2E tests.** Playwright across sign-up → ask → stream → share → billing, run against a seeded
    staging environment.

**Exit criteria** — a new user can sign up, ask, watch a run stream, share the result, and see it
billed, with no terminal involved; E2E suite green in CI; AA audit passes.

**Risks** — Scope inflation. Ship views 3–6 first and treat 7–11 as a second slice.

---

### Phase 6 — Public API and TypeScript SDK (1.5 weeks)

**Goal:** the API becomes a product with a contract you are willing to keep.

**Steps**

1. **Version the surface.** Mount routes under `/v1`. Publish a deprecation policy (12 months' notice,
   `Sunset` headers) in `doc/api/versioning.md`.
2. **Generate OpenAPI from the code.** Adopt `@hono/zod-openapi` so the existing Zod schemas in
   `packages/shared` produce the spec — no hand-maintained second source of truth.
3. **Finish the resource model.** Consistent errors (`{ code, message, details, requestId }`), cursor
   pagination everywhere, `Idempotency-Key` on all POSTs, `ETag`/`If-None-Match` on run reads.
4. **Streaming, publicly.** Document the SSE contract and event union formally, including cursor
   semantics and reconnect (`Last-Event-ID`).
5. **Webhooks.** `run.completed`, `run.failed`, `quota.exceeded` — signed (HMAC), retried with
   exponential backoff, with a delivery log and replay in the admin console.
6. **`packages/sdk`.** A published `@sce/sdk`: typed methods, `ask()` with streaming callbacks and
   async iterators, automatic retries with jitter, rate-limit awareness, cancellation, and a Node +
   browser + Bun build. Types generated from the same Zod schemas.
7. **Developer docs.** Quickstart, auth, errors, limits, streaming, webhooks, and a runnable example
   repo. An API playground in the web app.
8. **Compatibility gate in CI.** A schema-diff check fails the build on any breaking change to `/v1`
   that is not accompanied by an explicit override.

**Exit criteria** — a developer who has never seen the codebase goes from key to streamed answer in
under five minutes using only the published docs and SDK; breaking changes cannot merge silently.

**Risks** — Publishing a contract makes it expensive to change. Do not ship `/v1` before the Phase 2
event model is final.

---

### Phase 7 — Answer quality and evaluation (2 weeks, starts in parallel at Phase 2)

**Goal:** protect the actual product thesis — that synthesis beats any single model — and prove it
with numbers instead of vibes.

**Steps**

1. **Build a golden set** in `packages/evals`: 200–500 prompts across factual, reasoning, coding,
   long-form, and adversarial/ambiguous categories, with references or rubrics.
2. **Judge harness.** Score each run on correctness, completeness, calibration, and citation fidelity
   using an LLM judge *plus* a human-labelled subset to measure the judge itself.
3. **Prove the thesis.** Measure synthesis against each single model and a majority-vote baseline.
   Publish the delta — internally at minimum, externally if it is good.
4. **Version the prompts.** Move `packages/server/src/prompts.ts` into versioned records with ids
   persisted on each run, so any answer can be traced to the exact prompt that produced it.
5. **Regression gate.** A nightly (and pre-release) eval run; a quality drop beyond a threshold blocks
   the release, exactly like a failing test.
6. **Panel experimentation.** Config-driven panels: swap members, add a 4th, change the evaluator, run
   n-of-1 self-consistency on a single model. A/B by tenant cohort with results in the admin console.
7. **Confidence calibration.** The synthesis emits a confidence today; check it against measured
   accuracy and recalibrate so the number means something.
8. **Caching and dedup.** Cache identical (prompt, panel, temperature) tuples with a TTL, and use
   semantic near-duplicate detection to skip redundant fan-outs — a direct, large cost win.
9. **Close the feedback loop.** Route Phase 5 thumbs-down runs into an eval triage queue.

**Exit criteria** — a published quality delta vs. the best single model; the nightly gate has caught at
least one real regression; cache hit rate and its cost saving are on a dashboard.

**Risks** — Judge bias toward the model family that judges. Rotate judges and keep the human subset.

---

### Phase 8 — Observability, reliability, and cost (1.5 weeks, starts in parallel at Phase 0)

**Goal:** know it is broken before the user tells you, and know exactly which of six moving parts did it.

**Steps**

1. **OpenTelemetry end to end.** One trace per run spanning API → queue → worker → each provider call →
   synthesis → persistence. The AI SDK's telemetry hooks make provider spans nearly free.
2. **Metrics that matter.** Run throughput, end-to-end latency (p50/p95/p99), per-provider latency and
   error rate, candidate success rate, synthesis failure rate, queue depth and age, token spend per
   minute, cache hit rate, SSE connection count.
3. **Dashboards** per audience: service health, provider health, cost, and product (runs per tenant,
   confidence distribution, feedback).
4. **SLOs and alerts.** e.g. 99.5% availability on `POST /v1/runs`, p95 run completion under 90s,
   error budget tracked. Page on SLO burn, queue age, DLQ growth, provider breaker open, and budget
   threshold — not on individual errors.
5. **Log pipeline.** Structured JSON → aggregator, with PII redaction on prompt/answer fields and a
   defined retention window.
6. **Runbooks** in `doc/runbooks/`: provider outage, queue backlog, database failover, cost spike,
   bad deploy rollback, DLQ replay. Each one names the dashboard and the exact commands.
7. **Load and chaos testing.** k6 profiles for steady state and burst; chaos drills that kill workers,
   stall a provider, and sever Redis mid-run. Record measured capacity per instance size.
8. **Staging environment** that mirrors production, with seeded data and synthetic traffic.
9. **Deploy pipeline.** `.github/workflows/deploy.yml`: migrate → deploy → smoke test → auto-rollback
   on health-check failure. Migrations always backward-compatible (expand/contract) so rollback is real.

**Exit criteria** — one trace shows a whole run across all services; every alert has a runbook; a
staged rollback has been executed successfully; documented capacity numbers exist.

---

### Phase 9 — Security, compliance, and launch (2 weeks; checklist accumulates from Phase 0)

**Goal:** be safe to point at the public internet, and safe to sell to a company with a security
questionnaire.

**Steps**

1. **Threat model** the whole system (STRIDE), with prompt injection, data exfiltration via crafted
   prompts, and cross-tenant leakage as first-class threats.
2. **Input defence.** Prompt length caps, content-policy filtering, injection heuristics on prompts,
   and treating model output as untrusted data — never as instructions or as HTML.
3. **Output safety.** Sanitize rendered Markdown (no raw HTML/script), strip or proxy remote images,
   and never auto-execute anything a model returns.
4. **Secrets management.** Move from `.env` files to the platform secret store, with rotation
   procedures for every provider key and a break-glass revocation runbook.
5. **Transport and storage.** TLS everywhere, encryption at rest, tenant-scoped object-store paths,
   signed short-lived URLs for exports.
6. **Abuse controls.** Sign-up bot defence, per-IP limits, anomaly detection on spend, and an account
   suspension path.
7. **Privacy and retention.** A published data-handling policy: what is stored, for how long, whether
   prompts reach providers for training (disable where possible), and per-tenant retention settings.
   Implement data export and hard delete (GDPR Art. 15/17), including from backups within the stated
   window.
8. **Dependency and supply chain.** Dependabot/Renovate, `bun audit` in CI, SBOM generation, pinned
   base images.
9. **External review.** Third-party penetration test; fix criticals and highs before GA.
10. **Compliance groundwork** if selling to enterprises: SOC 2 Type I control mapping, DPA template,
    subprocessor list (each model provider is one), status page, security contact and disclosure policy.
11. **Launch.** Private beta → public beta → GA, each gated on the SLO dashboard and the eval gate.
    Support rota, incident process, and a `doc/runbooks/incident.md` before the first external user.

**Exit criteria** — pen-test criticals/highs closed; export and delete work end to end and are tested;
status page live; incident process rehearsed once.

---

## 5. Timeline

Sequential critical path is roughly **11 weeks**; with 2–3 engineers parallelising P3/P7/P8, the
realistic calendar is **13–16 weeks** including slack.

```
Week   1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
P0    ██
P1       ███
P2          █████
P3             ███
P4                ███
P5                   █████████
P6                         ███
P7          ████████████
P8    ██████████████████████████████
P9                            ██████
GA                                  ▲
```

**Milestones**

| Milestone | Phases done | Meaning |
| --------- | ----------- | ------- |
| **M1 — Hardened core** | P0–P2 | Durable, restart-safe, horizontally scalable engine |
| **M2 — Multi-tenant** | P3–P4 | Real users, isolation, quotas, revenue path |
| **M3 — Product** | P5–P6 | Web app + public API + SDK shipped to beta |
| **M4 — GA** | P7–P9 | Proven quality, observable, secure, supported |

---

## 6. What to cut if time is short

In this order — each cut costs something specific, named here so the trade is explicit.

1. **Billing (P4 partial)** — keep metering and quotas, defer plans/Stripe. *Cost: no revenue, but no
   runaway spend either.*
2. **Webhooks + SDK polish (P6)** — ship OpenAPI and a documented REST surface first. *Cost: harder
   integration for early API users.*
3. **Panel A/B experimentation (P7.6)** — keep the golden set and the regression gate. *Cost: slower
   quality iteration.*
4. **Admin console (P5.10)** — operate with SQL and CLI scripts for a while. *Cost: engineer time per
   support request.*
5. **SOC 2 groundwork (P9.10)** — only if you are not selling to enterprises yet. *Cost: closes
   enterprise deals until done.*

**Never cut:** the §3 type rules and their CI gates (P0.2–P0.4), migrations (P1.2), tenant isolation
tests (P3.5), idempotency (P2.3), the global budget cap (P4.6), backups with a tested restore
(P1.11), or output sanitization (P9.3). Each of these is cheap now and a genuine incident later — and
the type gates are the only item on this list whose cost *grows* every week they are deferred.

---

## 7. Immediate next steps

The first five things, in order, none of which depend on the open questions:

1. Confirm or correct the four assumptions in §0 (tenancy, billing, infra, team).
2. Land Biome + the strict compiler settings + the type gates (P0.1–P0.4) as one isolated commit,
   before any feature work — this is the cheapest it will ever be.
3. Land CI (P0.5) so those gates start blocking merges.
4. Spike Prisma 7 + Postgres driver adapter on Bun (P1 risk) — timebox to one day.
5. Write ADR-000 (the type policy), ADR-001 (Postgres), ADR-002 (queue choice),
   ADR-003 (Clerk + org-as-tenant), ADR-004 (Next.js for `packages/web`).
6. Start P1.1–P1.4 (datasource, migrations, JSON columns, enums) — the schema work everything blocks on.
