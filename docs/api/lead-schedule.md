# Preferred Schedule Fields for Inquiries API & WhatsApp Token Contract (`REQ-072`, `TASK-071`)

> Additive contract documentation complementing `docs/api/openapi.json` (do not hand-edit `openapi.json` outside `TASK-024`; `tests/task-024/unit.test.ts` enforces zero byte-level OpenAPI drift).

## Overview & Request-Only Invariant (`PLAN.md` §6 & §18.4, `PRD.md` `REQ-072`)

Visitors submitting an inquiry through the public contact form or consultation WhatsApp CTA may optionally provide a **preferred schedule request** (**"permintaan jadwal"**):

- **Request-only semantics:** UI copy, WhatsApp messages, and Lead Inbox displays explicitly state **"permintaan jadwal"** — never slot inventory, live availability checks, or automatic booking confirmations.
- **Date-only calendar math:** `preferred_date` is stored and formatted strictly as a calendar `YYYY-MM-DD` string in the tenant's configured IANA timezone (default `Asia/Jakarta`). Changing timezones never shifts a stored date.
- **No-JS fallback:** Both `<form method="POST" action="/api/leads">` (native `application/x-www-form-urlencoded` -> `303 See Other` PRG) and the server-rendered WhatsApp CTA `<a href="https://wa.me/...">` work cleanly with JavaScript disabled.
- **Privacy & telemetry boundary:** Schedule fields (`preferred_date`, `preferred_time`, `branch_id`, `preferred_branch_label`) are stored only with the lead inside the tenant's isolated `TenantStore` DO and are **never** emitted to analytics payloads, ad pixels, owner notification emails, PRG query strings, or structured logs.

---

## Endpoint: `POST /api/leads` (Verified Tenant Hosts Only)

Inherits all existing `TASK-021` / `TASK-029` guarantees:
- Served exclusively on verified tenant hosts (`404 NOT_FOUND` on marketing/app/console/unknown hosts).
- Supports `application/json` (`201 Created`) and `application/x-www-form-urlencoded` / `multipart/form-data` (`303 See Other` PRG).
- Enforces the **16 KiB** (`16,384` bytes) maximum body limit (`413 PAYLOAD_TOO_LARGE`).
- Rejects forged tenant selectors (`tenantId`, `organizationId`, etc.) and any unknown fields (`422 VALIDATION_ERROR`).
- Preserves atomic idempotency (`lead_dedup`): matching `Idempotency-Key` + identical canonical payload (including schedule fields) replays the original `leadNumber` (`201`) without duplicating rows; differing payload under the same active key returns `409 IDEMPOTENCY_CONFLICT`.

### Optional Schedule Fields

| Field | Accepted Aliases | Validation Rules | Error (`422 VALIDATION_ERROR`) |
|---|---|---|---|
| `preferred_date` | `preferredDate` | Optional calendar-valid ISO `YYYY-MM-DD`. Evaluated against **today in the tenant's timezone** (`site_settings.timezone`, default `Asia/Jakarta`). Must satisfy `today <= preferred_date <= today + 180 days`. | `INVALID_DATE`, `DATE_IN_PAST`, `DATE_TOO_FAR` |
| `preferred_time` | `preferredTime` | Optional strict enum: `"pagi" \| "siang" \| "sore" \| "malam"` (case-insensitive trim, stored lowercase). | `INVALID_PREFERRED_TIME` |
| `branch_id` | `branch`, `branchId` | Optional positive sequential integer (`1..2147483647`). Must match an **active (`active = 1`) and published (not `draft`)** outlet in the **same tenant's** `TenantStore.branches` table. | `INVALID_BRANCH` |

### JSON Request Example

```json
{
  "name": "Siti Rahmawati",
  "phone": "0812-3456-7890",
  "email": "siti@example.test",
  "message": "Mohon informasi konsultasi layanan pendirian usaha.",
  "preferred_date": "2026-12-10",
  "preferred_time": "pagi",
  "branch_id": 1,
  "privacyConsent": true,
  "sourcePath": "/kontak"
}
```

### Validation Error Example (`422 Unprocessable Entity`)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Mohon periksa kembali tanggal permintaan jadwal Anda.",
    "fields": [
      {
        "field": "preferred_date",
        "code": "DATE_TOO_FAR",
        "message": "Tanggal permintaan jadwal maksimal 180 hari ke depan."
      }
    ]
  },
  "requestId": "req_..."
}
```

---

## WhatsApp Single-Pass Token Expansion (`packages/core/src/wa-dispatcher.ts`)

Extends `TASK-010` canonical tokens (`{{item_title}}`, `{{item_price}}`, `{{page_url}}`) with optional schedule tokens:

| Token | Meaning | When Empty / JS Disabled |
|---|---|---|
| `{{preferred_date}}` | Visitor's requested date (e.g., `"10 Desember 2026"`) | Entire sentence containing `{{preferred_date}}` is omitted cleanly |
| `{{preferred_time}}` | Visitor's requested window (`"Pagi"`, `"Siang"`, `"Sore"`, `"Malam"`) | Entire sentence containing `{{preferred_time}}` is omitted cleanly |
| `{{branch}}` | Selected active outlet name | Entire sentence containing `{{branch}}` is omitted cleanly |

### Security & Determinism Rules
1. **Single-pass expansion only:** Replacement values containing `{{branch}}`, `{{page_url}}`, or `$&` are emitted literally and never re-scanned.
2. **Strict unknown-token rejection:** Templates containing unknown `{{...}}` tokens (or unclosed/malformed delimiters) throw `WhatsAppValidationError("UNKNOWN_TOKEN" | "INVALID_TEMPLATE")` deterministically.
3. **Zero dangling punctuation:** Omitting an empty schedule token removes its full sentence/line so messages never contain artifacts like `"pada tanggal ."` or `"di cabang ."`.
4. **No-JS WhatsApp CTA:** Server-rendered `<a href="https://wa.me/...">` expands the template with empty schedule values so all schedule sentences are cleanly omitted when JavaScript is disabled.

---

## Additive TenantStore Migration (`0024_lead_preferred_schedule.sql`)

- File: `packages/db/migrations/tenant/0024_lead_preferred_schedule.sql` (mirrored byte-for-byte in `packages/db/src/leads/migrations.ts`).
- Adds nullable `leads.preferred_branch_label TEXT` (preserving the outlet name snapshot in Lead Inbox even if the outlet is later renamed or deleted and `leads.branch_id` is detached to `NULL`) plus partial lookup indexes `leads_preferred_schedule_idx` and `leads_branch_created_idx`.
- Existing `preferred_date`, `preferred_time`, and `branch_id` columns from `0001_initial_tenant.sql` are preserved untouched; all repository reads/writes remain backward compatible with pre-0024 tenant DBs with zero runtime DDL.
