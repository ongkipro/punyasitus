# PunyaSitus

> **Status:** **M1 + M2 Release Candidate complete (`109 / 110` roadmap tasks; `4 / 4` hosted GitHub Actions workflows GREEN; `TASK-062` deferred to Release 1.1 per `DEC-035 C16`)** — live Cloudflare/provider/legal gates (`EXT-01..EXT-10`) await owner authorization | **Repository:** public `ongkipro/punyasitus`; research in private `punyasitus-docs` (DEC-044)
> **Implemented stack:** 100% Cloudflare (aligned with `adsbook.id`): Astro 7 SSR + React 19 islands (`shadcn/ui` `base-nova` / `@base-ui/react`) on one Cloudflare Worker, Cloudflare for SaaS (`situsku.click`), `PLATFORM_DB` (D1, `0001..0033`) + `TenantStore` (SQLite Durable Object per website, `0001..0024`), Drizzle ORM, Better Auth (Google OAuth + TOTP + MCP OAuth 2.1), R2 + Images + Containers (`ffmpeg` stub), Queues + Cron (ADR-0009) | **Started:** 2026-09-26

## Overview

PunyaSitus is a WordPress-like, multi-tenant business CMS for Indonesian businesses: company profiles, professional services, travel/Umrah and outlets. Each tenant gets one website with pages, blog, media, menus, themes, settings, members, a lead inbox and a showcase catalog. Visitors convert through WhatsApp, external links or the lead form. It is not a store: there is no cart, checkout, visitor payment, order or stock (DEC-008).

Four host-isolated surfaces run in one Astro Worker application (ADR-0007, ADR-0009):

| Surface | Where | Who |
|---|---|---|
| Platform marketing | `punyasitus.com` | Prospective SMEs, agencies, affiliates |
| Tenant, agency & affiliate app | `app.punyasitus.com` (`/dashboard/{handle}`, `/agency`, `/affiliate`) | Owners, admins, editors, agencies, affiliates |
| Platform superadmin console | `console.punyasitus.com` (DEC-035 C11) | Platform operators (Google allowlist + TOTP) |
| Tenant public site | `<handle>.situsku.click` or verified custom domain | Visitors & AI/search crawlers |

Business model: one website per subscription, 7-day free trial (DEC-023), IDR 179,000 per calendar month or IDR 1,790,000 per year plus the payment channel fee (DEC-035), paid through AutoLaris (DEC-006, DEC-010). Custom brand theme development is the core paid service (DEC-015), requested from the theme menu (DEC-013) and built by following [docs/themes/THEME-DEVELOPMENT.md](./docs/themes/THEME-DEVELOPMENT.md). SEO matches WordPress + All in One SEO, built in (DEC-016).

All 109 M1 + M2 launch-scope tasks, 6 tracked security findings (`SEC-001..006`), and 8 pre-staging polish items (`M1-FU-01..08`) are implemented and verified locally and on hosted GitHub Actions (`CI`, `Security Assurance`, `Staged Release Dry-Run`, `Production Release Gate`). Live production deployment remains gated behind owner-authorized external staging, provider, and legal checks (`EXT-01..EXT-10` in [docs/operations/release-checklist.md](./docs/operations/release-checklist.md)).

## Documents

**Start at [docs/README.md](./docs/README.md)**: the documentation map that connects this project, its development documents and the private research repository `punyasitus-docs`.

Each document owns its subject; do not restate one inside another.

- 🗺️ [docs/README.md](./docs/README.md) — documentation map (start here)
- 🤖 [AGENTS.md](./AGENTS.md) — read order and rules for AI agents
- 📋 [PRD.md](./PRD.md) — product scope and requirements (REQ-001..REQ-110)
- 🧭 [PLAN.md](./PLAN.md) — technical contracts: runtime, tenancy, data, HTTP, media, SEO, billing, lifecycle
- 🎨 [DESIGN.md](./DESIGN.md) — visual direction, components and TypeScript contract (proposed until TASK-032)
- ✅ [TASKS.md](./TASKS.md) — the only execution queue, an index whose full contracts live in [docs/tasks/](./docs/tasks/) (DEC-048) (TASK-001..TASK-110; full development per DEC-030: phase M1 checkpoint TASK-063, production release gate TASK-038)
- 📝 [DECISIONS.md](./DECISIONS.md) — decision register and [ADRs](./docs/adr/)
- 🧩 [docs/themes/THEME-DEVELOPMENT.md](./docs/themes/THEME-DEVELOPMENT.md) — how to build a custom brand theme (humans and AI agents) · [docs/plugins/PLUGIN-DEVELOPMENT.md](./docs/plugins/PLUGIN-DEVELOPMENT.md) — plugins
- 📊 [STATUS.md](./STATUS.md) — current workflow state
- 🏗️ [ARCHITECTURE.md](./ARCHITECTURE.md) — system map as built (topology diagram, surface/route map, workspace layout, capabilities & CI proof)
- 🚀 [RELEASE.md](./RELEASE.md) · 📡 [OBSERVABILITY.md](./OBSERVABILITY.md) · 📜 [BUILD-LOG.md](./BUILD-LOG.md)

## Repository layout

This repository holds code and the development contract; research, archive and the HTML prototype live in the private `punyasitus-docs` repository (DEC-044, see `AGENTS.md`). The boundaries below are the `Allowed Paths` of `TASKS.md`; each folder is created by the first task that writes to it, starting with TASK-023. Only the README boundary notes exist before then.

```text
apps/web                Astro SSR Worker `punyasitus-web` (PLAN §2): marketing, tenant public site, /dashboard, /agency, /affiliate, console, /auth, /api, /mcp
  src/worker            Worker entry (Step 0 DCV pass-through, host gate), TenantStore DO, VideoTranscoder Container, Queue and Cron handlers
  src/middleware        Host -> surface -> tenant resolution (protected, R3)
  src/core              Frozen core CMS modules (ADR-0010)
  src/pages             Routes per surface; JSON mutations only under src/pages/api/** (ADR-0007)
  src/themes            Platform, premium and custom themes (docs/themes/THEME-DEVELOPMENT.md)
  src/components, layouts, styles, scripts, content, lib
apps/status             Platform status page (TASK-106)
packages/core           Runtime-neutral Zod schemas, OpenAPI source, money/IDR, slugs, WA, SEO, theme and plugin contracts
packages/db             Drizzle SQLite: src/platform (PLATFORM_DB, D1) + src/tenant (TenantStore DO), migrations/ (protected)
packages/auth           Better Auth (sqlite), RBAC, platform operators, agency and entitlements (protected)
packages/integrations   Provider adapters, e.g. src/autolaris (TASK-057/058)
packages/plugins        First-party plugins (`seo-ai-autopilot`, `bio-links`, `wa-cs-rotator`, `wp-importer`, `lead-notifier`; docs/plugins/PLUGIN-DEVELOPMENT.md)
infra/cloudflare        Reviewable zone, SaaS, WAF/O2O and Wrangler resource config (`punyasitus-*` only; protected)
tests                   task-NNN/ acceptance suites, security/, performance/, e2e-gate/
scripts                 check-spec.py (now); verify/, security/, backup-restore/ (later tasks)
docs/adr                Architecture decision records (index: DECISIONS.md)
docs/tasks              Full task contracts per wave; TASKS.md is the queue index (DEC-048)
docs/themes, docs/plugins   Theme and plugin development guides
docs/api                OpenAPI contract generated from packages/core (TASK-024)
docs/operations, docs/security   Runbooks and security evidence (later tasks)
.delivery               delivery-ledger evidence (tool-owned)
```

## Verification checks

```bash
pnpm spec:check                               # requirements, tasks, index/contract agreement, dependencies, links, 50 KB budget
pnpm lint && pnpm typecheck && pnpm build     # ESLint, Astro/TS typecheck, SSR Worker build & Wrangler budget
pnpm test:unit && pnpm test:integration       # 110 unit suites + 94 Cloudflare workerd D1/DO integration suites
node scripts/security/run-security-suite.mjs  # 375-route parity, 50-endpoint cross-tenant BOLA & local DAST
node scripts/verify/release-gate.mjs          # Full M1 + M2 static release gate (109 tasks)
```

## Open gates

No product decision is open (DEC-045..DEC-048), and all local/CI M1 + M2 engineering gates pass (`4 / 4` hosted GitHub Actions workflows GREEN). What remains requires live accounts, owner authorization, or legal counsel: external staging/provider/legal gates `EXT-01..EXT-10` ([docs/operations/release-checklist.md](./docs/operations/release-checklist.md)) and the three live verifications in [STATUS.md](./STATUS.md).

## Environment

- **Production:** not provisioned (`EXT-01..EXT-10` gated)
- **Staging:** not provisioned (`EXT-01..EXT-06` awaiting owner authorization)
- **Local & Hosted CI:** active & verified (`workerd` D1/DO/R2 + `4 / 4` hosted GitHub Actions workflows GREEN)
