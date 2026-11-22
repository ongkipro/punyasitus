# Wave 1 — Core Schemas (`PLATFORM_DB` + `TenantStore`), OpenAPI, URL Helpers & `base-nova` UI Shell (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-001: Multi-Tenant Database Schema & Drizzle Migrations
- **Milestone:** M1
- **Requirement:** REQ-001
- **Constraints:** REQ-034
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `packages/db/**`, `tests/task-001/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-001; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:integration` including tests/task-001 executes successfully and demonstrates: Fresh and upgrade Drizzle SQLite migrations succeed on local `workerd` `PLATFORM_DB` (D1) and per-tenant `TenantStore` (SQLite Durable Object); the `D1Database`-compatible `TenantStore` RPC adapter preserves `changes`/`last_row_id` and atomic `transactionSync` batches; Worker migration orchestration records a PITR bookmark in `PLATFORM_DB.migration_bookmarks` before migrating a tenant DO and marks failed tenants `recovery` (503); two concurrent tenants are physically isolated in separate `TenantStore` instances and `PLATFORM_DB` repositories reject cross-tenant queries.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-010: WhatsApp Dynamic CTA URL Generator & E.164 Validation
- **Milestone:** M1
- **Requirement:** REQ-014
- **Constraints:** REQ-013, REQ-016
- **Risk Level:** R1
- **Allowed Paths:** `packages/core/src/wa-dispatcher.ts`, `tests/task-010/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-014; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-010 executes successfully and demonstrates: Normalize valid 08/+628/628 formats; reject letters, bad prefixes and excessive length; expand page_url once, preserve literal dollar signs, Unicode and line breaks; reject unknown tokens.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-011: External Link-Out Validation
- **Milestone:** M1
- **Requirement:** REQ-015
- **Constraints:** None
- **Risk Level:** R1
- **Allowed Paths:** `packages/core/src/link-sanitizer.ts`, `tests/task-011/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-015; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-011 executes successfully and demonstrates: Accept HTTPS marketplace URL; reject HTTP, javascript, credentials, localhost/IP-private URLs and malformed values; no silent hash-link fallback; output required rel/target.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-024: HTTP Schemas and Authorization Contract
- **Milestone:** M1
- **Requirement:** REQ-034
- **Constraints:** REQ-038
- **Risk Level:** R3
- **Allowed Paths:** `docs/api/**`, `packages/core/src/schemas/**`, `packages/auth/src/permissions.ts`, `tests/task-024/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-034; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:unit` including tests/task-024 executes successfully and demonstrates: OpenAPI is generated from the shared packages/core schemas, committed under docs/api and fails CI on drift; it validates and covers PLAN route families, public DTO components for headless readiness, input/error schemas, roles and host-scoped anonymous endpoints; unknown fields and cross-tenant selectors are rejected by executable schema tests.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-032: UX Direction and Accessible Admin Foundation
- **Milestone:** M1
- **Requirement:** REQ-037
- **Constraints:** REQ-040
- **Risk Level:** R2
- **Allowed Paths:** `DESIGN.md`, `apps/web/components.json`, `apps/web/src/lib/utils.ts`, `apps/web/src/layouts/ConsoleLayout.astro`, `apps/web/src/layouts/DashboardLayout.astro`, `apps/web/src/components/ui/**`, `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/components/admin/**`, `apps/web/src/styles/admin/**`, `apps/web/src/dev/design-fixtures/**`, `tests/task-032/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-037; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-023
- **Verification:** Done when `pnpm test:e2e` including tests/task-032 executes successfully and demonstrates: Lock `apps/web/components.json` to `shadcn/ui` v4 preset `base-nova` (`@base-ui/react`, `rsc: false`, Lucide, `render` prop composition, CI check rejecting `@radix-ui/*` and `asChild`); map Tailwind v4 semantic tokens from DESIGN.md; render isolated synthetic desktop sidebar + `<768px` 5-slot mobile web-app bottom-bar shells for tenant dashboard, agency portal, affiliate portal and `console.punyasitus.com` plus permission/loading/empty/error and `trial`/`grace`/`locked`/`suspended` fixtures at 360/768/1440px; keyboard and 200% zoom checks pass before dependent screens. Exclude fixture routes from production builds.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.
