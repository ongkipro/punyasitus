# ADR-0001: Multi-Tenant Ingress & Edge Hostname Resolution

> Superseded in part (2026-09-26): the KV-first routing cache, edge hostname resolution and edge HTML caching described below are replaced by PLAN section 3 (authoritative PostgreSQL routing per request, fail-closed 503, HTML not cached at Cloudflare) and ADR-0006/ADR-0007. Do not implement KV routing from this record.
>
> Review note (2026-09-25): historical decision rationale; implementation contracts and unresolved gates are in ../../PLAN.md. ADR-0006 (accepted for routing, theme loading and public ingestion by DEC-029 on 2026-11-14; tracker item superseded by DEC-027) overrides conflicting historical details below. Accepted status below is inherited, not a new approval.

- **Status:** Accepted
- **Date:** 2026-09-24
- **Author:** Business System Architect
- **Deciders:** Paduka Ongki, System Architecture Team
- **Supersedes:** None

## 1. Context
Traditional WordPress multi-site setups either rely on path-based routing (`example.com/site1`), subdomain rewrites, or complex multi-database clustering with Apache/Nginx vhost configs. When onboarding hundreds of Indonesian SME clients with custom domains (`brandanda.com`), managing individual Nginx reverse proxies and Certbot SSL renewals creates severe operational overhead and single-point-of-failure risks. Furthermore, hitting the primary database on every public web request to resolve the tenant identity causes database connection pool exhaustion during traffic surges.

Key Decision Drivers:
- Zero maintenance custom domain SSL provisioning.
- Low routing overhead, subject to measured latency and a safe revocation policy.
- Support for platform subdomains (`*.volumcms.com`, historical; now `*.situsku.click`) and apex/subdomain custom domains (`brandanda.com`).
- Strict tenant isolation at the data access layer.

## 2. Decision
Implement multi-tenant ingress resolution at the edge using **Cloudflare for SaaS (Custom Hostnames API)** combined with an **Edge Ingress Middleware** backed by a distributed edge key-value cache (Cloudflare KV / Redis):

1. **Edge Resolution**: Incoming HTTP `Host` header is normalized and matched against an edge KV cache key `host:{normalizedHost}` (TTL 3600s).
2. **Database Fallback**: On cache miss, Drizzle ORM queries the `tenant_domains` table, writes the result `{ tenantId, themeId, vertical, status }` into KV, and continues.
3. **Automated SSL**: Custom domains are provisioned via Cloudflare for SaaS with automated CNAME/TXT validation and managed wildcard/dedicated SSL certificates.
4. **Tenant Scoping**: The resolved `tenantId` is stamped into the request context (`Astro.locals.tenantContext`; never an untrusted incoming header), enforcing strict tenant boundaries across all downstream content queries.

## 3. Consequences

### Positive
- **Expected lookup benefit**: Hot KV reads can reduce lookup work; no fixed latency or cache-hit ratio has been measured. KV is eventually consistent.
- **Zero SSL Maintenance**: Automatic issuance and renewal of SSL certificates for all tenant custom domains without server reloads.
- **DDoS & CDN Protection**: Every tenant website automatically inherits Cloudflare edge DDoS mitigation and global edge caching.

### Negative
- Custom domain additions and theme changes require explicit edge cache purge / invalidation calls from the admin API.
- Dependency on Cloudflare for SaaS API for enterprise custom hostname management.

### Neutral
- Local development requires a mock middleware or host header mapping (an explicit local-only fixture map; unknown hosts never silently select a tenant).

### 2026-09-25 Domain Naming Proposal

Initial website addresses use username.situsku.click (decided 2026-09-26). PLAN.md section 17 owns handle assignment, signup and entitlement gates. The earlier volumcms.com example (from the former VolumCMS name) is historical, not the current proposed base or evidence of domain ownership. Neither base is authorized for live DNS/provisioning by this record.
