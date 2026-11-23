# Tenant-Defined Custom Forms API Contract (`REQ-080`, `TASK-080`)

> Canonical contract owners: `PRD.md` REQ-080, `PLAN.md` §19.2, `DESIGN.md` §8.

## Overview

Each website (`TenantStore`) supports up to **10 custom forms** and up to **12 closed-type fields** per form, ordered in a vertical list (no drag-and-drop), with **6 vertical starter templates**, **1-level conditional visibility** (`fieldKey == equalsValue`), and three safe **after-submit actions** (`text`, `whatsapp`, `url`).

### Hard Security & Compliance Invariants

- **Closed field types (10):** `short_text`, `long_text`, `number`, `email`, `phone_id`, `select`, `radio`, `checkbox_group`, `consent_checkbox`, `date`. File uploads, hidden fields, payment fields, quizzes, and multi-page forms are strictly rejected (`422 VALIDATION_ERROR`).
- **Limits:** `1..10` forms per website (11th returns `422 FORM_LIMIT_EXCEEDED`), `1..12` fields per form (13th returns `422 VALIDATION_ERROR`), `<= 20` options per choice field.
- **1-level visibility:** Conditional rules `{ fieldKey, equalsValue }` may reference only an unconditional field in the same form (no self-reference, no chaining, no cycles). Evaluated identically on the server during `POST /api/leads`: hidden fields are not required and not persisted.
- **UU PDP publishing gate:** Publishing a form requires a **published** non-empty `privacy_contact` (`business_profile_structured.published_json`, or `business_profile.published_json` on legacy `0001` stores). Unpublished draft privacy contacts do not unlock form publishing (`422 PRIVACY_CONTACT_REQUIRED`).
- **Mandatory UU PDP submission consent:** Every public custom form renders and strictly requires the built-in `privacyConsent: true` acknowledgement on `POST /api/leads`. Custom `consent_checkbox` fields are additional form-specific opt-ins and never bypass `privacyConsent`.
- **Draft vs live isolation:** `PUT`/`PATCH` updates draft fields/slug only, never modifies `active` (cannot reactivate unpublished forms), and never alters the live published URL or snapshot until an explicit `POST /publish`.
- **Health category warning:** Regulated health categories (`medical_clinic`, `dentist`, `health_and_beauty`) surface an explicit UU PDP sensitive-data warning in both admin and public surfaces.
- **Immutable snapshots:** Submissions validate strictly against `published_definition_json` and snapshot field labels/types/values into `leads.form_snapshot_json` before dispatching a PII-free owner email. Editing a form never mutates historical leads.
- **Safe after-submit handoff:**
  - `whatsapp`: normalizes Indonesian mobile phone via `@punyasitus/core/wa-dispatcher` (`whatsappPhoneOverride` or `business_profile.whatsapp_e164`; never fabricates a number) and single-encodes the submitted answer summary into `https://wa.me/<digits>?text=<encoded>`.
  - `url`: validates public `https://` URLs via `sanitizeExternalLink` (blocking `javascript:`, `data:`, loopback/private IPs, credentials) or clean same-site relative paths (`/terima-kasih`).

## RBAC & Host Isolation

| Endpoint | Host Surface | Required Permission | Locked Tenant | Suspended Tenant |
|---|---|---|---|---|
| `GET /api/tenants/:tenantId/forms` | `app` only (`404` elsewhere) | `settings:read` (Owner/Admin/Agency; Editor `403`) | Allowed (read-only) | `403 SUBSCRIPTION_LOCKED` |
| `GET /api/tenants/:tenantId/forms/templates` | `app` only | `settings:read` | Allowed | `403 SUBSCRIPTION_LOCKED` |
| `POST /api/tenants/:tenantId/forms` | `app` only + CSRF | `settings:write` | `403 SUBSCRIPTION_LOCKED` | `403 SUBSCRIPTION_LOCKED` |
| `GET /api/tenants/:tenantId/forms/:formId` | `app` only | `settings:read` | Allowed | `403 SUBSCRIPTION_LOCKED` |
| `PUT` / `PATCH /api/tenants/:tenantId/forms/:formId` | `app` only + CSRF | `settings:write` | `403 SUBSCRIPTION_LOCKED` | `403 SUBSCRIPTION_LOCKED` |
| `DELETE /api/tenants/:tenantId/forms/:formId` | `app` only + CSRF | `settings:write` | `403 SUBSCRIPTION_LOCKED` | `403 SUBSCRIPTION_LOCKED` |
| `POST /api/tenants/:tenantId/forms/:formId/publish` | `app` only + CSRF | `settings:publish` | `403 SUBSCRIPTION_LOCKED` | `403 SUBSCRIPTION_LOCKED` |
| `POST /api/leads` (with `formSlug`) | Verified tenant host only | Public (Origin/Sec-Fetch-Site, 16 KiB cap, honeypot, Turnstile `lead_submit`, rate-limit, idempotency) | Allowed (public site stays live) | `503 SITE_SUSPENDED` |

## Admin Endpoints

### `GET /api/tenants/:tenantId/forms`
Returns `{ items, count, maxForms: 10, compliance, templates }`.

### `POST /api/tenants/:tenantId/forms`
Creates a draft form. Supports initializing from `templateKey` (`booking_layanan`, `permintaan_penawaran`, `pendaftaran_tur`, `test_drive`, `reservasi_meja`, `kontak_umum`) or supplying explicit `fields` (`1..12`).
- Returns `201 { form }`.
- Errors: `422 VALIDATION_ERROR` (`FORM_LIMIT_EXCEEDED` on 11th form, >12 fields, unsupported field types, nested conditions), `409 CONFLICT` (`SLUG_CONFLICT`).

### `PUT` / `PATCH /api/tenants/:tenantId/forms/:formId`
Updates draft fields/metadata with optimistic concurrency (`expectedVersion` required). Does NOT alter `published_definition_json` or historical `leads`.
- Returns `200 { form }`.
- Errors: `409 STALE_VERSION`, `409 CONFLICT` (`SLUG_CONFLICT`), `404 NOT_FOUND`, `422 VALIDATION_ERROR`.

### `POST /api/tenants/:tenantId/forms/:formId/publish`
Body: `{ "expectedVersion": 1, "action": "publish" | "unpublish" }`.
- `publish`: checks non-empty `privacy_contact` (`422 PRIVACY_CONTACT_REQUIRED`), freezes `published_definition_json`, increments `publishedVersion` and `version`.
- `unpublish`: sets `active = 0` while preserving `published_definition_json` and historical leads.

### `DELETE /api/tenants/:tenantId/forms/:formId?expectedVersion=1`
Deletes an unused form (`leadsCount === 0`). Forms with existing leads return `409 CONFLICT` (deactivate instead to preserve lead history).

## Public Submission (`POST /api/leads` with `formSlug`)

### JSON Request
```json
{
  "formSlug": "permintaan-penawaran",
  "answers": {
    "nama_pic": "Rina Wijaya",
    "nama_perusahaan": "PT Nusantara Maju",
    "no_whatsapp": "081234567890",
    "kategori_kebutuhan": "Pengadaan Produk / Grosir",
    "perlu_survei": "Ya",
    "lokasi_survei": "Kawasan Industri Cikarang",
    "rincian_kebutuhan": "Butuh 500 unit kemasan custom",
    "persetujuan_privasi": true
  },
  "privacyConsent": true,
  "sourcePath": "/penawaran",
  "returnTo": "/penawaran"
}
```

### JSON Response (`201 Created`)
```json
{
  "leadNumber": 1,
  "status": "accepted",
  "confirmationMessage": "Permintaan penawaran Anda telah tercatat. Tim B2B kami akan segera menghubungi Anda.",
  "formSlug": "permintaan-penawaran",
  "formVersion": 1,
  "afterSubmit": {
    "action": "whatsapp",
    "message": "Permintaan penawaran Anda telah tercatat. Tim B2B kami akan segera menghubungi Anda.",
    "whatsappUrl": "https://wa.me/6281234567890?text=...",
    "redirectUrl": null
  }
}
```

### No-JS HTML Form Submission (`application/x-www-form-urlencoded`)
Submit fields named `cf_<fieldKey>` (and `cf_<fieldKey>__<idx>` for `checkbox_group`) alongside `formSlug`, `sourcePath`, `returnTo`, `hp_website`:
- `afterSubmitAction = "text"` -> `303 See Other` to `${returnTo}?leadStatus=accepted&leadNumber=<id>&formSlug=<slug>#formulir-<slug>`
- `afterSubmitAction = "whatsapp"` (with valid phone) -> `303 See Other` to `https://wa.me/<digits>?text=<encoded_summary>`
- `afterSubmitAction = "url"` (with validated HTTPS/relative URL) -> `303 See Other` to `<redirectUrl>`
