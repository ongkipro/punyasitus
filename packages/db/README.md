# packages/db

Boundary note; `PLAN.md` §5 owns the contract. Drizzle ORM on SQLite in two planes:

- `src/platform/`: `PLATFORM_DB` (Cloudflare D1) control plane: identity, routing, billing, agencies, affiliates, audit.
- `src/tenant/`: `TenantStore` (SQLite Durable Object per website) data plane through the `D1Database`-compatible RPC adapter.
- `migrations/`: protected (R3). Additive only; a destructive change needs explicit approval.

Server-only. Every tenant-owned query is scoped; another tenant's ID returns 404. Plugin tables are `plg_<id>__*` and belong to their plugin.
