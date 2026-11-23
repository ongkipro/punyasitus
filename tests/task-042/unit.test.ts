import fs from "node:fs";
import path from "node:path";
import {
  CLOSED_SECTION_TYPES,
  evaluateThemeCompatibility,
  filterGrantedThemesForTenant,
  PLATFORM_THEME_IDS,
  REQUIRED_PUBLIC_THEME_ROUTES,
  ThemeNotFoundError,
  ThemeNotGrantedError,
  verifyThemeGrantForTenant,
  type TenantThemeEntitlementRecord,
  type ThemeCatalogEntry,
  type ThemeCompatibilityCandidate,
} from "@punyasitus/core/theme/index";
import { describe, expect, it } from "vitest";
import {
  buildThemeCompatibilityCandidate,
  getRegisteredTheme,
  listGrantedThemesForTenant,
  resolveGrantedThemeForActivation,
} from "../../apps/web/src/core/theme-registry.ts";

const ROOT_DIR = path.resolve(import.meta.dirname, "../..");

function collectFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe("TASK-042 Unit: Compatibility Evaluation, Grant Filtering & Static Guards", () => {
  const baseCandidate: ThemeCompatibilityCandidate = {
    id: "compro",
    name: "Corporate / B2B Compro",
    schemaVersion: 1,
    tier: "included",
    basePlatformThemeId: "compro",
    supportedSectionTypes: CLOSED_SECTION_TYPES,
    supportedRoutes: REQUIRED_PUBLIC_THEME_ROUTES,
    recommendedOfferingTypes: ["service", "product"],
  };

  it("marks compatible theme as compatible with supported sections and preservation fallback notes", () => {
    const report = evaluateThemeCompatibility(baseCandidate, {
      vertical: "travel",
      blogEnabled: true,
      catalogEnabled: true,
      sections: [
        { id: "s1", type: "hero", schemaVersion: 1, enabled: true },
        { id: "s2", type: "offerings_grid", schemaVersion: 1, enabled: true },
        { id: "s3", type: "faq", schemaVersion: 1, enabled: true },
      ],
      contentCounts: {
        pages: 3,
        posts: 5,
        offerings: 4,
        offeringTypes: ["tour"],
        menus: 2,
      },
    });

    expect(report.compatible).toBe(true);
    expect(report.unsupportedSections).toEqual([]);
    expect(report.supportedSections).toEqual(["hero", "offerings_grid", "faq"]);
    expect(report.blockingReasons).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.fallbackNotes.some((note) => note.includes("tersimpan terpisah"))).toBe(true);
  });

  it("rejects theme when tenant has unsupported section kinds", () => {
    const restrictedCandidate: ThemeCompatibilityCandidate = {
      ...baseCandidate,
      id: "custom-minimal-studio",
      name: "Minimal Studio",
      tier: "custom",
      supportedSectionTypes: ["hero", "about", "contact_location"],
    };

    const report = evaluateThemeCompatibility(restrictedCandidate, {
      sections: [
        { id: "s1", type: "hero", schemaVersion: 1 },
        { id: "s2", type: "faq", schemaVersion: 1 },
        { id: "s3", kind: "legacy_parallax_widget", schemaVersion: 1 },
      ],
    });

    expect(report.compatible).toBe(false);
    expect(report.supportedSections).toEqual(["hero"]);
    expect(report.unsupportedSections).toEqual(["faq", "legacy_parallax_widget"]);
    expect(report.blockingReasons.some((r) => r.code === "UNSUPPORTED_SECTION")).toBe(true);
  });

  it("rejects theme on schema version mismatch (theme or section schema v2 vs v1)", () => {
    const futureThemeReport = evaluateThemeCompatibility(
      { ...baseCandidate, schemaVersion: 2 },
      { currentSchemaVersion: 1, sections: [{ id: "s1", type: "hero", schemaVersion: 1 }] },
    );
    expect(futureThemeReport.compatible).toBe(false);
    expect(
      futureThemeReport.blockingReasons.some((r) => r.code === "SCHEMA_VERSION_MISMATCH"),
    ).toBe(true);

    const futureSectionReport = evaluateThemeCompatibility(baseCandidate, {
      currentSchemaVersion: 1,
      sections: [{ id: "s1", type: "hero", schemaVersion: 2 }],
    });
    expect(futureSectionReport.compatible).toBe(false);
    expect(
      futureSectionReport.blockingReasons.some((r) => r.code === "SCHEMA_VERSION_MISMATCH"),
    ).toBe(true);
  });

  it("rejects theme when required module is disabled or required public routes are missing", () => {
    const blogRequiredReport = evaluateThemeCompatibility(
      { ...baseCandidate, requiredModules: ["blog"] },
      { blogEnabled: false, catalogEnabled: true },
    );
    expect(blogRequiredReport.compatible).toBe(false);
    expect(
      blogRequiredReport.blockingReasons.some((r) => r.code === "MISSING_REQUIRED_MODULE"),
    ).toBe(true);

    const missingRouteReport = evaluateThemeCompatibility(
      { ...baseCandidate, supportedRoutes: ["home", "page"] },
      {},
    );
    expect(missingRouteReport.compatible).toBe(false);
    expect(
      missingRouteReport.blockingReasons.some((r) => r.code === "MISSING_REQUIRED_ROUTE"),
    ).toBe(true);
  });

  it("filters granted themes strictly per tenant and never leaks foreign tenant custom themes", () => {
    const catalog: ThemeCatalogEntry[] = [
      ...PLATFORM_THEME_IDS.map((id) => ({
        id,
        name: `Platform ${id}`,
        tier: "included" as const,
        active: true,
      })),
      {
        id: "custom-sample-agency",
        name: "Editorial Studio Agency",
        tier: "custom",
        active: true,
      },
      {
        id: "custom-vip-client",
        name: "VIP Client Theme",
        tier: "custom",
        active: true,
      },
    ];

    const grants: TenantThemeEntitlementRecord[] = [
      {
        tenantId: "tenant-b",
        themeId: "custom-sample-agency",
        active: true,
        revokedAt: null,
      },
      {
        tenantId: "tenant-a",
        themeId: "custom-vip-client",
        active: true,
        revokedAt: Date.UTC(2026, 10, 20), // revoked!
      },
    ];

    // Tenant A sees ONLY the 6 platform themes — never Tenant B's grant or its own revoked grant
    const grantedForA = filterGrantedThemesForTenant("tenant-a", catalog, grants);
    expect(grantedForA.map((g) => g.entry.id)).toEqual([...PLATFORM_THEME_IDS]);

    // Tenant B sees the 6 platform themes + its active granted custom theme
    const grantedForB = filterGrantedThemesForTenant("tenant-b", catalog, grants);
    expect(grantedForB.map((g) => g.entry.id)).toEqual([
      ...PLATFORM_THEME_IDS,
      "custom-sample-agency",
    ]);

    // Direct grant assertions
    expect(() =>
      verifyThemeGrantForTenant("tenant-a", "custom-sample-agency", catalog, grants),
    ).toThrow(ThemeNotGrantedError);

    expect(() =>
      verifyThemeGrantForTenant("tenant-a", "custom-vip-client", catalog, grants),
    ).toThrow(ThemeNotGrantedError);

    expect(() =>
      verifyThemeGrantForTenant("tenant-a", "custom-nonexistent", catalog, grants),
    ).toThrow(ThemeNotFoundError);

    const okB = verifyThemeGrantForTenant("tenant-b", "custom-sample-agency", catalog, grants);
    expect(okB.grantSource).toBe("tenant_grant");
    expect(okB.entry.id).toBe("custom-sample-agency");
  });

  it("integrates theme-registry strict activation resolution without silent fallback", () => {
    const sample = getRegisteredTheme("custom-sample-agency");
    expect(sample).not.toBeNull();
    const candidate = buildThemeCompatibilityCandidate(sample!);
    expect(candidate.id).toBe("custom-sample-agency");
    expect(candidate.schemaVersion).toBe(1);

    // Tenant A without grant -> ThemeNotGrantedError (403)
    expect(() =>
      resolveGrantedThemeForActivation({
        tenantId: "tenant-a",
        requestedThemeId: "custom-sample-agency",
        tenantGrants: [{ tenantId: "tenant-b", themeId: "custom-sample-agency", active: true }],
      }),
    ).toThrow(ThemeNotGrantedError);

    // Unknown theme -> ThemeNotFoundError (404)
    expect(() =>
      resolveGrantedThemeForActivation({
        tenantId: "tenant-a",
        requestedThemeId: "custom-unknown-xyz",
      }),
    ).toThrow(ThemeNotFoundError);

    // Tenant B with grant -> resolves custom theme cleanly
    const resolvedB = resolveGrantedThemeForActivation({
      tenantId: "tenant-b",
      requestedThemeId: "custom-sample-agency",
      tenantGrants: [{ tenantId: "tenant-b", themeId: "custom-sample-agency", active: true }],
    });
    expect(resolvedB.entry.id).toBe("custom-sample-agency");
    expect(resolvedB.grantSource).toBe("tenant_grant");

    // Listing for Tenant A never exposes custom-sample-agency granted to Tenant B
    const listedA = listGrantedThemesForTenant({
      tenantId: "tenant-a",
      tenantGrants: [{ tenantId: "tenant-b", themeId: "custom-sample-agency", active: true }],
    });
    expect(listedA.some((t) => t.id === "custom-sample-agency")).toBe(false);
    expect(listedA.map((t) => t.id)).toEqual([...PLATFORM_THEME_IDS]);
  });

  it("enforces static guards: zero @radix-ui/*, zero asChild, and zero runtime CREATE TABLE DDL", () => {
    const uiFiles = collectFilesRecursive(
      path.join(ROOT_DIR, "apps/web/src/pages/dashboard/[handle]/appearance/themes"),
    );
    expect(uiFiles.length).toBeGreaterThanOrEqual(2);

    for (const file of uiFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${file} must not import @radix-ui/*`).not.toMatch(/@radix-ui\//);
      expect(src, `${file} must not import radix-ui`).not.toMatch(/from\s+["']radix-ui["']/);
      expect(src, `${file} must not use asChild`).not.toMatch(/\basChild\b/);
    }

    const runtimeDirs = [
      path.join(ROOT_DIR, "packages/db/src/themes"),
      path.join(ROOT_DIR, "apps/web/src/pages/api/tenants/[tenantId]/themes"),
    ];
    for (const dir of runtimeDirs) {
      const files = collectFilesRecursive(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const src = fs.readFileSync(file, "utf8");
        expect(src, `${file} must not execute runtime CREATE TABLE DDL`).not.toMatch(
          /\bCREATE\s+TABLE\b/i,
        );
      }
    }
  });
});
