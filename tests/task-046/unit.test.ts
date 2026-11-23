import fs from "node:fs";
import path from "node:path";
import { consoleNeutralNotFoundResponse } from "@punyasitus/auth/platform/index";
import {
  ConsoleTenantError,
  getAllowedConsoleStateActions,
  resolveConsoleServiceStateTransition,
} from "@punyasitus/db/platform";
import { describe, expect, it } from "vitest";
import {
  getRegisteredTheme,
  isPlatformThemeId,
  isRegisteredCustomThemeId,
} from "../../apps/web/src/core/theme-registry.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NOW = Date.UTC(2026, 10, 23, 6, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe("TASK-046 unit — Superadmin Tenant Directory & Scoped Operations", () => {
  it("returns a bare neutral 404 plain-text response without console copy for non-console hosts", async () => {
    const res = consoleNeutralNotFoundResponse();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await res.text();
    expect(body).toBe("Not Found");
    expect(body).not.toContain("Console Operasional");
    expect(body).not.toContain("<!doctype");
  });

  it("computes allowed operator state actions strictly from current status and operatorHold", () => {
    expect(getAllowedConsoleStateActions({ status: "trial", operatorHold: false })).toEqual([
      "suspend_hold",
      "enter_recovery",
    ]);
    expect(getAllowedConsoleStateActions({ status: "suspended", operatorHold: true })).toEqual([
      "release_hold",
      "enter_recovery",
    ]);
    expect(getAllowedConsoleStateActions({ status: "recovery", operatorHold: false })).toEqual([
      "suspend_hold",
      "exit_recovery",
    ]);
    expect(getAllowedConsoleStateActions({ status: "purging", operatorHold: false })).toEqual([]);
    expect(getAllowedConsoleStateActions({ status: "purged", operatorHold: false })).toEqual([]);
  });

  it("enforces strict transition matrix and never grants free active time on release_hold", () => {
    // 1. suspend_hold from active succeeds and pauses retention
    const held = resolveConsoleServiceStateTransition(
      {
        status: "active",
        operatorHold: false,
        operatorHoldReason: null,
        trialEndsAt: null,
        paidThrough: NOW + 15 * DAY_MS,
      },
      {
        action: "suspend_hold",
        cleanReason: "Penangguhan investigasi laporan penyalahgunaan #AB-12",
        nowMs: NOW,
      },
    );
    expect(held.nextStatus).toBe("suspended");
    expect(held.nextOperatorHold).toBe(true);
    expect(held.pauseRetention).toBe(true);

    // 2. double suspend_hold rejected with 409 INVALID_STATE_TRANSITION
    expect(() =>
      resolveConsoleServiceStateTransition(
        {
          status: "suspended",
          operatorHold: true,
          operatorHoldReason: "Existing hold",
          trialEndsAt: null,
          paidThrough: NOW + 15 * DAY_MS,
        },
        {
          action: "suspend_hold",
          cleanReason: "Duplicate hold attempt rejected by matrix",
          nowMs: NOW,
        },
      ),
    ).toThrowError(ConsoleTenantError);

    // 3. release_hold when NOT held rejected with 409 INVALID_STATE_TRANSITION
    expect(() =>
      resolveConsoleServiceStateTransition(
        {
          status: "active",
          operatorHold: false,
          operatorHoldReason: null,
          trialEndsAt: null,
          paidThrough: NOW + 15 * DAY_MS,
        },
        {
          action: "release_hold",
          cleanReason: "Release hold attempted on unheld tenant",
          nowMs: NOW,
        },
      ),
    ).toThrowError(ConsoleTenantError);

    // 4. release_hold on expired paid_through recomputes to suspended (NEVER free active time!)
    const releasedExpired = resolveConsoleServiceStateTransition(
      {
        status: "suspended",
        operatorHold: true,
        operatorHoldReason: "Hold lama",
        trialEndsAt: null,
        paidThrough: NOW - 10 * DAY_MS,
      },
      {
        action: "release_hold",
        cleanReason: "Investigasi selesai, lepas hold dan hitung ulang hak",
        nowMs: NOW,
      },
    );
    expect(releasedExpired.nextOperatorHold).toBe(false);
    expect(releasedExpired.nextStatus).toBe("suspended");
    expect(releasedExpired.nextPaidThrough).toBe(NOW - 10 * DAY_MS);

    // 5. release_hold on valid future paid_through recomputes to active
    const releasedActive = resolveConsoleServiceStateTransition(
      {
        status: "suspended",
        operatorHold: true,
        operatorHoldReason: "Hold lama",
        trialEndsAt: null,
        paidThrough: NOW + 5 * DAY_MS,
      },
      {
        action: "release_hold",
        cleanReason: "Investigasi selesai, lepas hold untuk tenant berbayar",
        nowMs: NOW,
      },
    );
    expect(releasedActive.nextOperatorHold).toBe(false);
    expect(releasedActive.nextStatus).toBe("active");

    // 6. terminal states purging/purged reject every transition
    for (const terminal of ["purging", "purged"] as const) {
      expect(() =>
        resolveConsoleServiceStateTransition(
          {
            status: terminal,
            operatorHold: false,
            operatorHoldReason: null,
            trialEndsAt: null,
            paidThrough: null,
          },
          {
            action: "enter_recovery",
            cleanReason: "Attempt transition on terminal tenant state",
            nowMs: NOW,
          },
        ),
      ).toThrowError(ConsoleTenantError);
    }

    // 7. set_status -> active without future paidThroughMs rejected with 422
    try {
      resolveConsoleServiceStateTransition(
        {
          status: "trial",
          operatorHold: false,
          operatorHoldReason: null,
          trialEndsAt: NOW + 3 * DAY_MS,
          paidThrough: null,
        },
        {
          action: "set_status",
          targetStatus: "active",
          cleanReason: "Attempt activate without paid deadline",
          nowMs: NOW,
        },
      );
      expect.unreachable("Should reject set_status active without future paidThroughMs");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsoleTenantError);
      expect((err as ConsoleTenantError).status).toBe(422);
    }

    // 8. set_status on held tenant without explicit operatorHold is rejected (409) so active hold cannot be silently dropped
    try {
      resolveConsoleServiceStateTransition(
        {
          status: "suspended",
          operatorHold: true,
          operatorHoldReason: "Hold aktif",
          trialEndsAt: null,
          paidThrough: NOW + 10 * DAY_MS,
        },
        {
          action: "set_status",
          targetStatus: "active",
          paidThroughMs: NOW + 10 * DAY_MS,
          cleanReason: "Attempt set_status active without explicit operatorHold flag",
          nowMs: NOW,
        },
      );
      expect.unreachable("Should reject set_status when operatorHold is active and omitted");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsoleTenantError);
      expect((err as ConsoleTenantError).status).toBe(409);
      expect((err as ConsoleTenantError).code).toBe("INVALID_STATE_TRANSITION");
    }
  });

  it("distinguishes built-in platform themes, registered custom themes, and unregistered theme IDs", () => {
    expect(isPlatformThemeId("compro")).toBe(true);
    expect(isRegisteredCustomThemeId("compro")).toBe(false);
    expect(isRegisteredCustomThemeId("custom-sample-agency")).toBe(true);
    expect(getRegisteredTheme("custom-sample-agency")?.isCustom).toBe(true);
    expect(isRegisteredCustomThemeId("custom-unregistered-evil")).toBe(false);
    expect(getRegisteredTheme("custom-unregistered-evil")).toBeNull();
  });

  it("contains zero request-time DDL, zero @radix-ui imports, and zero asChild props in TASK-046 files", () => {
    const taskFiles = [
      "packages/db/src/platform/tenants.ts",
      "apps/web/src/pages/api/console/tenants/_shared.ts",
      "apps/web/src/pages/api/console/tenants/index.ts",
      "apps/web/src/pages/api/console/tenants/[tenantId]/index.ts",
      "apps/web/src/pages/api/console/tenants/[tenantId]/state.ts",
      "apps/web/src/pages/api/console/tenants/[tenantId]/themes.ts",
      "apps/web/src/pages/console/tenants/_page-guard.ts",
      "apps/web/src/pages/console/tenants/index.astro",
      "apps/web/src/pages/console/tenants/_TenantDirectoryPanel.tsx",
      "apps/web/src/pages/console/tenants/[handle].astro",
      "apps/web/src/pages/console/tenants/_TenantDetailPanel.tsx",
    ];

    for (const rel of taskFiles) {
      const fullPath = path.join(ROOT, rel);
      const content = fs.readFileSync(fullPath, "utf8");
      expect(content, `${rel} must not contain CREATE TABLE`).not.toMatch(/CREATE\s+TABLE/i);
      expect(content, `${rel} must not contain ensure*Schema`).not.toMatch(/ensure\w*Schema/);
      expect(content, `${rel} must not import @radix-ui`).not.toMatch(/@radix-ui|from\s+["']radix-ui["']/);
      expect(content, `${rel} must not use Radix asChild prop`).not.toMatch(/\basChild\b/);
    }
  });
});
