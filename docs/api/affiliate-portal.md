# Affiliate Self-Service Portal & Console Payout Management API (`TASK-086`, `REQ-086`)

> Canonical owners: `PRD.md` (`REQ-086`, `REQ-095`), `PLAN.md` (§19.4), `DESIGN.md` (§4.3).
> All endpoints return `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
> Note: `docs/api/openapi.json` remains generated strictly from `packages/core/src/schemas/` (`TASK-024` drift guard).

---

## 1. Security, Privacy & Isolation Boundaries

| Boundary | Rule | Failure / Behavior |
|---|---|---|
| Affiliate portal host isolation | `/affiliate` and `/api/affiliate/**` are served **only** on `app.punyasitus.com` (or local loopback in `APP_ENV=local`). Marketing, console, and tenant hosts receive neutral `404`. | `404 NOT_FOUND` |
| Separate affiliate account | Authenticated users without an `affiliates` row receive `403 AFFILIATE_ACCOUNT_REQUIRED` on `/api/affiliate/**` and a clean enrollment CTA on `/affiliate` (zero affiliate data leaked). | `403 AFFILIATE_ACCOUNT_REQUIRED` |
| Strict self-scoping | Every affiliate portal query is bound to `actorAffiliate.id` resolved from `session.user.id`. Probing foreign `?affiliateId=` returns `403 FORBIDDEN`; foreign `?batchId=` or `/api/affiliate/batches/[batchId]` returns neutral `404 NOT_FOUND`. | `403` / `404` |
| Zero tenant PII | Referred tenants and commission entries expose **masked handles ONLY** (`ko***ra`, `to***01`, `a***c`). Owner names, emails, phones, WhatsApp numbers, business names, custom domains, and lead records are NEVER queried or serialized. | Guaranteed in SQL projection & DTO mapping |
| Console host + 2FA + RBAC | `/console/affiliates` and `/api/console/affiliates/**` are served **only** on `console.punyasitus.com`, enforcing active `platform_operators` grant, mandatory TOTP 2FA, 10-minute 2FA step-up (`requireStepUp: true`), `platform_superadmin` role, CSRF/Origin, mandatory 10–500 char `reason`, OCC `expectedVersion`, and atomic `platform_audit`. | `404` / `401` / `403` / `409` / `422` |
| REQ-095 payout compliance gate | Marking a payout batch paid requires BOTH platform REQ-095 resolution (`affiliate.payout_compliance` in `platform_settings`) AND affiliate `terms_accepted_at` / payout details. | `422 AFFILIATE_COMPLIANCE_INCOMPLETE` |
| Safe CSV export | Console CSV exports escape leading spreadsheet formula tokens (`=`, `+`, `-`, `@`, `\t`, `\r`) with a leading `'` and RFC 4180 quoting. | Neutralized across all text columns |

---

## 2. Affiliate Self-Service Portal Endpoints (`app.punyasitus.com`)

### `GET /api/affiliate/overview`

Returns the authenticated affiliate's own dashboard summary, referral link (only when `status === "active"`), cookieless funnel counts, masked referred tenants, exact integer IDR ledger balances, threshold progress toward `Rp 100.000`, next `Asia/Jakarta` 15th/30th payout date, recent commissions, and payout batch history.

- **Query parameters (optional):**
  - `affiliateId`: Rejected with `403 FORBIDDEN` if present and not matching the authenticated affiliate.
  - `batchId`: Returns detail for an owned payout batch, or `404 NOT_FOUND` if missing or owned by another affiliate.
- **Responses:**
  - `200 OK`: `{ success: true, affiliate, funnel, balances, threshold, nextPayout, rates, compliance, referredTenants, recentCommissions, payoutBatches, requestId }`
  - `401 UNAUTHENTICATED`, `403 AFFILIATE_ACCOUNT_REQUIRED`, `403 FORBIDDEN`, `404 NOT_FOUND`

### `GET /api/affiliate/batches/[batchId]`

Returns payout batch summary and masked commission entries strictly owned by the authenticated affiliate.

- **Responses:**
  - `200 OK`: `{ success: true, batch, entries, requestId }`
  - `401 UNAUTHENTICATED`, `403 AFFILIATE_ACCOUNT_REQUIRED`, `404 NOT_FOUND` (missing or foreign batch)

---

## 3. Console Affiliate & Payout Endpoints (`console.punyasitus.com`)

### `GET /api/console/affiliates`

Lists affiliates, payout batches, summary counts, and REQ-095 compliance state (or exports formula-safe CSV).

- **Query parameters:**
  - `status`: `pending | active | suspended | rejected`
  - `batchStatus`: `pending_review | paid | canceled`
  - `format`: `json` (default) or `csv`
  - `export`: `affiliates` (default) or `batches` (when `format=csv`)
- **Responses:**
  - `200 OK` (JSON or `text/csv; charset=utf-8` attachment with audited `console.affiliates.export_csv`)
  - `401 UNAUTHENTICATED`, `403 FORBIDDEN` / `TOTP_REQUIRED`, `404 NOT_FOUND` (non-console host)

### `GET /api/console/affiliates/[affiliateId]`

Reads a single affiliate's profile, compliance status, commission balances, and payout batches.

### `POST /api/console/affiliates/[affiliateId]/status` (alias: `PATCH /api/console/affiliates/[affiliateId]`)

Approves (`approve`, issuing unique referral code), suspends (`suspend`), or rejects (`reject`) an affiliate account atomically with `platform_audit`.

- **Headers:** `Content-Type: application/json`, `Origin: https://console.punyasitus.com`
- **Request JSON:**
  ```json
  {
    "action": "approve",
    "expectedVersion": 1,
    "reason": "Identitas dan rekening pencairan afiliasi telah diverifikasi.",
    "referralCode": "MITRA2026"
  }
  ```
- **Error Codes:** `401`, `403` (missing 2FA step-up `REAUTH_REQUIRED`, CSRF, or non-superadmin), `404 AFFILIATE_NOT_FOUND`, `409 STALE_VERSION` / `INVALID_STATE_TRANSITION` / `REFERRAL_CODE_TAKEN`, `422 VALIDATION_ERROR`.

### `POST /api/console/affiliates/batches/[batchId]/mark-paid`

Marks a `pending_review` payout batch `paid` with manual bank `transferReference`, atomically transitioning all linked `batched` commission entries to immutable `paid` status and recording `platform_audit`.

- **Request JSON:**
  ```json
  {
    "transferReference": "TRF-BCA-20261215-001",
    "expectedVersion": 1,
    "reason": "Transfer bank manual periode 15 Desember telah terkonfirmasi."
  }
  ```
- **Error Codes:**
  - `422 AFFILIATE_COMPLIANCE_INCOMPLETE`: REQ-095 tax/terms gate or affiliate `terms_accepted_at` is unresolved.
  - `409 STALE_VERSION` / `INVALID_STATE_TRANSITION`
  - `403 REAUTH_REQUIRED` / `FORBIDDEN`
  - `404 NOT_FOUND`

### `POST /api/console/affiliates/compliance`

Updates the platform-level REQ-095 affiliate tax & terms compliance gate (`platform_settings.key = 'affiliate.payout_compliance'`) atomically with `platform_audit`.

- **Request JSON:**
  ```json
  {
    "affiliateTermsPublished": true,
    "affiliateTaxReviewCompleted": true,
    "notes": "Ketentuan afiliasi v2026-11-v1 dan review PPh selesai.",
    "reason": "Konfirmasi penyelesaian dokumen ketentuan dan tinjauan pajak afiliasi REQ-095."
  }
  ```
