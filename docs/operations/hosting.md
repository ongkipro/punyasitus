# Cloudflare for SaaS Hosting & Routing Operations Runbook (`REQ-041`, `REQ-095`, `ADR-0009`)

This runbook documents the declarative two-zone Cloudflare for SaaS topology, Worker routing contract, staging isolation, O2O rules, Trust+ pre-launch check, Turnstile secret naming, and reproducible staging verification for PunyaSitus.

> **Approval & Safety Gate:** Provisioning zones, editing DNS records, setting `fallback_origin`, deploying Workers, or creating live Custom Hostnames are **production/provider mutations** and require explicit operator approval. Nothing in `infra/cloudflare/` or `scripts/verify/routes.mjs` mutates Cloudflare resources.

---

## 1. Two-Zone Topology & Resource Isolation (`PLAN.md` §12.1)

Every PunyaSitus Cloudflare resource uses the `punyasitus-*` prefix and never reads, binds, or modifies resources of other projects (`adsbook-*`, etc.) on the same Cloudflare account.

| Layer | Production | Staging (Isolated) | Notes |
|---|---|---|---|
| **Worker** | `punyasitus-web` | `punyasitus-web-staging` | `workers_dev: false`, `preview_urls: false`, `limits.cpu_ms: 50` |
| **Platform zone** | `punyasitus.com` (`@`, `www` -> `308` apex, `app.`, `console.`) | `staging.punyasitus.com`, `app.staging.punyasitus.com`, `console.staging.punyasitus.com` | Cloudflare for SaaS **disabled** on platform zone; Workers Custom Domains route to the Worker |
| **SaaS zone** | `situsku.click` | `situsku-staging.click` | Cloudflare for SaaS **enabled here only**; staging MUST own a separate SaaS zone |
| **Fallback origin** | `fallback.situsku.click` (`AAAA 100::`, proxied) | `fallback.situsku-staging.click` (`AAAA 100::`, proxied) | Originless proxied dummy IPv6 record; Worker handles every request |
| **Customer CNAME target** | `cname.situsku.click` -> `fallback.situsku.click` | `cname.situsku-staging.click` -> `fallback.situsku-staging.click` | Proxied CNAME target given to paid tenants |
| **SaaS Worker routes** | `*/*`, `cname.situsku.click/*` | `*/*`, `cname.situsku-staging.click/*` | Explicit `cname.<saas-zone>/*` route is mandatory for O2O customers |
| **D1 / R2 / Queue** | `punyasitus-platform`, `punyasitus-media`, `punyasitus-backup`, `punyasitus-jobs` (+ `-dlq`) | `punyasitus-*-staging` | Declared in `infra/cloudflare/topology.json` |

### Why Staging Requires Its Own SaaS Zone
Cloudflare's Custom Hostnames fallback origin (`PUT /zones/{zone_id}/custom_hostnames/fallback_origin`) is a **per-zone setting** accepting a single proxied hostname. Sharing the production SaaS zone (`situsku.click`) with staging would either route staging custom hostnames to production or overwrite the production fallback origin. Staging therefore uses its own dedicated SaaS zone (`situsku-staging.click`) and fallback origin (`fallback.situsku-staging.click`).

### Non-Enterprise Plan Boundaries
PunyaSitus operates on **Workers Paid + Cloudflare for SaaS (non-Enterprise)** and explicitly forbids Enterprise-only dependencies:
- `wildcard_custom_hostnames`: **disabled** (each hostname such as `www.example.com` and `example.com` is created and validated individually; max 2 per tenant).
- `custom_metadata` (`request.cf.hostMetadata`): **disabled** (tenant resolution reads `PLATFORM_DB` authoritatively, never Enterprise metadata or KV).
- `apex_proxying` (fixed-IP A-record onboarding): **disabled** (default onboarding connects `www.<domain>` via CNAME; root/apex is offered only when the customer's DNS supports CNAME flattening / `ALIAS` / `ANAME`).

---

## 2. Step 0 DCV Pass-Through & Request Routing Order (`PLAN.md` §3.3)

`apps/web/src/worker/index.ts` and `apps/web/src/core/tenant.ts` enforce the exact 8-step request gate in order:

1. **Step 0 — HTTP DCV Pass-Through:** `/.well-known/pki-validation/*` and `/.well-known/acme-challenge/*` pass through untouched (`return fetch(request)`) before any host classification or tenant lookup so pending custom hostnames complete HTTP DCV issuance and 90-day renewals. `/.well-known/cf-custom-hostname-challenge/*` is deliberately **not** passed through (pre-validation runs on the customer's existing origin, not ours).
2. **Host Normalization:** Normalized strictly from `request.url` only. `X-Forwarded-Host` and `X-Tenant-ID` are **never** trusted or read. Malformed hosts, IP literals (outside `APP_ENV === "local"` loopback), `*.workers.dev`, and `*.pages.dev` preview hostnames fail closed with a neutral `404`.
3. **Platform Allowlist:** `punyasitus.com` (marketing), `www.punyasitus.com` (`308` -> apex), `app.punyasitus.com` (dashboard/agency/affiliate/auth/account/MCP/API), and `console.punyasitus.com` (superadmin console). Marketing paths on `app.`/`console.` issue one `301` to `punyasitus.com` (preserving query); public-site paths (`/layanan`, `/produk`, etc.) return `404` on `app.` and `console.`.
4. **SaaS Zone Apex & Reserved Labels:** `situsku.click` and `www.situsku.click` return `301` to `https://punyasitus.com/`. Reserved labels (`www`, `fallback`, `cname`, `app`, `console`, `admin`, `api`, `mail`, `notif`) return neutral `404`.
5. **Host Isolation on Tenant Hosts:** Platform-only prefixes (`/dashboard`, `/agency`, `/affiliate`, `/console`, `/auth`, `/account`, `/mcp`, `/oauth2`, `/.well-known/oauth-*`, `/api/console`, `/api/auth`) return neutral `404` on every tenant host.
6. **Authoritative Tenant Resolution:** `PLATFORM_DB` (`tenant_hosts JOIN tenants`, <=5 s active-only isolate cache, 60 s moved-host quarantine). Control-plane outage returns `503` + `no-store` + `Retry-After: 60`, never a default tenant.
7. **Primary-Host Canonicalization:** Active custom primary triggers a single `301` from `<handle>.situsku.click` or alias host on `GET`/`HEAD` (preserving path and query/UTM/click IDs). **Never redirects** `/api/*` or `/.well-known/*`.
8. **Service Gate & Edge Cache:** Non-serving states (`provisioning`/`purging`/`purged` -> `404`; `suspended` -> `503` `"Situs dalam perbaikan"`; `recovery` -> `503` `"Sedang dalam pemeliharaan"`) run before `caches.default`. All state pages carry `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Content-Security-Policy: default-src 'none'`, zero tenant data or platform links, and answer `/api/*` with JSON `{ "success": false, "code": "..." }`.

---

## 3. Orange-to-Orange (O2O) Rules (`PLAN.md` §3.1, §3.2, §12.2)

When a customer's own domain is already proxied on Cloudflare (orange cloud), traffic passes through the customer's zone first and then enters our SaaS zone with header `cf-connecting-o2o: 1`:

1. **Explicit CNAME Target Route:** The SaaS zone MUST attach Worker route `cname.<saas-zone>/*` -> `punyasitus-web` alongside `*/*` so O2O requests targeting `cname.situsku.click` execute the Worker.
2. **Avoid Error 1014 (CNAME Cross-User Banned):** Always create the custom hostname via the Cloudflare for SaaS API **before** the customer saves their proxied CNAME to `cname.situsku.click`.
3. **Avoid Redirect Loops:** Instruct O2O customers to set their zone SSL/TLS mode to **`Full`** or **`Full (strict)`** (never `Flexible`) and not to create conflicting host-redirect rules on the connected hostname.
4. **No Pre-Validation:** Cloudflare does not support pre-validation for O2O hostnames; use `ssl.method = "http"` and gate primary promotion on `status == "active"`, `ssl.status == "active"`, matching CNAME target, and a passing HTTPS tenant-marker probe.
5. **Routing Parity:** O2O requests carrying `cf-connecting-o2o: 1` follow the exact same 8-step Worker gate, original `Host` normalization, `CF-Connecting-IP` preservation, and `301` primary-host redirect.

---

## 4. AI Search Visibility (`REQ-095`) & Zone WAF Hygiene

Per `PRD.md` `REQ-095` and `infra/cloudflare/topology.json`:

- **Free `Markdown for Agents`: ENABLED** on the SaaS zone (`markdown_for_agents: true`) so AI search/user fetchers sending `Accept: text/markdown` receive clean Markdown alongside canonical HTML/JSON-LD.
- **Free Bot Fight Mode: OFF** (`bot_fight_mode: false`) on both platform and SaaS zones so verified search engines and user-triggered AI fetchers (`Googlebot`, `Bingbot`, `OAI-SearchBot`, `ChatGPT-User`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot`, `Perplexity-User`, `Applebot`) are never JS-challenged or blocked.
- **WAF & Rate Limiting within Free Plan Limits:** At most 5 Custom Rules and 1 Rate Limiting Rule per zone:
  - SaaS zone custom rule 1 skips WAF challenges on HTTP DCV paths (`/.well-known/acme-challenge/*`, `/.well-known/pki-validation/*`).
  - SaaS zone custom rule 2 blocks sensitive dotfile / legacy PHP probes (`/.env`, `/.git`, `/wp-login.php`, `/xmlrpc.php`).
  - SaaS zone rate-limit rule caps burst `POST` traffic to `/api/leads`, `/api/events`, and `/api/abuse-report` by `ip.src` (complementing atomic D1 limits).
  - Platform zone rate-limit rule caps burst requests to `app.punyasitus.com/api/auth/*`.

---

## 5. Pre-Launch Indonesian ISP Trust+ Check & Cookie Isolation

- **Komdigi Trust+ IP Check (`PLAN.md` §1, §12.1):** Before onboarding the first live client on `situsku.click` (and on `situsku-staging.click`), resolve the assigned Cloudflare Anycast IPv4/IPv6 pairs and verify reachability from Indonesian residential/mobile ISPs (Telkomsel, Indihome, XL, Indosat) against Komdigi Trust+ / DNS Nawala blocklists. If the shared IP pool on `.click` is blocked, switch the SaaS base TLD to `.my.id` only through a recorded `DEC` before public launch.
- **PSL-Free Cookie Isolation (`PLAN.md` §3.2):** PunyaSitus does not depend on the Public Suffix List in v1. Platform session cookies use `__Host-` on the separate registrable domain `punyasitus.com`; tenant hosts strip any `Set-Cookie` containing `Domain=` and only allow the host-only `__Host-ps_consent` cookie.

---

## 6. Secrets & Turnstile Key Naming

No secret values or live Turnstile site keys are ever stored in Git (`wrangler.jsonc`, `topology.json`, or runbooks). Provision values via `wrangler secret put` (secrets) or Cloudflare dashboard/environment vars (non-secret site keys / zone IDs):

| Name | Type | Scope | Purpose |
|---|---|---|---|
| `TURNSTILE_SITE_KEY` | Var | Public forms & abuse reports | Client widget key on tenant/public surfaces |
| `TURNSTILE_SECRET_KEY` | Worker Secret | Public forms & abuse reports | Server-side Siteverify secret |
| `TURNSTILE_AUTH_SITE_KEY` | Var | Auth forms (`app.punyasitus.com`) | Client widget key on login/signup/reset |
| `TURNSTILE_AUTH_SECRET_KEY` | Worker Secret | Auth forms (`app.punyasitus.com`) | Server-side Siteverify secret |
| `CF_SAAS_ZONE_ID` | Var | SaaS zone only | Target Cloudflare SaaS zone ID (`situsku.click` / `situsku-staging.click`) |
| `CF_SAAS_ZONE_API_TOKEN` | Worker Secret | Zone-scoped (`SSL and Certificates Write`) | Custom hostname API lifecycle on the environment's SaaS zone only |
| `AUTH_SECRET` | Worker Secret | `app.punyasitus.com` | Better Auth session signing key |
| `CONSOLE_AUTH_SECRET` | Worker Secret | `console.punyasitus.com` | Separate superadmin session signing key |

---

## 7. Reproducible Verification Procedures

### 7.1 Offline Config & Topology Verification (Run in CI & Local)

```bash
node scripts/verify/routes.mjs --check-config
```

Checks `apps/web/wrangler.jsonc` (`workers_dev: false`, `preview_urls: false`, `punyasitus-*` resource prefix, v1 bindings) and `infra/cloudflare/topology.json` (staging vs production SaaS zone & fallback origin separation, originless `100::` DNS records, `*/*` + `cname.<saas-zone>/*` Worker routes, `markdown_for_agents: true`, `bot_fight_mode: false`, WAF Free-tier limits, zero Enterprise-only features, zero raw secret values).

### 7.2 Authorized Staging Routing Verification (Read-Only Probe)

Execute **only** after authorized staging deployment and DNS onboarding of a canary platform subdomain (`canary.situsku-staging.click`) and one authorized disposable custom hostname (`www.<staging-custom-domain>`):

```bash
node scripts/verify/routes.mjs \
  --target https://canary.situsku-staging.click \
  --custom-host https://www.staging-canary.example \
  --alias-host https://canary.situsku-staging.click \
  --expected-primary www.staging-canary.example \
  --unknown-host https://does-not-exist-probe.situsku-staging.click \
  --platform-app https://app.staging.punyasitus.com
```

Verify from the JSON probe report and staging Worker logs that:
1. Both the platform subdomain and the custom hostname reach `punyasitus-web-staging` with their **original `Host`** header intact and a populated **`CF-Connecting-IP`** header.
2. Host-isolated prefixes (`/dashboard/probe`, `/console`, `/auth/login`, `/api/console/health`) return `404` on both tenant hosts.
3. The unknown host returns `404` with `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and neutral body `"Halaman tidak ditemukan"`.
4. When a custom primary is active, `GET` on the alias/subdomain returns a single `301` to `https://<expected-primary>/...` preserving path & query while `/api/*` and `/.well-known/*` do not redirect.
5. `curl -I https://punyasitus-web-staging.<account>.workers.dev/` fails closed (`404` / unreachable because `workers_dev: false` and `preview_urls: false`).

### 7.3 Staging Evidence Record Template

Record authorized staging verification below (never paste tokens, secrets, or real customer PII):

| Field | Value |
|---|---|
| Date (UTC) | `YYYY-MM-DDTHH:MM:SSZ` |
| Commit SHA | `<git-rev-parse-short>` |
| Staging Platform Zone | `staging.punyasitus.com` / `app.staging.punyasitus.com` / `console.staging.punyasitus.com` |
| Staging SaaS Zone & Fallback | `situsku-staging.click` / `fallback.situsku-staging.click` |
| Trust+ Check Result (ID ISPs) | `pending authorized staging setup` |
| Canary Platform Subdomain | `canary.situsku-staging.click` (Host & `CF-Connecting-IP` preserved: `pending`) |
| Authorized Custom Hostname | `www.<disposable-staging-domain>` (HTTP DCV + Host & `CF-Connecting-IP` preserved: `pending`) |
| `routes.mjs --target` Result | `pending authorized staging deployment` |
| Operator | `<operator-handle>` |
