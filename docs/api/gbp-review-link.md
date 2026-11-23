# Google Maps Review Link & Google Business Profile Checklist API (`REQ-074`, `TASK-073`)

> Additive contract documentation complementing `docs/api/openapi.json` (do not hand-edit `openapi.json` outside `TASK-024`; `tests/task-024/unit.test.ts` enforces zero byte-level OpenAPI drift).

## Overview & Non-Scope Invariants (`PLAN.md` §18.4, `PRD.md` `REQ-074`)

PunyaSitus lets tenant **owners** and **admins** store a strictly validated HTTPS Google Maps / Google Business Profile review link under **Settings > Bisnis (`business`)** and provides a guided manual checklist step (**"Tambahkan website ke Google Business Profile"**) linking to official Google Business Profile Help documentation and PunyaSitus Help Center (`/bantuan/mengoptimalkan-seo-dan-visibilitas-ai`).

- **Plain link ONLY:** rendered with `target="_blank"` and `rel="noopener noreferrer nofollow"` inside `SectionTestimonials.astro` and `SectionContactForm.astro`.
- **Zero widgets / zero scripts / zero scraping:** no embedded third-party review widget, no external JavaScript, no copied review text, and no `Review` or `AggregateRating` JSON-LD schema.
- **Zero Google Business Profile API calls:** no OAuth tokens, no server-side outbound fetches to Google, and no review import.

---

## Endpoints (Host: `app.punyasitus.com` only)

All endpoints reuse the tenant-scoped grouped settings endpoints (`TASK-040`), enforce `app` host isolation (`404` on tenant/console/marketing hosts), Better Auth session verification (`401`), CSRF + same-origin check on mutations (`403`), live `PLATFORM_DB` membership & RBAC (`403` for `editor`; `404` cross-tenant), subscription lock (`403 SUBSCRIPTION_LOCKED` on mutations when `locked`), optimistic concurrency (`409 STALE_VERSION`), and return `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.

| Method & Path | Permission | Locked Tenant | Purpose |
|---|---|---|---|
| `GET /api/tenants/{tenantId}/settings` | `settings:read` (`owner`, `admin`, `agency_admin`; **`editor` -> `403 FORBIDDEN`**) | `200` (read-only) | Returns full admin grouped settings DTO including `draft.business.googleMapsReviewUrl` and `published.business.googleMapsReviewUrl`. |
| `GET /api/tenants/{tenantId}/settings/business` | `settings:read` (`owner`, `admin`, `agency_admin`; **`editor` -> `403 FORBIDDEN`**) | `200` (read-only) | Returns the `business` settings group including `data.googleMapsReviewUrl` and `publishedData.googleMapsReviewUrl`. |
| `PATCH /api/tenants/{tenantId}/settings/business` | `settings:write` (`owner`, `admin`, `agency_admin`; **`editor` -> `403 FORBIDDEN`**) | `403 SUBSCRIPTION_LOCKED` | Validates `googleMapsReviewUrl` against the strict Google Maps host+path allowlist and saves draft-only state in `site_settings_grouped.draft_json` + `site_settings.draft_json` with OCC (`expectedVersion`) and `WHERE changes() = 1` audit log. **Never mutates live published state.** |
| `POST /api/tenants/{tenantId}/settings/publish` | `settings:publish` (`owner`, `admin`, `agency_admin`; **`editor` -> `403 FORBIDDEN`**) | `403 SUBSCRIPTION_LOCKED` | Atomically promotes draft settings (including `googleMapsReviewUrl`) into `published_json` across `site_settings`, `business_profile`, and `site_settings_grouped`, bumps `PLATFORM_DB.tenants.cache_version`, and logs a PII-free `settings.published` audit entry. |

---

## Request & Response Examples

### `PATCH /api/tenants/{tenantId}/settings/business`

```json
{
  "expectedVersion": 2,
  "googleMapsReviewUrl": "https://g.page/r/Cf1234567890_EBM/review"
}
```

Pass `"googleMapsReviewUrl": null` (or `""`) to clear the link cleanly in draft.

#### Success (`200 OK`)

```json
{
  "group": "business",
  "version": 3,
  "draftVersion": 3,
  "publishedVersion": 2,
  "hasUnpublishedChanges": true,
  "data": {
    "businessName": "Klinik Sehat Nusantara",
    "googleMapsReviewUrl": "https://g.page/r/Cf1234567890_EBM/review"
  },
  "publishedData": {
    "businessName": "Klinik Sehat Nusantara",
    "googleMapsReviewUrl": null
  }
}
```

#### Validation Error (`422 Unprocessable Entity`)

Returned whenever `googleMapsReviewUrl` fails the strict Google Maps host+path allowlist (including `https://www.google.com/url?...` open redirects, `http://`, `javascript:`, credentials, private IPs, custom ports, or non-Google domains):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Tautan Google harus menggunakan path /maps (tautan pengalihan seperti /url tidak diizinkan).",
    "fields": [
      {
        "field": "googleMapsReviewUrl",
        "code": "INVALID_GOOGLE_MAPS_REVIEW_URL",
        "message": "Tautan Google harus menggunakan path /maps (tautan pengalihan seperti /url tidak diizinkan)."
      }
    ]
  },
  "requestId": "req_..."
}
```

---

## Strict Google Maps Review URL Allowlist (`packages/core/src/settings/google-maps-review.ts`)

Only HTTPS URLs without custom ports, credentials, control characters, path traversal (`..` / `%2e%2e` / `\`), or private/loopback hosts are accepted, strictly matching one of the following host + path forms (`PLAN.md` §18.4):

| Host | Allowed Path / Query Form | Link Kind |
|---|---|---|
| `maps.app.goo.gl` | `/<slug>` (`3..128` `[A-Za-z0-9_-]`, excludes `/url`) | `short_link` |
| `g.page` | `/r/<id>/review`, `/r/<id>`, `/<slug>/review`, `/<slug>` (excludes `/url`) | `write_review` / `maps_profile` |
| `www.google.com`, `google.com`, `www.google.co.id`, `maps.google.com` | `/maps/...` or `/maps?...` (rejects bare `/maps`, `/maps/url`, `/url`, `/search`, `/maps-evil`) | `maps_profile` |
| `search.google.com` | `/local/writereview?placeid=<id>` (`placeid` matches `^[A-Za-z0-9_-]{8,128}$`) | `write_review` |

### Explicitly Rejected Forms (`422 INVALID_GOOGLE_MAPS_REVIEW_URL`)

- Open redirects: `https://www.google.com/url?q=https://evil.com`, `https://google.com/url?sa=t&url=https://evil.com`, `https://maps.google.com/url?q=...`
- Scheme violations: `http://g.page/r/abc123/review`, `javascript:alert(1)`, `data:text/html,...`
- Embedded credentials or custom ports: `https://user:pass@g.page/r/abc123/review`, `https://g.page:8443/r/abc123/review`
- Private / loopback / non-Google hosts: `https://127.0.0.1/maps/place/x`, `https://localhost/maps`, `https://google.com.evil.com/maps/place/x`, `https://example.com/reviews`
- Missing `placeid`: `https://search.google.com/local/writereview`

---

## Public DTO & Draft/Publish Isolation

- `getPublishedGroupedSettings(tenantDb)` and `getPublishedGoogleMapsReviewUrl(tenantDb)` read **exclusively** from `published_json` (`site_settings_grouped` / `site_settings`) and re-validate fail-closed through `validateGoogleMapsReviewUrl()`.
- Unpublished draft edits stored via `PATCH /api/tenants/{tenantId}/settings/business` are **never** exposed to public pages or public DTOs until `POST /api/tenants/{tenantId}/settings/publish` commits atomically.
- Public sections (`SectionTestimonials.astro` and `SectionContactForm.astro`) pass the URL through `buildSafeGoogleMapsReviewLink()` (fail-closed) and emit a plain `<a target="_blank" rel="noopener noreferrer nofollow">` with zero third-party scripts, zero review widgets, zero copied review text, and zero `Review` / `AggregateRating` JSON-LD.

---

## Google Business Profile Onboarding Checklist (`packages/core/src/presets/gbp-checklist.ts`)

- Step ID: `google_business_profile` (`requiredForPublish: false`)
- Label: `"Tambahkan website ke Google Business Profile"`
- Official Google Help URLs:
  - `https://support.google.com/business/answer/3038177` (editing Business Profile website info)
  - `https://support.google.com/business/answer/7035772` (getting & sharing Google review link)
- PunyaSitus Help Center article: `/bantuan/mengoptimalkan-seo-dan-visibilitas-ai`
