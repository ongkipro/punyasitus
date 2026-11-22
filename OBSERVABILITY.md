# Observability Contract — punyasitus

Updated: 2026-11-22
Status: REQUIRED

Probe format:

```text
Probe: <name>|<url>|<expected-status>|<contains-or-TBD>|<max-latency-ms>
```

The expected status may be an exact code (`200`) or an inclusive range
(`200-299`). Every configured probe is mandatory. Use stable, non-secret public
endpoints only; private-network probes require an explicit local-test override.

No probe is active yet: nothing is deployed (`State: PLANNED`). The planned probes below become active lines only when `TASK-037` exposes the endpoints and a staging or production host exists; until then `release-check` has nothing to run.

```text
Planned (activate in TASK-037):
Probe: marketing|https://punyasitus.com/|200-299|PunyaSitus|2000
Probe: app|https://app.punyasitus.com/auth/login|200-299|Masuk|2000
Probe: health|https://app.punyasitus.com/api/health|200-299|ok|1000
Probe: platform-db|https://app.punyasitus.com/api/health/db|200-299|ok|750
Probe: jobs|https://app.punyasitus.com/api/health/jobs|200-299|ok|1000
Probe: canary-tenant|https://canary.situsku.click/|200-299|canary|2000
Probe: unknown-tenant-404|https://does-not-exist-canary.situsku.click/|404-404|Halaman tidak ditemukan|2000
```

The endpoint paths are proposals; TASK-037 records the final paths. The tenant base domain `situsku.click` is final (DEC-045).

## Recommended production probes

Add probes for database connectivity, background jobs, queue/worker health, or a
critical-error sentinel when the application exposes stable HTTP endpoints for
them. Keep vendor-specific credentials and query tokens out of this file.

Examples:

```text
Probe: database|https://example.com/health/db|200-299|ok|750
Probe: background-jobs|https://example.com/health/workers|200-299|ok|1000
Probe: critical-errors|https://example.com/health/errors|200-299|critical_errors=0|1000
```
