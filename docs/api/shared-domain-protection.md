# Shared-Domain Protection API — Publish Screening, Trust+ Watch & Takedown (`TASK-103`, `REQ-103`)

This document specifies the Console HTTP endpoints, publish screening gate contracts, Trust+ Komdigi watch status contract, and security invariants introduced by **TASK-103** (`PRD.md` `REQ-103`, `PLAN.md` §20.1, `DEC-043`).

---

## 1. Console Security Invariants

All endpoints under `/api/console/abuse/**` enforce:
- **Host Isolation:** Non-console hosts (`app.`, marketing, tenant hosts, unknown hosts) ALWAYS receive a bare neutral `404 Not Found` (`text/plain`).
- **Authentication & Authorization:** Live Better Auth session + active `platform_operators` grant + verified TOTP 2FA (`403 TOTP_REQUIRED` if not enrolled).
- **Step-Up 2FA & CSRF:** All state-changing mutations (`POST`) enforce same-origin `Origin`, recent 10-minute 2FA step-up (`requireStepUp: true` -> `403 REAUTH_REQUIRED`), mandatory operator audit reason (`10–500` chars), optimistic concurrency (`expectedVersion`), and atomic `PLATFORM_DB.batch()` with `platform_audit` (`WHERE changes() = 1`).
- **Headers:** `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`.

---

## 2. Publish Screening Review Queue

### `GET /api/console/abuse/screening`
Returns paginated held/reviewed publish items from `PLATFORM_DB.content_screening_reviews` alongside per-status counts.
- **Query parameters:**
  - `status`: `all | held_for_review | released | rejected | takedown` (default `all`)
  - `publishSource`: `all | dashboard | mcp | api` (default `all`)
  - `search`: matches tenant handle, tenant name, or resource title
  - `cursor`: `<createdAtMs>:<reviewId>`
  - `limit`: `1..100` (default `20`)
- **Privacy invariant:** Operator-only findings (`findings[]`) contain PII/secret-scrubbed excerpts (`redactedExcerpt`) and are NEVER returned to tenant owners. Tenant owners see only `{ held: true, status: "draft", reason: "held_for_review", reviewId, message: "Konten ditahan untuk ditinjau" }`.

### `GET /api/console/abuse/screening/{reviewId}`
Returns full operator detail for a single held review item (`404 NOT_FOUND` if absent).

### `POST /api/console/abuse/screening/{reviewId}/decision`
Executes an audited operator decision on a `held_for_review` item.
- **Headers:** `Content-Type: application/json`, same-origin `Origin`, optional `Idempotency-Key`.
- **Body:**
  ```json
  {
    "decision": "release | reject | takedown",
    "reason": "Alasan audit tinjauan konten minimal 10 karakter (maks 500).",
    "expectedVersion": 1
  }
  ```
- **Behavior:**
  - `release`: requires live `TenantStore` (`503 TENANT_STORE_UNAVAILABLE` if unavailable), verifies the draft `content_sha256` still matches the held snapshot (`409 SNAPSHOT_MISMATCH` if edited after hold), publishes the resource atomically in `TenantStore`, then commits `content_screening_reviews` (`status = 'released'`) + `platform_audit` (`WHERE changes() = 1`) in `PLATFORM_DB.batch()`. Compensates/unpublishes `TenantStore` if `PLATFORM_DB` fails.
  - `reject`: leaves resource as `draft` and records `status = 'rejected'` + `platform_audit`.
  - `takedown`: executes atomic **"Turunkan situs"** (`tenants.status = 'suspended'`, `operator_hold = 1`, `cache_version + 1`, `platform_audit`, `tenant_takedown_actions`, `evictTenantFromCache`, and owner notice).

---

## 3. One-Click Tenant Takedown ("Turunkan situs")

### `POST /api/console/abuse/takedown`
Directly suspends an eligible tenant site in one audited operator action using the existing `suspended` state (`REQ-005`).
- **Headers:** `Content-Type: application/json`, same-origin `Origin`, optional `Idempotency-Key`.
- **Body:**
  ```json
  {
    "tenantId": "01J...",
    "expectedTenantVersion": 1,
    "reason": "Situs terbukti memuat promosi judi online melanggar kebijakan Trust+ Komdigi.",
    "reviewId": "01J..."
  }
  ```
- **Atomicity & Guards:**
  - Enforces lifecycle and offboarding guards (`status NOT IN ('provisioning','purging','purged','recovery')`, `offboarding_started_at IS NULL`, `version = expectedTenantVersion`).
  - Atomically updates `tenants`, writes immutable `platform_audit` (`console.tenant.takedown`, `WHERE changes() = 1`), inserts append-only `tenant_takedown_actions` (`WHERE changes() = 1`), and queues owner notice in `job_ledger`.
  - Evicts tenant host routing cache (`evictTenantFromCache`) so the very next public request returns HTTP `503` suspended (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`).

---

## 4. Operator-Managed Screening Rules (Keyword & Domain Denylist)

### `GET /api/console/abuse/rules`
Returns operator-managed rules in `PLATFORM_DB.content_screening_rules`, built-in rule count, effective active count, and current `rulesetVersion`.

### `POST /api/console/abuse/rules`
Creates or updates a versioned screening rule atomically with `platform_audit` (requires 10-min 2FA step-up + audit reason).
- **Body:**
  ```json
  {
    "ruleType": "keyword | domain",
    "pattern": "slot gacor",
    "category": "gambling | phishing | malware | scam | illegal_content",
    "severity": "hold | high",
    "active": true,
    "notes": "Ditambahkan dari laporan insiden",
    "reason": "Penambahan kata kunci judi online baru hasil tinjauan operator."
  }
  ```

---

## 5. Daily Trust+ Komdigi Watch Status

### `GET /api/console/abuse/trust-watch`
Returns the latest daily Trust+ watch run (`status: "clean" | "hit" | "unknown"`), recent run history (`limit` 1..50, default 14), and standby fallback zone readiness metadata (`situsku.my.id`, `activationMode: "manual_operator_runbook"`, `automaticFailover: false`).
- **Fail-Closed Rule:** Whenever the Trust+ IP list (`https://trustpositif.komdigi.go.id/assets/db/ipaddress_isp`) cannot be fetched/parsed, the active host count exceeds the 2,000-host scan cap, or any target host fails DNS-over-HTTPS A-record resolution without a hit, status is strictly `"unknown"` (never `"clean"`).
- **Once-Per-Day Alert Cap:** Hits are logged on every run in `trust_watch_runs`, while operator alerts are atomically deduplicated to at most once per WIB day via `trust_watch_alert_days(run_day PRIMARY KEY)`. If alert delivery fails or no transport is available, the daily claim slot is released immediately so the next run retries.

---

## 6. Publish Route Wiring Handoff (`TASK-063` M1 Integration Gate)

`TASK-103` owns the screening engine (`@punyasitus/core/content-screening`), D1/TenantStore gate (`publishResourceWithScreening`, `publishFormWithScreening`), console review/takedown APIs, and Trust+ watch cron. Dashboard and MCP publish route files live outside `TASK-103`'s Allowed Paths and are wired centrally in **`TASK-063` (M1 Integration Gate)** using this exact checklist:

| Surface | Route / Handler | Gate Call |
| --- | --- | --- |
| Dashboard Pages | `apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts` | `publishResourceWithScreening(platformDb, tenantDb, { resourceType: "page", publishSource: "dashboard", ... })` |
| Dashboard Blog Posts | `apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts` | `publishResourceWithScreening(platformDb, tenantDb, { resourceType: "post", publishSource: "dashboard", ... })` |
| Dashboard Catalog Offerings | `apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts` | `publishResourceWithScreening(platformDb, tenantDb, { resourceType: "offering", publishSource: "dashboard", ... })` |
| Dashboard Custom Forms | `apps/web/src/pages/api/tenants/[tenantId]/forms/[formId]/publish.ts` | `publishFormWithScreening(platformDb, tenantDb, { publishSource: "dashboard", ... })` |
| Dashboard Identity / Settings / Theme | `apps/web/src/pages/api/tenants/[tenantId]/{identity,settings,theme}/publish.ts` | `publishResourceWithScreening(platformDb, tenantDb, { resourceType: "business_profile" \| "site_settings" \| "theme_config", publishSource: "dashboard", ... })` |
| MCP Publish Tools | MCP publish endpoints (`TASK-063` / MCP server) | `publishResourceWithScreening` / `publishFormWithScreening` with `publishSource: "mcp"` |

When `outcome === "held_for_review"`, every endpoint MUST return HTTP `202 Accepted` (or structured draft-hold payload) containing ONLY `ownerNotice` (`{ held: true, status: "draft", reason: "held_for_review", reviewId, message: "Konten ditahan untuk ditinjau" }`) and render `OwnerHeldNoticeCard` in the dashboard editor without disclosing matched keywords or domains.
