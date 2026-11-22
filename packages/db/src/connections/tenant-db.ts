import {
  TENANT_STORE_PROTOCOL,
  type Row,
  type SchemaState,
  type SqlValue,
  type StatementDescriptor,
  type StatementResult,
} from "./store-core.ts";

export interface TenantStoreRpcStub {
  query(protocol: number, statement: StatementDescriptor, raw: boolean): Promise<StatementResult>;
  batch(protocol: number, statements: StatementDescriptor[]): Promise<StatementResult[]>;
  schemaState(protocol: number): Promise<SchemaState>;
  armAlarm?(protocol: number, delayMs?: number): Promise<{ scheduledAt: number }>;
  alarmState?(protocol: number): Promise<{ runs: number; lastRunAt: number | null }>;
}

export interface TenantStoreNamespaceLike {
  getByName(name: string, options?: { locationHint?: string }): TenantStoreRpcStub;
}

class TenantPreparedStatement {
  readonly #stub: TenantStoreRpcStub;
  readonly #sql: string;
  readonly #args: SqlValue[];

  constructor(stub: TenantStoreRpcStub, sql: string, args: SqlValue[] = []) {
    this.#stub = stub;
    this.#sql = sql;
    this.#args = args;
  }

  descriptor(): StatementDescriptor {
    return { sql: this.#sql, args: [...this.#args] };
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new TenantPreparedStatement(
      this.#stub,
      this.#sql,
      values as SqlValue[],
    ) as unknown as D1PreparedStatement;
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const res = await this.#stub.query(TENANT_STORE_PROTOCOL, this.descriptor(), false);
    const row = res.results[0];
    if (!row) return null;
    if (colName !== undefined) {
      return (row[colName] ?? null) as T | null;
    }
    return row as T;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    const res = await this.#stub.query(TENANT_STORE_PROTOCOL, this.descriptor(), false);
    return {
      results: res.results as T[],
      success: true,
      meta: res.meta,
    };
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.run<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const res = await this.#stub.query(TENANT_STORE_PROTOCOL, this.descriptor(), true);
    const rows = res.raw ?? [];
    if (options?.columnNames) {
      return [res.columns, ...rows] as unknown as T[];
    }
    return rows as unknown as T[];
  }
}

/**
 * Wraps a `TenantStore` Durable Object RPC stub in a `D1Database`-compatible
 * handle so Drizzle (`drizzle-orm/d1`) and repositories run uniformly against
 * per-tenant SQLite Durable Objects.
 */
export function createTenantDb(stub: TenantStoreRpcStub): D1Database {
  const db = {
    prepare(query: string): D1PreparedStatement {
      return new TenantPreparedStatement(stub, query) as unknown as D1PreparedStatement;
    },
    async batch<T = Row>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const descriptors = statements.map((stmt) => {
        if (!(stmt instanceof TenantPreparedStatement)) {
          throw new Error("Expected statement prepared by createTenantDb()");
        }
        return stmt.descriptor();
      });
      const results = await stub.batch(TENANT_STORE_PROTOCOL, descriptors);
      return results.map((res) => ({
        results: res.results as T[],
        success: true,
        meta: res.meta,
      }));
    },
    async exec(query: string): Promise<D1ExecResult> {
      const started = Date.now();
      const statements = query
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((sql) => ({ sql, args: [] as SqlValue[] }));
      if (statements.length === 0) {
        return { count: 0, duration: 0 };
      }
      await stub.batch(TENANT_STORE_PROTOCOL, statements);
      return { count: statements.length, duration: Math.max(0, Date.now() - started) };
    },
    withSession(): never {
      throw new Error("TenantStore DO does not use D1 read-replication sessions");
    },
    dump(): never {
      throw new Error("Use Durable Object PITR bookmarks for TenantStore backups");
    },
  };
  return db as unknown as D1Database;
}

export function openTenantStoreStub(
  namespace: TenantStoreNamespaceLike,
  tenantId: string,
): TenantStoreRpcStub {
  if (!tenantId.trim()) {
    throw new Error("tenantId is required to open TenantStore");
  }
  return namespace.getByName(tenantId, { locationHint: "apac-se" });
}
