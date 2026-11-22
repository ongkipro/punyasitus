# ADR-0007: Single Astro Runtime for Public Site, Tenant Admin and Platform Superadmin

- **Status:** Accepted
- **Date:** 2026-09-25
- **Author:** Specification review
- **Deciders:** Paduka Ongki
- **Supersedes:** ADR-0002

> **Amended by DEC-035, ADR-0009 & DEC-036 (accepted 2026-11-18):** one Astro SSR Worker (`@astrojs/cloudflare`, `session: false`) now serves four host-isolated surfaces (`punyasitus.com` marketing, `app.punyasitus.com` tenant/agency/affiliate app, `console.punyasitus.com` superadmin replacing `/platform`, and `*.situsku.click` / custom-domain public sites with typed `/layanan`, `/produk`, `/tour`, `/kendaraan` routes replacing `/katalog`); persistence uses `PLATFORM_DB` D1 + `TenantStore` SQLite Durable Objects, and admin islands use `shadcn/ui` `base-nova` (`@base-ui/react`).

## Context

PunyaSitus is a hybrid, WordPress-like business CMS: pages, blog, media, menus, themes, settings, members and a showcase catalog. It is not a store. Catalog items present products, packages or services and convert through WhatsApp, external links or the lead form; visitors never add to cart, check out, pay, create accounts or track orders.

ADR-0002 split the product into an Astro public site and a Next.js admin. Under the Vultr + Coolify baseline (ADR-0006) that split costs a second Node runtime on one VPS, a second build and dependency tree, and a private authenticated renderer bridge whose only purpose was letting Next.js preview Astro templates. The admin is route-oriented CRUD with bounded interactive regions. A Next.js public site cannot meet the 25 KiB first-party JS budget (REQ-040), and framework-level HTML caching competes with the per-request tenant revocation check.

## Decision

### 1. One application, three surfaces

One Astro SSR application, `apps/web`, on the Node adapter with on-demand rendering (tenant, publication and service state are request-time data; no prerendered tenant pages).

| Surface | Host and prefix | Audience | Rendering and JavaScript |
|---|---|---|---|
| Public site | Verified tenant hosts (platform subdomain or active custom domain): pages, /blog, /katalog, sitemap/robots, POST /api/leads and /api/events | Visitors | Server HTML from the active theme; native HTML/CSS and small scripts first; optional islands only within REQ-040 |
| Tenant admin | Fixed admin host: /dashboard/{handle}, /auth, /api/tenants/{handle}/**, /api/auth/** | Owner, admin, editor of a tenant | Astro server pages plus React islands (shadcn/ui, Tailwind v4, TanStack Table); admin JS never loads on tenant hosts |
| Platform superadmin | Same admin host: /platform, /api/platform/** | Active platform operators only | Same component system, separate layout and authorization wrapper; reauthentication for privileged mutations |

Middleware (`src/middleware/`) runs in fixed order: host classification, then authentication (admin host only), then the PLAN section 17 service gate. Tenant hosts return 404 for every admin prefix; the admin host renders no tenant public site; unknown hosts return 404. Reserved slugs prevent page collisions with these prefixes. Health/readiness endpoints for the container orchestrator are the only host-independent exception and reveal no configuration.

### 2. Admin interaction model

- Each admin route is an Astro server page that authorizes, loads scoped initial data and passes serializable props to one working-area island. Layout, sidebar, headings and read-only content stay server HTML; small islands handle mobile navigation and dialogs.
- One mutation path: JSON endpoints under `src/pages/api/**`, documented in `docs/api/` OpenAPI (TASK-024) and backed by guarded server-only services. Astro Actions are not used in v1, so there is one validated contract for islands, tests and future clients.
- State lives in the URL (filters, sort, cursor) and the server response. No client-side cache library in v1; tenant switching is a full navigation, so no cross-tenant UI data survives.
- Forms use shadcn primitives with the same shared schema module the server uses (`packages/core`); server validation remains authoritative.
- Rich text uses a ProseMirror-family editor (candidate: Tiptap) storing the versioned JSON document from PLAN section 7, loaded client-only on editor routes. Final library choice and license are recorded in TASK-033.
- View Transitions, if adopted, belong to the admin layout only; public-site layouts never include client routing.

### 3. Authentication and superadmin

Better Auth is mounted on the admin host only (src/pages/api/auth/[...all].ts), with __Host- prefixed Secure/HttpOnly cookies and an exact admin-Origin check on every state-changing request; Astro's own session feature is not used. The admin origin and tenant platform subdomains must use different registrable domains so they are not same-site (PLAN section 4). Tenant roles come from Better Auth organization membership. Superadmin requires an active `platform_operators` grant checked on every /platform page and /api/platform handler (PLAN section 13); tenant membership never implies platform access. A separate operator hostname or access proxy in front of /platform is a deferred hardening option, not a v1 dependency.

### 4. Preview

Draft preview renders the registered theme components in-process from a validated draft DTO on the admin host (PLAN section 14). No internal renderer endpoint, signed service request or nonce store exists.

### 5. Not a store

The catalog is a showcase: fixed/from/inquiry price display, WhatsApp/link-out CTAs and lead capture. Out of product scope: cart, visitor checkout or payment, orders, stock/inventory, shipping, coupons and visitor accounts. Platform subscription billing (PLAN section 16) is tenants paying PunyaSitus, lives only on the admin host and never appears on public sites.

### 6. Processes and deployment

`apps/jobs` stays a separate Node process for image conversion and durable jobs; it may reuse the web image with a different start command (TASK-023 decides). Build images off the VPS where practical. If measurements justify isolation, run the same web image as two host-scoped containers (public and admin) without code changes.

## Consequences

### Positive
- One framework, build, image and database pool; lower memory pressure on the pilot VPS.
- Preview uses exactly the published renderer, removing the cross-process bridge and its secrets.
- Public site keeps HTML-first delivery and the REQ-040 budget; admin JS is route-split away from tenant hosts.
- One OpenAPI mutation contract serves islands and tests.

### Negative
- Admin navigation is multi-page; islands call explicit endpoints instead of Server Components/Server Actions.
- Admin and public site share one process until split; a crash or leak affects both.
- Host separation is a security boundary inside one app and needs dedicated negative tests (TASK-045) plus host-only admin cookies (PLAN section 4).

### Neutral
- The pnpm monorepo remains for `apps/web`, `apps/jobs` and shared packages. Exact Astro, React, Better Auth, editor and adapter versions and integration APIs are verified in TASK-023/TASK-033 against official documentation; this ADR does not assert specific API names.

## More Information

- 2026-11-14: ADR-0008 adds a remote MCP endpoint on the admin host for customer AI agents. It is a bearer-token transport (no session cookies, no admin Origin requirement) that calls the same server-only services and shared schemas as the JSON API, so the one-mutation-path rule is preserved for business logic. See PLAN sections 4 and 18.3.
