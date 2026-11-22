# ADR-0010: Frozen-Core Extension Model — Theme Style Variants, Theme Store, and Modular First-Party Plugins

- **Status:** Accepted (owner decision 2026-11-18, DEC-037)
- **Date:** 2026-11-18
- **Author:** Architecture & Product Specification Review
- **Deciders:** Paduka Ongki
- **Extends:** ADR-0003 (Dual Theme Engine), ADR-0007 (Single Astro Worker Surfaces), ADR-0008 (Tenant MCP Server), ADR-0009 (100% Cloudflare Multi-Tenant Runtime)

## Context

PunyaSitus serves both self-service Indonesian SMEs (at IDR 179,000/month) and bespoke/agency clients who request custom visual designs **plus** custom business features (e.g., multi-agent WhatsApp CS lead rotation, bio-link landing pages, appointment booking, CRM/Google Sheets sync, custom calculators).

Two architectural temptations had to be evaluated against primary research and Cloudflare platform limits:

1. **Modifying Core CMS Code per Client Request:** Adding client-specific logic directly into `packages/core`, `packages/db`, or `apps/web/src/core` causes core bloat, cross-tenant regression risks, and high maintenance cost.
2. **WordPress-Style Arbitrary `.zip` Uploads or "1 Worker = 1 Client" (`Workers for Platforms`):**
   - Arbitrary third-party plugin uploads are the root cause of WordPress's fragility (Patchstack: 96% of 11,334 WP vulnerabilities in 2025 came from plugins, fueling gambling/SEO-spam injections and 10.0s median mobile LCP).
   - Deploying a separate Worker script per regular tenant via **Workers for Platforms** ($25/month base + $0.02/script beyond 1,000) disables `caches.default` on namespaced user Workers, lacks gradual deployments, and forces per-tenant redeployments constrained by Cloudflare's `1,200 requests / 5 minutes` global Client API rate limit.
   - Conversely, our accepted `adsbook.id`-aligned runtime (`ADR-0009`: **1 Shared Worker + 1 physical `TenantStore` SQLite Durable Object per website**) already gives each client physical database and R2 storage isolation while keeping $5/month base pricing, `caches.default` edge caching, and instant 3-second atomic updates across all tenants.

## Decision

### 1. Frozen Core Principle (Zero Core Churn for Client Delivery)

The core CMS (`packages/core`, `packages/db`, `packages/auth`, `apps/web/src/core`) is a **Frozen Core**. Client-requested visual designs and client-requested feature extensions MUST be delivered exclusively through:
- **Themes** (`apps/web/src/themes/{compro..dealer,premium/*,custom/*}`) for visual/layout work, and
- **First-Party Modular Plugins** (`packages/plugins/<plugin-id>`) for functional/data/workflow work,

without adding tenant-specific branches or bespoke tables to core CMS modules. A bespoke plugin built for one paying client (`visibility: "private_client"`) can later be promoted to a free platform enhancer (`public_free`) or a commercial recurring/one-time add-on (`public_paid`) by updating catalog metadata in `PLATFORM_DB` — *"build once for a client, sell repeatedly in the Plugin Store."*

### 2. Shared Worker Engine + Physical Per-Tenant DO (Not 1 Worker per Regular Client)

- All standard, premium-theme, custom-theme, and plugin-enabled websites run on the **single shared `punyasitus-web` Worker** backed by **one dedicated `TenantStore` SQLite Durable Object per website** (`ADR-0009`).
- Inactive plugins and inactive themes incur **zero database tables, zero runtime queries, and zero bytes of public CSS/JS** on tenants that have not enabled them.
- As a future enterprise escape hatch only, `PLATFORM_DB.tenants` reserves a nullable `dedicated_worker_service` metadata field so a high-value enterprise contract requiring isolated custom Worker compute can be routed explicitly without changing the architecture for the other 99.9% of tenants.

### 3. Three-Tier Theme System (`Style Variants` + `Theme Store` + `Custom`)

1. **Built-in Platform Themes + Style Variants (`included`):** All 6 vertical themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) inherit shared base primitives (`themes/default`) and expose curated **Style Variants** (palette, font pair within the `<= 1` custom-font cap, border/card density, header/hero layout variant) selectable in 1 click with 100% lossless content preservation.
2. **Premium Marketplace Themes (`paid_once`):** Code-reviewed themes in `apps/web/src/themes/premium/<theme-id>` purchasable per website via AutoLaris QRIS/VA (with coupons, numbered PDF receipts, and affiliate commission support).
3. **Bespoke Client/Agency Themes (`custom`):** Code-reviewed themes in `apps/web/src/themes/custom/<theme-id>` granted to specific tenants or agencies via `console.punyasitus.com`.

### 4. First-Party Curated Plugin Architecture (`packages/plugins/<plugin-id>`)

Arbitrary `.zip` upload, runtime `eval`, and unreviewed third-party code execution remain strictly forbidden. Every plugin is a TypeScript package in `packages/plugins/<plugin-id>` exporting a validated `PluginManifest` with five bounded extension slots:

1. **Isolated `TenantStore` Tables (`plg_<id>__*`):** Optional additive SQLite migrations tracked in `_plugin_migrations` inside `TenantStore`, executed **only** for tenants that activate the plugin, guarded by the same pre-migration PITR bookmark in `PLATFORM_DB.migration_bookmarks` (`ADR-0009`). Disabling or expiring a plugin preserves its `plg_*` rows read-only until full tenant purge (`H+45`).
2. **Public `<head>` Discovery, Section, Widget & Declared Sub-Route Slots:** Plugins may register typed section blocks, shell widgets (e.g., floating rotator CTA), declared public sub-routes (e.g., `/link`), or the single exclusive `<head>` & discovery provider slot (`/sitemap.xml`, `/robots.txt`, `/[indexnowKey].txt`, Open Graph, Schema.org `@graph` — owned by the official free `seo-ai-autopilot` plugin under `DEC-039` so themes never collide on `<head>` tags), all bound by the global `<= 25 KiB` gzipped public JS budget (`REQ-040`). When `seo-ai-autopilot` is not installed on a site, the base shell emits only minimal `<title>` + mandatory `trial`/`suspended` `noindex` headers and hides all SEO editor fields.
3. **Admin Settings & Scoped JSON API Slots:** Mounted at `/dashboard/{handle}/plugins/{pluginId}` (`shadcn/ui` `base-nova`) and `/api/tenants/{tenantId}/plugins/{pluginId}/**`, automatically wrapped by host isolation, Better Auth RBAC, CSRF/Origin checks, `PLATFORM_DB` plugin entitlement verification, and subscription lifecycle gates (`locked` = read-only, `suspended` = blocked).
4. **Fault-Isolated Async Hooks & Verified Bot Webhooks:** Queue-dispatched domain events (`lead.created`, `offering.published`, `post.published`, `cron.daily`) with per-plugin timeouts and retry ledger entries so a plugin failure (e.g., external webhook or Telegram timeout) never rolls back or slows core CMS writes, plus an optional secret-verified platform callback route (`/api/plugins/{pluginId}/webhook` on `app.punyasitus.com`) for 1-click bot linking (such as `@PunyaSitusNotifBot` `/start <one_time_token>` in `lead-notifier`).
5. **Optional MCP Tools:** Read/draft/publish tools automatically exposed on `/mcp` (`ADR-0008`) only when both the tenant's plugin entitlement and OAuth scopes allow.

### 5. Dedicated Sidebar Surfaces & Symmetric 3-Tier Commercial Model (`Free` / `Paid Store` / `Custom Dev`)

To stay familiar to WordPress users while keeping the workspace clean, minimalist, and conversion-focused:
- **`Tema` (Themes) and `Plugin` (Plugins) are dedicated top-level sidebar menus** in `/dashboard/{handle}`, acting as both functional workspaces and first-class upsell storefronts. Installed plugins render their configuration screens strictly inside `/dashboard/{handle}/plugins/{pluginId}` — plugins NEVER inject arbitrary top-level sidebar menus.
- Both `Tema` and `Plugin` expose the **exact same three commercial tiers** managed on `console.punyasitus.com`:
  1. **Gratis / Bawaan (`included` themes & `public_free` plugins):** Included or 1-click installable.
  2. **Berbayar / Store (`paid_once` themes & `paid_once` / `paid_monthly` / `paid_yearly` plugins):** Self-serve purchase via AutoLaris QRIS/VA (or agency payer under `REQ-083`), issuing numbered PDF receipts (`REQ-081`) and affiliate commissions (`REQ-085`).
  3. **Custom Dev (`custom` themes & `private_client` plugins + `custom_theme` / `custom_plugin` Service Request Flow):** Owners and agencies can request bespoke theme design or bespoke plugin development directly from the `Tema -> Custom Dev` or `Plugin -> Custom Dev` tab (reusing the `service_packages` / `service_requests` workflow of `REQ-063` with `service_kind = "custom_plugin"`). Once built in `themes/custom/*` or `packages/plugins/*` and granted in `console.punyasitus.com`, the custom deliverable unlocks for that client without modifying Frozen Core CMS code — and any broadly useful plugin can later be promoted to the public store via console metadata.

## Consequences

- **Positive:** Bespoke client projects (custom theme + custom feature plugin) never pollute the core CMS; new revenue streams open via Premium Themes and Paid Add-on Plugins; zero WordPress-style plugin vulnerabilities or CWV bloat; single 3-second Worker deploy updates the entire fleet.
- **Negative / Trade-offs:** Every new bespoke theme or plugin requires a Git PR, automated CI checks, and a Worker deploy (`~3s`, zero downtime) rather than runtime `.zip` upload — an intentional trade-off that preserves security, type safety, and speed.
