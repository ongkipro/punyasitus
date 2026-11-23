import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createAuth } from "@punyasitus/auth";
import {
  ALLOWED_EMAIL_SENDER,
  createLocalMailSink,
  type EmailPort,
  type EmailSendRequest,
  type EmailSendResult,
} from "@punyasitus/core/email/index";
import { buildMonthlyReportMessageKey } from "@punyasitus/core/reports/index";
import { applyTenantInsightsMigrations } from "@punyasitus/db/analytics/index";
import {
  createTenantDb,
  openTenantStoreStub,
  splitMigrationStatements,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { applyEmailClaimsMigration, getEmailDeliveryClaim } from "@punyasitus/db/email/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { handleNotificationSettingsApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/settings/notifications/api.ts";
import {
  enqueueMonthlyPerformanceReportJobs,
} from "../../apps/web/src/worker/cron/monthly-report.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  createMonthlyReportQueueRegistry,
  executeMonthlyOwnerReportForTenant,
  listRecentMonthlyReportDeliveries,
  setTenantNotificationPreferences,
} from "../../apps/web/src/worker/queues/reports/index.ts";

const TEST_AUTH_SECRET = "local-dev-app-punyasitus-auth-secret-0123456789abcdef";
const DEC_1_2026_WIB_MS = Date.UTC(2026, 11, 1, 1, 0, 0); // 2026-12-01 08:00 WIB
const DEC_2_2026_WIB_MS = Date.UTC(2026, 11, 2, 1, 0, 0); // 2026-12-02 08:00 WIB

interface CapturedQueueMessage {
  readonly id: string;
  readonly body: unknown;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function makeFakeQueue() {
  const sent: unknown[] = [];
  return {
    sent,
    async send(message: unknown): Promise<void> {
      sent.push(message);
    },
    toMessageBatch(): {
      readonly batch: MessageBatch<unknown>;
      readonly tracked: readonly CapturedQueueMessage[];
    } {
      const tracked: CapturedQueueMessage[] = sent.map((body, idx) => {
        const msg: CapturedQueueMessage = {
          id: `msg_${idx + 1}`,
          body,
          acked: false,
          retried: false,
          ack() {
            msg.acked = true;
          },
          retry() {
            msg.retried = true;
          },
        };
        return msg;
      });
      const batch = {
        queue: "punyasitus-jobs-test",
        messages: tracked,
        ackAll() {
          for (const m of tracked) m.ack();
        },
        retryAll() {
          for (const m of tracked) m.retry();
        },
      } as unknown as MessageBatch<unknown>;
      return { batch, tracked };
    },
  };
}

async function migratePlatformDb(): Promise<void> {
  const statements = splitMigrationStatements(PLATFORM_MIGRATIONS[0]!.sql);
  for (const stmt of statements) {
    await env.PLATFORM_DB.prepare(stmt).run();
  }
  await applyEmailClaimsMigration(env.PLATFORM_DB);
}

async function openTenantDbWithInsights(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawStub, async (_instance, state) => {
    await applyTenantInsightsMigrations(state.storage as unknown as StorageLike);
  });
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function seedTenantPlatformRecords(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly owner?: { readonly id: string; readonly name: string; readonly email: string };
  readonly agencyStaff?: { readonly id: string; readonly name: string; readonly email: string };
  readonly nowMs: number;
}): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(params.orgId, params.name, params.handle, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      params.status,
      params.nowMs,
      params.nowMs,
    ),
  ];

  if (params.owner) {
    stmts.push(
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      ).bind(params.owner.id, params.owner.name, params.owner.email, params.nowMs, params.nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'owner', ?)`,
      ).bind(`mem_owner_${params.tenantId}`, params.orgId, params.owner.id, params.nowMs),
    );
  }

  if (params.agencyStaff) {
    stmts.push(
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      ).bind(
        params.agencyStaff.id,
        params.agencyStaff.name,
        params.agencyStaff.email,
        params.nowMs,
        params.nowMs,
      ),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'agency_staff', ?)`,
      ).bind(`mem_agency_${params.tenantId}`, params.orgId, params.agencyStaff.id, params.nowMs),
    );
  }

  await env.PLATFORM_DB.batch(stmts);
}

describe("TASK-110 workerd integration — Monthly owner report cron, queue delivery, idempotency, PII isolation, DEC-041 no blind retry & notification settings API", () => {
  beforeAll(async () => {
    await migratePlatformDb();
  });

  it("sends 1 PII-free monthly report per eligible active website, skips below-threshold/opted-out/agency-only/inactive sites, and stays idempotent on replay", async () => {
    const nowMs = DEC_1_2026_WIB_MS;
    const tEligible = "ten_t110_eligible";
    const tLowActivity = "ten_t110_low";
    const tOptedOut = "ten_t110_optout";
    const tAgencyOnly = "ten_t110_agency_only";
    const tTrial = "ten_t110_trial";

    // 1. Seed platform records
    await seedTenantPlatformRecords({
      tenantId: tEligible,
      orgId: "org_t110_eligible",
      handle: "studio-karya-t110",
      name: "Studio Karya & <Design>",
      status: "active",
      owner: {
        id: "usr_t110_owner_a",
        name: "Rina Pemilik",
        email: "rina.owner@studio-karya.test",
      },
      agencyStaff: {
        id: "usr_t110_agency_a",
        name: "Staff Agensi",
        email: "staff@agensi-luar.test",
      },
      nowMs,
    });

    await seedTenantPlatformRecords({
      tenantId: tLowActivity,
      orgId: "org_t110_low",
      handle: "warung-sepi-t110",
      name: "Warung Sepi",
      status: "active",
      owner: {
        id: "usr_t110_owner_b",
        name: "Joko Pemilik",
        email: "joko.owner@warung-sepi.test",
      },
      nowMs,
    });

    await seedTenantPlatformRecords({
      tenantId: tOptedOut,
      orgId: "org_t110_optout",
      handle: "klinik-optout-t110",
      name: "Klinik OptOut",
      status: "active",
      owner: {
        id: "usr_t110_owner_c",
        name: "Siti Pemilik",
        email: "siti.owner@klinik-optout.test",
      },
      nowMs,
    });

    await seedTenantPlatformRecords({
      tenantId: tAgencyOnly,
      orgId: "org_t110_agency_only",
      handle: "klien-agensi-t110",
      name: "Klien Agensi Tanpa Owner",
      status: "active",
      agencyStaff: {
        id: "usr_t110_agency_only",
        name: "Agensi Saja",
        email: "agensi-saja@agency.test",
      },
      nowMs,
    });

    await seedTenantPlatformRecords({
      tenantId: tTrial,
      orgId: "org_t110_trial",
      handle: "situs-trial-t110",
      name: "Situs Trial",
      status: "trial",
      owner: {
        id: "usr_t110_owner_trial",
        name: "Owner Trial",
        email: "trial.owner@example.test",
      },
      nowMs,
    });

    // Opt out Tenant C
    await setTenantNotificationPreferences(env.PLATFORM_DB, {
      tenantId: tOptedOut,
      actorUserId: "usr_t110_owner_c",
      monthlyPerformanceReportEnabled: false,
      nowMs,
    });

    // 2. Seed TenantStore DOs (analytics + raw leads with visitor PII on Tenant A)
    const dbEligible = await openTenantDbWithInsights(tEligible);
    await dbEligible.batch([
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO offerings (id, offering_type, slug, title, status, published_at, created_at, updated_at)
           VALUES (10, 'service', 'jasa-branding', 'Jasa <Branding> UMKM', 'published', ?, ?, ?)`,
        )
        .bind(nowMs, nowMs, nowMs),
      // Seed sensitive visitor PII into `leads` table — MUST NEVER leak into monthly report!
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO leads (
             id, name, phone_e164, email, message, source_category, page_path, status, created_at, updated_at
           ) VALUES (
             1, 'Budi Pengunjung Rahasia', '+6281234567890', 'budi.visitor@secret-client.test',
             'Halo saya mau pesan 500 unit rahasia IP 203.0.113.99', 'ai_assistant',
             '/layanan/jasa-branding', 'new', ?, ?
           )`,
        )
        .bind(nowMs, nowMs),
      // Previous month (2026-10) aggregates
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO analytics_content_daily
             (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-10-12', 'offering', 10, '/layanan/jasa-branding', 50, 5, 0, 2, ?)`,
        )
        .bind(nowMs),
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO analytics_sources_daily
             (day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-10-12', 'ai_assistant', 'chatgpt.com', 3, 0, 0, 0, ?)`,
        )
        .bind(nowMs),
      // Report month (2026-11) aggregates
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO analytics_content_daily
             (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-11-08', 'page', 1, '/', 45, 3, 0, 1, ?)`,
        )
        .bind(nowMs),
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO analytics_content_daily
             (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-11-15', 'offering', 10, '/layanan/jasa-branding', 80, 14, 1, 5, ?)`,
        )
        .bind(nowMs),
      dbEligible
        .prepare(
          `INSERT OR REPLACE INTO analytics_sources_daily
             (day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-11-15', 'ai_assistant', 'chatgpt.com', 7, 2, 0, 1, ?)`,
        )
        .bind(nowMs),
    ]);

    // Tenant B: low activity (3 visits, 0 leads, 0 WA clicks -> below threshold!)
    const dbLow = await openTenantDbWithInsights(tLowActivity);
    await dbLow
      .prepare(
        `INSERT OR REPLACE INTO analytics_content_daily
           (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
         VALUES ('2026-11-10', 'page', 1, '/', 3, 0, 0, 0, ?)`,
      )
      .bind(nowMs)
      .run();

    // Tenant C: high activity, but opted out
    const dbOptOut = await openTenantDbWithInsights(tOptedOut);
    await dbOptOut
      .prepare(
        `INSERT OR REPLACE INTO analytics_content_daily
           (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
         VALUES ('2026-11-10', 'page', 1, '/', 120, 15, 0, 4, ?)`,
      )
      .bind(nowMs)
      .run();

    // 3. Running cron on Dec 2 (NOT 1st of month) must do nothing
    const nonFirstQueue = makeFakeQueue();
    const skippedDay = await enqueueMonthlyPerformanceReportJobs(
      { PLATFORM_DB: env.PLATFORM_DB, JOBS_QUEUE: nonFirstQueue },
      { nowMs: DEC_2_2026_WIB_MS },
    );
    expect(skippedDay.ran).toBe(false);
    expect(skippedDay.skipReason).toBe("not_first_day_of_month");
    expect(nonFirstQueue.sent).toHaveLength(0);

    // 4. Run cron on Dec 1 WIB -> summarizes 2026-11
    const queue = makeFakeQueue();
    const firstDispatch = await enqueueMonthlyPerformanceReportJobs(
      { PLATFORM_DB: env.PLATFORM_DB, JOBS_QUEUE: queue },
      { nowMs: DEC_1_2026_WIB_MS },
    );
    expect(firstDispatch.ran).toBe(true);
    expect(firstDispatch.period.reportMonth).toBe("2026-11");
    expect(firstDispatch.enqueuedTenantIds).toContain(tEligible);
    expect(firstDispatch.enqueuedTenantIds).toContain(tLowActivity);
    expect(firstDispatch.skippedOptedOutTenantIds).toContain(tOptedOut);
    expect(firstDispatch.enqueuedTenantIds).not.toContain(tAgencyOnly);
    expect(firstDispatch.enqueuedTenantIds).not.toContain(tTrial);

    // Verify ZERO recipient email PII is persisted inside job_ledger.payload_json
    const jobRows = await env.PLATFORM_DB.prepare(
      "SELECT payload_json FROM job_ledger WHERE topic = 'reports.monthly_owner.send'",
    ).all<{ payload_json: string }>();
    const serializedPayloads = JSON.stringify(jobRows.results ?? []);
    expect(serializedPayloads).not.toContain("rina.owner@studio-karya.test");
    expect(serializedPayloads).not.toContain("joko.owner@warung-sepi.test");

    // 5. Process queue batch with local mail sink
    const mailSink = createLocalMailSink();
    const registry = createMonthlyReportQueueRegistry({
      emailPort: mailSink,
      now: () => DEC_1_2026_WIB_MS,
      resolveTenantDb: (tid) => {
        if (tid === tEligible) return dbEligible;
        if (tid === tLowActivity) return dbLow;
        if (tid === tOptedOut) return dbOptOut;
        return openTenantDbWithInsights(tid);
      },
    });

    const { batch, tracked } = queue.toMessageBatch();
    const batchResult = await processDurableQueueBatch(
      batch,
      { PLATFORM_DB: env.PLATFORM_DB },
      registry,
      { now: () => DEC_1_2026_WIB_MS },
    );
    expect(batchResult.retried).toBe(0);
    expect(batchResult.deadLettered).toBe(0);
    expect(tracked.every((m) => m.acked && !m.retried)).toBe(true);

    // Exactly 1 email sent — strictly to Tenant A's own owner (NOT agency staff, NOT low-activity, NOT opted-out)
    expect(mailSink.list()).toHaveLength(1);
    const email = mailSink.list()[0]!;
    expect(email.from).toBe(ALLOWED_EMAIL_SENDER);
    expect(email.to).toBe("rina.owner@studio-karya.test");
    expect(email.to).not.toBe("staff@agensi-luar.test");
    expect(email.subject).toContain("November 2026");

    // Verify metrics, MoM comparison, escaped offering title, AI referrals (page_views only = 7), 1 tip & opt-out link
    expect(email.html).toContain("Studio Karya &amp; &lt;Design&gt;");
    expect(email.html).toContain("Jasa &lt;Branding&gt; UMKM");
    expect(email.html).toContain("125"); // 45 + 80 visits
    expect(email.html).toContain("17"); // 3 + 14 WA clicks
    expect(email.html).toContain("1 Saran Peningkatan Bulan Depan");
    expect(email.html).toContain(
      "https://app.punyasitus.com/dashboard/studio-karya-t110/settings/notifications",
    );
    expect(email.text).toContain("Kunjungan: 125");
    expect(email.text).toContain("Pesan Masuk: 6");
    expect(email.text).toContain("Klik WhatsApp: 17");
    expect(email.text).toContain("Rujukan Asisten AI: 7");

    // Verify ZERO visitor personal data leaked from `leads` table!
    const combinedEmail = `${email.subject}\n${email.html}\n${email.text}`;
    for (const secretPii of [
      "Budi Pengunjung Rahasia",
      "+6281234567890",
      "budi.visitor@secret-client.test",
      "500 unit rahasia",
      "203.0.113.99",
    ]) {
      expect(combinedEmail).not.toContain(secretPii);
    }

    // Verify durable claim records for all 3 active sites
    const claimEligible = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tEligible, "2026-11"),
    );
    expect(claimEligible?.status).toBe("submitted");

    const claimLow = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tLowActivity, "2026-11"),
    );
    expect(claimLow?.status).toBe("skipped");
    expect(claimLow?.errorCode).toBe("E_BELOW_ACTIVITY_THRESHOLD");

    const claimOptOut = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tOptedOut, "2026-11"),
    );
    expect(claimOptOut?.status).toBe("skipped");
    expect(claimOptOut?.errorCode).toBe("E_REPORT_OPTED_OUT");

    // 6. Idempotency + terminal claim preservation:
    //    Even if owner opts out AFTER report was already submitted on the same day,
    //    subsequent hourly cron sweep & direct replay NEVER overwrite `submitted` with `skipped`!
    await setTenantNotificationPreferences(env.PLATFORM_DB, {
      tenantId: tEligible,
      actorUserId: "usr_t110_owner_a",
      monthlyPerformanceReportEnabled: false,
      nowMs: DEC_1_2026_WIB_MS + 3_600_000,
    });

    const secondQueue = makeFakeQueue();
    const secondDispatch = await enqueueMonthlyPerformanceReportJobs(
      { PLATFORM_DB: env.PLATFORM_DB, JOBS_QUEUE: secondQueue },
      { nowMs: DEC_1_2026_WIB_MS + 3_600_000 },
    );
    expect(secondDispatch.enqueuedTenantIds).not.toContain(tEligible);
    expect(secondDispatch.skippedOptedOutTenantIds).not.toContain(tEligible);

    // Direct handler call after late opt-out also MUST NOT overwrite `submitted`
    await executeMonthlyOwnerReportForTenant(
      { PLATFORM_DB: env.PLATFORM_DB },
      { tenantId: tEligible, reportMonth: "2026-11" },
      { emailPort: mailSink, resolveTenantDb: () => dbEligible, now: () => DEC_1_2026_WIB_MS + 3_600_000 },
    );

    const claimStillSubmitted = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tEligible, "2026-11"),
    );
    expect(claimStillSubmitted?.status).toBe("submitted");
    expect(claimStillSubmitted?.errorCode).toBeNull();

    // Re-enable and verify direct replay returns `duplicate` with zero extra sends
    await setTenantNotificationPreferences(env.PLATFORM_DB, {
      tenantId: tEligible,
      actorUserId: "usr_t110_owner_a",
      monthlyPerformanceReportEnabled: true,
      nowMs: DEC_1_2026_WIB_MS + 7_200_000,
    });
    const replayOutcome = await executeMonthlyOwnerReportForTenant(
      { PLATFORM_DB: env.PLATFORM_DB },
      { tenantId: tEligible, reportMonth: "2026-11" },
      { emailPort: mailSink, resolveTenantDb: () => dbEligible, now: () => DEC_1_2026_WIB_MS + 7_200_000 },
    );
    expect(replayOutcome.status).toBe("duplicate");
    expect(mailSink.list()).toHaveLength(1);
  });

  it("records failed and unknown EmailPort.send() outcomes durably and NEVER blindly retries or replays (DEC-041)", async () => {
    const nowMs = DEC_1_2026_WIB_MS;
    const tFail = "ten_t110_fail";
    const tUnknown = "ten_t110_unknown";

    await seedTenantPlatformRecords({
      tenantId: tFail,
      orgId: "org_t110_fail",
      handle: "toko-gagal-t110",
      name: "Toko Gagal",
      status: "active",
      owner: {
        id: "usr_t110_fail_owner",
        name: "Pemilik Gagal",
        email: "fail.owner@toko-gagal.test",
      },
      nowMs,
    });
    await seedTenantPlatformRecords({
      tenantId: tUnknown,
      orgId: "org_t110_unknown",
      handle: "toko-timeout-t110",
      name: "Toko Timeout",
      status: "active",
      owner: {
        id: "usr_t110_unknown_owner",
        name: "Pemilik Timeout",
        email: "timeout.owner@toko-timeout.test",
      },
      nowMs,
    });

    const dbFail = await openTenantDbWithInsights(tFail);
    const dbUnknown = await openTenantDbWithInsights(tUnknown);
    for (const db of [dbFail, dbUnknown]) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO analytics_content_daily
             (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-11-10', 'page', 1, '/', 30, 5, 0, 2, ?)`,
        )
        .bind(nowMs)
        .run();
    }

    let failPortCalls = 0;
    const failingPort: EmailPort = {
      provider: "cloudflare",
      async send(_req: EmailSendRequest): Promise<EmailSendResult> {
        failPortCalls += 1;
        return {
          outcome: "failed",
          provider: "cloudflare",
          errorCode: "E_RATE_LIMITED",
          retryable: true, // Even if provider says retryable, DEC-041 monthly report MUST NOT blind-retry!
          suppressed: false,
          retryAfterSeconds: 30,
        };
      },
    };

    const failQueue = makeFakeQueue();
    await failQueue.send({
      idempotencyKey: buildMonthlyReportMessageKey(tFail, "2026-11"),
      topic: "reports.monthly_owner.send",
      tenantId: tFail,
      payload: { tenantId: tFail, reportMonth: "2026-11" },
      maxAttempts: 1,
      correlationId: "test-fail",
      enqueuedAt: nowMs,
    });

    const { batch: failBatch, tracked: failTracked } = failQueue.toMessageBatch();
    const failBatchRes = await processDurableQueueBatch(
      failBatch,
      { PLATFORM_DB: env.PLATFORM_DB },
      createMonthlyReportQueueRegistry({
        emailPort: failingPort,
        resolveTenantDb: () => dbFail,
        now: () => nowMs,
      }),
      { now: () => nowMs },
    );

    expect(failPortCalls).toBe(1);
    expect(failBatchRes.retried).toBe(0);
    expect(failBatchRes.deadLettered).toBe(1);
    expect(failTracked[0]?.acked).toBe(true);
    expect(failTracked[0]?.retried).toBe(false);

    const failClaim = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tFail, "2026-11"),
    );
    expect(failClaim?.status).toBe("failed");
    expect(failClaim?.errorCode).toBe("E_RATE_LIMITED");
    expect(failClaim?.attempts).toBe(1);

    // Replaying directly MUST NOT invoke EmailPort.send() a second time
    const failReplay = await executeMonthlyOwnerReportForTenant(
      { PLATFORM_DB: env.PLATFORM_DB },
      { tenantId: tFail, reportMonth: "2026-11" },
      { emailPort: failingPort, resolveTenantDb: () => dbFail, now: () => nowMs },
    );
    expect(failReplay.status).toBe("duplicate");
    expect(failPortCalls).toBe(1);

    // Unknown / timeout outcome -> recorded as `unknown`, acked without retry, never replayed
    let unknownPortCalls = 0;
    const timeoutPort: EmailPort = {
      provider: "cloudflare",
      async send(_req: EmailSendRequest): Promise<EmailSendResult> {
        unknownPortCalls += 1;
        return {
          outcome: "unknown",
          provider: "cloudflare",
          errorCode: "E_NETWORK_TIMEOUT",
        };
      },
    };

    const unknownRes = await executeMonthlyOwnerReportForTenant(
      { PLATFORM_DB: env.PLATFORM_DB },
      { tenantId: tUnknown, reportMonth: "2026-11" },
      { emailPort: timeoutPort, resolveTenantDb: () => dbUnknown, now: () => nowMs },
    );
    expect(unknownRes.status).toBe("unknown_no_retry");
    expect(unknownPortCalls).toBe(1);

    const unknownClaim = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tUnknown, "2026-11"),
    );
    expect(unknownClaim?.status).toBe("unknown");
    expect(unknownClaim?.errorCode).toBe("E_NETWORK_TIMEOUT");

    const unknownReplay = await executeMonthlyOwnerReportForTenant(
      { PLATFORM_DB: env.PLATFORM_DB },
      { tenantId: tUnknown, reportMonth: "2026-11" },
      { emailPort: timeoutPort, resolveTenantDb: () => dbUnknown, now: () => nowMs },
    );
    expect(unknownReplay.status).toBe("duplicate");
    expect(unknownPortCalls).toBe(1);

    // Thrown transport error (ambiguous network failure) -> recorded as `unknown`, acked with retried = 0, zero replay
    const tThrown = "ten_t110_thrown";
    const tRenderErr = "ten_t110_render_err";
    await seedTenantPlatformRecords({
      tenantId: tThrown,
      orgId: "org_t110_thrown",
      handle: "toko-thrown-t110",
      name: "Toko Thrown",
      status: "active",
      owner: {
        id: "usr_t110_thrown_owner",
        name: "Pemilik Thrown",
        email: "thrown.owner@toko-thrown.test",
      },
      nowMs,
    });
    await seedTenantPlatformRecords({
      tenantId: tRenderErr,
      orgId: "org_t110_render_err",
      handle: "toko-render-err-t110",
      name: "Toko Render Error",
      status: "active",
      owner: {
        id: "usr_t110_render_err_owner",
        name: "Pemilik Render",
        email: "render.owner@toko-render.test",
      },
      nowMs,
    });
    const dbThrown = await openTenantDbWithInsights(tThrown);
    const dbRenderErr = await openTenantDbWithInsights(tRenderErr);
    for (const db of [dbThrown, dbRenderErr]) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO analytics_content_daily
             (day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits, updated_at)
           VALUES ('2026-11-10', 'page', 1, '/', 25, 3, 0, 1, ?)`,
        )
        .bind(nowMs)
        .run();
    }

    let thrownPortCalls = 0;
    const throwingPort: EmailPort = {
      provider: "cloudflare",
      async send(_req: EmailSendRequest): Promise<EmailSendResult> {
        thrownPortCalls += 1;
        throw new Error("ETIMEDOUT: socket hang up");
      },
    };

    const thrownQueue = makeFakeQueue();
    await thrownQueue.send({
      idempotencyKey: buildMonthlyReportMessageKey(tThrown, "2026-11"),
      topic: "reports.monthly_owner.send",
      tenantId: tThrown,
      payload: { tenantId: tThrown, reportMonth: "2026-11" },
      maxAttempts: 1,
      correlationId: "test-thrown",
      enqueuedAt: nowMs,
    });
    const { batch: thrownBatch, tracked: thrownTracked } = thrownQueue.toMessageBatch();
    const thrownBatchRes = await processDurableQueueBatch(
      thrownBatch,
      { PLATFORM_DB: env.PLATFORM_DB },
      createMonthlyReportQueueRegistry({
        emailPort: throwingPort,
        resolveTenantDb: () => dbThrown,
        now: () => nowMs,
      }),
      { now: () => nowMs },
    );
    expect(thrownPortCalls).toBe(1);
    expect(thrownBatchRes.retried).toBe(0);
    expect(thrownBatchRes.deadLettered).toBe(1);
    expect(thrownTracked[0]?.acked).toBe(true);
    expect(thrownTracked[0]?.retried).toBe(false);

    const thrownClaim = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tThrown, "2026-11"),
    );
    expect(thrownClaim?.status).toBe("unknown");
    expect(thrownClaim?.errorCode).toBeTruthy();

    // Render error after claim (e.g. invalid appBaseUrl) -> records `failed`, never stuck `claimed`, zero replay
    const renderSink = createLocalMailSink();
    const renderQueue = makeFakeQueue();
    await renderQueue.send({
      idempotencyKey: buildMonthlyReportMessageKey(tRenderErr, "2026-11"),
      topic: "reports.monthly_owner.send",
      tenantId: tRenderErr,
      payload: { tenantId: tRenderErr, reportMonth: "2026-11" },
      maxAttempts: 1,
      correlationId: "test-render-err",
      enqueuedAt: nowMs,
    });
    const { batch: renderBatch, tracked: renderTracked } = renderQueue.toMessageBatch();
    const renderBatchRes = await processDurableQueueBatch(
      renderBatch,
      { PLATFORM_DB: env.PLATFORM_DB },
      createMonthlyReportQueueRegistry({
        emailPort: renderSink,
        appBaseUrl: "javascript:alert(1)",
        resolveTenantDb: () => dbRenderErr,
        now: () => nowMs,
      }),
      { now: () => nowMs },
    );
    expect(renderSink.list()).toHaveLength(0);
    expect(renderBatchRes.retried).toBe(0);
    expect(renderBatchRes.deadLettered).toBe(1);
    expect(renderTracked[0]?.acked).toBe(true);

    const renderClaim = await getEmailDeliveryClaim(
      env.PLATFORM_DB,
      buildMonthlyReportMessageKey(tRenderErr, "2026-11"),
    );
    expect(renderClaim?.status).toBe("failed");
    expect(renderClaim?.status).not.toBe("claimed");
    expect(renderClaim?.errorCode).toBe("E_INVALID_TEMPLATE_URL");
  });

  it("paginates cron sweep past limit by excluding already-processed tenants and avoids SQL wildcard bleed in delivery history", async () => {
    const nowMs = Date.UTC(2026, 9, 1, 1, 0, 0); // 2026-10-01 WIB -> reportMonth 2026-09
    const reportMonth = "2026-09";
    const batchIds = ["ten_page_a_1", "ten_page_aX1", "ten_page_b_2"] as const;

    for (let i = 0; i < batchIds.length; i += 1) {
      const tid = batchIds[i]!;
      await seedTenantPlatformRecords({
        tenantId: tid,
        orgId: `org_${tid}`,
        handle: `page-site-${i + 1}`,
        name: `Page Site ${i + 1}`,
        status: "active",
        owner: {
          id: `usr_${tid}`,
          name: `Owner ${i + 1}`,
          email: `owner.${tid}@example.test`,
        },
        nowMs: nowMs + i,
      });
    }

    // Run sweeps with limit=1 for reportMonth=2026-09 until all 3 tenants are reached
    const seen = new Set<string>();
    for (let sweep = 0; sweep < 20; sweep += 1) {
      const q = makeFakeQueue();
      const res = await enqueueMonthlyPerformanceReportJobs(
        { PLATFORM_DB: env.PLATFORM_DB, JOBS_QUEUE: q },
        { nowMs, reportMonth, forceRun: true, limit: 1 },
      );
      for (const id of res.enqueuedTenantIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      if (batchIds.every((id) => seen.has(id))) break;
      if (res.scannedActiveTenants === 0) break;
    }

    for (const id of batchIds) {
      expect(seen.has(id)).toBe(true);
    }

    // Wildcard safety check: `ten_page_a_1` MUST NOT match `ten_page_aX1` in listRecentMonthlyReportDeliveries
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO email_delivery_claims
           (message_key, template, one_shot, status, provider, error_code, attempts, created_at, updated_at)
         VALUES (?, 'monthly-owner-performance-report', 1, 'submitted', 'cloudflare', NULL, 1, ?, ?)`,
      ).bind(buildMonthlyReportMessageKey("ten_page_a_1", "2026-09"), nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO email_delivery_claims
           (message_key, template, one_shot, status, provider, error_code, attempts, created_at, updated_at)
         VALUES (?, 'monthly-owner-performance-report', 1, 'failed', 'cloudflare', 'E_OTHER', 1, ?, ?)`,
      ).bind(buildMonthlyReportMessageKey("ten_page_aX1", "2026-08"), nowMs, nowMs),
    ]);

    const historyA1 = await listRecentMonthlyReportDeliveries(env.PLATFORM_DB, "ten_page_a_1", 6);
    expect(historyA1).toHaveLength(1);
    expect(historyA1[0]?.reportMonth).toBe("2026-09");
    expect(historyA1[0]?.status).toBe("submitted");
  });

  it("enforces owner-only RBAC, tenant isolation, CSRF protection, and durable opt-out toggling on /settings/notifications/api", async () => {
    const nowMs = Date.now();
    const appOrigin = "https://app.punyasitus.com";
    const tenantHandle = `notif-site-${nowMs}`;
    const tenantId = `ten_notif_${nowMs}`;
    const orgId = `org_notif_${nowMs}`;

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
         VALUES (?, 'Notif Studio', ?, ?, ?)`,
      ).bind(orgId, tenantHandle, nowMs, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT OR REPLACE INTO tenants (
           id, organization_id, handle, name, vertical, status, operator_hold,
           cache_version, schema_version, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'Notif Studio', 'compro', 'active', 0, 1, 1, 1, ?, ?)`,
      ).bind(tenantId, orgId, tenantHandle, nowMs, nowMs),
    ]);

    const auth = createAuth(env.PLATFORM_DB, {
      baseURL: appOrigin,
      secret: TEST_AUTH_SECRET,
      surface: "app",
      trustedOrigins: [appOrigin],
    });

    async function signUpUser(email: string, name: string) {
      const res = await auth.handler(
        new Request(`${appOrigin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: appOrigin },
          body: JSON.stringify({ email, password: "StrongPassword!123", name }),
        }),
      );
      expect(res.status).toBe(200);
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const body = (await res.json()) as { user: { id: string } };
      return { userId: body.user.id, cookie };
    }

    const owner = await signUpUser(`owner.t110.${nowMs}@example.test`, "Owner Notif");
    const admin = await signUpUser(`admin.t110.${nowMs}@example.test`, "Admin Notif");
    const editor = await signUpUser(`editor.t110.${nowMs}@example.test`, "Editor Notif");
    const outsider = await signUpUser(`outsider.t110.${nowMs}@example.test`, "Outsider");

    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`,
      ).bind(`mem_o_${nowMs}`, orgId, owner.userId, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)`,
      ).bind(`mem_a_${nowMs}`, orgId, admin.userId, nowMs),
      env.PLATFORM_DB.prepare(
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'editor', ?)`,
      ).bind(`mem_e_${nowMs}`, orgId, editor.userId, nowMs),
    ]);

    const runtimeEnv = {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      APP_AUTH_SECRET: TEST_AUTH_SECRET,
      PLATFORM_DB: env.PLATFORM_DB,
    };

    const apiUrl = `${appOrigin}/dashboard/${tenantHandle}/settings/notifications/api`;

    // 1. Unauthenticated -> 401
    const unauthRes = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, { method: "GET" }),
      runtimeEnv,
      { nowMs },
    );
    expect(unauthRes.status).toBe(401);

    // 2. Wrong surface (tenant host) -> 404
    const wrongHostRes = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(`https://${tenantHandle}.situsku.click/dashboard/${tenantHandle}/settings/notifications/api`, {
        method: "GET",
        headers: { cookie: owner.cookie },
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(wrongHostRes.status).toBe(404);

    // 3. Outsider (cross-tenant) -> 404
    const outsiderRes = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, { method: "GET", headers: { cookie: outsider.cookie } }),
      runtimeEnv,
      { nowMs },
    );
    expect(outsiderRes.status).toBe(404);

    // 4. Admin & Editor -> 403 OWNER_ONLY
    for (const member of [admin, editor]) {
      const getDenied = await handleNotificationSettingsApiRequest(
        tenantHandle,
        new Request(apiUrl, { method: "GET", headers: { cookie: member.cookie } }),
        runtimeEnv,
        { nowMs },
      );
      expect(getDenied.status).toBe(403);

      const postDenied = await handleNotificationSettingsApiRequest(
        tenantHandle,
        new Request(apiUrl, {
          method: "POST",
          headers: {
            cookie: member.cookie,
            origin: appOrigin,
            "content-type": "application/json",
            "x-requested-with": "XMLHttpRequest",
          },
          body: JSON.stringify({ monthlyPerformanceReportEnabled: false }),
        }),
        runtimeEnv,
        { nowMs },
      );
      expect(postDenied.status).toBe(403);
    }

    // 5. CSRF rejection: cross-origin POST from Owner -> 403
    const csrfBadOrigin = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ monthlyPerformanceReportEnabled: false }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(csrfBadOrigin.status).toBe(403);

    // 6. Owner GET default -> enabled: true
    const ownerGet1 = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, { method: "GET", headers: { cookie: owner.cookie } }),
      runtimeEnv,
      { nowMs },
    );
    expect(ownerGet1.status).toBe(200);
    const body1 = (await ownerGet1.json()) as {
      success: boolean;
      preferences: { monthlyPerformanceReportEnabled: boolean };
    };
    expect(body1.success).toBe(true);
    expect(body1.preferences.monthlyPerformanceReportEnabled).toBe(true);

    // 7. Owner toggles OFF -> persisted & audited
    const ownerToggleOff = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: appOrigin,
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ monthlyPerformanceReportEnabled: false }),
      }),
      runtimeEnv,
      { nowMs },
    );
    expect(ownerToggleOff.status).toBe(200);
    const bodyOff = (await ownerToggleOff.json()) as {
      success: boolean;
      preferences: { monthlyPerformanceReportEnabled: boolean; updatedAt: number };
    };
    expect(bodyOff.preferences.monthlyPerformanceReportEnabled).toBe(false);
    expect(bodyOff.preferences.updatedAt).toBe(nowMs);

    // Verify platform_audit logged the preference change
    const auditRow = await env.PLATFORM_DB.prepare(
      `SELECT action, actor_user_id, actor_role, outcome
       FROM platform_audit
       WHERE tenant_id = ? AND action = 'tenant.notifications.updated'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(tenantId)
      .first<{ action: string; actor_user_id: string; actor_role: string; outcome: string }>();
    expect(auditRow).toEqual({
      action: "tenant.notifications.updated",
      actor_user_id: owner.userId,
      actor_role: "owner",
      outcome: "success",
    });

    // 8. Owner toggles back ON -> persisted
    const ownerToggleOn = await handleNotificationSettingsApiRequest(
      tenantHandle,
      new Request(apiUrl, {
        method: "PATCH",
        headers: {
          cookie: owner.cookie,
          origin: appOrigin,
          "content-type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
        body: JSON.stringify({ monthlyPerformanceReportEnabled: true }),
      }),
      runtimeEnv,
      { nowMs: nowMs + 1000 },
    );
    expect(ownerToggleOn.status).toBe(200);
    const bodyOn = (await ownerToggleOn.json()) as {
      preferences: { monthlyPerformanceReportEnabled: boolean };
    };
    expect(bodyOn.preferences.monthlyPerformanceReportEnabled).toBe(true);
  });
});
