# ADR-0002: Decoupled Application Runtimes: Astro SSR Storefront & Next.js Admin

> Superseded 2026-09-25 by ADR-0007 (single Astro runtime). Kept as history only; do not implement apps/admin or Next.js from this record.
>
> Review note (2026-09-25): historical decision rationale; implementation contracts and unresolved gates are in ../../PLAN.md. ADR-0006 proposes corrections to routing, theme loading and public ingestion/tracker trust. Do not implement conflicting historical details before resolving that gate. Accepted status below is inherited, not a new approval.

- **Status:** Superseded by [ADR-0007](ADR-0007-single-astro-runtime.md) on 2026-09-25
- **Date:** 2026-09-24
- **Author:** Business System Architect
- **Deciders:** Paduka Ongki, System Architecture Team
- **Supersedes:** None

## 1. Context
A content management system serves two radically different audiences with competing technical requirements:
1. **Public Storefront Visitors**: Need ultra-fast mobile loading on Indonesian 4G networks, zero hydration lag, perfect SEO, sub-second LCP (<1.2s), and lightweight WhatsApp links. They read HTML and click CTAs; they do not perform complex administrative mutations.
2. **Platform & Tenant Administrators**: Need a state-heavy, highly interactive dashboard: drag-and-drop navigation tree reordering, data tables with pagination and URL filtering, rich text WYSIWYG editors, modal dialogs, real-time analytics graphs, and role-based access controls.

Using a single framework for both creates suboptimal compromises: Next.js on the storefront sends substantial React runtime JS (hurting mobile Core Web Vitals on budget Android phones), while Astro on the admin panel lacks rich React dashboard ecosystems and requires custom client-state scaffolding.

## 2. Decision
Decouple the application runtimes inside a unified `pnpm` monorepo:
1. **Public Storefront (`apps/storefront`)**: Built with **Astro v5 (SSR mode)** and budget-bound optional React 19 Islands. Renders pure, semantic HTML by default (0 KB client JavaScript baseline). Native HTML and small scripts are preferred; optional islands must fit the total JS budget.
2. **Admin & Superadmin Dashboard (`apps/admin`)**: Built with **Next.js 15+ (App Router)** + React 19 + Tailwind CSS v4 + TanStack Table + shadcn/ui. Handles Superadmin platform operations (`/platform/*`), Tenant Merchant operations (`/dashboard/*`), and Better Auth multi-tenant organization sessions.
3. **Shared Packages (`packages/db`, `packages/core`)**: Both applications directly import Drizzle ORM schemas and core contracts, avoiding REST/RPC network hop overhead during storefront SSR rendering.

## 3. Consequences

### Positive
- **Performance target**: HTML-first rendering limits hydration work; PLAN.md defines measured budgets. No PageSpeed score or visitor latency is guaranteed.
- **Maximum Admin Velocity**: The admin dashboard leverages the mature React 19 + shadcn/ui component ecosystem for rich data tables and drag-and-drop builders.
- **Independent Scaling & Deployment**: Storefront traffic spikes (e.g. viral TikTok campaigns) do not degrade admin dashboard responsiveness.

### Negative
- Requires maintaining two frontend frameworks (Astro and Next.js) within the monorepo.
- Shared UI components (if needed across storefront and admin) must be written in framework-agnostic TypeScript/React.

### Neutral
- Monorepo tooling (`pnpm workspaces` + Turborepo) handles shared dependencies, linting, and type checking cleanly.
