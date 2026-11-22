# PunyaSitus Telemetry, Alerting & Release Procedures

> Contract authority: `PRD.md` (`REQ-042`, `REQ-039`), `PLAN.md` (§9, §12, §13), `OBSERVABILITY.md`.
> Scope: Structured logging redaction contract, non-secret health/readiness endpoints, alert thresholds, external uptime probing, and staged release/rollback procedures.

---

## 1. Structured Telemetry & Strict Redaction Contract (`PLAN.md` §9)

Implemented in `packages/core/src/telemetry/logger.ts` (`createStructuredEvent`, `emitTelemetryEvent`):

### Allowlisted Event Schema

Every emitted telemetry JSON record contains **only** the following safe fields:

| Field | Type | Contract |
|---|---|---|
| `timestamp` | ISO-8601 UTC `string` | Event emission time. |
| `level` | `"info" \| "warn" \| "error"` | Derived from status/error code or explicit level. |
| `requestId` | `string` | Correlation / request ID (stripped of query strings & PII; `"unknown"` / `"redacted"` fallback). |
| `tenantId` | `string \| null` | Safe tenant identifier (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) where applicable; `null` for platform/unknown scope. |
| `operation` | `string` | Stable operation name (e.g. `http.request`, `backup.daily_platform_db`, `backup.isolated_restore_drill`); query strings stripped. |
| `status` | `"ok" \| "degraded" \| "error" \| number` | Machine status or HTTP status code (`100–599`). |
| `durationMs` | `number` | Non-negative integer duration in milliseconds. |
| `errorCode` | `string \| null` | Bounded uppercase machine error code (`sanitizeErrorCode`); **never** raw `Error.message` or stack traces. |
| `metrics` | `Record<string, number \| boolean \| string \| null>` (optional) | Allowlisted scalar counters only (e.g. `tableCount`, `totalRows`, `ageSeconds`). |

### Strictly Stripped / Forbidden Data

`createStructuredEvent` drops all unlisted top-level keys and scrubs any embedded sensitive strings via `stripQueryString` + `redactSensitiveString` (`packages/core/src/jobs/redact.ts`):
- Request and response bodies (`body`, `requestBody`, `responseBody`, `payload`, `formData`)
- Authentication headers & session material (`Authorization`, `Bearer ...`, `Cookie`, `Set-Cookie`, `__Host-*`, JWTs, API keys, TOTP/backup codes)
- URL query strings and fragments (`?...`, `#...`)
- Personal fields / PII (email addresses, Indonesian `08...`/`+628...` and international phone numbers, lead names/messages, IP addresses)
- Internal runtime config (environment variables, binding names, bucket names, R2 keys, stack traces)

### Tracked Operational Signals

- SSR error rate & request latency (`http.request`)
- D1 / `PLATFORM_DB` availability & latency (`/api/health/db`)
- Rejected anonymous lead attempts & rate-limit spikes (`TASK-029`)
- Custom domain pending age & repeated reconciliation failures
- Durable Queue dead-letter / stale-running jobs & oldest image job age (`/api/health/jobs`)
- Daily `PLATFORM_DB` R2 backup freshness (`/api/health/backup`)
- AutoLaris Advice reconciliation sweep freshness (`/api/health/jobs` -> `advice`)

---

## 2. Public Non-Secret Health & Readiness Endpoints

Implemented in `apps/web/src/pages/api/health/` (`index.ts`, `db.ts`, `jobs.ts`, `backup.ts`, `probe-helpers.ts`):

| Endpoint | Purpose | Healthy Response (`200`) | Failure / Degraded Behavior |
|---|---|---|---|
| `GET /api/health` | Worker liveness heartbeat | `{ status: "ok", service: "punyasitus-web", timestamp }` | Always lightweight; no external I/O. |
| `GET /api/health/db` | `PLATFORM_DB` `SELECT 1` readiness | `{ status: "ok", service: "punyasitus-web", timestamp }` | Returns `503` `{ status: "degraded", service, timestamp }`; swallows SQL errors and stack traces. |
| `GET /api/health/jobs` | `job_ledger` dead-letter / stale-lease counts + AutoLaris Advice freshness | `{ status: "ok", service, deadLetterCount: 0, staleRunningCount: 0, advice: { status, ageSeconds }, timestamp }` | Returns `200` with `status: "degraded"` when dead letters, stale leases, or stale Advice exist; `503` if DB unreachable. Never queries `payload_json`. |
| `GET /api/health/backup` | Latest daily `PLATFORM_DB` export freshness (`<= 26h`) | `{ status: "ok", service, freshness: "ok", ageSeconds, timestamp }` | Returns `200` with `status: "degraded", freshness: "stale"` when missing or `> 26h`; `503` if storage unreachable. Never reveals bucket names or R2 keys. |

Every health response sets:
- `Cache-Control: no-store`
- `X-Robots-Tag: noindex, nofollow`
- `Content-Security-Policy: default-src 'none'`

---

## 3. Alert Thresholds & Escalation (`packages/core/src/telemetry/alerts.ts`)

`evaluateAlertThresholds()` enforces the exact `PLAN.md` §9 thresholds:

| Alert ID | Condition | Severity | Operator Action |
|---|---|---|---|
| `HTTP_5XX_RATE_HIGH` | HTTP `5xx` rate **`> 1%`** over **`>= 5 minutes`** with **`>= 100` requests** | `warning` (`critical` at `>= 5%`) | Check recent Worker deploy, `/api/health/db`, and Cloudflare Workers Logs; initiate compatible rollback if regression confirmed. |
| `IMAGE_JOB_BACKLOG_STALE` | Oldest pending/running image processing job **`> 15 minutes`** | `warning` (`critical` at `>= 30m`) | Inspect `job_ledger` via `console.punyasitus.com/jobs` (dead-letter / lease stalls) and Cloudflare Images / Queue throughput. |
| `DOMAIN_RECONCILIATION_REPEATED_FAILURE` | Custom domain reconciliation **`>= 3` consecutive failures** | `warning` (`critical` at `>= 6`) | Check Cloudflare for SaaS quota, zone token validity, and `console.punyasitus.com/domains` error codes without forcing active status. |
| `PLATFORM_BACKUP_STALE` | Latest verified `PLATFORM_DB` R2 backup age **`> 26 hours`** or missing | `critical` | Inspect `cron.daily_platform_backup` in `job_ledger`, re-run manually after root-cause check, and confirm `/api/health/backup` returns `"freshness":"ok"`. |
| `AUTOLARIS_ADVICE_STALE` | AutoLaris Advice sweep age **`> 2 hours`** (2 missed hourly cron ticks) or missing/repeated failure | `warning` / `critical` | Check static-IP AutoLaris egress relay and `job_ledger` for `cron.billing_advice_sweep`; never mutate entitlement state manually without verified settlement. |

### External Uptime Probes (`OBSERVABILITY.md`)

Because early-stage and low-volume tenant sites may have quiet traffic windows where organic 5xx thresholds do not trip (`< 100` requests), external synthetic uptime probes are mandatory upon staging/production activation:
- **Admin host:** `https://app.punyasitus.com/api/health` and `/auth/login`
- **Canary tenant host:** `https://canary.situsku.click/` (plus negative check `https://does-not-exist-canary.situsku.click/` -> `404`)
- **Readiness & freshness:** `/api/health/db`, `/api/health/jobs`, `/api/health/backup`

All executable probe lines are maintained canonically in [OBSERVABILITY.md](../../OBSERVABILITY.md).

---

## 4. Staged Release & Compatible Rollback Procedure (`PLAN.md` §9)

1. **Pre-Release Verification (CI Gate — zero production credentials):**
   - Clean frozen-lockfile install passes `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build` (plus `pnpm test:e2e` / `pnpm test:security` at release gates).
   - Verify all database migrations are strictly **additive** and backward-compatible with the currently running Worker version.
2. **Stage 1 — Isolated Staging Deploy (separate authorization required):**
   - Apply additive `PLATFORM_DB` migrations using dedicated migration credentials (separate from runtime app credentials).
   - Deploy Worker to staging (`staging.punyasitus.com`) and run every executable probe in [OBSERVABILITY.md](../../OBSERVABILITY.md) against staging hosts.
   - If the release includes a major schema migration, execute an isolated restore drill ([backup-restore.md](./backup-restore.md) §3) before promotion.
3. **Stage 2 — Canary Tenant Verification:**
   - Verify `canary.situsku.click` (public SSR, cache headers, neutral 404 on unknown host, admin dashboard, and zero elevated 5xx or dead-letter jobs).
4. **Stage 3 — Production Promotion (explicit operator authorization required):**
   - Production deployment, DNS changes, and remote database writes require separate explicit approval.
   - Monitor `/api/health`, `/api/health/db`, `/api/health/jobs`, `/api/health/backup`, and 5xx error rates for 15 minutes post-deploy.
5. **Rollback Decision Tree:**
   - **Schema-compatible Worker regression:** Roll back to the previous Worker version immediately via Wrangler rollback (`wrangler rollback`), keeping the additive schema intact.
   - **Schema-incompatible change:** Do **not** execute destructive down-migrations. Ship an audited forward-fix or, for severe data corruption, follow [backup-restore.md](./backup-restore.md) (D1 Time Travel / R2 logical restore + DO PITR `restore(bookmark)` + mandatory `replayDeletionTombstones`).

See also: [Backup, Restore Drill & Tombstone Replay Runbook](./backup-restore.md) | [Observability Contract](../../OBSERVABILITY.md)
