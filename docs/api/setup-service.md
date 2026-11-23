# Terima Beres Setup Service Packages & Requests API (`TASK-069`, `REQ-070`)

> Canonical contract owners: `PRD.md` REQ-070; `PLAN.md` §11.4, §13, §18.2; `DECISIONS.md` DEC-026; `DESIGN.md` Appearance / Settings.
> Shares the canonical `custom_theme_packages` and `custom_theme_requests` data model differentiated by `service_kind = 'setup'` (additive migration `0026_setup_service_staff_delivery.sql`).
> All endpoints set `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`, perform ZERO request-time DDL, collect NO payment/checkout in the system, and NEVER use account impersonation.

## 1. Tenant App Endpoints (`app.punyasitus.com`)

Served strictly on `app.punyasitus.com` (`404` on tenant, marketing, and console hosts).
Requires authenticated session, verified tenant membership, and non-locked lifecycle status (`trial`, `active`, `grace`; `locked`/`suspended`/`recovery` -> `403 SUBSCRIPTION_LOCKED`; `purging`/`purged` -> `404`).

### `GET /api/tenants/:tenantId/service-requests`
- Permission: `theme:custom_request` (`owner`, `admin`, `agency_admin`; `editor` & `setup_staff` -> `403`; non-member/cross-tenant -> `404`).
- Returns active superadmin-managed `setup` packages sorted by `sort_order ASC`, tenant-scoped `setup` requests (including `staffAccess` state and single-encoded `whatsappUrl`), live member seat usage (`seatsUsed`, `seatsLimit: 5`, `seatsRemaining`), `canApproveStaff`, daily quota (`used`, `limit: 3`, `remaining`, `dayBucket`), and configured sales WhatsApp CTA.

### `POST /api/tenants/:tenantId/service-requests`
- Permission: `theme:custom_request` (`owner`, `admin`, `agency_admin`).
- Requires `Content-Type: application/json`, exact `Origin` matching `app.punyasitus.com`, and `Idempotency-Key` header (or `idempotencyKey` body field, 8–128 chars).
- Validated strictly with Zod v4 `.strict()` (`SetupServiceRequestCreateSchema`); unknown or forbidden keys (`tenantId`, `status`, `startingPriceIdr`, `staffUserId`, etc.) return `422`.
- Body:
```json
{
  "packageId": "01J... or null",
  "brandName": "Klinik Gigi Senyum Sehat",
  "brief": "Mohon bantu isi halaman beranda, daftar layanan perawatan, dan informasi cabang.",
  "referenceUrls": ["https://example.com/referensi-klinik"],
  "budgetRange": "Rp 1.500.000 - Rp 2.500.000",
  "contactPreference": "whatsapp",
  "idempotencyKey": "tbr-20261123-001"
}
```
- Invariants:
  - Generates request code prefixed `TBR-YYYYMMDD-XXXXXX`.
  - Reference URLs: max 5, strictly public HTTPS, NEVER fetched server-side.
  - Idempotent replay per `(tenant_id, service_kind='setup', idempotency_key)` with SHA-256 payload hash guard (`200` on matching payload even at daily cap; `409 IDEMPOTENCY_KEY_REUSED` on mismatched payload).
  - Atomic SQLite cap of **3 setup requests per day per tenant** (`429 DAILY_REQUEST_LIMIT_REACHED`), independent of `custom_theme` quota.
  - Non-blocking operator notification email enqueued via `dispatchCustomThemeRequestOperatorNotices`.

### `GET /api/tenants/:tenantId/service-requests/:requestId`
- Permission: `theme:custom_request`.
- Tenant-scoped read-only detail for a single `setup` request (`404` on missing, non-setup, or cross-tenant ID).

### `POST /api/tenants/:tenantId/service-requests/:requestId/staff-access`
- Permission: **strictly `owner` only** (`role === "owner"` & `dbRole === "owner"`; `agency_admin`, `admin`, `editor`, and `setup_staff` receive `403 FORBIDDEN`; cross-tenant receives `404 NOT_FOUND`).
- Validated strictly with Zod v4 `.strict()` (`SetupStaffAccessActionSchema`):
```json
{
  "action": "approve",
  "expectedVersion": 2,
  "reason": "Menyetujui akses sementara Tim Setup sebagai Editor"
}
```
- Behavior (`action: "approve"`):
  - Denied on `locked`/`suspended`/`recovery` tenants (`403 SUBSCRIPTION_LOCKED`).
  - Requires `status === "in_progress"` (`409 INVALID_STATUS_TRANSITION` otherwise), `expectedVersion` (`409 STALE_VERSION`), and an operator-nominated active platform operator account (`staffAccess.state` in `awaiting_owner_approval` | `waiting_seat`; idempotent `200` if already `active`).
  - Atomically enforces the canonical **5-member seat cap** (`active members + unexpired pending invitations < 5`) inside SQLite `INSERT INTO members (... role = 'setup_staff') SELECT ... WHERE ...`.
  - When a seat is free: inserts `members` with `role = 'setup_staff'` (mapped to canonical `editor` RBAC role — zero impersonation, zero billing/member/settings access; role cannot be promoted/demoted via member role update), sets `staff_access_state = 'active'`, increments `version`, and commits `platform_audit` (`setup_service.staff_access.approved_and_joined`) atomically inside a single `D1Database.batch([...])`.
  - When all 5 seats are full (verified against live member existence & seat count, never misclassifying an already-member conflict): NEVER bypasses the cap. Atomically transitions `staff_access_state = 'waiting_seat'` (guarded on `status = 'in_progress'`), records `staff_wait_reason`, increments `version`, commits `platform_audit` (`setup_service.staff_access.waiting_seat`), and returns `200` with `{ joined: false, waitingForSeat: true, waitReason, seats }`.
- Behavior (`action: "revoke"`):
  - Permitted for strict `owner` even when tenant status is `locked` or `suspended` so temporary staff access can always be revoked cleanly.
  - Idempotently deletes ONLY the exact `staff_member_id` row with `role = 'setup_staff'` (never deleting by `user_id` and performing zero writes on already-`revoked`/`none` replay), sets `staff_access_state = 'revoked'`, increments `version`, and writes `platform_audit` (`setup_service.staff_access.revoked`). Removing a `setup_staff` member via Team Management (`removeTenantMember`) also atomically reconciles the matching `custom_theme_requests` row to `staff_access_state = 'revoked'`.

---

## 2. Superadmin Console Endpoints (`console.punyasitus.com`)

Reuses `/api/console/custom-themes/packages/**` and `/api/console/custom-themes/requests/**` (bare neutral `404` on non-console hosts, mandatory active operator grant + 2FA + 10-minute step-up 2FA on mutations, mandatory 10–500 char `reason`, OCC `expectedVersion`, atomic `platform_audit` with `WHERE changes() = 1`).

### Package Management (`serviceKind: "setup"`)
- `POST /api/console/custom-themes/packages` accepts `serviceKind: "setup"` (default `"custom_theme"`).
- `GET /api/console/custom-themes/packages?serviceKind=setup` filters setup packages.
- `PATCH /api/console/custom-themes/packages/:packageId` updates/reorders/deactivates setup packages without deleting referenced rows.

### Request Queue & Staff Delivery Lifecycle (`serviceKind: "setup"`)
- `GET /api/console/custom-themes/requests?serviceKind=setup` lists setup requests enriched with `staffAccess` and `tenantSeats` (strictly from `PLATFORM_DB` metadata; never opens `TenantStore`).
- `PATCH /api/console/custom-themes/requests/:requestId`:
  - Accepts optional `staffUserEmail` (or `staffUserId`) strictly when resulting `status === "in_progress"` (`409 INVALID_STATUS_TRANSITION` on other statuses) to nominate an **active `platform_operators` account** (`422 STAFF_USER_NOT_FOUND` / `422 STAFF_NOT_ACTIVE_OPERATOR` if missing or non-operator; `409 STAFF_ALREADY_MEMBER` if already an active member of that tenant; `409 STAFF_ALREADY_ASSIGNED` if already nominated on another open setup request for that tenant). Sets `staff_access_state = 'awaiting_owner_approval'` without auto-joining.
  - Marking `delivered` on a `setup` request succeeds **without any theme grant** (rejects `deliveredThemeId` with `422`).
  - Transitioning to **any terminal state** (`delivered`, `declined`, `cancelled`) atomically and idempotently deletes ONLY the exact `staff_member_id` row with `role = 'setup_staff'` from `members`, transitions `staff_access_state` to `'revoked'`, and commits `platform_audit` inside the same `db.batch([...])`.
  - Custom-theme requests (`serviceKind: "custom_theme"`) remain 100% unchanged and continue requiring an active custom `theme_catalog` + `tenant_theme_entitlements` grant on `delivered`.
