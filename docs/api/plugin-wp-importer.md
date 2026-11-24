# Official Free Plugin: `wp-importer` (`TASK-100`, `REQ-100`, `DEC-038`, `ADR-0010`)

> Companion API & security contract for `packages/plugins/wp-importer`. Core OpenAPI (`docs/api/openapi.json`) remains owned by `TASK-024`; the Frozen-Core Plugin Runtime contract lives in `docs/api/plugins.md`.

## 1. Plugin Manifest & Frozen-Core Isolation

| Property | Value |
|---|---|
| Plugin ID (`slug`) | `wp-importer` |
| Tier / Visibility | `public_free` (`billingCycle: "free"`, `priceIdr: 0`) |
| Default on Provision | **No** (installed on demand via `Plugin -> Gratis`, NOT in `DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS`) |
| Table Prefix (`ADR-0010`) | `plg_wp_importer__` (`plg_wp_importer__jobs`, `plg_wp_importer__url_map`, `plg_wp_importer__staged_drafts`) |
| Public JS Budget (`REQ-040`) | `0` bytes (`maxPublicJsBytes: 0`; zero public routes or scripts) |
| Registry Registration | Statically registered in `apps/web/src/core/plugin-registry.ts` (`REGISTERED_FIRST_PARTY_PLUGINS`) |
| Frozen Core Edits | **Zero** (`packages/core`, `packages/db`, `packages/auth`, `apps/web/src/pages`, `apps/web/src/middleware` untouched) |

## 2. Default Runtime Persistence & Fail-Closed Behavior

`WP_IMPORTER_PLUGIN` wires real default production adapters (`packages/plugins/wp-importer/src/adapters.ts`) without modifying Frozen Core:

- **`createDefaultCmsWriter()`:** Resolves the tenant's isolated `TenantStore` via `cloudflare:workers` `env.TENANT_STORE` (or injected `tenantDb`) and writes real unpublished `draft` records using `@punyasitus/db/posts/index` (`createBlogTaxonomy`, `createPost`) — strictly `status = 'draft'`, `published_at = NULL`, `published_body_json = NULL`.
- **`createDefaultMediaPort()`:** Resolves `env.TENANT_STORE` + `env.MEDIA_BUCKET` (`R2Bucket`), atomically reserves and finalizes **100% of written R2 bytes** (master + any distinct variant objects) against `storage_usage.quota_bytes` via `@punyasitus/db/media/index` (`createMediaUploadIntent`, `markUploadIntentQuarantinedAndCreateMedia`, `finalizeProcessedMediaAtomically`), and compensates on any failure by deleting uploaded R2 keys and calling `failMediaUploadIntent` (releasing `reserved_bytes`).
- **Fail-Closed Guarantee (Zero Fake Success):**
  - If `POST /import` executes without an available CMS writer (neither default `TENANT_STORE` nor injected `cmsWriter`, and `allowStagedFallback` is not explicitly opted in), the job fails closed with `503 CMS_WRITER_UNAVAILABLE` and records a `failed` job row in `plg_wp_importer__jobs`.
  - If `MEDIA_BUCKET` is unavailable when `importImages: true`, images emit explicit `MEDIA_STORAGE_UNAVAILABLE` (`status: "skipped"`) warnings and `imagesImported` stays `0` — images are never falsely marked imported.
- **Durable Job Lifecycle & Compact `report_json`:**
  - Every `/dry-run` or `/import` inserts `plg_wp_importer__jobs` with `status = 'running'` **before** fetching or writing external/CMS/R2 resources, then transitions it to `completed`, `completed_with_warnings`, or `failed` (with `error_code` / `error_message`).
  - Persisted `plg_wp_importer__jobs.report_json` stores compact summary metadata (`blockCount`, counts, warnings, media, former-URL mappings) and drops bulky TipTap `sanitizedBody` trees so 100-post imports never bloat SQLite rows.

## 3. Hard Safety & Quota Invariants

1. **Strictly Draft-Only (`status = 'draft'`, `published_at = NULL`, `published_body_json = NULL`):**
   - Imported WordPress posts NEVER auto-publish, even when source WordPress status is `publish`, `future`, or `private`.
   - Former-URL mappings (`sourcePath` -> `/blog/<targetSlug>`) persist in `plg_wp_importer__url_map`.
2. **SSRF Guard (Base URL, REST Pagination, Images, and Every Redirect Hop):**
   - Strictly `https:` only on tenant HTTP API endpoints (`allowHttp` is rejected with `422 VALIDATION_ERROR` in client request payloads).
   - Rejects embedded credentials (`user:pass@host`), non-standard ports, single-label internal hosts (`metadata`, `redis`), `localhost`, `*.local`, `*.internal`, `*.localhost`, `*.home.arpa`, and wildcard DNS-rebinding domains (`.nip.io`, `.sslip.io`, `.xip.io`, `.localtest.me`, `.lvh.me`).
   - Blocks ALL private, loopback, link-local, metadata, CGNAT, multicast, broadcast, and reserved IPv4 ranges (`0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` incl. `169.254.169.254`, `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `240.0.0.0/4`) across dotted-quad, decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and shorthand (`127.1`) forms.
   - Blocks non-global IPv6 (`::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `::ffff:0:0/96` both dotted & hex, NAT64, 6to4, Teredo).
   - Fetches with `redirect: "manual"`, max 3 hops, re-validating every `Location` target (`422 SSRF_REDIRECT_BLOCKED`), and maps stream/fetch aborts cleanly to `504 FETCH_TIMEOUT`.
   - *Workers DNS boundary:* Cloudflare Workers `fetch()` does not expose pre-connect DNS resolution to JS; DNS-rebinding egress from arbitrary public domains to private IPs is bounded by the Workers egress sandbox.
3. **XML Bomb & XXE Guard (WXR XML Uploads):**
   - Enforces hard payload size cap (`5 MiB`), element count cap (`50,000`), total `<item>` cap (`2,000`), attachment cap (`500`), and post count cap (`100`) using a strict linear `O(n)` scanner with monotonic CDATA cursor caching.
   - Rejects `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION` (`422 WXR_XXE_FORBIDDEN`) and unknown custom XML entity references (`422 WXR_ENTITY_EXPANSION_FORBIDDEN`).
4. **HTML -> Sanitized TipTap JSON (`RestrictedRichTextDoc`):**
   - Loops dangerous-tag stripping until fixed point (defending against `<scr<script>ipt>`) before core state-machine HTML sanitization; strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, `<style>`, `<form>`, Gutenberg comments, shortcodes, `on*` handlers, and `javascript:`/`vbscript:`/`data:` URLs.
   - Preserves headings (`h1`->`h2`, `h2..h4`, `h5..h6`->`h4`), paragraphs, ordered/unordered lists, blockquotes, safe HTTPS links, and imported tenant `/media/<id>` image blocks + bounded Yoast/RankMath SEO metadata.
5. **Media Magic-Byte Validation, RIFF/WEBP Inspection & Tenant Storage Quota:**
   - Sniffs real magic bytes (JPEG, PNG, WebP, GIF) via `inspectImageBinary`; rejects SVG, HTML, JS, PHP, PE/ELF/Mach-O/shebang executables, ZIP/JAR, BMP, AVIF, and video streams.
   - Normalizes images to verified `image/webp` (`RIFF....WEBP`, metadata stripped, `<= 2 MB`) via `env.IMAGES` / encoder. When no encoder is bound, source WebP pass-through is permitted **only** after `inspectWebpContainerSafety()` verifies zero `EXIF`/`XMP ` chunks, zero VP8X metadata flags, and zero trailing polyglot bytes past `riffSize + 8`.
   - Enforces tenant storage quota (`usedBytes + reservedBytes + totalWrittenBytes <= quotaBytes`) BEFORE every R2 write; quota-exceeding images fail safely with `STORAGE_QUOTA_EXCEEDED`.

## 4. Slot-3 Plugin Admin API Endpoints

All endpoints run on `app.punyasitus.com` behind the Frozen-Core plugin runtime (`REQ-097`): session auth, tenant membership isolation (neutral `404` cross-tenant), RBAC (`content:read` for `GET`, `settings:write` for `POST`), CSRF/Origin validation, live lifecycle gating (`locked` -> `403 SUBSCRIPTION_LOCKED` on mutations), and `PLATFORM_DB` entitlement verification.

### `GET /api/tenants/:tenantId/plugins/wp-importer/status`
Returns plugin status, `draftOnlyEnforced: true`, hard limits (`WP_IMPORTER_LIMITS`), and up to 5 recent jobs from `plg_wp_importer__jobs`.

### `GET /api/tenants/:tenantId/plugins/wp-importer/jobs?limit=20`
Lists import & dry-run job history rows (`running` | `completed` | `completed_with_warnings` | `failed`) from `plg_wp_importer__jobs`.

### `GET /api/tenants/:tenantId/plugins/wp-importer/jobs/:jobId`
Returns single job metadata, parsed compact `report`, and associated `plg_wp_importer__url_map` rows (`404 NOT_FOUND` if missing).

### `GET /api/tenants/:tenantId/plugins/wp-importer/url-map?jobId=...&limit=100`
Lists the former-URL inventory (`sourceUrl`, `sourcePath`, `sourceSlug`, `targetSlug`, `targetPath`, `targetPostId`, `sourceStatus`, `importedStatus: "draft"`).

### `POST /api/tenants/:tenantId/plugins/wp-importer/dry-run`
Runs full SSRF/XXE/HTML/media/quota inspection without creating CMS posts or writing R2 objects. Persists a `dry_run` job record and former-URL preview rows in `plg_wp_importer__*`.

- **Allowed Request Body Fields (Strict):** `{ sourceKind: "wp_json" | "wxr", siteUrl?: string, wxrXml?: string, importImages?: boolean, maxPosts?: 1..100 }` (unknown fields including `allowHttp` return `422 VALIDATION_ERROR`).
- **200 Response:** `{ "report": WpImportReport }`
- **Error Codes:** `413 WXR_TOO_LARGE` / `RESPONSE_TOO_LARGE`, `422 VALIDATION_ERROR` / `SSRF_BLOCKED` / `SSRF_REDIRECT_BLOCKED` / `WXR_XXE_FORBIDDEN` / `WXR_ENTITY_EXPANSION_FORBIDDEN` / `WXR_MALFORMED` / `WP_JSON_INVALID`, `502 FETCH_FAILED`, `503 CMS_WRITER_UNAVAILABLE`, `504 FETCH_TIMEOUT`.

### `POST /api/tenants/:tenantId/plugins/wp-importer/import`
Executes the draft-only WordPress import using the same strict payload schema, writing real unpublished draft blog posts, taxonomies, and quota-checked R2 WebP assets via the default (or injected) adapters and recording job history + former-URL inventory in `plg_wp_importer__*`.
