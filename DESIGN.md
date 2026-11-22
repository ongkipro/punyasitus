# PunyaSitus Design and Component Contract

> Status: merged visual, component and responsive contract (2026-11-18, DEC-035 & DEC-036). Product/workflow authority: `PRD.md` and `PLAN.md`. Admin & portal UI is standardized on **`shadcn/ui` v4 preset `base-nova` (`@base-ui/react`)**. `TASK-032` validates this direction with executable shell fixtures before dependent UI screens run.

## 1. Direction and Two Presentation Layers

PunyaSitus separates **two presentation layers** (CMSPRO DEC-050, DEC-051):

1. **Admin, Portal & Console Layer (`app.punyasitus.com` & `console.punyasitus.com`):** Minimalist, data-first editorial and operational workspace built on **`shadcn/ui` `base-nova`** (`@base-ui/react` + Tailwind CSS v4). Neutral surfaces, one restrained accent, flat `1px` borders, type-led hierarchy, compact data tables, explicit draft/publish controls, and a persistent context bar. No gradients, glassmorphism, decorative bento grids, nested cards, or ornamental charts.
2. **Public Tenant & Platform Marketing Layer (`*.situsku.click`, custom domains, and `punyasitus.com`):** Pure Astro HTML/CSS (`0 KiB` React by default, `<= 25 KiB` gzip JS budget), fluid from `320px` to `2560px` (`clamp()` typography and spacing, container-query grids, breakpoints only at content-failure points `768`, `1024`, `1536`, reserved media aspect ratios, and no fourth column above `1536px`).

References for implementation research: [WordPress Administration Screens](https://wordpress.org/documentation/article/administration-screens/) for familiar CMS IA; [shadcn/ui Base UI components](https://ui.shadcn.com/docs/components) (`base-nova`) for accessible primitives; [Tailwind CSS v4 theme variables](https://tailwindcss.com/docs/theme); plus our own Lighthouse & Indonesian vertical research in `punyasitus-docs/docs/research/cmspro/01-market-and-mobile-research.md`, `02-design-direction-proposal.md` and `03-vertical-needs.md`.

## 2. Visual Tokens

### 2.1 Admin, Agency, Affiliate & Console Tokens (`base-nova`)

Shared across `/dashboard/{handle}`, `/agency`, `/affiliate` (`app.punyasitus.com`) and `console.punyasitus.com`, mapped via CSS variables in `apps/web/src/styles/admin/globals.css` (`@import "tailwindcss"; @import "tw-animate-css"; @import "shadcn/tailwind.css";`):

| Token | Value / use |
|---|---|
| `background` / `foreground` | `#f8faf9` / `#182522` |
| `card` / `muted` | `#ffffff` / `#eef3f0` |
| `muted-foreground` | `#52635c`; secondary text, never placeholder-only labels |
| `border` / `input` | `#d9e2dd`; structural `1px` dividers, never a focus indicator |
| `primary` / `primary-foreground` | `#176b51` / `#ffffff` |
| `destructive` | `#b42318`; action text plus explicit consequence |
| `warning` | `#854d0e` on `#fef3c7`; always paired with text/icon |
| `ring` (focus) | `#176b51`, `2px` outline with `2px` offset |
| `radius` | `base-nova` crisp scale (`4px` badges, `6px` controls, `8px` overlays/dialogs) |
| `spacing` | `4px` base; `8/12/16/24/32px` rhythm; measured against `punyasitus-docs/docs/archive/cmspro/admin-contract.json` (`volum-default` geometry) |

Admin typography: self-hosted **Plus Jakarta Sans** (`400`, `500`, `600`); body `14px`, mobile form inputs `>= 16px` (prevents iOS zoom), page title `24px`, section heading `18px`, metadata `12px`. Mandatory `font-variant-numeric: tabular-nums` on IDR amounts, quotas, counts and timestamps. Light mode is the v1 baseline; tenant brand colours never recolour admin status or permission indicators.

### 2.2 Public Site Brand-Colour Contrast & Typography Rules

- **Automatic contrast guard (CMSPRO DEC-033):** Tenant brand colours are automatically adjusted and disclosed so foreground text always achieves `>= 4.5:1` contrast. Dark "on-accent" neutral is near-black `#050505` (luminance `<= 0.00185`, proven across 10,000 brand colours in `02-design-direction-proposal.md`).
- **WhatsApp action colour:** `#0B6B3A` with high-contrast label; one shared bottom dock coordinates the floating WhatsApp widget and the consent banner so neither covers form errors or mobile navigation.
- **Public font budget (DEC-035 C14, REQ-020):** Public sites default to the zero-download **system font stack** for instant 4G rendering. Each platform/custom theme may bundle at most **one** self-hosted Latin variable font (`font-display: swap`/optional, counted inside the route budget), and owners can switch on a **"Mode tercepat (font sistem)"** toggle at any time.

## 3. Shells, Surfaces and Screen Patterns

### 3.1 Four Host-Separated Surfaces

| Host & Path | Surface | Shell & Context Indicator |
|---|---|---|
| `app.punyasitus.com/dashboard/{handle}/...` | Tenant CMS Admin | Persistent tenant switcher + status badge (`Trial`, `Aktif`, `Masa Tenggang`, `Terkunci`); when entered by an agency user (`REQ-083`), shows a prominent persistent client-context bar ("Mengelola klien: {Nama Bisnis}") |
| `app.punyasitus.com/agency/...` | Agency / Reseller Portal (`REQ-083`) | Client tenant list, trial-cap meter (`<= 3` unpaid trials before first paid client), discount badge, create client, consolidated billing |
| `app.punyasitus.com/affiliate/...` | Affiliate Portal (`REQ-086`) | Referral link & copy button, funnel counts (visits, signups, trials, masked paying tenants), commissions (`pending`, `approved`, `reversed`), next payout (`15` / `30`) & history |
| `console.punyasitus.com/...` | Superadmin Console (`REQ-049`) | Host-isolated (`__Host-` cookie, Google allowlist + TOTP); header always states **Console Operasional Platform**; explicit tenant detail view, never impersonation |

### 3.2 Desktop vs Mobile Web-App Shell & Minimalist WordPress-Familiar Sidebar (`CMSPRO DEC-050`, `DEC-037`)

- **Desktop `>= 1024px`:** `256px` left sidebar, `56px` top bar, `24px` canvas padding, content max `80rem`.
- **Clean, Selling-Focused Sidebar Navigation (9 top-level items max):** Familiar to WordPress users while eliminating clutter:
  1. **Beranda** (conversion overview: leads, WA clicks, Google/AI traffic, readiness checklist)
  2. **Pesan Masuk** (leads inbox — placed near top because leads = revenue)
  3. **[Penawaran Bisnis]** (**adaptive vertical label**: shows only the primary offering type chosen at onboarding — `Layanan`, `Produk`, `Paket Tur`, or `Kendaraan`; additional offering types stay tucked away until enabled in `Pengaturan`)
  4. **Halaman** (pages, conversion sections & custom forms)
  5. **Artikel** (blog SEO)
  6. **Media** (WebP photos, short videos, YouTube)
  7. **Tema** (**dedicated top-level sidebar menu**: Style Variants, **Gratis**, **Berbayar / Premium**, and **Custom Dev**)
  8. **Plugin** (**dedicated top-level sidebar menu**: Terpasang, **Gratis**, **Berbayar / Pro**, and **Custom Dev** — installed plugins render settings strictly inside `/dashboard/{handle}/plugins/{pluginId}` and NEVER inject extra top-level sidebar items)
  9. **Pengaturan** (Profil, Cabang, Menu Navigasi, GTM & Pixel, Domain, Anggota, Tagihan, Layanan Terima Beres — sedangkan pengaturan SEO & AI dikemas bersih di dalam plugin gratis `seo-ai-autopilot`)
- **Tablet `768–1023px`:** `48px` icon rail (labels on focus/tooltip) + retained location indicator.
- **Mobile `< 768px` (Web-App Mode):** `56px` top app bar + **5-slot bottom tab bar** (`Ringkasan`, `Konten`, `Pesan masuk`, `Tema & Plugin`, `Lainnya`), `16px` padding, full-screen list-to-detail push navigation, sticky bottom save/publish bar that never obscures inputs, `>= 44px` touch targets, zero horizontal page overflow.

### 3.3 Core Screen Structures

| Screen | Primary structure | Mobile transformation |
|---|---|---|
| Tenant overview (`REQ-093`, `REQ-073`) | First-run readiness checklist + GBP copy-ready card, on-demand lead summary card (last 7d, prev 7d, `new`), cookieless insights card ("Paling diminati", sources incl. AI assistants, peak hours), domain/service status | Single-column priority stack |
| Offerings (`REQ-012`, `REQ-079`) | Typed tabs/lists for `Layanan` (`/layanan`), `Produk` (`/produk`), `Paket Tur` (`/tour`), `Kendaraan` (`/kendaraan`); cover + 12-photo gallery, `fixed`/`from`/`range`/`on_request` IDR pricing, `whatsapp`/`external_link`/`inquiry`/`book` CTA; `vehicle` adds unit status (`available`/`booked`/`sold`) and static credit-estimate config | Row summary + expandable attributes; sticky save bar in editor |
| Pages & section composer (`REQ-008`, `REQ-019`) | Ordered 1D section list from the closed registry with `Tampilkan/Sembunyikan` and keyboard `Naik/Turun` controls (no drag-and-drop, no nested containers) + live inert preview (`PLAN` §14) | `Edit` / `Pratinjau` tabs sharing one draft state |
| Blog & rich-text editor (`REQ-009`, `REQ-092`) | Restricted **TipTap** (MIT core) island (`H2–H4`, paragraphs, bold/italic, lists, blockquote, links, own WebP image + ALT, table, own MP4 video & YouTube block) + publication/category/byline/SEO inspector | Inspector panels stacked cleanly below editor |
| Custom form builder (`REQ-080`) | Google-Form style vertical field list (up to 10 forms, 12 fields, closed types, **no drag-and-drop**), 6 vertical starter templates, 1-level conditional rule ("Tampilkan X jika Y = Z"), after-submit action (`Teks sukses`, `Lanjut ke WhatsApp dengan ringkasan`, `URL`) | Single-column card list with move-up/down buttons |
| Appearance & 6+1 theme catalog (`REQ-018`, `REQ-063`) | 6 platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) with "Direkomendasikan" badges + granted custom themes + Custom Theme & Terima Beres (`REQ-070`) service cards | Card stack; lossless preview before activation |
| Console (`console.punyasitus.com`) | Exceptions first (failed jobs, stuck/blocked domains, billing review/anomalies, abuse reports `REQ-094`), Tenants, Agencies, Affiliates & Payout Batches, Prices/Coupons (`REQ-082`), Service Packages, Funnel (`REQ-087`), Operators, Audit, Health | Priority columns + dedicated confirmation routes for state/payout mutations |

## 4. `shadcn/ui` (`base-nova`) and Tailwind CSS v4 Contract (DEC-036)

All admin, agency, affiliate and console interactive islands use **`shadcn/ui` v4 preset `base-nova`** on **Tailwind CSS v4** and **React 19**.

### 4.1 Locked `apps/web/components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/admin/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks",
    "utils": "@/lib/utils"
  }
}
```

### 4.2 Non-Negotiable `base-nova` Rules

1. **Single primitive library (`@base-ui/react` only):** `base-nova` is built on **Base UI** (`@base-ui/react`), **not** Radix UI. Installing `radix-ui` or `@radix-ui/*` packages or pasting Radix-based snippets is forbidden (enforced by a CI dependency/import guard test in `TASK-032`).
2. **Base UI composition (`render` prop, never `asChild`):** Base UI primitives compose elements via the `render` prop (for example `<Button render={<a href="/..." />}>...</Button>`), **not** Radix's `asChild`. Always run `pnpm dlx shadcn@latest info --json` and `pnpm dlx shadcn@latest docs <component>` before authoring unfamiliar primitives.
3. **`rsc: false` in Astro:** Astro React islands hydrate on the client; `"rsc": false` prevents Next.js-specific server assumptions.
4. **Strict surface isolation:** `apps/web/src/components/ui/**` and `apps/web/src/styles/admin/globals.css` are imported **only** by `app.punyasitus.com` and `console.punyasitus.com` layouts/islands. Public tenant themes (`apps/web/src/themes/**`) and `punyasitus.com` marketing pages never import `@base-ui/react` or admin stylesheets.
5. **Server HTML first:** Astro server pages own protected initial reads and pass serializable props to islands. Hydrate only interactive regions (tables, forms, dialogs, TipTap editor, customizer, command/navigation sheets); static headings and read-only summaries remain server HTML.

## 5. TypeScript Contract

All Worker, Durable Object, Container and shared package code uses strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, no implicit `any`, no trust-boundary `as any` or `!` assertions). Parse every HTTP body, URL param, stored JSON column and external provider response through shared runtime schemas in `packages/core`. Use discriminated unions for offering types (`service` | `product` | `tour` | `vehicle`), CTA types, lifecycle states (`trial` | `active` | `grace` | `locked` | `suspended` | `recovery` | `purging` | `purged`), domain states and job outcomes. Run both `astro check` and `tsc --noEmit` across workspaces.

## 6. States, Accessibility and Acceptance

Every admin/portal screen implements: initial loading, ready, genuinely empty, filtered-empty (with reset), retryable error, permission denial, pending mutation and `409` stale-write conflict. Preserve user input on validation/network failure; never persist sensitive form data in `localStorage`.

Accessibility (WCAG 2.2 AA): named controls, visible `#176b51` focus ring, keyboard `Escape`/focus-return on dialogs/sheets, explicit `Naik`/`Turun` buttons wherever ordering exists (WCAG 2.5.7 — zero drag-only interactions), `200%` zoom, `prefers-reduced-motion`, and `360px` / `768px` / `1440px` layouts. Indonesian UI labels use clear verbs (`Simpan draf`, `Terbitkan`, `Tangguhkan situs`, `Ekspor CSV`).

## 7. Six Platform Themes, Public Composition & Vertical Rules

The six platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`, REQ-018) pair with the **7 research-backed B2B Vertical Conversion Blueprints** (`punyasitus-docs/docs/research/cmspro/04-b2b-conversion-blueprints.md`, `REQ-093`) so onboarding configures the exact section sequence, contextual credential prompts, Indonesian field micro-prompts (never generic *Lorem Ipsum*), starter inquiry form, and `wa.me` template for the client's business model with zero guesswork:

| Theme / Vertical | Focal hierarchy & key rules | Responsive & regulatory guardrails |
|---|---|---|
| `compro` (Corporate / B2B Compro) | Identity & value proposition, authentic hero media, capabilities, portfolio/case studies, verifiable credentials (`NIB`/licences optional), branches & B2B inquiry | 5:7 desktop hero split; mobile heading/offer first; no text-over-photo with `< 4.5:1` contrast |
| `sales` (Sales Compro, Personal Branding & Services) | Personal/specialist credibility (sales executives, property/auto/insurance agents, doctors, lawyers, consultants, speakers), `fixed`/`from`/`on_request` pricing, "Cara Kerja" steps, licences/certifications (`SIP/STR`), FAQ, consultation form/WA | Clinic/health categories default `testimonials` to **off** with Permenkes warning & sensitive-data notice on forms; law/notary presets use informational tone; pages support **Landing Page Focus Mode** (hiding top/footer nav for ad traffic) |
| `travel` (Travel & Umrah Agency — **NOT OTA/Ticketing**) | Agency profile & package destination, honest gallery, duration ("3 hari 2 malam"), transport/accommodation/insurance & `SK Kemenag PPIU/PIHK` facts (Permenpar 6/2025), day-by-day itinerary, sticky price + WA/inquiry card | Desktop sticky summary card beside itinerary; mobile non-obstructive summary bar; **never a ticketing/OTA portal and zero fake seat-quota / scarcity bars** |
| `catalog` (Product Showcase -> Closing via WA) | Category filters, multi-photo product cards, IDR `fixed`/`from`/`range`/`on_request` + negotiable badge, direct **WhatsApp (`wa.me`)** or marketplace link-out tailored by the site owner | 3 cols desktop, 2 tablet, 1 narrow phone; never implies cart/checkout |
| `resto` (Offline Compro / F&B / Multi-Branch Outlets) | Physical-business profile + menu/service showcase, up to 10 branch cards (`REQ-088`) with weekday/holiday hours & static Maps links, walk-in/WA CTA | Directions & phone/WA work with zero JS; map iframe loads only on click |
| `dealer` (`vehicle`, `REQ-079`) | Filterable showroom (`new`/`used`, brand, body type incl. matic/bebek/sport/crossover/double cabin), 12-photo gallery, unit specs, `available`/`booked`/`sold` badge (`TERJUAL` stays indexable if kept), static server-rendered credit-estimate table with mandatory disclaimer, test-drive form / WA | Credit table uses integer Rupiah math, zero client JS, shown only on `available` + `fixed` price units |

YouTube blocks (`REQ-089`) and self-hosted short videos (`REQ-062`, `<= 10 MB`) always render click-to-play with a WebP poster, reserved aspect ratio, and visible disclosure before any third-party connection.

### Style Variants & Symmetric Sidebar Storefronts for `Tema` and `Plugin` (`REQ-096..099`, `DEC-037`)

Both **`Tema`** and **`Plugin`** are top-level sidebar destinations sharing one clean, conversion-oriented 3-tier layout (`shadcn/ui` `base-nova` tabs & flat bordered cards):

- **One-Click Style Variants (`Tema -> Sesuaikan`, `REQ-096`):** Each of the 6 built-in themes exposes at least **4 curated Style Variants** (*Clean Modern*, *Bold Corporate*, *Warm Heritage*, *High-Conversion*, *Dark Showroom*). Clicking a variant swaps WCAG-AA-verified colors, font pairing (`<= 1` custom font), border radius and header/card density with 0% content loss.
- **`Tema` Sidebar Storefront (`REQ-096`, `REQ-063`):**
  1. **Gratis / Bawaan** — all 6 vertical themes + style variants (`Gratis`).
  2. **Berbayar / Premium** — `Beli Sekali` IDR badge, live draft preview button (*"Pratinjau di situs saya"*) before purchase, QRIS/VA checkout unlocking immediate activation.
  3. **Custom Dev** — displays any `custom-<slug>` theme already built for this client/agency, plus the **Pesan Desain Tema Custom** packages & quote request form (`service_kind = "custom_theme"`).
- **`Plugin` Sidebar Storefront (`REQ-097..102`):**
  1. **Terpasang & Gratis** — 1-click `Pasang` / `Atur` / `Nonaktifkan` for official free plugins: **`seo-ai-autopilot`** (*SEO & AI Otomatis Tanpa Setting* — auto `sitemap.xml`, AI `robots.txt`, programmatic meta/OG, Schema `@graph`, `IndexNow`), **`bio-links`** (`/link` page), **`wp-importer`** (WordPress draft importer), and **`lead-notifier`** (**1-click `"Hubungkan Telegram"`** via `t.me/<Bot>?start=<token>` requiring zero manual `chat_id` lookup). All active plugin settings open cleanly inside `/dashboard/{handle}/plugins/{pluginId}`.
  2. **Berbayar / Pro** — clear Indonesian value summary, `Sekali Bayar` or `+Rp X/bulan` pricing, permission disclosure, and QRIS/VA checkout (`wa-cs-rotator` multi-agent WA distribution, `lead-notifier` CRM/Google Sheets webhook). Disabling a plugin reassures: *"Data pengaturan plugin tetap tersimpan aman jika diaktifkan kembali."*
  3. **Custom Dev** — displays any `private_client` bespoke plugin granted to this client/agency, plus the **Pesan Fitur / Plugin Custom** packages & requirement submission form (`service_kind = "custom_plugin"`), managed by superadmin at `console.punyasitus.com/plugins`.

## 8. Media, SEO Editorial & Visibility Surfaces

- **Media uploader (`REQ-010`, `REQ-062`, `REQ-064`):** Image controls state *"Maksimal 5 MB per foto (JPG, PNG, WebP, HEIC, GIF, TIFF, AVIF); dioptimalkan otomatis ke WebP <= 2 MB."* (Client Canvas converts AVIF before upload; SVG and BMP are rejected). Video controls state *"Maksimal 10 MB per video (MP4, MOV, WebM; maks 20 video). Untuk video panjang gunakan tautan YouTube."* Header displays *"Terpakai X MB dari Y"* (`100 MB` trial, `1 GB` paid/grace/locked) with an `80%` warning.
- **Zero-Config SEO & AI Autopilot Plugin (`seo-ai-autopilot`, `REQ-052..055`, `REQ-066`, `REQ-093`, `REQ-095`, `REQ-102`, `DEC-039`):**
  - **When `seo-ai-autopilot` is NOT installed/disabled:** Page, Offering, and Blog editors show **zero SEO form fields** so non-technical owners face zero clutter.
  - **When `seo-ai-autopilot` IS active (pre-installed on every new website per DEC-042, `Gratis`, removable in 1 click):** Works **100% automatically with zero required settings** from the site's B2B Blueprint (`REQ-093`) and content fields (auto `sitemap.xml` + Image Sitemap, AI-aware `robots.txt`, programmatic Title/Meta, `< 300 KiB` `1200x630` WebP WhatsApp OG, Schema `@graph` + HTML AI Fact-Sheets, `IndexNow`). Inside content editors, manual overrides stay tucked inside a single **collapsed optional accordion** (*"SEO & AI Otomatis Aktif — Klik jika ingin ubah manual"*) opening tabs **Umum**, **Sosial**, **Skema & Fakta AI**, and **Lanjutan**. Global controls (Search Console / Bing Webmaster tokens, AI training-crawler toggle, `IndexNow` status, and the 1-click **"Salin Data untuk Google Business Profile & Bing Places"** card) live cleanly inside `/dashboard/{handle}/plugins/seo-ai-autopilot`. Redirect manager & 404 monitor (`REQ-067`) are badged for release 1.1.

## 9. Billing, Coupons, Receipts & Full Lifecycle Surfaces (`DEC-035`)

Subscription billing (`REQ-056..058`, `REQ-081..082`) is visible **only** to the payer (the tenant owner, or the agency billing users for an agency-managed tenant; client users of an agency tenant see no billing UI).

- **Plans & Checkout:** Monthly (`Rp 179.000 / bulan`) and Yearly (`Rp 1.790.000 / tahun` — hemat 2 bulan) reading live platform settings; single coupon input with server-validated discount breakdown; payment channels strictly **QRIS** (unmodified EMVCo QR + accessible instructions) and **Bank Virtual Account** (bank selector, copyable VA number, exact total, expiry). Displays *"Belum termasuk PPN (non-PKP)"*, separate AutoLaris channel fee line, and *"Tidak ada pengembalian dana untuk pembatalan sepihak; pembayaran ganda/salah bayar dikembalikan manual melalui verifikasi admin."*
- **Receipts (`REQ-081`):** Every settled payment lists a downloadable immutable numbered PDF receipt (*Bukti Pembayaran Layanan*).

### Lifecycle Screen & Access Matrix (`REQ-059`, `REQ-060`, `REQ-069`)

| State & Window | Public Site (`*.situsku.click` / custom domain) | Dashboard (`app.punyasitus.com`) | Primary Action |
|---|---|---|---|
| **Register / Verify** (`REQ-090`) | — | **"Masuk dengan Google"** primary button + email/password fallback, Turnstile, handle `.situsku.click` check | 1-click Google signup or email verify -> 7-day trial |
| **Trial** (7 days, `168h`) | Live on `<handle>.situsku.click` only, `noindex, nofollow`, trial banner | Full CMS (`100 MB` quota, custom domain locked until paid); reminders at H-3 & H-1 | Upgrade to Monthly/Yearly |
| **Active** (Calendar month / year) | Live, indexable, custom domain enabled | Full CMS (`1 GB` quota); reminders at H-3, H-1 & H0 with 1-click pay link | Normal operation / early renewal |
| **Grace** (`H+1..H+3`) | **Live & indexable** | **Full CMS editable** + persistent amber overdue banner with exact `H+4` lock timestamp | Pay renewal (1-click link or billing screen) |
| **Locked** (`H+4..H+7`) | **Still live & indexable** (protects client SEO!) | **Read-only CMS**: view content, export leads CSV, pay renewal, sign out; all mutations disabled with clear explanation | Pay renewal before `H+8` suspension |
| **Suspended** (`H+8..H+44`, unpaid trial end, or operator hold) | HTTP `503` + `no-store` + `noindex`: heading *"Situs dalam perbaikan"*, body *"Situs ini sementara tidak dapat diakses. Silakan kembali lagi nanti."* | Standalone **Payment & Recovery shell** (payer: pay, receipts, **leads CSV export**, deletion date `H+45` or `Trial+30d`; non-payer: contact owner/agency) | Pay renewal (restores `Active` immediately unless under operator hold) |
| **Destroyed** (`H+45` paid / `Trial+30d` unpaid, warnings `H+38/42/44` or `-7/-3/-1`) | HTTP `404` | Tombstone / deleted notice; residual de-identified payment records kept for audit | Create a new website |

## 10. Security, AI, MCP & Abuse Surfaces

| Surface | Contract |
|---|---|
| **Google Sign-In & TOTP (`REQ-090`, `REQ-068`)** | Google primary button; mandatory TOTP enrollment + single-use backup codes for `console.` operators and `agency_admin`; optional TOTP for tenant users; 10-minute step-up verification dialog before destructive/money/operator actions |
| **AI Writing Assistant (`REQ-075`)** | Inline *"Bantu tulis"* button on title, excerpt, offering description and meta description; blocks prompts containing emails/phone numbers; shows *"Sisipkan / Ubah / Buang"*, fact-check reminder, and *"x dari 100 saran tersisa"* |
| **MCP OAuth Consent & Publish Approval (`REQ-076`)** | Indonesian OAuth consent screen on `app.punyasitus.com/auth/consent` selecting **one** website and scopes (extra PII box for `leads:read`); revocation table at `Akun > Aplikasi AI terhubung`; one-time human publish-approval screen showing draft preview & diff |
| **GTM Setup & Risk Dialog (`REQ-027`)** | Per-vendor `Langsung` vs `Melalui GTM`, downloadable container JSON template, Indonesian guide, and owner-only audited risk acknowledgement dialog |
| **Public Abuse Report (`REQ-094`)** | Lightweight footer/public report form (URL, category, optional contact + Turnstile) feeding the `console.punyasitus.com/abuse` queue; tenant admin single-lead permanent delete confirmation + read-only tenant activity log |
| **Domain Connect Wizard (`REQ-043`, `DEC-040`)** | Settings > Domains asks "Apakah situs di domain ini sudah live di tempat lain?" and shows one of three flows: **Domain baru** (1 CNAME), **Pindahan tanpa downtime** (step 1 records while the old site stays live, step 2 waiting until the certificate and hostname are both active, step 3 CNAME locked until then, plus a visible rollback note), or **Domain di Cloudflare** (create first, then proxied CNAME with `Full`/`Full (strict)` hint). Every record row shows type, name, value, purpose, status, last-checked time and a copy button; the ownership TXT is marked removable and the delegation CNAME is marked permanent |