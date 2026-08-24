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
                     │ Hono backend │
                     └──────┬───────┘
              ┌────────────┼────────────┐        fan-out (parallel)
        ┌─────┴────┐ ┌─────┴────┐ ┌─────┴────┐
        │  OpenAI  │ │  Claude  │ │  Gemini  │
        └─────┬────┘ └─────┬────┘ └─────┬────┘
              └────────────┼────────────┘
                    ┌──────┴───────┐
                    │  Evaluator   │              synthesis (Claude Opus)
                    │ compare→merge│
                    └──────┬───────┘
                    ┌──────┴───────┐
                    │Prisma/Postgres│             every run is persisted
                    └──────────────┘
```

---

## Quick start

```bash
bun install                     # install the workspace
cp .env.example .env            # add at least one provider key
bun run db:up                   # start Postgres + Redis (Docker)
bun run db:migrate              # create the schema
bun run db:seed                 # optional: a demo tenant and a few runs

bun run dev                     # API + TUI together, one terminal
```

`dev` uses [concurrently](https://github.com/open-cli-tools/concurrently) in `--raw` mode, which is
the only mode that hands a child real stdio — OpenTUI needs a genuine TTY for raw-mode input and the
alternate screen. The API's output would otherwise paint straight over the interface, so it is
redirected to `node_modules/.cache/sce-server.log` (outside the watched tree) with its stdin closed
so it never competes for keystrokes. Follow it in a second terminal with `bun run dev:logs`, or run
the two halves separately with `bun run dev:server` and `bun run dev:cli`. Quitting the TUI stops
the API via `--kill-others`.

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

A Bun workspace with four packages:

| Package           | Role                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Zod schemas, domain types, the model registry, run-event union. The single source of truth shared by server and client. |
| `packages/db`     | Prisma schema, migrations and a tenant-scoped repository. Postgres everywhere, via the Prisma `pg` driver adapter.       |
| `packages/server` | Hono app: RPC routes, SSE progress stream, provider resolution, the orchestrator.                                       |
| `packages/cli`    | OpenTUI + React terminal client, talking to the server over the typed Hono RPC client.                                  |

---

## How a run works

1. **`POST /api/runs`** seeds a `Run` row plus one `Candidate` row per panel member and returns
   immediately. The pipeline then runs in the background — the HTTP request never blocks on the
   models.
2. **Fan-out.** All panel members are called concurrently with the same prompt and the same system
   prompt. They never see each other's output; that independence is what makes later agreement
   meaningful. Each leg settles its own row, so one provider erroring, timing out or returning empty
   text cannot take down the others.
3. **Synthesis.** The successful candidates are handed to the evaluator (Claude Opus by default)
   with the original question. It returns a structured object — agreements, disagreements,
   per-candidate scores with concrete strengths and weaknesses, a confidence value, and the merged
   final answer.
4. **Persistence.** Everything is written to the database as it happens, so history survives
   restarts and a browsable archive comes for free.

Progress is published on an in-process event bus. `GET /api/runs/:id/events` streams it as SSE over
an **append-only buffer with a cursor**, so a client can connect late, or reconnect, and still
replay the complete timeline without dropping or duplicating an event.

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

| Route                      | Purpose                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/health`          | Liveness probe.                                                                 |
| `GET /api/providers`       | Which panel members are usable and how they are reached (`direct` / `gateway`). |
| `POST /api/runs`           | `{ prompt, providers?, temperature? }` → the seeded run.                        |
| `GET /api/runs`            | `?limit&cursor` → run history, newest first.                                    |
| `GET /api/runs/:id`        | Full run: candidates + synthesis.                                               |
| `GET /api/runs/:id/events` | SSE progress stream.                                                            |
| `DELETE /api/runs/:id`     | Delete a run and its children.                                                  |

```bash
curl -s localhost:8787/api/providers | jq
curl -s -X POST localhost:8787/api/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"Why is the sky blue?"}' | jq -r .run.id
curl -N localhost:8787/api/runs/<id>/events
```

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
| `bun run dev`              | API + TUI concurrently, hot reload on both |
| `bun run dev:logs`         | Tail the API log while `dev` is running    |
| `bun run dev:server`       | API only, with hot reload                  |
| `bun run dev:cli`          | TUI only, with hot reload                  |
| `bun run ask "<question>"` | TUI, pre-loaded with a question            |
| `bun run db:up` / `db:down`| Start / stop local Postgres + Redis         |
| `bun run db:nuke`          | Stop them and delete the volumes           |
| `bun run db:migrate`       | Create and apply a migration (local)       |
| `bun run db:deploy`        | Apply pending migrations (any environment) |
| `bun run db:status`        | Which migrations are applied               |
| `bun run db:seed`          | Demo tenant, demo runs, model price list   |
| `bun run db:studio`        | Browse the database                        |
| `bun test`                 | Full suite                                 |
| `bun run typecheck`        | `tsc --noEmit` across every package        |

### Tests

53 tests, no API keys and no network required — every model call runs against
`MockLanguageModelV4`. The database tests need the local Postgres up
(`bun run db:up`); everything else runs with nothing started.

- `packages/server/src/orchestrator.test.ts` — fan-out, partial failure, total failure, evaluator
  failure, provider subsets, review backfill.
- `packages/server/src/app.test.ts` — routing, validation, SSE framing and ordering, persistence,
  404s.
- `packages/cli/src/App.test.tsx` — headless render of the real TUI: idle screen, a run streaming to
  completion, tab switching.
- `packages/cli/src/components/Header.test.tsx` — which header items survive as the terminal narrows.
- `packages/db/src/repository.test.ts` — enum enforcement, JSON round-trips, large-body offload,
  the durable event log, pricing and usage totals — against real Postgres.
- `packages/db/src/isolation.test.ts` — for every repository function, tenant B cannot read, list,
  stream, mutate or delete tenant A's run.
- `packages/db/src/repository.scoping.test.ts` — static check that no new query can skip its
  `tenantId` filter.
- `packages/shared/src/env-file.test.ts` — root `.env` discovery and parsing.

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

### 2. Server

```bash
docker build -t sce . && docker run -p 8787:8787 --env-file .env sce
```

Fly.io (`fly.toml` is included):

```bash
fly launch --no-deploy
fly postgres create --name sce-db && fly postgres attach sce-db   # sets DATABASE_URL
fly secrets set ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GOOGLE_GENERATIVE_AI_API_KEY=…
fly deploy
```

Any Docker host works the same way — Railway, Render, Cloud Run. Set `PORT`, `HOST=0.0.0.0` and the
provider secrets; point the health check at `/api/health`.

> SSE streams stay open for the length of a run. Behind a proxy, make sure response buffering is off
> and the idle timeout exceeds `PER_MODEL_TIMEOUT_MS + EVALUATOR_TIMEOUT_MS`.

### 3. Client

```bash
SCE_SERVER_URL=https://your-app.fly.dev bun run cli
```

Or ship a standalone binary:

```bash
bun build packages/cli/src/index.tsx --compile --outfile sce
```

---

## Configuration

| Variable               | Default                 | Meaning                                  |
| ---------------------- | ----------------------- | ---------------------------------------- |
| `PORT` / `HOST`        | `8787` / `0.0.0.0`      | Server bind                              |
| `CORS_ORIGIN`          | `*`                     | Allowed origin for `/api/*`              |
| `PER_MODEL_TIMEOUT_MS` | `120000`                | Budget per panel member                  |
| `EVALUATOR_TIMEOUT_MS` | `180000`                | Budget for synthesis                     |
| `MAX_OUTPUT_TOKENS`    | `4000`                  | Per candidate; the evaluator gets double |
| `MAX_RETRIES`          | `2`                     | SDK-level retries per call               |
| `EVENT_BUFFER_TTL_MS`  | `600000`                | How long a finished run stays replayable |
| `SCE_SERVER_URL`       | `http://localhost:8787` | Where the CLI looks for the API          |

---

## Built with

[Bun](https://bun.com) workspaces · [Hono](https://hono.dev) + RPC · [Prisma 7](https://prisma.io)
with the libSQL driver adapter · [AI SDK 7](https://ai-sdk.dev) for provider-uniform model calls ·
[OpenTUI](https://github.com/anomalyco/opentui) React reconciler · Zod 4.
