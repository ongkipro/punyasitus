# First-Party Modular Plugin Development Guide

> Audience: developers and AI agents building reusable add-on plugins or client-specific functional features on PunyaSitus without modifying the Frozen Core CMS.
> Contracts this guide follows: `ADR-0010`, `DEC-037`, `PRD.md` `REQ-097..099`, `PLAN.md` §19.7, `DESIGN.md` §1, and `ADR-0009`.
> Status: target workflow. The plugin runtime and store are built by `TASK-097`, `TASK-098` and `TASK-099`.

## 1. Golden Rule: Frozen Core, Pluggable Features

When a client project (or internal roadmap) needs a new functional capability — such as multi-agent WhatsApp CS rotation, a `/link` bio page, appointment booking, Google Sheets / CRM lead sync, custom calculators, or QR table menus:

1. **NEVER add tenant-specific `if` branches, bespoke tables, or custom endpoints into `packages/core`, `packages/db`, `packages/auth`, or `apps/web/src/core`.**
2. Build the visual design as a **Theme** (`docs/themes/THEME-DEVELOPMENT.md`) and build the functional capability as a **Plugin** under `packages/plugins/<plugin-id>/`.
3. Start client-specific plugins from a **`Plugin -> Custom Dev` (`service_kind = "custom_plugin"`)** request as `visibility: "private_client"` (granted only to that client or agency in `console.punyasitus.com/plugins`, surfaced under their `Plugin -> Custom Dev` sidebar tab, and configured strictly inside `/dashboard/{handle}/plugins/<plugin-id>` without ever injecting top-level sidebar clutter). Whenever the feature proves broadly useful, promote it in the console to `public_free` or `public_paid` (`paid_once`, `paid_monthly`, `paid_yearly`) with zero code changes!

## 2. Folder Layout

```text
packages/plugins/<plugin-id>/
  package.json          @punyasitus/plugin-<plugin-id>
  src/
    manifest.ts         validated PluginManifest (id, version, slots, permissions, schemas)
    migrations/         optional additive SQLite migrations (MUST only touch plg_<id>__* tables)
    server/
      handlers.ts       tenant-scoped JSON API handlers (/api/tenants/[tenantId]/plugins/<id>/**)
      webhook.ts        optional secret-verified platform callback (/api/plugins/<id>/webhook, e.g. Telegram /start token)
      hooks.ts          async Queue event handlers (lead.created, offering.published, cron.daily)
      mcp.ts            optional OAuth-scoped MCP tool definitions
    public/
      sections/         optional Astro section components / shell widgets / exclusive <head> & discovery slot (<= 25 KiB global JS cap)
      routes/           optional declared public sub-routes (e.g. /link, or /sitemap.xml & /robots.txt in seo-ai-autopilot)
    admin/
      SettingsIsland.tsx React 19 + shadcn/ui base-nova (@base-ui/react) admin UI
  tests/                unit + two-tenant isolation + inactive-tenant zero-impact tests
```

Every plugin is explicitly registered in `apps/web/src/core/plugin-registry.ts`. Arbitrary `.zip` uploads, remote `import()`, and `eval()` are forbidden.

## 3. Hard Safety & Performance Invariants

1. **Zero Cost When Inactive:** If `tenant_plugin_entitlements` in `PLATFORM_DB` does not mark `<plugin-id>` active for the current tenant, the runtime executes **zero** plugin migrations, **zero** plugin SQL queries, mounts **zero** public routes/sections/scripts, and returns `404`/`403` on `/dashboard/{handle}/plugins/<id>` and `/api/tenants/{tenantId}/plugins/<id>/**`.
2. **Namespace-Locked SQLite Tables (`plg_<id>__*`):**
   - A plugin receives a restricted `TenantStore` wrapper whose migration runner rejects any DDL touching tables outside `plg_<snake_id>__*` and tracks versions in `_plugin_migrations`.
   - Before applying a new plugin migration to a tenant's `TenantStore`, the Worker records a PITR bookmark in `PLATFORM_DB.migration_bookmarks` (`ADR-0009`).
   - Disabling a plugin or letting a recurring add-on expire **never drops** `plg_*` tables; data remains intact for re-activation until full website purge (`H+45`).
3. **Fault-Isolated Hooks:** Event hooks (`lead.created`, `offering.published`, `post.published`, `cron.daily`) run asynchronously via Cloudflare Queues with per-plugin timeouts and idempotency keys. A failing webhook or plugin bug never blocks visitor form submission or CMS publishing.
4. **UI & Public Budget Compliance:**
   - Admin islands MUST use `shadcn/ui` style `base-nova` (`@base-ui/react` only, `render` prop composition, zero `@radix-ui/*` or `asChild`, Bahasa Indonesia copy).
   - Public sections/widgets/routes render server-first Astro HTML inside the shared SEO/CSP shell and MUST keep total public first-party JS `<= 25 KiB` gzipped (`REQ-040`).
5. **Payer & Lifecycle Enforcement:**
   - On `locked` (`H+4..H+7`) websites, plugin admin APIs reject mutations with `403 SUBSCRIPTION_LOCKED` while keeping already-published public widgets live if included in an active entitlement.
   - On `suspended` (`H+8+`) websites, all plugin public and admin routes follow the tenant's `503` / recovery lock.
   - On agency-managed websites (`REQ-083`), paid plugin purchases and renewals route exclusively through the owning agency's billing portal.
