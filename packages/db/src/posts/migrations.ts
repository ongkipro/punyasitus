import { applyTenantMigrations } from "../connections/migrations.ts";
import type { MigrationDescriptor } from "../connections/sql-splitter.ts";
import type { StorageLike } from "../connections/store-core.ts";
import { TENANT_MIGRATIONS } from "../tenant/migrations.ts";

/**
 * Bundled SQL matching `packages/db/migrations/tenant/0020_blog_author_toc_modified.sql`
 * byte-for-byte so Cloudflare `workerd` runtimes and tests can apply it alongside
 * `TENANT_MIGRATIONS` without filesystem access (REQ-092, PLAN §5.2 & §19.5, TASK-092).
 *
 * NOTE: Never invoke migration application at request time inside API/page/repository handlers;
 * apply via tenant provisioning/migration runner only.
 */
export const BLOG_AUTHOR_TOC_MODIFIED_MIGRATION_SQL = `-- PunyaSitus TenantStore (Per-Tenant SQLite Durable Object) — 0020_blog_author_toc_modified
-- Additive Blog Author Profiles (\`role_title\`), \`content_modified_at\` substantive fingerprint,
-- and index support for author/category blog lookups (REQ-092, PLAN §5.2 & §19.5, TASK-092).
-- Preserves all existing \`authors\` and \`posts\` rows from 0001_initial_tenant; zero destructive changes.

ALTER TABLE authors ADD COLUMN role_title TEXT;
ALTER TABLE posts ADD COLUMN content_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS posts_author_status_idx
  ON posts(author_id, status);

CREATE INDEX IF NOT EXISTS posts_primary_category_status_idx
  ON posts(primary_category_id, status, published_at);
`;

export const BLOG_AUTHOR_TOC_MODIFIED_MIGRATION: MigrationDescriptor = {
  version: 20,
  name: "0020_blog_author_toc_modified",
  sql: BLOG_AUTHOR_TOC_MODIFIED_MIGRATION_SQL,
} as const;

export const TENANT_MIGRATIONS_WITH_BLOG_AUTHOR_TOC_MODIFIED: readonly MigrationDescriptor[] = [
  ...TENANT_MIGRATIONS,
  BLOG_AUTHOR_TOC_MODIFIED_MIGRATION,
] as const;

/**
 * Idempotently applies `TENANT_MIGRATIONS` plus `0020_blog_author_toc_modified` to a
 * `TenantStore` Durable Object SQLite storage handle during provisioning or test setup.
 */
export async function applyTenantBlogAuthorTocMigrations(storage: StorageLike) {
  return applyTenantMigrations(storage, TENANT_MIGRATIONS_WITH_BLOG_AUTHOR_TOC_MODIFIED);
}
