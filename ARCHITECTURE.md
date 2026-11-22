# Architecture — punyasitus

Updated: 2026-11-22
Current state: Wave 0 (`TASK-023`) and full Wave 1 (`TASK-001`, `TASK-024`, `TASK-010`, `TASK-011`, `TASK-032`) implemented; awaiting Product Owner visual ACC on `TASK-032` before launching Wave 2 (`TASK-028`, `TASK-002`).

## Pinned Workspace & Runtime Versions (`TASK-023`)

| Layer | Pinned Package / Tool | Version | Notes |
|---|---|---|---|
| Package manager / runtime | `pnpm` / Node.js | `pnpm@12.21.0` / `node >=22.23.4` | `onlyBuiltDependencies: [esbuild, workerd]` |
| Web SSR & Worker adapter | `astro` / `@astrojs/cloudflare` / `@astrojs/react` | `7.4.13` / `14.4.9` / `7.1.9` | `output: "server"`, `session: false`, `nodejs_compat`, custom Worker entry `apps/web/src/worker/index.ts` |
| Cloudflare CLI & types | `wrangler` / `@cloudflare/workers-types` | `4.166.0` / `5.20261121.1` | `compatibility_date: "2026-11-22"`, pre-declared v1 local bindings |
| Database ORM & migrations | `drizzle-orm` / `drizzle-kit` | `0.45.4` / `0.31.11` | `PLATFORM_DB` (D1) + `TenantStore` SQLite Durable Object RPC adapter (`D1Database`-compatible) |
| Authentication | `better-auth` | `1.7.27` | Per-request `drizzleAdapter(..., { provider: "sqlite" })`, `advanced.database.joins: true`, `cf-connecting-ip` |
| UI foundation | `react` / `@base-ui/react` / `tailwindcss` / `lucide-react` | `19.3.1` / `1.9.0` / `4.3.5` / `1.77.0` | `shadcn/ui` `base-nova` direction; lint gate rejects `@radix-ui/*` / `radix-ui` (`DEC-036`) |
| Core utilities | `zod` / `pdf-lib` | `4.6.7` / `1.17.1` | Runtime-neutral validation and pure-JS receipt PDFs in `workerd` |
| TypeScript & checks | `typescript` / `@astrojs/check` / `eslint` / `vitest` / `@cloudflare/vitest-plugin` | `6.0.3` / `0.9.12` / `10.15.0` / `4.1.12` / `1.9.0` | `strict: true`, `noUncheckedIndexedAccess: true`; `VITEST_MAX_WORKERS` configurable |

## Workspace Layout

```text
apps/
  web/                     @punyasitus/web — single Astro SSR Cloudflare Worker (`punyasitus-web`)
    astro.config.mjs       output: "server", session: false, @astrojs/cloudflare, React, Tailwind v4
    wrangler.jsonc         pre-declared v1 local bindings (D1, TenantStore DO, R2, Images, Queue, AI, Email, Cron)
    src/worker/            Worker entry (Step 0 DCV pass-through, fetch/queue/scheduled), TenantStore DO, VideoTranscoder stub, Env types
    src/pages/index.astro  Bootstrap surface classification route (`punyasitus.com`, `app.`, `console.`, `*.situsku.click`)
packages/
  core/                    @punyasitus/core — runtime-neutral host/surface helpers, Zod & pdf-lib utilities
  db/                      @punyasitus/db — Drizzle helper & `D1Database`-compatible `TenantStore` SQLite DO RPC adapter (`src/connections/`)
  auth/                    @punyasitus/auth — per-request Better Auth SQLite factory (`joins: true`)
  integrations/            @punyasitus/integrations — server-only external provider boundaries (`EmailPort`, origin guard)
  plugins/                 @punyasitus/plugins — Frozen-Core plugin manifest & `plg_<id>__*` table prefix contract
scripts/dev/               `heavy.sh` (per-worktree `heavy-run` wrapper with CI fallback), lint, Wrangler dry-run budget check, dev server probe
tests/
  setup/                   Vitest unit & `@cloudflare/vitest-plugin` workerd integration configs
  fixtures/                Synthetic two-tenant fixtures (zero production data)
  task-023/                Bootstrap unit & `workerd` integration acceptance suite
.github/workflows/ci.yml   SHA-pinned GitHub Actions CI (`check-spec`, lint, typecheck, unit, workerd integration, build/dry-run)
```

## Selected Capabilities

| Capability | Decision | Proven operational |
|---|---|---|
| Control-plane database (`PLATFORM_DB`) | Cloudflare D1 (`punyasitus-platform`, `apac`, 10 GB) + Drizzle SQLite (`PLAN.md` §5.1, `DEC-036`) | Local `workerd` verified (`TASK-023`); remote staging pending |
| Per-tenant database (`TenantStore`) | SQLite-backed Durable Object per website (10 GB/site, `locationHint: "apac-se"`, `D1Database`-compatible RPC adapter, PITR bookmarks; `PLAN.md` §5.2, `DEC-036`) | Local `workerd` two-tenant isolation, `changes`/`last_row_id`, atomic `transactionSync` rollback, and `alarm()` verified (`TASK-023`); remote staging pending |
| Authentication | Better Auth (`provider: "sqlite"`, `joins: true`), Google OAuth primary + email/password fallback, Organization + TOTP + MCP OAuth 2.1, host-isolated `__Host-` cookies (`PLAN.md` §4, `REQ-090`) | Per-request `workerd` instantiation verified (`TASK-023`); full flows in `TASK-025`/`TASK-090` |
| Admin UI system | React 19 islands + `shadcn/ui` v4 preset `base-nova` (`@base-ui/react` only, `rsc: false`, zero Radix/`asChild`, Lucide, Tailwind v4; `DESIGN.md` §1, `DEC-036`) | Locked & real-browser verified at 360/768/1440px (`TASK-032`); Radix & `asChild` lint guard active |
| Extensibility (`Frozen Core`) | 6 platform themes + Style Variants + `paid_once`/`custom` themes and First-Party Modular Plugins (`plg_*` tables; `ADR-0010`, `DEC-037`) | Prefix/manifest contract bootstrapped (`TASK-023`); runtime in `TASK-012`/`018`/`097` |
| Deployment & media target | Cloudflare Workers, Cloudflare for SaaS (`situsku.click`), Custom Domains (`punyasitus.com`), Queues, Cron, R2, Images, `VideoTranscoder` Container, Email Service, AutoLaris relay (`ADR-0009`, `DEC-036`, `DEC-038`) | Local `workerd` Queue/Cron, `astro dev`, `wrangler dev`, and `wrangler deploy --dry-run` verified (`TASK-023`); remote staging pending |

## Boundaries & Parallel Execution Conventions

- Four host-isolated surfaces on one Worker: `punyasitus.com` (marketing), `app.punyasitus.com` (tenant/agency/affiliate app + auth + MCP), `console.punyasitus.com` (superadmin console), and `*.situsku.click` / verified custom hostnames (tenant public sites, passing HTTP DCV `/.well-known/pki-validation/*` & `/.well-known/acme-challenge/*` at Step 0).
- Heavy local scripts (`pnpm build`, `pnpm test:integration`, `pnpm test:e2e`) route through `scripts/dev/heavy.sh` (per-worktree `heavy-run` lock on dev hosts, direct execution in CI). Local dev server probes use ephemeral free ports (`port: 0`) and isolated temp `.wrangler/state` directories so linked worktrees never collide.
- Cloudflare account hygiene: every resource uses the `punyasitus-*` prefix on PunyaSitus's dedicated Cloudflare account.

## Verification

- Spec & DAG integrity: `pnpm spec:check` (`python3 scripts/check-spec.py` + `python3 scripts/test-check-spec.py`)
- Static & runtime verification (`TASK-023`): `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build` (Astro build + Wrangler dry-run `< 64 MiB` & `< 1 s` startup), `pnpm test:e2e` (`astro dev` + `wrangler dev` 4-surface probe), `actionlint`
