# First-Party Insights API & Schema Contract (`REQ-073`, `TASK-072`)

> Canonical contract owners: `PRD.md` `REQ-073`, `PLAN.md` §7.3 & §18.4, `DESIGN.md` §3.3.

## 1. Privacy-First Invariants

1. **Daily per-tenant aggregates only:** Every insights table resides inside the tenant's physically isolated `TenantStore` SQLite Durable Object and stores coarse aggregate counters only (`day_utc`, `utc_hour`, `content_kind`, `content_id`, `path`, `source_bucket`, `utm_source`, and integer counters).
2. **Zero personal or request identifiers:** No cookies, IP addresses, full `User-Agent` strings, raw referrer paths/query strings, or visitor/session IDs are ever stored.
3. **Bot User-Agent drop:** `POST /api/events` classifies known crawlers, bots, CLI clients (`curl`, `wget`, `python-requests`), and headless scrapers (`HeadlessChrome`, `Playwright`, `Puppeteer`, `Googlebot`, `Bingbot`, etc.) and drops them silently with `204 No Content` before rate-limit or aggregate writes.
4. **24-hour dedup expiry & 90-day aggregate retention:** Per-event `analytics_event_dedup` rows store only `evt:<uuid>` with a strict 24-hour TTL (`expires_at = created_at + 86_400_000`) and bounded opportunistic pruning. Insights aggregate tables (`analytics_content_daily`, `analytics_hourly_utc`, `analytics_sources_daily`) prune rows older than `90` days in bounded batches (`LIMIT 100`) alongside ingestion.
5. **Bounded anonymous cardinality:** Per UTC day per tenant, `analytics_content_daily` caps distinct `path` rows at `200` (overflow folds into `path = "/_other"`, `content_kind = "other"`, `content_id = 0`) and `analytics_sources_daily` caps distinct `utm_source` values at `50` (overflow folds into `utm_source = "_other"`). Personalized/hash `utm_source` tokens (UUIDs, hex hashes `>= 12` chars, or high-digit IDs like `u8f3a9c12b4e` / `sub-48213`) are stripped to `""` while preserving the coarse `campaign` bucket.
6. **Tab-scoped arrival persistence (no cookies):** On public tenant pages (`apps/web/src/scripts/analytics.ts`), an external arrival (`document.referrer` from another host or sanitized `utm_source`/`utm_medium`) is persisted ONLY as coarse metadata in `window.sessionStorage` (`ps_arrival_source_v1`) so subsequent same-site navigations preserve the original arrival source. Same-site checks normalize leading `www.` (`www.example.com` <-> `example.com`) and all tenant host pairs. Plain direct visits write zero `sessionStorage` entries.
7. **Exact 7/30-day windows & dynamic timezone projection:** `analytics_content_daily` and `analytics_sources_daily` are exact 7- or 30-day UTC-day aggregates filtered strictly to `[startDay, endDay]`. Hourly counters are stored in UTC (`day_utc`, `utc_hour` `0..23`), queried with a `±1` UTC day margin, and dynamically projected at read time into `site_settings.timezone` (`Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`, etc.) filtered strictly to `[startDay, endDay]` in the tenant's local calendar. Changing the tenant timezone re-projects peak hours immediately without rewriting stored rows.
8. **Estimate disclosure:** All dashboard overview cards and `/dashboard/{handle}/insights` views prominently state:
   `Estimasi agregat harian tanpa pelacakan individu — sinyal minat, bukan transaksi terkonfirmasi`.

---

## 2. Public Event Ingestion (`POST /api/events`)

Served **only** on verified tenant hosts (`*.situsku.click` or active custom domain); returns `404` on `marketing`, `app`, and `console` surfaces.

### Request Body (JSON, `<= 16 KiB`, `credentials: "omit"`)

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventName": "page_view",
  "path": "/layanan/konsultasi-seo",
  "routeKind": "offering",
  "resourceType": "offering",
  "resourceId": 100,
  "referrerHost": "www.google.com",
  "utmSource": "promo_ramadan",
  "utmMedium": "cpc"
}
```

| Field | Required | Validation & Privacy Rules |
|---|---|---|
| `eventName` / `eventType` | Yes | Closed allowlist: `page_view`, `wa_click`, `external_click`, `lead_submitted` |
| `path` | Yes | Starts with `/`, `<= 200` chars, strictly rejects `?`, `&`, `#`, `..`, emails, phone numbers |
| `eventId` | Optional | Strict lowercase RFC 4122 UUID; deduplicated per tenant for 24h in `analytics_event_dedup` |
| `routeKind` | Optional | `page` \| `post` \| `catalog` \| `offering` \| `taxonomy` \| `other` |
| `resourceType` + `resourceId` | Optional pair | `page` \| `post` \| `offering` + positive integer; verified `status = 'published'` in `TenantStore` |
| `targetKind` + `targetSlug` | Optional | Verified published resource slug when applicable |
| `sourceCategory` | Optional | `direct` \| `search` \| `social` \| `ai_assistant` \| `referral` \| `campaign` |
| `referrerHost` | Optional | Bare lowercase hostname only (no protocol, path, query, or PII); same-site host dropped server-side |
| `utmSource`, `utmMedium` | Optional | `1..50` lowercase chars (`^[a-z0-9][a-z0-9._-]{0,49}$`); emails, phone numbers, query chars rejected (`422`) |

### Source Classification Rules

1. **AI Assistant (`ai_assistant`):** `chatgpt.com`, `chat.openai.com`, `claude.ai`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, or `utm_medium` in `{ai-assistant, ai_assistant}`.
2. **Search (`search`):** `utm_medium = organic` or search engine hostnames (`google.*`, `bing.com`, `duckduckgo.com`, `search.yahoo.com`, `search.brave.com`, etc.).
3. **Campaign (`campaign`):** Any non-AI sanitized `utmSource` or `utmMedium` (preserving coarse `utm_source` token for campaign breakdown).
4. **Social (`social`):** `instagram.com`, `facebook.com`, `fb.com`, `tiktok.com`, `x.com`, `twitter.com`, `t.co`, `linkedin.com`, `youtube.com`, `youtu.be`, `threads.net`, `whatsapp.com`, `wa.me`, `t.me`, etc.
5. **Referral (`referral`):** Any other external hostname.
6. **Direct (`direct`):** No external referrer and no UTM (`Langsung / Tidak Diketahui`).

### Responses

- `204 No Content` (`Cache-Control: no-store`, zero `Set-Cookie`): Accepted, deduplicated replay, rate-limit drop, or bot User-Agent quiet drop.
- `403 Forbidden`: Cross-origin or invalid `Origin`.
- `404 Not Found`: Non-tenant surface.
- `413 Payload Too Large`: Body exceeds `16 KiB`.
- `422 Unprocessable Entity`: PII field, unknown field, invalid `eventId`/`path`/`referrerHost`/`utmSource`, forged `tenantId`, or unpublished/missing resource reference.
- `503 Service Unavailable`: Tenant datastore unavailable (fail-closed).

---

## 3. Authenticated Insights Read API (`GET /dashboard/{handle}/insights/api`)

Served **only** on `app.punyasitus.com` (and explicit local loopback dev).

- **Authentication, Authorization & Lifecycle Gate:** Better Auth `__Host-ps_session` + live `PLATFORM_DB` membership check (`resolveAuthorizedTenantMember`) + `isActionAllowedForTenantStatus(tenantStatus, "analytics:read")` + role permission (`analytics:read` or `content:read`: `owner`, `admin`, `editor`, `agency_admin`).
- **Lifecycle & cross-tenant denial:** Suspended/recovery/purging tenants receive `403 SUBSCRIPTION_LOCKED`; purged tenants and authenticated non-members of `{handle}` receive neutral `404 NOT_FOUND`; unauthenticated requests receive `401 UNAUTHENTICATED`.
- **Headers:** `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `Vary: Cookie`.
- **Query Params:** `range=7` (default) or `range=30`.

### Response `200 OK`

```json
{
  "success": true,
  "insights": {
    "days": 7,
    "startDay": "2026-11-17",
    "endDay": "2026-11-23",
    "timeZone": "Asia/Jakarta",
    "timeZoneLabel": "WIB (Asia/Jakarta)",
    "estimateLabel": "Estimasi agregat harian tanpa pelacakan individu — sinyal minat, bukan transaksi terkonfirmasi",
    "totals": {
      "pageViews": 142,
      "waClicks": 19,
      "externalClicks": 7,
      "leadSubmits": 4,
      "totalInterestSignals": 30,
      "totalActivity": 172
    },
    "popularItems": [
      {
        "contentKind": "offering",
        "contentKindLabel": "Katalog / Penawaran",
        "contentId": 100,
        "path": "/layanan/konsultasi-seo",
        "title": "Konsultasi SEO",
        "pageViews": 60,
        "waClicks": 12,
        "externalClicks": 3,
        "leadSubmits": 2,
        "totalInterestSignals": 17,
        "totalActivity": 77
      }
    ],
    "popularByKind": { "pages": [], "posts": [], "offerings": [] },
    "sources": [
      {
        "bucket": "search",
        "label": "Pencarian",
        "pageViews": 55,
        "waClicks": 8,
        "externalClicks": 2,
        "leadSubmits": 2,
        "totalActivity": 67,
        "sharePercent": 39.0
      }
    ],
    "utmCampaigns": [
      {
        "utmSource": "promo_ramadan",
        "pageViews": 24,
        "waClicks": 5,
        "externalClicks": 1,
        "leadSubmits": 1,
        "totalActivity": 31
      }
    ],
    "peakHours": {
      "timeZone": "Asia/Jakarta",
      "timeZoneLabel": "WIB (Asia/Jakarta)",
      "hours": [{ "hour": 9, "label": "09:00", "pageViews": 21, "waClicks": 4, "externalClicks": 1, "leadSubmits": 1, "totalActivity": 27 }],
      "peakHour": { "hour": 9, "label": "09:00", "pageViews": 21, "waClicks": 4, "externalClicks": 1, "leadSubmits": 1, "totalActivity": 27 },
      "maxHourlyActivity": 27
    },
    "hasAnyData": true
  }
}
```

---

## 4. Additive Tenant Migration (`0022_insights_aggregates.sql`)

Three purely additive tables in `packages/db/migrations/tenant/0022_insights_aggregates.sql`:

- `analytics_content_daily (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)`
- `analytics_hourly_utc (day_utc, utc_hour, page_views, wa_clicks, external_clicks, lead_submits, updated_at)`
- `analytics_sources_daily (day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits, updated_at)`

Zero destructive changes; `0001_initial_tenant.sql` and `TENANT_MIGRATIONS` checksums remain untouched.
