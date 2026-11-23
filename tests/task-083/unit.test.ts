import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENCY_PORTAL_MIGRATION,
  AGENCY_PORTAL_MIGRATION_SQL,
  AgencyError,
  computeAgencyClientCheckoutAmounts,
  computeEffectiveAgencyDiscountPercent,
  evaluateAgencyTrialQuota,
  validateAgencyDiscountPercent,
  validateAgencyDiscountTiers,
} from "@punyasitus/db/agencies/index";

const root = path.resolve(import.meta.dirname, "../..");

describe("TASK-083: Agency Portal unit tests (migration parity, pricing, tiers, trial cap, base-nova)", () => {
  it("keeps AGENCY_PORTAL_MIGRATION_SQL byte-for-byte identical to 0028_agency_portal.sql", () => {
    const sqlPath = path.join(root, "packages/db/migrations/platform/0028_agency_portal.sql");
    const diskSql = fs.readFileSync(sqlPath, "utf8");
    expect(AGENCY_PORTAL_MIGRATION.version).toBe(28);
    expect(AGENCY_PORTAL_MIGRATION.name).toBe("0028_agency_portal");
    expect(AGENCY_PORTAL_MIGRATION_SQL).toBe(diskSql);
    expect(diskSql).toContain("agencies_owner_user_uidx");
    expect(diskSql).toContain("agency_client_links_enforce_trial_cap");
    expect(diskSql).toContain("agency_client_links_enforce_trial_cap_update");
    expect(diskSql).toContain("AGENCY_TRIAL_LIMIT_REACHED");
  });

  it("validates agency base discount percent (0..50 integer) and rejects out-of-range values", () => {
    expect(validateAgencyDiscountPercent(0)).toBe(0);
    expect(validateAgencyDiscountPercent(15)).toBe(15);
    expect(validateAgencyDiscountPercent(50)).toBe(50);

    expect(() => validateAgencyDiscountPercent(-1)).toThrow(AgencyError);
    expect(() => validateAgencyDiscountPercent(51)).toThrow(AgencyError);
    expect(() => validateAgencyDiscountPercent(12.5)).toThrow(AgencyError);
  });

  it("validates volume discount tiers and computes effective discount accurately", () => {
    const tiers = validateAgencyDiscountTiers([
      { minPaidClients: 10, discountPercent: 25 },
      { minPaidClients: 3, discountPercent: 10 },
      { minPaidClients: 5, discountPercent: 15 },
    ]);
    // Sorted ascending by minPaidClients
    expect(tiers).toEqual([
      { minPaidClients: 3, discountPercent: 10 },
      { minPaidClients: 5, discountPercent: 15 },
      { minPaidClients: 10, discountPercent: 25 },
    ]);

    // 0% initial before reaching tier threshold
    expect(
      computeEffectiveAgencyDiscountPercent({
        baseDiscountPercent: 0,
        discountTiers: tiers,
        paidClientCount: 0,
      }),
    ).toEqual({ effectiveDiscountPercent: 0, tierCode: "standard_0" });

    // Reaches 3 paid clients -> 10%
    expect(
      computeEffectiveAgencyDiscountPercent({
        baseDiscountPercent: 0,
        discountTiers: tiers,
        paidClientCount: 3,
      }),
    ).toEqual({ effectiveDiscountPercent: 10, tierCode: "volume_3_10pct" });

    // Base discount higher than matched tier wins
    expect(
      computeEffectiveAgencyDiscountPercent({
        baseDiscountPercent: 20,
        discountTiers: tiers,
        paidClientCount: 5,
      }),
    ).toEqual({ effectiveDiscountPercent: 20, tierCode: "custom_20pct" });

    // Higher volume tier overrides lower base discount
    expect(
      computeEffectiveAgencyDiscountPercent({
        baseDiscountPercent: 20,
        discountTiers: tiers,
        paidClientCount: 12,
      }),
    ).toEqual({ effectiveDiscountPercent: 25, tierCode: "volume_10_25pct" });

    // Reject duplicate thresholds & non-monotonic discounts
    expect(() =>
      validateAgencyDiscountTiers([
        { minPaidClients: 5, discountPercent: 10 },
        { minPaidClients: 5, discountPercent: 15 },
      ]),
    ).toThrow(AgencyError);

    expect(() =>
      validateAgencyDiscountTiers([
        { minPaidClients: 3, discountPercent: 20 },
        { minPaidClients: 10, discountPercent: 10 },
      ]),
    ).toThrow(AgencyError);
  });

  it("computes exact integer IDR checkout amounts and never falls below AutoLaris minimum", () => {
    const zeroDiscount = computeAgencyClientCheckoutAmounts({
      baseAmountIdr: 179_000,
      agencyDiscountPercent: 0,
    });
    expect(zeroDiscount).toEqual({
      baseAmountIdr: 179_000,
      agencyDiscountPercent: 0,
      agencyDiscountIdr: 0,
      couponDiscountIdr: 0,
      totalDiscountIdr: 0,
      netAmountIdr: 179_000,
    });

    const discounted = computeAgencyClientCheckoutAmounts({
      baseAmountIdr: 179_000,
      agencyDiscountPercent: 15,
    });
    expect(discounted.agencyDiscountIdr).toBe(Math.floor((179_000 * 15) / 100)); // 26850
    expect(discounted.netAmountIdr).toBe(179_000 - 26_850); // 152150

    // Clamps to MIN_AUTOLARIS_CHARGE_IDR (Rp 10.000) when base is small
    const clamped = computeAgencyClientCheckoutAmounts({
      baseAmountIdr: 12_000,
      agencyDiscountPercent: 50,
    });
    expect(clamped.netAmountIdr).toBe(10_000);
    expect(clamped.agencyDiscountIdr).toBe(2_000);
  });

  it("enforces max 3 unpaid trials until first paid client unlocks the cap", () => {
    expect(evaluateAgencyTrialQuota({ unpaidTrialCount: 0, paidClientCount: 0 })).toEqual({
      unpaidTrialCap: 3,
      unpaidTrialCount: 0,
      paidClientCount: 0,
      unlockedByPaidClient: false,
      remainingUnpaidTrials: 3,
      canCreateTrial: true,
    });

    expect(evaluateAgencyTrialQuota({ unpaidTrialCount: 2, paidClientCount: 0 })).toEqual({
      unpaidTrialCap: 3,
      unpaidTrialCount: 2,
      paidClientCount: 0,
      unlockedByPaidClient: false,
      remainingUnpaidTrials: 1,
      canCreateTrial: true,
    });

    expect(evaluateAgencyTrialQuota({ unpaidTrialCount: 3, paidClientCount: 0 })).toEqual({
      unpaidTrialCap: 3,
      unpaidTrialCount: 3,
      paidClientCount: 0,
      unlockedByPaidClient: false,
      remainingUnpaidTrials: 0,
      canCreateTrial: false,
    });

    expect(evaluateAgencyTrialQuota({ unpaidTrialCount: 3, paidClientCount: 1 })).toEqual({
      unpaidTrialCap: 3,
      unpaidTrialCount: 3,
      paidClientCount: 1,
      unlockedByPaidClient: true,
      remainingUnpaidTrials: null,
      canCreateTrial: true,
    });
  });

  it("enforces DESIGN.md §4.2 base-nova rules across all TASK-083 UI files", () => {
    const uiFiles = [
      "apps/web/src/layouts/AgencyLayout.astro",
      "apps/web/src/pages/agency/index.astro",
      "apps/web/src/pages/agency/_AgencyEnrollmentPanel.tsx",
      "apps/web/src/pages/agency/clients/index.astro",
      "apps/web/src/pages/agency/clients/_AgencyClientsPanel.tsx",
      "apps/web/src/pages/agency/clients/[handle]/index.astro",
      "apps/web/src/pages/agency/billing/index.astro",
      "apps/web/src/pages/agency/billing/_AgencyBillingPanel.tsx",
      "apps/web/src/pages/console/agencies/index.astro",
      "apps/web/src/pages/console/agencies/_ConsoleAgenciesPanel.tsx",
    ];
    for (const rel of uiFiles) {
      const content = fs.readFileSync(path.join(root, rel), "utf8");
      expect(content, `${rel} must not use @radix-ui`).not.toMatch(/@radix-ui\//);
      expect(content, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(content, `${rel} must not use Sparkles`).not.toMatch(/\bSparkles(?:Icon)?\b/);
    }
  });
});
