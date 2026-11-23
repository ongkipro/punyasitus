import fs from "node:fs";
import path from "node:path";
import {
  constantTimeEqual,
  definePlugin,
  isBuiltinPluginId,
  isValidPluginId,
  measureEmittedPublicJsBytes,
  pluginIdToTablePrefix,
  PluginSqlViolationError,
  PUBLIC_PLUGIN_JS_BUDGET_BYTES,
  validatePluginConfigLimits,
  validatePluginManifest,
  validatePluginMigrationSql,
  validatePluginQuerySql,
} from "@punyasitus/core/plugins/index";
import {
  PLATFORM_PLUGIN_RUNTIME_MIGRATION_SQL,
  TENANT_PLUGIN_LEDGER_MIGRATION_SQL,
} from "@punyasitus/db/plugins/index";
import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../apps/web/src/core/plugin-registry.ts";
import {
  createPluginJobRegistry,
  PLUGIN_HOOK_QUEUE_TOPIC,
} from "../../apps/web/src/worker/queues/plugins/index.ts";
import { createSyntheticProbePlugin } from "./synthetic-plugin.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-097 Frozen-Core Plugin Manifest, SQL Guard & Registry Unit Tests", () => {
  it("bundles 0011_plugin_runtime_entitlements.sql and 0004_plugin_migrations_ledger.sql byte-for-byte with disk", () => {
    const platformDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0011_plugin_runtime_entitlements.sql"),
      "utf8",
    );
    const tenantDisk = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0004_plugin_migrations_ledger.sql"),
      "utf8",
    );
    expect(PLATFORM_PLUGIN_RUNTIME_MIGRATION_SQL).toBe(platformDisk);
    expect(TENANT_PLUGIN_LEDGER_MIGRATION_SQL).toBe(tenantDisk);
  });

  it("wires createPluginJobRegistry() into WORKER_JOB_REGISTRY in apps/web/src/worker/index.ts", () => {
    const jobRegistry = createPluginJobRegistry();
    expect(jobRegistry[PLUGIN_HOOK_QUEUE_TOPIC]).toBeDefined();
    expect(typeof jobRegistry[PLUGIN_HOOK_QUEUE_TOPIC]?.execute).toBe("function");

    const workerEntry = fs.readFileSync(
      path.join(ROOT, "apps/web/src/worker/index.ts"),
      "utf8",
    );
    expect(workerEntry).toContain("createPluginJobRegistry");
    expect(workerEntry).toContain("...createPluginJobRegistry()");
  });

  it("rejects builtin:* and double-hyphen '--' plugin IDs and enforces strict tablePrefix matching", () => {
    expect(isBuiltinPluginId("builtin:lead-email-notifications")).toBe(true);
    expect(isBuiltinPluginId("BUILTIN:anything")).toBe(true);
    expect(isValidPluginId("builtin:lead-email-notifications")).toBe(false);
    expect(isValidPluginId("a--b")).toBe(false);
    expect(isValidPluginId("alpha--beta")).toBe(false);
    expect(isValidPluginId("synthetic-probe")).toBe(true);
    expect(pluginIdToTablePrefix("synthetic-probe")).toBe("plg_synthetic_probe__");

    expect(() => pluginIdToTablePrefix("a--b")).toThrow(PluginSqlViolationError);

    expect(() =>
      validatePluginManifest({
        id: "builtin:lead-email-notifications",
        name: "Forbidden Builtin",
        description: "Must fail validation",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_builtin__",
        permissions: [],
        maxPublicJsBytes: 0,
        slots: {},
        defaultConfig: {},
      }),
    ).toThrow();

    expect(() =>
      validatePluginManifest({
        id: "a--b",
        name: "Double Hyphen Collision",
        description: "Must fail validation",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_a__b__",
        permissions: [],
        maxPublicJsBytes: 0,
        slots: {},
        defaultConfig: {},
      }),
    ).toThrow();

    expect(() =>
      validatePluginManifest({
        id: "synthetic-probe",
        name: "Mismatched Prefix",
        description: "Must reject mismatched tablePrefix",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_other_plugin__",
        permissions: [],
        maxPublicJsBytes: 0,
        slots: {},
        defaultConfig: {},
      }),
    ).toThrow(/tablePrefix/);
  });

  it("enforces <= 25 KiB public JS budget, real emitted JS measurement, config limits, and constantTimeEqual", () => {
    expect(constantTimeEqual("secret-abc", "secret-abc")).toBe(true);
    expect(constantTimeEqual("secret-abc", "secret-abd")).toBe(false);
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);

    // Real emitted JS byte measurement catches under-reported script blocks
    const hugeScript = `<script>${"a".repeat(PUBLIC_PLUGIN_JS_BUDGET_BYTES + 100)}</script>`;
    expect(
      measureEmittedPublicJsBytes({
        html: `<div>hi</div>${hugeScript}`,
        declaredJsBytes: 0,
      }),
    ).toBeGreaterThan(PUBLIC_PLUGIN_JS_BUDGET_BYTES);

    // Config caps: size <= 16 KiB, depth <= 6, keys <= 100
    expect(validatePluginConfigLimits({ ok: true }).ok).toBe(true);
    expect(validatePluginConfigLimits({ huge: "x".repeat(17_000) }).ok).toBe(false);
    expect(
      validatePluginConfigLimits({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }).ok,
    ).toBe(false);
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 105; i += 1) manyKeys[`k${i}`] = i;
    expect(validatePluginConfigLimits(manyKeys).ok).toBe(false);

    expect(() =>
      validatePluginManifest({
        id: "heavy-plugin",
        name: "Heavy Plugin",
        description: "Exceeds 25 KiB JS cap",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_heavy_plugin__",
        permissions: [],
        maxPublicJsBytes: PUBLIC_PLUGIN_JS_BUDGET_BYTES + 1,
        slots: {},
        defaultConfig: {},
      }),
    ).toThrow();

    expect(() =>
      validatePluginManifest({
        id: "shadow-route",
        name: "Shadow Route",
        description: "Attempts to shadow /dashboard or /api",
        version: "1.0.0",
        visibility: "public_free",
        billingCycle: "free",
        priceIdr: 0,
        tablePrefix: "plg_shadow_route__",
        permissions: ["public:route"],
        maxPublicJsBytes: 0,
        slots: {
          publicRoutes: [{ path: "/api/leads", maxJsBytes: 0 }],
        },
        defaultConfig: {},
      }),
    ).toThrow();
  });

  it("accepts valid additive plg_<id>__* DDL migrations", () => {
    const res = validatePluginMigrationSql(
      "synthetic-probe",
      `
      -- Header comment is safely stripped during tokenization
      CREATE TABLE IF NOT EXISTS plg_synthetic_probe__items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plg_synthetic_probe__tags (
        item_id INTEGER NOT NULL REFERENCES plg_synthetic_probe__items(id),
        tag TEXT NOT NULL
      );
      ALTER TABLE plg_synthetic_probe__items ADD COLUMN note TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS plg_synthetic_probe__items_label_uidx
        ON plg_synthetic_probe__items(label);
      `,
    );
    expect(res.statementCount).toBe(4);
    expect(res.tablePrefix).toBe("plg_synthetic_probe__");
  });

  it("rejects EVERY malicious / non-plg_* DDL vector including comments, triggers, views, PRAGMA, ATTACH, DROP, FK to core tables", () => {
    const attackVectors: readonly { readonly name: string; readonly sql: string }[] = [
      { name: "non-plg table CREATE", sql: "CREATE TABLE leads_evil (id INTEGER PRIMARY KEY);" },
      {
        name: "cross-plugin namespace CREATE",
        sql: "CREATE TABLE plg_other_plugin__steal (id INTEGER PRIMARY KEY);",
      },
      { name: "ALTER core leads table", sql: "ALTER TABLE leads ADD COLUMN hacked TEXT;" },
      { name: "DROP core table", sql: "DROP TABLE leads;" },
      { name: "DROP own plg table", sql: "DROP TABLE plg_synthetic_probe__items;" },
      {
        name: "SQL block comment smuggling",
        sql: "CREATE /* bypass */ TABLE /* core */ leads (id INTEGER);",
      },
      { name: "SQL line comment smuggling", sql: "DROP -- bypass\nTABLE installed_plugins;" },
      { name: "Unclosed block comment", sql: "CREATE TABLE plg_synthetic_probe__a (id INT); /* unclosed" },
      {
        name: "Multi-statement smuggling after valid CREATE",
        sql: "CREATE TABLE plg_synthetic_probe__ok (id INT); DELETE FROM leads;",
      },
      {
        name: "CREATE TRIGGER targeting core leads table",
        sql: "CREATE TRIGGER plg_synthetic_probe__tr AFTER INSERT ON leads BEGIN SELECT 1; END;",
      },
      {
        name: "CREATE VIEW reading core leads table",
        sql: "CREATE VIEW plg_synthetic_probe__v AS SELECT * FROM leads;",
      },
      { name: "ATTACH DATABASE", sql: "ATTACH DATABASE ':memory:' AS evil;" },
      { name: "PRAGMA execution", sql: "PRAGMA foreign_keys = OFF;" },
      {
        name: "Foreign key referencing core table",
        sql: "CREATE TABLE plg_synthetic_probe__fk (lead_id INTEGER REFERENCES leads(id));",
      },
      { name: "Schema-qualified table name", sql: "CREATE TABLE main.plg_synthetic_probe__x (id INTEGER);" },
      { name: "CREATE TEMP TABLE", sql: "CREATE TEMP TABLE plg_synthetic_probe__tmp (id INTEGER);" },
      {
        name: "Quoted identifier targeting core table",
        sql: 'ALTER TABLE "installed_plugins" ADD COLUMN evil TEXT;',
      },
      {
        name: "ALTER TABLE RENAME TO non-plg",
        sql: "ALTER TABLE plg_synthetic_probe__items RENAME TO leads;",
      },
      { name: "Index on core table", sql: "CREATE INDEX plg_synthetic_probe__idx ON pages(slug);" },
    ];

    for (const vec of attackVectors) {
      expect(
        () => validatePluginMigrationSql("synthetic-probe", vec.sql),
        `Expected migration attack vector "${vec.name}" to be rejected`,
      ).toThrow(PluginSqlViolationError);
    }
  });

  it("blocks EVERY SQL sandbox escape vector including CTE shadowing, parenthesized tables, and comma-joins after JOIN/INDEXED BY/NOT INDEXED", () => {
    // Valid single-statement queries (including properly namespaced CTEs)
    expect(
      validatePluginQuerySql(
        "synthetic-probe",
        "SELECT id, label FROM plg_synthetic_probe__items WHERE id = ?",
      ).operation,
    ).toBe("SELECT");

    expect(
      validatePluginQuerySql(
        "synthetic-probe",
        `WITH plg_synthetic_probe__recent AS (
           SELECT id, label FROM plg_synthetic_probe__items WHERE created_at > ?
         )
         SELECT r.id, e.event_name
         FROM plg_synthetic_probe__recent r
         LEFT JOIN plg_synthetic_probe__events e ON e.id = r.id`,
      ).operation,
    ).toBe("SELECT");

    expect(
      validatePluginQuerySql(
        "synthetic-probe",
        "SELECT id FROM plg_synthetic_probe__items WHERE id IN (1, 2, 3)",
      ).operation,
    ).toBe("SELECT");

    expect(
      validatePluginQuerySql(
        "synthetic-probe",
        "SELECT id FROM plg_synthetic_probe__items WHERE id IN (SELECT id FROM plg_synthetic_probe__events)",
      ).operation,
    ).toBe("SELECT");

    expect(
      validatePluginQuerySql(
        "synthetic-probe",
        "INSERT OR IGNORE INTO plg_synthetic_probe__items (label, created_at) VALUES (?, ?)",
      ).operation,
    ).toBe("INSERT");

    const queryAttacks: readonly { readonly name: string; readonly sql: string }[] = [
      // Bare SQLite `IN <table>` / `IN func(...)` without parentheses
      {
        name: "Bare IN core leads table",
        sql: "SELECT id FROM plg_synthetic_probe__items WHERE id IN leads",
      },
      {
        name: "Bare NOT IN core leads in DELETE",
        sql: "DELETE FROM plg_synthetic_probe__items WHERE id NOT IN leads",
      },
      {
        name: "Bare IN schema-qualified main.leads",
        sql: "SELECT id FROM plg_synthetic_probe__items WHERE 1 IN main.leads",
      },
      {
        name: "Bare IN pragma_table_info function",
        sql: "SELECT id FROM plg_synthetic_probe__items WHERE label IN pragma_table_info('leads')",
      },
      {
        name: "Parenthesized expression with bare IN core leads",
        sql: "SELECT id FROM plg_synthetic_probe__items WHERE (id IN leads)",
      },
      {
        name: "JOIN ON expression with bare IN core leads",
        sql: "SELECT a.id FROM plg_synthetic_probe__items a JOIN plg_synthetic_probe__events b ON a.id IN leads",
      },
      // Round-1 critical SQL sandbox escapes
      {
        name: "CTE shadowing UPDATE core leads",
        sql: "WITH leads AS (SELECT 1) UPDATE leads SET name = 'pwned'",
      },
      {
        name: "CTE shadowing DELETE FROM core leads",
        sql: "WITH leads AS (SELECT 1) DELETE FROM leads",
      },
      {
        name: "CTE shadowing INSERT INTO core leads",
        sql: "WITH leads AS (SELECT 1) INSERT INTO leads (id, name) VALUES (1, 'pwn')",
      },
      {
        name: "CTE shadowing SELECT non-plg name",
        sql: "WITH leads AS (SELECT 1) SELECT * FROM leads",
      },
      { name: "Parenthesized FROM (leads)", sql: "SELECT * FROM (leads)" },
      { name: "Double-parenthesized FROM ((leads))", sql: "SELECT * FROM ((leads))" },
      {
        name: "JOIN parenthesized (leads)",
        sql: "SELECT * FROM plg_synthetic_probe__items JOIN (leads) ON 1",
      },
      {
        name: "Parenthesized join list (leads JOIN plg)",
        sql: "SELECT * FROM (leads JOIN plg_synthetic_probe__items ON 1)",
      },
      {
        name: "Comma-join after JOIN ... ON",
        sql: "SELECT * FROM plg_synthetic_probe__items JOIN plg_synthetic_probe__events ON 1, leads",
      },
      {
        name: "Comma-join after JOIN ... USING",
        sql: "SELECT * FROM plg_synthetic_probe__items JOIN plg_synthetic_probe__events USING (id), leads",
      },
      {
        name: "Comma-join after NOT INDEXED",
        sql: "SELECT * FROM plg_synthetic_probe__items NOT INDEXED, leads",
      },
      {
        name: "Comma-join after INDEXED BY",
        sql: "SELECT * FROM plg_synthetic_probe__items INDEXED BY plg_synthetic_probe__items_created_idx, leads",
      },
      {
        name: "INDEXED BY non-plg index",
        sql: "SELECT * FROM plg_synthetic_probe__items INDEXED BY leads_status_created_idx",
      },
      // Baseline core-table & smuggling vectors
      { name: "SELECT core leads", sql: "SELECT * FROM leads" },
      { name: "SELECT installed_plugins", sql: "SELECT * FROM installed_plugins" },
      { name: "SELECT _plugin_migrations", sql: "SELECT * FROM _plugin_migrations" },
      { name: "SELECT sqlite_master", sql: "SELECT name FROM sqlite_master" },
      {
        name: "Comma-join smuggling core table",
        sql: "SELECT a.id FROM plg_synthetic_probe__items a, leads b",
      },
      {
        name: "JOIN smuggling core table",
        sql: "SELECT a.id FROM plg_synthetic_probe__items a JOIN pages p ON a.id = p.id",
      },
      {
        name: "Subquery reading core table",
        sql: "SELECT * FROM plg_synthetic_probe__items WHERE label IN (SELECT email FROM leads)",
      },
      {
        name: "CTE reading core table",
        sql: "WITH plg_synthetic_probe__stolen AS (SELECT email FROM leads) SELECT * FROM plg_synthetic_probe__stolen",
      },
      {
        name: "Multi-statement smuggling",
        sql: "SELECT * FROM plg_synthetic_probe__items; DELETE FROM leads",
      },
      { name: "Cross-plugin table access", sql: "SELECT * FROM plg_other_plugin__items" },
      { name: "Runtime DDL inside query", sql: "CREATE TABLE plg_synthetic_probe__sneaky (id INT)" },
      { name: "Table-valued pragma function", sql: "SELECT * FROM pragma_table_info('leads')" },
      { name: "Schema qualifier bypass", sql: "SELECT * FROM main.plg_synthetic_probe__items" },
    ];

    for (const vec of queryAttacks) {
      expect(
        () => validatePluginQuerySql("synthetic-probe", vec.sql),
        `Expected query attack vector "${vec.name}" to be rejected`,
      ).toThrow(PluginSqlViolationError);
    }
  });

  it("rejects malicious migrations at definePlugin() registration time and enforces registry uniqueness", () => {
    const valid = createSyntheticProbePlugin();
    const registry = createPluginRegistry([valid]);
    expect(registry.get("synthetic-probe")?.manifest.id).toBe("synthetic-probe");
    expect(registry.get("builtin:lead-email-notifications")).toBeNull();
    expect(registry.findByPublicRoute("/probe-widget")?.manifest.id).toBe("synthetic-probe");

    expect(() => createPluginRegistry([valid, valid])).toThrow(/DUPLICATE_ID/);

    expect(() =>
      definePlugin({
        ...valid,
        migrations: [{ version: 1, name: "0001_evil", sql: "DROP TABLE leads;" }],
      }),
    ).toThrow(PluginSqlViolationError);
  });
});
