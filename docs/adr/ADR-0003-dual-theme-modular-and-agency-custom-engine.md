# ADR-0003: Dual Theme Architecture: Default Modular Theme & Agency Custom Theme Engine

> Review note (2026-09-25): historical decision rationale; implementation contracts and unresolved gates are in ../../PLAN.md. ADR-0006 (accepted for routing, theme loading and public ingestion by DEC-029 on 2026-11-14; tracker item superseded by DEC-027) overrides conflicting historical details below. Accepted status below is inherited, not a new approval.

- **Status:** Accepted
- **Date:** 2026-09-24
- **Author:** Business System Architect
- **Deciders:** Paduka Ongki, System Architecture Team
- **Supersedes:** None

## 1. Context
Traditional CMS platforms either force users into rigid templates that require coding to customize, or offer unconstrained drag-and-drop page builders (e.g. Elementor, Divi) that produce dirty HTML DOM trees, excessive CSS/JS bloat, and broken mobile responsiveness. 

Additionally, as an agency and software provider, we need a dual-tier monetization model:
1. Standard SaaS clients need a fast, clean, zero-code theme where they can edit hero banners, color palettes, menus, and sections without breaking the layout.
2. Premium enterprise clients (luxury brands, large Umrah agencies, franchise chains) want 100% bespoke designs with custom animations, unique layouts, and specialized workflows, for which they pay high-ticket agency fees.

## 2. Decision
Implement a **Dual Theme Architecture** within the Astro public site engine:

1. **Default Modular Theme ("PunyaSitus Default")**:
   - Out-of-the-box theme for all self-serve tenants.
   - Composed of a finite **Section Registry** of 14 battle-tested, accessible Astro components: Header, Hero Banner (single/slider), Trust Logos, Mini-Catalog, Services Grid, About Us Story, Portfolio/Gallery, Testimonials, Outlets/Locations (Google Maps), FAQ Accordion, Latest Articles, Contact/Lead Form, Floating WhatsApp Widget, and Footer.
   - Tenant editors reorder and toggle sections via the admin dashboard without touching code.
   - Brand tokens (primary color, accent color, font pairings, border radius) are injected via CSS Custom Properties on the root layout shell. Changes take effect instantly without rebuilding the public site.

2. **Custom Theme Engine (Agency Service Tier)**:
   - Dedicated templates live under `apps/web/src/themes/custom/<theme-id>/` (named by theme, so one theme can be granted to several tenants) and follow `docs/themes/THEME-DEVELOPMENT.md`.
   - An explicit build-time registry maps registered theme IDs to layouts; there is no dynamic import from stored IDs or paths (PLAN section 7). The active theme comes from the tenant's published theme configuration.
   - Custom themes access content strictly via tenant-scoped data loaders (`getTenantPublicData(tenantId)`), with isolation enforced and tested at authorization, repository and database boundaries.
   - Custom themes automatically inherit platform-wide benefits: Cloudflare-managed TLS, WebP image pipelines, dynamic `sitemap.xml`, and WhatsApp Open Graph tags.

## 3. Consequences

### Positive
- **Controlled layouts**: Validated configuration limits layout risk; content and integrations still require accessibility and performance checks.
- **Agency Monetization Pipeline**: Gives our agency team complete design freedom (GSAP animations, bespoke components, custom interactive tools) to deliver high-ticket custom services.
- **Zero Platform Drift**: Custom themes do not require separate server deployments or fork the core codebase.

### Negative
- Custom themes must be authored by developers who understand Astro and the platform's data loader contract.

### Neutral
- An invalid or missing custom theme slug automatically falls back to the Default Modular Theme, preventing public site crashes.
