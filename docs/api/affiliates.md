# Affiliate Enrollment, First-Party Referral Attribution & Anti-Abuse Locks (`TASK-084`, `REQ-084`)

> Canonical owners: `PRD.md` (`REQ-084`), `PLAN.md` (§19.4), `DECISIONS.md` (`DEC-038`, `DEC-045`).
> All API endpoints return `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.

## 1. Security, Isolation & Anti-Abuse Boundaries

| Boundary | Rule | Failure / Behavior |
|---|---|---|
| Separate affiliate account | Affiliates have their own account record (`affiliates` + `affiliate_enrollment_profiles`, `UNIQUE(user_id)`) separate from tenant organizations and agency accounts. | `409 AFFILIATE_ALREADY_EXISTS` on duplicate application |
| Surface host isolation | `POST /api/affiliates/apply` is served **only** on `app.punyasitus.com` (or local loopback in `APP_ENV=local`). Marketing (`punyasitus.com`), console (`console.punyasitus.com`), and tenant hosts (`*.situsku.click`) receive neutral `404`. | `404 NOT_FOUND` |
| CSRF & Origin | State-changing requests require `Content-Type: application/json` and exact `Origin === https://app.punyasitus.com`. | `403 FORBIDDEN` |
| Auth & session ceiling | Requires authenticated Better Auth `app` session passing `enforceSessionLifetimeCeiling` (`DEC-045`). | `401 UNAUTHENTICATED` |
| Verified email | Applicant MUST have live `users.email_verified === 1`. | `403 EMAIL_NOT_VERIFIED` |
| PII-free audit logs | Raw payout bank/e-wallet account numbers and raw emails are **never** stored in `platform_audit`; only masked display (`****5678`) and bank code are logged. | Guaranteed atomically in `D1Database.batch` |
| First-party cookie (`ps_ref`) | `?ref=<code>` on `punyasitus.com` validates `^[A-Za-z0-9_-]{4,32}$` and sets an HMAC-SHA256 signed `ps_ref` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000; Domain=punyasitus.com`) containing zero visitor PII. Never set on tenant/console hosts. | Invalid format ignored; expired (`> 30d`) cookie produces zero attribution |
| Server-side 30-day TTL | Attribution verification enforces `nowSec - issuedAtSec <= 2592000` (30 days) from the HMAC-signed embedded timestamp even if a browser replays an older cookie. | Zero attribution |
| Immutable lock | At most one affiliate per tenant (`affiliate_referrals.tenant_id` PRIMARY KEY + `tenants.referred_by_affiliate_id`). Once locked at trial creation, replays/subsequent requests cannot overwrite it (also enforced by SQLite `BEFORE UPDATE` trigger). | Only explicit audited superadmin `correctTenantAffiliateAttribution` can change it |
| Anti-abuse self-referral | Blocks matching `user_id`, existing organization membership, canonicalized email (case-insensitive, `+tag` stripped, Gmail dot-insensitive), shared OAuth identity, and normalized `payout_identity_hash`. | Zero attribution |
| Ineligible tenants | Blocks agency-managed (`tenants.agency_id` / `agency_client_links`), superadmin-created, complimentary (non-settlement `entitlement_grants`), platform, and demo tenants. | Zero attribution |

---

## 2. Affiliate Enrollment Endpoint (`app.punyasitus.com`)

### `POST /api/affiliates/apply`

Submits a verified user's application to join the PunyaSitus affiliate program in `pending` status. Referral codes are **never** self-chosen or active before superadmin approval.

- **Headers:**
  - `Content-Type: application/json`
  - `Origin: https://app.punyasitus.com`
  - `Cookie: __Host-ps_app.session_token=...`
- **Request JSON (strict allowlist):**
  ```json
  {
    "payoutBankCode": "BCA",
    "payoutAccountNumber": "1234-5678-90",
    "payoutAccountHolder": "Budi Santoso",
    "termsAccepted": true,
    "termsVersion": "2026-11-v1"
  }
  ```
- **Rejected Fields (`422 FORBIDDEN_CLIENT_FIELD`):** `status`, `referralCode`, `approvedBy`, `userId`, `version`, `payoutIdentityHash`, etc.
- **Success Response (`201 Created`):**
  ```json
  {
    "success": true,
    "affiliate": {
      "id": "01J...",
      "userId": "usr_...",
      "status": "pending",
      "referralCode": null,
      "referralLink": null,
      "payoutBankCode": "BCA",
      "payoutAccountHolder": "Budi Santoso",
      "payoutAccountMasked": "******7890",
      "termsVersion": "2026-11-v1",
      "termsAcceptedAt": 1764000000000,
      "approvedAt": null,
      "suspendedAt": null,
      "version": 1,
      "createdAt": 1764000000000,
      "updatedAt": 1764000000000
    },
    "auditId": "01J...",
    "requestId": "req_..."
  }
  ```
- **Error Codes:** `404 NOT_FOUND` (wrong host), `405 METHOD_NOT_ALLOWED`, `403 FORBIDDEN` (CSRF/Origin), `401 UNAUTHENTICATED`, `403 EMAIL_NOT_VERIFIED`, `422 VALIDATION_ERROR` / `422 FORBIDDEN_CLIENT_FIELD` / `422 TERMS_NOT_ACCEPTED`, `409 AFFILIATE_ALREADY_EXISTS`.

---

## 3. First-Party `?ref=<code>` Attribution Cookie (`punyasitus.com`)

- **Trigger:** `GET` / `HEAD` on `punyasitus.com` with `?ref=<code>` (and optional `src=footer_badge`).
- **Format:** `ps_ref=v1.<CODE_UPPER>.<ISSUED_AT_SEC>.<SOURCE_TAG>.<HMAC_SHA256_B64URL>`
- **Attributes:** `Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Domain=punyasitus.com; Secure`
- **Cache safety:** Any response setting `ps_ref` sets `Cache-Control: private, no-store`.
- **First-touch preservation:** If the visitor already holds a valid unexpired `ps_ref` cookie, subsequent reloads do not reset the 30-day TTL.
- **Cookieless funnel counter:** Increments `affiliate_funnel_visits(affiliate_id, day_utc)` for active affiliates with zero visitor PII.

---

## 4. Trial Creation Attribution Lock (`POST /api/onboarding/provision`)

`POST /api/onboarding/provision` accepts optional `referralCode` (string) in the request body and/or reads the verified `ps_ref` cookie from the `Cookie` header.

- **Deterministic Precedence:**
  1. Explicit non-empty `referralCode` in JSON body (`attribution_source = "manual_code"`).
  2. Verified, unexpired (`<= 30 days`) `ps_ref` cookie (`attribution_source = "cookie"` or `"footer_badge"`).
  3. Otherwise zero attribution.
- **Immutability:** Once locked on `tenant_id`, idempotent replays or subsequent requests never modify `referred_by_affiliate_id`.
- **Response Addition:** Includes `affiliateAttribution: { attributed, affiliateId, referralCode, source, locked }` alongside all existing onboarding fields.

---

## 5. Superadmin Lifecycle & Correction Operations (`@punyasitus/db/affiliates/index`)

Ready for `TASK-086` console endpoints, each enforcing mandatory 10–500 character `reason` (`validateOperatorReason`) and atomic `platform_audit`:

- `approveAffiliate(db, { affiliateId, actorUserId, reason, referralCode?, expectedVersion? })` -> sets `status = 'active'`, issues unique referral code & `https://punyasitus.com/?ref=<code>`, audits `console.affiliate.approve`.
- `suspendAffiliate(db, { affiliateId, actorUserId, reason, expectedVersion? })` -> sets `status = 'suspended'`, audits `console.affiliate.suspend`.
- `rejectAffiliate(db, { affiliateId, actorUserId, reason, expectedVersion? })` -> transitions `pending` -> `rejected`, audits `console.affiliate.reject`.
- `correctTenantAffiliateAttribution(db, { tenantId, newAffiliateId, actorUserId, reason, expectedVersion? })` -> verifies active `platform_operators` grant (`403 FORBIDDEN`), enforces OCC (`expectedVersion`, `409 STALE_VERSION`), updates/clears `affiliate_referrals` (`attribution_source = 'superadmin_correction'`, bumping `version` and `corrected_at`) and `tenants.referred_by_affiliate_id` atomically with `console.affiliate.attribution.correct`.

---

## 6. "Dibuat dengan PunyaSitus" Minimalist Footer Badge (`@punyasitus/core/affiliates/index`)

`resolveTenantPoweredByBadge({ tenantStatus, hidePoweredByBadge, affiliateReferralCode, affiliateStatus })`:

| Tenant State | `hidePoweredByBadge` | Owner Affiliate | Result |
|---|---|---|---|
| `trial` (or non-paid) | Any (ignored) | Any (ignored) | `visible: true`, `text: "Dibuat dengan PunyaSitus"`, `href: "https://punyasitus.com"`, `canHide: false` |
| `active` (paid) | `true` | Any | `visible: false`, `canHide: true` |
| `active` (paid) | `false` | Approved (`active`) with valid code | `visible: true`, `href: "https://punyasitus.com/?ref=<CODE>"`, `isAffiliateLinked: true` |
| `active` (paid) | `false` | Missing / `pending` / `suspended` / `rejected` / forged code | `visible: true`, `href: "https://punyasitus.com"`, `isAffiliateLinked: false` |
