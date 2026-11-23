import fs from "node:fs";
import path from "node:path";
import {
  assertNoForbiddenOnboardingFields,
  computeServerTrialWindow,
  FORBIDDEN_ONBOARDING_CLIENT_FIELDS,
  normalizeBusinessNameForTrialKey,
  ONBOARDING_RESERVED_HANDLES,
  ONBOARDING_SAAS_ZONE,
  ONBOARDING_TRIAL_DURATION_MS,
  ONBOARDING_TRIAL_DURATION_SECONDS,
  OnboardingValidationError,
  suggestHandleFromBusinessName,
  validateOnboardingHandleFormat,
  validateOnboardingProvisionPayload,
} from "@punyasitus/core/onboarding/index";
import { ONBOARDING_TRIAL_CLAIMS_MIGRATION_SQL } from "@punyasitus/db/provisioning/onboarding-migrations";
import { describe, expect, it } from "vitest";

describe("TASK-058 unit: self-service onboarding rules, trial math & handle guards", () => {
  it("computes server-owned 7-day trial of exactly 604,800 seconds", () => {
    expect(ONBOARDING_TRIAL_DURATION_SECONDS).toBe(604_800);
    expect(ONBOARDING_TRIAL_DURATION_MS).toBe(604_800_000);

    const anchorMs = Date.UTC(2026, 10, 23, 0, 0, 0);
    const window = computeServerTrialWindow(anchorMs);
    expect(window.durationSeconds).toBe(604_800);
    expect(window.trialStartsAtMs).toBe(anchorMs);
    expect(window.trialEndsAtMs - window.trialStartsAtMs).toBe(604_800_000);
  });

  it("normalizes and validates valid tenant handles with fixed .situsku.click suffix", () => {
    const res = validateOnboardingHandleFormat("  Kopi-Nusantara01  ");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.normalizedHandle).toBe("kopi-nusantara01");
      expect(res.saasZone).toBe(ONBOARDING_SAAS_ZONE);
      expect(res.primaryHost).toBe("kopi-nusantara01.situsku.click");
    }
  });

  it("rejects malformed and reserved handles with structured codes", () => {
    for (const invalid of ["", "ab", "-awal", "akhir-", "pakai spasi", "tanda_garis", "a".repeat(41)]) {
      const check = validateOnboardingHandleFormat(invalid);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("INVALID_HANDLE");
      }
    }

    for (const reserved of [
      "www",
      "app",
      "console",
      "admin",
      "api",
      "auth",
      "cname",
      "fallback",
      "mcp",
      "notif",
      "punyasitus",
      "situsku",
    ]) {
      expect(ONBOARDING_RESERVED_HANDLES.has(reserved)).toBe(true);
      const check = validateOnboardingHandleFormat(reserved.toUpperCase());
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("RESERVED_HANDLE");
      }
    }
  });

  it("suggests clean handles and normalizes business names for anti-abuse fingerprinting", () => {
    expect(suggestHandleFromBusinessName("Kopi Nusantara & Roastery!")).toBe(
      "kopi-nusantara-roastery",
    );
    expect(suggestHandleFromBusinessName("Admin")).toBe("");
    expect(normalizeBusinessNameForTrialKey("  Kopi   Nusantara,  Jakarta! ")).toBe(
      "kopi nusantara jakarta",
    );
  });

  it("rejects every client-supplied forged deadline, status, role, or platform authority field with 422", () => {
    for (const field of FORBIDDEN_ONBOARDING_CLIENT_FIELDS) {
      expect(() =>
        validateOnboardingProvisionPayload({
          handle: "toko-berkah",
          name: "Toko Berkah",
          vertical: "catalog",
          [field]: "forged-value",
        }),
      ).toThrowError(OnboardingValidationError);

      try {
        assertNoForbiddenOnboardingFields({ [field]: true });
      } catch (err) {
        expect(err).toBeInstanceOf(OnboardingValidationError);
        const validationErr = err as OnboardingValidationError;
        expect(validationErr.status).toBe(422);
        expect(validationErr.code).toBe("FORBIDDEN_CLIENT_FIELD");
        expect(validationErr.field).toBe(field);
      }
    }
  });

  it("rejects unknown extra fields and accepts clean onboarding payloads", () => {
    expect(() =>
      validateOnboardingProvisionPayload({
        handle: "warung-senja",
        name: "Warung Senja",
        vertical: "resto",
        unexpectedExtra: 123,
      }),
    ).toThrowError(OnboardingValidationError);

    const parsed = validateOnboardingProvisionPayload({
      handle: "Warung-Senja",
      name: "  Warung Senja  ",
      vertical: "resto",
    });
    expect(parsed).toEqual({
      handle: "warung-senja",
      name: "Warung Senja",
      vertical: "resto",
      idempotencyKey: null,
    });
  });

  it("keeps bundled 0006_onboarding_trial_claims SQL byte-identical to migration file on disk", () => {
    const sqlPath = path.resolve(
      import.meta.dirname,
      "../../packages/db/migrations/platform/0006_onboarding_trial_claims.sql",
    );
    const onDisk = fs.readFileSync(sqlPath, "utf8");
    expect(ONBOARDING_TRIAL_CLAIMS_MIGRATION_SQL).toBe(onDisk);
  });
});
