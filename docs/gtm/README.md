# PunyaSitus Google Tag Manager (GTM) Container Template & `ps_*` DataLayer Contract

> Canonical owners: `PRD.md` `REQ-027`, `PLAN.md` §18.1, `DECISIONS.md` `DEC-027`, `TASK-076`.

## 1. Ready-to-Import Container Template

File: [`punyasitus-container-template-v1.json`](./punyasitus-container-template-v1.json) (GTM Export Format Version 2).

### Import Procedure (Recommended)

1. Open Google Tag Manager (`https://tagmanager.google.com`) and select your **Web** container.
2. Go to **Admin > Import Container**.
3. Choose [`punyasitus-container-template-v1.json`](./punyasitus-container-template-v1.json).
4. Choose a **New Workspace** (recommended) and select **Merge** (never Overwrite an existing production workspace).
5. Under **Variables**, replace only the constant placeholder IDs for vendors you routed as **"Melalui GTM"** in PunyaSitus:
   - `PS - GA4 Measurement ID` (default `G-XXXXXXXXXX`)
   - `PS - Meta Pixel ID` (default `000000000000000`)
   - `PS - TikTok Pixel ID` (default `C0000000000000000000`)
   - Pause or delete tags for vendors you keep in **"Langsung"** mode so no vendor ever double-counts.
6. Verify with **Preview / Tag Assistant** that Consent Mode defaults start `denied` and all 4 `ps_*` events appear after granting consent.
7. Publish the container, then paste your `GTM-XXXXXXX` container ID into **Pengaturan > Analitik & GTM** (owner must accept the audited risk acknowledgement to enable GTM).

---

## 2. Standard First-Party `ps_*` DataLayer Event Contract (`ps_schema_version: 1`)

All events emitted by PunyaSitus are strictly PII-free. Visitor names, email addresses, phone numbers, inquiry message bodies, and raw URL query strings are **never** pushed to `window.dataLayer`.

| Event | Fields | Trigger Rule |
|---|---|---|
| `ps_page_view` | `ps_schema_version`, `event_id`, `page_type`, `content_id`, `page_path` | Fires on consented public tenant pages when analytics consent is active. |
| `ps_wa_click` | `ps_schema_version`, `event_id`, `item_id`, `item_title`, `placement`, `page_path` | Fires non-blocking on WhatsApp CTA clicks; never contains phone or message text. |
| `ps_external_click` | `ps_schema_version`, `event_id`, `item_id`, `destination_host`, `page_path` | Fires non-blocking on external CTA clicks; emits **hostname only** (`destination_host`). |
| `ps_lead_submitted` | `ps_schema_version`, `event_id`, `form_id`, `page_path` | Fires **once per persisted leadId** strictly after `POST /api/leads` confirms durability. |

---

## 3. Google Consent Mode v2 Defaults & Updates

Before `gtm.js` loads, PunyaSitus calls `gtag("consent", "default", ...)`:

- `ad_storage`: `"denied"`
- `ad_user_data`: `"denied"`
- `ad_personalization`: `"denied"`
- `analytics_storage`: `"denied"`
- `functionality_storage`: `"denied"`
- `personalization_storage`: `"denied"`
- `security_storage`: `"granted"`
- `wait_for_update`: `500`

When the visitor saves preferences in `__Host-ps_consent`:

- `analytics: true` -> `analytics_storage: "granted"`, `functionality_storage: "granted"`
- `marketing: true` -> `ad_storage: "granted"`, `ad_user_data: "granted"`, `ad_personalization: "granted"`, `personalization_storage: "granted"`
- Revoking consent immediately sends `gtag("consent", "update", ...)` with all optional storages `"denied"` and removes the GTM script/noscript slot.

---

## 4. Staging Evidence Checklist (External GTM Import Verification)

> External live Google Tag Manager import & Tag Assistant inspection remains **UNVERIFIED** until executed in staging with a real Google Tag Manager account.

- [ ] Import `docs/gtm/punyasitus-container-template-v1.json` into staging GTM Web container via **Admin > Import Container > Merge (New Workspace)**.
- [ ] Confirm zero import warnings and all 4 triggers (`ps_page_view`, `ps_wa_click`, `ps_external_click`, `ps_lead_submitted`) + 13 variables + 13 tags appear.
- [ ] Connect Tag Assistant to a staging GTM-enabled tenant and record screenshots of:
  - [ ] Pre-consent: zero GTM load, strict CSP header.
  - [ ] Post-consent: relaxed CSP with nonce, Consent Mode v2 default -> update, `ps_page_view`, `ps_wa_click`, `ps_external_click`, and `ps_lead_submitted` visible in Tag Assistant with zero PII.
