# PunyaSitus — OWASP ZAP Baseline & Local Built-Worker DAST Scan Report (`TASK-078`)

- **Contract Authorities:** `PRD.md` (`REQ-078`), `DECISIONS.md` (`DEC-032`), `docs/tasks/wave-8.md` (`TASK-078`)
- **CI Workflow:** `.github/workflows/security.yml` (`zaproxy/action-baseline@de8ad967d3548d44ef623df22cf95c3b0baf8b25` / `v0.15.0`, targeting Host-routed `http://127.0.0.1:8787/auth/login` with ZAP replacer injecting `Host: app.punyasitus.com`)
- **ZAP Ruleset:** `scripts/security/zap-rules.tsv` (14 explicit `FAIL` rules on High/Medium/cookie/XSS/SQLi/header/CSP checks; `IGNORE` only on 9 explicitly justified benign Low/Info/SPA-JSON rules; `fail_action: true`)
- **Hosted CI OWASP ZAP Baseline (`45577200637`, commit `6a4d6c1`, 2026-11-25):** **`PASS` — `PASS: 65`, `FAIL-NEW: 0`, `WARN-NEW: 0`, `INFO: 0`, `IGNORE: 6`** (`https://github.com/ongkipro/punyasitus/actions/runs/45577200637`)
- **Local Security Runner:** `scripts/security/run-security-suite.mjs` (post-hardening re-scan against commits `5cb5de1`, `1da5819`, `04e885a`, `6a4d6c1`: **`PASS` — 0 High, 0 Medium, 0 Low alerts**)

---

## 1. Execution Boundary (Honest Separation of Local, Hosted CI & Live Staging Evidence)

| Environment / Scan Type | Status | Evidence Source |
|---|---|---|
| **Local Built-Worker HTTP DAST, Header Audit & 50-Endpoint Cross-Tenant BOLA Probe** | **EXECUTED (`PASS`: all isolation & attack probes passed; 0 High, 0 Medium, 0 Low alerts = `0` total alerts after resolving `SEC-003` & `SEC-006` in `1da5819` & `6a4d6c1`)** | `node scripts/security/run-security-suite.mjs` against real built `apps/web/dist/server/wrangler.json` (`2026-11-25`, commit `6a4d6c1`) |
| **Hosted CI OWASP ZAP Baseline Workflow (`.github/workflows/security.yml`)** | **EXECUTED ON HOSTED GITHUB ACTIONS (`VERIFIED_AUTOMATED` — `PASS`: `65` PASS, `0` FAIL-NEW, `0` WARN-NEW, `0` INFO, `6` IGNORE)** | Run `45577200637` (`https://github.com/ongkipro/punyasitus/actions/runs/45577200637`, commit `6a4d6c1`, 2026-11-25), `.github/workflows/security.yml`, `scripts/security/zap-rules.tsv` |
| **Live Staging OWASP ZAP Full Active Scan (`EXT-10`)** | **`UNVERIFIED_STAGING_GATE`** | Blocked on authorized staging Cloudflare provisioning (`EXT-01`, `EXT-02`, `EXT-10`); MUST be executed and recorded here prior to authorized production cutover |

---

## 2. Executed Local Built-Worker Scan Summary (`apps/web/dist/server/wrangler.json`)

- **Target:** Local `wrangler dev --config dist/server/wrangler.json --local` with migrated `PLATFORM_DB` D1 and TWO isolated `TenantStore` SQLite Durable Objects (`sec-dast-alpha` & `sec-dast-beta`).
- **Surface Inventory Parity:** `375` routes (`141` tenant APIs, `57` tenant dashboard pages, `54` console APIs, `21` console pages, `26` public tenant routes, `3` public tenant APIs, `16` agency APIs, `5` agency pages, `3` affiliate APIs, `1` affiliate page, `15` auth/account routes, `10` marketing routes, `8` MCP/OAuth routes, `8` platform public endpoints, `6` onboarding APIs, `1` plugin webhook), `16` allowed MCP tools, `31` excluded MCP tools, `5` official first-party plugins — **0 drift, 0 unclassified `/api/**` routes**.

### 2.1 Dynamic Attack & Isolation Probe Results

| Probe Category | Measured Result | Verdict |
|---|---|---|
| **Cross-Tenant A -> B & Privilege Escalation (50 live HTTP endpoints)** | 50 / 50 denied (`401`/`403`/`404`) with zero Tenant B data leak | `PASS` |
| **Public Host Isolation (bidirectional A <-> B slugs + 6 platform prefixes)** | Tenant A -> B slug `404`; Tenant B -> A slug `404`; all 6 platform prefixes on tenant host `404` | `PASS` |
| **Session Cookie Attributes (`__Host-ps_session`)** | `HttpOnly`, `Secure`, `Path=/`, `SameSite=Lax`, zero `Domain=` attribute | `PASS` |
| **Reflected XSS Probe (`/marketing?q="><script>alert(1337)</script>`)** | Unescaped payload absent from HTML response | `PASS` |
| **Host / Header Spoofing (`X-Forwarded-Host` + `X-Tenant-ID`)** | Ignored (`404`, zero Tenant B content leak) | `PASS` |
| **Path Traversal, Encoding Bypass & Dotfile Exposure** | `/api/%63onsole/tenants` `403`, `/api//console/tenants` `403`, `/api/console/../tenants` `404`, `/..%2f.env` `400`, `/.env` `404`, `/.git/config` `404`, `/wp-login.php` `404` | `PASS` |
| **Open Redirect (`/auth/login?next=https://evil.example/phish`)** | Zero external redirect (`Location` never points off-origin) | `PASS` |
| **HTTP Method Tampering & Audit Immutability** | `TRACE /api/health` `404`; `POST /api/console/audit` `403` | `PASS` |
| **CSRF / Origin Enforcement (Evil Origin & Missing Origin)** | Evil Origin `403`; Missing Origin `403` | `PASS` |
| **MCP Bearer-Only Boundary (`POST /mcp` with `__Host-` session cookie)** | Rejected `401` | `PASS` |
| **CORS Wildcard + Credentials Check** | Zero `Access-Control-Allow-Origin: *` with credentials across all surfaces | `PASS` |

### 2.2 Observed Post-Hardening Security Header Matrix (Real Built-Worker Output)

| Surface / Endpoint | HTTP | `Content-Security-Policy` | `X-Content-Type-Options` | `X-Frame-Options` | `Referrer-Policy` | `Cache-Control` | `X-Robots-Tag` |
|---|---:|---|---|---|---|---|---|
| `marketing_home` (`/marketing`) | `200` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'nonce-<per-response>' https://challenges.cloudflare.com; ...` *(zero `'unsafe-inline'` in `script-src`)* | `nosniff` | `SAMEORIGIN` | `strict-origin-when-cross-origin` | `public, max-age=60` | *(absent)* |
| `auth_login` (`/auth/login`) | `200` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'nonce-<per-response>' https://challenges.cloudflare.com; ...` *(zero `'unsafe-inline'` in `script-src`)* | `nosniff` | `SAMEORIGIN` | `strict-origin-when-cross-origin` | `no-store` | `noindex, nofollow` |
| `tenant_home` (`/` on tenant host) | `200` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'nonce-<per-response>' https://challenges.cloudflare.com; ...` *(zero `'unsafe-inline'` in `script-src`)* | `nosniff` | `SAMEORIGIN` | `strict-origin-when-cross-origin` | `public, max-age=60, s-maxage=60` | *(absent)* |
| `tenant_not_found` (`/__nonexistent__`) | `404` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'nonce-<per-response>' https://challenges.cloudflare.com; ...` *(zero `'unsafe-inline'` in `script-src`)* | `nosniff` | `SAMEORIGIN` | `strict-origin-when-cross-origin` | `no-store` | `noindex, nofollow` |
| `api_health` (`/api/health`) | `200` | `default-src 'none'` | `nosniff` | *(n/a JSON)* | *(n/a JSON)* | `no-store` | `noindex, nofollow` |
| `api_tenant_pages` (`/api/tenants/:h/pages`) | `200` | *(n/a JSON)* | `nosniff` | *(n/a JSON)* | *(n/a JSON)* | `no-store` | `noindex, nofollow` |

---

## 3. DAST / ZAP-Equivalent Alert Summary & Historical Closure (`0` Active Alerts — `PASS`)

- **Current Post-Hardening Result:** **`0` High, `0` Medium, `0` Low (`0` total alerts) — Verdict `PASS`**.
- **Previously Observed Pre-Hardening Alerts (13 total: 5 Medium, 8 Low) — All Closed in `1da5819` (`238c429`) and Re-Verified `0` on Built Worker:**

| Rule ID | Severity | Alert Title | Previously Affected Surfaces | Finding Ref | Post-Hardening Status |
|---|---|---|---|---|---|
| `10038` | **Medium** | Content Security Policy (CSP) Header Not Set | `marketing_home` (`/marketing`), `auth_login` (`/auth/login`) | `SEC-003` | `RESOLVED_VERIFIED` (`1da5819`, per-response nonced CSP emitted) |
| `10020` | **Medium** | Missing Anti-clickjacking Header (`X-Frame-Options` / `frame-ancestors`) | `marketing_home` (`/marketing`), `auth_login` (`/auth/login`) | `SEC-003` | `RESOLVED_VERIFIED` (`1da5819`, `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`) |
| `10055` | **Medium** | CSP: `script-src` includes `'unsafe-inline'` | `tenant_home` (`/`) | `SEC-006` | `RESOLVED_VERIFIED` (`1da5819`, per-response 128-bit `'nonce-...'`, zero `'unsafe-inline'` in `script-src`) |
| `10021` | **Low** | `X-Content-Type-Options` Header Missing (`nosniff`) | `marketing_home`, `auth_login`, `tenant_home`, `api_health`, `api_tenant_pages` | `SEC-003` | `RESOLVED_VERIFIED` (`1da5819`, `nosniff` emitted on HTML + JSON APIs) |
| `CUSTOM-REFERRER-POLICY` | **Low** | `Referrer-Policy` Header Missing | `marketing_home`, `auth_login`, `tenant_home` | `SEC-003` | `RESOLVED_VERIFIED` (`1da5819`, `Referrer-Policy: strict-origin-when-cross-origin`) |

**Explicit `FAIL` Rules & Accepted Benign `IGNORE` Rules (`scripts/security/zap-rules.tsv`):**
- **Explicit `FAIL` (14 rules):** `10010`, `10011`, `10020`, `10021`, `10035`, `10038`, `10054`, `10055`, `40012`, `40014`, `40016`, `40017`, `40018`, `90022` — ensures CI fails cleanly on any unaccepted High/Medium/cookie/header/XSS/SQLi/error-disclosure alert.
- **Accepted `IGNORE` (9 justified benign Info/Low/SPA-JSON rules in `scripts/security/zap-rules.tsv`):**
  - `10027` (`IGNORE`): Benign HTML/JS build comment notice reviewed manually.
  - `10049` (`IGNORE`): Public marketing/tenant HTML edge caching is intentional (`caches.default` keyed by tenant + `cacheVersion`); private/API routes send `no-store`.
  - `10094` (`IGNORE`): 128-bit Base64 CSP script nonces are emitted per response in `<script nonce="...">` and `Content-Security-Policy` headers; not sensitive data disclosure.
  - `10096` (`IGNORE`): Epoch timestamps in public JSON/sitemaps are non-sensitive metadata.
  - `10109` (`IGNORE`): Modern Web Application informational detection notice.
  - `10111` (`IGNORE`): Passive ZAP detection of the public `/auth/login` authentication form; expected behavior.
  - `10202` (`IGNORE`): Low-confidence passive HTML form token notice on React island `<form method="post">` auth forms that submit `application/json` via `fetch()` protected by server-side exact-`Origin` CSRF middleware (`apps/web/src/middleware/csrf.ts`), Better Auth `trustedOrigins`, and `SameSite=Lax` `__Host-` session cookies.
  - `90004` (`IGNORE`): `Cross-Origin-Embedder-Policy: require-corp` is intentionally omitted so Cloudflare Turnstile, privacy-enhanced YouTube, Google Maps embeds, and tenant R2/CDN assets load cleanly.
  - `90005` (`IGNORE`): ZAP spider requests omit browser `Sec-Fetch-*` headers; server-side CSRF and exact-`Origin` checks enforce mutation boundaries.

---

## 4. Pending Live Staging Full Scan (`EXT-10`) & Independent Review Sign-Off (`DEC-032`)

- **Live Staging ZAP Full Scan (`EXT-10`):** `UNVERIFIED_STAGING_GATE` — All local/CI security findings (`SEC-001`..`SEC-006`) are now `RESOLVED_VERIFIED` (`0` local built-Worker DAST alerts). Once staging Cloudflare zones (`EXT-01`, `EXT-02`) are provisioned with owner authorization, run OWASP ZAP Full Scan (`zap-full-scan.py`) against the isolated staging tenant + staging `app`/`console` endpoints, verify Cloudflare edge HSTS (`EXT-02`), and append the staging report hash, zero-High/Medium-alert confirmation, and retest timestamp here.
- **Independent Reviewer Sign-Off (Different Model Family per `DEC-032` & `TASK-078`):** `APPROVED` (`pi-claude-sonnet-5-5`, 2026-11-24) — Initial cross-family R3 review surfaced H1–H3 and M1–M4; all remediations and retests were verified on re-review with `VERDICT: APPROVE` (keeping `EXT-10` staging full ZAP scan explicitly `UNVERIFIED_STAGING_GATE`).
