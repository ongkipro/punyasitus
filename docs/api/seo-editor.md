# SEO Editor Controls & Webmaster Verification API Contract (`TASK-052`, `REQ-053`, `REQ-055`)

All endpoints live on the authenticated `app` surface (`app.punyasitus.com`) and enforce:

- Host isolation (tenant, marketing, and console hosts return neutral `404`).
- Session verification + lifetime ceiling (`401 UNAUTHENTICATED`).
- CSRF & `Origin` verification on state-changing requests (`POST`, `PATCH`).
- Tenant membership isolation (non-members / cross-tenant selectors return neutral `404`).
- Live lifecycle gate BEFORE any `TenantStore` reads:
  - `purging` / `purged` -> neutral `404`.
  - `suspended` / `recovery` / `operatorHold` -> `403 SUBSCRIPTION_LOCKED`.
  - `locked` -> `GET` allowed (read-only), mutations -> `403 SUBSCRIPTION_LOCKED`.
- Strict JSON body parsing (`<= 64 KiB`, rejects forbidden selector keys such as `tenantId`, `organizationId`, `userId`, `role`).
- Plugin-active enforcement: all SEO settings, publish, verification-check, and per-resource SEO override mutations return `409 PLUGIN_DISABLED` while `seo-ai-autopilot` is disabled (`POST /seo/toggle` remains callable by Owner/Admin to re-enable it).
- Single canonical plugin-scoped table: `plg_seo_ai_autopilot__settings` (migration `0013_seo_editor_settings.sql`, zero duplicate tables).
- Atomic audit & cache invalidation: every write commits `tenant_activity_log` inside the same atomic `TenantStore` batch; if `PLATFORM_DB.tenants.cache_version` bump fails on publish, toggle, or taxonomy opt-in, the `TenantStore` mutation is compensated/rolled back and the endpoint returns `503 SERVICE_UNAVAILABLE`.
- Private headers on every response: `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`.

### Boundary with Public `<head>` (`TASK-102` / `TASK-053`)
`TASK-052` owns validated SEO editor persistence (`plg_seo_ai_autopilot__settings` + per-resource draft/published SEO snapshots), strict APIs, admin UI, and pure emitters (`renderVerificationMetaTags()`, `resolveEffectiveSeoPreview()`, `resolvePublishSafeSchemaType()`). Public `<head>` integration in `SEOHead.astro` is wired by `TASK-102` (and entity JSON-LD integration by `TASK-053`).

---

## 1. Global Search Appearance & Verification Settings

### `GET /api/tenants/:tenantId/seo/settings`
- **Permission:** `content:read` (Owner, Admin, Editor, Agency Admin)
- **Response `200`:** Returns `settings` containing:
  - `draft` and `published` `searchAppearance` (`separator` + 9 kind templates) and `verificationTokens` (`google`, `bing`, `yandex`)
  - `version` (atomic OCC counter), `hasUnpublishedChanges`, `seoAutopilotEnabled`
  - `verificationStatuses`: per-provider resolved status (`not_configured` | `configured` | `externally_verified` | `recheck_required`) evaluated against current verified `primaryHost`
  - `publishedVerificationMetaTags`: escaped fixed `<meta>` tags
  - `sitemapUrl`, `directoryListingCopyText`

### `PATCH /api/tenants/:tenantId/seo/settings`
- **Permission:** `settings:write` (Owner / Admin / Agency Admin; Editor -> `403 FORBIDDEN`)
- **Request Body (`.strict()`):**
  - `separator?`: `"-" | "|" | "–" | "—" | "·" | "•" | ":" | "/" | "»"`
  - `templates?`: partial map of `{ homepage, page, post, catalog_item, post_category, post_tag, catalog_category, blog_index, catalog_index }` -> `{ titleTemplate, descriptionTemplate }`
    - Only the 7 fixed tokens are allowed: `{{title}}`, `{{site_name}}`, `{{tagline}}`, `{{sep}}`, `{{category}}`, `{{excerpt}}`, `{{page}}`. Unknown tokens, unbalanced braces, or HTML/script tags return `422 VALIDATION_ERROR`.
  - `verification?`: `{ google?: string | null, bing?: string | null, yandex?: string | null }`
    - Plain content-attribute tokens only (Google: `/^[A-Za-z0-9._-]{10,128}$/`, Bing: `/^[A-Za-z0-9]{16,64}$/`, Yandex: `/^[A-Za-z0-9]{8,64}$/`). Raw `<meta>` tags, quotes, angle brackets, or script payloads return `422 VALIDATION_ERROR`.
  - `version` / `expectedVersion`: required positive integer (`409 VERSION_CONFLICT` on stale write).
- **Draft Privacy:** Mutates `draft_json` only; `published_json` remains untouched until `POST /publish`.

### `POST /api/tenants/:tenantId/seo/publish`
- **Permission:** `settings:write` (Owner / Admin / Agency Admin; Editor -> `403 FORBIDDEN`)
- **Request Body (`.strict()`):** `{ version | expectedVersion }`
- **Effect:** Atomically promotes `draft_json` -> `published_json`, resets external verification for any provider whose token changed, syncs Google/Bing tokens into `site_settings_grouped` when present, bumps `PLATFORM_DB.tenants.cache_version`, and logs `seo.settings.published`.

### `POST /api/tenants/:tenantId/seo/verification-check`
- **Permission:** `settings:write` (Owner / Admin / Agency Admin; Editor -> `403 FORBIDDEN`)
- **Request Body (`.strict()`):** `{ provider: "google" | "bing" | "yandex", verifiedHost: string, note?: string | null, version | expectedVersion }`
- **Invariants:**
  - `verifiedHost` must exactly match the tenant's current verified `primaryHost` (`422 HOST_MISMATCH` otherwise).
  - Provider token must already be published (`422 TOKEN_NOT_PUBLISHED` otherwise).
  - If the tenant later changes `primaryHost`, status automatically degrades to `recheck_required`.

### `POST /api/tenants/:tenantId/seo/toggle`
- **Permission:** `settings:write` (Owner / Admin / Agency Admin; Editor -> `403 FORBIDDEN`)
- **Request Body (`.strict()`):** `{ enabled: boolean }`
- **Effect:** Enables or disables `seo-ai-autopilot` in `installed_plugins` while preserving all saved templates, tokens, and per-resource SEO overrides.

---

## 2. Per-Resource SEO Preview, Checklist & Overrides

### `GET /api/tenants/:tenantId/seo/resources/:kind/:resourceId`
- **Permission:** `content:read`
- **Path `:kind`:** `page` | `post` | `offering` | `taxonomy`
- **Response `200`:** Returns `seo` state with:
  - `draftSeo`, `publishedSeo`, `version`, `seoAutopilotEnabled`
  - `allowedSchemaTypes` (computed from resource kind + visible facts)
  - `preview`: effective title/description, read-only canonical URL, effective robots meta, indexability reasons, inherited-vs-overridden field states, social preview (`summary_large_image`)
  - `checklist`: non-blocking advisory items (`"x dari y saran terpenuhi"`, zero numeric score) including focus keyphrase checks, duplicate title/description warnings, and keyphrase cannibalization warnings across published resources of the same tenant.

### `PATCH /api/tenants/:tenantId/seo/resources/:kind/:resourceId`
- **Permission:** `content:write` (Owner, Admin, Editor, Agency Admin; `locked` -> `403 SUBSCRIPTION_LOCKED`)
- **Request Body (`.strict()`):**
  - For `page` | `post` | `offering`: `{ seo: { titleOverride?, descriptionOverride?, focusKeyphrase?, ogTitleOverride?, ogDescriptionOverride?, ogImageMediaId?, schemaType?, noindex?, nofollow? }, version | expectedVersion }`
    - Rejects arbitrary canonical, robots.txt, script, or custom JSON-LD fields (`422`).
    - Rejects disallowed `schemaType` per kind (`FAQPage` requires visible FAQ block; `Product` requires visible fixed/from price; `TouristTrip` requires visible itinerary).
    - Rejects `ogImageMediaId` not owned by the tenant or not `kind = 'image' AND status = 'ready'` (`422`).
    - Draft isolation: on published resources, updates ONLY draft snapshot; published snapshot stays unchanged until resource publish.
  - For `taxonomy`: `{ indexOptIn: boolean, version | expectedVersion }`
    - Empty taxonomies remain effectively `noindex` even when `indexOptIn = true`.
