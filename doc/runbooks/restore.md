# Runbook — Postgres backup and restore

**Owner:** @gitdeepaks · **Applies to:** every environment with a managed Postgres
**Last rehearsed:** _not yet — see "Rehearsal log" at the bottom_

> An untested backup is not a backup. This procedure exists to be *run*, on a schedule, against
> staging. The number that matters is not "do we have snapshots" but "how long does it take to get
> back, and what did we lose" — and you only learn those by doing it.

---

## 1. What is protected

| Data | Where it lives | Protected by |
| ---- | -------------- | ------------ |
| Tenants, users, memberships | Postgres | daily snapshot + PITR |
| Runs, candidates, synthesis, event log | Postgres | daily snapshot + PITR |
| Usage records and the price registry | Postgres | daily snapshot + PITR |
| Offloaded answer bodies (over `LARGE_BODY_THRESHOLD_BYTES`) | object store under `tenants/<id>/` | bucket versioning + lifecycle policy |

The last row matters: restoring Postgres alone gives you rows whose `contentRef` points at objects
that may no longer exist. The repository degrades gracefully (the body reads back as
`[answer body unavailable — object … could not be read]`) rather than failing the whole run, but a
restore is not complete until both halves are back at the same point in time.

## 2. Required configuration

On the managed Postgres:

- **Daily automated snapshots**, retained 7 days minimum (30 for production).
- **Point-in-time recovery** enabled, so recovery granularity is a timestamp rather than a day.
- Snapshots stored in a **different region** from the primary.
- An alert when the last successful snapshot is older than 26 hours.

On the object store:

- **Versioning on**, so an overwritten or deleted body is recoverable.
- A lifecycle rule that expires noncurrent versions on the same schedule as the database retention,
  so the two stay in step.

Fly.io reference (adjust for another host):

```bash
fly postgres list
fly postgres backup list  --app sce-db      # snapshots and their timestamps
fly postgres backup enable --app sce-db     # if it is somehow not on
```

## 3. Restore procedure

Time it. Write the number down at the bottom of this file.

### 3.1 Declare and stop writing

```bash
fly scale count 0 --app self-consistency-answer-engine   # stop the API taking new runs
```

Stopping writes first is what makes the restore point meaningful. In-flight runs are lost; Phase 2's
durable queue is what makes them resumable instead.

### 3.2 Choose the restore point

```bash
fly postgres backup list --app sce-db
```

Pick the latest snapshot **before** the incident. For PITR, pick a timestamp instead — usually one
minute before the first bad write.

### 3.3 Restore into a NEW database

Never restore in place. A new instance keeps the damaged original available for forensics and makes
the rollback of a bad restore trivial.

```bash
fly postgres create --name sce-db-restored --fork-from sce-db --snapshot-id <id>
```

For a plain dump/restore on any host:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_URL" backup.dump
```

### 3.4 Verify before cutting over

Against the restored database, not the live one:

```bash
export DATABASE_URL="postgres://…sce-db-restored…"

bun run db:status          # must report: no pending migrations
bun -e '
  import { prisma, disconnect } from "@sce/db"
  const [tenants, runs, events, usage] = await Promise.all([
    prisma.tenant.count(), prisma.run.count(),
    prisma.runEvent.count(), prisma.usageRecord.count(),
  ])
  console.table({ tenants, runs, events, usage })
  const newest = await prisma.run.findFirst({ orderBy: { createdAt: "desc" } })
  console.log("newest run:", newest?.createdAt)
  await disconnect()
'
```

Check three things:

1. **Migration state** — `db:status` clean. A restore that is behind head needs `bun run db:deploy`
   before the app starts, not after.
2. **Row counts** are in the right order of magnitude versus the last known-good figures.
3. **The newest run's `createdAt`** is where you expect the restore point to be. This is your actual
   data loss window — record it.

### 3.5 Restore the object store to the same point

For every `contentRef` / `finalAnswerRef` written after the restore point, the object may be newer
than the database. Roll the prefix back to the same timestamp:

```bash
aws s3api list-object-versions --bucket "$BUCKET" --prefix "tenants/"
# restore the version current at the restore point for any object that changed after it
```

Then spot-check that a restored run reads end to end:

```bash
curl -s "$API/api/runs/<id>" | jq '.run.synthesis.finalAnswer | length'
```

A body that comes back as `[answer body unavailable …]` means the object half is not restored yet.

### 3.6 Cut over

```bash
fly postgres detach sce-db        --app self-consistency-answer-engine
fly postgres attach sce-db-restored --app self-consistency-answer-engine
fly scale count 2                 --app self-consistency-answer-engine
```

Watch `/api/health`, then confirm a new run completes end to end.

### 3.7 Afterwards

- Keep the damaged database for at least 7 days.
- Record the timings and the data-loss window below.
- If anything in this document was wrong, fix it *now* — that is the most valuable output of a
  restore.

## 4. Rehearsal schedule

Quarterly, against staging, by a different engineer each time — a runbook only one person can follow
has not been tested.

## 5. Rehearsal log

| Date | Environment | Restore point | Wall-clock to healthy | Data loss window | Notes |
| ---- | ----------- | ------------- | --------------------- | ---------------- | ----- |
| _(pending — the Phase 1 exit criterion is one timed restore against staging)_ | | | | | |
