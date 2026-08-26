# ADR-005 — Clerk for identity, organization as tenant, keys minted locally

**Status:** accepted · **Date:** 2026-08-26 · **Phase:** 3

## Context

Every run was global and public. `POST /api/runs` took an unauthenticated request and spent real
money on model calls; `GET /api/runs/:id` served anyone's run to anyone. The schema had carried
`Tenant`, `User`, `Membership` and `Run.tenantId` since Phase 1, and every repository function
already took a `tenantId` — but the value came from `defaultTenant()`, a single well-known row. The
isolation was real and unused.

So Phase 3 is not "add tenancy". It is "make `tenantId` come from a credential instead of a
constant", plus the machinery that requires: an identity provider, credentials for callers with no
browser, a policy layer, and an audit trail.

Four decisions, each with a live alternative.

## Decision 1 — Clerk, not our own identity

Sessions, MFA, social login, password reset, email verification, organization invitations and SSO
are a product in themselves. Building them is months; running them badly is a breach. Clerk covers
all of it, and `@clerk/backend` verifies both credential types this API sees — browser sessions and
OAuth tokens — in one call.

The cost is a hard dependency on a third party for sign-in, and a webhook pipeline to keep local
rows in step. Both are accepted, and Decision 4 addresses the second.

**Not chosen:** Auth.js (self-hosted, but organizations and invitations are then ours to build),
WorkOS (better enterprise SSO story, weaker at the consumer end this product starts from).

## Decision 2 — a Clerk organization *is* a tenant

`Tenant.externalId` holds the Clerk organization id, and Clerk's `org:admin` maps onto our own
closed `MemberRole` enum rather than being stored raw.

Mapping rather than adopting matters. Clerk roles are namespaced and customisable in the dashboard,
so a role could appear that this build has never modelled. `memberRoleFromClerk` maps an unknown one
to `viewer` — the least privilege available — instead of throwing inside a webhook Clerk would then
retry forever.

Ownership stays local. A foreign key cannot point at another company's API, so `Run.tenantId` and
`Run.createdByUserId` reference local rows and Clerk is mirrored into them.

**Not chosen:** treating each *user* as a tenant. It makes team features a migration later, and this
schema was built for organizations in Phase 1.

## Decision 3 — API keys are minted here, not in Clerk

Clerk can issue machine credentials. We issue our own anyway:

- **Verification is one indexed lookup**, not a network round trip to a third party on every
  request. The key format carries a unique prefix, so the lookup is keyed rather than a scan.
- **The scopes are ours.** `runs:read` and `keys:write` are this product's vocabulary and belong in
  a closed enum the compiler checks.
- **It works without Clerk.** An install that has not connected Clerk still authenticates CI and the
  SDK, which is what makes the bootstrap path possible at all.

A key stores a prefix and a SHA-256 of a 256-bit random secret. SHA-256 rather than a password hash
is deliberate and holds *only* because the secret is CSPRNG output: there is no dictionary to attack
and no work factor worth paying on a credential verified on every request.

Two properties fall out of the design and are worth naming:

- **A key's role is its creator's current role**, read at verification time rather than stored. So
  demoting someone demotes their keys, and removing them from the tenant kills their keys, with
  nobody having to remember they exist.
- **Revocation is immediate** because there is no cache. Every request resolves its key from the
  database; that is the cost, and it buys a revocation story with no window in it.

### The CLI uses OAuth + PKCE, not a key

Humans at a terminal get an authorization-code flow with PKCE (`S256`) and a loopback redirect on an
ephemeral `127.0.0.1` port — RFC 8252 §7.3. A CLI is a public client: it ships to users and cannot
hold a secret, so the proof is a per-login `code_verifier` that never leaves the process. An
intercepted authorization code is worthless without it.

Keys remain for CI and the SDK, where there is no browser to open.

**Not chosen:** the device-code flow the plan originally suggested. It is the right answer when the
client has no browser *and no loopback* — a TV, a headless box. On a developer's laptop it is
strictly worse: an extra code to copy, and a longer window in which a code is valid.

## Decision 4 — webhooks, plus a nightly reconciler that can fail the build

Webhook delivery is at-least-once, unordered, and eventually gives up. The handler is therefore
verified (Svix signature before the payload is read), idempotent (claimed by `svix-id` before being
applied), and order-independent (a membership event that overtakes its `user.created` creates the
placeholder it needs).

That still leaves drift, and drift is invisible: the database simply goes stale. So `bun run
auth:reconcile` walks Clerk's own lists nightly and repairs differences in both directions —
including the security-relevant one, where a membership removed upstream is still live locally.

**It exits non-zero when it repairs anything.** Drift is not routine; a scheduled run that finds some
should page someone, not scroll past.

## Consequences

- No route serves tenant data without an authenticated principal. The public surface is four routes,
  visible in the route table: `/health`, `/providers`, `/auth/config` (which the CLI must read
  *before* it has a credential) and `/webhooks/*` (authenticated by signature instead).
- `defaultTenant()` survives for the bootstrap script only. `bun run auth:bootstrap` mints a real key
  through the real code path — deliberately not a dev-mode bypass in the middleware, because a
  bypass means production runs different authentication code from development, and the branch nobody
  exercises is the one that ships enabled.
- Authorization is one function. `can(actor, permission, resource)` in `@sce/shared` requires role
  **and** scope to agree, so a leaked read-only key on an owner's account still cannot start a run.
- `CORS_ORIGIN=*` is now a boot failure outside development.
- `AuditEvent` is append-only. Nothing updates or deletes one; there is no `updateAudit`, and adding
  one should be read as a bug report against this line.

## Notes

The one thing to watch: `@clerk/backend` types JWT claims as `Record<string, any>`. Everything Clerk
returns is narrowed inside `packages/server/src/auth/clerk.ts` before it leaves that module, because
letting that shape spread would quietly disable type checking across the whole authenticated
surface.
