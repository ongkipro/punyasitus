# Subscription Billing & AutoLaris Advice Reconciliation Runbook (`REQ-056`, `REQ-057`, `REQ-058`, `PLAN §16–17`)

This runbook governs PunyaSitus platform subscription payment reconciliation via AutoLaris H2H (`POST /api/h2h/advice`), the production `UNVERIFIED` settlement-mapping safety gate, bounded worker leases, secret/PII redaction, and scoped console operator procedures.

---

## 1. Non-Physical AutoLaris Flow & Endpoint Boundaries

PunyaSitus subscription billing targets **only** the configured HTTPS static-IP relay (`AUTOLARIS_RELAY_URL`) and permits strictly three H2H paths (`packages/integrations/src/autolaris/client.ts`):

| Method | Path | Purpose | Authority Boundary |
|---|---|---|---|
| `GET` | `/api/h2h/list_payment` | Fetch active QRIS & Bank VA channels + fee metadata | Runtime validation only; rejects COD, retail, e-wallet |
| `POST` | `/api/h2h/submit` | Create one non-physical instruction (`courir_id: 1`, `cod_value: "0"`) | Persists `reff_id` before call; never pairs with `/create_payment` |
| `POST` | `/api/h2h/advice` | Read payment status for one provider-issued `transaction_id` | Scheduled worker & audited console operator recheck only |

- **Never permitted:** `/api/h2h/create_payment`, `/api/h2h/ongkir`, `/api/h2h/order`, `/api/h2h/lacak`, `/api/h2h/cancel`, `/api/h2h/pickup`, unauthenticated payment webhooks, or browser return-URL activation.
- **Strictly `transaction_id`:** `POST /api/h2h/advice` MUST receive the provider-issued `provider_transaction_id`. Never send local `reff_id` to Advice. Attempts in `creation_unknown` that lack `provider_transaction_id` immediately route to `review` (`MISSING_PROVIDER_TRANSACTION_ID`) for manual provider reconciliation by `reff_id` and make zero outbound Advice calls.

---

## 2. Production Settlement-Mapping Gate (`UNVERIFIED` by Default)

> **CRITICAL LAUNCH GATE:** Real-provider AutoLaris Advice settlement mapping remains **`UNVERIFIED`** until authorized live provider evidence exists.

- `DEFAULT_PRODUCTION_SETTLEMENT_POLICY` (`packages/core/src/billing/advice.ts`) ships with:
  - `profile: "production_unverified"`
  - `realProviderMappingStatus: "UNVERIFIED"`
  - `allowSettlementGrant: false`
- Under this default policy:
  - `rc: "02"` / `PENDING` keeps the attempt `pending` with bounded backoff.
  - Any non-pending response (including `rc: "00"`) fails safely into `review` (`REAL_PROVIDER_SETTLEMENT_MAPPING_UNVERIFIED`) with **zero** settlements and **zero** entitlement grants.
- **Hard Forbidden Tokens (never proof of payment under ANY policy):**
  - Generic envelope/status strings: `00`, `OK`, `SUCCESS`, `SUKSES`, `BERHASIL`, `COMPLETED`, `DONE`, `PROCESSED`
  - Shipping vocabulary: `DELIVERED`, `SHIPPED`, `IN_TRANSIT`, `MANIFEST`, `PICKUP`, `POD`
- **Local/CI Mock Policy (`mock_only_verified_policy`):**
  - `createMockOnlyVerifiedSettlementPolicy()` is used strictly in automated tests with synthetic fixtures.
  - Even under `mock_only_verified_policy`, settlement requires ALL of:
    1. `rc === "00"` + explicitly whitelisted confirmed payment status (never generic/shipping tokens)
    2. Exact `provider_transaction_id` match (and `reff_id` cross-check when returned)
    3. Exact integer IDR `paidAmountIdr === attempt.totalPayableIdr`
    4. Explicit `currency === "IDR"`
- **Required Evidence Before Enabling Live Production Settlement:**
  1. Written merchant approval from AutoLaris for digital/non-physical `courir_id: 1` profile and required payload schema.
  2. Static-IP relay egress IP whitelisted with AutoLaris (`ADR-0009 E-1`).
  3. Sanitized authorized test-transaction Advice captures for QRIS and every enabled bank VA showing exact settled status code, amount, and currency fields (never copied from public examples or raw secrets).
  4. Independent R3 review updating the versioned settlement policy and verification vectors.

---

## 3. Exactly-Once Entitlement Grants, Renewal Anchors & Precedence

Confirmed settlement executes inside **one atomic `PLATFORM_DB.batch([...])`** transaction (`settleVerifiedPaymentAttempt` -> `applyVerifiedEntitlementGrant`):

1. Inserts `settlements` (enforced unique per `obligation_id` and per `payment_attempt_id`).
2. Updates `payment_attempts` -> `paid` (`settled`) and `billing_obligations` -> `paid`.
3. Inserts `entitlement_grants` (unique per `settlement_id`, guaranteeing **at most 1 grant per obligation**).
4. Updates `tenants` with optimistic CAS (`WHERE id = ? AND version = ?`) using `PLAN §17.1` renewal anchors:
   - `active` / `grace` (`H+1..H+3`) / `locked` (`H+4..H+7`): extends from existing `paid_through` (UTC calendar-month math with month-end clamp, e.g. Jan 31 -> Feb 28/29).
   - Active `trial` (`now < trial_ends_at`): preserves remaining trial hours + appends purchased calendar period.
   - `suspended` / expired trial: starts fresh from server settlement verification timestamp (`nowMs`).
5. Appends immutable `platform_audit` row inside the **same** batch. If audit persistence fails, SQLite rolls back **every** statement (zero settlement, zero grant, zero tenant mutation).

### Non-Negotiable State Protections
- **Manual Operator Holds Survive Payment:** If `tenants.operator_hold = 1`, confirmed payment still records the settlement and extends `paid_through`, while `tenants.status` **stays `'suspended'`**, `deletion_due_at` stays paused, and `platform_audit` records `operatorHoldPreserved: true`.
- **Terminal / Non-Commercial States Never Resurrect:** Tenants in `provisioning`, `purging`, `purged`, or `recovery` receive zero entitlement grants; the attempt routes to `review` (`TERMINAL_TENANT_LATE_SETTLEMENT`) for manual post-purge refund handling.
- **Late & Out-of-Order Safety:**
  - Duplicate confirmed Advice for an already-paid attempt is an idempotent no-op (0 extra grants).
  - Late `PENDING`, `EXPIRED`, or `FAILED` responses can NEVER downgrade a `paid` attempt.
  - Late confirmed settlement on an older attempt after an obligation was already paid or replaced routes to `review` (`LATE_DUPLICATE_SETTLEMENT` / `LATE_SETTLEMENT_AFTER_REPLACEMENT`) with 0 second grants.

---

## 4. Bounded Leases, Batch Caps & Error Isolation

`runBillingAdviceReconciliationSweep` (`apps/web/src/worker/queues/billing/advice-reconciliation.ts`) enforces strict operational bounds:

| Parameter | Default | Enforced Bounds | Purpose |
|---|---|---|---|
| `batchLimit` | `20` | `1..50` | Caps outbound Advice volume per worker tick |
| `leaseDurationMs` | `60,000 ms` (60s) | `5,000..300,000 ms` | Atomic `lease_expires_at` prevents concurrent double-processing |
| `maxPolls` | `24` | `1..100` | Escalates endlessly-pending attempts to `review` (`ADVICE_MAX_POLLS_EXHAUSTED`) |
| `backoff` | `30s` base | `30s -> 60s -> 120s ...` capped at `15m` | Deterministic exponential backoff between polls |
| `expiredGraceWindowMs` | `24h` | `>= 0` | Bounded late-settlement polling window for open obligations |

- Leases are acquired via conditional SQLite CAS (`WHERE lease_expires_at IS NULL OR lease_expires_at <= ?`) and released cleanly in `finally`.
- Per-attempt errors (network timeouts, HTTP 5xx, malformed JSON, unexpected payloads) transition that attempt safely to `review` and **never halt** remaining attempts in the batch.

---

## 5. Redaction Rules (Zero Secret or PII Leakage)

All logs (`redactBillingLogRecord`), `platform_audit` rows (`redactAuditMetadata`), and console billing API responses MUST NEVER contain:
- `AUTOLARIS_API_KEY`, `Authorization: Bearer ...` headers, JWTs, or session cookies
- Raw `payment_info` payloads (`qrisPayload`, `qr`, `vaNumber`, `va`, `paymentRedirectUrl`)
- Customer/payer emails, phone numbers, or addresses

Only opaque identifiers (`obligationId`, `attemptId`, `reffId`, `providerTransactionId`, `tenantId`, `settlementId`, `grantId`), exact integer IDR totals, and sanitized reason/status codes may appear in console responses, audit metadata, and logs.

---

## 6. Scoped Console Operator SOP (`/api/console/billing/**`)

All endpoints are served strictly on `console.punyasitus.com` with `Cache-Control: private, no-store`, active platform operator check, mandatory 2FA, CSRF/Origin validation on `POST`, and 10-minute 2FA step-up (`requireRecentSecondFactor`) on mutations:

1. **Inspect Review Queue (`GET /api/console/billing?reviewOnly=true`):**
   - Lists redacted obligations, latest attempts, poll counts, `safeFailureCode`, and recorded refunds.
2. **Run Audited Advice Recheck (`POST /api/console/billing/recheck`):**
   - Body allowlist: `{ attemptId?, obligationId?, tenantId?, reason }` (`reason` 10–500 chars).
   - Executes one bounded Advice check under the server settlement policy and records an immutable `platform_audit` row.
   - **No arbitrary "mark paid" toggle exists.** Any payload passing `status`, `paid`, `markPaid`, or `grantEntitlement` is rejected with `422 UNKNOWN_FIELD`.
3. **Record Audited Manual Refund (`POST /api/console/billing/refund`):**
   - For duplicate, mistaken, or post-purge late payments only (`DEC-035 C6`; no change-of-mind refunds).
   - Body allowlist: `{ obligationId, paymentAttemptId?, tenantId?, refundKind, amountIdr, externalReference?, reason }`.
   - `refundKind` must be `"duplicate_payment"`, `"mistaken_payment"`, or `"late_post_purge"`.
   - Persists `billing_refund_records` + `platform_audit` atomically (unique per `payment_attempt_id`); never grants or mutates entitlements arbitrarily.

---

## 7. Automated Verification

Run inside the repository workspace:

```bash
pnpm spec:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit && pnpm test:integration
```
