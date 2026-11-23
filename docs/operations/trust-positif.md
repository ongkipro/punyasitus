# Trust+ Komdigi Protection, Takedown & Normalisation Runbook (`REQ-103`, `PLAN.md` §20.1, `DEC-043`)

This runbook governs how PunyaSitus protects the shared tenant domain (`situsku.click`), responds to gambling/illegal content reports, monitors Komdigi's Trust+ IP list daily, rotates trial subdomains to the standby fallback zone (`situsku.my.id`) if a shared zone is blocked, and files normalisation requests on `trustpositif.komdigi.go.id`.

> **Prerequisite:** PSE Lingkup Privat registration (`PLAN.md` §1) must be active so Komdigi takedown notices arrive directly at our registered operator contact.

---

## 1. Preventive Controls & Internal Response Targets

| Layer | Control | Target / Guarantee |
| --- | --- | --- |
| Publish-time screening | `packages/core/src/content-screening` + `packages/db/src/content-screening` screens every dashboard & MCP publish (titles, rich text, resolved link hosts, image ALT including hidden ALTs, custom-form labels). | Match **never** publishes; stays `draft` (`held_for_review`); owner sees `"Konten ditahan untuk ditinjau"` without matched terms. |
| Daily Trust+ IP watch | `apps/web/src/worker/cron/trust-watch.ts` resolves platform hosts, `cname.<saasZone>`, `cname.<fallbackZone>`, and active `tenant_hosts` A records over DoH against `https://trustpositif.komdigi.go.id/assets/db/ipaddress_isp`. | Reports **`unknown`** (never `clean`) when list or DNS fails; logs every hit and alerts operators **at most once per day**. |
| One-click takedown | `console.punyasitus.com/abuse` action **"Turunkan situs"** (`POST /api/console/abuse/takedown` or review decision `takedown`). | **Internal target: < 1 hour** from report/detection to public 503 suspended state (well under the reported Kepmen Komdigi 127/128 of 2026 4-hour urgent order deadline and 1×12h pre-order reply window — verify official decree text before publishing any external SLA). |
| Standby second tenant zone | `situsku.my.id` (`infra/cloudflare/topology.json` -> `environments.production.fallbackSaasZone`). | Manual operator rotation for shared subdomains; paid clients on custom domains remain unaffected by a shared-zone block. |

---

## 2. Emergency Takedown Procedure ("Turunkan situs")

Execute immediately when an abusive/gambling tenant is confirmed via public abuse report, publish screening review queue, or Komdigi notice:

1. Open `https://console.punyasitus.com/abuse` (requires active `platform_operators` grant + verified 2FA).
2. Complete a fresh 2FA step-up if your verification window is older than 10 minutes.
3. Locate the offending tenant in **Antrean Tinjauan Konten Ditahan** or **Antrean Moderasi Penyalahgunaan**, or use the direct **Turunkan situs** panel.
4. Click **Turunkan situs**, enter a concise PII-free audit reason (10–500 characters, e.g., `"Situs mengandung tautan judi online melanggar kebijakan Trust+ Komdigi"`), and confirm.
5. Verify immediately:
   - `tenants.status` transitions to `suspended` with `operator_hold = 1` and `cache_version` incremented.
   - `platform_audit` and `tenant_takedown_actions` record the immutable audit entry.
   - The next public HTTP request to the tenant host returns HTTP `503` with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
   - Evidence snapshot (review ID / audit ID / timestamp WIB) is saved for any Komdigi compliance reply.

---

## 3. Responding to a Daily Trust+ IP Watch Alert (`status: "hit"`)

When `cron.daily_trust_watch` records `status = "hit"`:

1. Inspect the latest run on `https://console.punyasitus.com/abuse` (section **Pantauan Trust+ Komdigi**) or `GET /api/console/abuse/trust-watch`.
2. Identify which host(s) and IPv4 address(es) matched `ipaddress_isp`:
   - **Case A — Shared Cloudflare edge IP pair on `situsku.click`:** Note that deleting and re-creating a Cloudflare Free zone often assigns the same Cloudflare edge IP pair. Do **not** assume zone recreation clears an IP-level block.
   - **Case B — Specific tenant abuse triggered a domain/host block:** Immediately execute Section 2 (**Turunkan situs**) on the offending tenant(s) and verify the site returns `503` suspended.
3. Confirm whether the block is IP-level, DNS/domain-level, or both using an Indonesian ISP resolver check (Telkomsel / IndiHome / XL / Biznet) from an operator probe outside production Worker code.
4. If `situsku.click` is unreachable for Indonesian visitors, proceed to **Section 4 (Manual Fallback Zone Rotation)** while preparing **Section 5 (Komdigi Normalisation Filing)**.

> **If `status = "unknown"`:** Never treat `unknown` as `clean`. Inspect `error_code` and `failures` (e.g., Komdigi list endpoint timeout or DoH resolution failure), verify upstream reachability, and re-verify before assuming zones are clear.

---

## 4. Manual Standby Fallback Zone Rotation (`situsku.click` -> `situsku.my.id`)

> **Policy (`TASK-103`):** Fallback zone rotation is **strictly manual** (`automaticFailover: false`). Never automate zone switching. Paid clients on custom domains (`domainklien.id`) are unaffected and stay on their custom domains.

### Pre-Launch Readiness Checklist (Verify Before Launch)
- [ ] `situsku.my.id` registered and active in Cloudflare under the PunyaSitus account.
- [ ] Cloudflare for SaaS enabled with `fallbackOrigin: fallback.situsku.my.id` and `cnameTarget: cname.situsku.my.id`.
- [ ] Originless DNS records created: `AAAA @ 100::`, `AAAA * 100::`, `AAAA fallback 100::`, `CNAME cname -> fallback.situsku.my.id` (all proxied).
- [ ] Worker routes attached: `*/*` and `cname.situsku.my.id/*` -> `punyasitus-web`.
- [ ] `Markdown for Agents` enabled, `Free Bot Fight Mode` OFF, WAF rules within Free plan limits (`infra/cloudflare/topology.json`).
- [ ] Resolved IPv4 pair of `situsku.my.id` verified absent from `https://trustpositif.komdigi.go.id/assets/db/ipaddress_isp`.

### Manual Cutover Steps (During a Confirmed `situsku.click` Block)
1. Re-verify `situsku.my.id` IPv4 records are **not** present on `trustpositif.komdigi.go.id/assets/db/ipaddress_isp`.
2. Ensure the offending tenant(s) have already been suspended (**Turunkan situs**) so abusive content is not mirrored onto the fallback zone.
3. Update the Worker `SAAS_ZONE` variable for new trial/subdomain provisioning from `situsku.click` to `situsku.my.id` via staged deployment (`docs/operations/release.md`), and register alias subdomain rows (`<handle>.situsku.my.id`) in `PLATFORM_DB.tenant_hosts` for affected non-custom-domain tenants.
4. Notify affected owners via dashboard incident banner (`TASK-106`) and transactional email with their temporary `https://<handle>.situsku.my.id` link.
5. Keep `situsku.click` monitored until Komdigi normalisation completes; do not delete existing `tenant_hosts` records while normalisation is pending.

---

## 5. Komdigi Normalisation Procedure (`trustpositif.komdigi.go.id`)

Prepare this **pre-assembled document pack** before launch and keep it updated in secure operator storage (never commit secrets or personal IDs to git):

### Prepared Document Set
1. **Surat Pernyataan Kepemilikan Domain (Domain Ownership Statement):** Signed on company letterhead stating legal entity ownership of `situsku.click` / `punyasitus.com` and PSE Lingkup Privat registration number.
2. **Bukti Pembelian / Registrasi Domain (Proof of Purchase):** Registrar invoice + WHOIS/RDAP ownership record matching the legal entity.
3. **Surat Pernyataan Pembersihan Konten (Cleanup & Remediation Statement):** Signed statement confirming the offending tenant subdomain/content was permanently removed/suspended, citing:
   - Exact subdomain/URL and timestamp of takedown (`platform_audit.id` and WIB timestamp).
   - Preventive controls in place (publish-time keyword/domain screening queue + daily Trust+ IP monitoring + 1-click takedown).
4. **Screenshot Bukti Pembersihan:** Before/after evidence showing the offending subdomain now returns the neutral `503` suspended response with zero prohibited content.
5. **Identitas Penanggung Jawab & Kontak Resmi:** Authorised PIC details matching PSE registration.

### Submission Steps on `trustpositif.komdigi.go.id`
1. Visit `https://trustpositif.komdigi.go.id` and open the **Normalisasi / Aduan Konten** portal (or reply directly to the official Komdigi PSE notice channel if an order was issued).
2. Select category **Normalisasi Domain / IP** and enter the affected domain (`situsku.click` and/or affected Cloudflare IPv4 address).
3. Attach the prepared document set (Ownership Statement, Proof of Purchase, Cleanup Statement, and `503` verification screenshots).
4. Record the Komdigi ticket/tracking number in the operator incident log (`console.punyasitus.com/incidents`) and monitor `cron.daily_trust_watch` until the IP/domain clears across Indonesian ISPs.
5. Once verified clean across major Indonesian ISPs for 48 consecutive hours, announce restoration and update the incident record.
