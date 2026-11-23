import fs from "node:fs";
import path from "node:path";
import {
  DAY_MS,
  GRACE_WINDOW_MS,
  LOCKED_WINDOW_MS,
  PAID_DELETION_WINDOW_MS,
  PAID_STORAGE_QUOTA_BYTES,
  TRIAL_DELETION_WINDOW_MS,
  TRIAL_DURATION_MS,
  TRIAL_DURATION_SECONDS,
  TRIAL_STORAGE_QUOTA_BYTES,
  addCalendarMonthsUtc,
  computeSettlementEntitlementTransition,
  evaluateDueRenewalReminder,
  evaluateEntitlementState,
} from "@punyasitus/core/billing/index";
import { EmailTemplateError, renderEmailTemplate } from "@punyasitus/core/email/index";
import {
  assertAuthorized,
  AuthorizationError,
  isActionAllowedForTenantStatus,
} from "@punyasitus/auth";
import {
  buildServiceAccessViewModel,
  evaluateTenantApiEntitlement,
  type LiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE_MS = Date.UTC(2026, 0, 31, 10, 0, 0); // 2026-01-31T10:00:00.000Z (month-end clamp vector)

function makeEntitlement(
  overrides: Partial<Parameters<typeof evaluateEntitlementState>[0]> = {},
): LiveTenantEntitlement {
  const evaluation = evaluateEntitlementState({
    storedStatus: "active",
    operatorHold: false,
    trialEndsAtMs: null,
    paidThroughMs: BASE_MS + 30 * DAY_MS,
    nowMs: BASE_MS,
    ...overrides,
  });
  return {
    tenantId: "01JT059TENANTALPHA00000001",
    organizationId: "org_t059_alpha",
    handle: "alpha-studio",
    tenantName: "Alpha Studio",
    agencyId: overrides.agencyId ?? null,
    version: 1,
    evaluation,
  };
}

describe("TASK-059: Timed Entitlement State Machine & Renewal Anchors (unit)", () => {
  it("enforces exact 7-day (604,800s) trial boundary and immediate unpaid expiry -> suspended", () => {
    expect(TRIAL_DURATION_SECONDS).toBe(604_800);
    expect(TRIAL_DURATION_MS).toBe(604_800_000);

    const trialStart = BASE_MS;
    const trialEndsAt = trialStart + TRIAL_DURATION_MS;

    // 1ms before expiry -> still trial (live, noindex, 100MB quota, custom domain disabled)
    const beforeExpiry = evaluateEntitlementState({
      storedStatus: "trial",
      operatorHold: false,
      trialEndsAtMs: trialEndsAt,
      paidThroughMs: null,
      nowMs: trialEndsAt - 1,
    });
    expect(beforeExpiry.effectiveStatus).toBe("trial");
    expect(beforeExpiry.needsStoredSync).toBe(false);
    expect(beforeExpiry.publicAccess).toEqual({
      allowed: true,
      httpStatus: 200,
      noindex: true,
      customDomainAllowed: false,
      cacheable: true,
    });
    expect(beforeExpiry.adminAccess.mode).toBe("full");
    expect(beforeExpiry.adminAccess.canEditContent).toBe(true);
    expect(beforeExpiry.adminAccess.storageQuotaBytes).toBe(TRIAL_STORAGE_QUOTA_BYTES);
    expect(beforeExpiry.deadlines.deletionDueAtMs).toBe(trialEndsAt + TRIAL_DELETION_WINDOW_MS);

    // Exact expiry millisecond -> immediately suspended (NO grace/locked for unpaid trial!)
    const atExpiry = evaluateEntitlementState({
      storedStatus: "trial",
      operatorHold: false,
      trialEndsAtMs: trialEndsAt,
      paidThroughMs: null,
      nowMs: trialEndsAt,
    });
    expect(atExpiry.effectiveStatus).toBe("suspended");
    expect(atExpiry.needsStoredSync).toBe(true);
    expect(atExpiry.suspensionReason).toBe("trial_expired");
    expect(atExpiry.publicAccess).toEqual({
      allowed: false,
      httpStatus: 503,
      noindex: true,
      customDomainAllowed: false,
      cacheable: false,
    });
    expect(atExpiry.adminAccess.mode).toBe("payment_recovery_only");
    expect(atExpiry.adminAccess.canEditContent).toBe(false);
    expect(atExpiry.adminAccess.canReadCms).toBe(false);
    expect(atExpiry.adminAccess.canExportLeadsCsv).toBe(true);
    expect(atExpiry.adminAccess.canAccessBilling).toBe(true);
    expect(atExpiry.adminAccess.canSignOut).toBe(true);
    expect(atExpiry.adminAccess.writeDenyCode).toBe("SUBSCRIPTION_LOCKED");
  });

  it("freezes time cleanly across active -> grace (H+1..H+3) -> locked (H+4..H+7) -> suspended (H+8+)", () => {
    const paidThrough = Date.UTC(2026, 2, 15, 0, 0, 0); // 2026-03-15T00:00:00Z

    // 1. Active (1ms before paidThrough)
    const active = evaluateEntitlementState({
      storedStatus: "active",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      nowMs: paidThrough - 1,
    });
    expect(active.effectiveStatus).toBe("active");
    expect(active.publicAccess).toEqual({
      allowed: true,
      httpStatus: 200,
      noindex: false,
      customDomainAllowed: true,
      cacheable: true,
    });
    expect(active.adminAccess.mode).toBe("full");
    expect(active.adminAccess.storageQuotaBytes).toBe(PAID_STORAGE_QUOTA_BYTES);

    // 2. Grace start (exact H0 = paidThrough) & Grace end - 1ms (paidThrough + 72h - 1ms)
    for (const ts of [paidThrough, paidThrough + GRACE_WINDOW_MS - 1]) {
      const grace = evaluateEntitlementState({
        storedStatus: "active",
        operatorHold: false,
        trialEndsAtMs: null,
        paidThroughMs: paidThrough,
        nowMs: ts,
      });
      expect(grace.effectiveStatus).toBe("grace");
      expect(grace.needsStoredSync).toBe(true);
      expect(grace.publicAccess.allowed).toBe(true);
      expect(grace.publicAccess.httpStatus).toBe(200);
      expect(grace.publicAccess.noindex).toBe(false);
      expect(grace.adminAccess.mode).toBe("full");
      expect(grace.adminAccess.canEditContent).toBe(true);
      expect(grace.adminAccess.canPublish).toBe(true);
    }

    // 3. Locked start (exact H+4 = paidThrough + 72h) & Locked end - 1ms (paidThrough + 168h - 1ms)
    for (const ts of [paidThrough + GRACE_WINDOW_MS, paidThrough + LOCKED_WINDOW_MS - 1]) {
      const locked = evaluateEntitlementState({
        storedStatus: "active",
        operatorHold: false,
        trialEndsAtMs: null,
        paidThroughMs: paidThrough,
        nowMs: ts,
      });
      expect(locked.effectiveStatus).toBe("locked");
      expect(locked.needsStoredSync).toBe(true);
      // CRITICAL SEO INVARIANT: public site STILL live & indexable during locked H+4..H+7!
      expect(locked.publicAccess).toEqual({
        allowed: true,
        httpStatus: 200,
        noindex: false,
        customDomainAllowed: true,
        cacheable: true,
      });
      expect(locked.adminAccess.mode).toBe("read_only_locked");
      expect(locked.adminAccess.canReadCms).toBe(true);
      expect(locked.adminAccess.canEditContent).toBe(false);
      expect(locked.adminAccess.canPublish).toBe(false);
      expect(locked.adminAccess.canExportLeadsCsv).toBe(true);
      expect(locked.adminAccess.canAccessBilling).toBe(true);
      expect(locked.adminAccess.writeDenyCode).toBe("SUBSCRIPTION_LOCKED");
    }

    // 4. Suspended (exact H+8 = paidThrough + 168h)
    const suspended = evaluateEntitlementState({
      storedStatus: "locked",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      nowMs: paidThrough + LOCKED_WINDOW_MS,
    });
    expect(suspended.effectiveStatus).toBe("suspended");
    expect(suspended.needsStoredSync).toBe(true);
    expect(suspended.suspensionReason).toBe("subscription_overdue");
    expect(suspended.publicAccess).toEqual({
      allowed: false,
      httpStatus: 503,
      noindex: true,
      customDomainAllowed: false,
      cacheable: false,
    });
    expect(suspended.adminAccess.mode).toBe("payment_recovery_only");
    expect(suspended.deadlines.deletionDueAtMs).toBe(paidThrough + PAID_DELETION_WINDOW_MS);
  });

  it("matches PLAN §17.1/§17.2 renewal anchors, month-end clamp, and manual operator hold precedence", () => {
    // Month-end clamps (non-leap and leap year)
    expect(addCalendarMonthsUtc(Date.UTC(2026, 0, 31, 10, 0, 0), 1)).toBe(
      Date.UTC(2026, 1, 28, 10, 0, 0),
    );
    expect(addCalendarMonthsUtc(Date.UTC(2028, 0, 31, 10, 0, 0), 1)).toBe(
      Date.UTC(2028, 1, 29, 10, 0, 0),
    );
    expect(addCalendarMonthsUtc(Date.UTC(2028, 1, 29, 10, 0, 0), 12)).toBe(
      Date.UTC(2029, 1, 28, 10, 0, 0),
    );

    // Active trial payment preserves remaining trial hours + adds 1 calendar month
    const trialEnds = Date.UTC(2026, 0, 31, 10, 0, 0);
    const paidDuringTrial = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "trial",
      operatorHold: false,
      paidThroughMs: null,
      trialEndsAtMs: trialEnds,
      nowMs: trialEnds - 3 * DAY_MS,
    });
    expect(paidDuringTrial.renewalAnchor).toBe("trial_end_preserved");
    expect(paidDuringTrial.nextStatus).toBe("active");
    expect(paidDuringTrial.nextPaidThroughMs).toBe(Date.UTC(2026, 1, 28, 10, 0, 0));

    // Renewal during grace or locked extends from paidThrough (`current_period_end`)
    const graceRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "grace",
      operatorHold: false,
      paidThroughMs: Date.UTC(2026, 0, 31, 10, 0, 0),
      trialEndsAtMs: null,
      nowMs: Date.UTC(2026, 1, 2, 10, 0, 0), // H+2
    });
    expect(graceRenewal.renewalAnchor).toBe("current_period_end");
    expect(graceRenewal.nextStatus).toBe("active");
    expect(graceRenewal.nextPaidThroughMs).toBe(Date.UTC(2026, 1, 28, 10, 0, 0));

    // Renewal after H+8 suspended starts fresh from settlement time (`settlement_time`)
    const suspendedAt = Date.UTC(2026, 1, 10, 12, 0, 0); // H+10
    const suspendedRenewal = computeSettlementEntitlementTransition({
      plan: "yearly",
      storedStatus: "suspended",
      operatorHold: false,
      paidThroughMs: Date.UTC(2026, 0, 31, 10, 0, 0),
      trialEndsAtMs: null,
      nowMs: suspendedAt,
    });
    expect(suspendedRenewal.renewalAnchor).toBe("settlement_time");
    expect(suspendedRenewal.nextStatus).toBe("active");
    expect(suspendedRenewal.nextPaidThroughMs).toBe(Date.UTC(2027, 1, 10, 12, 0, 0));

    // Manual operator hold ALWAYS survives payment settlement!
    const heldRenewal = computeSettlementEntitlementTransition({
      plan: "monthly",
      storedStatus: "suspended",
      operatorHold: true,
      paidThroughMs: Date.UTC(2026, 0, 31, 10, 0, 0),
      trialEndsAtMs: null,
      nowMs: Date.UTC(2026, 1, 1, 10, 0, 0),
    });
    expect(heldRenewal.operatorHoldPreserved).toBe(true);
    expect(heldRenewal.nextStatus).toBe("suspended");
    expect(heldRenewal.nextPaidThroughMs).toBeGreaterThan(Date.UTC(2026, 0, 31, 10, 0, 0));

    // Operator hold overrides active paid period
    const heldActive = evaluateEntitlementState({
      storedStatus: "active",
      operatorHold: true,
      operatorHoldReason: "Abuse investigation",
      paidThroughMs: BASE_MS + 20 * DAY_MS,
      trialEndsAtMs: null,
      nowMs: BASE_MS,
    });
    expect(heldActive.effectiveStatus).toBe("suspended");
    expect(heldActive.suspensionReason).toBe("operator_hold");
    expect(heldActive.publicAccess.httpStatus).toBe(503);
  });

  it("computes H-3, H-1, H0 renewal reminders with exact grace-expiring links and suppresses under hold", () => {
    const paidThrough = Date.UTC(2026, 4, 20, 0, 0, 0);
    const graceEnds = paidThrough + GRACE_WINDOW_MS;

    expect(
      evaluateDueRenewalReminder({
        storedStatus: "active",
        operatorHold: false,
        trialEndsAtMs: null,
        paidThroughMs: paidThrough,
        nowMs: paidThrough - 4 * DAY_MS,
      }),
    ).toBeNull();

    const hMinus3 = evaluateDueRenewalReminder({
      storedStatus: "active",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      nowMs: paidThrough - 3 * DAY_MS,
    });
    expect(hMinus3?.kind).toBe("paid_h_minus_3");
    expect(hMinus3?.linkExpiresAtMs).toBe(graceEnds);

    const hMinus1 = evaluateDueRenewalReminder({
      storedStatus: "active",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      nowMs: paidThrough - 1 * DAY_MS,
    });
    expect(hMinus1?.kind).toBe("paid_h_minus_1");
    expect(hMinus1?.linkExpiresAtMs).toBe(graceEnds);

    const h0 = evaluateDueRenewalReminder({
      storedStatus: "grace",
      operatorHold: false,
      trialEndsAtMs: null,
      paidThroughMs: paidThrough,
      nowMs: paidThrough + 1_000,
    });
    expect(h0?.kind).toBe("paid_h0");
    expect(h0?.linkExpiresAtMs).toBe(graceEnds);

    // Operator hold suppresses reminders
    expect(
      evaluateDueRenewalReminder({
        storedStatus: "active",
        operatorHold: true,
        trialEndsAtMs: null,
        paidThroughMs: paidThrough,
        nowMs: paidThrough - 1 * DAY_MS,
      }),
    ).toBeNull();
  });

  it("enforces RBAC + API entitlement decisions across locked, suspended, trial, and owner vs member", () => {
    // Locked tenant: reads, billing, leads CSV export allowed; CMS writes return 403 SUBSCRIPTION_LOCKED
    const lockedEnt = makeEntitlement({
      storedStatus: "active",
      paidThroughMs: BASE_MS - 4 * DAY_MS, // H+4 -> locked
      nowMs: BASE_MS,
    });
    expect(lockedEnt.evaluation.effectiveStatus).toBe("locked");

    expect(
      evaluateTenantApiEntitlement({
        entitlement: lockedEnt,
        method: "GET",
        subPath: "/pages",
        role: "editor",
      }).allowed,
    ).toBe(true);

    const writeDenied = evaluateTenantApiEntitlement({
      entitlement: lockedEnt,
      method: "POST",
      subPath: "/pages",
      role: "owner",
    });
    expect(writeDenied.allowed).toBe(false);
    expect(writeDenied.status).toBe(403);
    expect(writeDenied.code).toBe("SUBSCRIPTION_LOCKED");

    const publishDenied = evaluateTenantApiEntitlement({
      entitlement: lockedEnt,
      method: "POST",
      subPath: "/pages/1/publish",
      role: "owner",
    });
    expect(publishDenied.allowed).toBe(false);
    expect(publishDenied.status).toBe(403);
    expect(publishDenied.code).toBe("SUBSCRIPTION_LOCKED");

    // Owner billing & leads CSV export stay open on locked & suspended
    expect(
      evaluateTenantApiEntitlement({
        entitlement: lockedEnt,
        method: "POST",
        subPath: "/billing/obligations",
        role: "owner",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateTenantApiEntitlement({
        entitlement: lockedEnt,
        method: "GET",
        subPath: "/leads/export.csv",
        role: "owner",
      }).allowed,
    ).toBe(true);

    // Non-owner editor cannot access billing or leads CSV export
    const editorBilling = evaluateTenantApiEntitlement({
      entitlement: lockedEnt,
      method: "GET",
      subPath: "/billing",
      role: "editor",
    });
    expect(editorBilling.allowed).toBe(false);
    expect(editorBilling.status).toBe(403);
    expect(editorBilling.code).toBe("FORBIDDEN");

    // Suspended tenant: CMS reads AND writes denied with 403 SUBSCRIPTION_LOCKED; owner billing + export allowed
    const suspendedEnt = makeEntitlement({
      storedStatus: "active",
      paidThroughMs: BASE_MS - 8 * DAY_MS, // H+8 -> suspended
      nowMs: BASE_MS,
    });
    expect(suspendedEnt.evaluation.effectiveStatus).toBe("suspended");

    const suspendedRead = evaluateTenantApiEntitlement({
      entitlement: suspendedEnt,
      method: "GET",
      subPath: "/pages",
      role: "owner",
    });
    expect(suspendedRead.allowed).toBe(false);
    expect(suspendedRead.status).toBe(403);
    expect(suspendedRead.code).toBe("SUBSCRIPTION_LOCKED");

    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEnt,
        method: "GET",
        subPath: "/leads/export.csv",
        role: "owner",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEnt,
        method: "POST",
        subPath: "/billing/attempts",
        role: "owner",
      }).allowed,
    ).toBe(true);

    // Trial: custom domain connect/primary blocked with 403 TRIAL_DOMAIN_FORBIDDEN
    const trialEnt = makeEntitlement({
      storedStatus: "trial",
      paidThroughMs: null,
      trialEndsAtMs: BASE_MS + 5 * DAY_MS,
      nowMs: BASE_MS,
    });
    const domainConnect = evaluateTenantApiEntitlement({
      entitlement: trialEnt,
      method: "POST",
      subPath: "/domains",
      role: "owner",
    });
    expect(domainConnect.allowed).toBe(false);
    expect(domainConnect.status).toBe(403);
    expect(domainConnect.code).toBe("TRIAL_DOMAIN_FORBIDDEN");

    expect(isActionAllowedForTenantStatus("trial", "domain:make_primary")).toEqual({
      allowed: false,
      status: 403,
      code: "TRIAL_DOMAIN_FORBIDDEN",
    });

    expect(() =>
      assertAuthorized(
        {
          actorId: "u1",
          surface: "app",
          role: "owner",
          tenantId: "t1",
          tenantStatus: "locked",
        },
        "content:publish",
        "t1",
      ),
    ).toThrow(AuthorizationError);

    // Service-access view model distinguishes owner payer vs member non-payer
    const ownerVm = buildServiceAccessViewModel({ entitlement: suspendedEnt, role: "owner" });
    expect(ownerVm.isPayer).toBe(true);
    expect(ownerVm.canExportLeadsCsv).toBe(true);
    const memberVm = buildServiceAccessViewModel({ entitlement: suspendedEnt, role: "editor" });
    expect(memberVm.isPayer).toBe(false);
    expect(memberVm.canExportLeadsCsv).toBe(false);
  });

  it("renders Indonesian renewal-reminder & lifecycle-notice templates with strict HTML escaping", () => {
    const reminder = renderEmailTemplate("renewal-reminder", {
      recipientName: `Budi <script>alert(1)</script>`,
      tenantName: `Klinik "Sehat" & Co`,
      stage: "paid_h_minus_3",
      dueAtLabel: "20 Mei 2026, 07.00 WIB",
      graceEndsAtLabel: "23 Mei 2026, 07.00 WIB",
      amountIdr: 179_000,
      oneClickPayUrl: "https://app.punyasitus.com/pay/renew?token=abc123",
    });
    expect(reminder.subject).toContain("H-3");
    expect(reminder.html).not.toContain("<script>");
    expect(reminder.html).toContain("&lt;script&gt;");
    expect(reminder.html).toContain("Rp 179.000");
    expect(reminder.html).toContain("https://app.punyasitus.com/pay/renew?token=abc123");
    expect(reminder.text).toContain("https://app.punyasitus.com/pay/renew?token=abc123");

    const notice = renderEmailTemplate("lifecycle-notice", {
      tenantName: "Alpha Studio",
      state: "locked",
      deadlineLabel: "27 Mei 2026, 07.00 WIB",
      billingUrl: "https://app.punyasitus.com/dashboard/alpha/billing",
    });
    expect(notice.subject).toContain("terkunci");
    expect(notice.html).toContain("masih aktif dan terindeks");

    expect(() =>
      renderEmailTemplate("renewal-reminder", {
        tenantName: "Alpha",
        stage: "paid_h0",
        dueAtLabel: "20 Mei 2026",
        oneClickPayUrl: "javascript:alert(1)",
      }),
    ).toThrow(EmailTemplateError);
  });

  it("enforces zero @radix-ui/*, zero asChild, and zero Sparkles in TASK-059 UI files", () => {
    const files = [
      "apps/web/src/components/Maintenance.astro",
      "apps/web/src/components/admin/service-access/types.ts",
      "apps/web/src/components/admin/service-access/ServiceAccessBanner.tsx",
      "apps/web/src/components/admin/service-access/SuspendedRecoveryShell.tsx",
      "apps/web/src/components/admin/service-access/index.ts",
      "apps/web/src/layouts/DashboardLayout.astro",
    ];
    for (const rel of files) {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(content).not.toMatch(/@radix-ui\/|from\s+["']radix-ui["']/);
      expect(content).not.toMatch(/\basChild\b/);
      expect(content).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
    const maintenanceSrc = fs.readFileSync(
      path.join(ROOT, "apps/web/src/components/Maintenance.astro"),
      "utf8",
    );
    expect(maintenanceSrc).not.toMatch(/<script\b/i);
    expect(maintenanceSrc).not.toContain("punyasitus.com");
  });
});
