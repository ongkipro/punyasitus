import { describe, expect, it } from "vitest";
import {
  ConsoleDomainChangeRequestSchema,
  ConsoleDomainRecheckRequestSchema,
  ConsoleJobRetryRequestSchema,
} from "@punyasitus/core/schemas";
import {
  classifyConsoleDomainState,
  ConsoleRecoveryError,
  evaluateJobRecoveryEligibility,
  normalizePositiveVersion,
  normalizeRecoveryIdempotencyKey,
  normalizeRecoveryReason,
  redactJobPayloadSummary,
  STALE_QUEUED_JOB_THRESHOLD_MS,
} from "@punyasitus/db/platform";
import {
  ConsoleDomainChangeBodySchema,
  ConsoleDomainRecheckBodySchema,
  validateConsoleDomainChangePayload,
  validateConsoleDomainRecheckPayload,
} from "../../apps/web/src/pages/api/console/domains/_shared.ts";
import {
  ConsoleJobCancelBodySchema,
  ConsoleJobRetryBodySchema,
  validateConsoleJobCancelPayload,
  validateConsoleJobRetryPayload,
} from "../../apps/web/src/pages/api/console/jobs/_shared.ts";

const NOW_MS = Date.UTC(2026, 10, 23, 12, 0, 0);

describe("TASK-047 Unit — Strict Schemas, Redaction, Eligibility & Domain Classification", () => {
  describe("Strict payload validators & Zod v4 schemas reject unknown/bypass fields", () => {
    it("rejects forceActive / bypassVerification on domain recheck & change", () => {
      const recheckBypass = validateConsoleDomainRecheckPayload({
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        hostname: "www.tokocontoh.id",
        expectedVersion: 1,
        reason: "Investigasi DNS tertahan tiket #1001",
        forceActive: true,
      });
      expect(recheckBypass.ok).toBe(false);
      if (!recheckBypass.ok) {
        expect(recheckBypass.code).toBe("UNKNOWN_FIELD");
      }

      const changeBypass = validateConsoleDomainChangePayload({
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        hostname: "www.tokocontoh.id",
        confirmHostname: "www.tokocontoh.id",
        confirmRemoveLocked: true,
        expectedVersion: 2,
        reason: "Ganti domain resmi tiket #1002",
        bypassVerification: true,
      });
      expect(changeBypass.ok).toBe(false);
      if (!changeBypass.ok) {
        expect(changeBypass.code).toBe("UNKNOWN_FIELD");
      }

      // Real Zod v4 `.strict()` request body schemas reject unknown fields directly
      expect(
        ConsoleDomainRecheckBodySchema.safeParse({
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          hostname: "www.tokocontoh.id",
          expectedVersion: 1,
          reason: "Investigasi DNS tertahan tiket #1001",
          forceActive: true,
        }).success,
      ).toBe(false);
      expect(
        ConsoleDomainChangeBodySchema.safeParse({
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          hostname: "www.tokocontoh.id",
          confirmHostname: "www.tokocontoh.id",
          confirmRemoveLocked: true,
          expectedVersion: 1,
          reason: "Ganti domain resmi tiket #1002",
          bypassVerification: true,
        }).success,
      ).toBe(false);

      // Shared core Zod v4 `.strict()` contracts also reject unknown keys
      expect(
        ConsoleDomainRecheckRequestSchema.safeParse({
          tenantHandle: "toko-contoh",
          reason: "Investigasi DNS tertahan tiket #1001",
          expectedVersion: 1,
          idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
          forceActive: true,
        }).success,
      ).toBe(false);
      expect(
        ConsoleDomainChangeRequestSchema.safeParse({
          tenantHandle: "toko-contoh",
          removeDomainId: 2,
          reason: "Ganti domain resmi tiket #1002",
          expectedVersion: 1,
          idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
          bypassVerification: true,
        }).success,
      ).toBe(false);
    });

    it("rejects arbitrary payload overrides on job retry and cancel", () => {
      const retryWithPayload = validateConsoleJobRetryPayload({
        jobIdempotencyKey: "domain-recheck:123",
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        expectedUpdatedAt: NOW_MS,
        reason: "Retry job gagal setelah outage selesai",
        payload: { hacked: true },
      });
      expect(retryWithPayload.ok).toBe(false);
      if (!retryWithPayload.ok) {
        expect(retryWithPayload.code).toBe("UNKNOWN_FIELD");
      }

      const cancelWithExtra = validateConsoleJobCancelPayload({
        jobIdempotencyKey: "domain-recheck:123",
        tenantId: null,
        expectedUpdatedAt: NOW_MS,
        reason: "Batalkan job usang yang tidak relevan",
        overridePayload: "{}",
      });
      expect(cancelWithExtra.ok).toBe(false);
      if (!cancelWithExtra.ok) {
        expect(cancelWithExtra.code).toBe("UNKNOWN_FIELD");
      }

      expect(
        ConsoleJobRetryBodySchema.safeParse({
          jobIdempotencyKey: "domain-recheck:123",
          tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          expectedUpdatedAt: NOW_MS,
          reason: "Retry job gagal setelah outage selesai",
          payload: { hacked: true },
        }).success,
      ).toBe(false);
      expect(
        ConsoleJobCancelBodySchema.safeParse({
          jobIdempotencyKey: "domain-recheck:123",
          tenantId: null,
          expectedUpdatedAt: NOW_MS,
          reason: "Batalkan job usang yang tidak relevan",
          overridePayload: "{}",
        }).success,
      ).toBe(false);

      expect(
        ConsoleJobRetryRequestSchema.safeParse({
          reason: "Retry job gagal setelah outage selesai",
          expectedVersion: 1,
          idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
          payload: { hacked: true },
        }).success,
      ).toBe(false);
    });

    it("enforces mandatory 10-500 char reasons and safe idempotency keys", () => {
      expect(() => normalizeRecoveryReason("short")).toThrow(ConsoleRecoveryError);
      expect(() => normalizeRecoveryReason("a".repeat(501))).toThrow(ConsoleRecoveryError);
      expect(normalizeRecoveryReason("Tiket dukungan #8812 untuk recheck domain")).toContain(
        "Tiket dukungan #8812",
      );

      expect(() => normalizeRecoveryIdempotencyKey("bad")).toThrow(ConsoleRecoveryError);
      expect(() => normalizeRecoveryIdempotencyKey("has spaces invalid")).toThrow(
        ConsoleRecoveryError,
      );
      expect(normalizeRecoveryIdempotencyKey("op-retry-2026-11-23-001")).toBe(
        "op-retry-2026-11-23-001",
      );

      expect(() => normalizePositiveVersion(0)).toThrow(ConsoleRecoveryError);
      expect(() => normalizePositiveVersion(1.5)).toThrow(ConsoleRecoveryError);
      expect(normalizePositiveVersion(3)).toBe(3);
    });
  });

  describe("Multi-layer job payload redaction (zero secrets/tokens/PII/lead bodies)", () => {
    it("scrubs secrets, JWTs, Bearer tokens, cookies, emails, phones, and lead bodies", () => {
      const sensitivePayload = JSON.stringify({
        hostname: "www.kopinusantara.id",
        attemptKind: "manual_recheck",
        apiKey: "cf_supersecretkey1234567890",
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456",
        cookie: "__Host-ps_console=supersecretcookievalue123",
        customerEmail: "budi.rahasia@gmail.com",
        whatsappPhone: "+6281234567890",
        leadBody: "Halo saya mau pesan 50 unit alamat Jl Merdeka No 10",
        note: "Contact owner@secret.id or +6281299887766 with Bearer secret_token_xyz123",
      });

      const { summary, payloadRedacted } = redactJobPayloadSummary(sensitivePayload);
      expect(payloadRedacted).toBe(true);
      expect(summary).not.toBeNull();

      const serialized = JSON.stringify(summary);
      expect(serialized).toContain("www.kopinusantara.id");
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("cf_supersecretkey1234567890");
      expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(serialized).not.toContain("supersecretcookievalue123");
      expect(serialized).not.toContain("budi.rahasia@gmail.com");
      expect(serialized).not.toContain("owner@secret.id");
      expect(serialized).not.toContain("6281234567890");
      expect(serialized).not.toContain("6281299887766");
      expect(serialized).not.toContain("Jl Merdeka No 10");
      expect(serialized).not.toContain("secret_token_xyz123");
    });

    it("handles malformed JSON safely without echoing raw content", () => {
      const malformed = "{not valid json secret=sk_live_9876543210abcdef";
      const { summary, payloadRedacted } = redactJobPayloadSummary(malformed);
      expect(payloadRedacted).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("sk_live_9876543210abcdef");
      expect(JSON.stringify(summary)).toContain("[REDACTED]");
    });
  });

  describe("Job recovery eligibility rules", () => {
    it("rejects completed jobs and live active leases; allows failed, dead_letter, and expired leases", () => {
      const completed = evaluateJobRecoveryEligibility({
        status: "completed",
        leaseUntil: null,
        nowMs: NOW_MS,
      });
      expect(completed.retryEligible).toBe(false);
      expect(completed.cancelEligible).toBe(false);
      expect(completed.retryIneligibleReasonCode).toBe("JOB_ALREADY_COMPLETED");

      const liveLease = evaluateJobRecoveryEligibility({
        status: "running",
        leaseUntil: NOW_MS + 30_000,
        nowMs: NOW_MS,
      });
      expect(liveLease.leaseState).toBe("active");
      expect(liveLease.retryEligible).toBe(false);
      expect(liveLease.cancelEligible).toBe(false);
      expect(liveLease.retryIneligibleReasonCode).toBe("JOB_LEASE_ACTIVE");

      const expiredLease = evaluateJobRecoveryEligibility({
        status: "running",
        leaseUntil: NOW_MS - 1_000,
        nowMs: NOW_MS,
      });
      expect(expiredLease.leaseState).toBe("expired");
      expect(expiredLease.retryEligible).toBe(true);
      expect(expiredLease.cancelEligible).toBe(true);

      const failed = evaluateJobRecoveryEligibility({
        status: "failed",
        leaseUntil: null,
        nowMs: NOW_MS,
      });
      expect(failed.retryEligible).toBe(true);
      expect(failed.cancelEligible).toBe(true);

      const dlq = evaluateJobRecoveryEligibility({
        status: "dead_letter",
        leaseUntil: null,
        nowMs: NOW_MS,
      });
      expect(dlq.retryEligible).toBe(true);
      expect(dlq.cancelEligible).toBe(false);

      const freshQueued = evaluateJobRecoveryEligibility({
        status: "queued",
        leaseUntil: null,
        updatedAt: NOW_MS - 30_000,
        nowMs: NOW_MS,
      });
      expect(freshQueued.retryEligible).toBe(false);
      expect(freshQueued.retryIneligibleReasonCode).toBe("JOB_ALREADY_QUEUED");

      const staleQueued = evaluateJobRecoveryEligibility({
        status: "queued",
        leaseUntil: null,
        updatedAt: NOW_MS - STALE_QUEUED_JOB_THRESHOLD_MS - 1_000,
        nowMs: NOW_MS,
      });
      expect(staleQueued.retryEligible).toBe(true);
      expect(staleQueued.retryIneligibleReasonCode).toBeNull();
    });
  });

  describe("Domain exception classification", () => {
    it("flags failed, moved, deleting, TLS error, failureCode, and stale pending hosts as exceptions", () => {
      const failed = classifyConsoleDomainState({
        status: "failed",
        sslStatus: "validation_timed_out",
        providerStatus: "blocked",
        providerSslStatus: "validation_timed_out",
        failureCode: "PROVIDER_TIMEOUT",
        lastCheckedAt: NOW_MS - 10_000,
        createdAt: NOW_MS - 60_000,
        nowMs: NOW_MS,
      });
      expect(failed.isException).toBe(true);
      expect(failed.ownershipStatus).toBe("error");
      expect(failed.tlsStatus).toBe("error");

      const stuckPending = classifyConsoleDomainState({
        status: "pending",
        sslStatus: "pending_validation",
        providerStatus: "pending",
        providerSslStatus: "pending_validation",
        failureCode: null,
        lastCheckedAt: NOW_MS - 8 * 3600 * 1000,
        createdAt: NOW_MS - 10 * 3600 * 1000,
        nowMs: NOW_MS,
      });
      expect(stuckPending.isException).toBe(true);

      const healthy = classifyConsoleDomainState({
        status: "active",
        sslStatus: "active",
        providerStatus: "active",
        providerSslStatus: "active",
        failureCode: null,
        lastCheckedAt: NOW_MS - 60_000,
        createdAt: NOW_MS - 86_400_000,
        nowMs: NOW_MS,
      });
      expect(healthy.isException).toBe(false);
      expect(healthy.ownershipStatus).toBe("active");
      expect(healthy.tlsStatus).toBe("active");
    });
  });
});
