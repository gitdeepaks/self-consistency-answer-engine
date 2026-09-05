# Authentication

Every `/v1` route except `GET /v1` and `GET /v1/health` requires a credential.

```http
Authorization: Bearer sce_live_a1b2c3d4e5f6_JHR3aXN0ZWQtc2VjcmV0…
```

## Getting a key

Web app → **Settings → API keys → Create**, or `sce keys create` from the terminal client.

The secret is returned by the request that creates it and **never again**. The database stores
a prefix and a SHA-256 of the secret half, so a dump of that table authenticates nobody — which
also means we genuinely cannot recover a key you have lost. Create a new one and revoke the old.

```
sce_live_a1b2c3d4e5f6_JHR3aXN0ZWQtc2VjcmV0LWJ5dGVz…
└┬┘ └─┬┘ └─────┬────┘ └──────────────┬───────────┘
 │    │        │                     └ secret: 32 random bytes, never stored
 │    │        └ public id: safe to log, display and put in a ticket
 │    └ environment: a test key pasted into production fails loudly
 └ vendor tag: makes the string greppable in a leaked-repo scan
```

The prefix — everything up to the last underscore — is safe to log and is what appears in the
key list and the audit trail. The part after it is not.

## Scopes

A key carries a subset of the scopes its creator held. A key cannot mint a key with more
privilege than itself, so a leaked `runs:read` key cannot promote itself.

| Scope | Grants |
| --- | --- |
| `runs:read` | List, fetch and stream runs; read tags and shares |
| `runs:write` | Create, cancel, delete and tag runs; publish share links |
| `usage:read` | `GET /v1/usage` |
| `keys:read` | List keys and webhook endpoints, read the delivery log |
| `keys:write` | Create keys, register and re-enable webhook endpoints, replay deliveries |
| `keys:revoke` | Revoke keys, delete webhook endpoints |
| `members:read` | Read the workspace roster |
| `audit:read` | Read the audit trail |

Give a key the least it needs. A key that only reads results should not be able to start runs
that cost money.

## 401 versus 403

| | Meaning | What to do |
| --- | --- | --- |
| `401` `unauthorized` | No credential, or one that is expired, revoked or unrecognised | Check the header; mint a new key |
| `403` `forbidden` | The credential is valid and lacks the scope or the role | Grant the scope, or use a different key |

A 401 body says nothing beyond "authentication required", deliberately: telling an anonymous
caller whether a key is *revoked* or *unknown* tells them which half of a guess was right. The
reason is in our logs against your `requestId`.

A 403 does name what was missing, because by then we know who is asking.

## Rotation

There is no rotation endpoint, and that is the design: create the new key, deploy it, confirm
traffic has moved (the key list shows `lastUsedAt`), then revoke the old one. A rotate-in-place
call would have to invalidate the old secret at some instant, and there is no instant at which
every one of your instances has picked up the new one.

Revocation is immediate. Every request resolves its key from the database, so there is no cache
to wait out.

## Sessions

The API also accepts a Clerk session token, which is how the web app and its API playground
talk to `/v1`. It is not useful to a server-side integration — it is short-lived and belongs to
a person, not to a machine — and there is no supported way to obtain one outside a browser.
