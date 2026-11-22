# Wave 6 — Phase 1 Integration Checkpoint (53 direct M1 leaf dependencies) (M1 Gate)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-063: Phase 1 Integration Checkpoint (M1)
- **Milestone:** M1
- **Requirement:** REQ-041
- **Constraints:** REQ-040, REQ-042
- **Risk Level:** R3
- **Allowed Paths:** `.github/workflows/**`, `tests/e2e-gate/**`, `tests/performance/**`, `scripts/verify/**`, `docs/operations/release-checklist.md`, `tests/task-063/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md sections 8 and 9; TASKS.md milestones.
- **Accepted Invariants:** Checkpoint scope is exactly the M1 list; it is not a production release (DEC-030); unverified provider/legal gates remain explicit; no production action without authorization.
- **Depends On:** TASK-014, TASK-018, TASK-022, TASK-026, TASK-033, TASK-034, TASK-036, TASK-037, TASK-039, TASK-040, TASK-041, TASK-042, TASK-043, TASK-044, TASK-045, TASK-046, TASK-047, TASK-048, TASK-049, TASK-050, TASK-051, TASK-052, TASK-053, TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-059, TASK-060, TASK-061, TASK-065, TASK-067, TASK-068, TASK-069, TASK-070, TASK-076, TASK-077, TASK-080, TASK-081, TASK-082, TASK-087, TASK-088, TASK-089, TASK-090, TASK-091, TASK-092, TASK-093, TASK-094, TASK-095, TASK-096, TASK-097, TASK-102, TASK-103, TASK-104, TASK-106, TASK-107, TASK-108
- **Verification:** Done when `pnpm test:e2e` including tests/task-063 executes successfully and demonstrates: clean checkout passes lint/typecheck/unit/integration/e2e/build in CI; all M1 negative cases pass in Chromium at 360/1440 on the production-like local compose topology (staging once it exists); unverified provider/legal/launch gates listed. The full browser matrix, performance lab and restore rehearsal run once, in TASK-038.
- **Visual Contract:** PLAN.md section 8 full browser matrix, run once at the phase 1 checkpoint.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** M2 tasks (TASK-019, TASK-020, TASK-035, TASK-064, TASK-066, TASK-071, TASK-072, TASK-073, TASK-074, TASK-075), live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.
