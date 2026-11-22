import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ALERT_THRESHOLDS,
  createStructuredEvent,
  emitTelemetryEvent,
  evaluateAlertThresholds,
  stripQueryString,
  type StructuredTelemetryEvent,
} from "@punyasitus/core/telemetry/index";
import { describe, expect, it } from "vitest";
import {
  handleBackupHealthProbe,
  handleDbHealthProbe,
  handleJobsHealthProbe,
  handleLivenessProbe,
  type HealthBackupBucketLike,
} from "../../apps/web/src/pages/api/health/probe-helpers.ts";
import type { DurableJobRegistry } from "../../apps/web/src/worker/queues/consumer.ts";
import {
  DAILY_PLATFORM_BACKUP_TOPIC,
  buildPlatformBackupKeys,
  computeSha256Hex,
  createDailyBackupQueueHandler,
  formatSqlLiteral,
  formatUtcBackupDate,
} from "../../scripts/backup-restore/index.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OBSERVABILITY_PATH = path.join(REPO_ROOT, "OBSERVABILITY.md");

describe("TASK-037 Structured Telemetry Redaction (PLAN §9)", () => {
  it("strips request/response bodies, Authorization/Cookie headers, query strings, emails, phones, and tokens", () => {
    const emitted: StructuredTelemetryEvent[] = [];
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature1234567890";

    const event = emitTelemetryEvent(
      {
        requestId: "req_abc123?token=secret_query_val&email=owner@bisnis.id",
        tenantId: "01JTESTTENANT000000000001",
        operation: "POST /api/leads?utm_email=lead@example.id&access_token=sk_live_1234567890",
        status: 500,
        durationMs: 142.7,
        errorCode: new Error(
          `Auth failed Bearer ${fakeJwt} for user@example.com phone +6281234567890`,
        ),
        timestamp: Date.UTC(2026, 10, 22, 12, 0, 0),
        // All unsafe extra fields below MUST be completely dropped:
        body: '{"name":"Budi","phone":"+6281299998888","message":"Halo rahasia"}',
        requestBody: "password=supersecret",
        responseBody: "internal stack trace",
        headers: {
          Authorization: "Bearer super_secret_token_987654321",
          Cookie: "__Host-better-auth.session_token=sess_secret_xyz",
        },
        query: "?secret=1&phone=081234567890",
        email: "victim@bisnis.id",
        phone: "081234567890",
        metrics: {
          attempt: 2,
          rowsAffected: 1,
          // Unsafe metric keys MUST be dropped:
          authorization: "Bearer leaked_metric_token",
          cookie: "__Host-session=abc",
          email: "metric@bisnis.id",
          phone: "+628111222333",
          requestBody: "raw body",
          query: "?foo=bar",
          // Safe metric string with embedded PII/query MUST be scrubbed:
          stage: "notify?token=abc123 owner@bisnis.id 081234567890",
        },
      },
      (e) => emitted.push(e),
    );

    expect(emitted).toHaveLength(1);
    const json = JSON.stringify(event);

    // Safe fields preserved
    expect(event.requestId).toBe("req_abc123");
    expect(event.tenantId).toBe("01JTESTTENANT000000000001");
    expect(event.operation).toBe("POST /api/leads");
    expect(event.status).toBe(500);
    expect(event.durationMs).toBe(143);
    expect(event.level).toBe("error");
    expect(event.errorCode).toBe("JOB_EXECUTION_ERROR");
    expect(event.timestamp).toBe("2026-11-22T12:00:00.000Z");
    expect(event.metrics?.attempt).toBe(2);
    expect(event.metrics?.rowsAffected).toBe(1);

    // Zero sensitive values or extra keys leaked anywhere in serialized JSON
    const forbiddenSubstrings = [
      "secret_query_val",
      "owner@bisnis.id",
      "lead@example.id",
      "sk_live_1234567890",
      fakeJwt,
      "user@example.com",
      "+6281234567890",
      "081234567890",
      "+6281299998888",
      "Halo rahasia",
      "supersecret",
      "super_secret_token_987654321",
      "sess_secret_xyz",
      "victim@bisnis.id",
      "leaked_metric_token",
      "metric@bisnis.id",
      "+628111222333",
      "raw body",
      "requestBody",
      "responseBody",
      "Authorization",
      "Cookie",
      "?utm_email",
      "?token=",
    ];
    for (const forbidden of forbiddenSubstrings) {
      expect(json).not.toContain(forbidden);
    }

    // Only allowlisted top-level keys exist
    expect(Object.keys(event).sort()).toEqual([
      "durationMs",
      "errorCode",
      "level",
      "metrics",
      "operation",
      "requestId",
      "status",
      "tenantId",
      "timestamp",
    ]);
  });

  it("nulls unsafe tenantId values and strips query strings cleanly", () => {
    expect(stripQueryString("/api/health?secret=1#frag")).toBe("/api/health");

    const unsafeTenantEvent = createStructuredEvent({
      requestId: "Bearer secret_token_value_12345",
      tenantId: "owner@bisnis.id",
      operation: "GET /dashboard?session=abc",
      status: "ok",
      durationMs: -5,
    });

    expect(unsafeTenantEvent.tenantId).toBeNull();
    expect(unsafeTenantEvent.requestId).toBe("redacted");
    expect(unsafeTenantEvent.operation).toBe("GET /dashboard");
    expect(unsafeTenantEvent.durationMs).toBe(0);
    expect(unsafeTenantEvent.errorCode).toBeNull();
  });
});

describe("TASK-037 Alert Threshold Evaluator Fixtures (PLAN §9)", () => {
  const fixedNow = Date.UTC(2026, 10, 22, 15, 0, 0);

  it("stays ok when all metrics are at or below thresholds", () => {
    const res = evaluateAlertThresholds({
      evaluatedAtMs: fixedNow,
      http5xx: { totalRequests: 100, serverErrors: 1, windowMinutes: 5 }, // exactly 1% -> ok (strictly > 1%)
      imageJobs: { oldestPendingAgeMinutes: 15 }, // exactly 15m -> ok (strictly > 15m)
      domainReconciliation: { consecutiveFailures: 2 }, // < 3 -> ok
      backup: { lastBackupAgeHours: 26 }, // exactly 26h -> ok (strictly > 26h)
      autolarisAdvice: { lastSweepAgeHours: 2, consecutiveFailures: 0 },
    });

    expect(res.status).toBe("ok");
    expect(res.alerts).toHaveLength(0);
  });

  it("does not trigger 5xx alert below 100 requests or shorter than 5-minute window", () => {
    const lowVolume = evaluateAlertThresholds({
      evaluatedAtMs: fixedNow,
      http5xx: { totalRequests: 99, serverErrors: 10, windowMinutes: 5 },
    });
    expect(lowVolume.status).toBe("ok");
    expect(lowVolume.alerts).toHaveLength(0);

    const shortWindow = evaluateAlertThresholds({
      evaluatedAtMs: fixedNow,
      http5xx: { totalRequests: 250, serverErrors: 25, windowMinutes: 4 },
    });
    expect(shortWindow.status).toBe("ok");
    expect(shortWindow.alerts).toHaveLength(0);
  });

  it("triggers every configured PLAN §9 / TASK-037 alert fixture accurately", () => {
    const res = evaluateAlertThresholds({
      evaluatedAtMs: fixedNow,
      http5xx: { totalRequests: 100, serverErrors: 2, windowMinutes: 5 }, // 2% > 1%
      imageJobs: { oldestPendingAgeMinutes: 16 }, // > 15m
      domainReconciliation: { consecutiveFailures: 3 }, // >= 3
      backup: { lastBackupAgeHours: 27 }, // > 26h
      autolarisAdvice: { lastSweepAgeHours: 3.5 }, // > 2h
    });

    expect(res.status).toBe("alert");
    expect(res.alerts.map((a) => a.id)).toEqual([
      "HTTP_5XX_RATE_HIGH",
      "IMAGE_JOB_BACKLOG_STALE",
      "DOMAIN_RECONCILIATION_REPEATED_FAILURE",
      "PLATFORM_BACKUP_STALE",
      "AUTOLARIS_ADVICE_STALE",
    ]);

    expect(DEFAULT_ALERT_THRESHOLDS.http5xxRateRatio).toBe(0.01);
    expect(DEFAULT_ALERT_THRESHOLDS.http5xxMinRequests).toBe(100);
    expect(DEFAULT_ALERT_THRESHOLDS.oldestImageJobMaxAgeMinutes).toBe(15);
    expect(DEFAULT_ALERT_THRESHOLDS.backupMaxAgeHours).toBe(26);
  });

  it("triggers critical alerts when backup or AutoLaris Advice timestamp is null (missing)", () => {
    const res = evaluateAlertThresholds({
      evaluatedAtMs: fixedNow,
      backup: { lastBackupAgeHours: null },
      autolarisAdvice: { lastSweepAgeHours: null },
    });

    expect(res.status).toBe("alert");
    expect(res.alerts.map((a) => a.id)).toEqual([
      "PLATFORM_BACKUP_STALE",
      "AUTOLARIS_ADVICE_STALE",
    ]);
    expect(res.alerts.every((a) => a.severity === "critical")).toBe(true);
  });
});

describe("TASK-037 OBSERVABILITY.md Contract & Probe Syntax", () => {
  it("contains zero TBD or planned-only placeholders and valid executable Probe lines", () => {
    const raw = fs.readFileSync(OBSERVABILITY_PATH, "utf8");

    expect(raw).not.toMatch(/\bTBD\b/i);
    expect(raw).not.toContain("State: PLANNED");
    expect(raw).not.toContain("Planned (activate in TASK-037)");

    const probeLines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Probe:"));

    // Exclude the format documentation line `Probe: <name>|...`
    const executableProbes = probeLines.filter((line) => !line.includes("<name>"));
    expect(executableProbes.length).toBeGreaterThanOrEqual(8);

    const parsedProbes = executableProbes.map((line) => {
      const spec = line.slice("Probe:".length).trim();
      const parts = spec.split("|");
      expect(parts, `Invalid probe syntax: ${line}`).toHaveLength(5);
      const [name, url, status, contains, latency] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(url.startsWith("https://")).toBe(true);
      expect(() => new URL(url)).not.toThrow();
      expect(status).toMatch(/^\d{3}(?:-\d{3})?$/);
      expect(contains.length).toBeGreaterThan(0);
      expect(Number(latency)).toBeGreaterThan(0);
      return { name, url, status, contains, latency: Number(latency) };
    });

    const byName = new Map(parsedProbes.map((p) => [p.name, p]));
    expect(byName.get("admin-host")?.url).toContain("app.punyasitus.com");
    expect(byName.get("tenant-host")?.url).toContain(".situsku.click");
    expect(byName.get("unknown-tenant-404")?.status).toBe("404-404");
    expect(byName.get("worker-heartbeat")?.url).toContain("/api/health");
    expect(byName.get("platform-db")?.url).toContain("/api/health/db");
    expect(byName.get("jobs")?.url).toContain("/api/health/jobs");
    expect(byName.get("backup-freshness")?.url).toContain("/api/health/backup");
    expect(byName.get("autolaris-advice-freshness")?.url).toContain("/api/health/jobs");
  });
});

describe("TASK-037 Health Endpoints Non-Disclosure & Backup Helpers", () => {
  it("never leaks secrets, bindings, bucket names, keys, or stack traces on failures", async () => {
    const liveness = handleLivenessProbe({ nowMs: Date.UTC(2026, 10, 22, 10, 0, 0) });
    expect(liveness.status).toBe(200);
    expect(liveness.headers.get("cache-control")).toBe("no-store");
    expect(liveness.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const livenessJson = (await liveness.json()) as Record<string, unknown>;
    expect(livenessJson).toEqual({
      status: "ok",
      service: "punyasitus-web",
      timestamp: "2026-11-22T10:00:00.000Z",
    });

    const secretThrowingDb = {
      prepare() {
        throw new Error(
          "D1_ERROR binding PLATFORM_DB secret=sk_live_9999999999 host=internal.db.local",
        );
      },
    } as unknown as D1Database;

    const dbRes = await handleDbHealthProbe({ platformDb: secretThrowingDb });
    expect(dbRes.status).toBe(503);
    expect(dbRes.headers.get("cache-control")).toBe("no-store");
    expect(dbRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const dbText = await dbRes.text();
    expect(JSON.parse(dbText)).toMatchObject({
      status: "degraded",
      service: "punyasitus-web",
    });
    expect(dbText).not.toContain("PLATFORM_DB");
    expect(dbText).not.toContain("sk_live_");
    expect(dbText).not.toContain("internal.db.local");
    expect(dbText).not.toContain("D1_ERROR");

    const jobsRes = await handleJobsHealthProbe({ platformDb: secretThrowingDb });
    expect(jobsRes.status).toBe(503);
    const jobsText = await jobsRes.text();
    expect(jobsText).not.toContain("PLATFORM_DB");
    expect(jobsText).not.toContain("sk_live_");

    const secretThrowingBucket: HealthBackupBucketLike = {
      async get() {
        throw new Error("R2_ERROR bucket=punyasitus-backup key=platform-db/latest.json");
      },
      async list() {
        throw new Error("R2_ERROR bucket=punyasitus-backup");
      },
    };
    const backupErrRes = await handleBackupHealthProbe({ backupBucket: secretThrowingBucket });
    expect(backupErrRes.status).toBe(503);
    const backupErrText = await backupErrRes.text();
    expect(backupErrText).not.toContain("punyasitus-backup");
    expect(backupErrText).not.toContain("platform-db/");
    expect(backupErrText).not.toContain("R2_ERROR");

    // Healthy backup response also never exposes bucket name or key
    const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);
    const healthyBucket: HealthBackupBucketLike = {
      async get() {
        return {
          key: "platform-db/latest.json",
          async text() {
            return JSON.stringify({
              createdAtMs: nowMs - 600_000,
              snapshotKey: "platform-db/2026-11-22/snapshot.sql",
            });
          },
        };
      },
      async list() {
        return { objects: [], truncated: false };
      },
    };
    const backupOkRes = await handleBackupHealthProbe({ backupBucket: healthyBucket, nowMs });
    expect(backupOkRes.status).toBe(200);
    const backupOkText = await backupOkRes.text();
    expect(JSON.parse(backupOkText)).toMatchObject({
      status: "ok",
      service: "punyasitus-web",
      freshness: "ok",
      ageSeconds: 600,
    });
    expect(backupOkText).not.toContain("platform-db/");
    expect(backupOkText).not.toContain("snapshot.sql");
    expect(backupOkText).not.toContain("punyasitus-backup");
  });

  it("formats deterministic SQL literals, backup keys, SHA-256, and DurableJobRegistry handler compatibility", async () => {
    expect(formatSqlLiteral(null)).toBe("NULL");
    expect(formatSqlLiteral(42)).toBe("42");
    expect(formatSqlLiteral(true)).toBe("1");
    expect(formatSqlLiteral("O'Reilly")).toBe("'O''Reilly'");
    expect(formatSqlLiteral(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("X'DEADBEEF'");

    const date = formatUtcBackupDate(Date.UTC(2026, 10, 22, 7, 0, 0));
    expect(date).toBe("2026-11-22");
    expect(buildPlatformBackupKeys(date)).toEqual({
      snapshotKey: "platform-db/2026-11-22/snapshot.sql",
      manifestKey: "platform-db/2026-11-22/manifest.json",
      latestKey: "platform-db/latest.json",
    });

    const hashA = await computeSha256Hex("SELECT 1;");
    const hashB = await computeSha256Hex("SELECT 1;");
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).toBe(hashB);

    // Compile-time & runtime check that createDailyBackupQueueHandler plugs directly into DurableJobRegistry
    const registry: DurableJobRegistry = {
      [DAILY_PLATFORM_BACKUP_TOPIC]: createDailyBackupQueueHandler(),
    };
    expect(typeof registry[DAILY_PLATFORM_BACKUP_TOPIC]?.execute).toBe("function");
    expect(typeof registry[DAILY_PLATFORM_BACKUP_TOPIC]?.reconcile).toBe("function");
  });
});
