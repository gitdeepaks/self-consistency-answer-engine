# ADR-002 — Tenancy columns land in Phase 1, identity in Phase 3

**Status:** accepted · **Date:** 2026-08-24 · **Phase:** 1

## Context

The system had no notion of ownership: every run was global and public. Identity (Clerk, sessions,
API keys, RBAC) is Phase 3 work and is not close to ready. The tempting order is to add tenancy when
identity arrives — but the schema is the hardest thing in the plan to change later, and retrofitting
an owner column onto a populated `Run` table means a backfill, a nullable-then-required migration,
and an audit of every query written in the meantime.

## Decision

Add the full tenancy shape now and use a single well-known tenant until identity exists.

- `Tenant`, `User`, `Membership` (with a `MemberRole` enum) exist from the initial migration.
- `Run.tenantId` is **required**, not nullable — there are no legacy rows to backfill, so the
  three-step nullable → backfill → required dance is unnecessary. `Run.createdByUserId` is nullable,
  because there genuinely is no user yet.
- Every tenant-scoped table leads its hot index with `tenantId` (`@@index([tenantId, createdAt])`).
- **Every repository function takes an explicit `tenantId` and filters on it.** There is no unscoped
  variant, because the moment one exists it becomes the one somebody calls by mistake.
- The API resolves one tenant per request in middleware (`withTenant`), from a well-known slug. Phase
  3 replaces the body of that middleware with a real principal and changes nothing else.

## Consequences

**Good**

- Phase 3 is a change to one middleware plus a `Membership` lookup, not a schema migration and a
  query audit.
- Isolation is exercised from day one: `isolation.test.ts` creates two tenants and asserts that for
  every repository function, one cannot read, list, stream, mutate or delete the other's run.
- `repository.scoping.test.ts` statically fails any new `prisma.<model>.<op>()` whose filter never
  mentions the tenant. Deliberate exceptions are listed with a written reason, so adding one shows up
  in review rather than being an omission nobody sees.

**Costs**

- Every repository signature carries a `tenantId` that, today, is always the same value. That is the
  point — the parameter is what makes the call sites correct in advance — but it is visible ceremony
  for a single-tenant install.
- The default tenant is created lazily on first use. It is memoised per process; the underlying
  upsert is idempotent, so several replicas starting at once is safe.

## Alternatives considered

- **Nullable `tenantId`, backfill in Phase 3.** The plan's original shape, and the right one if there
  were existing rows. With a fresh Postgres there are none, so the nullable window would only buy the
  opportunity to write unscoped queries during Phases 1–2.
- **Row-level security in Postgres instead of application-level filters.** Stronger, and worth
  revisiting once there is a connection-per-tenant story. It needs the session to carry the tenant,
  which needs the identity work in Phase 3; the application-level rule is enforceable today and RLS
  can be added underneath it later as defence in depth.
