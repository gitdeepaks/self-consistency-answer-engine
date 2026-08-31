# ADR-0007 — Next.js for the web app, and capability URLs for sharing

**Status:** accepted · **Date:** 2026-08-31 · **Phase:** 5

## Context

Phases 0–4 produced an engine with no face on it: a durable, multi-tenant, metered orchestration
system reachable from a terminal and from `curl`. Phase 5 adds the primary surface — everything the
TUI does, plus what a terminal cannot do: sharing, deep history, side-by-side comparison and team
collaboration.

Four things had to be decided before any of that could be built, and each of them is expensive to
change afterwards.

## Decisions

### 1. Next.js (App Router), consuming the API over `hc<AppType>()`

`packages/web` is a Next.js app inside the Bun workspace. It talks to the existing Hono API through
the same typed RPC client the CLI uses — `import type { AppType } from "@sce/server"`, which is
erased at compile time, so nothing of the server package reaches the browser bundle.

The alternative considered was a Next app with its own route handlers proxying the API. Rejected:

- The run stream is a long-lived SSE connection. Putting a serverless function in the middle of one
  buys nothing and adds a hop that platforms are prone to time out.
- A proxy is a second place the route table is written down, and it drifts.
- The CORS allowlist and Clerk bearer tokens already make direct browser access safe, and both were
  built in Phase 3 for exactly this.

The consequence: the browser calls the API directly, authenticated with a Clerk session token. The
API is the only thing that enforces anything. The web app enforces nothing — it renders affordances,
and every one of them is independently refused server-side if a user gets past the UI.

**Every response is still parsed.** The route types describe what the server *intends* to send;
they are a contract, not a guarantee. So each response goes through the shared Zod schema that
defined it, exactly as the CLI does. The two halves are complementary: the types stop a typo at
compile time, the parse stops a lie at runtime.

### 2. The SSE decoder moved into `@sce/shared`

Both the CLI and the web app need the three things `EventSource` cannot give them: an
`Authorization` header, a cursor they control, and an `AbortSignal`. So both read the response body
as a stream and decode frames themselves — and that decoding is exactly the fiddly, easily-wrong
code that must not exist twice. `readRunEventStream` is now the single implementation.

The reducer over those events (`packages/web/src/lib/run-stream.ts`) is a **pure function**, kept
apart from the React effect that feeds it. That is what makes the genuinely hard behaviour testable
without a browser: replay after a reconnect, a delta for a candidate that has already settled, a
cursor that must only move forward.

### 3. Share links are capability URLs, and the token is stored in plaintext

A share is a public, read-only link to one finished run. Possession of the link is the whole
authorization. This is the one secret in the schema that is **not** hashed, and the reasoning is
worth recording because it looks like an inconsistency:

- An `ApiKey`'s hash protects data the key can reach *beyond* the key row. A share token reaches
  exactly one run, and that run is sitting in the same database, in plaintext, one join away.
  Hashing the token would guard a door in a glass wall.
- The link has to stay retrievable. A share whose URL is shown once and then unrecoverable is a
  share nobody uses.

What does the real work instead: shares expire, revoke immediately (the row is read on every visit —
there is no cache to wait out), and are enumerable by their owner.

**The redaction is the security boundary.** `toSharedRun` builds the public projection by *naming*
every field, never by spreading a row and deleting. A projection built by spreading leaks the next
column somebody adds; one built by naming cannot. Left out deliberately: who asked, the workspace
id, the individual drafts, provider errors, tokens, cost and deadlines.

Every failure to resolve a token — malformed, unknown, revoked, expired, run deleted — answers the
same 404. Telling an anonymous caller that a link *expired* confirms it once existed, which turns a
guessed token into an oracle.

### 4. Install administration is a separate axis from tenant roles

The operations console is cross-tenant by definition. Its guard reads `SCE_ADMIN_EMAILS` from the
API's configuration — a value only somebody with deploy access can set.

Reusing the `owner` role was rejected outright: an owner is the most senior person inside *one*
workspace, and making that also mean "operator of the whole install" would hand every customer's
account owner a cross-tenant view of every other customer — an escalation available to anyone who
can sign up.

Consequences:

- Every cross-tenant query lives in `packages/db/src/admin.ts` and takes an `OperatorScope` whose
  `reason` is a closed union of literals, so a call site must type out which sanctioned purpose it
  serves. Same idiom as `RunScope` and `MeteringScope`, for the same reason.
- `repository.scoping.test.ts` scans that file and requires each exemption to be listed with its
  justification.
- The console answers **404**, not 403, to everyone else. There is nothing here for a customer to
  appeal, and a 403 advertises the surface.
- It is not reachable by API key at all. It is an interactive surface, and a long-lived cross-tenant
  credential is precisely what should not exist.

## Consequences

- Search is `ILIKE` over `Run.prompt` and the inline `Synthesis.finalAnswer`, backed by `pg_trgm`
  GIN indexes. Chosen over `tsvector` because people search for fragments they half-remember, which
  is what trigram matching is good at — and because a stored, trigger-maintained vector column plus
  a per-tenant language choice is a lot of machinery for a question nobody has asked yet.
  **Stated limitation:** an answer body over `LARGE_BODY_THRESHOLD_BYTES` lives in object storage and
  its column is null, so it is matched by prompt alone.
- Tags are a `text[]` with a GIN index rather than a join table: read on every history query, written
  rarely, never joined *from*, and capped at sixteen.
- Feedback requires a person (`[runId, userId]` unique, upserted). A credential with no user behind
  it cannot leave a verdict — an unattributable one is noise in a dataset whose entire value is that
  a human produced it. Changing your mind corrects the label rather than adding a contradictory
  second one.
- Model output is rendered with raw HTML disabled, URLs restricted to `http`/`https`/`mailto`, and
  remote images turned into links rather than fetched. That last one is the P9.3 rule applied early:
  an `<img>` in an answer is a request the *reader's* browser makes to a third party.
- Every page in the authenticated route group is `force-dynamic`. This is a correctness rule, not a
  performance knob: Next will prerender a page whose code happens not to touch a request-scoped API,
  and a page baked with one tenant's runs and served to the next is the worst bug this codebase
  could ship.

## Alternatives rejected

| Option | Why not |
| ------ | ------- |
| Remix / TanStack Start | Both workable. Next was chosen for App Router streaming, the maturity of Clerk's integration, and the deployment story on the platform already in `fly.toml`. |
| A charting library for the spend view | One chart, one shape. A dependency would cost more in the bundle than it saves in code — on a page whose Core Web Vitals budget is enforced in CI. |
| `EventSource` for the run stream | Cannot send an `Authorization` header, cannot be aborted cleanly, and controls its own resume cursor. |
| Hashing share tokens | Guards a door in a glass wall, and makes the link unrecoverable — the behaviour that would actually stop anyone using the feature. |
| A write path for team membership | Clerk owns identity. A second write path lets this database and Clerk disagree about who works at a company, which is the drift the nightly reconciliation job exists to *detect*. |
