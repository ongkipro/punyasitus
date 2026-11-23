# Frozen-Core Modular Plugin Runtime API Contract (`TASK-097`, `REQ-097`, `ADR-0010`)

> Note: Core platform OpenAPI (`docs/api/openapi.json`) is generated deterministically from `packages/core/src/schemas/*.ts` and guarded by `tests/task-024/unit.test.ts`. This companion specification documents the Frozen-Core Plugin Runtime HTTP endpoints introduced in `TASK-097`.

## Common Invariants

- **Surface Isolation:** All tenant plugin admin APIs and inbound plugin webhooks run exclusively on `app.punyasitus.com` (or local loopback in `APP_ENV=local`). Tenant, marketing, and console hosts receive a neutral `404` with `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
- **RBAC & CSRF:** State-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`) require valid Origin/CSRF headers and `settings:write` permission (`owner`, `admin`, `agency_admin`). `editor` receives `403 FORBIDDEN`. Cross-tenant selectors receive neutral `404 NOT_FOUND`.
- **Lifecycle Enforcement:**
  - `locked`: `GET` succeeds (read-only); all mutations return `403 SUBSCRIPTION_LOCKED`.
  - `suspended`, `recovery`, `purging`, `operatorHold`: all plugin APIs return `403 SUBSCRIPTION_LOCKED` (SSR pages redirect `302` to `/dashboard/{handle}/service-status`, `purging`/`purged` return `404`), with **zero `TenantStore` reads** while preserving all `plg_*` rows.
- **`builtin:*` Exclusion:** Internal feature rows in `installed_plugins` using the `builtin:` prefix (e.g. `builtin:lead-email-notifications`, `TASK-021`) are strictly filtered from listings and rejected with `404` on install/enable/disable/config calls.
- **Namespace Isolation:** Plugin SQL migrations and runtime queries are validated against `plg_<snake_id>__*` exclusively; non-`plg_*` DDL/DML, comments/multi-statement smuggling, triggers, views, `PRAGMA`, `ATTACH`, and `DROP` are rejected.

## Tenant Admin Plugin Endpoints

### `GET /api/tenants/{tenantId}/plugins`
Lists registered plugins visible to the tenant (`public_free`, `public_paid`, plus any entitled `private_client`), their entitlement status from `PLATFORM_DB.tenant_plugin_entitlements`, and their installation/enabled state from `TenantStore.installed_plugins` (excluding `builtin:*`).

- **Auth:** `app_session`, `content:read`
- **200 Response:** `{ items: TenantPluginCatalogItem[], permissions: { role, canManagePlugins, isLocked }, requestId }`

### `POST /api/tenants/{tenantId}/plugins`
Installs or re-enables a plugin (`public_free` auto-grants entitlement; `public_paid`/`private_client` require active entitlement in `PLATFORM_DB`). Runs additive `plg_<id>__*` migrations in `TenantStore` after recording a PITR bookmark in `PLATFORM_DB.migration_bookmarks`.

- **Auth:** `app_session`, `settings:write`, CSRF/Origin
- **Body:** `{ pluginId: string, config?: Record<string, unknown> }`
- **200 Response:** `{ plugin: TenantPluginCatalogItem, migration: { outcome, bookmarkId, schemaVersion, applied } | null, requestId }`
- **Errors:** `403 FORBIDDEN` (editor or unentitled paid plugin), `403 SUBSCRIPTION_LOCKED` (`locked`/`suspended`), `404 NOT_FOUND` (unknown, `builtin:*`, or ungranted `private_client`), `422 VALIDATION_ERROR`

### `GET /api/tenants/{tenantId}/plugins/{pluginId}`
Loads single plugin metadata, entitlement, installation state, and optional plugin-supplied `adminSlots.loadState` payload.

- **Auth:** `app_session`, `content:read`
- **200 Response:** `{ plugin: TenantPluginCatalogItem, adminState: Record<string, unknown> | null, requestId }`

### `PATCH /api/tenants/{tenantId}/plugins/{pluginId}`
Updates `enabled` (`true`/`false`) and/or `config` for an installed plugin. Disabling sets `enabled = 0` without deleting config or dropping `plg_*` tables.

- **Auth:** `app_session`, `settings:write`, CSRF/Origin
- **Body:** `{ enabled?: boolean, config?: Record<string, unknown> }`
- **200 Response:** `{ plugin: TenantPluginCatalogItem, requestId }`

### `ALL /api/tenants/{tenantId}/plugins/{pluginId}/{...subpath}`
Slot 3 scoped JSON API forwarded to `plugin.adminSlots.apiHandler` with a namespace-locked `PluginTenantDb` (`plg_<id>__*`). Unentitled or disabled plugins return `403`/`404` with zero `plg_*` SQL queries.

## Platform Inbound Plugin Webhook Endpoint

### `POST /api/plugins/{pluginId}/webhook`
Slot 4 secret-verified platform callback (e.g., Telegram Bot API `X-Telegram-Bot-Api-Secret-Token`).

- **Surface:** `app.punyasitus.com` only (`404` on tenant/marketing/console hosts)
- **Auth:** Plugin-defined constant-time secret verification (`401 UNAUTHENTICATED` on mismatch)
- **Tenant Entitlement:** Resolved target tenant must be active and entitled for `{pluginId}` (`403`/`404` otherwise, zero `TenantStore` reads)
