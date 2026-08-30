# Self-Consistency Answer Engine

Ask one question. It goes to **OpenAI**, **Claude** and **Gemini** in parallel. Claude then reads
all three answers, scores them, resolves their conflicts, and writes a single merged answer that is
better than any individual response.

The final answer is never a copy of one model's output — it is synthesised from the strongest parts
of every candidate, with wrong claims dropped.

```
                     ┌──────────────┐
                     │  OpenTUI CLI │  ← type a question, watch it unfold
                     └──────┬───────┘
                     Hono RPC + SSE
                     ┌──────┴───────┐
                     │  API  (N×)   │  stateless: validate → persist → enqueue
                     └──┬────────┬──┘
             enqueue    │        │   subscribe to the run's progress
              ┌─────────┴──┐  ┌──┴──────────────┐
              │   Queue    │  │  Progress bus   │  Redis Streams (live tail)
              │  (BullMQ)  │  │   + Postgres    │  Postgres (durable replay)
              └─────────┬──┘  └─────────────────┘
                     ┌──┴───────────┐
                     │ Worker (M×)  │  one job per candidate, one per synthesis
                     └──────┬───────┘
              ┌────────────┼────────────┐        fan-out (parallel, streaming)
        ┌─────┴────┐ ┌─────┴────┐ ┌─────┴────┐
        │  OpenAI  │ │  Claude  │ │  Gemini  │
        └─────┬────┘ └─────┬────┘ └─────┬────┘
              └────────────┼────────────┘
                    ┌──────┴───────┐
                    │  Evaluator   │              synthesis (Claude Opus)
                    │ compare→merge│
                    └──────┬───────┘
                    ┌──────┴────────┐
                    │Prisma/Postgres│             every run is persisted
                    └───────────────┘
```

A run survives a deploy, a crash and a scale event. The API never calls a model, so it restarts
freely; the worker drains its in-flight jobs on `SIGTERM`; and progress lives in Postgres and Redis
rather than in one process's memory, so **any** API replica can stream **any** run — including one
started on a machine that has since been replaced.

---

## Quick start

```bash
bun install                     # install the workspace
cp .env.example .env            # add at least one provider key
bun run db:up                   # start Postgres + Redis (Docker)
bun run db:migrate              # create the schema
bun run db:seed                 # optional: a demo tenant and a few runs
bun run auth:bootstrap          # mint the first API key and store it for the CLI

bun run dev                     # API + worker + TUI together, one terminal
```

The API is closed to anonymous callers, so `auth:bootstrap` is what gets you in: it mints a real key
for the default workspace and writes it to the CLI's credential store. It is deliberately not a
dev-mode bypass in the auth middleware — a bypass would mean production runs different
authentication code from development, and the branch nobody exercises is the one that ships enabled.

For human sign-in through a browser instead, connect Clerk (`doc/runbooks/clerk-setup.md`) and run
`sce auth login`.

`dev` uses [concurrently](https://github.com/open-cli-tools/concurrently) in `--raw` mode, which is
the only mode that hands a child real stdio — OpenTUI needs a genuine TTY for raw-mode input and the
alternate screen. The API's and worker's output would otherwise paint straight over the interface, so
both are redirected to `node_modules/.cache/` (outside the watched tree) with their stdin closed so
they never compete for keystrokes. Follow them in a second terminal with `bun run dev:logs`, or run
the parts separately with `bun run dev:server`, `bun run dev:worker` and `bun run dev:cli`. Quitting
the TUI stops the rest via `--kill-others`.

To run everything in one process instead — no queue, no scale-out, but nothing else to start — set
`RUN_TRANSPORT=local` and use `bun run dev:server` on its own.

Or ask straight from the shell:

```bash
bun run ask "Explain CRDTs and when they beat operational transforms"
```

### Credentials

You need **either** individual provider keys **or** one Vercel AI Gateway key:

| Variable                       | Enables                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `OPENAI_API_KEY`               | the OpenAI panel member                                           |
| `ANTHROPIC_API_KEY`            | the Claude panel member **and the evaluator**                     |
| `GOOGLE_GENERATIVE_AI_API_KEY` | the Gemini panel member                                           |
| `AI_GATEWAY_API_KEY`           | all three, via [Vercel AI Gateway](https://vercel.com/ai-gateway) |

Direct keys win when both are present. A provider with no credentials is marked `SKIPPED` and the
run continues without it — you only need one to get started, though the technique needs at least two
to be interesting. The evaluator needs Anthropic (directly or through the gateway); without it a run
fails with a clear message rather than silently returning one model's answer.

Every model id is overridable — see `.env.example`.

---

## Repository layout

A Bun workspace with six packages:

| Package           | Role                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Zod schemas, domain types, the model registry, the run-event union, job payloads, provider availability. One source of truth. |
| `packages/db`     | Prisma schema, migrations and a tenant-scoped repository. Postgres everywhere, via the Prisma `pg` driver adapter.           |
| `packages/queue`  | The Redis control plane: BullMQ queues and flows, the durable progress bus, cancellation, the dead-letter queue.             |
| `packages/server` | Hono app: RPC routes, idempotency, cancellation, the SSE fan-in. Never calls a model.                                       |
| `packages/worker` | The orchestrator: candidate and synthesis job processors, streaming, budgets, circuit breakers, the deadline reaper.         |
| `packages/cli`    | OpenTUI + React terminal client, talking to the server over the typed Hono RPC client.                                      |

---

## How a run works

1. **`POST /api/runs`** seeds a `Run` row plus one `Candidate` row per panel member, enqueues the
   work, and returns. The API's job ends there — it never waits on a model, so its latency is a
   database write and a Redis round trip no matter how long the answer takes.
2. **Fan-out.** A run is enqueued as a **flow**: one candidate job per panel member, and a synthesis
   job the queue holds until all of them settle. They spread across the whole worker pool, are called
   with the same prompt and the same system prompt, and never see each other's output — that
   independence is what makes later agreement meaningful. Each job settles its own row, so one
   provider erroring, timing out or returning empty text cannot take down the others, and a worker
   that dies loses **one candidate**, not the run.
3. **Streaming.** Candidates are generated with `streamText`, emitting `candidate.delta` events as
   tokens arrive. A call cut short by a timeout or a cancellation now yields the partial answer it did
   produce, recorded next to the reason it stopped.
4. **Synthesis.** The successful candidates are handed to the evaluator (Claude Opus by default)
   with the original question. It returns a structured object — agreements, disagreements,
   per-candidate scores with concrete strengths and weaknesses, a confidence value, and the merged
   final answer.
5. **Persistence.** Everything is written to the database as it happens, so history survives
   restarts and a browsable archive comes for free.

Progress goes to a **durable bus**: the append-only `RunEvent` table in Postgres for replay, and a
Redis Stream per run for the live tail. `GET /api/runs/:id/events` streams it as SSE with the durable
sequence number as the event id, so `Last-Event-ID` (or `?afterSeq=`) resumes exactly where a client
left off — from any replica, after any restart, with no gap and no duplicate. See
[ADR-004](doc/adr/0004-durable-progress-bus.md) for why the ordering of the two writes is what makes
that guarantee hold.

**Idempotency.** `POST /api/runs` accepts an `Idempotency-Key` header; a retry returns the run the
first attempt created, with `200` instead of `201`. Uniqueness is enforced by a database index, and
the queue's job ids are deterministic, so neither a retried request nor a retried enqueue can fan out
a second, identically expensive panel.

**Cancellation.** `POST /api/runs/:id/cancel` stops a run: the database flag is authoritative, and a
Redis pub/sub message aborts an in-flight model call within a moment rather than at the next
checkpoint. Closing a tab stops costing tokens.

### Failure handling

| Situation                       | Behaviour                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------- |
| One model errors or times out   | That candidate is marked `ERROR` with the reason; the run continues.            |
| A model returns empty text      | Treated as a failure, not a valid candidate.                                    |
| No credentials for a provider   | Candidate marked `SKIPPED` with a hint naming the env var to set.               |
| Every model fails               | Run marked `FAILED`, listing each provider's reason.                            |
| Evaluator fails                 | Run marked `FAILED` — candidate answers are kept and still viewable.            |
| Evaluator hits the token cap    | Explicit "raise `MAX_OUTPUT_TOKENS`" message instead of an opaque parser error. |
| Server unreachable from the CLI | Status bar names the URL and the command to start it.                           |
| SSE stream drops mid-run        | The CLI falls back to a one-shot `GET /api/runs/:id`.                           |

---

## API

Base URL `http://localhost:8787`. The CLI consumes these through `hc<AppType>()`, so route paths,
inputs and response shapes are type-checked end to end.

Everything that touches tenant data requires `Authorization: Bearer <credential>`. The public
surface is four routes, and each is public for a reason you can state:

| Public route          | Why it has to be                                                        |
| --------------------- | ----------------------------------------------------------------------- |
| `GET /api/health`     | A liveness probe must not touch the database or Clerk.                  |
| `GET /api/providers`  | Answered from configuration; reveals no tenant's anything.              |
| `GET /api/auth/config` | The OAuth discovery document `sce auth login` reads *before* it has a credential. |
| `POST /api/webhooks/clerk` | The caller is Clerk, which holds no credential of ours — it is authenticated by Svix signature instead. |

| Route                        | Purpose                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/health`            | Liveness probe. Reports the active transport.                                    |
| `GET /api/providers`         | Which panel members are usable and how they are reached (`direct` / `gateway`).  |
| `GET /api/auth/config`       | OAuth issuer + public client id, so a CLI needs no configuration of its own.     |
| `GET /api/auth/whoami`       | The principal behind the current credential: tenant, user, role, scopes.         |
| `POST /api/runs`             | `{ prompt, providers?, temperature? }` → the queued run. `Idempotency-Key` honoured. |
| `GET /api/runs`              | `?limit&cursor` → run history, newest first.                                     |
| `GET /api/runs/:id`          | Full run: candidates + synthesis.                                                |
| `POST /api/runs/:id/cancel`  | `{ reason? }` → stop a run in flight.                                            |
| `GET /api/runs/:id/events`   | SSE progress stream. `Last-Event-ID` or `?afterSeq=` resumes from a cursor.       |
| `DELETE /api/runs/:id`       | Delete a run and its children.                                                   |
| `GET /api/usage`             | Spend, plan limits and entitlements for the calling tenant.                      |
| `GET /api/usage/daily`       | `?from&to` → per-day, per-model spend. Requires the `usage.daily` entitlement.   |
| `GET /api/billing`           | Subscription, access mode and the plan catalogue.                                |
| `GET /api/audit`             | The append-only audit trail. Owners and admins.                                  |
| `GET /api/keys`              | List API keys. Secrets are never returned.                                       |
| `POST /api/keys`             | `{ name, scopes?, expiresInDays? }` → a key, shown exactly once.                 |
| `DELETE /api/keys/:id`       | Revoke a key, effective immediately.                                             |
| `POST /api/webhooks/clerk`   | Clerk → Postgres identity sync. Svix-signed, idempotent, order-independent.      |

```bash
export SCE_API_KEY=$(...)   # from `bun run auth:bootstrap`
AUTH="authorization: Bearer $SCE_API_KEY"

curl -s localhost:8787/api/providers | jq

RUN=$(curl -s -X POST localhost:8787/api/runs \
  -H "$AUTH" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: my-request-0001' \
  -d '{"prompt":"Why is the sky blue?"}' | jq -r .run.id)

# Watch it. Kill the connection and re-run with ?afterSeq=<last id> to resume.
curl -N -H "$AUTH" localhost:8787/api/runs/$RUN/events

curl -s -X POST localhost:8787/api/runs/$RUN/cancel -H "$AUTH" \
  -H 'content-type: application/json' -d '{"reason":"never mind"}' | jq
```

### Identity and access

Two credential kinds reach the API, and they are for different callers:

| Credential | Who | How it is obtained |
| ---------- | --- | ------------------ |
| **OAuth access token** | a human at a terminal | `sce auth login` — authorization code + PKCE (`S256`), loopback redirect on an ephemeral `127.0.0.1` port (RFC 8252 §7.3) |
| **Session token** | the web app (Phase 5) | a Clerk browser session |
| **API key** | CI, scripts, the SDK | `sce keys create <name>`, or `bun run auth:bootstrap` for the first one |

Authorization is the conjunction of two independent things, and keeping them independent is the
design: a **role** (`owner` / `admin` / `member` / `viewer`) is what a *person* may do inside a
tenant; a **scope** (`runs:read`, `keys:write`, …) is what *this credential* may do on their behalf.
`can(actor, permission, resource)` in `@sce/shared` requires both to agree — so an owner holding a
read-only key still cannot start a run, and a leaked CI token is not an account takeover.

Two consequences worth knowing:

- **A key's role is its creator's current role**, read at verification time rather than stored. So
  demoting someone demotes their keys, and removing them from the tenant kills their keys, without
  anyone having to remember they exist.
- **A resource in another tenant answers `404`, never `403`.** A 403 would confirm the id is real,
  which turns a list of guessed ids into a census of another tenant's runs.

```bash
sce auth login --org acme       # browser sign-in, acting inside one organization
sce auth status                 # tenant, role and scopes of the current credential
sce keys create ci --scopes runs:read,runs:write --days 90
sce keys revoke <key-id>
```

See `doc/runbooks/clerk-setup.md` for connecting Clerk, and
`doc/adr/0005-clerk-identity-and-org-as-tenant.md` for why it is built this way.

### Plans, quotas and spend

Every run costs money at a provider, so three independent brakes sit in front of one:

| Brake | Scope | Refusal |
| ----- | ----- | ------- |
| **Per-run ceiling** | one run | candidates settle `SKIPPED`; the run `FAILED` |
| **Plan quota** | one tenant, one calendar month | `429 quota_exceeded` |
| **Rate limit** | one credential (and one IP), per minute | `429 rate_limited` |
| **Subscription state** | one tenant | `402 payment_required` once dunning runs out |
| **Global daily cap** | the whole install, one UTC day | `503 budget_exhausted` |

Plans are **data**, not branches — `PLANS` in `@sce/shared`:

| Plan | Runs / month | Tokens / month | Spend / month | Concurrent | Features |
| ---- | ------------ | -------------- | ------------- | ---------- | -------- |
| Free | 50 | 500K | $5 | 1 | — |
| Pro | 1,000 | 20M | $100 | 5 | custom panel, API keys, daily usage |
| Team | 10,000 | 200M | $1,000 | 20 | + webhooks, priority queue |
| Enterprise | unlimited | unlimited | unlimited | 100 | all |

The same record drives the API's enforcement *and* a client's affordances, so the two cannot drift:
`GET /api/usage` returns the tenant's position against each limit, computed by the same function that
will refuse their next request.

The check happens **before** the spend — a quota discovered after three provider calls have been paid
for is a report, not a limit — and the monthly ceiling is carried *into* a run by narrowing the
per-run ceilings stamped on the row, so one enormous run cannot spend a whole month's allowance.

Every refusal carries a machine-readable `code` and a typed body, because an HTTP status cannot tell
"out of monthly runs" from "too many requests per minute" — both are `429`:

```jsonc
{
  "error": "Monthly run limit reached — 50 of 50 runs on the Free plan.",
  "code": "quota_exceeded",
  "quota": {
    "limit": "monthly_runs", "used": 50, "ceiling": 50, "remaining": 0,
    "resetAt": "2026-09-01T00:00:00.000Z", "plan": "free", "upgradeTo": "pro"
  }
}
```

Billing rides on the same Svix-signed webhook as identity: Clerk is the authority on what was paid,
this database on what that entitles a tenant to do. A failed payment opens a grace window
(`BILLING_GRACE_PERIOD_DAYS`); after it the workspace is **read-only** — every GET still works and
nothing is ever hidden or deleted.

Above all of it is one install-wide daily cap. Reaching it engages a persisted, latching kill switch
that both the API and the workers observe, and only an operator releases it:

```bash
bun run ops spend                      # today's spend, the switch, the biggest spenders
bun run ops halt --reason "runaway"    # stop the install from starting new runs
bun run ops resume                     # release it
```

See `doc/runbooks/cost.md` for the incident procedures and
`doc/adr/0006-plans-quotas-and-billing.md` for why each brake exists.

### Run events

| Event                | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `run.snapshot`       | The full run as it stood when you subscribed.                          |
| `run.status`         | `QUEUED` → `FANNING_OUT` → `SYNTHESIZING`.                             |
| `candidate.started`  | A panel member's call has begun.                                       |
| `candidate.delta`    | A chunk of an answer as it is generated. **Ephemeral** — never replayed. |
| `candidate.settled`  | That panel member's final row: `OK`, `ERROR`, `SKIPPED` or `CANCELED`. |
| `synthesis.started`  | The evaluator pass has begun.                                          |
| `synthesis.settled`  | Agreements, disagreements, scorecard, confidence, final answer.        |
| `run.completed` / `run.failed` / `run.canceled` | Terminal. The stream ends.                  |

Every event except `candidate.delta` is written to the durable log and carries a sequence number as
its SSE `id`. Deltas carry no id: the `candidate.settled` that follows has the complete text, so a
client that reconnects mid-candidate loses animation, not content.

---

## The TUI

```
 █▀▀ █▀▀ █▀▀
 ▄▄█ █▄▄ ██▄
 Self-Consistency Answer Engine  ● OpenAI  ● Claude  ● Gemini  ⚖ claude-opus-5   http://localhost:8787
╭─ ask ───────────────────────────────────────────────────────────────────────────────────────────────╮
│ ❯ Why is the sky blue?                                                                              │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ panel ─────────────────────────────────────────────────────────────────────────────────────────────╮
│ ✔ OpenAI   gpt-5.5                 1.4s 20in / 90out                                                │
│ ✔ Claude   claude-sonnet-5         1.8s 20in / 110out                                               │
│ ✖ Gemini   gemini-3.7-flash       300ms — HTTP 429: rate limited                                    │
│ · Final answer ready · confidence 92% · total 4.2s                                                  │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯
  Final Answer   Analysis   OpenAI   Claude   Gemini
```

**Final Answer** renders the merged reply as Markdown. **Analysis** shows where the models agreed,
where they conflicted, and a scorecard with per-model strengths and weaknesses. The remaining tabs
show each model's raw answer, so you can check the synthesis against its sources.

| Key     | Action             | Key     | Action            |
| ------- | ------------------ | ------- | ----------------- |
| `enter` | ask                | `esc`   | browse answers    |
| `←` `→` | switch tabs        | `↑` `↓` | scroll            |
| `i`     | back to the prompt | `^h`    | history           |
| `^n`    | new run            | `^r`    | retry last prompt |
| `^c`    | quit               |         |                   |

---

## Scripts

| Command                    | Effect                                     |
| -------------------------- | ------------------------------------------ |
| `bun run dev`              | API + worker + TUI concurrently, hot reload |
| `bun run dev:logs`         | Tail the API and worker logs during `dev`  |
| `bun run dev:server`       | API only, with hot reload                  |
| `bun run dev:worker`       | Worker only, with hot reload               |
| `bun run dev:cli`          | TUI only, with hot reload                  |
| `bun run ask "<question>"` | TUI, pre-loaded with a question            |
| `bun run db:up` / `db:down`| Start / stop local Postgres + Redis         |
| `bun run db:nuke`          | Stop them and delete the volumes           |
| `bun run db:migrate`       | Create and apply a migration (local)       |
| `bun run db:deploy`        | Apply pending migrations (any environment) |
| `bun run db:status`        | Which migrations are applied               |
| `bun run db:seed`          | Demo tenant, demo runs, model price list   |
| `bun run db:studio`        | Browse the database                        |
| `bun run auth:bootstrap`   | Mint the first API key for a fresh install |
| `bun run auth:reconcile`   | Repair Clerk↔Postgres drift; exits non-zero if it found any |
| `bun run dlq <command>`    | Queue depth, dead letters, replay, reap    |
| `bun run scale-test`       | Multi-process scale and chaos drill        |
| `bun test`                 | Full suite                                 |
| `bun run typecheck`        | `tsc --noEmit` across every package        |

### Tests

214 tests, no API keys and no network required — every model call runs against
`MockLanguageModelV4`, and the OAuth flow runs against a stub authorization server on loopback. Run `bun run db:up` first: the database, queue and bus suites exercise the
real Postgres and Redis, because what they assert (enum enforcement, cascades, flow ordering, the
backfill/tail join) is precisely what a mock cannot get wrong. `test-setup.ts` moves the suite onto
its own Redis namespace, so a `bun run dev` fleet in another terminal cannot claim its jobs.

- `packages/worker/src/pipeline.test.ts` — fan-out, partial failure, total failure, evaluator
  failure, provider subsets, review backfill, token streaming, redelivery, cancellation mid-stream,
  deadline and budget ceilings, retry classification, the circuit breaker.
- `packages/queue/src/bus.test.ts` — the progress bus, every assertion run against **both**
  transports: sequence numbers, cursor resume, the backfill/tail join, ephemeral deltas, and one
  instance publishing to another instance's subscriber.
- `packages/queue/src/queues.test.ts` — real BullMQ: flow ordering, duplicate enqueue as a no-op,
  a job exhausting its attempts into the DLQ, and replaying it back out.
- `packages/server/src/app.test.ts` — routing, validation, idempotency, cancellation, SSE framing,
  cursor resume, 404s.
- `packages/cli/src/App.test.tsx` — headless render of the real TUI: idle screen, a run streaming to
  completion, tab switching.
- `packages/cli/src/components/Header.test.tsx` — which header items survive as the terminal narrows.
- `packages/db/src/repository.test.ts` — enum enforcement, JSON round-trips, large-body offload,
  the durable event log, pricing and usage totals — against real Postgres.
- `packages/db/src/isolation.test.ts` — for every repository function, tenant B cannot read, list,
  stream, mutate or delete tenant A's run.
- `packages/db/src/repository.scoping.test.ts` — static check that no new query can skip its
  `tenantId` filter.
- `packages/shared/src/providers.test.ts` — direct key beats gateway, panel subsets, and the
  evaluator keeping its own model rather than inheriting the panel member's.
- `packages/shared/src/env-file.test.ts` — root `.env` discovery and parsing.

The multi-process drill is separate, because it makes real model calls:

```bash
bun run scale-test --apis 3 --workers 3 --runs 12
```

It starts real API and worker processes, starts each run on one replica and watches it on **another**,
`SIGKILL`s a worker mid-fan-out and `SIGTERM`s an API replica, and asserts every run still completes.

---

## Deploying

The server is a plain Bun HTTP app; the CLI points at it via `SCE_SERVER_URL`.

### 1. Database

Postgres, everywhere. Locally, `bun run db:up` starts the Postgres and Redis in
`infra/docker-compose.yml`; `DATABASE_URL` then defaults to that instance, and is **required** when
`NODE_ENV=production`.

```bash
bun run db:up        # start Postgres + Redis
bun run db:migrate   # apply migrations (creates one when the schema changed)
bun run db:seed      # a demo tenant, a few runs, and the model price list
```

Schema changes ship as migrations, never as `db push`: `prisma migrate dev` locally,
`prisma migrate deploy` on the way to any other environment. `fly.toml` runs the latter as its
release command, so a failed migration aborts the deploy instead of starting a server against the
wrong schema.

Answer bodies over `LARGE_BODY_THRESHOLD_BYTES` (32 KiB by default) are written to object storage
under a `tenants/<id>/` prefix and the row keeps a pointer; the repository hydrates them on read, so
nothing above it knows the difference.

Backups and the tested restore procedure are in [`doc/runbooks/restore.md`](doc/runbooks/restore.md).

### 2. Redis

The queue and the live progress tail both use Redis. `bun run db:up` starts one locally; in
production point `REDIS_URL` at a managed instance (Upstash, Fly Redis, ElastiCache).

Both the API and the worker ping Redis at boot and refuse to start without it, so a bad `REDIS_URL`
fails the health check instead of failing a user's first request.

### 3. API and worker

One image, two roles. They share every dependency and every line of the schema, so building them
separately would only create a way for two halves of a deploy to disagree about what a `Run` is.

```bash
docker build -t sce .

docker run -p 8787:8787 --env-file .env sce                              # API
docker run --env-file .env sce bun run packages/worker/src/index.ts      # worker
```

Fly.io (`fly.toml` is included, with `api` and `worker` process groups):

```bash
fly launch --no-deploy
fly postgres create --name sce-db && fly postgres attach sce-db   # sets DATABASE_URL
fly redis create                                                  # then: fly secrets set REDIS_URL=…
fly secrets set ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GOOGLE_GENERATIVE_AI_API_KEY=…
fly deploy
fly scale count api=3 worker=3
```

The two scale on different signals — the API on request rate, the worker on queue depth — which is
the deployment shape the whole phase exists to enable.

Any Docker host works the same way: run the two commands above as two services. Set `PORT`,
`HOST=0.0.0.0`, `DATABASE_URL`, `REDIS_URL` and the provider secrets; point the API's health check at
`/api/health`.

For a single machine, `EMBED_WORKER=true` runs the worker inside the API process; `RUN_TRANSPORT=local`
drops Redis entirely (one replica only, and it says so at boot).

> SSE streams stay open for the length of a run. Behind a proxy, make sure response buffering is off
> and the idle timeout exceeds `RUN_DEADLINE_MS`.
>
> Give the worker enough time to drain on `SIGTERM` — it waits for its in-flight jobs, up to
> `SHUTDOWN_TIMEOUT_MS`, which is what keeps a rolling deploy from orphaning runs.

Operations — backlog, dead letters, a Redis outage, cancellation, deploys — are in
[`doc/runbooks/queue.md`](doc/runbooks/queue.md).

### 4. Client

```bash
SCE_SERVER_URL=https://your-app.fly.dev bun run cli
```

Or ship a standalone binary:

```bash
bun build packages/cli/src/index.tsx --compile --outfile sce
```

---

## Configuration

Every variable is parsed with Zod at boot. A bad value stops the process and names the field, rather
than being silently swapped for a default at the first request that needed it.

| Variable                    | Default                 | Meaning                                        |
| --------------------------- | ----------------------- | ---------------------------------------------- |
| `DATABASE_URL`              | local Postgres          | Required in production                         |
| `REDIS_URL`                 | `redis://localhost:6379`| Queue and progress bus                         |
| `RUN_TRANSPORT`             | `redis`                 | `redis` (scalable) or `local` (one process)    |
| `REDIS_NAMESPACE`           | `sce`                   | Key prefix; lets environments share an instance |
| `PORT` / `HOST`             | `8787` / `0.0.0.0`      | API bind                                       |
| `CORS_ORIGIN`               | `*`                     | Allowed origins for `/api/*`; `*` is refused in production |
| `EMBED_WORKER`              | `false`                 | Run the worker inside the API process          |
| `QUEUE_CONCURRENCY`         | `8`                     | Candidate jobs per worker                      |
| `QUEUE_MAX_ATTEMPTS`        | `3`                     | Deliveries before a job is dead-lettered       |
| `PER_MODEL_TIMEOUT_MS`      | `120000`                | Budget per panel member                        |
| `EVALUATOR_TIMEOUT_MS`      | `180000`                | Budget for synthesis                           |
| `RUN_DEADLINE_MS`           | `600000`                | Budget for the whole run                       |
| `RUN_MAX_TOTAL_TOKENS`      | `400000`                | Per-run token ceiling; `0` disables            |
| `RUN_MAX_COST_MICRO_CENTS`  | `50000000`              | Per-run cost ceiling ($0.50); `0` disables     |
| `GLOBAL_DAILY_BUDGET_MICRO_CENTS` | `25000000000`     | Install-wide daily spend cap ($250). Reaching it engages the kill switch; `0` disables |
| `GLOBAL_BUDGET_REFRESH_MS`  | `15000`                 | How long the API caches today's spend figure   |
| `KILL_SWITCH_REFRESH_MS`    | `10000`                 | How long a worker caches the kill-switch state |
| `BILLING_GRACE_PERIOD_DAYS` | `7`                     | Dunning window after a failed payment before a workspace goes read-only |
| `USAGE_ROLLUP_INTERVAL_MS`  | `300000`                | Daily usage rollup sweep; `0` disables (reporting only) |
| `RATE_LIMIT_ENABLED`        | `true`                  | Per-route request budgets                      |
| `RATE_LIMIT_WINDOW_MS`      | `60000`                 | The sliding window every budget is measured over |
| `RATE_LIMIT_RUNS_PER_WINDOW` | `20`                   | `POST /api/runs`, per credential               |
| `RATE_LIMIT_READS_PER_WINDOW` | `300`                 | Reads, per credential                          |
| `RATE_LIMIT_RUNS_PER_IP_PER_WINDOW` | `60`            | `POST /api/runs`, per client IP                |
| `PROVIDER_MAX_CONCURRENCY`  | `4`                     | Bulkhead: in-flight calls per provider         |
| `BREAKER_FAILURE_THRESHOLD` | `5`                     | Consecutive failures that open a breaker       |
| `MAX_OUTPUT_TOKENS`         | `4000`                  | Per candidate; the evaluator gets double       |
| `MAX_RETRIES`               | `2`                     | SDK-level retries inside one call              |
| `REAPER_INTERVAL_MS`        | `30000`                 | Deadline sweep; `0` disables                   |
| `SHUTDOWN_TIMEOUT_MS`       | `30000`                 | How long a drain may take before a hard exit   |
| `SCE_SERVER_URL`            | `http://localhost:8787` | Where the CLI looks for the API                |
| `SCE_API_KEY`               | —                       | Non-interactive credential; beats anything stored |
| `SCE_TENANT`                | —                       | Organization to act inside, for multi-org users |
| `CLERK_SECRET_KEY`          | —                       | Verifies sessions and OAuth tokens; set with the publishable key or not at all |
| `CLERK_PUBLISHABLE_KEY`     | —                       | Also encodes the OAuth issuer, so it needs no second variable |
| `CLERK_WEBHOOK_SIGNING_SECRET` | —                    | Without it the webhook answers `503` rather than trusting unsigned payloads |
| `CLERK_OAUTH_CLIENT_ID`     | —                       | The public PKCE client `sce auth login` uses    |
| `CLERK_OAUTH_ISSUER`        | derived                 | Override, for a proxied or custom-domain instance |

The Clerk variables are all optional: without them the API still authenticates API keys — everything
CI and the SDK need — but cannot accept a browser session or an OAuth token. Set the secret and
publishable keys **both or neither**; the server refuses to boot half-configured, because that state
accepts no sessions and reports no error.

`.env.example` lists the rest, with the reasoning next to each.

---

## Design notes

| ADR                                                        | Decision                                          |
| ---------------------------------------------------------- | ------------------------------------------------- |
| [ADR-001](doc/adr/0001-postgres-and-migrations.md)         | Postgres as the datasource, with migration history |
| [ADR-002](doc/adr/0002-tenancy-columns-before-identity.md) | Tenancy columns before identity                   |
| [ADR-003](doc/adr/0003-bullmq-for-the-run-queue.md)        | BullMQ on Redis for the run queue                 |
| [ADR-004](doc/adr/0004-durable-progress-bus.md)            | Postgres for replay, Redis Streams for the tail   |
| [ADR-005](doc/adr/0005-clerk-identity-and-org-as-tenant.md) | Clerk for identity, organization as tenant, keys minted locally |
| [ADR-006](doc/adr/0006-plans-quotas-and-billing.md)        | Plans as data, quotas before the spend, one global kill switch |

---

## Built with

[Bun](https://bun.com) workspaces · [Hono](https://hono.dev) + RPC · [Prisma 7](https://prisma.io)
with the Postgres driver adapter · [BullMQ](https://docs.bullmq.io) on Redis for the queue and the
progress bus · [AI SDK 7](https://ai-sdk.dev) for provider-uniform streaming ·
[OpenTUI](https://github.com/anomalyco/opentui) React reconciler · Zod 4.
