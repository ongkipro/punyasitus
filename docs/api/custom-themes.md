# Custom Theme Service Packages & Requests API (`TASK-061`, `REQ-063`)

> Canonical contract owners: `PRD.md` REQ-063; `PLAN.md` §4, §5, §11.4, §13; `DESIGN.md` Appearance.
> All endpoints set `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`, perform ZERO request-time DDL, and collect NO payment/checkout for custom theme work.

## 1. Tenant App Endpoints (`app.punyasitus.com`)

Served strictly on `app.punyasitus.com` (`404` on tenant, marketing, and console hosts).
Requires authenticated session, verified tenant membership, permission `theme:custom_request` (`owner`, `admin`, `agency_admin`; `editor` -> `403`, non-member/cross-tenant -> `404`), and non-locked lifecycle status (`trial`, `active`, `grace`; `locked`/`suspended`/`recovery` -> `403 SUBSCRIPTION_LOCKED`; `purging`/`purged` -> `404`).

### `GET /api/tenants/:tenantId/custom-theme-packages`
Returns active superadmin-managed `custom_theme` packages sorted by `sort_order ASC`, default + granted custom theme summaries, daily quota (`used`, `limit: 3`, `remaining`, `dayBucket`), and configured sales WhatsApp CTA (`null` if not configured in `platform_settings`).

### `GET /api/tenants/:tenantId/custom-theme-requests`
Lists this tenant's custom theme requests (read-only) ordered newest first, with each item carrying its single-encoded `whatsappUrl` (`handle`, `requestCode`, `packageName` encoded strictly once).

### `POST /api/tenants/:tenantId/custom-theme-requests`
Requires `Content-Type: application/json`, exact `Origin` matching `app.punyasitus.com`, and `Idempotency-Key` header (or `idempotencyKey` body field, 8–128 chars).

Request body (strict allowlist; unknown/forbidden keys -> `422`):
```json
{
  "packageId": "01J... or null",
  "brandName": "PT Nusantara Mandiri",
  "brief": "Need bespoke corporate theme with dark slate palette and portfolio gallery.",
  "referenceUrls": ["https://example.com/design-1"],
  "budgetRange": "Rp 5.000.000 - Rp 8.000.000",
  "contactPreference": "whatsapp",
  "idempotencyKey": "ctr-20261123-001"
}
```

Validation & atomicity invariants:
- `brandName`: 1–100 chars.
- `brief`: 1–2000 chars.
- `referenceUrls`: max **5** URLs, strictly public **HTTPS** (rejects `http:`, `javascript:`, `data:`, embedded credentials, loopback/private/link-local hosts); submitted URLs are **NEVER fetched** server-side.
- Idempotent retry on `(tenant_id, service_kind, idempotency_key)` with matching payload SHA-256 hash returns `200` (`created: false`, `idempotentReplay: true`) without creating a duplicate or failing even when the daily limit is reached. Reusing an existing `idempotency_key` with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.
- Atomic SQLite cap of **3 requests per day per tenant** (`429 DAILY_REQUEST_LIMIT_REACHED`).
- New requests enqueue non-blocking operator notification emails via `custom-theme-request-operator-notice`.

### `GET /api/tenants/:tenantId/custom-theme-requests/:requestId`
Returns tenant-scoped detail for a single request (`404` if missing or owned by another tenant).

---

## 2. Superadmin Console Endpoints (`console.punyasitus.com`)

Served strictly on `console.punyasitus.com` (bare neutral `404` on non-console hosts).
Requires active `platform_operators` grant + verified 2FA; all mutations (`POST`/`PATCH`) require recent 2FA step-up (`<= 10m`, else `403 REAUTH_REQUIRED`), exact console `Origin`, `Content-Type: application/json`, mandatory `reason` (10–500 chars), optimistic `expectedVersion` on `PATCH`, and commit `platform_audit` atomically inside a single `D1Database.batch([...])` guarded by `WHERE changes() = 1`.

### `GET /api/console/custom-themes/packages`
Lists all service packages (active and inactive) sorted by `sort_order ASC`. Optional query params: `activeOnly=true`, `serviceKind=custom_theme|setup|custom_plugin`, `limit`.

### `POST /api/console/custom-themes/packages`
Creates a package (`201 Created`). `startingPriceIdr` is either a positive integer IDR or `null` (quote-only: *"Harga berdasarkan penawaran"*). Duplicate `slug` returns `409 PACKAGE_SLUG_EXISTS`.

### `GET /api/console/custom-themes/packages/:packageId`
Reads a single package (`404` if not found).

### `PATCH /api/console/custom-themes/packages/:packageId`
Updates `name`, `description`, `inclusions`, `startingPriceIdr`, `estimatedDuration`, `sortOrder`, or `active` (deactivate instead of deleting referenced packages). Version mismatch returns `409 STALE_VERSION`.

### `GET /api/console/custom-themes/requests`
Lists requests across tenants from `PLATFORM_DB` metadata only (never opens `TenantStore`). Optional filters: `status`, `tenant`, `serviceKind`, `limit`. Enriches each row with the tenant's active custom theme grants from `tenant_theme_entitlements`.

### `GET /api/console/custom-themes/requests/:requestId`
Reads a single request with the tenant's active custom theme grants.

### `PATCH /api/console/custom-themes/requests/:requestId`
Transitions status along `new -> contacted -> quoted -> in_progress -> delivered` (or `declined` / `cancelled`).
- Requires `expectedVersion` (`409 STALE_VERSION`) and `reason` (10–500 chars).
- Invalid or terminal transition returns `409 INVALID_STATUS_TRANSITION`.
- Transitioning to `delivered` **requires** `deliveredThemeId` matching an active custom `theme_catalog` + `tenant_theme_entitlements` grant for that exact tenant (`409 THEME_GRANT_REQUIRED` otherwise, verified atomically in SQL). Once delivered, the linked custom theme is activatable by the tenant via `POST /api/tenants/:tenantId/themes/activate`.
