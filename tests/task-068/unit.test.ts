import fs from "node:fs";
import path from "node:path";
import {
  buildServiceAccessViewModel,
  evaluateTenantApiEntitlement,
  type LiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import {
  DAY_MS,
  HOLD_RELEASE_MIN_REMAINING_MS,
  PAID_DELETION_WINDOW_MS,
  TRIAL_DELETION_WINDOW_MS,
  UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
  computeAuthoritativeDeletionDueAt,
  computeHoldResumeDeletionDueAt,
  evaluateDeletionWarningSchedule,
  evaluateEntitlementState,
  evaluateOffboardingClaimEligibility,
} from "@punyasitus/core/billing/index";
import { renderEmailTemplate } from "@punyasitus/core/email/index";
import {
  TENANT_OFFBOARDING_MIGRATION,
  TENANT_OFFBOARDING_MIGRATION_SQL,
} from "@punyasitus/db/offboarding/index";
import { describe, expect, it } from "vitest";
import { OFFBOARDING_CRON_JOB_DEFINITIONS } from "../../apps/web/src/worker/queues/offboarding/index.ts";
import { TENANT_OFFBOARDING_SWEEP_TOPIC } from "../../apps/web/src/worker/queues/dispatch/offboarding.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-068 unit: Locked-Tenant Retention Clocks, Warnings, Hold Pause & Zero-DDL Contract", () => {
  it("matches packages/db/migrations/platform/0017_tenant_offboarding.sql byte-for-byte with bundled SQL", () => {
    const onDiskPath = path.join(
      ROOT,
      "packages/db/migrations/platform/0017_tenant_offboarding.sql",
    );
    const onDiskSql = fs.readFileSync(onDiskPath, "utf8");
    expect(TENANT_OFFBOARDING_MIGRATION.version).toBe(17);
    expect(TENANT_OFFBOARDING_MIGRATION.name).toBe("0017_tenant_offboarding");
    expect(TENANT_OFFBOARDING_MIGRATION_SQL).toBe(onDiskSql);
  });

  it("contains ZERO request-time runtime DDL in offboarding runtime repositories, workers, and export endpoint", () => {
    const runtimeFiles = [
      "packages/db/src/offboarding/repository.ts",
      "apps/web/src/worker/queues/offboarding/handler.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/leads/export.ts",
    ];
    for (const rel of runtimeFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/CREATE\s+TABLE/i);
      expect(src).not.toMatch(/ensure\w+Schema/i);
      expect(src).not.toMatch(/applyTenantOffboardingMigration/);
    }
  });

  it("computes exact deletion_due_at for never-paid trial (+30d), no-trial unpaid (+30d), and previously paid (H+45)", () => {
    const t0 = Date.UTC(2026, 5, 1, 0, 0, 0);

    const trialClock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: null,
      trialEndsAtMs: t0,
      createdAtMs: t0 - 7 * DAY_MS,
    });
    expect(trialClock.track).toBe("never_paid_trial");
    expect(trialClock.deletionDueAtMs).toBe(t0 + TRIAL_DELETION_WINDOW_MS);

    const noTrialClock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: null,
      trialEndsAtMs: null,
      createdAtMs: t0,
    });
    expect(noTrialClock.track).toBe("no_trial_unpaid");
    expect(noTrialClock.deletionDueAtMs).toBe(t0 + UNPAID_NO_TRIAL_DELETION_WINDOW_MS);

    const paidClock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: t0,
      trialEndsAtMs: t0 - 30 * DAY_MS,
      createdAtMs: t0 - 37 * DAY_MS,
    });
    expect(paidClock.track).toBe("previously_paid");
    expect(paidClock.deletionDueAtMs).toBe(t0 + PAID_DELETION_WINDOW_MS);

    // Explicit hold-shifted deletion_due_at takes precedence
    const shifted = t0 + 70 * DAY_MS;
    const shiftedClock = computeAuthoritativeDeletionDueAt({
      paidThroughMs: t0,
      trialEndsAtMs: null,
      explicitDeletionDueAtMs: shifted,
    });
    expect(shiftedClock.deletionDueAtMs).toBe(shifted);
  });

  it("enforces exact -1s vs 0s eligibility boundary and blocks on holds, active periods, or unresolved payments", () => {
    const paidThrough = Date.UTC(2026, 6, 1, 12, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;

    // 1 second before H+45 -> NOT eligible
    const oneSecBefore = evaluateOffboardingClaimEligibility({
      storedStatus: "active", // even if scheduler delayed status sync!
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: dueAt - 1000,
    });
    expect(oneSecBefore.eligible).toBe(false);
    expect(oneSecBefore.blockReason).toBe("before_deletion_due_at");

    // Exactly at H+45 -> eligible regardless of scheduler delay
    const exactDue = evaluateOffboardingClaimEligibility({
      storedStatus: "active",
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: dueAt,
    });
    expect(exactDue.eligible).toBe(true);
    expect(exactDue.deletionDueAtMs).toBe(dueAt);

    // Operator hold blocks
    const held = evaluateOffboardingClaimEligibility({
      storedStatus: "suspended",
      operatorHold: true,
      retentionPausedAtMs: dueAt - 5 * DAY_MS,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: dueAt + 20 * DAY_MS,
    });
    expect(held.eligible).toBe(false);
    expect(held.blockReason).toBe("operator_hold");

    // Unresolved payment attempt blocks
    const unresolved = evaluateOffboardingClaimEligibility({
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      hasUnresolvedPaymentAttempt: true,
      nowMs: dueAt + DAY_MS,
    });
    expect(unresolved.eligible).toBe(false);
    expect(unresolved.blockReason).toBe("unresolved_payment_attempt");
  });

  it("evaluates H+38/H+42/H+44 and -7d/-3d/-1d warning schedules and suppresses earlier missed stages on delayed jobs", () => {
    const paidThrough = Date.UTC(2026, 7, 1, 0, 0, 0);
    const dueAt = paidThrough + PAID_DELETION_WINDOW_MS;

    // 1s before H+38 -> none
    const beforeH38 = evaluateDeletionWarningSchedule({
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: paidThrough + 38 * DAY_MS - 1000,
    });
    expect(beforeH38.latestDueWarning).toBeNull();
    expect(beforeH38.skipReason).toBe("before_first_warning");

    // Exact H+38 -> paid_h38
    const atH38 = evaluateDeletionWarningSchedule({
      storedStatus: "active", // delayed status sync still triggers warning on schedule!
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: paidThrough + 38 * DAY_MS,
    });
    expect(atH38.latestDueWarning?.stage).toBe("paid_h38");
    expect(atH38.earlierMissedWarnings).toHaveLength(0);

    // Delayed job waking up at H+44 -> ONLY paid_h44 due; H+38 & H+42 listed as earlierMissedWarnings
    const delayedAtH44 = evaluateDeletionWarningSchedule({
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: paidThrough + 44 * DAY_MS + 3600_000,
    });
    expect(delayedAtH44.latestDueWarning?.stage).toBe("paid_h44");
    expect(delayedAtH44.earlierMissedWarnings.map((m) => m.stage)).toEqual([
      "paid_h38",
      "paid_h42",
    ]);

    // At H+45 -> past_deadline, no warning
    const atH45 = evaluateDeletionWarningSchedule({
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      nowMs: dueAt,
    });
    expect(atH45.latestDueWarning).toBeNull();
    expect(atH45.isPastDeadline).toBe(true);

    // Never-paid trial delayed job waking up at -1d -> ONLY unpaid_minus_1d
    const trialEnds = Date.UTC(2026, 8, 1, 0, 0, 0);
    const trialDelayed = evaluateDeletionWarningSchedule({
      storedStatus: "trial",
      operatorHold: false,
      paidThroughMs: null,
      trialEndsAtMs: trialEnds,
      nowMs: trialEnds + 29 * DAY_MS,
    });
    expect(trialDelayed.latestDueWarning?.stage).toBe("unpaid_minus_1d");
    expect(trialDelayed.earlierMissedWarnings.map((m) => m.stage)).toEqual([
      "unpaid_minus_7d",
      "unpaid_minus_3d",
    ]);
  });

  it("resumes operator-hold deletion clock with paused duration shift AND minimum 14-day floor", () => {
    const paidThrough = Date.UTC(2026, 9, 1, 0, 0, 0);
    const originalDue = paidThrough + PAID_DELETION_WINDOW_MS;

    // Case A: Held with 20 days remaining, released 10 days later -> still has 20 days remaining (>14d)
    const heldAtA = originalDue - 20 * DAY_MS;
    const releasedAtA = heldAtA + 10 * DAY_MS;
    const resumedA = computeHoldResumeDeletionDueAt({
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      explicitDeletionDueAtMs: originalDue,
      retentionPausedAtMs: heldAtA,
      nowMs: releasedAtA,
    });
    expect(resumedA).toBe(releasedAtA + 20 * DAY_MS);

    // Case B: Held with only 2 days remaining, released 15 days later -> floored to >= 14 days remaining!
    const heldAtB = originalDue - 2 * DAY_MS;
    const releasedAtB = heldAtB + 15 * DAY_MS;
    const resumedB = computeHoldResumeDeletionDueAt({
      paidThroughMs: paidThrough,
      trialEndsAtMs: null,
      explicitDeletionDueAtMs: originalDue,
      retentionPausedAtMs: heldAtB,
      nowMs: releasedAtB,
    });
    expect(resumedB).toBe(releasedAtB + HOLD_RELEASE_MIN_REMAINING_MS);
    expect(resumedB - releasedAtB).toBeGreaterThanOrEqual(HOLD_RELEASE_MIN_REMAINING_MS);
  });

  it("treats offboardingStartedAtMs as effective status 'purging' and derives no-trial deletion deadline", () => {
    const createdAt = Date.UTC(2026, 10, 1, 0, 0, 0);
    const unpaidEval = evaluateEntitlementState({
      storedStatus: "suspended",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: null,
      createdAtMs: createdAt,
      nowMs: createdAt + 10 * DAY_MS,
    });
    expect(unpaidEval.deadlines.deletionDueAtMs).toBe(
      createdAt + UNPAID_NO_TRIAL_DELETION_WINDOW_MS,
    );

    const purgingEval = evaluateEntitlementState({
      storedStatus: "suspended",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: null,
      offboardingStartedAtMs: createdAt + 30 * DAY_MS,
      nowMs: createdAt + 30 * DAY_MS,
    });
    expect(purgingEval.effectiveStatus).toBe("purging");
    expect(purgingEval.publicAccess.httpStatus).toBe(404);
    expect(purgingEval.adminAccess.canAccessBilling).toBe(false);
    expect(purgingEval.adminAccess.canExportLeadsCsv).toBe(false);
  });

  it("renders Bahasa Indonesia deletion-warning email template with escaped HTML and valid URLs", () => {
    const rendered = renderEmailTemplate("deletion-warning", {
      recipientName: 'Budi <script>alert("x")</script>',
      tenantName: "Klinik & Sehat",
      stage: "paid_h44",
      daysRemaining: 1,
      deletionDueAtLabel: "15 Agu 2026, 23.59 WIB",
      billingUrl: "https://app.punyasitus.com/dashboard/klinik/billing",
      leadsExportUrl: "https://app.punyasitus.com/api/tenants/t1/leads/export",
    });

    expect(rendered.template).toBe("deletion-warning");
    expect(rendered.subject).toContain("H+44");
    expect(rendered.subject).toContain("1 hari lagi");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("15 Agu 2026, 23.59 WIB");
    expect(rendered.html).toContain("/api/tenants/t1/leads/export");
    expect(rendered.text).toContain("15 Agu 2026, 23.59 WIB");

    expect(() =>
      renderEmailTemplate("deletion-warning", {
        tenantName: "Klinik",
        stage: "unpaid_minus_1d",
        daysRemaining: 1,
        deletionDueAtLabel: "15 Agu 2026, 23.59 WIB",
        billingUrl: "javascript:alert(1)",
      }),
    ).toThrow(/Skema URL tidak diizinkan/);
  });

  it("aligns buildServiceAccessViewModel leadsExportHref, strict role gating, and retentionPaused derivation", () => {
    const nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);
    const makeLive = (opts: {
      agencyId?: string | null;
      operatorHold?: boolean;
      retentionPausedAtMs?: number | null;
    }): LiveTenantEntitlement => {
      const evaluation = evaluateEntitlementState({
        storedStatus: "suspended",
        operatorHold: opts.operatorHold ?? false,
        trialEndsAtMs: null,
        paidThroughMs: nowMs - 10 * DAY_MS,
        retentionPausedAtMs: opts.retentionPausedAtMs ?? null,
        agencyId: opts.agencyId ?? null,
        nowMs,
      });
      return {
        tenantId: "01T068UNIT0000000000000001",
        organizationId: "01ORG068000000000000000001",
        handle: "klinik-unit",
        tenantName: "Klinik Unit",
        agencyId: opts.agencyId ?? null,
        version: 1,
        evaluation,
      };
    };

    // Direct tenant: leadsExportHref points to `/leads/export`, ONLY `owner` gets canExportLeadsCsv=true
    const directEnt = makeLive({ agencyId: null });
    const ownerVm = buildServiceAccessViewModel({ entitlement: directEnt, role: "owner" });
    expect(ownerVm.leadsExportHref).toBe("/api/tenants/01T068UNIT0000000000000001/leads/export");
    expect(ownerVm.canExportLeadsCsv).toBe(true);
    expect(ownerVm.retentionPaused).toBe(false);

    for (const deniedRole of ["admin", "editor", "agency_admin"] as const) {
      const vm = buildServiceAccessViewModel({ entitlement: directEnt, role: deniedRole });
      expect(vm.canExportLeadsCsv).toBe(false);
      const apiDecision = evaluateTenantApiEntitlement({
        entitlement: directEnt,
        method: "GET",
        subPath: "/leads/export",
        role: deniedRole,
      });
      expect(apiDecision.allowed).toBe(false);
      expect(apiDecision.status).toBe(403);
    }

    // Agency-managed tenant: ONLY `agency_admin` gets canExportLeadsCsv=true
    const agencyEnt = makeLive({ agencyId: "01AGY068000000000000000001" });
    expect(
      buildServiceAccessViewModel({ entitlement: agencyEnt, role: "agency_admin" })
        .canExportLeadsCsv,
    ).toBe(true);
    expect(
      buildServiceAccessViewModel({ entitlement: agencyEnt, role: "owner" }).canExportLeadsCsv,
    ).toBe(false);

    // retentionPaused derives from `operatorHold || retentionPausedAtMs !== null`
    const pausedByTimestamp = makeLive({
      operatorHold: false,
      retentionPausedAtMs: nowMs - DAY_MS,
    });
    expect(pausedByTimestamp.evaluation.retentionPaused).toBe(true);
    expect(pausedByTimestamp.evaluation.retentionPausedAtMs).toBe(nowMs - DAY_MS);
    expect(pausedByTimestamp.evaluation.deadlines.daysRemaining).toBeNull();
    expect(
      buildServiceAccessViewModel({ entitlement: pausedByTimestamp, role: "owner" })
        .retentionPaused,
    ).toBe(true);
  });

  it("registers daily offboarding sweep in OFFBOARDING_CRON_JOB_DEFINITIONS and wires worker entrypoint", () => {
    expect(OFFBOARDING_CRON_JOB_DEFINITIONS).toHaveLength(1);
    expect(OFFBOARDING_CRON_JOB_DEFINITIONS[0]?.name).toBe("daily-tenant-offboarding-sweep");
    expect(OFFBOARDING_CRON_JOB_DEFINITIONS[0]?.topic).toBe(TENANT_OFFBOARDING_SWEEP_TOPIC);
    expect(OFFBOARDING_CRON_JOB_DEFINITIONS[0]?.cadence).toBe("daily");

    const workerIndexSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/worker/index.ts"),
      "utf8",
    );
    expect(workerIndexSrc).toContain("...createOffboardingJobRegistry()");
    expect(workerIndexSrc).toContain("...OFFBOARDING_CRON_JOB_DEFINITIONS");
  });
});
