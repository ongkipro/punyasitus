# Deferred — Owner Redirect Manager & 404 Monitor (`DEC-035 C16`) (Release 1.1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-062: SEO Redirects and 404 Monitor
- **Milestone:** Release 1.1 (deferred per DEC-035 C16; excluded from TASK-063 and TASK-038)
- **Requirement:** REQ-067
- **Constraints:** REQ-001, REQ-034, REQ-052, REQ-061
- **Risk Level:** R3
- **Allowed Paths:** `packages/db/migrations/**`, `apps/web/src/pages/dashboard/[handle]/seo/redirects/**`, `apps/web/src/pages/dashboard/[handle]/seo/not-found/**`, `apps/web/src/pages/api/tenants/[tenantId]/redirects/**`, `apps/web/src/pages/api/tenants/[tenantId]/not-found/**`, `apps/web/src/core/redirects.ts`, `packages/db/src/redirects/**`, `packages/core/src/redirects/**`, `docs/api/**`, `tests/task-062/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`, `.github/workflows/**`
- **Canonical Contract Owners:** PLAN.md section 15.7; PRD.md REQ-067.
- **Accepted Invariants:** Same-host exact-path sources only; internal targets only; one hop; live routes win; tenant-scoped and audited; 404 monitor stores no query, IP or user agent.
- **Depends On:** TASK-024, TASK-027, TASK-032, TASK-036, TASK-051
- **Verification:** Done when `pnpm test:integration` and `pnpm test:e2e` including tests/task-062 pass: owner/admin create, edit, delete and CSV-import redirects with preview; editors and other tenants are denied; regex, wildcard, external and query sources/targets are rejected; loops are rejected and chains flatten to one hop; a source matching a live route is rejected; the 501st redirect fails; 301/308 responses precede 404 and respect the service gate and cache revision; former-slug redirects list read-only; 404 monitor aggregates normalized paths per day, ignores asset extensions, caps at 200 paths for 30 days and offers "Buat redirect".
- **Visual Contract:** DESIGN.md SEO area: redirect list, form, CSV preview and 404 list at 360/768/1440px with keyboard access.
- **Reopen Conditions:** A listed acceptance case fails or the redirect bounds change.
- **Rollback/Migration State:** Keep schema changes additive; disabling redirects falls back to normal 404 behavior without data loss.
- **Non-Scope:** Regex/wildcard rules, external redirects, cross-domain rules, analytics on visitors and Search Console integration.
- **Escalation Conditions:** Request for regex/external redirects or storing visitor identifiers.
