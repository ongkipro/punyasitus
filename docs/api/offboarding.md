# Locked-Tenant Retention, Leads Export & Offboarding API Contract

> Contract authority: `PRD.md` (`REQ-069`), `PLAN.md` (§17.3), `DECISIONS.md` (`DEC-022`, `DEC-035 C5`), `TASK-068`.
> Surface: `app.punyasitus.com` (Tenant Admin API) + Cloudflare Durable Queues (`offboarding.sweep`, `offboarding.purge_tenant`).

---

## 1. Owner-Only Leads CSV Export (Lockout Allowlist)

### `GET /api/tenants/{tenantId}/leads/export`

*(Alias: `GET /api/tenants/{tenantId}/leads/export.csv`)*

Exports all currently retained visitor leads for the tenant as a formula-injection-safe UTF-8 CSV attachment.

- **Lockout Allowlist:** Explicitly permitted while tenant is `trial`, `active`, `grace`, `locked` (`H+4..H+7`), or `suspended` (`H+8+`, trial expired, or operator hold), while the leads inbox UI and other lead APIs remain locked (`403 SUBSCRIPTION_LOCKED` on `suspended`, writes blocked on `locked`).
- **Offboarding Cutoff:** Denied once offboarding has claimed the entitlement lock (`status = 'purging'` / `offboarding_started_at IS NOT NULL` → `403 SUBSCRIPTION_LOCKED`; `status = 'purged'` → `404 NOT_FOUND`).
- **Authorization (Owner-Only):**
  - Direct tenant: `owner` only. `admin` and `editor` receive `403 FORBIDDEN`.
  - Agency-managed tenant: `agency_admin` payer only. Client members receive `403 FORBIDDEN`.
  - Cross-tenant or non-member: neutral `404 NOT_FOUND`.
  - Unauthenticated: `401 UNAUTHENTICATED`.
- **Rate Limiting:** Durable fixed-window bucket (`leads_export_rate_limits`, default `10` requests per `15 minutes` per `(tenantId, userId)`). Exceeding returns `429 RATE_LIMITED` with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and appends a denied entry to `platform_audit`.
- **Auditing:** Every successful export appends a PII-free record to both `TenantStore.tenant_activity_log` (`lead.export_csv`) and `PLATFORM_DB.platform_audit` (`tenant.leads.export_csv`).
- **Mandatory Response Headers:**
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="leads-{handle}.csv"`
  - `Cache-Control: private, no-store`
  - `X-Robots-Tag: noindex, nofollow`
  - `X-Content-Type-Options: nosniff`
  - `Vary: Cookie`

---

## 2. Billing Serialization Against Offboarding (`DEC-022`)

Once `claimTenantForOffboarding` transitions `tenants.status` to `'purging'` and sets `offboarding_started_at`:

| Path | Behavior After Offboarding Claim |
|---|---|
| `POST /api/tenants/{tenantId}/billing/attempts` / `obligations` | Rejected with `403 SUBSCRIPTION_LOCKED` (middleware entitlement gate) or `409 CONFLICT` (`TENANT_OFFBOARDING_IN_PROGRESS` at durable repository layer — including coupon checkouts). |
| Late Advice Settlement (`settleVerifiedPaymentAttempt`) | Never reactivates `purging`/`purged` tenant and creates `0` entitlement grants; transitions attempt to `lifecycle_state = 'review'` (`TERMINAL_TENANT_LATE_SETTLEMENT`), sets `billing_obligations.review_required = 1`, and appends `billing.entitlement.deferred_terminal_state` audit row. |
| Operator Manual Hold (`setOperatorManualHold`) | Rejected with `409 INVALID_LIFECYCLE_STATE` (`offboarding_started_at IS NOT NULL`). |

Conversely, before offboarding claims the lock:
- Any payment attempt in `creating`, `creation_unknown`, `pending`, or `review` (or any obligation with `review_required = 1`) **blocks** offboarding claim atomically in SQL.
- Any active operator hold (`operator_hold = 1` or `retention_paused_at IS NOT NULL`) **blocks** offboarding claim and pauses the deletion clock; releasing the hold resumes `deletion_due_at` with **at least 14 days remaining**.

---

## 3. Offboarding Durable Queue Topics

| Topic | Payload | Idempotency & Resumability |
|---|---|---|
| `offboarding.sweep` | `{ scheduledAtMs, appOrigin?, limit? }` | Evaluates exact `deletion_due_at` clocks (`paid_through + 45d`, `trial_ends_at + 30d`, or `created_at + 30d`), suppresses earlier missed warning milestones on delayed runs (sending only the latest due warning), atomically claims due tenants, and resumes any interrupted `purging` runs. |
| `offboarding.purge_tenant` | `{ tenantId, scheduledAtMs?, reason? }` | Claims (if not already `purging`) and executes the 6-step checkpointed purge (`tenant_offboarding_runs`): Cloudflare custom hostnames → R2 `t/<tenantId>/` → `TenantStore` (`deleteAlarm()` + `deleteAll()`) → sessions/memberships → residual billing de-identification → `deletion_tombstones` (30-day handle quarantine) + `status = 'purged'` + `platform_audit`. |
