# Public Abuse Reporting, Console Moderation Queue & Tenant Activity Log API (`TASK-094`, `REQ-094`)

This document specifies the HTTP endpoints, security boundaries, data retention/redaction guarantees, and audit invariants introduced by **TASK-094**.

---

## 1. Public Host-Scoped Abuse Reporting

### `GET /api/abuse-report` (Tenant Host HTML Form)
- **Surface:** Verified tenant host (`<handle>.situsku.click` or active custom domain) only. Returns neutral `404 NOT_FOUND` on marketing, app, console, or unknown hosts.
- **Behavior:**
  - When `Accept` includes `text/html`, renders a lightweight zero-JS progressive-enhancement Bahasa Indonesia abuse report form (URL/path prefilled from `?path=`, closed violation category selector, description textarea, optional reporter email, hidden honeypot field, and optional Turnstile widget).
  - For non-HTML callers, returns `405 BAD_REQUEST` with `Allow: POST`.
- **Headers:** `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`.

### `POST /api/abuse-report`
- **Surface:** Verified tenant host only (`404 NOT_FOUND` on non-tenant hosts; tenant scope comes exclusively from verified `Host`).
- **Content Types:** `application/json`, `application/x-www-form-urlencoded`, `multipart/form-data` (UTF-8, hard cap `16,384` bytes -> `413 PAYLOAD_TOO_LARGE`).
- **Security Controls (Fail-Closed):**
  1. **Origin / Sec-Fetch-Site Matrix (`apps/web/src/core/public-input.ts`):** Rejects `Origin: null` (`403 NULL_ORIGIN`), mismatched origins (`403 ORIGIN_MISMATCH`), missing `Origin` on JSON (`403 MISSING_ORIGIN`), and cross-site form submits (`403 CROSS_SITE_FORM`).
  2. **Forged Tenant Selector Rejection:** Any `tenantId`, `tenant_id`, `organizationId`, `organization_id`, `tenantHandle`, or `tenant_handle` key returns `422 VALIDATION_ERROR`.
  3. **Honeypot (`TASK-090`):** Populated `honeypot`, `hp_website`, `_hp_field`, or `website_url` silently returns a synthetic `201` (or `303`) without writing to `PLATFORM_DB`.
  4. **Cloudflare Turnstile (`TASK-090`):** Verifies `turnstileToken` / `cf-turnstile-response` / `X-Turnstile-Token` with `action: "abuse_report"` and `hostname: <verifiedHost>`. Fails closed (`503 TURNSTILE_NOT_CONFIGURED` / `403 TURNSTILE_REQUIRED` / `403 TURNSTILE_INVALID`) outside `local`/`test`.
  5. **Rate Limiting (Fail-Closed):** Atomic D1 counters in `PLATFORM_DB.abuse_rate_limit_buckets` using HMAC-SHA256 salted IP hashes (`5/min` per network+tenant, `50/hr` per tenant -> `429 RATE_LIMITED` + `Retry-After`; DB/salt outage -> `503 SERVICE_UNAVAILABLE`).
- **Request Body (`PublicAbuseReportRequest`):**
  ```json
  {
    "category": "phishing | scam | malware | impersonation | illegal_content | spam | other",
    "reportedPath": "/halaman-terlapor",
    "description": "Uraian dugaan pelanggaran minimal 10 karakter.",
    "reporterEmail": "pelapor@contoh.id",
    "turnstileToken": "..."
  }
  ```
- **Response (`201 Created`, JSON):**
  ```json
  {
    "reportId": "01J...",
    "status": "received"
  }
  ```
  - Form POST returns `303 See Other` to `/api/abuse-report?status=received&ref=<reportId>`.
  - Never echoes `tenantId`, tenant handle, owner email, or reporter email (zero enumeration / zero PII leakage).

---

## 2. Console Moderation Queue (`console.punyasitus.com`)

All `/console/abuse` pages and `/api/console/abuse/**` endpoints enforce:
- **Host Isolation:** Non-console hosts (`app.`, marketing, tenant hosts) receive a bare neutral `404 Not Found` (`text/plain`).
- **Authentication & Authorization:** Active `platform_operators` grant + verified 2FA (`TOTP_REQUIRED` if missing).
- **Step-Up 2FA:** Moderation mutations enforce `requireStepUp: true` (recent second factor within 10 minutes -> `403 REAUTH_REQUIRED`).

### `GET /api/console/abuse`
- Query parameters: `status` (`all | open | investigating | resolved | dismissed`), `category`, `search`, `cursor`, `limit` (`1..100`, default `20`).
- Returns paginated queue items (with masked reporter contact) plus per-status `counts`.

### `GET /api/console/abuse/{reportId}`
- Returns full report detail and append-only `abuse_moderation_actions` history (`404 NOT_FOUND` if missing).

### `POST /api/console/abuse/{reportId}/moderate`
- **Headers:** `Content-Type: application/json`, same-origin `Origin`, optional `Idempotency-Key`.
- **Body:**
  ```json
  {
    "action": "dismiss | unpublish | suspend",
    "reason": "Alasan audit moderasi minimal 10 karakter (maks 500).",
    "expectedVersion": 1
  }
  ```
- **Atomicity & Effects:**
  - `unpublish` requires a live `TenantStore` binding (`503 TENANT_STORE_UNAVAILABLE` if unavailable), normalizes single percent-encoded slugs cleanly, verifies actual SQLite unpublish `changes === 1` (`422 TARGET_CONTENT_NOT_FOUND` if 0 published pages/posts/offerings match) BEFORE finalizing the report in `PLATFORM_DB`, and rolls back the `TenantStore` change if the subsequent `PLATFORM_DB` batch fails or loses a version race.
  - `suspend` enforces lifecycle, offboarding, and CAS guards (`status NOT IN ('provisioning','purging','purged','recovery')`, `offboarding_started_at IS NULL`, `version = ?` -> `409 TENANT_NOT_ELIGIBLE` if ineligible), computes authoritative `deletion_due_at` and `retention_paused_at`, and cross-guards both `tenants` and `abuse_reports` inside ONE atomic `PLATFORM_DB.batch([...])` transaction.
  - Every moderation commit atomically writes `abuse_reports`, immutable `platform_audit` (`WHERE changes() = 1`), append-only `abuse_moderation_actions` (`WHERE changes() = 1`, storing `notification_status` and `idempotency_key`), and a durable `job_ledger` notification outbox row (dispatched via `JOBS_QUEUE` or `EmailPort` fallback, returning truthful `notificationStatus: "queued" | "sent" | "skipped" | "failed"`).
  - Concurrent duplicate requests with the same `Idempotency-Key` resolve via `(report_id, idempotency_key)` to `200` replay (matching payload) or `409 IDEMPOTENCY_CONFLICT` (mismatched payload).
  - Moderation rows mirrored into `TenantStore.tenant_activity_log` always set `actor_user_id = NULL` (and read-side redaction masks `actorUserId` for `platform_operator` entries) so internal operator user IDs are never exposed to tenants.

---

## 3. Tenant Single-Lead Permanent Deletion & Read-Only Activity Log (`app.punyasitus.com`)

### `DELETE /api/tenants/{tenantId}/leads/{leadId}`
- **RBAC:** Requires `"lead:delete"` (`owner`, `admin`, `agency_admin`).
  - `editor` -> `403 FORBIDDEN`.
  - Foreign tenant / non-member -> `404 NOT_FOUND`.
  - `locked` or `suspended` tenant -> `403 SUBSCRIPTION_LOCKED`.
- **Concurrency:** Optional `?version=<int>` query param or JSON `{ "expectedVersion": <int> }` (`409 STALE_VERSION` on mismatch).
- **Atomicity & Privacy:**
  - Executes ONE atomic `TenantStore` batch deleting the row from `leads`, cleaning up `lead_dedup`, and inserting a strictly PII-free `lead.deleted` row into `tenant_activity_log` (`WHERE changes() = 1`).
  - Raw visitor name, phone, email, message, answers, and notes are NEVER copied into `tenant_activity_log`.
  - Returns `204 No Content` with `Cache-Control: private, no-store`.

### `GET /api/tenants/{tenantId}/activity`
- **RBAC:** Requires `"settings:read"` (`owner`, `admin`, `agency_admin`).
  - `editor` -> `403 FORBIDDEN`.
  - Foreign tenant / non-member -> `404 NOT_FOUND`.
  - `locked` tenant -> allowed (read-only).
  - `suspended` tenant -> `403 SUBSCRIPTION_LOCKED`.
- **Read-Only:** Non-`GET` methods return `405` with `Allow: GET`.
- **Query Parameters:** `action`, `resourceType`, `actorRole`, `cursor`, `limit` (`1..100`, default `20`).
- **Redaction:** Every returned row passes defense-in-depth read-side redaction (`redactAuditText` + `redactAuditMetadata`).
