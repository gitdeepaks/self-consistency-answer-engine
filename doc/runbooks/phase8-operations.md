# Phase 8 Operations

## Scope

Optional local assets, not a deployed monitoring service. No runtime package or root package changes belong to this work. Runtime instrumentation is a separate integration. See [evidence ledger](phase8-evidence.md) for what is actually verified.

## Telemetry

Start from the repository root, with Docker running:

```bash
export GRAFANA_ADMIN_PASSWORD='choose-a-local-password'
docker compose -f infra/monitoring/compose.yml config --quiet
docker compose -f infra/monitoring/compose.yml up -d
bun run infra/monitoring/check-translation.js
```

Grafana: http://127.0.0.1:3001 (admin and your password). Prometheus: http://127.0.0.1:9090. OTLP HTTP: http://127.0.0.1:4318 with `/v1/metrics`, `/v1/traces`, `/v1/logs`. No OTLP gRPC listener. Tempo and Loki are internal-only, accessed via provisioned Grafana sources. Set `SCE_TELEMETRY_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` for host API/worker processes after runtime integration. Container processes must use a reachable collector network address, not container loopback. No change to `bun run db:up` is needed.

```bash
docker compose -f infra/monitoring/compose.yml down
```

Volumes survive `down`; `down -v` deliberately deletes monitoring history. Prometheus retains seven days / 2 GB, Tempo 24 hours, Loki 48 hours (asynchronous compactor deletion). Monitor disk usage; retention is not an instantaneous disk quota. No Alertmanager/paging destination is configured: alerts are visible in Prometheus only. Before using remotely, add authenticated TLS ingress, private networks, backups, resource sizing and an approved notification route. Never expose this local unauthenticated OTLP/Loki stack publicly.

### Metric Contract

Collector 0.123.0 Prometheus exporter uses `add_metric_suffixes: true`: dots become underscores, monotonic sums gain `_total`, seconds histograms gain `_seconds_{bucket,sum,count}`, and non-monotonic sums do **not** gain `_total`. Explicit cumulative temporality is required. Do not set count units such as `{request}` or a currency unit unless deliberately updating the translated-name contract. The collector explicitly sets queue-age unit `s` to enforce the seconds contract independently of emitter metadata.

| OTLP Name | Kind / Unit | Allowed Dimensions | Prometheus Base |
| --- | --- | --- | --- |
| sce.http.requests | Counter / unset | method, route, status_class | sce_http_requests_total |
| sce.http.duration | Histogram / s | method, route, status_class | sce_http_duration_seconds |
| sce.run.created | Counter / unset | none | sce_run_created_total |
| sce.run.completed | Counter / unset | outcome | sce_run_completed_total |
| sce.run.duration | Histogram / s | none | sce_run_duration_seconds |
| sce.provider.calls | Counter / unset | provider, operation, outcome | sce_provider_calls_total |
| sce.provider.duration | Histogram / s | provider, operation, outcome | sce_provider_duration_seconds |
| sce.candidate.completed | Counter / unset | outcome | sce_candidate_completed_total |
| sce.synthesis.completed | Counter / unset | outcome | sce_synthesis_completed_total |
| sce.tokens | Counter / unset | provider, direction | sce_tokens_total |
| sce.cost.microcents | Counter / unset | provider | sce_cost_microcents_total |
| sce.cache.requests | Counter / unset | outcome | sce_cache_requests_total |
| sce.sse.connections | UpDownCounter / unset | none | sce_sse_connections |
| sce.queue.depth | Gauge / unset | queue, state | sce_queue_depth |
| sce.queue.age | Gauge / s | queue | sce_queue_age_seconds |
| sce.provider.breaker.open | Gauge / unset | provider | sce_provider_breaker_open |
| sce.budget.tripped | Counter / unset | none | sce_budget_tripped_total |

HTTP routes must be templates (e.g. `/v1/runs/:id`), never IDs, URLs or query strings. Status classes are `2xx`, `3xx`, `4xx`, `5xx`. Use finite provider/operation/outcome enums. One microcent is 1/100,000,000 USD. Queue gauges must publish zero when empty and one fleet-wide source or identical snapshots per instance; dashboards use `max`, not `sum`, for shared queue data. Breaker state is per-process; alert on `max` across the fleet. DLQ growth measures **net** growth, not all arrivals if jobs are replayed/purged within the same window.

Set a stable, unique `service.instance.id` on **each process** before multi-replica rollout. Prometheus exporter maps `service.name` to `job` and `service.instance.id` to `instance`; `honor_labels` preserves them. Without the instance ID, independent cumulative counters can collide. Runtime integration must confirm this; collector cannot infer the originating process behind a shared OTLP listener.

Use explicit duration boundaries including exactly 90 seconds (recommended: .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 90, 120, 300). The integration checker sends all 17 synthetic instruments and asserts actual translated names, histogram suffixes, the 90s bucket and tenant-label removal through Prometheus. It is **not** evidence that production instrumentation emits those instruments. Run it only on the local stack; synthetic samples remain until retention/volume cleanup.

### Logs And Privacy

There is no Docker socket, host log mount, filelog receiver, or automatic console scraping. Collector log bodies are replaced, severity text cleared, and only approved operational attributes survive. Trace names/status messages/events are sanitized; linked spans are dropped to avoid unsanitized link attributes. Resource and scope attributes are allowlisted. Never put sensitive values inside an allowed key. OTLP is trusted local input, not a defense against malicious senders; identifier/route values must be constrained by the emitter.

The current runtime logger writes JSON to console, not OTLP logs. To opt in to a **sanitized** local bridge using the existing development log file:

```bash
tail -F node_modules/.cache/sce-worker.log | ALLOW_LOCAL_LOG_FORWARDING=yes SCE_LOG_SERVICE=sce-worker bun run infra/ops/structured-logs.js
```

The bridge discards non-JSON records, messages, arbitrary keys and arbitrary field values, forwarding only a fixed body, numeric severity and finite operational enums. It never sends raw lines to the collector. It stops on collector failure rather than buffering raw data. Keep the source console file private: it may still contain sensitive content. Do not upload it as capacity evidence. Loki query: `{service_name="sce-worker"}`. More detailed diagnostics belong in restricted application/admin data, not telemetry.

### Product Data

Global panels show creation/completion, cache outcomes and provider spend. Do not add tenant, user, run, candidate, API-key, prompt or model-output identifiers as metrics labels. Tenant analysis uses authenticated `/v1/usage`, `/api/usage/daily`, existing admin views and persisted usage/rollups. Operators use `bun run ops spend --days 1 --limit 20` and `bun run ops rollup`. These commands expose tenant information: view privately, do not pipe them to Loki or publish raw output. Persisted metering is authoritative; metric windows and resets cannot serve as billing records.

## Availability

POST `/v1/runs` admission SLO: 99.5% non-5xx responses over a rolling 30 days. All observed responses are in the denominator (including 4xx); report quota/auth failures separately so they do not hide user impact. This is admission availability, not successful answers. Network failures before the app are invisible here and require external probes/platform metrics in staging.

Fast burn requires both 1h and 5m error ratios > 14.4 x 0.005; slow burn requires both 6h and 30m > 6 x 0.005. No requests produces no ratio, not a healthy signal. Missing telemetry has a separate alert. Look at service status-class rates, platform events and queue age. `bun run dlq depth` checks infrastructure; `bun run ops spend --days 1 --limit 20` distinguishes budget refusal. For a bad release follow [deployment rollback](phase8-deploy.md), not a schema downgrade. Investigate 429/auth problems separately. Resolve only after synthetic completion and both short-window burn ratios recover.

## Latency

The p95 < 90s objective means accepted-run creation through terminal completion, including queue wait, not the quick 201 HTTP response. Equivalent latency budget: at most 5% of observed terminal runs exceed 90s. Multiwindow burn uses the exact 90s bucket with the same 14.4/6 multipliers; a separate sustained p95 alert catches slower degradation. All terminal outcomes must record duration once, including timeout/cancel/failure. Stuck runs are censored until terminal: queue age, deadline reaping and bounded synthetic polling are essential companion checks. Verify runtime timestamps include enqueue wait.

Check queue age and provider latency, then `bun run dlq depth`. Use [queue runbook](queue.md) for backlog and dead letters. Check `QUEUE_CONCURRENCY` and provider bulkhead limits before scaling; more workers can magnify provider throttling and spend. Do not claim capacity from sparse or empty histograms. Resolve after backlog drains, synthetic completions succeed, and p95 recovers.

## Breaker

Identify the provider in the alert, compare call outcomes/latencies and check its status privately. Inspect configured timeouts and bulkhead limits; avoid immediate fleet-wide retries or DLQ replay. A candidate/provider failure is not necessarily a DLQ entry. Follow [queue](queue.md) and [cost](cost.md). If spending is unsafe, `bun run ops halt --reason "provider incident"`; only `bun run ops resume` after operator approval and a bounded smoke. Confirm breaker gauge returns to zero and provider calls recover.

## Local Drills

Use only the isolated `sce-chaos` project and an **absolute path outside the repository** for `CHAOS_ENV_FILE`, containing test auth/provider credentials, never production credentials. The build context's existing `.dockerignore` does not exclude arbitrary secret filenames. This project has its own ephemeral DB/Redis and no published data ports. Never point it at shared data; explicit Compose env overrides fix DB/Redis hosts. Provider account caps are still required: the $1 install cap is cached and in-flight calls can overshoot it. The 256-token drill cap may cause synthesis failure and is not representative capacity evidence.

```bash
export CHAOS_ENV_FILE=/absolute/private/path/chaos.env
docker compose -f infra/chaos/compose.yml up -d postgres redis
docker compose -f infra/chaos/compose.yml run --rm api bun run db:deploy
docker compose -f infra/chaos/compose.yml run --rm api bun run db:seed
docker compose -f infra/chaos/compose.yml up -d api worker
```

Configure a synthetic tenant and API key using the existing [auth instructions](../api/authentication.md) and [Clerk setup](clerk-setup.md). Seed data is UI/demo evidence, not measured model completion. Start the bounded load script against `http://127.0.0.1:8788` in a separate terminal, then inject **one** fault while jobs are active:

```bash
ALLOW_LOCAL_CHAOS=yes bash infra/chaos/drill.sh worker-kill
ALLOW_LOCAL_CHAOS=yes bash infra/chaos/drill.sh provider-stall
ALLOW_LOCAL_CHAOS=yes bash infra/chaos/drill.sh redis-partition
```

Each holds for 20s then restores via EXIT/INT/TERM trap, including normal completion. Worker kill restarts the worker; provider stall disconnects **all worker external egress**, retaining internal DB/Redis, so this is an all-provider transport outage, not a single provider latency simulator. Redis partition isolates Redis from both API and workers and restores its network alias. The script refuses non-Unix Docker contexts and nonempty `DOCKER_HOST`.

Capture completion/failure/cancel counts, queue drain and duplicate-charge checks from persisted usage. Worker kill should redeliver; provider stall may produce partial/failing runs; Redis outage should reject/fail enqueue rather than lose accepted work. The script's network restoration is not an assertion of application recovery: re-run the one-run smoke after each drill. If a trap cannot execute (SIGKILL/host shutdown), recover without deleting data:

```bash
docker compose -f infra/chaos/compose.yml up -d --force-recreate api worker redis
docker compose -f infra/chaos/compose.yml exec -T redis redis-cli ping
docker compose -f infra/chaos/compose.yml exec -T worker bun run dlq depth
```

Named Postgres/Redis volumes retain local run and queue evidence through force-recreation. Normal trap restoration retains the container and queue. Tear down only after collecting sanitized evidence with `docker compose -f infra/chaos/compose.yml down`; use `down -v` only when deliberately deleting this isolated drill's data.
