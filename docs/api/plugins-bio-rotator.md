# Official Launch Seed Plugins API Contract: `bio-links` & `wa-cs-rotator` (`TASK-099`, `REQ-099`, `ADR-0010`)

> Companion specification to `docs/api/plugins.md` and `docs/api/plugin-store.md`. Core platform OpenAPI (`docs/api/openapi.json`) remains untouched and drift-free (`tests/task-024/unit.test.ts`).
>
> Both plugins live strictly inside `packages/plugins/bio-links/**` and `packages/plugins/wa-cs-rotator/**` and are statically registered in `apps/web/src/core/plugin-registry.ts` with **zero edits to Frozen Core CMS packages**.

## 1. `bio-links` (`public_free`, Zero-JS `/link` Page)

- **Plugin ID:** `bio-links`
- **Tier / Billing:** `public_free` (`free`, `priceIdr = 0`)
- **Table Namespace (`TenantStore`):** `plg_bio_links__*`
  - `plg_bio_links__config` — single-row bio profile (`id = 1`: display name, headline, bio text, avatar URL, hex accent, optional WhatsApp CTA settings)
  - `plg_bio_links__items` — ordered bio links (`id`, `label`, `url`, `subtitle`, `badge`, `sort_order`, `is_active`, `click_count`)
  - `plg_bio_links__clicks_daily` — first-party daily click counters (`link_id`, `day_bucket` in `Asia/Jakarta` `YYYY-MM-DD`, `click_count`; zero PII, zero cookies)
- **Public JS Budget:** `0` bytes (`maxPublicJsBytes: 0`; emits zero `<script>` tags and zero inline JS handlers).

### Public Routes (Slot 2)
- `GET /link`: Renders the tenant's mobile-first semantic HTML+CSS bio page (`0` bytes client JS) with active links pointing to `/link/go?id={linkId}` and optional WhatsApp button. Rejects backslashes (`/\evil.com`) and unsafe schemes in avatar/link URLs at both write and render time. Returns `404` when plugin is unentitled or disabled (zero `TenantStore` queries when unentitled).
- `GET /link/go?id={linkId}`: Verifies `{linkId}` exists and is active in the resolved tenant's `plg_bio_links__items`, re-validates stored URL against the strict allowlist (`https:`, `http:`, `tel:`, `mailto:`, `wa.me`), rejects open-redirect query parameters (`?url=`, `?target=`, `?next=`, `?redirect=`) with `400`, skips counting on `HEAD` or browser prefetch/prerender headers (`Purpose`, `Sec-Purpose`, `X-Purpose`, `X-Moz`), atomically increments `click_count` + `plg_bio_links__clicks_daily`, and renders a `0`-JS handoff page.
- `handleBioLinkClickRedirect` (`/api/plugins/bio-links/click?id={linkId}`): First-party HTTP `302 Found` (`GET`) or `200 OK` JSON (`POST`) click recorder with strict tenant ownership, open-redirect rejection (`400 OPEN_REDIRECT_REJECTED`), prefetch/HEAD skip, `Referrer-Policy: no-referrer`, and `Cache-Control: private, no-store`.

### Scoped Admin JSON API (Slot 3: `/api/tenants/{tenantId}/plugins/bio-links/...`)
All routes inherit Slot 3 host isolation (`app.punyasitus.com`), auth, CSRF/Origin, RBAC (`content:read` for GET, `settings:write` for mutations), and lifecycle locks (`locked` -> `403 SUBSCRIPTION_LOCKED`). Unsupported HTTP methods on known subpaths return `405 Method Not Allowed` with an `Allow` header.

| Method & Subpath | Purpose |
| --- | --- |
| `GET /overview` | Returns bio profile, ordered links, and first-party click statistics (`publicJsBytes: 0`). |
| `GET /profile`, `PUT /profile`, `PATCH /profile` | Reads or updates `plg_bio_links__config`. Preserves omitted optional fields (`avatarUrl`, `whatsappMessage`) on partial updates; validates accent hex, avatar URL (rejecting backslashes/`//`), and Indonesian WA phone. |
| `GET /links`, `POST /links` | Lists or creates a bio link (strict URL allowlist: `https:`, `http:`, `tel:`, `mailto:`, `wa.me`; rejects `javascript:`, `data:`, `vbscript:`, `file:`, `//`). |
| `PATCH /links/{linkId}` | Updates label, URL, subtitle, badge, sort order, or active flag (`404` if not owned by tenant). |
| `DELETE /links/{linkId}` | Deletes a bio link and its daily counter rows (`404` if not owned by tenant). |
| `POST /links/reorder` | Atomically reorders links via `db.batch` by `{ orderedIds: string[] }`. |
| `GET /stats` | Returns total links, active links, total clicks, top link ID, and daily buckets (zero PII). |
| `POST /click` | Admin-only `POST` click recorder (`GET` returns `405 Method Not Allowed`). |

---

## 2. `wa-cs-rotator` (`public_paid` / Operator-Grantable, Multi-Agent WhatsApp Rotator)

- **Plugin ID:** `wa-cs-rotator`
- **Tier / Billing:** `public_paid` (`paid_monthly`, `priceIdr = 49000`, or operator/agency grant via `TASK-098`)
- **Table Namespace (`TenantStore`):** `plg_wa_cs_rotator__*`
  - `plg_wa_cs_rotator__agents` — sales agents (`id`, `name`, `role_label`, `phone_e164`, `weight` `1..100`, `schedule_days`, `start_time`, `end_time`, `timezone`, `is_active`, `sort_order`, `total_clicks`)
  - `plg_wa_cs_rotator__state` — single-row authoritative rotation state (`id = 1`: `strategy` `round_robin | weighted`, monotonic `cursor_index`, `weighted_state_json`, `fallback_whatsapp_phone`, `timezone`, `fallback_clicks`, `last_agent_id`, `state_version` OCC CAS counter)
  - `plg_wa_cs_rotator__clicks` — 90-day bounded raw attribution log (`id`, `agent_id`, `target_phone_e164`, `was_fallback`, `strategy_used`, `source_path` stripped of query/fragments, `day_bucket`, `clicked_at`; zero visitor PII; auto-pruned past 90 days)
  - `plg_wa_cs_rotator__clicks_daily` — compact permanent daily click totals (`agent_key`, `day_bucket`, `click_count`)
- **Public JS Budget:** `0` bytes (`maxPublicJsBytes: 0`, strictly `<= 25 KiB`).

### Rotation, Concurrency & Lifecycle Semantics
- **Single Source of Truth & OCC Concurrency:** `plg_wa_cs_rotator__state` is the single source of truth for `strategy`, `fallback_whatsapp_phone`, `timezone`, `cursor_index`, and `weighted_state_json`. Both rotation clicks and `PUT /settings` use optimistic compare-and-set (`WHERE id = 1 AND state_version = ?`, up to 5 retries) so concurrent traffic never assigns the same agent twice or loses cursor increments.
- **Active-Hour Schedules:** Evaluates each active agent's weekday set (`0=Sun..6=Sat`, rejecting malformed empty segments like `"1,,2"`) and `HH:MM` window in their IANA timezone (default `Asia/Jakarta` WIB), supporting daytime shifts (`08:00-17:00`), overnight shifts (`22:00-06:00`), and 24-hour shifts (`00:00-24:00`).
- **Round-Robin (`round_robin`):** Advances persistent `cursor_index` across deterministically ordered on-shift agents.
- **Weighted (`weighted`):** Deterministic Smooth Weighted Round-Robin (Nginx SWRR) persisted in `weighted_state_json`, yielding exact weight proportions without clumping.
- **Off-Shift Fallback & Frozen-Core `PluginPublicRouteContext` Resolution Order:** When zero agents are active/on-shift, `/wa-rotator` resolves the fallback WhatsApp number in strict precedence order without breaking Frozen-Core `PluginTenantDb` isolation:
  1. Host-supplied primary WhatsApp (`tenant.whatsappE164` / `tenant.primaryWhatsappPhone` on extended tenant snapshot, or explicit `primaryWhatsappPhone` argument),
  2. Persisted plugin state `plg_wa_cs_rotator__state.fallback_whatsapp_phone` (saved via `PUT /settings`),
  3. `config.primaryWhatsappPhone`,
  4. `config.fallbackWhatsappPhone`,
  5. Base `TenantStore.business_profile.whatsapp_e164` via `readTenantPrimaryWhatsappFromStore(ctx.tenantDb)` when the host supplies an unrestricted `tenantDb` handle.
  If none is configured yet, `/wa-rotator` degrades gracefully to a `0`-JS HTTP `200` off-hours card (`renderWaRotatorUnavailableHtml`) with a link back to `/` (`Kembali ke Situs Utama`) and zero uncaught exceptions.
- **HEAD / Prefetch & Zero-PII Guards:** Skips cursor & click mutations on `HEAD` and browser prefetch headers (`Purpose`, `Sec-Purpose`, `X-Purpose`, `X-Moz`); strips query strings/fragments from `source_path`; caps `/wa-rotator?item=...` to `120` chars with control characters removed.
- **Instant Revert (`REQ-014`):** When `wa-cs-rotator` is disabled or unentitled (`resolveWhatsAppCtaWithRotator({ pluginActive: false, ... })`), executes **zero** `plg_wa_cs_rotator__*` queries and immediately returns the single-number base WhatsApp flow while preserving all `plg_wa_cs_rotator__*` tables intact for re-activation.

### Public Slots (Slot 2)
- Section `wa-cs-rotator-cta`: Renders a `0`-JS WhatsApp CTA block with current on-shift count pointing to `/wa-rotator`.
- Route `GET /wa-rotator`: Executes rotation (skipping mutations on `HEAD`/prefetch), records per-agent attribution, and renders a `0`-JS WhatsApp handoff card (`handleWaRotatorPublicRedirect` provides HTTP `302 Found` direct redirect when used in redirect flows).

### Scoped Admin JSON API (Slot 3: `/api/tenants/{tenantId}/plugins/wa-cs-rotator/...`)

| Method & Subpath | Purpose |
| --- | --- |
| `GET /overview` | Returns persisted rotator state (`strategy`, `fallbackWhatsappPhone`, `timezone`, `stateVersion`), agents (with live `isOnShiftNow`), and attribution stats. |
| `GET /agents`, `POST /agents` | Lists or creates a sales agent (validates Indonesian E.164 phone `08...`/`+628...`, weight `1..100`, `HH:MM` schedule, IANA timezone). |
| `PATCH /agents/{agentId}` | Updates agent details, schedule, weight, or active status (`404` if not owned by tenant). |
| `DELETE /agents/{agentId}` | Removes agent from tenant rotation (`404` if not owned by tenant). |
| `PUT /settings`, `PATCH /settings` | Atomically persists `strategy` (`round_robin` \| `weighted`), `fallbackWhatsappPhone`, `timezone`, and optional `resetCursor: true` via OCC CAS. |
| `GET /stats` | Returns per-agent click counts, share percentages, fallback clicks, and compact daily breakdown (zero PII). |
| `POST /simulate` | Dry-run rotation preview at optional `{ atMs \| atIso }` without mutating cursor or click logs. |
