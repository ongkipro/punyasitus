# Plugin Store, Bespoke Client Grants (`private_client`) & AutoLaris Add-on Billing API (`TASK-098`, `REQ-098`)

> Canonical contract: `PRD.md` (`REQ-098`), `ADR-0010`, `PLAN.md §19.7`, `DESIGN.md §7`.
> Additive migration: `packages/db/migrations/platform/0033_plugin_store_billing.sql` (zero runtime DDL).

## Commercial, Visibility & Data-Preservation Invariants

1. **Three Symmetric Commercial Tiers:**
   - `public_free` (`free`, Rp 0): 1-click install, enable, and disable.
   - `public_paid` (`paid_once`, `paid_monthly` +30d, `paid_yearly` +365d): AutoLaris QRIS / Bank VA checkout with single promo coupon and agency volume discount support, immutable gap-free numbered PDF receipts (`INV-PLG-YYYY-NNNNNN`), and affiliate commission attribution via `TASK-085` `recordConfirmedPaymentCommission` (when tenant is eligible; 0 for agency-managed sites).
   - `private_client` (Bespoke Client / Agency Grants + `service_kind = "custom_plugin"` Dev Requests): **100% invisible** (omitted from store list; `404 NOT_FOUND` on direct fetch/install) to any tenant lacking an active direct `tenant_id` grant or active grant on its active owning `agency_id`. Promoting `private_client -> public_free | public_paid` is an audited console metadata update requiring zero code rewrite.
2. **Agency Billing Boundary:**
   - Agency-managed client tenants NEVER see or initiate paid plugin checkout (`403 AGENCY_PAYER_ONLY`).
   - Owning agencies purchase add-ons on `/api/agency/plugins/**` using `authorizeAgencyRequest` + `resolveAuthorizedTargetMembership` (`agency:billing:write`, mandatory 2FA, CSRF).
3. **`plg_*` Data Preservation:**
   - Disabling a plugin or expiring a lapsed `paid_monthly`/`paid_yearly` add-on sets `enabled = 0` / `status = 'expired'` and **NEVER deletes `plg_*` tenant data rows** (preserved until `H+45` purge).
4. **Custom Dev Fulfillment Guard:**
   - Fulfilling a `service_kind = "custom_plugin"` request (`status = "fulfilled"`) is strictly blocked (`422 GRANT_REQUIRED`) unless linked to an existing active `private_client` grant matching the requesting tenant or its active owning agency.

## Tenant Endpoints (`app.punyasitus.com`)

| Method & Path | Permission / Guard | Description |
|---|---|---|
| `GET /api/tenants/:tenantId/plugins/store` | `content:read`, app host, session, lifecycle | Returns 4-tab store snapshot (`Terpasang`, `Gratis`, `Berbayar`, `Khusus Klien`), omitting ungranted `private_client` plugins and hiding billing orders/receipts for agency-managed clients. |
| `GET /api/tenants/:tenantId/plugins/store/:pluginSlug` | `content:read` | Returns store item detail, or `404 NOT_FOUND` for ungranted `private_client` plugins. |
| `POST /api/tenants/:tenantId/plugins/store/:pluginSlug` | `settings:write`, CSRF, non-locked | Installs/enables `public_free`, actively granted `private_client`, or actively entitled `public_paid` plugin. |
| `PATCH /api/tenants/:tenantId/plugins/store/:pluginSlug` | `settings:write`, CSRF, non-locked | Toggles `{ enabled: boolean }` without deleting `plg_*` tables/rows. |
| `POST /api/tenants/:tenantId/plugins/checkout` | `settings:write`, CSRF, non-locked | Creates idempotent AutoLaris QRIS/VA add-on order (`422` on client price fields, `403 AGENCY_PAYER_ONLY` for agency clients). |
| `POST /api/tenants/:tenantId/plugins/orders/:orderId/settle` | `settings:write`, CSRF, server Advice port | Atomically & idempotently settles order, activates/extends entitlement, issues numbered PDF receipt (`INV-PLG-YYYY-NNNNNN`), and credits affiliate commission (TASK-085). |
| `GET /api/tenants/:tenantId/plugins/receipts/:receiptId/pdf` | `content:read`, non-agency | Downloads immutable PDF receipt (`application/pdf`, `Cache-Control: private, no-store`). |
| `GET / POST /api/tenants/:tenantId/plugins/custom-dev` | `content:read` / `settings:write`, CSRF | Lists/submits rate-limited (3/day/tenant) `service_kind = "custom_plugin"` bespoke requests with validated WhatsApp contact. |

## Agency Portal Endpoints (`app.punyasitus.com`)

| Method & Path | Guard | Description |
|---|---|---|
| `GET /api/agency/plugins` | 2FA + `agency:billing:read` + `resolveAuthorizedTargetMembership` | Lists paid plugins, agency discount tier, agency `private_client` grants, client entitlements, orders, and receipts. |
| `POST /api/agency/plugins/checkout` | 2FA + CSRF + `agency:billing:write` + `resolveAuthorizedTargetMembership` | Creates agency-billed (`payer_kind = 'agency'`) add-on order for a linked client (`404` on cross-agency client, `403` on unauthorized agency role). |
| `POST /api/agency/plugins/orders/:orderId/settle` | 2FA + CSRF + `agency:billing:write` | Settles agency add-on order via AutoLaris Advice, activates client entitlement, issues agency PDF receipt (0 affiliate commission). |
| `GET /api/agency/plugins/receipts/:receiptId/pdf` | 2FA + `agency:billing:read` | Streams agency-scoped immutable PDF receipt (`404` on foreign agency). |

## Console Operator Endpoints (`console.punyasitus.com`)

| Method & Path | Guard | Description |
|---|---|---|
| `GET / POST / PATCH /api/console/plugins/catalog` | Console host, operator RBAC, 2FA step-up + CSRF + OCC + reason on writes | Lists/creates/updates catalog items and promotes `private_client <-> public_free | public_paid` with atomic `platform_audit`. |
| `GET / POST / PATCH / DELETE /api/console/plugins/grants` | Console host, operator RBAC, 2FA step-up + CSRF + reason on writes | Lists, issues, or revokes `private_client` grants for a tenant or agency with atomic `platform_audit`. |
| `GET / PATCH /api/console/plugins/requests` | Console host, operator RBAC, 2FA step-up + CSRF + OCC + reason on writes | Lists and transitions `custom_plugin` dev requests; strictly enforces `422 GRANT_REQUIRED` on `fulfilled` unless linked to an active `private_client` grant for that tenant/agency. |
