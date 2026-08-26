# Runbook — connecting Clerk

What to click, in what order, to turn a fresh Clerk instance into a working
identity provider for this API. Roughly fifteen minutes.

The API works **without** any of this: API keys are verified locally and need no
Clerk at all. What Clerk adds is human sign-in — browser sessions for the web app
(Phase 5) and `sce auth login` for the CLI.

---

## 0. Before you start

| You need | Where |
| -------- | ----- |
| A Clerk application | <https://dashboard.clerk.com> |
| Organizations enabled | Dashboard → Organizations, or `clerk enable orgs` |
| The repo running locally | `bun run db:up && bun run dev` |

Organizations are not optional here. A Clerk **organization maps 1:1 to a
`Tenant`**, and tenancy is what every query in the system filters on. With
organizations off, users have no organization, `resolveMembership` finds
nothing, and every authenticated request answers `403 no-membership`.

Pick the membership mode deliberately:

- **Membership required** — B2B only. Every user must belong to an organization,
  which matches this schema exactly.
- **Membership optional** — users can exist without one. Fine, but those users
  get a 403 from this API until somebody adds them to an organization.

---

## 1. API keys

Dashboard → **API keys**. Copy both into `.env`:

```sh
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
```

Set **both or neither**. The server refuses to boot with one of the two, because
a half-configured identity provider accepts no sessions and reports no error —
it just looks like everyone's password is wrong.

The publishable key is not only for browsers here: its base64 payload encodes
the instance's frontend API host, which is where the OAuth endpoints live. That
is why `CLERK_OAUTH_ISSUER` is normally unnecessary.

---

## 2. The OAuth application, for the CLI

Dashboard → **OAuth applications** → *New application*.

| Field | Value | Why |
| ----- | ----- | --- |
| Name | `sce CLI` | Shown on the consent screen |
| **Public client** | **enabled** | A CLI ships to users and cannot hold a secret. This is what enables PKCE-only exchange |
| Redirect URI | `http://127.0.0.1/callback` | RFC 8252 §7.3 — Clerk matches loopback redirects on any port |
| Scopes | `openid`, `profile`, `email`, `offline_access` | `offline_access` is what issues a refresh token |

Then copy the client id:

```sh
CLERK_OAUTH_CLIENT_ID=...
```

Two details worth understanding rather than just copying:

- **The port is not fixed.** The CLI binds `127.0.0.1:0` and takes whatever
  ephemeral port it gets, because a fixed port collides with whatever else the
  developer is running. Clerk allows any port on a registered loopback host,
  which is exactly why the flow is specified this way.
- **There is no client secret, and that is fine.** The proof is the PKCE
  `code_verifier`: 32 random bytes invented per login, sent only as a SHA-256
  hash up front, and presented in full at the token exchange. An intercepted
  authorization code is useless without it.

Verify it end to end:

```sh
sce auth login          # opens a browser
sce auth status         # should print your tenant, role and scopes
```

`sce auth login` reads `GET /api/auth/config` first, so the CLI needs no
configuration of its own — point `SCE_SERVER_URL` at any deployment and it
discovers that deployment's issuer and client id.

---

## 3. Webhooks — the part that actually keeps the database correct

Clerk owns *who exists*. This database owns *who owns what*. Runs, usage records,
keys and audit rows all join against local ids, so every Clerk user and
organization needs a local row. Webhooks are what create them.

Dashboard → **Webhooks** → *Add endpoint*.

| Field | Value |
| ----- | ----- |
| Endpoint URL | `https://your-api.example.com/api/webhooks/clerk` |
| Events | `user.*`, `organization.*`, `organizationMembership.*` |

Copy the signing secret:

```sh
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
```

Without it the endpoint answers **503**, not 200. An endpoint that cannot verify
a signature must not process the payload — anyone can POST to it.

### Locally

The Clerk CLI tunnels without needing a public URL:

```sh
clerk webhooks listen --token "$(clerk webhooks token)" \
  --forward-to http://localhost:8787/api/webhooks/clerk
```

Add the relay URL it prints as an endpoint in the dashboard — events do not flow
until you do.

### What the handler guarantees

- **Verified** — Svix signature checked before the payload is read. A bad
  signature is a `400`, which tells Svix to stop retrying, because the same
  bytes will fail the same way.
- **Idempotent** — every delivery is claimed by its `svix-id` before being
  applied. A retry is acknowledged and not re-applied. Two API replicas racing
  on the same retry resolve it in the database, not in a read-then-write window.
- **Order-independent** — a membership event that overtakes its `user.created`
  creates the placeholder it needs; the later event fills it in.

---

## 4. Lock down CORS

`CORS_ORIGIN=*` is refused outside development — the server will not boot with
it. Set the real origins:

```sh
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

---

## 5. Reconciliation

Webhooks are eventually consistent, which is a polite way of saying eventually
wrong: a delivery exhausts its retries, an endpoint is misconfigured for an hour,
a deploy drops a window of events. None of that is visible — the database just
goes quietly stale, and the first symptom is a person who cannot reach an
organization they were added to last week.

So run this nightly:

```sh
bun run auth:reconcile              # repair drift and report
bun run auth:reconcile --dry-run    # report only
```

It walks Clerk's own organization and membership lists and makes the local mirror
match, including the security-relevant direction: a membership removed upstream
but still present locally is deleted, and every API key that member minted is
revoked with it.

**It exits non-zero when it repairs anything**, so a scheduled run surfaces as a
failed job rather than scrolling past in a log nobody reads. Drift is not
routine. When it appears, check the endpoint's delivery log in the dashboard
before dismissing it.

---

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `401` on every request | No credential, or the token is not for this instance | `sce auth status`; check `CLERK_SECRET_KEY` matches the instance that issued the token |
| `403 user-not-synced` | Clerk knows the user; Postgres does not | The `user.created` webhook never arrived. Check delivery logs, then `bun run auth:reconcile` |
| `403 no-membership` | User belongs to no organization | Add them to one, or enable Organizations |
| `403 not-a-member-of-requested-tenant` | `--org` / `X-SCE-Tenant` names an organization they are not in | Use a slug they belong to, or drop the flag |
| Webhook returns `503` | `CLERK_WEBHOOK_SIGNING_SECRET` unset | Set it and redeploy |
| Webhook returns `400` | Signature mismatch | The secret belongs to a different endpoint — each endpoint has its own |
| Server will not boot, complains about `CORS_ORIGIN` | `*` in production | Set an explicit allowlist |
| Server will not boot, complains about Clerk keys | One key set, not both | Set both or neither |
| `sce auth login` says no interactive sign-in | `CLERK_OAUTH_CLIENT_ID` unset, or the publishable key did not decode | Set the client id; if the instance is proxied, set `CLERK_OAUTH_ISSUER` |

---

## Related

- `doc/adr/0005-clerk-identity-and-org-as-tenant.md` — why Clerk, why
  organizations are tenants, and why API keys are minted here rather than there.
- `packages/server/src/auth/` — the verification path.
- `packages/server/src/isolation.test.ts` — the suite that proves tenant B
  cannot reach tenant A on any route.
