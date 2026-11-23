# Custom Theme Development Guide

> Audience: developers and AI agents building a custom brand or agency theme for a PunyaSitus client.
> Contracts: `PLAN.md` §2, §7.3, §8, §11.4, §14, §15; `ADR-0003`, `ADR-0009`, `ADR-0010`; `REQ-001`, `REQ-018`–`REQ-021`, `REQ-040`, `REQ-046`, `REQ-063`, `REQ-066`, `REQ-096`.
> Reference implementation: [`apps/web/src/themes/custom/sample-agency/`](../../apps/web/src/themes/custom/sample-agency/) registered in [`apps/web/src/core/theme-registry.ts`](../../apps/web/src/core/theme-registry.ts).

## 1. Architecture & Frozen Core Rule

Custom themes are **trusted Astro code reviewed and bundled at build time** inside the `punyasitus-web` Cloudflare Worker. Under the **Frozen Core** rule (`ADR-0010`), client visual presentation lives strictly inside `apps/web/src/themes/custom/<slug>/` while core CMS, database, auth, SEO, consent, and security remain owned by the shared platform shell.

Three theme tiers exist:

1. **Built-in Platform Themes (`included`):** `compro`, `sales`, `travel`, `catalog`, `resto`, `dealer` — available to every tenant.
2. **Premium Marketplace Themes (`paid_once`):** unlocked per website upon confirmed payment.
3. **Bespoke Client / Agency Themes (`custom-<slug>`):** live in `apps/web/src/themes/custom/<slug>/`, explicitly registered in `apps/web/src/core/theme-registry.ts`, and routed only to tenants with a verified direct tenant grant (`tenantId`) or matching agency grant (`agencyId`).

**Prohibited everywhere:** theme `.zip` uploads, runtime Git pulls, dynamic `import(userInput)`, `eval()`, `new Function()`, and remote HTTP(S) module imports.

## 2. Folder Layout

Follow the exact layout demonstrated by `apps/web/src/themes/custom/sample-agency/`:

```text
apps/web/src/themes/custom/<slug>/
  theme.ts              CustomThemeRegistrationManifest (`id: "custom-<slug>"`, tokens, variants, routes, sections)
  Layout.astro          Theme frame wrapped strictly inside `../../default/Layout.astro` + `<SEOHead>`
  RouteDispatcher.astro Optional dispatcher mapping all 7 `PublicThemeRouteKind` routes inside `Layout.astro`
  pages/
    types.ts            Pure presentation DTO props
    Home.astro          `home` (`/`)
    Page.astro          `page` (`/{pageSlug}`)
    PostList.astro      `blog_index` (`/blog`)
    Post.astro          `blog_post` (`/blog/{slug}`)
    OfferingList.astro  `catalog_index` (`/layanan`, `/produk`, `/tour`, `/kendaraan`)
    OfferingDetail.astro `catalog_detail` (`/{type}/{slug}`)
    NotFound.astro      `not_found` (404 recovery view; always `noindex, nofollow`, zero canonical/JSON-LD)
  sections/
    SectionRenderer.astro Delegates every closed section type (`REQ-019`) to `../../default/sections/SectionRenderer.astro`
  styles/
    theme.css           Scoped under `[data-ps-custom-theme="custom-<slug>"]` (zero admin CSS)
  README.md             Client scope, palette/contrast notes, JS budget, changelog
```

## 3. Build-Time Registration Contract (`theme-registry.ts`)

Every custom theme MUST be registered by **explicit static import** in [`apps/web/src/core/theme-registry.ts`](../../apps/web/src/core/theme-registry.ts):

```ts
import { SAMPLE_AGENCY_THEME_MANIFEST } from "../themes/custom/sample-agency/theme.ts";

export const REGISTERED_CUSTOM_THEMES = buildCustomThemeEntries([
  SAMPLE_AGENCY_THEME_MANIFEST,
]);
```

Registration invariants enforced at module load time:

- `id` MUST match `ThemeIdSchema` (`custom-<slug>`, lowercase ASCII alphanumeric segments separated by single hyphens, 1–50 slug chars).
- `supportedRoutes` MUST include all 7 public routes: `home`, `page`, `blog_index`, `blog_post`, `catalog_index`, `catalog_detail`, `not_found`.
- `supportedSectionTypes` MUST include every type in `CLOSED_SECTION_TYPES` (`REQ-019`) so switching between any built-in theme and a custom theme is 100% lossless.
- `defaultTokens` and `defaultVariants` MUST validate cleanly against `ThemeTokensSchema` and `ThemeVariantsSchema` (`@punyasitus/core/theme/index`) with WCAG 2.2 AA (`>= 4.5:1`) contrast.

## 4. Entitlement, Agency Routing & Safe Fallback

All public route rendering resolves the theme through `resolveTenantTheme()` and `buildPublicThemeRouteShellContract()`:

- **Built-in platform themes (`compro`..`dealer`)** are always granted (`grantSource: "platform_included"`).
- **Custom themes (`custom-<slug>`)** require either:
  - A direct tenant grant matching `grant.tenantId === input.tenantId` (`grantSource: "tenant_grant"`), or
  - An agency grant matching a non-empty `grant.agencyId === input.agencyId` and optional `ownerAgencySlug` (`grantSource: "agency_grant"`).
- **Two-tenant isolation:** A grant record belonging to Tenant A is strictly ignored for Tenant B.
- **Safe fallback:** Unknown, malformed, path-traversal, or ungranted theme IDs NEVER crash SSR or expose another tenant's theme — they fall back cleanly to the tenant's verified platform default (`compro`), setting `fallbackUsed: true` and `operatorAlertRequired: true`.

## 5. Shared Security, SEO, Schema.org & Consent Shell

Every custom theme `Layout.astro` MUST wrap `../../default/Layout.astro` and mount `<SEOHead slot="head" ... />` using the `PublicThemeRouteShellContract` built by `buildPublicThemeRouteShellContract()`:

- **Head & SEO (`TASK-016`, `TASK-051`, `REQ-066`):** `<SEOHead.astro>` owns canonical URLs, `robots`, Open Graph, and Twitter tags. Preview, trial, `siteVisibility: "noindex"`, and `not_found` routes ALWAYS emit `noindex, nofollow` and omit `<link rel="canonical">` and `og:url`.
- **Structured Data (`TASK-015`):** Schema.org `@graph` JSON-LD is generated centrally from verified visible facts and automatically suppressed on `not_found`, preview, or non-serving routes.
- **Consent (`TASK-012` / `TASK-031`):** `<Consent.astro>` is owned by `DefaultLayout`; optional scripts and embeds never load before affirmative consent.
- **Token Security (`TASK-012` / `TASK-027`):** `buildSafeThemeStyleBlock` validates all theme tokens server-side, enforces WCAG AA `>= 4.5:1` contrast, neutralizes hostile CSS (`url(`, `expression(`, `</style>`, `<script>`), and injects inline CSS custom properties in `<head>` before `<body>` (zero FOUC).

## 6. Allowed vs Forbidden Imports (Static Import Guard)

`auditCustomThemesStaticImports()` in [`apps/web/src/core/theme-registry.ts`](../../apps/web/src/core/theme-registry.ts) scans every source file under `apps/web/src/themes/custom/**` and **FAILS** on any violation.

| Category | Allowed | Forbidden (Blocked by Static Guard) |
|---|---|---|
| Core types & pure helpers | `@punyasitus/core/theme/index`, `@punyasitus/core/content/index`, `@punyasitus/core/schemas/common`, `../../../core/section-registry.ts`, `../../../core/theme-registry.ts` (type-only) | `@punyasitus/db`, `@punyasitus/auth`, `drizzle-orm`, `packages/db/*`, `packages/auth/*` |
| Runtime & bindings | Pure Astro SSR templates and scoped CSS | `cloudflare:workers`, `cloudflare:*`, `node:*`, bare Node built-ins (`fs`, `path`, `child_process`, etc.), `PLATFORM_DB`, `TENANT_STORE`, `process.env` |
| UI & styling | `../../default/Layout.astro`, `../../default/sections/SectionRenderer.astro`, `../../../components/SEOHead.astro`, scoped `styles/theme.css` | `@radix-ui/*`, `radix-ui`, Radix `asChild` prop, `@base-ui/*`, `components/ui/*`, `styles/admin/*`, `worker/*`, `middleware/*` |
| Code execution & SEO | Static build-time imports only | Dynamic `import(...)`, `eval(...)`, `new Function(...)`, remote `http(s)://` imports, raw `<link rel="canonical">`, `<meta name="robots">`, `application/ld+json`, third-party tracker scripts |

## 7. Token Overrides, Section Slots & Quality Budget

- **Token Overrides:** Declare safe defaults in `theme.ts` (`defaultTokens` + `defaultVariants`) and scope visual rules in `styles/theme.css` under `[data-ps-custom-theme="custom-<slug>"]`. Tenant brand color overrides pass through `buildSafeThemeStyleBlock` automatically.
- **Section Slots:** Re-export or wrap `../../default/sections/SectionRenderer.astro` for every closed section kind (`hero`, `features`, `offerings_grid`, `rich_text`, `gallery`, `testimonials`, `faq`, `blog_latest`, `cta_banner`, `contact_location`, etc.).
- **No-JS & Performance (`REQ-040`):** Full navigation, CTAs, pagination, and content must work with JavaScript disabled; keep first-party route JS `<= 25 KiB` gzip (`0 KiB` for pure CSS themes).
- **Accessibility & Responsive (`PLAN.md` §8, `DESIGN.md`):** Fluid `320px`–`2560px`, zero horizontal overflow at `360px` and `1440px`, `>= 44px` mobile touch targets, `>= 2px` visible keyboard focus rings, system font stack by default (`<= 1` self-hosted variable font max), `prefers-reduced-motion` respected, and zero cart/checkout/payment/visitor-account UI (`DEC-008`).

## 8. Verification Commands

Run all checks before delivery:

```bash
pnpm spec:check && pnpm lint && pnpm typecheck && pnpm build
pnpm test:unit
node tests/task-018/e2e.mjs
```

To capture rendered screenshots for visual inspection at `360px` and `1440px`:

```bash
TASK018_SCREENSHOT_DIR=/tmp/task-018-shots node tests/task-018/e2e.mjs
```
