# PunyaSitus Privacy, Consent & UU 27/2022 Operational Runbook

> Contract authority: `PRD.md` (`REQ-039`), `PLAN.md` (§3.2, §5, §7.3, §9), `DECISIONS.md` (`DEC-022`, `DEC-025`, `DEC-041`, `DEC-045`, `DEC-047`).
> Scope: Engineering and operational runbook for data-subject requests, breach notification, automated retention, subprocessor disclosures, and backup tombstone replay.

> **PRE-LAUNCH GATE NOTICE (`DEC-047`):**
> Unresolved legal, Data Protection Officer (DPO / *Pejabat Pelindung Data Pribadi*), PSE Lingkup Privat registration, and implementing-regulation (`PP 33/2026`, reported effective date `2027-01-16`) confirmations are **`DEC-047` pre-launch gates that block production launch, NOT local development or test fixtures**. Nothing in this document constitutes legal advice or completed regulatory certification; qualified Indonesian legal review must sign off before production traffic is admitted.

---

## 1. Roles, Legal Basis & Consent Controls (`UU 27/2022` Art. 1, 51–52; `DEC-025`)

| Data Surface | Personal Data Controller (*Pengendali*) | Personal Data Processor (*Prosesor*) | Primary Processing Boundary |
|---|---|---|---|
| Tenant website visitor leads & custom form submissions (`TenantStore.leads`) | **Tenant** (website owner / business) | **PunyaSitus** | Processed strictly per Terms of Service instructions; isolated inside per-tenant `TenantStore` Durable Object (`t/<tenantId>`). |
| Platform user accounts, sessions, 2FA, organization memberships (`PLATFORM_DB`) | **PunyaSitus** | Infrastructure subprocessors (§4) | Host-isolated on `app.punyasitus.com` and `console.punyasitus.com` (`__Host-` session cookies). |
| Billing obligations, QRIS/VA attempts, numbered PDF receipts, affiliate payouts (`PLATFORM_DB`) | **PunyaSitus** | AutoLaris (+ static-IP relay), Cloudflare | Residual de-identified financial records retained after tenant purge per `REQ-069`. |
| Platform security & append-only audit logs (`PLATFORM_DB.platform_audit`) | **PunyaSitus** | Cloudflare D1 | Immutable append-only audit trail; never exposes PII bodies or auth tokens. |

### Public-Site Consent & Cookie Isolation (`PLAN §3.2`, `§7.3`, `DEC-041`)

- **Strict Opt-In Default:** Optional third-party trackers (`analytics`, `marketing` — GA4, Meta Pixel, TikTok Pixel, tenant GTM) and interactive map iframes (`maps`) are **never loaded** until the visitor provides affirmative opt-in consent.
- **Host-Only Cookie (`__Host-ps_consent`):** Stored strictly with `Path=/; Secure; SameSite=Lax; Max-Age=15552000` and **NEVER** sets a `Domain=` attribute so sibling `*.situsku.click` subdomains cannot toss or forge consent cookies.
- **Versioned Consent & Withdrawal:** Consent payloads store `{ version, analytics, marketing, maps, updatedAt }`. Incrementing the policy version invalidates stale choices without retroactively inventing consent. Visitors can update or withdraw consent at any time (`Ubah / cabut izin privasi` / `Cabut izin`), immediately unmounting map iframes, removing optional vendor scripts, and expiring the cookie (`Max-Age=0`).
- **Pre-Consent Map Fallback & Core Resilience:** Before `maps` consent (and when JS is disabled), locations render a plain external Maps link (`target="_blank" rel="noopener noreferrer"`). Rejecting or withdrawing optional consent never impairs navigation, lead forms, or WhatsApp links.
- **Ad-Provider Redaction:** `sanitizeVendorEventPayload` strips all lead fields (`name`, `phone`, `email`, `message`, notes), embedded email/phone patterns, and URL query strings (`?...`) before any event payload can reach ad providers.

---

## 2. Retention Schedule & Automated Enforcement (`DEC-045`)

Enforced automatically via `packages/db/src/privacy/retention.ts` (`runTenantRetentionSweep`) and Durable Queue topic `privacy.retention_sweep` (also wired to `cron.hourly_housekeeping`):

| Data Category / Table / Storage | Retention Period | Deletion Scope | Notes |
|---|---|---|---|
| Visitor leads (`TenantStore.leads`) | **180 days** | Rows where `created_at <= now - 180d` | Cascades dependent `lead_dedup` rows. Tenants may also permanently delete individual leads earlier via inbox (`REQ-094`). |
| Raw dedup keys (`lead_dedup`, `analytics_event_dedup`) | **24 hours** | Rows where `expires_at <= now` or `created_at <= now - 24h` | Prevents duplicate submission replay without retaining long-lived request hashes. |
| Daily & hourly analytics aggregates (`analytics_daily`, `analytics_hourly_sources`) | **13 months (395 days)** | Buckets strictly older than `now - 395d` UTC | Cookieless first-party counts only; zero visitor PII. |
| Tenant activity log (`tenant_activity_log`) | **90 days** | Rows where `created_at <= now - 90d` | Tenant-visible change audit log. |
| Platform security/audit logs (`platform_audit`) | **90 days operational window** | Append-only immutable in D1 (`BEFORE UPDATE/DELETE` triggers); archived/exported per legal hold policy | Never mutated in place; contains zero credentials, cookies, or lead bodies. |
| Expired R2 quarantine objects (`t/<tenantId>/quarantine/...` & `media_items.status = 'quarantined'`) | **24 hours** | Deletes R2 objects (`MEDIA_BUCKET.delete`) and unreferenced DB rows; decrements `storage_usage.used_bytes` | Prevents abandoned uploads from persisting or holding storage quota. |
| Trashed content & media (`pages`, `posts`, `offerings`, trashed `media_items`, R2 `t/<tenantId>/trash/...`) | **30 days** | Deletes DB rows + R2 source/poster/caption/variant objects; frees `storage_usage.used_bytes` | Protects active published references before hard deletion. |
| Backups (`punyasitus-backup` R2, D1 Time Travel, DO PITR bookmarks) | **30 days** | Bucket lifecycle (`expire-30-days`) + platform window | Any restore from within 30 days MUST run tombstone replay (§5). |
| Unpaid / offboarded tenants (`DEC-022`) | **H+45** (paid) / **Trial+30d** (never paid) | Full tenant purge + `deletion_tombstones` row + 30-day handle quarantine | Residual de-identified billing records retained per `REQ-069`. |

---

## 3. Operator-Assisted Data-Subject Request (DSR) Procedure (`UU 27/2022` Art. 30, 32, 40, 41)

Supported request types: **Access** (Art. 32), **Correction** (Art. 30), **Deletion** (Art. 43), **Consent Withdrawal** (Art. 40), and **Processing Restriction** (Art. 41).

- **Target SLA:** **`72 hours` (`3 x 24 hours`)** from receipt of a verified request, matching `UU 27/2022` statutory turnaround windows.
- **Scope Note:** Product privacy requests are **operator-assisted**; this does not introduce an excluded one-click self-service archive product (the `DEC-022` locked/suspended tenant owner leads CSV export is the single product exception).

### Step-by-Step Procedure

1. **Intake (T+0 to T+4h):**
   - Receive request through the designated privacy contact channel (published in the pre-launch `Kebijakan Privasi`, `DEC-047`).
   - Open a tracked DSR ticket (`DSR-YYYYMMDD-NNNN`) and record `received_at_utc`, `request_type`, and affected surface (`tenant_visitor` vs `platform_account`) in the DSR request log.
   - Never copy raw lead message text, government IDs, or full phone numbers into unredacted engineering logs.

2. **Identity & Authority Verification (T+4h to T+24h):**
   - **Platform-controlled data (account / billing / affiliate):** Verify the requester via authenticated session ownership on `app.punyasitus.com` or signed challenge sent to the verified account email on file.
   - **Tenant-controlled data (visitor lead submitted on a tenant website):** Verify the requester controls the submitted email or phone channel (minimal proof only) AND identify the target `tenant_id` from the reported site hostname.
   - If verification fails or is ambiguous, pause fulfillment and request clarification within 24 hours without disclosing whether any record exists.

3. **Tenant Routing vs Platform Execution (T+24h to T+48h):**
   - **Visitor leads (`Tenant = Controller`):** Route the verified request to the tenant owner via their verified account contact with clear instructions to execute correction/deletion inside `Pesan Masuk` (`REQ-094` permanent single-lead delete). If the tenant is unresponsive within 24h or suspended, an authorized platform operator executes the instruction under explicit audited tenant context on `console.punyasitus.com` (`platform_audit`).
   - **Platform accounts & auth (`PunyaSitus = Controller`):** Platform operator executes access summary, profile correction, session revocation, consent withdrawal, or account deletion/de-identification while preserving statutory de-identified billing/receipt ledgers (`REQ-069`).
   - **Consent withdrawal (public site):** Guide the visitor to click `Ubah / cabut izin privasi` -> `Cabut semua izin opsional` (immediately expiring `__Host-ps_consent` and unmounting optional scripts/maps), and remove any server-side lead/contact entry if requested.

4. **Completion, Confirmation & Closure (before T+72h):**
   - Confirm database rows and any referenced R2 objects are removed or updated.
   - For full tenant offboarding/deletion, ensure a `PLATFORM_DB.deletion_tombstones` record is written (`recordDeletionTombstone`) so backup restores cannot resurrect deleted data.
   - Send written completion confirmation to the data subject (or controller) and close the DSR ticket before the `72-hour` (`3 x 24h`) deadline.

### DSR Request Log Schema (PII-Minimized)

| Field | Type / Format | Description |
|---|---|---|
| `request_id` | `string` (`DSR-YYYYMMDD-NNNN`) | Unique request reference. |
| `received_at_utc` | ISO-8601 UTC | Exact intake timestamp (starts the `72h` / `3 x 24h` SLA clock). |
| `request_type` | `access \| correction \| deletion \| withdrawal \| restriction` | Statutory right invoked (`UU 27/2022` Art. 30/32/40/41/43). |
| `controller_scope` | `platform_controller \| tenant_controller` | Determines direct execution vs tenant routing. |
| `tenant_id` | ULID or `null` | Scoped tenant when request concerns a tenant website. |
| `verification_status` | `pending \| verified \| rejected_unverified` | Outcome of minimal identity check (no raw ID copies stored). |
| `routed_at_utc` | ISO-8601 UTC or `null` | When escalated to tenant controller (if applicable). |
| `completed_at_utc` | ISO-8601 UTC or `null` | When fulfillment & confirmation completed. |
| `sla_72h_met` | `boolean` | Whether `completed_at_utc - received_at_utc <= 72h`. |
| `operator_id` | Platform operator user ID | Accountable operator recorded in `platform_audit`. |
| `outcome_code` | `fulfilled \| routed_to_tenant \| partial_legal_retention \| rejected` | Standardized closure code. |

---

## 4. Personal Data Breach-Notification Runbook (`UU 27/2022` Art. 46)

### Classification & Dual Notification Duties

| Affected Data Scope | Legal Role | Notification Obligation | Timeline |
|---|---|---|---|
| **Processor data** (tenant `TenantStore` visitor leads, tenant custom forms, tenant private R2 uploads) | PunyaSitus = **Processor**; Tenant = **Controller** | Escalate in writing to every affected tenant controller **without delay** with full technical facts so the tenant can fulfill its own `3 x 24h` statutory notice. | Immediate triage; initial written escalation target **`<= 12 hours`** from confirmed breach. |
| **Platform-controlled data** (platform `users`, `sessions`, `accounts`, agency/affiliate payout details, billing records, security logs) | PunyaSitus = **Controller** | Issue written notification directly to **affected data subjects** AND the **Indonesian PDP supervisory authority** (*Lembaga Pengawas PDP*, once operational / per `PP 33/2026`). | Strictly within **`3 x 24 hours` (`72 hours`)** of awareness (`UU 27/2022` Art. 46). |

### Incident Execution Steps

1. **Detection & Containment (T+0 to T+2h):**
   - Revoke compromised credentials, sessions, OAuth tokens, or API keys; rotate signing secrets if affected.
   - Isolate affected tenant(s) or operator accounts without destroying forensic evidence (`platform_audit` remains immutable).
2. **Scope & Impact Assessment (T+2h to T+12h):**
   - Identify exact data categories exposed (e.g., visitor lead names/phones vs hashed credentials vs billing metadata), affected `tenant_id`s, exposure window (start/end UTC), and root vector.
   - Determine whether the incident affects processor data, platform-controlled data, or both.
3. **Written Notice Content (`UU 27/2022` Art. 46 mandatory elements):**
   Every written notice (both platform-to-tenant escalation and `3 x 24h` controller notice) MUST state:
   1. **Personal data disclosed** (*data pribadi yang terungkap*) — exact categories and affected record scope;
   2. **When and how the disclosure occurred** (*kapan dan bagaimana data pribadi terungkap*) — UTC + `Asia/Jakarta` timeline and root cause summary;
   3. **Remediation & handling efforts** (*upaya penanganan dan pemulihan*) — containment actions taken, protective steps for affected subjects, and privacy contact point.
4. **Delivery & Recordkeeping (within `3 x 24 hours`):**
   - Send notices via verified channels (`notif.punyasitus.com` transactional email + dashboard banner for affected tenants).
   - Archive the incident report, notice timestamps, recipient count, and corrective action plan in the operator incident register (zero raw leaked PII copied into the report).

---

## 5. Subprocessor & Cross-Border Data-Location Register (`UU 27/2022` Art. 51–52, 56)

Processing locations and binding cross-border safeguards MUST be reviewed and reflected in the published `Kebijakan Privasi` and Terms of Service pre-approval clause before production launch (`DEC-047`).

| Subprocessor | Role / Service | Data Categories Processed | Processing Location / Cross-Border Status | `UU 27/2022` Art. 56 Safeguard & Scope Notes |
|---|---|---|---|---|
| **Cloudflare** (Workers, D1 `PLATFORM_DB`, SQLite Durable Objects `TenantStore`, R2 `punyasitus-media` & `punyasitus-backup`, Cloudflare Images, Cloudflare Containers `VideoTranscoder`, Cloudflare Email Service) | Primary application runtime, control-plane & per-tenant storage, media storage/normalization, video transcoding, primary transactional email | Account/auth records, billing/receipts, tenant CMS content, visitor leads (`TenantStore` with `locationHint: "apac-se"`), uploaded media, transactional email envelopes | **Cross-border:** Global Cloudflare edge network; Durable Objects hinted to `apac-se` (Southeast Asia); D1/R2/Email/Images processed in Cloudflare global/regional infrastructure outside Indonesia | Cloudflare DPA + Standard Contractual Clauses (SCCs) / binding contractual safeguards; TLS in transit, encryption at rest; per-tenant DO physical isolation; disclosed in Privacy Notice (`DEC-047` gate). |
| **AutoLaris** (QRIS & Virtual Account gateway) + **Stateless Static-IP Egress Relay** (ADR-0009 E-1) | Subscription & add-on payment settlement (`QRIS` / `VA`) and fixed-IP egress for AutoLaris allowlisting | Payer reference, obligation/transaction ID, IDR amount, channel metadata (no visitor leads, no raw card PAN) | **Indonesia / Regional** (relay host region recorded in fleet inventory before staging/prod; stateless pass-through with zero payload persistence) | Contractual processor agreement; strict payload minimization; relay stores zero PII on disk (`DEC-047` gate). |
| **Google (Google OAuth 2.0)** | Primary platform authentication (`Masuk dengan Google`, `REQ-090`) | Google `sub` identifier, verified email address, display name, avatar URL (platform users only; never public site visitors) | **Cross-border:** Google global identity infrastructure (US/global) | Google Cloud/Identity terms + contractual safeguards; minimal OAuth scopes (`openid email profile`); disclosed at sign-in (`DEC-047` gate). |
| **Resend** *(optional fallback only)* | Secondary transactional email delivery ONLY if fallback is explicitly enabled (`DEC-038`) | Recipient account/notification email address and rendered transactional notice (no visitor lead dumps) | **Cross-border:** US/global email infrastructure | Disabled by default when Cloudflare Email Service is active; enabled only with DPA & updated subprocessor notice (`DEC-047` gate). |
| **Telegram Bot API** *(optional, tenant-enabled)* | Instant lead notifications ONLY for tenants that explicitly link the `lead-notifier` plugin (`REQ-097`) | Lead alert summary sent to the tenant's own linked Telegram chat | **Cross-border:** Telegram global messaging servers | Strictly opt-in per tenant controller (`t.me/<Bot>?start=<token>`); tenant authorizes forwarding of their leads when linking the plugin. |
| **Cloudflare Workers AI** *(optional editorial tool)* | In-editor AI writing suggestions (`REQ-075`, 100/30d cap) | CMS editorial copy snippets (titles, excerpts, offering/meta descriptions); prompts containing emails or phone numbers are blocked server-side | **Cross-border:** Cloudflare Workers AI inference network | No visitor leads or customer PII permitted; server-side PII prompt filter enforced; Cloudflare AI data-usage terms confirmed at `DEC-047` gate. |

---

## 6. Backup Tombstone Replay Procedure (`DEC-022`, `deletion_tombstones`)

Because `PLATFORM_DB` D1 Time Travel, `punyasitus-backup` R2 exports, and `TenantStore` DO PITR bookmarks retain snapshots for up to **30 days**, restoring an older backup can reintroduce tenants or R2 media objects that were legally deleted after the backup timestamp.

### Mandatory Restore-Drill & Recovery Checklist

1. **Restore into Isolation Only:**
   - Restore `PLATFORM_DB` (D1 Time Travel or logical SQL dump), `TenantStore` DO (`restore(bookmark)`), and `punyasitus-media` R2 strictly into an **isolated staging/recovery environment** — NEVER attach an un-replayed backup directly to live host routing.
2. **Merge Authoritative `deletion_tombstones`:**
   - Export the latest `deletion_tombstones` table from the current production/DR tombstone ledger and load it into the restored `PLATFORM_DB` (preserving all rows with `deleted_at` newer than the backup point).
3. **Execute Automated Tombstone Replay:**
   - Run `replayDeletionTombstones({ platformDb, mediaBucket, nowMs })` (exported from `@punyasitus/db/privacy/index`, or dispatch a `privacy.retention_sweep` Durable Queue job with `replayTombstones: true`).
   - If immutable statutory billing receipts live in the same R2 bucket under `t/<tenantId>/receipts/`, pass `preserveSubprefixes: ["receipts/"]` only when required by accounting retention (`REQ-069`); all tenant media, uploads, trash, and quarantine objects under `t/<tenantId>/` are purged.
4. **Verify Zero Resurrection Before Traffic Cutover:**
   - Assert every `tenant_id` in `deletion_tombstones` has `tenants.status = 'purged'` (if a residual row exists for de-identified billing references) and `cache_version` incremented.
   - Assert zero rows in `tenant_hosts` for tombstoned tenants have `status = 'active'` or `is_primary = 1`.
   - Assert `MEDIA_BUCKET.list({ prefix: "t/<tenantId>/" })` returns zero non-preserved objects for every tombstoned tenant.
5. **Log Drill Evidence:**
   - Record the restore timestamp, tombstone count replayed, `tenantsRePurged`, `hostsNeutralized`, and `r2ObjectsDeleted` counts in the restore-drill log (no PII).

---

## 7. Pre-Launch Legal & Governance Checklist (`DEC-047` Gate)

Before admitting production users or live customer data, the product owner and a qualified Indonesian privacy reviewer MUST complete and record sign-off for:

1. **DPO Applicability Assessment (`UU 27/2022` Art. 53):** Document whether PunyaSitus meets statutory mandatory-DPO thresholds and publish the designated privacy contact address in `Kebijakan Privasi`.
2. **`PP 33/2026` & Supervisory Authority Verification:** Recheck final enacted text of `PP 33/2026` (reported effective `2027-01-16`) and confirm official breach-reporting portal/channel of the Indonesian PDP supervisory agency.
3. **Published Bahasa Indonesia Legal Documents:** Publish versioned `Syarat & Ketentuan` (including `DEC-025` processor instructions and pre-approved subprocessor list under `UU 27/2022` Art. 51–52 and `PP 71/2019` Art. 48–49) and `Kebijakan Privasi` (covering `UU 27/2022` Art. 21 disclosures and Art. 56 cross-border transfers), with versioned acceptance recorded at signup.
4. **PSE Lingkup Privat Registration:** Complete OSS registration (`Permenkominfo 5/2020` Art. 2–3).
5. **Retention Schedule Sign-Off:** Confirm or tighten `DEC-045` retention windows in `packages/db/src/privacy/retention.ts` if legal counsel requires shorter windows.
