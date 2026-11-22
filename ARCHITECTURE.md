# Architecture — punyasitus

Updated: 2026-11-18
Expected stack: single Astro SSR app (`@astrojs/cloudflare`, `session: false`) on one Cloudflare Worker (`punyasitus-web`) exporting `TenantStore` (SQLite Durable Object), `VideoTranscoder` (Cloudflare Container), Queue and Cron handlers (ADR-0007, ADR-0009, DEC-036 — aligned with `adsbook.id`)

## Selected capabilities

| Capability | Decision | Proven operational |
|---|---|---|
| Control-plane database (`PLATFORM_DB`) | Cloudflare D1 (`punyasitus-platform`, `apac`, 10 GB) + Drizzle SQLite (`PLAN.md` §5.1, `DEC-036`) | No |
| Per-tenant database (`TenantStore`) | SQLite-backed Durable Object per website (10 GB/site, `locationHint: "apac-se"`, `D1Database`-compatible RPC adapter, PITR bookmarks; `PLAN.md` §5.2, `DEC-036`) | No |
| Authentication | Better Auth (`provider: "sqlite"`, `joins: true`), Google OAuth primary + email/password fallback, Organization + TOTP + MCP OAuth 2.1, host-isolated `__Host-` cookies on `app.punyasitus.com` & `console.punyasitus.com` (`PLAN.md` §4, `REQ-090`) | No |
| Admin UI system | React 19 islands + `shadcn/ui` v4 preset `base-nova` (`@base-ui/react` only, `rsc: false`, zero Radix/`asChild`, Lucide, Tailwind v4; `DESIGN.md` §1, `DEC-036`) | No |
| Extensibility (`Frozen Core`) | 6 platform themes + Style Variants + `paid_once` Premium Themes + `custom` themes (`apps/web/src/themes/**`) and First-Party Modular Plugins (`packages/plugins/*`, isolated `plg_*` SQLite tables in `TenantStore`, `private_client` / `public_free` / `public_paid` store; `ADR-0010`, `DEC-037`) | No |
| Deployment & media target | Cloudflare Workers, Cloudflare for SaaS on `situsku.click`, Custom Domains on `punyasitus.com`, Queues, Cron, R2 (`punyasitus-media` + `punyasitus-backup`), Cloudflare Images binding, `VideoTranscoder` Container (`ffmpeg`), Cloudflare Email Service (`env.EMAIL.send()` primary, Resend fallback), stateless AutoLaris static-IP relay (`ADR-0009`, `DEC-036`, `DEC-038`) | No |

Bootstrap source state: native generator: none. Every Cloudflare resource MUST use the `punyasitus-*` prefix and never touch `adsbook-*` or other project resources. These selections constrain future architecture work and do not create live remote resources until explicitly authorized.

## Current system

Nothing is built yet (`DEC-033` restart from zero). Canonical design lives in `PRD.md`, `PLAN.md`, `DESIGN.md`, `ADR-0007`, `ADR-0008` and `ADR-0009`; this file records what code and runtime configuration prove, starting with `TASK-023`.

## Boundaries

- Four host-isolated surfaces on one Worker: `punyasitus.com` (marketing), `app.punyasitus.com` (tenant/agency/affiliate app + auth + MCP), `console.punyasitus.com` (superadmin console), and `*.situsku.click` / verified custom hostnames (tenant public sites, passing HTTP DCV `/.well-known/pki-validation/*` & `/.well-known/acme-challenge/*` at Step 0).

## Data

- `PLATFORM_DB` (D1) holds cross-tenant identity, routing, billing, numbered PDF receipts, coupons, agencies, affiliates, funnel and audit records; `TenantStore` (SQLite DO) physically isolates each website's CMS content, offerings, forms, leads, media metadata and analytics.

## Decisions

Accepted architectural and product decisions live in `DECISIONS.md` (`DEC-001` through `DEC-043`) and `docs/adr/ADR-0001` through `ADR-0010`.

## Verification

- Spec & DAG integrity: `python3 scripts/check-spec.py` and `python3 scripts/test-check-spec.py`
- Runtime bootstrap (once `TASK-023` is authorized): `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration` (`workerd` D1 + `TenantStore` DO), `pnpm test:e2e`, `pnpm build`
