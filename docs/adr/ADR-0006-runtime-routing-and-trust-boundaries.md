# ADR-0006: Runtime, Routing Consistency and Trust Boundaries

- **Status:** Accepted 2026-11-14 for items 1-4 (DEC-005, DEC-029); item 5 superseded by DEC-027
- **Date:** 2026-09-25
- **Author:** Specification review
- **Deciders:** Paduka Ongki
- **Supersedes:** Amends ADR-0001 (KV-first routing), ADR-0003 (theme loading) and ADR-0005 (public ingestion)

> **Amended by ADR-0009 & DEC-036 (accepted 2026-11-18):** item 1 (Vultr + Coolify + PostgreSQL execution baseline) is replaced by the 100% Cloudflare runtime (`punyasitus-web` Worker + `PLATFORM_DB` D1 + per-tenant `TenantStore` SQLite Durable Object); items 2-4 (authoritative `PLATFORM_DB` host check before `caches.default`, fail-closed `503`, code-defined theme registry) stay in force.

## Context

Observed: the previous PLAN mixes Next.js with a TanStack Router SPA, PostgreSQL with D1, and assumes immediate KV revocation. Accepted ADR-0002 selects Astro and Next.js with shared data packages. Cloudflare documents eventual KV consistency. A custom theme importing a scoped loader is trusted code, not an isolation sandbox. A GTM container can publish executable tags even when only its ID is accepted by the CMS.

## Decision

Accepted 2026-11-14 for items 1-4 (DEC-005, DEC-029); item 5 superseded by DEC-027.


1. User-selected hosting is Vultr + self-hosted Coolify. The revised implementation baseline keeps PostgreSQL/Drizzle, one Astro SSR application with its Node adapter (ADR-0007) and image jobs in separate Docker services on the VPS. Validate pinned Node/framework/driver builds before deployment. R2 stores images; bounded Node jobs perform conversion. Cloudflare for SaaS remains the hostname/TLS ingress; Workers are not required.
2. Check hostname ownership and tenant status authoritatively before serving HTML. Bypass CDN/proxy HTML caching initially; optional application-local cache comes after the check. KV is not a baseline dependency. Database outage fails closed with 503. Never forward a client-supplied tenant header as authority.
3. Compile an explicit trusted theme registry and prohibit direct DB/auth imports from theme code. Public data loaders expose published DTOs only; tests, permissions and database constraints enforce isolation.
4. Accept public forms on the resolved public site origin. Derive tenant from host, rate-limit atomically and deduplicate persistence. Admin APIs require session/membership authorization independently.
5. (Superseded by DEC-027 on 2026-11-14: GTM is a tenant-owned, easy-setup option without platform review; see PLAN section 18.1.) Preserve GTM capability through platform-controlled publishing and tag review. Unreviewed containers remain disabled; direct GA4/Meta/TikTok integrations continue subject to consent.

## Alternatives and Consequences

- KV-only routing lowers some read latency but cannot provide immediate revocation; rejected for the proposed security boundary.
- Durable Objects could provide a stronger routing registry but add coordination and migration work; defer until measurements justify it.
- D1 would require a distinct schema, auth and transaction strategy; do not pretend it is a drop-in PostgreSQL option.
- An Astro Worker deployment was previously proposed. Node-hosted Astro now fits the user's Vultr/Coolify direction and avoids a second database transport/runtime; regional origin latency must still be measured.
- (Historical, superseded by DEC-027.) Restricting all analytics to direct tags is simpler but removes existing GTM scope. Controlled containers preserve it with explicit operational responsibility.
- Authoritative routing incurs database latency and availability dependency. Pooling, regional placement and cache effectiveness must be measured before any performance claim.

## Acceptance Gate (historical; satisfied by DEC-005 and DEC-029 on 2026-11-14)

The hosting selection comes from the user's explicit Vultr/Coolify instruction; it does not approve provisioning or deploys. Architecture owner records compatible versions after TASK-023 and encrypted origin ingress evidence under TASK-045. Product owner accepts the routing/tracker policy before affected provider integrations. Price observations are recorded in PLAN.md; no account capability, live DNS or deployment is verified here.
