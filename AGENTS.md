# Project Instructions — punyasitus

## Scope

This file contains repository-specific rules only. Global safety, Git, secret-handling, native-first, and verification policy comes from the user's canonical AI policy.

## Project

- Purpose: PunyaSitus, a WordPress-like multi-tenant business CMS and digital growth platform for Indonesian company profiles, services, products, travel/Umrah and car/motorcycle dealers (`service`, `product`, `tour`, `vehicle`). It is not a store: offerings convert through WhatsApp, link-out or lead/custom forms (DEC-008, DEC-035).
- Planned stack (ADR-0007 surfaces, ADR-0009 runtime accepted 2026-11-18, DEC-036 — aligned with `adsbook.id`): pnpm monorepo; one Astro SSR app `apps/web` on `@astrojs/cloudflare` (`output: "server"`, `session: false`, `nodejs_compat`) deployed as one Cloudflare Worker (`punyasitus-web`) serving `punyasitus.com` (marketing), `app.punyasitus.com` (`/dashboard/{handle}`, `/agency`, `/affiliate`, `/auth`, `/account`, `/api`, `/mcp`), `console.punyasitus.com` (superadmin console), and SaaS zone `situsku.click` (`*.situsku.click` + customer custom hostnames via `cname.situsku.click`); React 19 islands with **`shadcn/ui` v4 preset `base-nova`** (`@base-ui/react` primitives exclusively, `rsc: false`, Lucide icons; never Radix UI); **`PLATFORM_DB` (Cloudflare D1, 10 GB)** control plane + **`TenantStore` (SQLite Durable Object per tenant, 10 GB/site, `locationHint: "apac-se"`)** data plane with Drizzle ORM (no Supabase/external Postgres); R2 + Cloudflare Images binding + on-demand scale-to-zero Cloudflare Container (`ffmpeg` for MOV/WebM); Cloudflare Queues + Cron; Better Auth (`provider: "sqlite"`, Google OAuth primary); Resend email; AutoLaris via stateless static-IP relay.
- Current state: restarted from zero on 2026-11-17 (DEC-033). Specifications plus a non-authoritative static HTML prototype (`punyasitus-docs/docs/html/`, see its README; it is not TASK-032 evidence). The September 2026 code (`dev/m1`, `dev/m1-b`) is history and must not be reused or cherry-picked. CMSPRO is merged (DEC-034, DEC-035): its accepted content now lives in PRD.md; `punyasitus-docs/docs/archive/cmspro/` is never an implementation source. PRD.md, PLAN.md, DESIGN.md, DECISIONS.md and TASKS.md are synchronised to the merged Cloudflare-native baseline (DEC-035, DEC-036). No application code exists and development is not authorized yet. Do not scaffold, install dependencies or start any TASK until Paduka Ongki explicitly authorizes development; the first task is then TASK-023.

## Repositories (DEC-044)

| Folder | Repository | Visibility | Holds |
|---|---|---|---|
| `~/Projects/punyasitus` (this) | `ongkipro/punyasitus` | intended public | application code and the development contract: root `AGENTS.md`, `STATUS.md`, `TASKS.md`, `PRD.md`, `PLAN.md`, `DESIGN.md`, `DECISIONS.md`, `ARCHITECTURE.md`, `BUILD-LOG.md`, `RELEASE.md`, `OBSERVABILITY.md`, `docs/adr/`, `docs/themes/`, `docs/plugins/`, later `docs/api/`, `docs/operations/`, `docs/security/`, plus `.delivery/` and `scripts/` |
| `~/Projects/punyasitus-docs` | `ongkipro/punyasitus-docs` | private | research, the frozen CMSPRO archive, the static HTML prototype and the CMSPRO merge ledger; never an implementation source |

A path written `punyasitus-docs/docs/...` lives in the private repository, cloned beside this one. The development contract stays here because `delivery-ledger`, `project-check`, `production-gate` and `release-check` read it from the code repository and bind review to the same commit. Never move it out, never add research or customer-identifying material here, and never link into `punyasitus-docs` with a Markdown link (it does not resolve for public readers); cite the path in backticks.

## Read order

1. `AGENTS.md` (this file), then `STATUS.md` for the current state.
2. `PRD.md` for product behavior and requirements (REQ-NNN).
3. `DECISIONS.md` and the linked `docs/adr/` records.
4. `PLAN.md` for runtime, data, IAM, domain, HTTP, security, billing and lifecycle contracts.
5. `DESIGN.md` before any UI task; `docs/themes/THEME-DEVELOPMENT.md` before any custom theme work.
6. `TASKS.md` as the only execution queue; follow dependencies, not numeric order.

## Sources of truth

- Accepted product behavior: root `PRD.md` (canonical; this repository has no `docs/spec/` suite)
- Sole executable work queue: `TASKS.md`
- Current implementation handoff and semantic review state: `STATUS.md`
- Accepted technical and product constraints: `DECISIONS.md`
- Accepted implementation design when present: `PLAN.md`
- Full architecture decisions when present: `docs/adr/ADR-NNNN-<slug>.md`; `DECISIONS.md` remains the canonical index
- Current release boundary, declared release risk, rollback evidence: `RELEASE.md`
- Post-deploy runtime health contract: `OBSERVABILITY.md`
- Execution evidence and resume projection: `.delivery/`
- Durable implementation notes: `BUILD-LOG.md`
- Architecture and trust boundaries: `ARCHITECTURE.md`

When design and implementation diverge, `ARCHITECTURE.md` records what the code
actually does and therefore outranks a pre-implementation `PLAN.md`. Update the
plan or supersede its decision rather than leaving two current claims.

`STATUS.md` is the only workflow-state authority. `.delivery/current.json` is a projection/evidence index and must never override `STATUS.md`. Do not hand-edit `.delivery/runs/*.jsonl` or `.delivery/releases/*.json`; their integrity is verified by hash chains/self-hashes. Use `delivery-ledger` to start runs, capture an R1-R4 task boundary, record verification, check the final change surface, checkpoint handoffs, finish runs, and snapshot releases. A bounded run may not report `PASS` without a current passing or independently approved boundary result. The canonical behavior and examples live in `~/dotfiles/docs/task-change-boundary.md`.

Delivery metrics are optional immutable sidecars under `.delivery/metrics/`. Use `delivery-benchmark` to record them after a run finishes and to compare model reliability/cost empirically. Benchmark recommendations are advisory only. Do not rewrite routing from a small sample, do not select a cheaper model below the configured reliability floor, and never auto-downgrade R3/R4 work from benchmark output.

Inspect the repository's actual configuration before adding stack-specific rules. Disk and executable behavior override stale documentation. Production readiness must be proven by the repository gates; never infer it from prose alone. `production-gate` also requires `delivery-ledger verify` to pass before a release is production-ready.

## Project rules

- Tenant isolation first: every tenant-owned query, cache key, upload, job and lookup is scoped; another tenant's ID returns 404. Tenant ID or handle is a selector, never authorization (PLAN section 4).
- Host decides the surface before routing (PLAN section 2): pass `/.well-known/pki-validation/*` and `/.well-known/acme-challenge/*` through untouched first so HTTP DCV SSL succeeds; `punyasitus.com` serves the platform marketing site; `app.punyasitus.com` serves `/dashboard/{handle}`, `/agency`, `/affiliate`, `/auth`, `/account`, admin APIs and (M2) `/mcp` + OAuth; `console.punyasitus.com` serves the superadmin console (host-only `__Host-` cookie, Google allowlist + TOTP, active `platform_operators` grant); verified tenant hosts (`*.situsku.click` and active custom domains) serve only the public site plus `POST /api/leads` and `POST /api/events`.
- One mutation path: JSON endpoints under `apps/web/src/pages/api/**` documented in `docs/api/` OpenAPI. No Astro Actions in v1 and no client cache library (ADR-0007). The M2 MCP endpoint (ADR-0008) is a bearer-token transport that calls the same server-only services; it never carries business rules of its own.
- Public-site routes stay HTML-first within the PLAN section 9 JS budget; admin islands never load on tenant hosts.
- Never add cart, checkout, visitor payment, orders, stock, shipping or visitor accounts (DEC-008). Subscription billing is tenant-to-platform only (PLAN section 16).
- Identifiers and slugs follow PLAN section 7.1; limits and quotas follow PLAN sections 3.1, 7.2 and 11.2.
- Custom theme & plugin extensibility (`Frozen Core`, DEC-015, ADR-0010, DEC-037): never modify core CMS modules (`packages/core`, `packages/db`, `packages/auth`, `apps/web/src/core`) for bespoke client designs or features. Client visual work lives in `apps/web/src/themes/{premium,custom}/<theme-id>/` (`docs/themes/THEME-DEVELOPMENT.md`, consuming public DTO props, never emitting SEO/head/tracker tags or importing db/auth) and client/add-on functional work lives in `packages/plugins/<plugin-id>/` (`docs/plugins/PLUGIN-DEVELOPMENT.md`, isolated `plg_<id>__*` tables in `TenantStore`, zero runtime cost when inactive, `private_client` / `public_free` / `public_paid`). Arbitrary `.zip`/third-party code uploads are forbidden.
- SEO & AI Indexing (`DEC-039`, `REQ-102`): packaged as the official free Zero-Config plugin `seo-ai-autopilot` (`packages/plugins/seo-ai-autopilot`) populating the shared shell's single `<head>` & discovery slot (`/sitemap.xml`, `/robots.txt`, `[indexnowKey].txt`, OG, Schema `@graph`). Themes and other plugins must never add a second `<head>`, schema or sitemap authority; when `seo-ai-autopilot` is inactive, base editors hide SEO inputs and the shell emits only minimal `<title>` + mandatory `trial`/`suspended` `noindex` safety headers.
- Admin UI labels and errors are Bahasa Indonesia; code, contracts and docs are English.
- UI primitive rule (DEC-036): admin/portal islands use `shadcn/ui` style `base-nova` (`@base-ui/react`) exclusively. Never install `radix-ui` / `@radix-ui/*` or write Radix `asChild` props (use Base UI `render={<a ... />}`).
- Cloudflare account hygiene: prefix every Cloudflare resource with `punyasitus-*` and never touch resources of other projects (`adsbook-*`, etc.) on the same account.
- Verify framework, Better Auth, Drizzle, AutoLaris and Cloudflare APIs against official documentation for the pinned version; never invent API names, fees or provider behavior.
- No deploy, DNS change, provider mutation, paid provisioning, commit or push without explicit authorization for that action. Secrets never enter the repository or docs.
- `ADR-0002` is superseded history; do not implement from it.
- After any documentation change run `python3 scripts/check-spec.py` and `python3 scripts/test-check-spec.py`; both must pass. They check structure and traceability only, not application behavior.
