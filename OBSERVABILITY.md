# Observability Contract — punyasitus

Updated: 2026-11-23
Status: REQUIRED

> **Deployment Activation Notice:** All health and readiness endpoints below are implemented in `TASK-037` (`apps/web/src/pages/api/health/`). Staging and production host URLs activate only upon authorized staging/production deployment; **no production deployment, DNS mutation, or live external probe provisioning has been executed**.

## Probe Format

```text
Probe: <name>|<url>|<expected-status>|<contains>|<max-latency-ms>
```

- `<expected-status>` is an exact HTTP code (`200`) or inclusive range (`200-299`).
- `<contains>` is a non-secret substring that must appear in the HTTP response body.
- Every configured probe is mandatory once its target environment is deployed.
- Keep credentials, API keys, bindings, and query tokens out of this file and out of every health response.

## Executable Service & Host Probes

```text
Probe: marketing|https://punyasitus.com/|200-299|PunyaSitus|2000
Probe: admin-host|https://app.punyasitus.com/auth/login|200-299|Masuk|2000
Probe: tenant-host|https://canary.situsku.click/|200-299|canary|2000
Probe: unknown-tenant-404|https://does-not-exist-canary.situsku.click/|404-404|Halaman tidak ditemukan|2000
Probe: worker-heartbeat|https://app.punyasitus.com/api/health|200-299|"status":"ok"|1000
Probe: platform-db|https://app.punyasitus.com/api/health/db|200-299|"status":"ok"|750
Probe: jobs|https://app.punyasitus.com/api/health/jobs|200-299|"status":"ok"|1000
Probe: backup-freshness|https://app.punyasitus.com/api/health/backup|200-299|"freshness":"ok"|1000
Probe: autolaris-advice-freshness|https://app.punyasitus.com/api/health/jobs|200-299|"advice":{"status":"ok"|1000
```

## External Uptime Alerting & Synthetic Monitoring (`PLAN.md` §9)

Low-volume tenant sites cannot rely solely on organic traffic to surface outages. Upon authorized staging/production deployment, configure an external uptime monitor (independent of Cloudflare Workers) targeting:

1. **Admin host:** `https://app.punyasitus.com/api/health` + `https://app.punyasitus.com/auth/login` (60-second interval, alert operator after 2 consecutive failures or HTTP `5xx` / timeout `> 2000ms`).
2. **Canary tenant host:** `https://canary.situsku.click/` (60-second interval, alert operator after 2 consecutive failures or missing tenant marker) plus negative check `https://does-not-exist-canary.situsku.click/` expecting neutral `404`.
3. **Readiness & freshness probes:** `https://app.punyasitus.com/api/health/db`, `/api/health/jobs`, and `/api/health/backup` (5-minute interval, alert operator immediately on `503` or `"status":"degraded"`).

## Operational Runbooks

- Structured telemetry redaction, alert thresholds, and compatible release/rollback rules: [docs/operations/telemetry-release.md](docs/operations/telemetry-release.md)
- Backup topology, RPO/RTO measurements, isolated restore drill, and `DEC-022` tombstone replay: [docs/operations/backup-restore.md](docs/operations/backup-restore.md)
- Privacy retention, DSR 72h workflow, and breach notification: [docs/operations/privacy.md](docs/operations/privacy.md)
