# Versioning and deprecation

The promise, in one sentence: **an integration written against `/v1` today keeps working
until we have told you otherwise for twelve months.**

---

## What is versioned

`/v1/*` is the product. Its shapes are in [`openapi.json`](./openapi.json), that file is
committed, and a pull request that changes it in a way which would break a caller fails CI.

`/api/*` is **not** versioned and is not for you. It is the first-party surface the web app
and the terminal client use; they ship in the same deployment as the server, so their contract
can change in the same commit. It is undocumented on purpose. Anything you need from it that
is not in `/v1` is a request we would rather have than a dependency you would rather not have.

---

## What counts as breaking

We may do these at any time, and your client must tolerate them:

- **adding** a field to a response,
- **adding** an optional field to a request,
- **adding** a new endpoint, a new event type, or a new value to a response enum,
- changing a `message` string — `code` is the stable part, prose is not,
- changing the order of an array where no order was documented.

Parse permissively. A client that rejects unknown response fields will break on our next
release, and that is a bug in the client.

We will not do these without the notice below:

- removing or renaming an endpoint, a field, or an error `code`,
- making an optional request field required,
- removing a value a request enum accepts,
- changing a field's type,
- removing a documented response status,
- removing a webhook event type.

---

## The notice period

**Twelve months, from the day the `Deprecation` header first appears.**

A deprecation runs in this order, and none of the steps is skipped:

1. **Announced.** The change lands in the changelog and in the OpenAPI description of the
   affected operation, with what replaces it.
2. **Signalled in the responses.** From that day, every response from the affected endpoint
   carries the headers below. This is the important step: it means a client that reads no
   announcements still finds out, from the wire, with a year to act.
3. **Sunset.** No sooner than twelve months later, the endpoint stops answering. It returns
   `410 Gone` with `code: "not_found"` for a further six months before the route is removed
   entirely, so a caller that missed everything gets a diagnosable failure rather than a 404
   that looks like a bug in their URL.

### The headers

```http
Deprecation: Wed, 05 Mar 2026 00:00:00 GMT
Sunset: Thu, 05 Mar 2027 00:00:00 GMT
Link: <https://…/v1/runs>; rel="successor-version",
      <https://…/doc/api/versioning.md>; rel="deprecation"; type="text/html"
```

`Deprecation` is RFC 9745, `Sunset` is RFC 8594, both as IMF-fixdate. They are exposed through
CORS, so a browser client can read them too.

**Alert on `Sunset`.** One line in whatever wraps your HTTP client, checking for the header and
logging a warning, converts a silent year-long countdown into something a person sees. It is
the single highest-value thing you can do with this section.

---

## A new major version

`/v2` appears only when a change cannot be made additively. When it does:

- `/v1` and `/v2` are served **side by side** for the whole notice period. There is no flag
  day, and no window in which only one works.
- `/v1` gains its `Deprecation` and `Sunset` headers the day `/v2` becomes generally
  available — not before, so there is never a period where the replacement is not yet real.
- A migration guide lands at `doc/api/migrating-to-v2.md` with a field-by-field mapping.
- `GET /v1` — the version index — reports its own `sunset` date, so a client can check
  programmatically rather than by reading this file.

---

## How this is enforced

`bun run api:check` runs on every pull request. It does two things:

**It fails if `openapi.json` is out of date** with the routes. A generated spec that is only
built in CI can tell you today's shape but not what you just changed; committing it is what
puts an API change in the pull request diff, where a reviewer sees it.

**It fails on a breaking change** against the base branch, with the JSON path of each one. The
comparison is direction-aware — adding a required field to a *request* breaks every caller,
while adding one to a *response* breaks nobody — because a gate that flags safe changes is a
gate people switch off.

Deliberately breaking the contract requires `ALLOW_BREAKING_API_CHANGE=1`, which prints the
findings and passes. It exists for the announced break at the end of a notice period. Using it
to make a red build green is the one thing this whole document is arranged to prevent.
