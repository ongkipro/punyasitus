# Owner Full-Website Export Archive & Self-Service Deletion API (`REQ-107`, `TASK-107`)

> Contract authority: `PRD.md` (`REQ-107`), `PLAN.md` (§20.4), `DECISIONS.md` (`DEC-022`, `DEC-043`).

## Access & Security Invariants

- **Surface:** `app.punyasitus.com` only (returns neutral `404` on tenant, marketing, and console hosts).
- **Authorization:** Strictly **`owner` ONLY** (`members.role === 'owner'`).
  - `admin`, `editor`, `agency_staff`, and `setup_staff` receive `403 FORBIDDEN`.
  - Non-members, cross-tenant selectors, and purged tenants receive `404 NOT_FOUND`.
- **CSRF/Origin:** All state-changing methods (`POST`, `DELETE`) require `Content-Type: application/json` and exact `Origin: https://app.punyasitus.com`.
- **No-Store Privacy:** All JSON and ZIP responses return `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, and `Vary: Cookie`.

---

## 1. Full-Website Export Archive Endpoints

### `GET /api/tenants/:tenantId/exports`
Lists recent export archive jobs for the verified tenant and today's `Asia/Jakarta` daily quota status (`dailyLimit: 1`).

- Returns signed `downloadUrl` **only** when `status === 'ready'` and `now < downloadExpiresAt`.
- Never exposes `download_token_hash` or raw R2 keys.

### `POST /api/tenants/:tenantId/exports`
Requests a new full-website ZIP archive for the tenant.

- **Rate limit:** At most **1 non-failed export per website per Asia/Jakarta calendar day** (`YYYY-MM-DD`). A second request on the same day returns `429 RATE_LIMITED` with `Retry-After` until next `00:00 WIB`.
- **Async execution:** Records a `tenant_export_jobs` row (`status = 'queued'`), appends an immutable `platform_audit` entry (`tenant.export.requested`), and enqueues an idempotent `exports.generate_archive` job via `job_ledger` + `JOBS_QUEUE`.
- **Archive layout (`t/<tenantId>/exports/<exportId>.zip`):**
  - `manifest.json` — format version, export metadata, item counts, explicit `truncated: { pages, posts, offerings, leads, media, any }` flags, included file list, skipped media diagnostics.
  - `site.json` — tenant handle/name/vertical, `site_settings`, `business_profile` (scrubbed of any secret/token/credential keys).
  - `pages.json` — all non-trashed pages (draft & published sections, SEO, metadata).
  - `posts.json` — all non-trashed blog posts.
  - `offerings.json` — all non-trashed offerings.
  - `leads.csv` — UTF-8 CSV with spreadsheet formula neutralization on free-text columns while preserving faithful E.164 `+62...` phone numbers.
  - `media/<id>-<safe-filename>` — ready media files copied strictly from `t/<tenantId>/` (excluding `exports/` and `trash/`, bounded to `<= 32 MiB` total in-memory ZIP ceiling / `<= 16 MiB` per file / `<= 500` files).

### `GET /api/tenants/:tenantId/exports/:exportId`
Returns status, manifest, and signed download link (if ready and unexpired) for a single export job.

### `GET /api/tenants/:tenantId/exports/:exportId/download?token=<hmac-token>`
Streams the ZIP archive (`Content-Type: application/zip`, `X-Content-Type-Options: nosniff`).

- Verifies HMAC-SHA256 signature bound to `(exportId, tenantId, ownerUserId, expiresAtMs)` **and** SHA-256 hash stored in `tenant_export_jobs.download_token_hash`.
- Strictly bound to the authenticated owner session and tenant.
- Returns `410 EXPORT_EXPIRED` after 24 hours (`nowMs >= download_expires_at`).

---

## 2. Self-Service Deletion with 7-Day Undo Endpoints

### `GET /api/tenants/:tenantId/deletion`
Returns current deletion status (`canRequestDeletion`, `canCancelDeletion`, `remainingUndoMs`, `activeRequest`, `latestRequest`, `operatorHold`, and `authCapabilities`).

### `POST /api/tenants/:tenantId/deletion`
Schedules self-service website deletion with a **7-day undo window**.

**Request body (`application/json`):**
```json
{
  "confirmHandle": "my-site-handle",
  "currentPassword": "required-when-2fa-not-enabled",
  "reason": "Optional owner reason (<= 500 chars)"
}
```

- **Typed confirmation:** `confirmHandle` must match the exact tenant handle (`422 VALIDATION_ERROR` otherwise).
- **Step-up authentication (`403 TOTP_REQUIRED` / `REAUTH_REQUIRED` if missing/stale):**
  - When `users.two_factor_enabled = 1`: **strictly requires** a recent Better Auth 2FA session verification (`session_two_factor_verifications` within 10 minutes); password alone never bypasses active 2FA.
  - When 2FA is not enabled: requires verified `currentPassword`, explicit recent reauth (`<= 10 min`), or fresh OAuth-only session (`<= 10 min`) for accounts without password credentials.
- **Immediate offline effect:** Atomically transitions `tenants.status = 'suspended'`, sets `tenants.deletion_due_at = now + 7d`, increments `cache_version`, evicts host cache (next public request returns HTTP `503` neutral page), inserts `tenant_deletion_requests` (`status = 'scheduled'`), and appends `platform_audit` (`tenant.deletion.requested`).
- **Operator hold guard:** Blocked with `409 OPERATOR_HOLD_ACTIVE` if `operator_hold = 1` or `retention_paused_at IS NOT NULL`.

### `POST /api/tenants/:tenantId/deletion/cancel` (and `DELETE /api/tenants/:tenantId/deletion`)
Cancels a pending deletion request strictly before `deletion_due_at` (`nowMs < deletion_due_at`).

- Atomically restores `tenants.status` (re-evaluating commercial entitlement accurately from `previous_status`, `paid_through`, `trial_ends_at`), restores `tenants.deletion_due_at`, bumps `cache_version`, evicts host cache, marks `tenant_deletion_requests.status = 'canceled'`, and appends `platform_audit` (`tenant.deletion.canceled`).
- After the 7-day window closes (or once purge has been claimed), returns `409 DELETION_WINDOW_EXPIRED`.

---

## 3. Queue Topics & Daily Cron Jobs

| Topic | Trigger | Behavior |
|---|---|---|
| `exports.generate_archive` | Enqueued by `POST /api/tenants/:tenantId/exports` | Builds safe ZIP archive in R2 (`t/<tenantId>/exports/<exportId>.zip`), mints 24h signed token hash, updates job ledger. |
| `exports.cleanup_expired` | Daily cron (`0 2 * * *`) | Deletes expired export ZIPs (`download_expires_at <= now`) from R2 and marks rows `deleted`. |
| `exports.deletion_sweep` | Daily cron (`0 2 * * *`) | Claims due uncancelled deletion requests (`now >= deletion_due_at`) and executes the existing serialized REQ-069 purge (`executeTenantOffboardingPurge`) while preserving billing obligations, settlements, numbered receipts, and `platform_audit` (`DEC-022`). |
