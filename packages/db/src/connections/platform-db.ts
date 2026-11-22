import { drizzle } from "drizzle-orm/d1";

/**
 * Instantiates a per-request Drizzle SQLite handle over `PLATFORM_DB` (D1)
 * or a `D1Database`-compatible `TenantStore` adapter. Never cache at module scope.
 */
export function createSqliteDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  db: D1Database,
  schema?: TSchema,
) {
  return drizzle(db, schema ? { schema } : undefined);
}
