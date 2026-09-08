# Phase 8 Deployment

## Approval Gates

No remote deployment is performed by the implementation. The manual workflow selects `staging` or `production`, uses the corresponding GitHub Environment and fixed Fly app/config, and is serialized per environment. Configure required reviewers, allowed branches/tags and separate environment secrets `FLY_API_TOKEN` (app-scoped) and `SCE_SMOKE_API_KEY` (synthetic tenant, run write/read/cancel permissions). Require signed/reviewed source and a tested staging commit before production approval. Workflow actions currently use upstream release refs (Fly setup uses master); pin reviewed action commits/tool versions before enabling a production policy requiring supply-chain immutability.

The `migration_compatible` checkbox is an operational attestation, not a SQL analyzer. Before checking it, attach evidence of:

1. Database backup and rehearsed [restore](restore.md).
2. All migrations reviewed for expand/contract compatibility: old API and worker can read/write the new schema; no column/table removals, incompatible enum changes, blocking backfills or required-without-default fields in the expand release.
3. Old immutable image tested against migrated staging schema, including a complete run and queue redelivery.
4. Destructive contract migration deferred until old images/workers/queued payloads are retired and the rollback window closes.
5. No incompatible process topology, secrets or configuration change in this image-only rollback release. Such changes need a separately reviewed configuration rollback plan.

Never reverse a migration automatically. `release_command = "bun run --filter @sce/db db:deploy"` runs migrations before the new fleet. Rollback uses the old image with `--skip-release-command` against the forward schema. Initial provisioning (no previous API+worker image) and already mixed fleets are deliberately rejected; repair/provision under a separate approved procedure.

## Staging

`fly.staging.toml` mirrors production region, process commands, VM sizes, health checks, transport, concurrency and rolling migration strategy. Use separate Postgres, Redis, Clerk test instance, billing/webhook endpoints, synthetic tenants and capped provider credentials; never copy production tenant data or secrets. Fly auto-stop settings and replica counts affect latency: record actual counts, do not infer them from TOML. Disable auto-suspend only as a documented experiment, not a silent production mismatch.

Using a securely established connection to **staging only**, with `DATABASE_URL` verified privately and no production credentials in the shell:

```bash
bun run db:status
SCE_SEED_FORCE=1 bun run db:seed
```

Seeding is a deliberate privileged exception: it creates demo data and an unmetered demo plan. It does not create realistic load, prove providers work, or replace synthetic identity/API-key setup. Never use `SCE_SEED_FORCE=1` against production. Use existing key creation UI and auth runbooks for a dedicated synthetic workspace. Keep payloads innocuous and unique per test to avoid cache-only readiness checks.

## Deploy And Rollback

The workflow builds/pushes a commit-labeled Docker image, resolves its immutable SHA-256 digest, and passes that image to Fly. Immediately before any deployment, `infra/ops/deploy.sh` snapshots API/worker machine identities and the one previous digest into evidence files. It refuses ambiguous/missing digests. It arms its recovery trap **before** `flyctl deploy`, so nonzero partial rollout, machine-image verification and smoke failures all attempt rollback. The old image is never inferred from the new release list.

Successful rollout requires all API/worker machine digests match, workers be started, API machines be started or suspended, liveness and `/api/ready` pass and one unique paid synthetic run reach `COMPLETE` with a synthesis. The concurrent runtime implementation adds `/api/ready` for DB/Redis; this ops work consumes it without modifying runtime code. This checks auth, Postgres, enqueue/Redis, worker and provider behavior, not merely 201. It does not assert SSE delivery, every replica's dependency health, or external ingress availability. There is no build-SHA HTTP endpoint; platform digests plus OCI revision label are the version evidence. API `/v1` version is a contract version, not a deployment SHA. Only rollback permits a 404 from `/api/ready`, because the shipped pre-Phase8 image lacks that route; dependency completion smoke remains mandatory and 503 is never ignored.

Rollback verifies the old fleet digest and repeats the same dependency smoke (at most two created runs per workflow, new and rollback). The job remains failed even after successful recovery. A rollback failure is recorded and requires operator intervention. Workflow artifacts preserve digest evidence for 14 days. Logs must not contain credential values or model output.

If GitHub runner loss/SIGKILL prevents the trap, use the saved `old-image.txt` (retain registry images through the rollback window), and verify the app/config before issuing these commands under incident approval:

```bash
flyctl deploy --app "$FLY_APP" --config "$FLY_CONFIG" --image "$OLD_IMAGE" --skip-release-command --yes
flyctl machines list --app "$FLY_APP" --json
bash infra/ops/smoke.sh
```

Compare **all** API/worker `image_ref.digest` values with the saved digest, not just the first machine. Never invoke these commands locally as part of static validation. A persistent external dependency outage can make both new and rollback smokes fail; rollback cannot repair a provider/Redis outage. Halt unsafe new spend using `bun run ops halt --reason "incident"` in an authorized environment, then follow the dependency runbook. Do not resume automatically.
