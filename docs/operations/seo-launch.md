# SEO Crawl Regression & Webmaster Launch Operations Runbook (`REQ-055`, `PLAN.md §15`)

This runbook defines the repeatable pre-launch crawl regression gate, manual Google Search Console (GSC) and Bing Webmaster Tools verification/submission steps, post-launch measurement cadence, and explicit `UNVERIFIED` external outcome tracking for PunyaSitus tenant websites.

> **Approval, Scope & Honesty Gate (`PRD.md REQ-055`, `PLAN.md §15.5–§15.6`):**
> - **Manual external execution only:** PunyaSitus v1 performs **zero** automated Google Search Console OAuth calls, Bing Webmaster API calls, live DNS record edits, deprecated sitemap pings, or general-purpose Google Indexing API submissions.
> - **No ranking or inclusion guarantees:** Clean crawlability, valid XML sitemaps, accurate canonicals, and factual Schema.org `@graph` markup support discovery; search engines independently decide indexing, snippet rewrites, canonical selection, and rankings.
> - **FAQ rich result notice:** Google discontinued the FAQ rich result on `2026-05-07` (`PLAN.md §15.4`). Visible FAQ sections may still emit factual `FAQPage` JSON-LD for semantic clarity, but operators and UI copy must never promise an FAQ search feature.
> - **Never submit private previews or trial hosts:** Only verify and submit an active paid tenant's verified primary custom domain (or active paid primary hostname) after passing the crawl regression checklist.

---

## 1. Pre-Launch Crawl Regression Gate (`TASK-054`)

Per `AGENTS.md`, full heavy suites (`pnpm test:integration`, `pnpm test:e2e`, `pnpm build`) run through `scripts/dev/heavy.sh` (or `heavy-run --lock <repo>-env -- <cmd>`) to prevent concurrent resource contention. Run the canonical verification commands before any release touching public routes, themes, middleware, discovery endpoints, or `seo-ai-autopilot`:

```bash
# Canonical repository verification suites (serialized via scripts/dev/heavy.sh)
pnpm test:unit
pnpm test:integration
pnpm test:e2e

# Targeted TASK-054 runs during iterative SEO verification
pnpm exec vitest run --config tests/setup/vitest.unit.config.ts tests/task-054/
bash scripts/dev/heavy.sh --label t054-integration -- pnpm exec vitest run --config tests/setup/vitest.integration.config.ts tests/task-054/
bash scripts/dev/heavy.sh --label t054-e2e -- node tests/task-054/e2e.mjs
```

### Exact Proof Boundary Across the Three Test Layers
1. **Unit Layer (`tests/task-054/unit.test.ts` — Node Vitest):**
   - Verifies pure XML 1.0 strict well-formedness, W3C `<lastmod>` parsing, namespace prefix checks, RFC 9309 `robots.txt` group parsing, `<= 50,000` URLs & `<= 50 MB` sitemap chunking boundaries, HTML `<head>` + whole-document XSS injection detection, `X-Robots-Tag`/meta robots parity (including `none`, `all`, bot-prefixed headers), relative & cross-tenant link auditing, full `PLAN.md §15.2` policy matrix, and custom theme (`sample-agency`) static import hygiene.
2. **Workerd Integration Layer (`tests/task-054/workerd.integration.test.ts` — Cloudflare `workerd`):**
   - Executes real `executeTenantMiddleware`, isolated edge cache (`serveWithTenantEdgeCache`), real discovery handlers (`/robots.txt`, `/sitemap.xml`, `/sitemaps/[kind].xml`, `/blog/feed.xml`), real public route resolvers, and `composePublicSeoHead` in-process against real `PLATFORM_DB` D1 and two isolated `TenantStore` Durable Objects.
   - Enforces: two-tenant isolation & spoofed `X-Forwarded-Host`/`X-Tenant-ID` rejection; single `<title>`, `<= 1` `<meta name="description">`, single `<meta name="robots">` with `X-Robots-Tag` parity, single canonical (tracking params stripped), single safely escaped JSON-LD `@graph` with zero whole-document XSS breakout; zero broken or cross-tenant internal links derived from resolver outputs; sitemap XML validity, chunk pagination, `<lastmod>`/ETag revision updates on publish only (never draft saves), and zero draft/trashed/noindex/tag/empty/former-slug/paginated `?page=2+` leaks; taxonomy archive indexability + `?page=1`/`?page=2`/`?page=99` pagination; per-page `noindex` remaining crawlable in `/robots.txt`; former-slug & homepage-slug `308` redirects; live domain switch (old subdomain permanent redirect -> primary custom domain, canonical/sitemap/schema origin switch, and automatic `recheck_required` invalidation of recorded external verification); warm-cache suspension safety (warmed `HIT` on HTML pages, `/robots.txt`, and `/sitemap.xml` immediately flips to `503` `no-store` `noindex, nofollow` with zero leaked content/XML); and custom theme grant isolation.
3. **E2E DOM Render Layer (`tests/task-054/e2e.mjs` — Compiled Astro Components + Playwright Chromium):**
   - Compiles real Astro components (`Layout.astro`, `PublicSeoHead.astro`, `SectionRenderer.astro`, `SectionBranches.astro`, `_OfferingDetailView.astro`, `_BlogTaxonomyArchiveView.astro`, `_PublicNotFoundView.astro`, `sample-agency/RouteDispatcher.astro`) plus real discovery generator endpoints (`buildRobotsTxtPolicy`, `buildSitemapIndexXml`, `buildUrlsetXml`) into an isolated static fixture build and crawls all 6 rendered routes (Tenant A home, offering detail, taxonomy archive, custom theme, branded 404; Tenant B trial `noindex` home) in Playwright Chromium with `javaScriptEnabled: false` at **both `360px` and `1440px`**.
   - Verifies rendered No-JS DOM parity, single `<head>`/`@graph`, non-lazy hero dimensions, zero map iframes before consent, zero inline event-handler attributes, zero horizontal overflow across both viewports, zero cross-tenant leaks, and zero broken internal links. *(Note: `e2e.mjs` proves compiled Astro component DOM rendering rather than a live deployed Worker SSR server; Worker routing/edge-cache/HTTP status behavior is proven by `workerd.integration.test.ts`.)*

> **Known M1 Sitemap Scope Note (`TASK-063` Integration Gate):**
> `apps/web/src/pages/sitemaps/_shared.ts` currently emits published pages (`pages.xml`), `/blog` + published posts (`posts.xml`), and `/layanan`/`/produk`/`/tour`/`/kendaraan` + published offerings (`offerings.xml`), while excluding drafts, trashed items, `noindex` pages, non-opted-in tags, empty categories, former slugs, and `?page=2+`. Emitting opted-in (`index_enabled = 1`) non-empty taxonomy archive URLs inside `sitemaps/_shared.ts` is tracked as an M1 follow-up verification item under `TASK-063`.

### Manual Pre-Launch Tenant Readiness Checklist
Before starting external webmaster verification for a live tenant, confirm:
1. Tenant status is **paid `active`** (never `trial`, `suspended`, or `recovery`).
2. Target custom domain is verified (`status = active`, `ssl_status = active`, `is_primary = true`), and visiting the old `<handle>.situsku.click` subdomain redirects permanently to `https://<primary-host>/`.
3. Plugin **`SEO & AI Autopilot` (`seo-ai-autopilot`)** is enabled and site visibility is set to **`public`** (not `noindex`).
4. `GET https://<primary-host>/robots.txt` returns `200`, allows public content and assets, and contains `Sitemap: https://<primary-host>/sitemap.xml`.
5. `GET https://<primary-host>/sitemap.xml` returns `200` with valid `<sitemapindex>` pointing only to `https://<primary-host>/sitemaps/*.xml`, and every sub-sitemap returns `200` with live `200` URLs only.
6. Homepage, key offering details, blog posts, and opted-in categories load full primary content with JavaScript disabled, show factual business details/hours/contact, and contain zero placeholder text or broken links.

---

## 2. Google Search Console (GSC) Manual Verification & Sitemap Submission

Perform these steps manually in the tenant owner's authorized Google Search Console account:

### Step 2.1 — Add Property & Choose Verification Method
1. Open [Google Search Console](https://search.google.com/search-console) using the tenant owner's Google account (or an explicitly authorized agency account).
2. Choose **one** verification path:
   - **Option A — Domain Property via DNS TXT (Recommended when owner controls DNS):**
     1. Select **Domain** property type and enter the registrable domain (e.g., `example.id`).
     2. Copy the `google-site-verification=...` TXT record value provided by Google.
     3. Add the TXT record at the customer's DNS provider (Cloudflare / registrar DNS). Do not modify PunyaSitus CNAME records.
     4. Wait for DNS propagation and click **Verify** in GSC.
   - **Option B — URL-Prefix Property via HTML Meta Tag (No DNS edit required):**
     1. Select **URL prefix** and enter the exact verified primary origin including scheme and `www` if applicable (e.g., `https://www.example.id`).
     2. Under **HTML tag**, copy **only the plain token value** inside `content="..."` (never paste the full `<meta>` HTML tag).
     3. In PunyaSitus Admin: open **Menu Samping: `Plugin` -> `SEO & AI Autopilot` -> tab `Verifikasi Webmaster`** (also accessible from **`Beranda` -> `Plugin`**).
     4. Paste the plain token into **`Nilai Token Verifikasi (atribut content polos)`** under Google Search Console, then click **`Terbitkan Token Verifikasi`**.
     5. Confirm `curl -s https://<primary-host>/ | grep -i google-site-verification` renders `<meta name="google-site-verification" content="<token>" />`.
     6. Return to GSC and click **Verify**.
3. **Record Verification Locally:** In **Menu Samping: `Plugin` -> `SEO & AI Autopilot` -> tab `Verifikasi Webmaster`**, click **`Catat Verifikasi Eksternal Selesai`** for the verified hostname.
   - Before token publication, the badge displays **`Belum dikonfigurasi`**.
   - After publishing the token (before recording manual completion), the badge intentionally displays **`Terkonfigurasi (Belum terverifikasi eksternal)`**.
   - Only after an owner/admin records the completed external check does the badge display **`Terverifikasi eksternal (<primaryHost>)`**.

### Step 2.2 — Submit Primary Sitemap & Run Representative URL Inspections
1. In GSC left navigation, open **Indexing -> Sitemaps**.
2. Enter `sitemap.xml` (resolving to `https://<primary-host>/sitemap.xml`) and click **Submit**.
3. Confirm GSC reads the `<sitemapindex>` and discovers `/sitemaps/pages.xml`, `/sitemaps/posts.xml`, and `/sitemaps/offerings.xml` (only non-empty kinds appear). Never submit drafts, alias domains, or preview URLs.
4. Use **URL Inspection** on representative live URLs:
   - Homepage (`https://<primary-host>/`)
   - One primary service/product/tour/vehicle detail page
   - One published blog article (if blog is enabled)
   - One opted-in category archive (if enabled)
   - One nonexistent path (confirm `404` / not indexed)
5. Confirm **Test Live URL** shows: page fetchable (`200`), user-declared canonical matches `https://<primary-host>/...`, primary content visible in rendered HTML, and zero unexpected `noindex` or robots blocks.

### Step 2.3 — Domain-Switch Re-Verification Rule
Whenever a tenant changes its primary domain (e.g., moving from `<handle>.situsku.click` to `www.example.id` or switching custom domains):
- PunyaSitus automatically transitions the verification badge to **`Perlu verifikasi ulang (Domain berubah)`** (`recheck_required`, `PLAN.md §15.5`).
- The owner must add and verify the **new** primary property in GSC, submit `https://<new-primary-host>/sitemap.xml`, inspect migrated URLs, and record a new completion check on the new hostname. Old hostname verification never proves ownership of a new hostname.

---

## 3. Bing Webmaster Tools Manual Verification & Sitemap Submission

Perform these steps manually in the tenant owner's authorized Bing Webmaster Tools account:

1. Open [Bing Webmaster Tools](https://www.bing.com/webmasters) and sign in with the tenant owner's account.
2. Add the exact primary site URL (`https://<primary-host>`) using **one** method:
   - **Option A — Import from verified Google Search Console** (fastest if Step 2 is already complete).
   - **Option B — HTML Meta Tag (`msvalidate.01`):**
     1. Copy **only the plain hexadecimal token** from `content="..."` (never paste raw HTML).
     2. In **Menu Samping: `Plugin` -> `SEO & AI Autopilot` -> tab `Verifikasi Webmaster`**, paste the token into **`Nilai Token Verifikasi (atribut content polos)`** under Bing Webmaster Tools and click **`Terbitkan Token Verifikasi`**.
     3. Confirm `curl -s https://<primary-host>/ | grep -i msvalidate.01` renders `<meta name="msvalidate.01" content="<token>" />`.
     4. Click **Verify** in Bing Webmaster Tools.
   - **Option C — DNS CNAME/TXT** at the customer's DNS provider.
3. Open **Sitemaps -> Submit sitemap** and submit `https://<primary-host>/sitemap.xml`.
4. Run **URL Inspection** on the homepage and one offering detail page to verify crawlability and canonical selection.
5. Click **`Catat Verifikasi Eksternal Selesai`** in **Verifikasi Webmaster** to record the completed external Bing check (hostname + UTC timestamp).

### Optional Regional / Local Channels (Manual Owner Checklist)
- **Google Business Profile (GBP):** Align business name, address (or truthful service-area configuration without fabricating a private home address), phone/WhatsApp, opening hours, and website URL (`https://<primary-host>/`) manually. PunyaSitus does not provision GBP profiles automatically.
- **Yandex / Pinterest:** Configure only when the tenant's target market or channel explicitly warrants it.

---

## 4. Post-Launch Measurement Cadence (`PLAN.md §15.5`)

Capture a pre-launch baseline before opening the site to search engines, then review:
- **Weekly** during the **first 3 months** post-launch
- **Monthly** thereafter (and within 7 days after any primary-domain change, major theme switch, or catalog restructure)

| Signal Area | Source (Authorized Manual Report) | What to Check | Action Threshold |
|---|---|---|---|
| **Indexation Coverage** | GSC *Page Indexing* & Bing *Site Explorer* | Submitted vs indexed vs excluded counts; unexpected `noindex`, soft-404, or server `5xx` spikes | Investigate any published sitemap URL stuck in `Not indexed` due to `noindex` or `5xx` |
| **Canonical Selection** | GSC *Page Indexing -> Duplicate / Canonical* & URL Inspection | Google-selected canonical matches user-declared `https://<primary-host>/...` | Check for lingering alias links, trailing-slash links, or query-parameter links |
| **Crawl & HTTP Status** | GSC *Crawl Stats* & Bing *Crawl Information* | `404` spikes, redirect chains (`> 1` hop), `503` maintenance bleed, robots fetch errors | Fix broken internal links; verify former-slug `308` and domain alias redirects remain single-hop |
| **Structured Data & Rich Results** | Manual [Rich Results Test](https://search.google.com/test/rich-results) & Schema Markup Validator on live public URLs | Valid `@graph` syntax, visible-content parity (`LocalBusiness`, `Service`, `Product`, `Article`, `BreadcrumbList`), zero warnings from missing visible facts | Never fabricate ratings, reviews, private addresses, or merchant-listing fields to silence optional warnings |
| **Core Web Vitals & Mobile Layout** | GSC *Core Web Vitals* (field CrUX when available) & PageSpeed Insights (Mobile + Desktop) | LCP (non-lazy hero with dimensions), CLS, INP, mobile readability & horizontal overflow | Optimize oversized media or layout shifts; keep zero-JS crawlable content intact |
| **Search Performance & Leads** | GSC *Performance* (impressions, clicks, CTR by query & page type) + PunyaSitus consent-respecting WA/lead events | Separate discovery traffic from actual WhatsApp/form enquiries (**clicks are not sales**) | Refine page clarity, service proof, and internal links; never store PII in query strings or scrape webmaster sessions |

---

## 5. External Provider Outcomes Ledger (`UNVERIFIED` Until Manually Executed)

All live external provider checks remain explicitly **`UNVERIFIED`** until an authorized operator or tenant owner executes them against a live, authorized hostname and records the UTC timestamp and evidence below. Never paste API keys, passwords, session cookies, or customer PII in this table.

| External Verification / Launch Outcome | Target Hostname | Status | Executed At (UTC) | Operator / Owner | Evidence / Notes |
|---|---|---|---|---|---|
| Automated crawl regression (`tests/task-054` unit + workerd + e2e) | Synthetic local workerd & compiled Astro fixtures | `LOCAL_ONLY` (re-run per release) | `pending release SHA` | `<operator>` | Synthetic tenants only; does not prove live external crawl |
| Google Search Console ownership verification (DNS TXT or HTML meta) | `https://<primary-host>` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Manual GSC verification not yet executed |
| Google Search Console sitemap submission (`sitemap.xml`) | `https://<primary-host>/sitemap.xml` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Manual GSC submission not yet executed |
| GSC URL Inspection (homepage, offering, blog, archive, 404) | `https://<primary-host>/*` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Manual live URL inspection not yet executed |
| Bing Webmaster Tools ownership verification (HTML meta / DNS / GSC import) | `https://<primary-host>` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Manual Bing verification not yet executed |
| Bing Webmaster Tools sitemap submission (`sitemap.xml`) | `https://<primary-host>/sitemap.xml` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Manual Bing submission not yet executed |
| Manual Rich Results Test / Schema Validator check on authorized public URLs | `https://<primary-host>/*` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | External validator not yet executed against live host |
| Field Core Web Vitals & 30-day post-launch indexation / lead review | `https://<primary-host>` | **`UNVERIFIED`** | `pending` | `<owner-or-operator>` | Requires live field traffic after launch; no ranking guarantee |
| Google Business Profile (GBP) manual alignment checklist | `https://<primary-host>` | **`UNVERIFIED`** | `pending` | `<owner>` | Owner manual alignment check not yet executed |
