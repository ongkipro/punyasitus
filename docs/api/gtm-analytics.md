# Easy Google Tag Manager & Tracking API (`REQ-027`, `DEC-027`, `TASK-076`)

> Canonical contract owners: `PRD.md` `REQ-027`, `PLAN.md` §18.1, `DECISIONS.md` `DEC-027`.

## 1. Tenant Analytics & GTM Endpoints (`app.punyasitus.com` only)

All tenant analytics endpoints enforce:
- `app.punyasitus.com` host-only isolation (neutral `404` on tenant/marketing/console hosts).
- Better Auth session + live `PLATFORM_DB` membership & lifecycle re-check (`401 UNAUTHENTICATED`, `404 NOT_FOUND` cross-tenant, `403 SUBSCRIPTION_LOCKED` on writes while `locked`/`suspended`).
- CSRF/Origin checks on `PATCH`.
- `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `Vary: Cookie`.
- Optimistic concurrency control (`expectedVersion` required on `PATCH`; `409 STALE_VERSION` on conflict).

### `GET /api/tenants/{tenantId}/analytics/gtm`
Returns the combined direct + GTM configuration, per-vendor delivery modes, owner risk acknowledgement record, redacted tenant-safe operator kill-switch state (internal operator identity `disabledBy` is never exposed), and the versioned `ps_*` `dataLayer` schema documentation.

- **Roles allowed:** `owner`, `admin` (`settings:read`; `editor` is denied `403 FORBIDDEN`).
- **Response `200`:**
  ```json
  {
    "ga4MeasurementId": "G-AB12CD34EF",
    "metaPixelId": null,
    "tiktokPixelId": null,
    "vendorModes": { "ga4": "direct", "meta": "gtm", "tiktok": "gtm" },
    "gtmContainerId": "GTM-ABC1234",
    "gtmEnabled": true,
    "gtmRiskAck": {
      "accepted": true,
      "version": 1,
      "acceptedAt": "2026-11-23T12:00:00.000Z",
      "acceptedByUserId": "usr_..."
    },
    "operatorKillSwitch": {
      "active": false,
      "disabled": false,
      "category": null,
      "reasonCategory": null,
      "reason": null,
      "disabledAt": null,
      "liftedAt": null
    },
    "version": 3,
    "updatedAt": "2026-11-23T12:00:00.000Z",
    "requiredRiskAckVersion": 1,
    "dataLayerContractVersion": 1
  }
  ```

### `PATCH /api/tenants/{tenantId}/analytics/gtm`
Atomically updates GTM container ID, per-vendor delivery modes (`"direct"` | `"gtm"`), optional direct IDs, and owner-only audited GTM activation.

- **Body:**
  ```json
  {
    "gtmContainerId": "GTM-ABC1234",
    "gtmEnabled": true,
    "vendorModes": { "ga4": "gtm", "meta": "gtm", "tiktok": "direct" },
    "ga4MeasurementId": null,
    "metaPixelId": null,
    "tiktokPixelId": "C1234567890ABCDEF",
    "riskAcknowledgement": { "accepted": true, "version": 1 },
    "expectedVersion": 2
  }
  ```
- **Validation & Security Rules:**
  - `gtmContainerId`: must match `^GTM-[A-Z0-9]{6,12}$` or be `null`/empty. HTML tags, `<script>`, and JS snippets return `422 VALIDATION_ERROR` (`FORBIDDEN_SCRIPT_SNIPPET`).
  - **Anti-double-count invariant:** Any vendor with `vendorModes[v] === "gtm"` and a non-null direct ID returns `422 VENDOR_DUAL_MODE_CONFLICT`.
  - **RBAC:**
    - `editor`: `403 FORBIDDEN`.
    - `admin`: may save container IDs, vendor modes, or turn GTM off; attempting to turn GTM on (`gtmEnabled: true`), swap an active container, or submit `riskAcknowledgement` returns `403 OWNER_ONLY_GTM_ACTIVATION`.
    - `owner`: enabling GTM requires `riskAcknowledgement: { accepted: true, version: 1 }` (`422 GTM_RISK_ACK_REQUIRED` otherwise), recorded in `site_settings.analytics_risk_ack_at`, `analytics_config_json.gtmRiskAck`, and `tenant_activity_log` (`WHERE changes() = 1`).
  - **Operator kill switch:** Attempting to enable GTM while an operator kill switch is active returns `403 GTM_DISABLED_BY_OPERATOR`.

### `GET /api/tenants/{tenantId}/analytics/gtm/template`
Requires `settings:read` (`owner`, `admin`; `editor` denied `403`). Downloads the ready-to-import GTM Export Format Version 2 container JSON (`punyasitus-gtm-container-template-v1.json`) with `Content-Disposition: attachment`.

---

## 2. Superadmin Console GTM Kill Switch (`console.punyasitus.com` only)

Non-console hosts ALWAYS receive a bare neutral `404 Not Found` (`text/plain`).

### `GET /api/console/tenants/{tenantId}/gtm`
Requires active `platform_operators` grant + mandatory 2FA. Returns narrow GTM configuration metadata (`containerId`, `gtmEnabled`, `vendorModes`, `riskAck`, `directProvidersConfigured`, `killSwitch`) without reading tenant content or leads.

### `POST /api/console/tenants/{tenantId}/gtm`
Requires CSRF/Origin, active `platform_operators` grant, **10-minute step-up 2FA** (`403 REAUTH_REQUIRED`), mandatory `Idempotency-Key`, optimistic `expectedVersion`, and `10–500` char audit `reason`.

- **Body:**
  ```json
  {
    "action": "disable",
    "reasonCategory": "malware",
    "reason": "Detected malicious injected tag inside tenant GTM container",
    "expectedVersion": 4,
    "idempotencyKey": "gtm-kill-001"
  }
  ```
- **`action: "disable"`:** Requires `reasonCategory` in `["abuse", "malware", "performance"]`. Atomically increments `tenants.version` & `cache_version`, records `platform_audit` (`WHERE changes() = 1`), conditionally upserts `tenant_gtm_policies` and `job_ledger` only when the version transition + audit row commit (zero mutation on `409 STALE_VERSION`), synchronizes `TenantStore.site_settings` with bounded OCC retry while leaving direct GA4/Meta/TikTok tags intact (reporting `tenantMirrorSynced: boolean`), and dispatches a deduplicated `gtm-kill-switch-owner-notice` email to the tenant owner.
- **`action: "lift"`:** Lifts the operator block with audit reason; GTM stays `gtmEnabled: false` until the tenant owner explicitly re-enables it with fresh risk acknowledgement.

---

## 3. Public CSP Profiles & `ps_*` DataLayer Contract

- **Before analytics consent / non-GTM tenants / admin / console / preview / maintenance / error:** Strict CSP profile (`X-PunyaSitus-CSP-Profile: strict`, zero GTM/GA4/Meta/TikTok origins; preserves Cloudflare Turnstile `https://challenges.cloudflare.com` and click-to-play YouTube `https://www.youtube-nocookie.com`).
- **After affirmative `__Host-ps_consent` (`analytics: true`) on `200 text/html` public pages of GTM-enabled tenants (kill switch off):** Bypasses the anonymous edge cache, emits relaxed GTM CSP profile (`X-PunyaSitus-CSP-Profile: gtm-relaxed`) with a fresh cryptographic per-response `'nonce-<nonce>'` (zero `'unsafe-inline'` in `script-src`), Turnstile + YouTube-nocookie + verified GA4/Meta/TikTok/GTM origins, `Vary: Cookie`, and `Cache-Control: private, no-store`. On first-visit consent acceptance on a pre-consent strict-CSP GTM page, the client performs one loop-guarded reload to receive the fresh relaxed CSP + nonce immediately.
- **Standard `ps_*` `dataLayer` events (`ps_schema_version: 1`, strictly PII-free):**
  - `ps_page_view`: `event_id`, `page_type`, `content_id`, `page_path`
  - `ps_wa_click`: `event_id`, `item_id`, `item_title`, `placement`, `page_path`
  - `ps_external_click`: `event_id`, `item_id`, `destination_host` (hostname only), `page_path`
  - `ps_lead_submitted`: `event_id`, `form_id`, `page_path` (once per persisted `leadId`)
