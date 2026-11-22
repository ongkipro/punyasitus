# Custom Theme Development Guide

> Audience: developers and AI agents building a custom brand theme for a PunyaSitus client.
> Contracts this guide follows: PLAN.md sections 2, 7, 11.4, 14 and 19.7; ADR-0003, ADR-0009 and ADR-0010; REQ-018, REQ-019, REQ-020, REQ-021, REQ-046, REQ-063, REQ-096.
> Status: target workflow. The theme registry, style variants, theme store and shell are built by TASK-012, TASK-013, TASK-018, TASK-093 and TASK-096; until they exist, this guide describes the contract, not working code.

## Why this matters

Custom theme development — paired with modular first-party plugins (`docs/plugins/PLUGIN-DEVELOPMENT.md`) when a client also needs bespoke functional features — is the core high-margin service of PunyaSitus, while **Premium Marketplace Themes (`paid_once`)** provide scalable self-serve upsell revenue alongside the IDR 179,000/month (IDR 1,790,000/year, DEC-035) subscription. Under the **Frozen Core** rule (`ADR-0010`), client visual requirements live strictly inside themes and client functional requirements live strictly inside plugins — never by modifying core CMS code. Everything platform-wide (the single `<head>` & discovery slot populated by the official free `seo-ai-autopilot` plugin when active, consent, security, media, forms, maintenance mode) is owned by the shared shell so a theme only designs and composes and never emits competing SEO tags.

## What a platform, premium, or custom theme is

- Trusted Astro code that lives in this repository, reviewed and deployed inside the `punyasitus-web` Worker bundle. There is no theme upload, runtime Git pull or per-request dynamic import from a path.
- Three distribution tiers (`REQ-096`):
  1. **Built-in Platform Themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer` — `included`):** each exposes at least **4 one-click Style Variants** (WCAG AA color palette, font pair `<= 1` custom font, radius/card density, header/hero layout variant).
  2. **Premium Marketplace Themes (`premium-<slug>` — `paid_once`):** live in `apps/web/src/themes/premium/<theme-id>/`, previewable with draft content (`no-store, noindex`) and unlocked per website upon confirmed AutoLaris QRIS/VA payment.
  3. **Bespoke Client/Agency Themes (`custom-<brand-slug>` — `custom`):** live in `apps/web/src/themes/custom/<theme-id>/`, granted by superadmin on `console.punyasitus.com/tenants/{handle}` (or to an agency).

## Folder layout

Platform base sections and shell components live in `apps/web/src/themes/default/**`, inherited by the 6 platform themes in `apps/web/src/themes/{compro,sales,travel,catalog,resto,dealer}/**`. Custom themes follow:

```text
apps/web/src/themes/custom/<theme-id>/
  theme.ts            manifest: id, name, version, schemaVersion, recommendedOfferingTypes,
                      typed presentation config schema, preview image path
  Layout.astro        theme frame rendered inside the shared shell slot
  pages/              Home, Page, PostList, Post, OfferingList, OfferingDetail, Archive
  sections/           theme-specific section renderers (re-exports platform sections it does not customize)
  styles/theme.css    CSS custom properties and theme styles (no shadcn/admin imports)
  assets/             at most one self-hosted variable Latin font (DEC-035 C14) and static artwork
  preview.webp        card image shown in Appearance > Themes
  README.md           client, brief link, design decisions, budget exceptions, changelog
```

## Boundaries (enforced by lint/import guards and tests)

- **Content vs presentation split:** All page sections, offerings (`service` `/layanan`, `product` `/produk`, `tour` `/tour`, `vehicle` `/kendaraan`), blog posts, branches, forms and business profile arrive as typed public DTO props from `packages/core`. Never import `packages/db`, `packages/auth`, `@base-ui/react`, `apps/web/src/components/ui`, server-only modules or environment secrets.
- Every custom theme must render every section kind in the closed section registry (REQ-019) — re-exporting shared default section components for kinds it does not customize — so switching between any of the 6 platform themes (`compro`, `sales`, `travel`, `catalog`, `resto`, `dealer`) and a custom theme never loses content.
- The shell owns `<head>` (title, canonical, robots, OG, JSON-LD), consent and analytics/GTM, CSP, 404/503 maintenance pages and preview mode. A theme never emits its own canonical, tracker script, `<meta name="robots">` or JSON-LD.
- Use shared public components for anything with platform rules: responsive WebP image, click-to-play video / YouTube disclosure block, WhatsApp CTA, external link, built-in or tenant custom form (`REQ-080`), static vehicle credit-estimate table (`REQ-079`), pagination, breadcrumbs. Do not re-implement them.
- Every public route must render: `/`, `/{pageSlug}`, `/blog`, `/blog/{slug}`, `/layanan`, `/layanan/{slug}`, `/produk`, `/produk/{slug}`, `/tour`, `/tour/{slug}`, `/kendaraan`, `/kendaraan/{slug}`, taxonomy archives, empty states and pagination. Missing optional content renders nothing, never placeholder claims.
- No cart, checkout, visitor payment, orders, stock or visitor account UI (DEC-008). Offering CTAs are `whatsapp`, `external_link`, `inquiry` or `book` (request only) per REQ-013.

## Quality budget

- Works without JavaScript for content, navigation, CTAs, static vehicle credit tables and forms.
- First-party JS <=25 KiB gzip per route (PLAN section 9). Prefer CSS transitions and native elements. Animation libraries need an explicit, recorded budget exception in the theme README and must respect `prefers-reduced-motion`.
- Fluid layout from 320 to 2560 CSS px (`clamp()` type/spacing, container-query grids, automatic 4.5:1 brand-colour contrast adjustment with `#050505` dark neutral per DEC-035 / CMSPRO DEC-033 & DEC-050).
- System font stack by default; at most one self-hosted variable font counted in the speed budget, with an owner toggle for fastest system-font mode (DEC-035 C14).
- LCP image is not lazy-loaded and reserves dimensions (`3:2` on phones where applicable).
- WCAG 2.2 AA: contrast, focus visible, keyboard menu, 200% zoom, headings in order. Check 360, 768 and 1440 px.
- Preview mode renders with scripts, forms and outbound links inert (PLAN section 14); the theme must still look complete.

## Configuration

Theme presentation settings (colors, font mode, header/footer variants, visual section variants) are declared in the manifest's typed config schema, validated server-side and edited in the customizer. Content lives in `TenantStore`, never trapped inside `theme_configs`. Each theme keeps its own draft and published presentation config per tenant. A breaking presentation-config change bumps `schemaVersion` and ships a pure upcaster; activation of an incompatible config is blocked, never silently reset.

## Delivery workflow (service)

1. Client submits a Custom theme request (REQ-063); operator quotes and records status.
2. Brief and design direction are agreed outside the system; link them in the theme README.
3. Build the theme on a feature branch/worktree with synthetic fixtures plus the client's non-sensitive sample content.
4. Run the checks below; fix every failure.
5. Deploy the Worker containing the theme (release authorization required).
6. Superadmin grants the theme on `console.punyasitus.com/tenants/{handle}`, links the grant to the request and marks it delivered.
7. Owner/admin previews with real draft content and activates. The prior theme config stays restorable.
8. Later changes: bump `version`, update the README changelog, repeat checks and release.

## Checks before delivery

Commands are created by TASK-023; until then they are the target contract.

```bash
pnpm lint && pnpm typecheck          # includes the theme import guard
pnpm test:e2e -- themes/<theme-id>   # routes, empty states, no-JS, keyboard, two-tenant isolation
pnpm test:performance -- <theme-id>  # JS/asset budget and LCP/CLS lab profile
```

Also verify: rendered screenshots at 360/768/1440 px, preview mode, maintenance 503 page, and that sitemap/canonical output is unchanged from the `compro` theme for the same content.

## Instruction for an AI agent building a theme

```text
Build custom theme <theme-id> for tenant <handle> in PunyaSitus.
Read AGENTS.md, docs/themes/THEME-DEVELOPMENT.md, PLAN.md sections 2, 7, 11.4, 14
and DESIGN.md. Work only under apps/web/src/themes/custom/<theme-id>/ plus one
registry entry in apps/web/src/core/theme-registry.ts and tests for the theme.
Use shell-provided public DTO props and shared components; never import db/auth or
admin UI packages, never emit head/SEO/tracker tags, never add commerce UI. Meet the
no-JS, 25 KiB JS, WCAG 2.2 AA and 360/768/1440 checks, run the theme checks, and
report evidence. Do not grant, deploy, commit or push without explicit authorization.
```
