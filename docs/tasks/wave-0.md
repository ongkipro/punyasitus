# Wave 0 — Monorepo & Cloudflare `workerd` Bootstrap (M1)

Full task contracts for this wave. [`TASKS.md`](../../TASKS.md) is the queue: it owns order and state and repeats each task's requirement and dependencies, which `scripts/check-spec.py` keeps identical to this file. A finished contract moves to `docs/archive/TASKS-<date>.md` (DEC-048).

### TASK-023: Workspace Bootstrap & Runtime Compatibility Spike
- **Milestone:** M1
- **Requirement:** REQ-041
- **Constraints:** None
- **Risk Level:** R3
- **Allowed Paths:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `apps/web/package.json`, `apps/web/astro.config.*`, `apps/web/wrangler.jsonc`, `apps/web/tsconfig.json`, `apps/web/src/pages/index.astro`, `apps/web/src/worker/**`, `.github/workflows/ci.yml`, `packages/*/package.json`, `packages/*/tsconfig.json`, `packages/db/src/connections/**`, `packages/*/src/index.ts`, `scripts/dev/**`, `tests/setup/**`, `tests/fixtures/**`, `ARCHITECTURE.md`, `tests/task-023/**`
- **Protected Paths:** `packages/db/migrations/**`, `packages/auth/**`, `infra/**`, `.github/workflows/**`, `.env`, `.env.*`, `**/.env`, `**/.env.*`, `apps/web/src/middleware/**`
- **Canonical Contract Owners:** PRD.md REQ-041; PLAN.md corresponding component contract.
- **Accepted Invariants:** Existing product scope and IDs remain; scoped failures have no unauthorized side effects; no production data in fixtures.
- **Depends On:** None
- **Verification:** Done when `pnpm build` and the compatibility probes executes successfully and demonstrates: Pin compatible supported versions of pnpm, Astro (`output: "server"`, `session: false`), `@astrojs/cloudflare`, Wrangler, Better Auth (`provider: "sqlite"`, `joins: true`), Drizzle SQLite, `@base-ui/react` (`shadcn/ui` `base-nova`, zero `@radix-ui/*`), Tailwind v4 and `pdf-lib`; enable strict TypeScript and `noUncheckedIndexedAccess` across apps/packages with Astro template checks; define PLAN section 9 scripts; run the single Astro Worker (`punyasitus.com`, `app.punyasitus.com`, `console.punyasitus.com` and `*.situsku.click` surfaces) in `workerd` through `astro dev` and `wrangler dev`; validate `PLATFORM_DB` D1 and `TenantStore` SQLite Durable Object queries with synthetic fixtures; prove a Queue producer/consumer, DO `alarm()` and Cron handler run locally; Wrangler dry-run reports bundle size under 64 MiB and startup under 1 s; add a CI workflow running lint, typecheck, unit and `workerd` integration tests from a frozen lockfile on every push, plus `scripts/check-spec.py`; ARCHITECTURE.md records the workspace layout and pinned versions.
- **Visual Contract:** No new visual behavior in this task; dependent UI tasks own browser acceptance.
- **Reopen Conditions:** A listed acceptance case fails, an upstream contract changes, or evidence no longer matches the implementation revision.
- **Rollback/Migration State:** Keep schema changes additive; preserve data; revert only this task's compatible application changes after review.
- **Non-Scope:** Unlisted modules, new vendors, live infrastructure mutation and automatic Git actions.
- **Escalation Conditions:** An unresolved PLAN gate changes architecture/cost/privacy; destructive migration; overlapping user edits; required change exceeds the declared boundary.
