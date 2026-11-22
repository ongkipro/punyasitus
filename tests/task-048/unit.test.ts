import fs from "node:fs";
import path from "node:path";
import { resolveConsoleHostContext } from "@punyasitus/auth/platform/index";
import {
  aggregatePlatformHealthStatus,
  evaluateHeartbeatStatus,
  isValidPlatformOperatorRole,
  PlatformSettingsError,
  redactAuditRecordForRead,
  validatePlatformSettingsUpdate,
} from "@punyasitus/db/platform";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

function collectFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("TASK-048 unit checks — platform_settings validation, health states, audit redaction & console boundaries", () => {
  it("validates and normalizes platform_settings using TASK-010 E.164 WhatsApp and TASK-011 safe HTTPS URLs", () => {
    const valid = validatePlatformSettingsUpdate({
      salesWhatsapp: "0812-3456-7890",
      supportEmail: "  Support@PunyaSitus.COM ",
      termsUrl: "https://punyasitus.com/syarat-ketentuan",
      privacyUrl: "https://punyasitus.com/kebijakan-privasi",
      supportHours: "Senin-Jumat 09.00-17.00 WIB",
      supportResponseTarget: "Maksimal 1 hari kerja",
      monthlyPriceIdr: 179_000,
      yearlyPriceIdr: 1_790_000,
      expectedVersion: 0,
      reason: "Initial configuration of official platform contacts and legal pages",
    });

    expect(valid.salesWhatsapp).toBe("6281234567890");
    expect(valid.supportEmail).toBe("support@punyasitus.com");
    expect(valid.termsUrl).toBe("https://punyasitus.com/syarat-ketentuan");
    expect(valid.privacyUrl).toBe("https://punyasitus.com/kebijakan-privasi");
    expect(valid.monthlyPriceIdr).toBe(179_000);
    expect(valid.yearlyPriceIdr).toBe(1_790_000);
  });

  it("rejects invalid WhatsApp, invalid email, javascript:/http:/private URLs, unknown keys, and forbidden keys", () => {
    const baseValid = {
      salesWhatsapp: "+6281234567890",
      supportEmail: "support@punyasitus.com",
      termsUrl: "https://punyasitus.com/terms",
      privacyUrl: "https://punyasitus.com/privacy",
      expectedVersion: 1,
      reason: "Valid operator update reason for settings test",
    };

    // Invalid WhatsApp
    expect(() =>
      validatePlatformSettingsUpdate({ ...baseValid, salesWhatsapp: "+14155550199" }),
    ).toThrow(PlatformSettingsError);

    // Invalid email
    expect(() =>
      validatePlatformSettingsUpdate({ ...baseValid, supportEmail: "not-an-email" }),
    ).toThrow(PlatformSettingsError);

    // Dangerous / non-HTTPS / private URLs
    for (const badUrl of [
      "javascript:alert(1)",
      "http://punyasitus.com/terms",
      "https://localhost/terms",
      "https://127.0.0.1/privacy",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/internal",
      "https://user:pass@punyasitus.com/terms",
    ]) {
      expect(() =>
        validatePlatformSettingsUpdate({ ...baseValid, termsUrl: badUrl }),
      ).toThrow(PlatformSettingsError);
      expect(() =>
        validatePlatformSettingsUpdate({ ...baseValid, privacyUrl: badUrl }),
      ).toThrow(PlatformSettingsError);
    }

    // Unknown field
    expect(() =>
      validatePlatformSettingsUpdate({ ...baseValid, unexpectedExtraField: "nope" }),
    ).toThrow(/Field tidak dikenal/);

    // Forbidden keys
    for (const forbiddenKey of [
      "actorUserId",
      "role",
      "tenantId",
      "secret",
      "impersonateUserId",
      "sql",
    ]) {
      try {
        validatePlatformSettingsUpdate({ ...baseValid, [forbiddenKey]: "forged" });
        expect.unreachable(`Expected forbidden key ${forbiddenKey} to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformSettingsError);
        expect((err as PlatformSettingsError).code).toBe("FORBIDDEN_FIELD");
      }
    }

    // Too-short reason
    expect(() =>
      validatePlatformSettingsUpdate({ ...baseValid, reason: "short" }),
    ).toThrow(PlatformSettingsError);
  });

  it("distinguishes healthy, degraded, stale, and unknown health states without fabricating healthy", () => {
    const nowMs = 1_763_830_000_000;

    // Never reported -> unknown (never healthy!)
    expect(
      evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: null,
        maxAgeSeconds: 3600,
      }),
    ).toEqual({ status: "unknown", ageSeconds: null });

    // Within threshold -> healthy
    expect(
      evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: nowMs - 120_000,
        maxAgeSeconds: 3600,
      }),
    ).toEqual({ status: "healthy", ageSeconds: 120 });

    // Older than threshold -> stale
    expect(
      evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: nowMs - 4000 * 1000,
        maxAgeSeconds: 3600,
      }),
    ).toEqual({ status: "stale", ageSeconds: 4000 });

    // Probe error or unhealthy flag -> degraded
    expect(
      evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: nowMs - 60_000,
        maxAgeSeconds: 3600,
        healthy: false,
      }),
    ).toEqual({ status: "degraded", ageSeconds: 60 });
    expect(
      evaluateHeartbeatStatus({
        nowMs,
        reportedAtMs: null,
        maxAgeSeconds: 3600,
        probeError: true,
      }),
    ).toEqual({ status: "degraded", ageSeconds: null });

    // Aggregation priority: degraded > stale > unknown > healthy
    expect(aggregatePlatformHealthStatus(["healthy", "healthy"])).toBe("healthy");
    expect(aggregatePlatformHealthStatus(["healthy", "unknown"])).toBe("unknown");
    expect(aggregatePlatformHealthStatus(["healthy", "stale", "unknown"])).toBe("stale");
    expect(aggregatePlatformHealthStatus(["healthy", "stale", "degraded"])).toBe("degraded");
    expect(aggregatePlatformHealthStatus([])).toBe("unknown");
  });

  it("re-redacts sensitive values on read-side audit records (defense-in-depth)", () => {
    const redacted = redactAuditRecordForRead({
      id: "01JFX048000000000000000001",
      actorUserId: "usr_op_1",
      actorRole: "platform_operator",
      action: "platform_settings.update",
      targetType: "platform_settings",
      targetId: "platform.public_settings",
      tenantId: null,
      reason:
        "Update with leaked password=TopSecret999 api_key=sk_live_abcdefgh12345 and email ops@example.com",
      outcome: "success",
      requestId: "req_audit_001",
      metadataJson: JSON.stringify({
        changedFields: ["salesWhatsapp"],
        token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig1234567890",
        apiKey: "cf_secret_key_999999",
        leadBody: "Nama saya Budi, nomor 081234567890",
        rawCookie: "__Host-ps_console_session=secret-cookie-val",
      }),
      createdAt: 1_763_830_000_000,
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("TopSecret999");
    expect(serialized).not.toContain("sk_live_abcdefgh12345");
    expect(serialized).not.toContain("ops@example.com");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("cf_secret_key_999999");
    expect(serialized).not.toContain("081234567890");
    expect(serialized).not.toContain("secret-cookie-val");
    expect(redacted.metadata).toMatchObject({
      changedFields: ["salesWhatsapp"],
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      leadBody: "[REDACTED]",
      rawCookie: "[REDACTED]",
    });
  });

  it("enforces strict console host isolation and valid operator roles", () => {
    const prodEnv = { APP_ENV: "production", PLATFORM_DOMAIN: "punyasitus.com" };
    expect(
      resolveConsoleHostContext(new Request("https://console.punyasitus.com/console"), prodEnv)
        ?.authSurface,
    ).toBe("console");

    for (const disallowed of [
      "https://app.punyasitus.com/console",
      "https://punyasitus.com/console",
      "https://toko.situsku.click/console",
      "https://evil.example.com/api/console/settings",
      "http://127.0.0.1:4321/console",
    ]) {
      expect(resolveConsoleHostContext(new Request(disallowed), prodEnv)).toBeNull();
    }

    // Local loopback permitted strictly when APP_ENV === "local"
    expect(
      resolveConsoleHostContext(new Request("http://127.0.0.1:4321/console"), {
        APP_ENV: "local",
      })?.isLocalLoopback,
    ).toBe(true);

    expect(isValidPlatformOperatorRole("platform_superadmin")).toBe(true);
    expect(isValidPlatformOperatorRole("platform_support")).toBe(true);
    expect(isValidPlatformOperatorRole("owner")).toBe(false);
    expect(isValidPlatformOperatorRole("admin")).toBe(false);
  });

  it("verifies zero @radix-ui/* imports or asChild props in TASK-048 console UI files", () => {
    const consoleFiles = collectFiles(path.join(ROOT, "apps/web/src/pages/console"));
    expect(consoleFiles.length).toBeGreaterThanOrEqual(9);
    for (const file of consoleFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `Found forbidden @radix-ui import in ${file}`).not.toMatch(/@radix-ui\//);
      expect(src, `Found forbidden asChild prop in ${file}`).not.toMatch(/\basChild\b/);
    }
  });
});
