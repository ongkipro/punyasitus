# apps/web

Boundary note; `PLAN.md` §2 and §12 own the contract. Created by TASK-023.

One Astro SSR app on `@astrojs/cloudflare` (`output: "server"`, `session: false`, `nodejs_compat`), deployed as the single Worker `punyasitus-web`.

| Path | Holds | Rule |
|---|---|---|
| `src/worker/` | Worker entry, `TenantStore` DO, `VideoTranscoder` Container, Queue and Cron handlers | Step 0 passes `/.well-known/pki-validation/*` and `/.well-known/acme-challenge/*` through untouched |
| `src/middleware/` | Host -> surface -> tenant resolution | Protected (R3); host decides the surface before any route, session or cache work |
| `src/core/` | Frozen core CMS modules | No client-specific branches (ADR-0010) |
| `src/pages/` | Routes per surface | Mutations only as JSON endpoints under `src/pages/api/**`, documented in `docs/api/` (ADR-0007) |
| `src/themes/` | `platform`, `premium`, `custom` themes | Public DTO props only; no head/SEO/tracker tags, no db/auth imports |
| `src/components/`, `layouts/`, `styles/`, `scripts/`, `content/`, `lib/` | UI and shared app code | Admin islands use `shadcn/ui` `base-nova` (`@base-ui/react`); never Radix; never load on tenant hosts |
