import {
  pluginIdToTablePrefix,
  validatePluginQuerySql,
  type PluginTenantDb,
} from "@punyasitus/core/plugins/index";

export interface ScopedPluginTenantDbOptions {
  /** Optional observer invoked whenever a validated plugin query is prepared. */
  readonly onQuery?: (info: {
    readonly pluginId: string;
    readonly sql: string;
    readonly operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    readonly touchedTables: readonly string[];
  }) => void;
}

/**
 * Wraps a per-tenant `D1Database` handle in a namespace-locked `PluginTenantDb`.
 *
 * Every statement prepared through this wrapper is validated by `validatePluginQuerySql`
 * before reaching `TenantStore`, strictly blocking:
 * - Any table outside `plg_<snake_id>__*`
 * - Multi-statement `;` smuggling
 * - DDL (`CREATE`, `ALTER`, `DROP`), `PRAGMA`, `ATTACH`, transactions, or `sqlite_*`
 * - Core tables (`leads`, `pages`, `posts`, `offerings`, `installed_plugins`, `_plugin_migrations`)
 *
 * Tracks returned statement proxies in a `WeakMap` back to their underlying
 * prepared statements so `scopedDb.batch([...])` verifies ownership AND unwraps
 * raw `TenantPreparedStatement` instances safely for `TenantStore` RPC execution.
 */
export function createScopedPluginTenantDb(
  pluginId: string,
  tenantDb: D1Database,
  options?: ScopedPluginTenantDbOptions,
): PluginTenantDb {
  const tablePrefix = pluginIdToTablePrefix(pluginId);
  const rawStatementByProxy = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  function trackStatement(rawStmt: D1PreparedStatement): D1PreparedStatement {
    const originalBind = rawStmt.bind.bind(rawStmt);
    const proxy = new Proxy(rawStmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...values: unknown[]) => trackStatement(originalBind(...values));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatementByProxy.set(proxy, rawStmt);
    return proxy;
  }

  return {
    pluginId,
    tablePrefix,
    prepare(sql: string): D1PreparedStatement {
      const validated = validatePluginQuerySql(pluginId, sql);
      options?.onQuery?.({
        pluginId,
        sql,
        operation: validated.operation,
        touchedTables: validated.touchedTables,
      });
      return trackStatement(tenantDb.prepare(sql));
    },
    async batch<T = Record<string, unknown>>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      const unwrapped: D1PreparedStatement[] = [];
      for (const stmt of statements) {
        const raw = rawStatementByProxy.get(stmt);
        if (!raw) {
          throw new Error(
            `PLUGIN_SCOPED_DB_VIOLATION: Statement was not prepared by scoped PluginTenantDb for "${pluginId}"`,
          );
        }
        unwrapped.push(raw);
      }
      return tenantDb.batch<T>(unwrapped);
    },
  };
}
