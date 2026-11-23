# Structured Business Profile & Auto-Derived Brand Assets API (`REQ-091`, `TASK-091`)

> Additive contract documentation complementing `docs/api/openapi.json` (do not edit `openapi.json` directly outside TASK-024).

## Endpoints (Host: `app.punyasitus.com` only)

All endpoints require an authenticated Better Auth session on `app.punyasitus.com`, live `PLATFORM_DB` membership verification for `{tenantId}` (immutable tenant handle or ULID), CSRF + same-origin verification on mutations, and emit `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

| Method & Path | Permission | Locked Tenant | Purpose |
|---|---|---|---|
| `GET /api/tenants/{tenantId}/identity/business-profile` | `settings:read` (Owner/Admin; **Editor -> `403 FORBIDDEN`**) | `200` (read-only) | Read structured business profile draft/published state, resolved Schema.org subtype, truthful Indonesian credentials, and brand-asset derivation status. |
| `PATCH /api/tenants/{tenantId}/identity/business-profile` | `settings:write` (Owner/Admin) | `403 SUBSCRIPTION_LOCKED` | Atomically validate & save draft structured business profile + site identity with OCC (`expectedVersion` -> `409 STALE_VERSION`) and `WHERE changes() = 1` audit log. Preserves unrelated `site_settings` (`activeThemeId`, `analytics_config_json`, etc.). |
| `PUT /api/tenants/{tenantId}/identity/business-profile` | `settings:write` (Owner/Admin) | `403 SUBSCRIPTION_LOCKED` | Replace draft structured business profile + site identity with OCC and `WHERE changes() = 1` audit log. |
| `POST /api/tenants/{tenantId}/identity/business-profile/publish` | `settings:publish` (Owner/Admin) | `403 SUBSCRIPTION_LOCKED` | Atomically publish validated draft, bump `PLATFORM_DB.tenants.cache_version`, and record `WHERE changes() = 1` audit entry. |
| `GET/PUT/PATCH /api/tenants/{tenantId}/identity` & `POST .../publish` | TASK-008 + TASK-091 compatible | Read-only / `403` | Backwards-compatible unified identity endpoints also supporting structured profile fields when `0011_business_profile_structured` is migrated. |

## Closed `businessCategory` -> Google-Supported Schema.org Mapping

Default fallback is `LocalBusiness`. Deprecated `ProfessionalService` is **rejected with `422 INVALID_BUSINESS_CATEGORY`** on write and **never emitted** in JSON-LD (`resolveBusinessSchemaType` always maps legacy/unknown values to `LocalBusiness`).

| `businessCategory` Key | Schema.org Subtype | Entity Profile Kind | Contextual Indonesian Credentials |
|---|---|---|---|
| `local_business` | `LocalBusiness` | `local_business` | `nib` |
| `organization` / `b2b_corporate` | `Organization` | `organization` | `nib`, `isoSniTkdn` |
| `contractor` | `HomeAndConstructionBusiness` | `local_business` | `nib`, `isoSniTkdn` |
| `sales_executive` | `LocalBusiness` + `ProfilePage` (`Person` + `worksFor`) | `profile_person` | `nib` |
| `personal_brand` | `LocalBusiness` + `ProfilePage` (`Person`) | `profile_person` | `nib` |
| `travel_umrah_agency` | `TravelAgency` | `local_business` | `skKemenagPpiu`, `asitaIata`, `nib` |
| `auto_dealer` / `motorcycle_dealer` / `auto_repair` / `automotive_business` | `AutoDealer` / `MotorcycleDealer` / `AutoRepair` / `AutomotiveBusiness` | `local_business` | `nib` |
| `restaurant` / `cafe` / `bakery` / `food_catering` / `retail_store` | `Restaurant` / `CafeOrCoffeeShop` / `Bakery` / `FoodEstablishment` / `Store` | `local_business` | `halalBpjh`, `pirt`, `nib` |
| `medical_clinic` / `dentist` / `health_and_beauty` | `MedicalClinic` / `Dentist` / `HealthAndBeautyBusiness` | `local_business` | `sipStr`, `nib` |
| `legal_service` / `accounting_service` | `LegalService` / `AccountingService` | `local_business` | `barNotaryJurisdiction`, `nib` |
| `financial_service` / `real_estate_agent` / `beauty_salon` / `hotel_lodging` / `lodging_business` / `sports_activity` | Matching current Google-supported subtype | `local_business` | `nib` |
| `education_course` | `EducationalOrganization` | `organization` | `lkpNpsn`, `nib` |

## Optional Indonesian Licence Credentials (Truthful, Zero Fabricated Badges)

All credentials are optional and strictly format-validated:

- `nib`: 13 digits (`^\d{13}$`, spaces/hyphens normalized).
- `skKemenagPpiu`: 4–80 chars, alphanumeric + `./- ` with `>= 2` digits (e.g., `U.123 Tahun 2024`).
- `asitaIata`: 3–48 chars with digits (e.g., `ASITA 0123/DPP/2024`).
- `sipStr`: 4–64 chars with `>= 3` digits (e.g., `SIP 446/1234/Dinkes/2025`).
- `barNotaryJurisdiction`: 4–100 chars with digits.
- `halalBpjh`: `ID` + 12–20 digits (e.g., `ID31110000123450123`).
- `pirt`: `P-IRT` / `SPP-IRT` + 12–16 digits (e.g., `P-IRT 2063171010123-28`).
- `isoSniTkdn`: 3–80 chars with digits (e.g., `ISO 9001:2015`).
- `lkpNpsn`: 3–64 chars with digits.

Every emitted credential carries `selfDeclared: true`, `verifiedByPlatform: false`, and renders as plain factual text / Schema.org `PropertyValue` identifiers with zero fabricated trust badges or ratings.

## Auto-Derived Brand Assets on Logo Upload (`media.process_image` `purpose: "logo"` / `media.derive_brand_assets`)

When a tenant uploads or assigns a logo, the media worker derives:
- `32x32` WebP favicon (`t/{tenantId}/media/{logoMediaId}/{slug}-favicon-32.webp`)
- `180x180` WebP apple-touch-icon (`t/{tenantId}/media/{logoMediaId}/{slug}-apple-touch-180.webp`)
- `1200x630` WebP default OG image (`<= 300 KiB` / `307,200` bytes; `t/{tenantId}/media/{logoMediaId}/{slug}-brand-og-1200x630.webp`)

**Override Protection Invariant:** Auto-derivation **only** populates unset default slots. If the tenant explicitly uploaded/selected `faviconMediaId` or `ogImageMediaId`, the explicit tenant override is preserved untouched (`faviconSource: "explicit_override"` / `ogImageSource: "explicit_override"`).

## SSR Lifecycle & RBAC Gate (`/dashboard/{handle}/settings/identity`)

Enforced **before** any `TenantStore` DB read:
- `purging` / `purged` -> neutral `404`
- `suspended` / `recovery` / `operatorHold` -> `302 /dashboard/{handle}/service-status`
- Missing `settings:read` (including `editor` role) -> `403`
- `locked` -> `200` read-only (`403 SUBSCRIPTION_LOCKED` on all mutations)
- All responses carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
