# Wave 8 — Pre-Launch Security Assurance (`ASVS L2` + `ZAP` + BOLA) & Full Production Release Gate (M2 Gate)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-038: Full Production Release Gate (M1 + M2)
- **Milestone:** M2
- **Requirement:** REQ-041
- **Constraints:** REQ-040, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `.github/workflows/**`, `tests/e2e-gate/**`, `tests/performance/**`, `scripts/verify/**`, `docs/operations/release-checklist.md`, `RELEASE.md`, `ARCHITECTURE.md`, `tests/task-038/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** TASK-063, TASK-019, TASK-020, TASK-035, TASK-064, TASK-065, TASK-066, TASK-071, TASK-072, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-105, TASK-109, TASK-110
- **Verification:** Done when `pnpm test:e2e` including tests/task-038 executes successfully and demonstrates: Re-run the TASK-063 checks including every M2 task on staging, plus the full Chromium/Firefox/WebKit matrix at 360/768/1440, the PLAN section 9 performance lab and an executed backup restore: clean checkout passes lint/typecheck/unit/integration/e2e/performance/build; run all PLAN negative cases including the TASK-053 schema/crawl suite extended with M2 vertical routes, Chromium/Firefox/WebKit no-JS public journeys and measured budgets; RELEASE.md records release ID, base, declared risk, a first-release rollback plan (no previous app version exists: rollback means disabling public routing and restoring the pre-launch backup) and backup proof, and `production-gate` passes; unverified provider/legal/launch gates remain explicit.
- **Visual Contract:** PLAN.md section 8 and accepted DESIGN.md; verify rendered states and successful/denied actions, not just screenshots.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.

### TASK-078: Pre-Launch Security Assurance (ASVS L2, ZAP, Cross-Tenant)
- **Milestone:** M2
- **Requirement:** REQ-078
- **Constraints:** REQ-001, REQ-034, REQ-038, REQ-039, REQ-068, REQ-076
- **Risk Level:** R3
- **Allowed Paths:** `docs/security/**`, `tests/security/**`, `.github/workflows/security.yml`, `scripts/security/**`, `tests/task-078/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-078; PLAN.md section 12; DECISIONS.md DEC-032.
- **Accepted Invariants:** Findings are fixed in their owning tasks' paths through normal task reopen, not inside this task; no testing against production or third-party systems without authorization.
- **Depends On:** TASK-063, TASK-067, TASK-075, TASK-076, TASK-077, TASK-079, TASK-083, TASK-084, TASK-085, TASK-086, TASK-098, TASK-099, TASK-100, TASK-101, TASK-102, TASK-103, TASK-107, TASK-109
- **Verification:** Done when `pnpm test:security` including tests/task-078 passes: the ASVS 5.0 L2 checklist in docs/security maps every applicable requirement to a test, control or accepted risk; the cross-tenant suite enumerates every tenant-owned API route, MCP tool and public route and proves 404/403 for foreign tenants; the ZAP baseline workflow runs in CI with no unaccepted high/medium alerts; a ZAP full scan against the production-like environment is recorded with each high/medium finding fixed (owning task reopened) or accepted with reason; an independent reviewer of a different model family signs off the report and the retest.
- **Visual Contract:** None.
- **Reopen Conditions:** A new internet-facing surface is added, a high finding reappears, or the ASVS version changes.
- **Rollback/Migration State:** Documentation and tests only.
- **Non-Scope:** Paid external pentest (DEC-032) and certification.
- **Escalation Conditions:** A critical finding that changes architecture, or a customer contract requiring an external pentest.
