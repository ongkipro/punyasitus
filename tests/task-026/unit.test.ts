import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashInvitationToken,
  INVITATION_EXPIRY_HOURS,
  INVITATION_EXPIRY_MS,
  INVITATION_EXPIRY_SECONDS,
  InvitationError,
  MAX_TENANT_MEMBERS,
  normalizeInviteEmail,
  OWNER_TRANSFER_REAUTH_WINDOW_MS,
  resolveInvitationExpirySeconds,
} from "@punyasitus/auth/invitations/index";
import {
  normalizeAndValidateTenantHandle,
  PROVISIONING_RESERVED_HANDLES,
  ProvisioningError,
  resolveNextServiceState,
  TRIAL_DURATION_SECONDS,
} from "@punyasitus/db/provisioning/index";
import { resolveConsoleHostContext } from "../../apps/web/src/pages/api/console/provisioning/_shared.ts";

const root = path.resolve(import.meta.dirname, "../..");

describe("TASK-026 unit tests — Provisioning, Invitations, 5-Member Cap & Service State", () => {
  it("exports explicit 48-hour invitation expiry, 5-member cap, 7-day trial, and 10-minute reauth constants", () => {
    expect(INVITATION_EXPIRY_HOURS).toBe(48);
    expect(INVITATION_EXPIRY_SECONDS).toBe(172_800);
    expect(INVITATION_EXPIRY_MS).toBe(172_800_000);
    expect(MAX_TENANT_MEMBERS).toBe(5);
    expect(TRIAL_DURATION_SECONDS).toBe(604_800);
    expect(OWNER_TRANSFER_REAUTH_WINDOW_MS).toBe(600_000);
    expect(resolveInvitationExpirySeconds()).toBe(172_800);
    expect(resolveInvitationExpirySeconds(3600)).toBe(3600);
    expect(() => resolveInvitationExpirySeconds(0)).toThrow(InvitationError);
    expect(() => resolveInvitationExpirySeconds(-10)).toThrow(InvitationError);
  });

  it("normalizes valid tenant handles and rejects malformed or reserved handles", () => {
    expect(normalizeAndValidateTenantHandle("  Toko-Maju-01  ")).toBe("toko-maju-01");
    expect(normalizeAndValidateTenantHandle("abc")).toBe("abc");

    for (const reserved of [
      "app",
      "console",
      "api",
      "www",
      "admin",
      "auth",
      "mail",
      "status",
      "cname",
      "fallback",
      "notif",
    ]) {
      expect(PROVISIONING_RESERVED_HANDLES.has(reserved)).toBe(true);
      expect(() => normalizeAndValidateTenantHandle(reserved)).toThrowError(
        expect.objectContaining({
          status: 422,
          code: "RESERVED_HANDLE",
        }),
      );
    }

    for (const invalid of ["ab", "-leading", "trailing-", "bad_underscore", "has space", "a".repeat(41)]) {
      expect(() => normalizeAndValidateTenantHandle(invalid)).toThrowError(
        expect.objectContaining({
          status: 422,
          code: "INVALID_HANDLE",
        }),
      );
    }
  });

  it("normalizes invitation emails and produces deterministic SHA-256 token digests distinct from plaintext", async () => {
    expect(normalizeInviteEmail("  Owner.Demo@Example.ID ")).toBe("owner.demo@example.id");
    expect(() => normalizeInviteEmail("bukan-email")).toThrow(InvitationError);
    expect(() => normalizeInviteEmail("bad\r\n@example.com")).toThrow(InvitationError);

    const raw = "a".repeat(64);
    const hash1 = await hashInvitationToken(raw);
    const hash2 = await hashInvitationToken(raw);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).not.toBe(raw);
  });

  it("recomputes service state without granting free active time when releasing an operator hold", () => {
    const nowMs = 1_764_000_000_000;

    // 1. Applying operator hold suspends and pauses retention
    const held = resolveNextServiceState(
      {
        status: "active",
        operatorHold: false,
        operatorHoldReason: null,
        trialEndsAt: null,
        paidThrough: nowMs + 10 * 86_400_000,
      },
      {
        action: "suspend_hold",
        cleanReason: "Peninjauan keamanan akibat laporan penyalahgunaan",
        nowMs,
      },
    );
    expect(held.nextStatus).toBe("suspended");
    expect(held.nextOperatorHold).toBe(true);
    expect(held.pauseRetention).toBe(true);

    // 2. Releasing hold on an EXPIRED paid tenant MUST NOT resurrect it as active!
    const releasedExpired = resolveNextServiceState(
      {
        status: "suspended",
        operatorHold: true,
        operatorHoldReason: "Hold sebelumnya",
        trialEndsAt: null,
        paidThrough: nowMs - 10 * 86_400_000, // 10 days past expiry -> H+10 -> suspended
      },
      {
        action: "release_hold",
        cleanReason: "Laporan telah diverifikasi aman oleh tim operasional",
        nowMs,
      },
    );
    expect(releasedExpired.nextOperatorHold).toBe(false);
    expect(releasedExpired.nextStatus).toBe("suspended");
    expect(releasedExpired.clearRetentionPause).toBe(true);

    // 3. Releasing hold on an active paid tenant restores active
    const releasedActive = resolveNextServiceState(
      {
        status: "suspended",
        operatorHold: true,
        operatorHoldReason: "Hold sebelumnya",
        trialEndsAt: null,
        paidThrough: nowMs + 5 * 86_400_000,
      },
      {
        action: "release_hold",
        cleanReason: "Penangguhan selesai setelah klarifikasi pemilik",
        nowMs,
      },
    );
    expect(releasedActive.nextOperatorHold).toBe(false);
    expect(releasedActive.nextStatus).toBe("active");

    // 4. set_status targeting active/trial requires explicit future deadline (prevents infinite free time)
    expect(() =>
      resolveNextServiceState(
        {
          status: "trial",
          operatorHold: false,
          operatorHoldReason: null,
          trialEndsAt: nowMs + 86_400_000,
          paidThrough: null,
        },
        {
          action: "set_status",
          targetStatus: "active",
          cleanReason: "Mencoba aktivasi tanpa paidThroughMs yang valid",
          nowMs,
        },
      ),
    ).toThrowError(expect.objectContaining({ status: 422, code: "VALIDATION_ERROR" }));

    expect(() =>
      resolveNextServiceState(
        {
          status: "suspended",
          operatorHold: false,
          operatorHoldReason: null,
          trialEndsAt: null,
          paidThrough: null,
        },
        {
          action: "set_status",
          targetStatus: "trial",
          cleanReason: "Mencoba uji coba tanpa trialEndsAtMs yang valid",
          nowMs,
        },
      ),
    ).toThrowError(expect.objectContaining({ status: 422, code: "VALIDATION_ERROR" }));

    const validActive = resolveNextServiceState(
      {
        status: "trial",
        operatorHold: false,
        operatorHoldReason: null,
        trialEndsAt: nowMs + 86_400_000,
        paidThrough: null,
      },
      {
        action: "set_status",
        targetStatus: "active",
        paidThroughMs: nowMs + 30 * 86_400_000,
        cleanReason: "Aktivasi dengan batas masa berlaku terverifikasi",
        nowMs,
      },
    );
    expect(validActive.nextStatus).toBe("active");
    expect(validActive.nextPaidThrough).toBe(nowMs + 30 * 86_400_000);

    // 5. Terminal purged tenant cannot be transitioned
    expect(() =>
      resolveNextServiceState(
        {
          status: "purged",
          operatorHold: false,
          operatorHoldReason: null,
          trialEndsAt: null,
          paidThrough: null,
        },
        {
          action: "release_hold",
          cleanReason: "Mencoba memulihkan tenant yang sudah dihapus permanen",
          nowMs,
        },
      ),
    ).toThrow(ProvisioningError);
  });

  it("isolates console provisioning host boundary strictly to console.punyasitus.com", () => {
    const prodEnv = { APP_ENV: "production", PLATFORM_DOMAIN: "punyasitus.com" };

    const onConsole = resolveConsoleHostContext(
      new Request("https://console.punyasitus.com/api/console/provisioning"),
      prodEnv,
    );
    expect(onConsole.allowed).toBe(true);

    for (const deniedUrl of [
      "https://app.punyasitus.com/api/console/provisioning",
      "https://punyasitus.com/api/console/provisioning",
      "https://alpha.situsku.click/api/console/provisioning",
      "http://127.0.0.1:4321/api/console/provisioning",
    ]) {
      expect(resolveConsoleHostContext(new Request(deniedUrl), prodEnv).allowed).toBe(false);
    }

    const onLocal = resolveConsoleHostContext(
      new Request("http://127.0.0.1:4321/api/console/provisioning"),
      { APP_ENV: "local", PLATFORM_DOMAIN: "punyasitus.com" },
    );
    expect(onLocal.allowed).toBe(true);
  });

  it("keeps all TASK-026 UI files free of @radix-ui/*, Radix asChild, and banned Sparkles icons", () => {
    const uiFiles = [
      "apps/web/src/pages/console/provisioning/index.astro",
      "apps/web/src/pages/console/provisioning/_ConsoleProvisioningPanel.tsx",
      "apps/web/src/pages/dashboard/[handle]/settings/members/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/members/_MembersManager.tsx",
      "apps/web/src/pages/dashboard/[handle]/settings/members/accept/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/members/_AcceptInvitation.tsx",
      "apps/web/src/pages/dashboard/[handle]/service-status/index.astro",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(root, rel), "utf8");
      expect(content).not.toMatch(/@radix-ui\/|from\s+["']radix-ui["']/);
      expect(content).not.toMatch(/\basChild\b/);
      expect(content).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});
