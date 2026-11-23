# Official Free Zero-Config Plugin: `seo-ai-autopilot` (`TASK-102`, `REQ-102`, `DEC-039`, `DEC-042`)

> Companion API & architecture contract for `packages/plugins/seo-ai-autopilot`. Core OpenAPI (`docs/api/openapi.json`) remains owned by `TASK-024`; SEO editor endpoints live in `docs/api/seo-editor.md`, plugin runtime in `docs/api/plugins.md`, and local entity schema in `docs/api/local-schema-seo.md`.

## 1. Plugin Manifest & Provisioning Contract

| Property | Value |
|---|---|
| Plugin ID (`slug`) | `seo-ai-autopilot` |
| Tier / Visibility | `public_free` (`billingCycle: "free"`, `priceIdr: 0`) |
| Default on Provision (`DEC-042`) | Active by default (`enabled = 1` in `TenantStore.installed_plugins`) — zero owner action required |
| Table Prefix (`ADR-0010`) | `plg_seo_ai_autopilot__` (`plg_seo_ai_autopilot__settings`) |
| Public JS Budget (`REQ-040`) | `0` bytes (`maxPublicJsBytes: 0`) |
| Registry Registration | Statically registered in `apps/web/src/core/plugin-registry.ts` (`REGISTERED_FIRST_PARTY_PLUGINS`) |
| Zero-Config Requirement | `0` mandatory form fields; all discovery, metadata, OG, Schema.org `@graph`, and IndexNow features activate automatically on install |
| Disable Data Preservation | Disabling sets `installed_plugins.enabled = 0` without dropping `plg_seo_ai_autopilot__settings` or deleting saved templates, verification tokens, or per-resource SEO overrides |

## 2. Active vs Disabled Invariant Matrix (`DEC-039`, `REQ-102`)

| Surface / Endpoint | `seo-ai-autopilot` **ACTIVE** (Default / 1-Click `Pasang (Gratis)`) | `seo-ai-autopilot` **DISABLED** (`enabled = 0`) |
|---|---|---|
| Page / Offering / Post Editors | Single collapsed optional drawer (*"SEO & AI Otomatis Aktif — Ubah manual (opsional)"*); 0 fields visible until clicked | **Zero SEO form fields** rendered (`SeoOverrideDrawer` returns `null`) |
| `<SEOHead.astro>` / `<PublicSeoHead.astro>` | Programmatic Blueprint Title/Description, canonical, `< 300 KiB` `1200x630` WhatsApp OG, Twitter Card, Schema.org `@graph`, published verification tags, RSS `<link rel="alternate">` | Minimal `<title>` + mandatory `trial`/`suspended`/`noindex`/`error` `<meta name="robots">` safety meta **ONLY**; **zero** JSON-LD `@graph`, **zero** OG/Twitter expansion |
| `GET /sitemap.xml` & `/sitemaps/*.xml` | `200 application/xml` Sitemap Index & Image Sitemaps (`xmlns:image`) for indexable paid sites (`404` on `trial`/`noindex`, `503` on `suspended`) | **`404`** (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) |
| `GET /robots.txt` | AI-split `robots.txt`: 9 search/answer bots allowed (`Googlebot`, `Bingbot`, `OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`, `Perplexity-User`, `Applebot`), 4 training bots per `aiTrainingPolicy` (`GPTBot`, `ClaudeBot`, `Google-Extended`, `Applebot-Extended`), faceted filter disallows, `Sitemap:` | Clean minimal fallback (`User-agent: *`, `Allow: /`, private path disallows — **no `Sitemap:`**, **no AI bot split**, explicit fresh headers with `Vary: Host, Accept-Encoding`); `trial`/`noindex`/`suspended` retain `Disallow: /` |
| `GET /[indexnowKey].txt` | `200 text/plain` (`Cache-Control: no-store`) exact key on verified active custom domains (stored key or HMAC-SHA-256 keyed tenant-scoped key); `404` on `.situsku.click`, `trial`, unverified, wrong/cross-tenant key, or `suspended` | **`404`** (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) |
| `GET /blog/feed.xml` | `200 application/rss+xml` latest 20 published posts when `blogEnabled === true` | **`404`** (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) |
| Canonical `308` / Alias `301` & `trial`/`suspended` `noindex` | 100% active | **100% intact** (platform safety invariants never depend on optional plugin state) |
| Saved overrides (`plg_seo_ai_autopilot__settings` + resource `seo_json`) | Active and editable | **Preserved intact** (read/write SEO mutations return `409 PLUGIN_DISABLED` until re-enabled) |
| TenantStore DB error (Fail-Closed) | `<SEOHead.astro>` degrades to minimal `<title>` + safety `robots`; `/sitemap.xml`, `/robots.txt`, `/blog/feed.xml` return `503` (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`); `/[indexnowKey].txt` returns `404` (`Cache-Control: no-store`) | Same fail-closed behavior — never fails open |

### Theme Layout Automatic Enforcement (`SEOHead.astro`)
When `seoAutopilotActive` prop is omitted (as in all 6 platform themes `compro`/`sales`/`travel`/`catalog`/`resto`/`dealer` and custom themes), `<SEOHead.astro>` inspects `Astro.locals` (`seoAutopilotEnabled` or `tenantDb` via `checkSeoAutopilotActiveInTenantDb`) and fails closed to `false` on DB error or missing `tenantDb` for a live tenant request. Standalone static renders without a live tenant context default to `true`.

### IndexNow Key Derivation & Security Model
- **Public Domain-Control Proof (Not an Auth Secret):** Per the IndexNow protocol, `https://<primaryCustomDomain>/<key>.txt` is a **publicly fetchable domain-control proof** used by search engines to verify host ownership — it is NEVER an authentication secret or bearer credential.
- **Key Precedence & HMAC-SHA-256 Keying:**
  1. Stored per-tenant cryptographic 32-hex key in `installed_plugins.config_json.indexnowKey` (when persisted by `ensureTenantIndexNowKey`).
  2. Zero-config derived key computed via **HMAC-SHA-256** (`deriveDeterministicTenantIndexNowKey`) keyed by Worker secret `INDEXNOW_KEY_SECRET` (falling back to `BETTER_AUTH_SECRET` / `AUTH_SECRET`, and deterministic domain-separated SHA-256 only in isolated secretless unit tests).
- **Immediate Invalidation:** `200` responses emit `Cache-Control: no-store` so disabling `seo-ai-autopilot` or changing primary domain immediately serves `404` without stale edge cache.

## 3. Plugin Runtime & Admin API Endpoints

All tenant admin APIs execute exclusively on `app.punyasitus.com` (or local loopback in `APP_ENV=local`) and enforce session auth, tenant membership isolation (neutral `404` cross-tenant), RBAC (`settings:write` for mutations; `editor` -> `403 FORBIDDEN`), CSRF/Origin validation, and subscription lifecycle (`locked` -> `403 SUBSCRIPTION_LOCKED`).

### `GET /api/tenants/:tenantId/plugins`
Lists `seo-ai-autopilot` (`visibility: "public_free"`, `priceIdr: 0`, `maxPublicJsBytes: 0`, `tablePrefix: "plg_seo_ai_autopilot__"`).

### `POST /api/tenants/:tenantId/plugins`
1-click `Pasang (Gratis)` install for `{ "pluginId": "seo-ai-autopilot" }`:
- Auto-grants `public_free` entitlement in `PLATFORM_DB.tenant_plugin_entitlements`.
- Runs additive migration `0001_seo_autopilot_settings` (`plg_seo_ai_autopilot__settings`) with pre-migration PITR bookmark.
- Sets `installed_plugins.enabled = 1` and logs `plugin.installed` / `plugin.enabled`.

### `PATCH /api/tenants/:tenantId/plugins/seo-ai-autopilot`
Toggles `{ "enabled": false | true }` or updates optional plugin config (`separator`, `autoIndexNow`):
- Disabling sets `enabled = 0` while preserving `plg_seo_ai_autopilot__settings` and all saved overrides.

### `GET /api/tenants/:tenantId/plugins/seo-ai-autopilot/status`
Scoped Slot-3 plugin API handler returning zero-config autopilot status, saved settings version, `hasSavedOverrides`, `defaultActiveOnProvision: true`, and active capabilities list (strictly scoped to `plg_seo_ai_autopilot__*` via `PluginTenantDb`).

### `POST /api/tenants/:tenantId/seo/toggle`
Dedicated SEO workspace toggle (`{ "enabled": boolean }`) used by `/dashboard/[handle]/plugins/seo-ai-autopilot` that atomically toggles `installed_plugins` + `tenant_activity_log` and bumps `PLATFORM_DB.tenants.cache_version`.

## 4. Programmatic Zero-Config Exports (`packages/plugins/seo-ai-autopilot`)

- `SEO_AI_AUTOPILOT_PLUGIN`, `SEO_AI_AUTOPILOT_MANIFEST`, `SEO_AI_AUTOPILOT_METADATA`, `SEO_AI_AUTOPILOT_MIGRATIONS`
- `generateAutopilotBlueprintMeta()` — programmatic vertical Title & Meta Description from the 7 B2B Blueprints (`REQ-093`)
- `resolveAutopilotWhatsAppOgMetadata()` — `< 300 KiB` `1200x630` WhatsApp-safe OG resolver
- `resolveAutopilotSchemaGraph()` — Schema.org `@graph` plugin gating hook (single engine via `@punyasitus/core/schema-generator`)
- `renderAutopilotSeoHead()` — single `<head>` renderer wired into `<SEOHead.astro>`
- `evaluateAutopilotSitemapGate()`, `buildAutopilotImageSitemapXml()`, `buildAutopilotSitemapIndexXml()`
- `buildAutopilotRobotsTxt()`, `buildMinimalFallbackRobotsTxt()`
- `deriveDeterministicTenantIndexNowKey()`, `resolveAutopilotIndexNowKey()`, `verifyAutopilotIndexNowKeyFile()`, `buildAutopilotIndexNowPing()`, `dispatchAutopilotIndexNowPing()` (injectable `fetchImpl`, defaults to `dryRun: true` when no fetch port is passed)
- `evaluateAutopilotBlogFeedGate()`
- `resolveAutopilotEditorSlot()`, `buildAutopilotDirectoryCopyCard()`, `buildAutopilotPluginDashboardModel()`
