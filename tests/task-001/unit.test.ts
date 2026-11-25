import fs from "node:fs";
import path from "node:path";
import {
  applyTenantMigrations,
  computeMigrationChecksum,
  splitMigrationStatements,
  type CursorLike,
  type Row,
  type SqlLike,
  type SqlValue,
  type StorageLike,
} from "@punyasitus/db/connections";
import { ALL_PLATFORM_MIGRATIONS, PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { ALL_TENANT_MIGRATIONS, TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-001 unit checks — SQL migration bundles & trigger-safe splitter", () => {
  it("keeps bundled TS migration descriptors byte-for-byte identical to SQL files on disk", () => {
    const platformSqlOnDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0001_initial_platform.sql"),
      "utf8",
    );
    const tenantSqlOnDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0001_initial_tenant.sql"),
      "utf8",
    );

    expect(PLATFORM_MIGRATIONS).toHaveLength(1);
    expect(PLATFORM_MIGRATIONS[0]!.name).toBe("0001_initial_platform");
    expect(PLATFORM_MIGRATIONS[0]!.sql).toBe(platformSqlOnDisk);

    expect(TENANT_MIGRATIONS).toHaveLength(1);
    expect(TENANT_MIGRATIONS[0]!.name).toBe("0001_initial_tenant");
    expect(TENANT_MIGRATIONS[0]!.sql).toBe(tenantSqlOnDisk);

    // M1-FU-01: Consolidated M1 + M2 migration catalogs match EVERY .sql file on disk byte-for-byte
    const platformFiles = fs
      .readdirSync(path.join(ROOT, "packages/db/migrations/platform"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(ALL_PLATFORM_MIGRATIONS).toHaveLength(platformFiles.length);
    for (let i = 0; i < platformFiles.length; i += 1) {
      const file = platformFiles[i]!;
      const descriptor = ALL_PLATFORM_MIGRATIONS[i]!;
      expect(descriptor.name).toBe(file.replace(/\.sql$/, ""));
      expect(descriptor.sql).toBe(
        fs.readFileSync(path.join(ROOT, "packages/db/migrations/platform", file), "utf8"),
      );
      if (i > 0) {
        expect(descriptor.version).toBeGreaterThan(ALL_PLATFORM_MIGRATIONS[i - 1]!.version);
      }
    }

    const tenantFiles = fs
      .readdirSync(path.join(ROOT, "packages/db/migrations/tenant"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(ALL_TENANT_MIGRATIONS).toHaveLength(tenantFiles.length);
    for (let i = 0; i < tenantFiles.length; i += 1) {
      const file = tenantFiles[i]!;
      const descriptor = ALL_TENANT_MIGRATIONS[i]!;
      expect(descriptor.name).toBe(file.replace(/\.sql$/, ""));
      expect(descriptor.sql).toBe(
        fs.readFileSync(path.join(ROOT, "packages/db/migrations/tenant", file), "utf8"),
      );
      if (i > 0) {
        expect(descriptor.version).toBeGreaterThan(ALL_TENANT_MIGRATIONS[i - 1]!.version);
      }
    }
  });

  it("splits SQLite migrations safely across comments, quoted semicolons, and CREATE TRIGGER blocks", () => {
    const script = `
      -- Leading comment with ; semicolon
      CREATE TABLE demo (
        id INTEGER PRIMARY KEY,
        note TEXT DEFAULT 'hello; world; ''quoted'''
      );
      /* Block comment
         with ; semicolons and BEGIN; END; */
      CREATE TRIGGER demo_guard
      BEFORE UPDATE ON demo
      BEGIN
        SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'invalid; id') ELSE 1 END;
        SELECT RAISE(ABORT, 'immutable; row');
      END;
      INSERT INTO demo (id, note) VALUES (1, 'ok; done');
    `;

    const stmts = splitMigrationStatements(script);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^CREATE TABLE demo/);
    expect(stmts[0]).toContain("'hello; world; ''quoted'''");
    expect(stmts[1]).toMatch(/^CREATE TRIGGER demo_guard/);
    expect(stmts[1]).toContain("RAISE(ABORT, 'immutable; row');");
    expect(stmts[1]).toMatch(/END$/);
    expect(stmts[2]).toBe("INSERT INTO demo (id, note) VALUES (1, 'ok; done')");
  });

  it("splits platform and tenant 0001 migrations preserving the append-only audit trigger", () => {
    const platformStmts = splitMigrationStatements(PLATFORM_MIGRATIONS[0]!.sql);
    const tenantStmts = splitMigrationStatements(TENANT_MIGRATIONS[0]!.sql);

    expect(platformStmts.length).toBeGreaterThan(40);
    expect(tenantStmts.length).toBeGreaterThan(25);

    const triggerStmt = platformStmts.find((s) =>
      s.startsWith("CREATE TRIGGER IF NOT EXISTS platform_audit_no_update"),
    );
    expect(triggerStmt).toBeDefined();
    expect(triggerStmt).toContain("BEGIN");
    expect(triggerStmt).toContain("SELECT RAISE(ABORT, 'platform_audit is append-only');");
    expect(triggerStmt).toMatch(/END$/);
  });

  it("computes deterministic checksums and rejects mutated applied migrations", () => {
    const sqlA = "CREATE TABLE a (id INTEGER PRIMARY KEY);";
    const sqlB = "CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);";
    expect(computeMigrationChecksum(sqlA)).toBe(computeMigrationChecksum(`${sqlA}\r\n`));
    expect(computeMigrationChecksum(sqlA)).not.toBe(computeMigrationChecksum(sqlB));

    const ledger: Row[] = [];
    const fakeCursor = (rows: Row[]): CursorLike => ({
      toArray: () => rows,
      *raw(): IterableIterator<SqlValue[]> {
        for (const r of rows) yield Object.values(r);
      },
      columnNames: rows[0] ? Object.keys(rows[0]) : [],
      rowsRead: rows.length,
      rowsWritten: 0,
    });
    const fakeSql: SqlLike = {
      databaseSize: 4096,
      exec(query: string, ...bindings: SqlValue[]): CursorLike {
        if (query.startsWith("SELECT version, name, checksum FROM _tenant_migrations")) {
          return fakeCursor(ledger);
        }
        if (query.startsWith("INSERT INTO _tenant_migrations")) {
          ledger.push({
            version: bindings[0] ?? 1,
            name: bindings[1] ?? "",
            checksum: bindings[2] ?? "",
          });
        }
        return fakeCursor([]);
      },
    };
    const fakeStorage: StorageLike = {
      sql: fakeSql,
      transactionSync<T>(fn: () => T): T {
        return fn();
      },
    };

    const first = applyTenantMigrations(fakeStorage, [{ version: 1, name: "0001_a", sql: sqlA }]);
    expect(first.applied).toEqual(["0001_a"]);

    const second = applyTenantMigrations(fakeStorage, [{ version: 1, name: "0001_a", sql: sqlA }]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0001_a"]);

    expect(() =>
      applyTenantMigrations(fakeStorage, [{ version: 1, name: "0001_a", sql: sqlB }]),
    ).toThrow(/TENANT_MIGRATION_CHECKSUM_MISMATCH/);
  });
});
