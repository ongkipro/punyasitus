# Superadmin Console — Tenant Directory & Scoped Operations API (`REQ-049`, `TASK-046`)

Served **exclusively** on `console.punyasitus.com` (or local loopback when `APP_ENV === "local"`). Requests arriving on `app.punyasitus.com`, `punyasitus.com`, or any tenant host return a **bare neutral `404 Not Found`** (`text/plain; charset=utf-8`, `cache-control: private, no-store`, `x-robots-tag: noindex, nofollow`) without disclosing console HTML or copy.

## Common Security & Audit Requirements

- **Authentication & Grant:** Every endpoint requires a live session within the superadmin lifetime ceiling (`30m` idle / `8h` absolute), an active row in `PLATFORM_DB.platform_operators` (`revoked_at IS NULL`), and mandatory enrolled + verified 2FA (`TASK-067`). Tenant `owner`/`admin`/`editor` roles never confer platform access (`403 PLATFORM_OPERATOR_REQUIRED`); revoked operators fail immediately (`403 OPERATOR_REVOKED`).
- **Step-Up 2FA Reauthentication:** All state-changing mutations (`POST`) require second-factor verification within the last **10 minutes** (`403 REAUTH_REQUIRED`).
- **CSRF & Strict JSON:** All `POST` requests enforce `Content-Type: application/json`, exact console `Origin`, a `16 KiB` body cap, and strict field allowlists (`422 UNKNOWN_FIELD`).
- **Audit & Optimistic Concurrency:** All mutations require a `10–500` character non-secret `reason`, an `Idempotency-Key` header or `idempotencyKey` field, and (for existing tenants) a positive integer `expectedVersion` (`409 STALE_VERSION`). State writes and `platform_audit` rows commit inside a single atomic `D1Database.batch([...])` gated on `WHERE changes() = 1`; audit failure rolls back the mutation with zero side effects.
- **No Impersonation & No Blanket Content/PII Access:** Directory and detail reads query narrow `PLATFORM_DB` control-plane metadata only. Revoking a theme grant reads only `site_settings.active_theme_id` from `TenantStore` (failing closed `503` if unavailable) and never reads or mutates tenant content tables (`pages`, `posts`, `offerings`, `menus`, `media_items`, `leads`).

---

## Endpoints

### `GET /api/console/tenants`
List, search, filter, and paginate control-plane tenants.

- **Query params:**
  - `search` (optional): matches tenant `name`, `handle`, exact `id`, or any host in `tenant_hosts`.
  - `status` (optional): `all` or a valid `TenantStatus` (`trial`, `active`, `grace`, `locked`, `suspended`, `recovery`, `purging`, `purged`, `provisioning`).
  - `vertical` (optional): `all` or a valid `TenantVertical` (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`).
  - `page` (optional, integer `1..1000`, default `1`).
  - `limit` (optional, integer `1..100`, default `20`).
- **Response `200`:** `{ success: true, requestId, items, page, limit, totalCount, totalPages, hasMore, statusCounts }`.

### `POST /api/console/tenants`
Atomically provision a new tenant (organization, tenant, primary `<handle>.situsku.click` host, initial owner membership or 48h pending owner invitation, idempotency ledger, and `platform_audit`).

- **Headers:** `Idempotency-Key: <uuid-or-token>` (8–128 safe chars).
- **Body:** `{ handle, name, ownerEmail, vertical?, initialStatus: "trial" | "active", reason, idempotencyKey?, paidThroughMs?, trialEndsAtMs? }`.
- **Responses:** `201 Created` (fresh), `200 OK` with `replayed: true` (idempotent retry), `409 HANDLE_TAKEN`, `409 IDEMPOTENCY_CONFLICT`, `422 VALIDATION_ERROR`.

### `GET /api/console/tenants/{tenantId}`
Read control-plane metadata for a single tenant (accepts ULID `tenantId` or lowercase `handle`).

- **Response `200`:** `{ success: true, requestId, tenant, owner, domains, grantedThemes, activeThemeId, activeThemeVerificationStatus, allowedStateActions, recentAudit, registeredCustomThemes }`.
- **Errors:** `401`, `403`, `404 NOT_FOUND`.

### `POST /api/console/tenants/{tenantId}/state`
Execute an audited service-state transition enforcing the allowed transition matrix.

- **Body:** `{ action: "suspend_hold" | "release_hold" | "enter_recovery" | "exit_recovery" | "set_status", targetStatus?, operatorHold?, paidThroughMs?, trialEndsAtMs?, reason, expectedVersion, idempotencyKey? }`.
- **Invariants:**
  - `release_hold` recomputes effective entitlement status and **never grants free active time**.
  - Rejects disallowed transitions (e.g., `release_hold` when not held, double `suspend_hold`, transitions on `purging`/`purged`) with `409 INVALID_STATE_TRANSITION`.
- **Responses:** `200 OK` (`replayed` boolean), `404 NOT_FOUND`, `409 STALE_VERSION`, `409 INVALID_STATE_TRANSITION`, `409 IDEMPOTENCY_CONFLICT`, `422 VALIDATION_ERROR`, `500 AUDIT_PERSISTENCE_FAILED`.

### `GET /api/console/tenants/{tenantId}/themes`
List granted custom themes, read-only active theme verification status, and build-time registered custom themes available to grant.

### `POST /api/console/tenants/{tenantId}/themes`
Grant or revoke a registered custom theme for a tenant.

- **Body:** `{ themeId, action: "grant" | "revoke", reason, expectedVersion, idempotencyKey? }`.
- **Invariants:**
  - `grant` accepts **only** custom themes present in the closed build-time `REGISTERED_CUSTOM_THEMES` registry; unregistered IDs fail with `422 UNREGISTERED_THEME`, and built-in platform themes (`compro`..`dealer`) fail with `422 BUILT_IN_THEME_NOT_GRANTABLE`.
  - `revoke` verifies `TenantStore.site_settings.active_theme_id` and **blocks revoking the tenant's currently active theme (`409 ACTIVE_THEME_PROTECTED`)**. If `TenantStore` cannot be verified, revocation **fails closed (`503 ACTIVE_THEME_VERIFICATION_UNAVAILABLE`)**.
- **Responses:** `200 OK` (`{ success, action, themeId, replayed, tenant, grantedThemes, auditId }`), `404 NOT_FOUND`, `404 THEME_GRANT_NOT_FOUND`, `409 STALE_VERSION`, `409 THEME_ALREADY_GRANTED`, `409 ACTIVE_THEME_PROTECTED`, `409 IDEMPOTENCY_CONFLICT`, `422 UNREGISTERED_THEME`, `422 BUILT_IN_THEME_NOT_GRANTABLE`, `500 AUDIT_PERSISTENCE_FAILED`, `503 ACTIVE_THEME_VERIFICATION_UNAVAILABLE`.
