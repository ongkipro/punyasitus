import { describe, expect, it } from "vitest";
import {
  buildCronPeriodKey,
  computeRetryBackoffSeconds,
  DEFAULT_MAX_JOB_ATTEMPTS,
  JobEnvelopeSchema,
  NonRetryableJobError,
  parseJobEnvelope,
  REDACTED_VALUE,
  redactJobLogRecord,
  redactSensitiveString,
  sanitizeErrorCode,
  UncertainProviderEffectError,
} from "@punyasitus/core/jobs/index";

describe("TASK-028 core jobs contracts (unit)", () => {
  describe("JobEnvelopeSchema & parseJobEnvelope", () => {
    it("parses valid full and minimal envelopes with defaults", () => {
      const full = parseJobEnvelope({
        idempotencyKey: "job-001",
        topic: "billing.reconcile",
        tenantId: "01JTESTTENANTALPHA00000001",
        payload: { obligationId: "obl_1" },
        maxAttempts: 5,
        correlationId: "req-abc-123",
        enqueuedAt: 1_763_820_000_000,
      });

      expect(full).toEqual({
        idempotencyKey: "job-001",
        topic: "billing.reconcile",
        tenantId: "01JTESTTENANTALPHA00000001",
        payload: { obligationId: "obl_1" },
        maxAttempts: 5,
        correlationId: "req-abc-123",
        enqueuedAt: 1_763_820_000_000,
      });

      const minimal = parseJobEnvelope(
        {
          idempotencyKey: "job-002",
          topic: "cron.daily_backup",
          tenantId: null,
        },
        { nowMs: 1_763_820_420_000 },
      );

      expect(minimal).toEqual({
        idempotencyKey: "job-002",
        topic: "cron.daily_backup",
        tenantId: null,
        payload: {},
        maxAttempts: DEFAULT_MAX_JOB_ATTEMPTS,
        correlationId: null,
        enqueuedAt: 1_763_820_420_000,
      });
    });

    it("rejects unknown top-level fields and invalid values strictly", () => {
      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "job-003",
          topic: "email.send",
          tenantId: null,
          unexpectedExtraField: true,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "   ",
          topic: "email.send",
          tenantId: null,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "bad\nkey",
          topic: "email.send",
          tenantId: null,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "job-004",
          topic: "invalid topic with spaces",
          tenantId: null,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "job-005",
          topic: "email.send",
          tenantId: null,
          maxAttempts: 0,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "job-006",
          topic: "email.send",
          tenantId: null,
          maxAttempts: 99,
        }).success,
      ).toBe(false);

      expect(
        JobEnvelopeSchema.safeParse({
          idempotencyKey: "job-007",
          topic: "email.send",
          // Missing tenantId (must explicitly be string or null)
        }).success,
      ).toBe(false);
    });
  });

  describe("buildCronPeriodKey", () => {
    it("produces deterministic UTC keys per hourly, daily, and monthly cadence", () => {
      const t1 = Date.UTC(2026, 10, 22, 16, 7, 0, 0);
      const t2 = Date.UTC(2026, 10, 22, 16, 59, 59, 999);
      const nextHour = Date.UTC(2026, 10, 22, 17, 7, 0, 0);
      const nextDay = Date.UTC(2026, 10, 23, 0, 7, 0, 0);
      const nextMonth = Date.UTC(2026, 11, 1, 0, 7, 0, 0);

      expect(buildCronPeriodKey("billing-sweep", t1, "hourly")).toBe(
        "cron:billing-sweep:2026-11-22T16",
      );
      expect(buildCronPeriodKey("billing-sweep", t2, "hourly")).toBe(
        "cron:billing-sweep:2026-11-22T16",
      );
      expect(buildCronPeriodKey("billing-sweep", nextHour, "hourly")).toBe(
        "cron:billing-sweep:2026-11-22T17",
      );

      expect(buildCronPeriodKey("platform-backup", t1, "daily")).toBe(
        "cron:platform-backup:2026-11-22",
      );
      expect(buildCronPeriodKey("platform-backup", nextHour, "daily")).toBe(
        "cron:platform-backup:2026-11-22",
      );
      expect(buildCronPeriodKey("platform-backup", nextDay, "daily")).toBe(
        "cron:platform-backup:2026-11-23",
      );

      expect(buildCronPeriodKey("monthly-report", t1, "monthly")).toBe(
        "cron:monthly-report:2026-11",
      );
      expect(buildCronPeriodKey("monthly-report", nextMonth, "monthly")).toBe(
        "cron:monthly-report:2026-12",
      );
    });

    it("rejects invalid cron job names or timestamps", () => {
      expect(() => buildCronPeriodKey("bad name!", Date.now(), "hourly")).toThrow(RangeError);
      expect(() => buildCronPeriodKey("ok", -1, "daily")).toThrow(RangeError);
      expect(() => buildCronPeriodKey("ok", Number.NaN, "daily")).toThrow(RangeError);
    });
  });

  describe("computeRetryBackoffSeconds", () => {
    it("grows exponentially and strictly caps at maxSeconds", () => {
      expect(computeRetryBackoffSeconds(1, { baseSeconds: 5, maxSeconds: 60 })).toBe(5);
      expect(computeRetryBackoffSeconds(2, { baseSeconds: 5, maxSeconds: 60 })).toBe(10);
      expect(computeRetryBackoffSeconds(3, { baseSeconds: 5, maxSeconds: 60 })).toBe(20);
      expect(computeRetryBackoffSeconds(4, { baseSeconds: 5, maxSeconds: 60 })).toBe(40);
      expect(computeRetryBackoffSeconds(5, { baseSeconds: 5, maxSeconds: 60 })).toBe(60);
      expect(computeRetryBackoffSeconds(50, { baseSeconds: 5, maxSeconds: 60 })).toBe(60);
    });

    it("applies bounded jitter while respecting [1, maxSeconds]", () => {
      const low = computeRetryBackoffSeconds(2, {
        baseSeconds: 10,
        maxSeconds: 60,
        jitterRatio: 0.25,
        random: () => 0,
      });
      const high = computeRetryBackoffSeconds(2, {
        baseSeconds: 10,
        maxSeconds: 60,
        jitterRatio: 0.25,
        random: () => 1,
      });
      expect(low).toBe(15);
      expect(high).toBe(25);
    });
  });

  describe("Sensitive-field redaction and error code sanitization", () => {
    it("redacts tokens, passwords, secrets, Authorization headers, cookies, emails, phones, and raw payloads", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMTIzNCJ9.signature_abcdef123456";
      const record = redactJobLogRecord({
        event: "job.failed",
        idempotencyKey: "job-redact-1",
        topic: "email.send",
        tenantId: "01JTESTTENANTALPHA00000001",
        scheduledDate: "2026-11-22",
        password: "SuperSecretPassword!",
        accessToken: "sk_live_verysecret123456",
        authorization: `Bearer ${jwt}`,
        cookie: "__Host-session=abc123secretvalue",
        email: "owner@example.co.id",
        phone: "+6281234567890",
        payload: {
          recipientEmail: "customer@example.com",
          otp: "994812",
          nestedSecret: "ghp_secretToken987654321",
        },
        headers: {
          Authorization: "Basic dXNlcjpwYXNz",
        },
        note: `Failed for owner@example.co.id phone 0812-3456-7890 Bearer ${jwt} password=topsecret api_key=re_1234567890ab __Host-auth=cookieval`,
      });

      const serialized = JSON.stringify(record);

      expect(record.idempotencyKey).toBe("job-redact-1");
      expect(record.tenantId).toBe("01JTESTTENANTALPHA00000001");
      expect(record.scheduledDate).toBe("2026-11-22");
      expect(record.password).toBe(REDACTED_VALUE);
      expect(record.accessToken).toBe(REDACTED_VALUE);
      expect(record.authorization).toBe(REDACTED_VALUE);
      expect(record.cookie).toBe(REDACTED_VALUE);
      expect(record.email).toBe(REDACTED_VALUE);
      expect(record.phone).toBe(REDACTED_VALUE);
      expect(record.payload).toBe(REDACTED_VALUE);
      expect(record.headers).toBe(REDACTED_VALUE);

      for (const secret of [
        "SuperSecretPassword!",
        "sk_live_verysecret123456",
        jwt,
        "abc123secretvalue",
        "owner@example.co.id",
        "+6281234567890",
        "0812-3456-7890",
        "customer@example.com",
        "994812",
        "ghp_secretToken987654321",
        "dXNlcjpwYXNz",
        "topsecret",
        "re_1234567890ab",
        "cookieval",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it("sanitizes error codes without leaking Error.message or embedded secrets", () => {
      expect(sanitizeErrorCode("E_PROVIDER_TIMEOUT")).toBe("E_PROVIDER_TIMEOUT");
      expect(sanitizeErrorCode(new NonRetryableJobError("bad password=123", "E_INVALID_TARGET"))).toBe(
        "E_INVALID_TARGET",
      );
      expect(
        sanitizeErrorCode(
          new UncertainProviderEffectError(
            "Timeout calling provider for owner@example.com +6281234567890 Bearer secret_token_12345",
          ),
        ),
      ).toBe("UNCERTAIN_PROVIDER_EFFECT");

      // Generic Error with leaked PII/secrets in message must NOT leak anything
      const leaked = sanitizeErrorCode(
        new Error("Auth failed for alice@example.com with sk_live_secret123456789"),
      );
      expect(leaked).toBe("JOB_EXECUTION_ERROR");
      expect(leaked).not.toContain("alice");
      expect(leaked).not.toContain("sk_live");

      // Sensitive string passed directly as errorCode must be rejected
      expect(sanitizeErrorCode("alice@example.com")).toBe("JOB_EXECUTION_ERROR");
      expect(sanitizeErrorCode("sk_live_secret123456789")).toBe("JOB_EXECUTION_ERROR");
      expect(sanitizeErrorCode("Bearer token123456")).toBe("JOB_EXECUTION_ERROR");
      expect(redactSensitiveString("Call +62 812-9999-8888 on 2026-11-22")).toBe(
        `Call ${REDACTED_VALUE} on 2026-11-22`,
      );
    });
  });
});
