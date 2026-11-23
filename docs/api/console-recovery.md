# Superadmin Console — Domain & Job Recovery Queues API (`REQ-050`, `TASK-047`)

Served **exclusively** on `console.punyasitus.com` (or local loopback when `APP_ENV === "local"`). Requests arriving on `app.punyasitus.com`, `punyasitus.com`, or any tenant host return a **bare neutral `404 Not Found`** (`text/plain; charset=utf-8`, `cache-control: private, no-store`, `x-robots-tag: noindex, nofollow`) without disclosing console HTML or copy.

## Common Security, Redaction & Audit Invariants

- **Authentication & Grant:** Every endpoint requires a live session within the superadmin lifetime ceiling (`30m` idle / `8h` absolute), an active row in `PLATFORM_DB.platform_operators` (`revoked_at IS NULL`), and mandatory enrolled + verified 2FA (`TASK-067`). Tenant `owner`/`admin`/`editor` roles never confer platform access (`403 PLATFORM_OPERATOR_REQUIRED`); revoked operators fail immediately (`403 OPERATOR_REVOKED`).
- **Step-Up 2FA Reauthentication:** All state-changing mutations (`POST`) enforce `requireRecentSecondFactor` (10-minute step-up window, else `403 REAUTH_REQUIRED`), CSRF `Origin`, `Content-Type: application/json`, a `16 KiB` body cap, and strict Zod v4 `.strict()` schemas (`422 UNKNOWN_FIELD`).
- **Atomic Audit & Idempotency:** All mutations require a `10–500` character non-secret `reason`, an `Idempotency-Key` header or `idempotencyKey` body field, and optimistic concurrency (`expectedVersion` for domains, `expectedUpdatedAt` for jobs). State changes, `platform_audit` (`WHERE changes() = 1`), and idempotency receipts commit inside ONE atomic `D1Database.batch([...])`.
- **No Verification/Suspension Bypass & No Payload Editor:**
  - Domain actions reject `forceActive` / `bypassVerification` (`422 UNKNOWN_FIELD`), never promote unverified hostnames to `active`, and never alter `tenants.status` or `tenants.operator_hold`. Provider timeouts leave the domain in `pending` / `deleting` with a safe `PROVIDER_TIMEOUT` code and never fabricate success.
  - Job actions reject `payload` / `payloadJson` / `overridePayload` (`422 UNKNOWN_FIELD`), never expose raw `payload_json`, scrub all secrets/tokens/cookies/emails/phones/lead bodies, and strictly reject live active leases (`409 JOB_LEASE_ACTIVE`) and completed jobs (`409 JOB_ALREADY_COMPLETED`).

---

## Domain Recovery Endpoints

### `GET /api/console/domains`
List, search, filter, and paginate custom hostnames across tenants, ordered **exceptions first** (`failed`, `moved`, `deleting`, stuck `pending`, `active`).

- **Query params:**
  - `status` (optional): `all` | `exceptions` | `pending` | `active` | `failed` | `moved` | `deleting` (default `all`).
  - `search` (optional): matches hostname, tenant handle, tenant name, or exact `tenantId`.
  - `tenantId` (optional): filter to a single tenant.
  - `page` (`1..1000`, default `1`), `limit` (`1..100`, default `20`).
- **Response `200`:** `{ success: true, requestId, items, page, limit, totalCount, totalPages, hasMore, counts }`.

### `POST /api/console/domains/recheck` & `POST /api/console/domains/{hostname}/recheck`
Execute a rate-limited, audited Cloudflare + DNS reconciliation for a tenant's custom hostname.

- **Headers:** `Idempotency-Key: <token>` (8–128 safe chars).
- **Body (strict):** `{ tenantId, hostname?, expectedVersion, sslMethod?: "http" | "txt", reason, idempotencyKey? }`.
- **Invariants:**
  - Forged `tenantId` + `hostname` pair returns `404 NOT_FOUND`; path-vs-body `hostname` mismatch returns `422 VALIDATION_ERROR`.
  - Enforces per-domain and per-tenant rate limits (`429 RATE_LIMITED` + `Retry-After`).
  - `sslMethod` is included in the idempotency request hash (`409 IDEMPOTENCY_CONFLICT` if replayed with different `sslMethod`).
  - On Cloudflare timeout / retryable 5xx, persists `failure_code = "PROVIDER_TIMEOUT"`, preserves the domain's existing status (`pending`, `failed`, `moved`, or `active` — never rewrites `moved` to `pending` and never promotes to `active`), keeps `tenant_hosts.version` unchanged so immediate retry succeeds cleanly, writes an `error` audit row, and returns `503 SERVICE_UNAVAILABLE` (`reasonCode: "PROVIDER_TIMEOUT"`, `reconciliationPending: true`, `expectedVersion`) without unsuspending the tenant.
- **Responses:** `200 OK` (`replayed` boolean, `domain`, `auditId`), `404 NOT_FOUND`, `409 STALE_VERSION`, `409 IDEMPOTENCY_CONFLICT`, `422 UNKNOWN_FIELD` / `VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 SERVICE_UNAVAILABLE`.

### `POST /api/console/domains/change`
Operator-only tenant domain change (REQ-065): removes locked custom hostname(s), restores `<handle>.situsku.click` as primary, and optionally connects a new custom hostname in `pending` state.

- **Headers:** `Idempotency-Key: <token>` (8–128 safe chars).
- **Body (strict):** `{ tenantId, hostname, confirmHostname, confirmRemoveLocked: true, removeDomainSet?, newHostname?, connectMode?, sslMethod?, confirmApexFlattening?, expectedVersion, reason, idempotencyKey? }`.
- **Invariants:**
  - Requires exact `confirmHostname === hostname` and `confirmRemoveLocked: true`.
  - Enforces REQ-065 max-2 custom hostnames (`409 DOMAIN_LIMIT_REACHED`) and single apex/www domain-set compatibility (`422 DOMAIN_SET_MISMATCH`) both in precheck and atomically in SQL when `removeDomainSet: false`.
  - Trial tenants cannot connect a new custom domain (`403 TRIAL_DOMAIN_FORBIDDEN`); `purging`/`purged` tenants are rejected (`409 TENANT_NOT_ELIGIBLE`).
  - New domain always starts `pending` (never force-active) and never modifies `tenants.status` or `tenants.operator_hold`.
  - Finalization atomically deletes version-guarded target hostnames, writes `platform_audit`, and writes the idempotency receipt in one D1 batch so retries across provider failures replay cleanly instead of returning `404`.
  - On Cloudflare delete timeout, old hostnames remain `deleting` (routing disabled, subdomain fallback active) and returns `503 SERVICE_UNAVAILABLE` (`cleanupPending: true`). On Cloudflare create timeout or non-retryable rejection, records `failure_code` + error audit row (`console.domain.change.create_timeout` / `console.domain.change.provider_failed`) and returns `503` / `502` while keeping the new domain `pending`.
- **Responses:** `200 OK` (`replayed`, `removedHostnames`, `restoredSubdomainPrimary`, `newDomain`, `auditId`), `403`, `404`, `409`, `422`, `503`.

---

## Job Recovery Endpoints

### `GET /api/console/jobs`
List, search, filter, and paginate durable background jobs from `PLATFORM_DB.job_ledger` with multi-layer secret/PII redaction and retry eligibility metadata.

- **Query params:**
  - `status` (optional): `exceptions` (default: `failed`, `dead_letter`, expired-lease `running`) | `all` | `failed` | `dead_letter` | `running` | `queued` | `completed`.
  - `topic` (optional), `tenantId` (optional), `search` (optional).
  - `page` (`1..1000`, default `1`), `limit` (`1..100`, default `20`).
- **Response `200`:** `{ success: true, requestId, items, page, limit, totalCount, totalPages, hasMore, counts, topics }`.
  - Each item includes `redactedPayloadSummary` (never raw secrets/tokens/PII/lead bodies), `lastErrorCode` (sanitized), `leaseState` (`active` | `expired` | `none`), `retryEligible`, `retryIneligibleReasonCode`, and `cancelEligible`.

### `POST /api/console/jobs/retry` & `POST /api/console/jobs/{jobKey}/retry`
Atomically reset an eligible `failed`, `dead_letter`, or expired-lease `running` job to `queued` and re-dispatch its original validated envelope without editing its payload.

- **Headers:** `Idempotency-Key: <token>` (8–128 safe chars).
- **Body (strict):** `{ jobIdempotencyKey?, tenantId: string | null, expectedUpdatedAt, reason, idempotencyKey? }`.
- **Invariants:**
  - Live active leases fail `409 JOB_LEASE_ACTIVE`; completed jobs fail `409 JOB_ALREADY_COMPLETED`; fresh `queued` jobs fail `409 JOB_NOT_RETRYABLE` while stale `queued` jobs (`> 5m` with `lease_until IS NULL`) remain retry-eligible.
  - Enforces a bounded operator retry cap (`MAX_OPERATOR_JOB_RETRIES = 5`, else `409 JOB_RETRY_LIMIT_REACHED`).
  - Forged `jobIdempotencyKey` or mismatched `tenantId` fails `404 NOT_FOUND`; path-vs-body `jobIdempotencyKey` mismatch fails `422 VALIDATION_ERROR`.
  - Any payload override field fails `422 UNKNOWN_FIELD`.
  - If `JOBS_QUEUE` is unavailable or `send()` fails, atomically reverts the job to `failed` (`QUEUE_UNAVAILABLE` / `QUEUE_DISPATCH_FAILED`), removes the failed retry receipt, logs an error audit row, and returns `503 SERVICE_UNAVAILABLE`.
  - Concurrent duplicate clicks with the same `Idempotency-Key` replay cleanly (`replayed: true`) without double-enqueueing.
- **Responses:** `200 OK` (`replayed`, `dispatched`, `job`, `auditId`), `404`, `409`, `422`, `500`, `503`.

### `POST /api/console/jobs/cancel`
Atomically move an eligible `queued`, `failed`, or expired-lease `running` job to terminal `dead_letter` (`OPERATOR_CANCELED`). Rejects completed jobs and active leases.

- **Body (strict):** `{ jobIdempotencyKey, tenantId: string | null, expectedUpdatedAt, reason, idempotencyKey? }`.
- **Responses:** `200 OK` (`replayed`, `job`, `auditId`), `404`, `409`, `422`, `500`.
