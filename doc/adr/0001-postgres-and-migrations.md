# ADR-001 — Postgres as the datasource, with migration history

**Status:** accepted · **Date:** 2026-08-24 · **Phase:** 1

## Context

The prototype ran on SQLite/libSQL with `prisma db push` and no migration history. Three properties
that everything after Phase 1 depends on were missing:

- **A schema you can change safely.** `db push` diffs the schema against the database and applies the
  difference. There is no ordered history, no way to review what a deploy will do to production, and
  no way to roll one back.
- **Concurrent writers.** Phase 2 runs N API replicas and M workers against the same data, with
  `SELECT … FOR UPDATE`-style contention on run rows. SQLite's single-writer model does not survive
  that; libSQL/Turso's does not give us local transactional semantics to develop against either.
- **Real column types.** `Synthesis.agreements`, `.disagreements` and `.reviews` were JSON-encoded
  `String` columns because SQLite has no JSON type, and both status columns were free text with the
  allowed values recorded only in a doc comment.

## Decision

1. **Postgres is the datasource in every environment**, reached through Prisma's `pg` driver adapter
   (`@prisma/adapter-pg`). The libSQL adapter and `@libsql/client` are removed. Local development
   uses the Postgres in `infra/docker-compose.yml`, which is also the default `DATABASE_URL` outside
   production; in production the variable is required and a missing or non-Postgres value fails at
   boot with the offending value named.
2. **Schema changes ship as migrations.** `prisma migrate dev` locally, `prisma migrate deploy`
   everywhere else — wired as Fly's release command, so a failed migration aborts the deploy rather
   than starting a server against the wrong schema. `db push` and `db reset --force-reset` are gone
   from every script that could reach a non-local database.
3. **The database enforces the domain where it can.** `RunStatus`, `CandidateStatus`, `ProviderId`,
   `MemberRole` and `UsageKind` are Postgres enums; the JSON list columns are native `Json` parsed by
   Zod at the repository boundary.

## Consequences

**Good**

- Every schema change is a reviewable file with an ordered position in history.
- The generated enum types match the shared Zod unions exactly, which removed four `as` assertions
  from `repository.ts` — the database is now the thing that rejects an invalid state, not a comment.
- Native `Json` columns are queryable and indexable; a corrupt value degrades to a parsed fallback
  instead of throwing.
- Local development runs the same engine as production, so concurrency bugs surface on a laptop.

**Costs**

- `bun test` now needs a running Postgres (`bun run db:up`). The suite is still keyless and
  network-free for model calls; it is no longer zero-dependency.
- Docker (or some Postgres) is a prerequisite for local development.
- There is **no automatic migration of existing SQLite data**. The pre-Phase-1 `dev.db` files are
  development data; the Postgres history starts from the initial migration. Had there been
  production data, this would have needed an export/import step and a documented cutover instead.

## Alternatives considered

- **Stay on libSQL/Turso and add migrations.** Keeps one fewer local service, but leaves the
  single-writer ceiling in place ahead of the phase whose entire purpose is horizontal scale-out, and
  leaves JSON-in-`String` columns permanent.
- **Postgres without an ORM (raw SQL + a query builder).** More control over the exact SQL, but gives
  up the generated types that make the tenant-scoping rule checkable, and Prisma's migration tooling
  is the thing being adopted here.

## Related

- ADR-002 (queue choice) — Phase 2, depends on this.
- `doc/runbooks/restore.md` — the backup and restore procedure this schema is protected by.
