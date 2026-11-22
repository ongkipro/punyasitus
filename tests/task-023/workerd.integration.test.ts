import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import { createReceiptPdfBytes } from "@punyasitus/core";
import {
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  TENANT_STORE_PROTOCOL,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { JobQueuePayload } from "../../apps/web/src/worker/env.d.ts";
import { SYNTHETIC_PLATFORM_HOSTS, SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";
import worker from "../setup/workerd-entry.ts";

const probeTenantsTable = sqliteTable("_probe_tenants", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  title: text("title").notNull(),
});

const probePagesTable = sqliteTable("_probe_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
});

describe("TASK-023 workerd runtime compatibility spike", () => {
  it("runs Drizzle SQLite queries against PLATFORM_DB (D1)", async () => {
    await env.PLATFORM_DB.prepare(
      `CREATE TABLE IF NOT EXISTS _probe_tenants (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        title TEXT NOT NULL
      )`,
    ).run();

    const db = createSqliteDrizzle(env.PLATFORM_DB, { probeTenantsTable });
    for (const tenant of SYNTHETIC_TENANTS) {
      await db
        .insert(probeTenantsTable)
        .values({ id: tenant.id, handle: tenant.handle, title: tenant.siteTitle })
        .onConflictDoNothing();
    }

    const rows = await db.select().from(probeTenantsTable);
    expect(rows.map((r) => r.handle).sort()).toEqual(["alpha-studio", "beta-klinik"]);
  });

  it("isolates two synthetic tenants in separate SQLite TenantStore DOs via D1Database RPC adapter", async () => {
    const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
    const stubA = openTenantStoreStub(ns, SYNTHETIC_TENANTS[0].id);
    const stubB = openTenantStoreStub(ns, SYNTHETIC_TENANTS[1].id);
    const dbA = createTenantDb(stubA);
    const dbB = createTenantDb(stubB);

    const ddl = `CREATE TABLE IF NOT EXISTS _probe_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL
    )`;
    await dbA.prepare(ddl).run();
    await dbB.prepare(ddl).run();

    const insertA = await dbA
      .prepare("INSERT INTO _probe_pages (slug, title) VALUES (?, ?)")
      .bind("beranda", "Beranda Alpha")
      .run();
    expect(insertA.meta.changes).toBe(1);
    expect(insertA.meta.last_row_id).toBeGreaterThan(0);

    // Atomic batch rollback test: duplicate unique slug in second statement rolls back first statement
    await expect(
      dbA.batch([
        dbA.prepare("INSERT INTO _probe_pages (slug, title) VALUES (?, ?)").bind("tentang", "Tentang"),
        dbA.prepare("INSERT INTO _probe_pages (slug, title) VALUES (?, ?)").bind("beranda", "Duplicate"),
      ]),
    ).rejects.toThrow();

    const drizzleA = createSqliteDrizzle(dbA, { probePagesTable });
    const drizzleB = createSqliteDrizzle(dbB, { probePagesTable });
    const pagesA = await drizzleA.select().from(probePagesTable);
    const pagesB = await drizzleB.select().from(probePagesTable);

    // Tenant A has only the initial committed row (atomic rollback preserved); Tenant B sees zero rows from A
    expect(pagesA.map((p) => p.slug)).toEqual(["beranda"]);
    expect(pagesB).toEqual([]);
  });

  it("instantiates per-request Better Auth (provider: sqlite, joins: true) on PLATFORM_DB", () => {
    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: `https://${SYNTHETIC_PLATFORM_HOSTS.app}`,
      secret: "0123456789abcdef0123456789abcdef",
    });
    expect(typeof auth.handler).toBe("function");
    expect(auth.options.advanced?.database?.joins).toBe(true);
  });

  it("runs Queue producer/consumer, Durable Object alarm(), and Cron scheduled() locally", async () => {
    // 1. Queue producer send
    const payload: JobQueuePayload = {
      idempotencyKey: "spike-job-001",
      topic: "spike.verify",
      tenantId: SYNTHETIC_TENANTS[0].id,
    };
    await env.JOBS_QUEUE.send(payload);

    // 2. Queue consumer batch execution (idempotent on duplicate delivery)
    const batch = createMessageBatch("punyasitus-jobs-test", [
      { id: "m1", timestamp: new Date(), body: payload, attempts: 1 },
      { id: "m2", timestamp: new Date(), body: payload, attempts: 2 },
    ]);
    const qCtx = createExecutionContext();
    await worker.queue(batch as unknown as MessageBatch<JobQueuePayload>, env);
    await waitOnExecutionContext(qCtx);

    const jobRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM _bootstrap_job_ledger WHERE idempotency_key = ?",
    )
      .bind("spike-job-001")
      .first<{ cnt: number }>();
    expect(jobRow?.cnt).toBe(1);

    // 3. Durable Object alarm()
    const ns = env.TENANT_STORE as unknown as DurableObjectNamespace;
    const id = ns.idFromName(SYNTHETIC_TENANTS[0].id);
    const stub = env.TENANT_STORE.get(id);
    await stub.armAlarm(TENANT_STORE_PROTOCOL, 5_000);
    const alarmRan = await runDurableObjectAlarm(stub);
    expect(alarmRan).toBe(true);
    const alarmState = await stub.alarmState(TENANT_STORE_PROTOCOL);
    expect(alarmState.runs).toBeGreaterThanOrEqual(1);
    expect(alarmState.lastRunAt).not.toBeNull();

    // 4. Cron scheduled()
    const ctrl = createScheduledController({
      cron: "7 * * * *",
      scheduledTime: 1_763_820_420_000,
    });
    const cCtx = createExecutionContext();
    await worker.scheduled(ctrl, env);
    await waitOnExecutionContext(cCtx);

    const cronRow = await env.PLATFORM_DB.prepare(
      "SELECT cron, scheduled_time FROM _bootstrap_cron_ticks WHERE cron = ? AND scheduled_time = ?",
    )
      .bind("7 * * * *", 1_763_820_420_000)
      .first<{ cron: string; scheduled_time: number }>();
    expect(cronRow).toEqual({ cron: "7 * * * *", scheduled_time: 1_763_820_420_000 });
  });

  it("handles Step 0 DCV pass-through and all 4 host surfaces plus pdf-lib in workerd", async () => {
    const workerExports = exports as unknown as {
      default: { fetch(request: Request): Promise<Response> };
    };
    const dcv = await workerExports.default.fetch(
      new Request("https://custom.example.id/.well-known/pki-validation/test.txt"),
    );
    expect(dcv.status).toBe(200);
    expect(dcv.headers.get("X-DCV-Pass-Through")).toBe("1");

    const surfaces = [
      ["punyasitus.com", 200, "marketing"],
      ["app.punyasitus.com", 200, "app"],
      ["console.punyasitus.com", 200, "console"],
      ["alpha-studio.situsku.click", 200, "tenant"],
      ["unknown.invalid", 404, "unknown"],
    ] as const;

    for (const [host, expectedStatus, expectedSurface] of surfaces) {
      const res = await workerExports.default.fetch(new Request(`https://${host}/`));
      expect(res.status).toBe(expectedStatus);
      expect(res.headers.get("X-PunyaSitus-Surface")).toBe(expectedSurface);
    }

    const pdf = await createReceiptPdfBytes({
      receiptNumber: "PS-2026-00002",
      tenantName: SYNTHETIC_TENANTS[1].siteTitle,
      amountIdr: 1_790_000,
    });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
});
