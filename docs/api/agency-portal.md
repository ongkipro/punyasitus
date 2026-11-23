# Agency / Reseller Portal, Client Provisioning & Agency-Payer Billing API (`TASK-083`, `REQ-083`)

> Canonical owners: `PRD.md` (`REQ-083`), `PLAN.md` (§19.4), `DESIGN.md` (§4.2).
> All endpoints return `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.

## 1. Security & Isolation Boundaries

| Boundary | Rule | Failure Response |
|---|---|---|
| Surface host isolation | `/agency/**` and `/api/agency/**` are served **only** on `app.punyasitus.com` (or local loopback in `APP_ENV=local`). `/console/agencies/**` and `/api/console/agencies/**` are served **only** on `console.punyasitus.com`. | `404 Not Found` (neutral) |
| Mandatory TOTP 2FA | **Every** agency user MUST have verified email (`email_verified = 1`) and enroll + verify TOTP 2FA before accessing any `/agency/**` or `/api/agency/**` route (including `/api/agency/receipts/**`). | `403 EMAIL_NOT_VERIFIED` / `403 TOTP_ENROLLMENT_REQUIRED` / `403 TOTP_REQUIRED` |
| Agency Member RBAC | Explicit per-action role matrix on active `agency_members` (`agency_owner`/`agency_admin`: full; `agency_billing`: read clients + billing/receipts only; `agency_staff`: read clients + CMS switch only). Revoked members immediately lose both agency and client org access atomically. | `403 FORBIDDEN` / `403 AGENCY_MEMBERSHIP_REQUIRED` |
| Session lifetime ceiling | Agency sessions enforce `DEC-045` ceilings: **60 minutes idle / 12 hours absolute**. | `401 SESSION_EXPIRED` |
| CSRF & Origin | All state-changing (`POST`, `PUT`, `PATCH`, `DELETE`) requests require `Content-Type: application/json` and exact `Origin === https://app.punyasitus.com` (or `console.punyasitus.com`). | `403 FORBIDDEN` |
| Cross-agency isolation | Requesting another agency's ID, client tenant, billing checkout, reconciliation, or PDF receipt never reveals existence. | `404 NOT_FOUND` (neutral) |
| 100% Agency-Payer Billing | For any tenant with `tenants.agency_id IS NOT NULL`, client `owner`, `admin`, `editor`, and `setup_staff` have **zero** billing access (`403 FORBIDDEN` + hidden billing UI). Reminders and numbered PDF receipts go strictly to the agency. | `403 FORBIDDEN` |
| Atomic Unpaid Trial Cap | Before an agency has at least 1 linked client with a settled paid subscription, creating a 4th unpaid trial client is blocked atomically in SQL (`agency_client_links_enforce_trial_cap` trigger + repository guard). | `409 AGENCY_TRIAL_LIMIT_REACHED` |
| Console Step-Up & Audit | Console agency invitations and discount/tier/status mutations require active `platform_operators` grant, recent 2FA step-up (`<= 10m`), CSRF/Origin, mandatory 10–500 char `reason`, optimistic `expectedVersion`, and atomic `platform_audit`. | `403 RECENT_SECOND_FACTOR_REQUIRED` / `409 STALE_VERSION` |

---

## 2. Agency Portal Endpoints (`app.punyasitus.com`)

### `POST /api/agency/enroll`
Self-registration for a verified, TOTP-2FA-enabled account.
- **Request JSON:** `{ agencyName, billingEmail?, billingName?, acceptTerms: true, termsVersion? }`
- **Invariants:** Requires `email_verified = 1`, `acceptTerms === true`, mandatory 2FA. Always initializes `discountPercent = 0`, `discountTiers = []`, `unpaidTrialCap = 3`.
- **Response (`201`):** `{ success: true, agency, auditId, requestId }`

### `POST /api/agency/invitations/accept`
Accepts an operator-issued onboarding invitation token (stored SHA-256 hashed in `agency_invitations`).
- **Request JSON:** `{ token, agencyName?, billingEmail?, billingName?, acceptTerms: true, termsVersion? }`
- **Invariants:** Authenticated verified email MUST match invitation email (`403 INVITATION_EMAIL_MISMATCH`); token is single-use and expires (`410 INVITATION_EXPIRED`).

### `GET /api/agency`
Returns the active agency summary, effective discount %, volume discount tiers, unpaid trial cap meter, pricing, linked client summaries, and recent receipts.

### `GET /api/agency/clients`
Lists **only** linked clients (`tenants.agency_id = activeAgency.id`, excluding `purged`).

### `POST /api/agency/clients`
Provisions a new linked client website (`tenants.agency_id = activeAgency.id`, `agency_client_links.billing_payer = 'agency'`, 7-day trial).
- **Headers:** `Idempotency-Key: <RFC 4122 UUID>` (required)
- **Request JSON:** `{ agencyId?, handle, name, vertical?, clientOwnerEmail? }`
- **Errors:** `409 AGENCY_TRIAL_LIMIT_REACHED` (4th unpaid trial before 1st paid client), `409 HANDLE_TAKEN`, `409 IDEMPOTENCY_CONFLICT`.
- **Audit:** Appends `platform_audit` (`action = "agency.client.provision"`, `actor_user_id = agencyUserId`).

### `GET /api/agency/clients/{tenantId}`
Returns scoped client detail + `agencyClientContext` payload. Returns neutral `404 NOT_FOUND` for any tenant outside the caller's agency.

### `POST /api/agency/clients/{tenantId}/switch`
Audited context switch into `/dashboard/{handle}`:
- Verifies client ownership (`404` for cross-agency).
- Ensures `agency_staff` membership on client organization and updates `sessions.active_organization_id`.
- Appends `platform_audit` (`action = "agency.client.switch"`, recording `actor_user_id` = actual agency user ID, `agencyId`, `clientHandle`).
- Returns `{ success: true, client, agencyClientContext: { agencyId, agencyName, clientTenantId, clientName, clientHandle, returnHref, dashboardUrl }, auditId }`.

### `GET /api/agency/billing`
Consolidated 100% agency-payer billing overview: server-computed monthly & yearly prices (base & agency-discounted), linked clients' lifecycle states, and numbered PDF receipts.

### `POST /api/agency/billing/checkout`
Creates a durable agency-payer `billing_obligations` (`payer_type = 'agency'`, `payer_agency_id = agencyId`) and `payment_attempts` instruction via AutoLaris relay.
- **Headers:** `Idempotency-Key: <RFC 4122 UUID>`
- **Request JSON:** `{ agencyId?, tenantId, plan: "monthly" | "yearly", channelCode, channelKind? }`
- **Security:** Rejects any client-supplied amount/price/discount/status/paid fields (`422 FORBIDDEN_BILLING_FIELD`). Server computes agency discount from live `agencies.discount_percent` + volume tiers, clamped to `>= Rp 10.000`.

### `POST /api/agency/billing/reconcile`
Reconciles an agency client payment attempt strictly via server-side AutoLaris Advice (`reconcilePaymentAttemptViaAdvice`).
- **Request JSON:** `{ agencyId?, tenantId, attemptId?, obligationId? }`
- **Abuse & Audit Hardening:** Enforces a 15-second per-attempt cooldown (`429 RATE_LIMITED` + `Retry-After`), never allows user-triggered polls to exhaust `maxPolls` into `review`, and logs the actual agency member's `userId` and `agencyRole` in `platform_audit`.
- On verified settlement: updates `agency_client_links.first_settled_at` (unlocking the 3-trial cap), grants calendar subscription period, and issues an immutable numbered PDF receipt (`PS-YYYY-NNNNNN`) addressed to the agency in R2 + email via `EmailPort`.

### `GET /api/agency/billing/receipts/{receiptId}/pdf`
Mandatory-2FA-gated, SHA-256-verified immutable PDF download strictly scoped to the caller's own agency (`404 NOT_FOUND` for cross-agency or direct tenant receipts).

---

## 3. Superadmin Console Endpoints (`console.punyasitus.com`)

### `GET /api/console/agencies`
Lists all registered agencies with live client counts, unpaid trial utilization, paid client count, effective discount %, volume tiers, and pending onboarding invitations.

### `POST /api/console/agencies`
Issues a single-use SHA-256-hashed agency onboarding invitation. Requires recent operator 2FA step-up (`<= 10m`), CSRF/Origin, and 10–500 char `reason`.
- **Request JSON:** `{ email, agencyName, reason, expiresInHours? }`
- **Audit:** `console.agency.invite` in `platform_audit`.

### `GET /api/console/agencies/{agencyId}`
Returns single agency summary + linked clients overview.

### `PATCH /api/console/agencies/{agencyId}`
Configures agency base discount (`0..50%`), volume discount tiers (`[{ minPaidClients, discountPercent }]`), `unpaidTrialCap` (`0..50`), and `status` (`pending | active | suspended`).
- **Request JSON:** `{ expectedVersion, discountPercent?, discountTiers?, unpaidTrialCap?, status?, reason }`
- Requires recent operator 2FA step-up (`<= 10m`), CSRF/Origin, optimistic concurrency (`409 STALE_VERSION`), mandatory 10–500 char `reason`, and atomic `platform_audit` (`console.agency.update`).
