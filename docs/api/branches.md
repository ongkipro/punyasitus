# Multi-Branch Locations (`branches`) & Unified Schema.org `@graph` API (`REQ-088`, `TASK-088`)

> Additive contract documentation complementing `docs/api/openapi.json` (do not edit `openapi.json` directly outside TASK-024).

## Endpoints (Host: `app.punyasitus.com` only)

All endpoints require an authenticated Better Auth session on `app.punyasitus.com`, live `PLATFORM_DB` membership verification for `{tenantId}` (immutable tenant handle or ULID), CSRF + same-origin verification on state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`), and emit `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

| Method & Path | Permission | Editor Role | Locked Tenant | Purpose |
|---|---|---|---|---|
| `GET /api/tenants/{tenantId}/branches` | `content:read` | `200` (read-only) | `200` (read-only) | List all tenant branches in canonical order (`isPrimary DESC, sortOrder ASC, id ASC`), total count, remaining slots (`10 - total`), and `primaryBranchId`. |
| `POST /api/tenants/{tenantId}/branches` | `outlet:manage` | `403 FORBIDDEN` | `403 SUBSCRIPTION_LOCKED` | Atomically create a branch (max `10` per website; 11th returns `422 VALIDATION_ERROR` with `BRANCH_LIMIT_REACHED`), enforce single-primary invariant, bump `tenants.cache_version` (post-commit best-effort with `cacheVersionSynced: boolean`), and record audit entry. |
| `GET /api/tenants/{tenantId}/branches/{branchId}` | `content:read` | `200` (read-only) | `200` (read-only) | Fetch a single branch by per-tenant sequential positive integer ID (`404` if missing or cross-tenant). |
| `PATCH /api/tenants/{tenantId}/branches/{branchId}` | `outlet:manage` | `403 FORBIDDEN` | `403 SUBSCRIPTION_LOCKED` | Atomically update branch fields with **required** optimistic concurrency control (`expectedVersion` / `version` — missing -> `422 EXPECTED_VERSION_REQUIRED`, mismatch -> `409 STALE_VERSION`), single-primary enforcement, post-commit `cache_version` sync (`cacheVersionSynced: boolean`), and `WHERE changes() = 1` audit log. |
| `PUT /api/tenants/{tenantId}/branches/{branchId}` | `outlet:manage` | `403 FORBIDDEN` | `403 SUBSCRIPTION_LOCKED` | Replace/update branch fields with identical required OCC, single-primary, post-commit cache sync, and audit guarantees. |
| `DELETE /api/tenants/{tenantId}/branches/{branchId}` | `outlet:manage` | `403 FORBIDDEN` | `403 SUBSCRIPTION_LOCKED` | Atomically unlink any `leads.branch_id` FK references, delete the branch (optional `expectedVersion` via query or JSON body), run post-commit `cache_version` sync (`cacheVersionSynced: boolean`), and write audit log. |
| `POST /api/tenants/{tenantId}/branches/reorder` | `outlet:manage` | `403 FORBIDDEN` | `403 SUBSCRIPTION_LOCKED` | Atomically reorder all existing branches (`{ branchIds: number[] }`, exact complete permutation of current branch IDs), update `sort_order = 0..N-1`, bump versions, run post-commit `cache_version` sync (`cacheVersionSynced: boolean`), and record audit entry. |

## Validation & Security Invariants

- **Strict Zod v4 `.strict()` schemas**: Unknown fields are rejected with `422 UNKNOWN_FIELD`; forbidden tenant-selector keys (`tenantId`, `organizationId`, `tenantHandle`, etc.) anywhere in the JSON body are rejected with `422 FORBIDDEN_TENANT_SELECTOR`.
- **10-Branch Hard Cap (`MAX_BRANCHES_PER_TENANT = 10`)**: Enforced atomically in SQL (`WHERE (SELECT COUNT(*) FROM branches) < 10`) so concurrent creates cannot exceed 10 branches.
- **Single-Primary-Branch Invariant**: Enforced both by SQLite partial unique index `branches_single_primary_idx ON branches(is_primary) WHERE is_primary = 1` (`0017_branches.sql`) and atomic `tenantDb.batch()` transactions.
- **URL Sanitization (`link-sanitizer.ts`)**: `mapsUrl` must be a public `https://` URL without `javascript:`, `data:`, `http://`, embedded credentials, `localhost`, or private/link-local IP ranges.
- **WhatsApp Normalization (`wa-dispatcher.ts`)**: `whatsappE164` / `whatsappNumber` accepts Indonesian mobile formats (`08...`, `+628...`, `628...`) and normalizes to E.164 digits (`628...`).
- **Coordinate Pair Integrity**: `latitude` (`[-90, 90]`) and `longitude` (`[-180, 180]`) must both be supplied together or both omitted (`null`).
- **Timezone Validation**: Valid IANA timezone (`Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`, etc.; default `Asia/Jakarta`).

## Public Rendering (`SectionBranches.astro`) & Unified Schema.org `@graph`

- **Zero JS & Consent-Safe Maps (`REQ-088`, `TASK-031`)**: `SectionBranches.astro` emits zero `<script>` tags and zero third-party map `<iframe>` elements. Call (`tel:`), Branch WhatsApp (`https://wa.me/<digits>?text=...`), and Static Map links (`https://...`, `target="_blank" rel="noopener noreferrer"`, labelled `"Buka Google Maps"` only for Google Maps hosts and `"Buka Lokasi di Peta"` for other valid HTTPS map hosts) work without JavaScript. The site's floating WhatsApp button remains bound to the main business profile number.
- **Exact Visible-Fact `@graph` Parity**: `mapBranchesToSchemaInput()` feeds active branches (max 10) into `generateSchemaGraph()` / `generatePublishedResourceSchema()`. The parent node (`Organization` / `LocalBusiness` subtype) links branches via `subOrganization`, and each branch node emits the same valid Schema.org subtype (falling back to `LocalBusiness` when parent is `Organization`; never deprecated `ProfessionalService`) with `parentOrganization: { "@id": "<origin>/#organization" }`, exact visible `name`, `address`, `telephone` (emitted strictly from visible `phone`, never from WhatsApp-only numbers), `openingHours`, `geo`, and `hasMap` — and ZERO fabricated `aggregateRating`, `review`, coordinates, or hours.
- **Storefront Route & Theme Registry Integration Handoff**: Mounting `SectionBranches.astro` inside `SectionRenderer.astro` / `section-registry.ts` and loading `listActiveBranchesForPublic()` inside public storefront catch-all/home routes (`apps/web/src/pages/[...slug].astro`, `apps/web/src/core/section-registry.ts`, `apps/web/src/themes/default/sections/SectionRenderer.astro`) are intentionally handed off to **`TASK-053`** (Local Entity Schema & Crawlable Content Integration) and **`TASK-063`** (Public Site Assembly) as those files lie outside `TASK-088`'s declared path boundary.

## SSR Lifecycle & RBAC Gate (`/dashboard/{handle}/settings/branches`)

Executed strictly **before** any `TenantStore` DB read:
- Invalid handle / non-`app` surface / unauthenticated / foreign handle -> neutral `404`
- `provisioning` / `purging` / `purged` -> neutral `404`
- `suspended` / `recovery` / `operatorHold` -> `302 /dashboard/{handle}/service-status`
- `editor` -> `200` read-only (`canManageBranches: false`, all write controls disabled/hidden per `REQ-088`)
- `locked` -> `200` read-only (`isLocked: true`, `canManageBranches: false`, API mutations return `403 SUBSCRIPTION_LOCKED`)
- `owner` / `admin` / `agency_admin` on active/trial/grace tenant -> `200` full CRUD (`canManageBranches: true`)
- All responses emit `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
