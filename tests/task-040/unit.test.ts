import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

import {
  ALLOWED_BUSINESS_CATEGORIES,
  attachGroupedSettingsExtension,
  createDefaultGroupedSettingsExtension,
  extractGroupedSettingsExtension,
  filterPublicNavigationForSettings,
  formatDateOnlyPreservingSemantics,
  formatTimestampInTenantTimezone,
  isPublicRouteEnabledBySettings,
  SettingsValidationError,
  validateGroupedSettingsPatch,
  validateIanaTimezone,
  type PublicNavItem,
} from "@punyasitus/core/settings/index";
import { SiteSettingsSnapshotSchema } from "@punyasitus/core/content/index";
import {
  TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION,
  TENANT_0005_SITE_SETTINGS_GROUPED_SQL,
} from "@punyasitus/db/settings/migrations";
import {
  resolveGroupedSettingsServerContext,
  type SettingsAstroContextLike,
} from "../../apps/web/src/core/settings.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function makeAstroMock(overrides: {
  handle?: string;
  surface?: App.Locals["surface"];
  role?: "owner" | "admin" | "editor" | "agency_admin";
  tenantStatus?:
    | "trial"
    | "active"
    | "grace"
    | "locked"
    | "suspended"
    | "recovery"
    | "purging"
    | "purged";
  operatorHold?: boolean;
}): SettingsAstroContextLike {
  const handle = overrides.handle ?? "klinik-sehat";
  const status = overrides.tenantStatus ?? "active";
  return {
    params: { handle },
    response: { headers: new Headers() },
    locals: {
      surface: overrides.surface ?? "app",
      isLocalLoopback: false,
      authUser: {
        id: "user_1",
        email: "owner@example.com",
        name: "Budi Pemilik",
      },
      authorizedTenantMember: {
        userId: "user_1",
        tenantId: "01JT040TENANTA000000000001",
        organizationId: "org_t040_alpha",
        handle,
        tenantName: "Klinik Sehat Nusantara",
        tenantStatus: status,
        role: overrides.role ?? "owner",
        membershipId: "mem_1",
      },
      tenantEntitlement: {
        tenantId: "01JT040TENANTA000000000001",
        organizationId: "org_t040_alpha",
        handle,
        tenantName: "Klinik Sehat Nusantara",
        agencyId: null,
        version: 1,
        evaluation: {
          storedStatus: status,
          effectiveStatus: status,
          needsStoredSync: false,
          evaluatedAtMs: Date.UTC(2026, 10, 23),
          operatorHold: overrides.operatorHold ?? false,
          operatorHoldReason: overrides.operatorHold ? "Pemeriksaan kepatuhan" : null,
          suspensionReason: overrides.operatorHold ? "operator_hold" : null,
          agencyManaged: false,
        },
      },
      tenant: null,
      tenantDb: null,
    } as unknown as App.Locals,
  };
}

describe("TASK-040 Unit: Grouped Settings Validation, Navigation, Timezone & R3 Guards", () => {
  it("validates allowlisted fields per group and rejects cross-group, unknown, tenant-selector, and secret fields", () => {
    const gen = validateGroupedSettingsPatch("general", {
      siteTitle: "PT Nusantara Mandiri",
      tagline: "Mitra Konstruksi Nasional",
      timezone: "Asia/Makassar",
      publicEmail: "halo@nusantara.co.id",
      expectedVersion: 1,
    });
    expect(gen.siteSettingsPatch?.siteTitle).toBe("PT Nusantara Mandiri");
    expect(gen.siteSettingsPatch?.timezone).toBe("Asia/Makassar");
    expect(gen.businessProfilePatch?.email).toBe("halo@nusantara.co.id");

    // Cross-group field rejected
    expect(() =>
      validateGroupedSettingsPatch("general", {
        blogEnabled: false,
        expectedVersion: 1,
      }),
    ).toThrow(SettingsValidationError);

    // Forbidden tenant selector rejected
    expect(() =>
      validateGroupedSettingsPatch("general", {
        siteTitle: "Valid",
        tenantId: "01JFORGEDTENANT00000000000",
        expectedVersion: 1,
      }),
    ).toThrow(/tenantId|Forbidden/i);

    // Secret/infrastructure keys rejected
    for (const secretKey of ["cloudflareApiToken", "smtpPassword", "coolifyToken"]) {
      expect(() =>
        validateGroupedSettingsPatch("general", {
          siteTitle: "Valid",
          [secretKey]: "super-secret-value",
          expectedVersion: 1,
        }),
      ).toThrow(SettingsValidationError);
    }
  });

  it("enforces Schema.org business category allowlist, Indonesian WhatsApp E.164, and HTTPS-only URLs", () => {
    expect(ALLOWED_BUSINESS_CATEGORIES).not.toContain("ProfessionalService");

    expect(() =>
      validateGroupedSettingsPatch("business", {
        businessCategory: "ProfessionalService",
        expectedVersion: 1,
      }),
    ).toThrow(SettingsValidationError);

    const biz = validateGroupedSettingsPatch("business", {
      businessName: "CV Karya Jaya",
      businessCategory: "TravelAgency",
      whatsappE164: "0812-3456-7890",
      phone: "(021) 555-0192",
      mapsUrl: "https://maps.google.com/?q=-6.2,106.8",
      serviceAreas: ["Jakarta", "jakarta", "Bandung"],
      socialLinks: [{ platform: "instagram", url: "https://instagram.com/karyajaya" }],
      expectedVersion: 1,
    });
    expect(biz.businessProfilePatch?.whatsappE164).toBe("6281234567890");
    expect(biz.businessProfilePatch?.phone).toBe("62215550192");
    expect(biz.businessProfilePatch?.serviceAreas).toEqual(["Jakarta", "Bandung"]);

    // Reject javascript: or http:// links
    expect(() =>
      validateGroupedSettingsPatch("business", {
        mapsUrl: "javascript:alert(1)",
        expectedVersion: 1,
      }),
    ).toThrow(SettingsValidationError);
    expect(() =>
      validateGroupedSettingsPatch("business", {
        socialLinks: [{ platform: "instagram", url: "http://instagram.com/insecure" }],
        expectedVersion: 1,
      }),
    ).toThrow(SettingsValidationError);
  });

  it("validates Reading & SEO group constraints (itemsPerPage, offering types, noindex, plain verification tokens)", () => {
    const reading = validateGroupedSettingsPatch("reading", {
      homepageMode: "page",
      homepagePageId: 7,
      blogEnabled: false,
      enabledOfferingTypes: ["service", "tour"],
      itemsPerPage: 24,
      expectedVersion: 2,
    });
    expect(reading.siteSettingsPatch?.blogEnabled).toBe(false);
    expect(reading.siteSettingsPatch?.catalogEnabled).toBe(true);
    expect(reading.extensionPatch?.reading?.itemsPerPage).toBe(24);
    expect(reading.extensionPatch?.reading?.enabledOfferingTypes).toEqual(["service", "tour"]);

    expect(() =>
      validateGroupedSettingsPatch("reading", {
        itemsPerPage: 10,
        expectedVersion: 2,
      }),
    ).toThrow(SettingsValidationError);

    expect(() =>
      validateGroupedSettingsPatch("reading", {
        homepageMode: "page",
        homepagePageId: null,
        expectedVersion: 2,
      }),
    ).toThrow(SettingsValidationError);

    const seo = validateGroupedSettingsPatch("seo", {
      defaultTitle: "Klinik Nusantara — Perawatan Modern",
      defaultDescription: "Layanan kesehatan keluarga di Jakarta.",
      siteVisibility: "noindex",
      aiCrawlerTrainingOptOut: true,
      googleSiteVerification: "abcDEF1234567890_token",
      bingSiteVerification: "ABCDEF0123456789ABCDEF0123456789",
      expectedVersion: 3,
    });
    expect(seo.siteSettingsPatch?.siteVisibility).toBe("noindex");
    expect(seo.siteSettingsPatch?.aiTrainingPolicy).toBe("disallow");

    // Reject HTML tags in verification token or SEO defaults
    expect(() =>
      validateGroupedSettingsPatch("seo", {
        googleSiteVerification: '<meta name="google-site-verification" content="abc" />',
        expectedVersion: 3,
      }),
    ).toThrow(SettingsValidationError);
    expect(() =>
      validateGroupedSettingsPatch("seo", {
        defaultTitle: "<script>alert(1)</script>",
        expectedVersion: 3,
      }),
    ).toThrow(SettingsValidationError);
  });

  it("preserves UTC instant semantics on timezone change while keeping date-only tour dates immutable", () => {
    expect(validateIanaTimezone("Asia/Jakarta")).toBe("Asia/Jakarta");
    expect(validateIanaTimezone("Asia/Jayapura")).toBe("Asia/Jayapura");
    expect(() => validateIanaTimezone("Mars/Olympus_Mons")).toThrow(SettingsValidationError);

    // 2026-12-15T16:30:00.000Z is 23:30 WIB on 15 Dec in Asia/Jakarta,
    // and 01:30 WIT on 16 Dec in Asia/Jayapura — underlying UTC instant unchanged!
    const utcMs = Date.UTC(2026, 11, 15, 16, 30, 0);
    const wib = formatTimestampInTenantTimezone(utcMs, "Asia/Jakarta", "id-ID");
    const wit = formatTimestampInTenantTimezone(utcMs, "Asia/Jayapura", "id-ID");
    expect(wib).toContain("15");
    expect(wit).toContain("16");
    expect(wib).not.toBe(wit);

    // Date-only value MUST stay 15 Desember 2026 regardless of timezone!
    const dateOnly = formatDateOnlyPreservingSemantics("2026-12-15", "id-ID");
    expect(dateOnly).toBe("15 Desember 2026");
  });

  it("filters disabled blog and catalog/offering links from public navigation across 3 levels", () => {
    const menu: PublicNavItem[] = [
      { label: "Beranda", href: "/", openInNewTab: false, children: [] },
      { label: "Blog", href: "/blog", openInNewTab: false, children: [] },
      {
        label: "Penawaran",
        href: "/tentang",
        openInNewTab: false,
        children: [
          { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
          { label: "Paket Tur", href: "/tour/umrah-ramadan", openInNewTab: false, children: [] },
          { label: "Kontak", href: "/kontak", openInNewTab: false, children: [] },
        ],
      },
    ];

    expect(
      isPublicRouteEnabledBySettings("/blog/artikel-baru", {
        blogEnabled: false,
        catalogEnabled: true,
        enabledOfferingTypes: ["service"],
      }),
    ).toBe(false);

    const filtered = filterPublicNavigationForSettings(menu, {
      blogEnabled: false,
      catalogEnabled: true,
      enabledOfferingTypes: ["service"],
    });
    expect(filtered.map((i) => i.href)).toEqual(["/", "/tentang"]);
    expect(filtered[1]?.children.map((c) => c.href)).toEqual(["/layanan", "/kontak"]);

    const allCatalogOff = filterPublicNavigationForSettings(menu, {
      blogEnabled: true,
      catalogEnabled: false,
      enabledOfferingTypes: [],
    });
    expect(allCatalogOff.map((i) => i.href)).toEqual(["/", "/blog", "/tentang"]);
    expect(allCatalogOff[2]?.children.map((c) => c.href)).toEqual(["/kontak"]);
  });

  it("attaches _groupedSettings onto site_settings envelope without breaking SiteSettingsSnapshotSchema.strict()", () => {
    const ext = createDefaultGroupedSettingsExtension();
    const baseEnvelope = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "site_settings",
      data: {
        siteTitle: "Klinik Nusantara",
        tagline: "Sehat Bersama",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
        faviconMediaId: null,
        ogImageMediaId: null,
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        analyticsConfig: { ga4MeasurementId: "G-ABC1234567" },
        siteVisibility: "public",
      },
    });
    const enriched = attachGroupedSettingsExtension(baseEnvelope, {
      ...ext,
      reading: {
        ...ext.reading,
        itemsPerPage: 24,
        enabledOfferingTypes: ["service", "product"],
      },
    });
    expect(enriched).toBeTruthy();

    const parsed = JSON.parse(enriched!);
    expect(SiteSettingsSnapshotSchema.parse(parsed.data).activeThemeId).toBe("compro");
    const extracted = extractGroupedSettingsExtension(enriched);
    expect(extracted.reading.itemsPerPage).toBe(24);
    expect(extracted.reading.enabledOfferingTypes).toEqual(["service", "product"]);
  });

  it("enforces SSR Lifecycle & RBAC Gate BEFORE any TenantStore DB reads (zero tenantDb opens on denial)", async () => {
    const spyResolveTenantDb = vi.fn(() => ({}) as D1Database);
    const baseEnv = { APP_ENV: "production", PLATFORM_DOMAIN: "punyasitus.com", PLATFORM_DB: null, TENANT_STORE: null };

    // 1. purging / purged -> neutral 404, ZERO tenant DB reads
    for (const status of ["purging", "purged"] as const) {
      spyResolveTenantDb.mockClear();
      const res = await resolveGroupedSettingsServerContext(
        makeAstroMock({ tenantStatus: status }),
        baseEnv,
        { resolveTenantDb: spyResolveTenantDb },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(404);
        expect(res.response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(res.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      }
      expect(spyResolveTenantDb).not.toHaveBeenCalled();
    }

    // 2. suspended / recovery / operatorHold -> 302 redirect to /dashboard/[handle]/service-status, ZERO tenant DB reads
    for (const scenario of [
      { tenantStatus: "suspended" as const, operatorHold: false },
      { tenantStatus: "recovery" as const, operatorHold: false },
      { tenantStatus: "active" as const, operatorHold: true },
    ]) {
      spyResolveTenantDb.mockClear();
      const res = await resolveGroupedSettingsServerContext(
        makeAstroMock(scenario),
        baseEnv,
        { resolveTenantDb: spyResolveTenantDb },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(302);
        expect(res.response.headers.get("Location")).toBe("/dashboard/klinik-sehat/service-status");
        expect(res.response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(res.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      }
      expect(spyResolveTenantDb).not.toHaveBeenCalled();
    }

    // 3. Editor (missing settings:read) -> 403, ZERO tenant DB reads
    spyResolveTenantDb.mockClear();
    const editorRes = await resolveGroupedSettingsServerContext(
      makeAstroMock({ role: "editor", tenantStatus: "active" }),
      baseEnv,
      { resolveTenantDb: spyResolveTenantDb },
    );
    expect(editorRes.ok).toBe(false);
    if (!editorRes.ok) {
      expect(editorRes.response.status).toBe(403);
      expect(editorRes.response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(editorRes.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(spyResolveTenantDb).not.toHaveBeenCalled();

    // 4. Locked tenant -> allowed read-only (canWriteSettings: false, canPublishSettings: false)
    spyResolveTenantDb.mockClear();
    const astroLocked = makeAstroMock({ role: "owner", tenantStatus: "locked" });
    const lockedRes = await resolveGroupedSettingsServerContext(astroLocked, baseEnv, {
      resolveTenantDb: spyResolveTenantDb,
    });
    expect(lockedRes.ok).toBe(true);
    if (lockedRes.ok) {
      expect(lockedRes.ctx.permissions.isLocked).toBe(true);
      expect(lockedRes.ctx.permissions.canReadSettings).toBe(true);
      expect(lockedRes.ctx.permissions.canWriteSettings).toBe(false);
      expect(lockedRes.ctx.permissions.canPublishSettings).toBe(false);
    }
    expect(astroLocked.response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(astroLocked.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("keeps bundled 0005_site_settings_grouped migration descriptor byte-for-byte identical to SQL file", () => {
    const sqlPath = path.join(
      REPO_ROOT,
      "packages/db/migrations/tenant/0005_site_settings_grouped.sql",
    );
    expect(fs.existsSync(sqlPath)).toBe(true);
    const fileSql = fs.readFileSync(sqlPath, "utf8");
    expect(TENANT_0005_SITE_SETTINGS_GROUPED_SQL).toBe(fileSql);
    expect(TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION.version).toBe(5);
    expect(TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION.name).toBe("0005_site_settings_grouped");
    expect(TENANT_0005_SITE_SETTINGS_GROUPED_MIGRATION.sql).toBe(fileSql);
  });

  it("enforces zero request-time runtime DDL and zero Radix UI imports across TASK-040 source files", () => {
    const filesToCheck = [
      "packages/core/src/settings/index.ts",
      "packages/db/src/settings/index.ts",
      "apps/web/src/core/public-data.ts",
      "apps/web/src/core/settings.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/settings/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/settings/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/settings/[group].ts",
      "apps/web/src/pages/api/tenants/[tenantId]/settings/publish.ts",
      "apps/web/src/pages/dashboard/[handle]/settings/_GroupedSettingsWorkspace.tsx",
      "apps/web/src/pages/dashboard/[handle]/settings/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/general/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/business/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/reading/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/seo/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/privacy/index.astro",
    ];

    for (const rel of filesToCheck) {
      const fullPath = path.join(REPO_ROOT, rel);
      expect(fs.existsSync(fullPath), `Missing expected file ${rel}`).toBe(true);
      const src = fs.readFileSync(fullPath, "utf8");
      expect(src, `Runtime DDL forbidden in ${rel}`).not.toMatch(/\bCREATE\s+TABLE\b/i);
      expect(src, `ensure*Schema forbidden in ${rel}`).not.toMatch(/\bensure[A-Za-z]*Schema\b/);
      expect(src, `Radix UI forbidden in ${rel}`).not.toMatch(/@radix-ui\/|from\s+["']radix-ui["']/);
    }
  });
});
