import fs from "node:fs";
import path from "node:path";
import {
  BUSINESS_CATEGORY_CATALOG,
  CLOSED_BUSINESS_CATEGORY_KEYS,
  formatTruthfulCredentialItems,
  getPromptedCredentialsForCategory,
  isDeprecatedProfessionalService,
  mapBusinessCategoryToSchemaOrg,
  resolveEffectiveBrandAssets,
  shouldAutoDeriveBrandAssetSlot,
  validateClosedBusinessCategoryStrict,
  validateClosedDays,
  validateIndonesianCredentials,
  validatePrivacyContact,
} from "@punyasitus/core/business-profile/index";
import {
  ALLOWED_BUSINESS_SCHEMA_TYPES,
  generateSchemaGraph,
  resolveBusinessSchemaType,
} from "@punyasitus/core/schema-generator";
import {
  BUSINESS_PROFILE_STRUCTURED_MIGRATION,
  BUSINESS_PROFILE_STRUCTURED_MIGRATION_SQL,
} from "@punyasitus/db/business-profile/migrations";
import { describe, expect, it } from "vitest";
import {
  evaluateIdentitySettingsSsrGate,
  serviceUnavailableIdentitySsrResponse,
} from "../../apps/web/src/pages/dashboard/[handle]/settings/identity/_ssr-gate.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("TASK-091 unit — Closed business_category -> Schema.org subtype mapping & zero ProfessionalService", () => {
  it("maps every closed business_category to a valid current Google-supported Schema.org subtype with ZERO ProfessionalService", () => {
    expect(CLOSED_BUSINESS_CATEGORY_KEYS.length).toBeGreaterThanOrEqual(20);
    expect(ALLOWED_BUSINESS_SCHEMA_TYPES).not.toContain("ProfessionalService");

    for (const def of BUSINESS_CATEGORY_CATALOG) {
      expect(ALLOWED_BUSINESS_SCHEMA_TYPES).toContain(def.schemaType);
      expect(def.schemaType).not.toBe("ProfessionalService");
      expect(mapBusinessCategoryToSchemaOrg(def.key)).toBe(def.schemaType);
      expect(resolveBusinessSchemaType(def.key)).toBe(def.schemaType);

      const strict = validateClosedBusinessCategoryStrict(def.key);
      expect(strict.ok, `Expected ${def.key} to pass strict validation`).toBe(true);

      // Verify end-to-end Schema.org JSON-LD graph emits valid subtype and zero ProfessionalService
      const result = generateSchemaGraph({
        seo: {
          surface: "public_tenant",
          routeKind: "homepage",
          pathname: "/",
          tenant: {
            tenantHandle: "demo-tenant",
            tenantStatus: "active",
            primaryHost: "demo.example.id",
            primaryHostKind: "custom",
            primaryHostStatus: "active",
            primaryHostSslStatus: "active",
            primaryHostVerified: true,
          },
          siteVisibility: "public",
          resourceState: "published",
        },
        tenantId: "01JT091TENANT0000000000001",
        siteName: "Demo Bisnis",
        business: {
          businessName: "Demo Bisnis Nusantara",
          legalName: "PT Demo Bisnis Nusantara",
          businessCategory: def.key,
          whatsappE164: "6281234567890",
          privacyContact: "privasi@demo.example.id",
        },
      });

      expect(result.emitted).toBe(true);
      expect(result.jsonLd).not.toBeNull();
      expect(result.jsonLd).not.toContain("ProfessionalService");

      const orgNode = result.nodes.find((n) => n["@id"]?.endsWith("/#organization"));
      expect(orgNode?.["@type"]).toBe(def.schemaType);
      expect(orgNode?.legalName).toBe("PT Demo Bisnis Nusantara");
    }
  });

  it("rejects deprecated ProfessionalService & unknown junk strictly and falls back to LocalBusiness in schema generator", () => {
    const deprecatedVariants = [
      "ProfessionalService",
      "professionalservice",
      "professional_service",
      "Professional Service",
      "professional-service",
    ];
    for (const raw of deprecatedVariants) {
      expect(isDeprecatedProfessionalService(raw)).toBe(true);
      expect(mapBusinessCategoryToSchemaOrg(raw)).toBe("LocalBusiness");
      expect(resolveBusinessSchemaType(raw)).toBe("LocalBusiness");

      const strict = validateClosedBusinessCategoryStrict(raw);
      expect(strict.ok).toBe(false);
      if (!strict.ok) {
        expect(strict.issue.code).toBe("INVALID_BUSINESS_CATEGORY");
      }
    }

    const unknownStrict = validateClosedBusinessCategoryStrict("RandomArbitraryType");
    expect(unknownStrict.ok).toBe(false);
    expect(mapBusinessCategoryToSchemaOrg("RandomArbitraryType")).toBe("LocalBusiness");
    expect(mapBusinessCategoryToSchemaOrg(null)).toBe("LocalBusiness");
  });

  it("emits ProfilePage + Person for personal_brand & sales_executive with affiliated dealership worksFor", () => {
    const salesSchema = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: "budi-sales",
          tenantStatus: "active",
          primaryHost: "budi-sales.example.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        },
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Budi Santoso — Konsultan Mobil Resmi",
      business: {
        businessName: "Budi Santoso",
        businessCategory: "sales_executive",
        personRoleTitle: "Senior Sales Executive",
        affiliatedOrgName: "Auto2000 Sudirman",
        whatsappE164: "6281234567890",
      },
    });

    expect(salesSchema.emitted).toBe(true);
    expect(salesSchema.jsonLd).not.toContain("ProfessionalService");
    const pageNode = salesSchema.nodes.find((n) => n["@id"]?.endsWith("#webpage"));
    const personNode = salesSchema.nodes.find((n) => n["@type"] === "Person");
    expect(pageNode?.["@type"]).toBe("ProfilePage");
    expect(personNode?.name).toBe("Budi Santoso");
    expect(personNode?.jobTitle).toBe("Senior Sales Executive");
    expect(personNode?.worksFor).toEqual({
      "@type": "Organization",
      name: "Auto2000 Sudirman",
    });
  });
});

describe("TASK-091 unit — Optional Indonesian licence credentials (truthful, zero fabricated badges)", () => {
  it("validates NIB, SK Kemenag PPIU/PIHK, SIP/STR, Halal BPJPH, and P-IRT truthfully without fabricated trust badges", () => {
    const valid = validateIndonesianCredentials({
      nib: "1234-5678-90123",
      skKemenagPpiu: "U.123 Tahun 2024",
      asitaIata: "ASITA 0123/DPP/2024",
      sipStr: "SIP 446/1234/Dinkes/2025",
      halalBpjh: "id 3111-0000-1234-50123",
      pirt: "P-IRT 2063171010123-28",
      isoSniTkdn: "ISO 9001:2015",
    });

    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(valid.value.nib).toBe("1234567890123");
    expect(valid.value.halalBpjh).toBe("ID31110000123450123");
    expect(valid.value.skKemenagPpiu).toBe("U.123 Tahun 2024");
    expect(valid.value.sipStr).toBe("SIP 446/1234/Dinkes/2025");
    expect(valid.value.pirt).toBe("P-IRT 2063171010123-28");

    const items = formatTruthfulCredentialItems(valid.value, "travel_umrah_agency");
    expect(items.length).toBe(7);
    // Travel category orders SK Kemenag & ASITA first
    expect(items[0]?.key).toBe("skKemenagPpiu");
    for (const item of items) {
      expect(item.selfDeclared).toBe(true);
      expect(item.verifiedByPlatform).toBe(false);
    }

    // Verify Schema.org emits truthful PropertyValue identifiers and zero fake ratings/awards
    const graphRes = generateSchemaGraph({
      seo: {
        surface: "public_tenant",
        routeKind: "homepage",
        pathname: "/",
        tenant: {
          tenantHandle: "rahmatan-travel",
          tenantStatus: "active",
          primaryHost: "rahmatan.example.id",
          primaryHostKind: "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
        },
        siteVisibility: "public",
        resourceState: "published",
      },
      siteName: "Travel Rahmatan",
      business: {
        businessName: "Travel Rahmatan",
        businessCategory: "travel_umrah_agency",
        credentials: {
          nib: valid.value.nib,
          skKemenagPpiu: valid.value.skKemenagPpiu,
        },
      },
    });

    expect(graphRes.emitted).toBe(true);
    expect(graphRes.jsonLd).toContain("SK Kemenag PPIU/PIHK");
    expect(graphRes.jsonLd).toContain("U.123 Tahun 2024");
    expect(graphRes.jsonLd).toContain("1234567890123");
    expect(graphRes.jsonLd).not.toContain("AggregateRating");
    expect(graphRes.jsonLd).not.toContain("award");
    expect(graphRes.jsonLd).not.toContain("ProfessionalService");
  });

  it("rejects malformed NIB, Halal, P-IRT, HTML payloads, and unknown credential keys", () => {
    const badNib = validateIndonesianCredentials({ nib: "12345" });
    expect(badNib.ok).toBe(false);
    if (!badNib.ok) expect(badNib.issues[0]?.code).toBe("INVALID_NIB_FORMAT");

    const badHalal = validateIndonesianCredentials({ halalBpjh: "HALAL-FAKE" });
    expect(badHalal.ok).toBe(false);
    if (!badHalal.ok) expect(badHalal.issues[0]?.code).toBe("INVALID_HALAL_FORMAT");

    const badPirt = validateIndonesianCredentials({ pirt: "P-IRT 123" });
    expect(badPirt.ok).toBe(false);
    if (!badPirt.ok) expect(badPirt.issues[0]?.code).toBe("INVALID_PIRT_FORMAT");

    const xssCred = validateIndonesianCredentials({
      skKemenagPpiu: "<script>alert(1)</script> 2024",
    });
    expect(xssCred.ok).toBe(false);

    const unknownKey = validateIndonesianCredentials({ fakeTrustBadge: "Verified #1" });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.issues[0]?.code).toBe("UNKNOWN_FIELD");
  });

  it("prompts contextual credentials per selected category", () => {
    expect(getPromptedCredentialsForCategory("travel_umrah_agency").map((c) => c.key)).toEqual([
      "skKemenagPpiu",
      "asitaIata",
      "nib",
    ]);
    expect(getPromptedCredentialsForCategory("medical_clinic").map((c) => c.key)).toEqual([
      "sipStr",
      "nib",
    ]);
    expect(getPromptedCredentialsForCategory("restaurant").map((c) => c.key)).toEqual([
      "halalBpjh",
      "pirt",
      "nib",
    ]);
  });

  it("validates privacyContact and closedDays strictly", () => {
    expect(validatePrivacyContact("Privasi@Bisnis.ID")).toEqual({
      ok: true,
      value: "privasi@bisnis.id",
    });
    expect(validatePrivacyContact("0812-3456-7890")).toEqual({
      ok: true,
      value: "6281234567890",
    });
    expect(validatePrivacyContact("https://bisnis.id/privasi")).toEqual({
      ok: true,
      value: "https://bisnis.id/privasi",
    });
    expect(validatePrivacyContact("javascript:alert(1)").ok).toBe(false);
    expect(validatePrivacyContact("http://bisnis.id/privasi").ok).toBe(false);
    expect(validatePrivacyContact("https://127.0.0.1/privasi").ok).toBe(false);

    expect(validateClosedDays(["sunday", "friday", "sunday"])).toEqual({
      ok: true,
      value: ["friday", "sunday"],
    });
    expect(validateClosedDays(["funday"]).ok).toBe(false);
  });
});

describe("TASK-091 unit — Auto-derived brand assets policy (never overwrites explicit tenant overrides)", () => {
  it("uses auto-derived logo assets only when explicit overrides are unset and preserves explicit overrides", () => {
    expect(shouldAutoDeriveBrandAssetSlot(null)).toBe(true);
    expect(shouldAutoDeriveBrandAssetSlot(undefined)).toBe(true);
    expect(shouldAutoDeriveBrandAssetSlot(42)).toBe(false);

    const derivedFav32 = {
      key: "t/01JTEST/media/10/logo-favicon-32.webp",
      width: 32,
      height: 32,
      bytes: 1200,
      mimeType: "image/webp" as const,
      sourceLogoMediaId: 10,
      derivedAt: "2026-11-23T06:00:00.000Z",
    };
    const derivedApple180 = {
      key: "t/01JTEST/media/10/logo-apple-touch-180.webp",
      width: 180,
      height: 180,
      bytes: 4800,
      mimeType: "image/webp" as const,
      sourceLogoMediaId: 10,
      derivedAt: "2026-11-23T06:00:00.000Z",
    };
    const derivedOg = {
      key: "t/01JTEST/media/10/logo-brand-og-1200x630.webp",
      width: 1200,
      height: 630,
      bytes: 85_000,
      mimeType: "image/webp" as const,
      sourceLogoMediaId: 10,
      derivedAt: "2026-11-23T06:00:00.000Z",
    };

    const autoOnly = resolveEffectiveBrandAssets({
      sourceLogoMediaId: 10,
      faviconOverrideMediaId: null,
      ogImageOverrideMediaId: null,
      derivedFavicon32: derivedFav32,
      derivedAppleTouch180: derivedApple180,
      derivedOg1200x630: derivedOg,
    });
    expect(autoOnly.faviconSource).toBe("auto_derived_from_logo");
    expect(autoOnly.ogImageSource).toBe("auto_derived_from_logo");
    expect(autoOnly.effectiveDerivedFavicon32?.width).toBe(32);
    expect(autoOnly.effectiveDerivedAppleTouch180?.width).toBe(180);
    expect(autoOnly.effectiveDerivedOg1200x630?.width).toBe(1200);
    expect(autoOnly.effectiveDerivedOg1200x630?.height).toBe(630);
    expect(autoOnly.effectiveDerivedOg1200x630?.bytes).toBeLessThanOrEqual(307_200);

    const withFavOverride = resolveEffectiveBrandAssets({
      sourceLogoMediaId: 10,
      faviconOverrideMediaId: 99,
      ogImageOverrideMediaId: null,
      derivedFavicon32: derivedFav32,
      derivedAppleTouch180: derivedApple180,
      derivedOg1200x630: derivedOg,
    });
    expect(withFavOverride.faviconSource).toBe("explicit_override");
    expect(withFavOverride.effectiveFaviconOverrideMediaId).toBe(99);
    expect(withFavOverride.effectiveDerivedFavicon32).toBeNull();
    expect(withFavOverride.ogImageSource).toBe("auto_derived_from_logo");
  });
});

describe("TASK-091 unit — SSR Lifecycle & RBAC Gate BEFORE any TenantStore DB reads", () => {
  const baseInput = {
    rawHandle: "alpha-studio",
    surface: "app" as const,
    isLocalLoopback: false,
    isLocalEnv: false,
    authUser: { id: "user_1", name: "Owner" },
    authorized: {
      tenantId: "01JT091TENANT0000000000001",
      handle: "alpha-studio",
      role: "owner" as const,
      tenantStatus: "active" as const,
    },
    operatorHold: false,
  };

  it("returns neutral 404 for purging/purged tenants, 302 service-status for suspended/recovery/operatorHold, 403 for editor, and read-only for locked", () => {
    for (const status of ["purging", "purged"] as const) {
      const res = evaluateIdentitySettingsSsrGate({
        ...baseInput,
        authorized: { ...baseInput.authorized, tenantStatus: status },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(404);
        expect(res.response.headers.get("cache-control")).toBe("private, no-store");
        expect(res.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    }

    for (const status of ["suspended", "recovery"] as const) {
      const res = evaluateIdentitySettingsSsrGate({
        ...baseInput,
        authorized: { ...baseInput.authorized, tenantStatus: status },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(302);
        expect(res.response.headers.get("location")).toBe("/dashboard/alpha-studio/service-status");
        expect(res.response.headers.get("cache-control")).toBe("private, no-store");
        expect(res.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    }

    const holdRes = evaluateIdentitySettingsSsrGate({
      ...baseInput,
      operatorHold: true,
    });
    expect(holdRes.ok).toBe(false);
    if (!holdRes.ok) {
      expect(holdRes.status).toBe(302);
      expect(holdRes.response.headers.get("location")).toBe("/dashboard/alpha-studio/service-status");
    }

    const editorRes = evaluateIdentitySettingsSsrGate({
      ...baseInput,
      authorized: { ...baseInput.authorized, role: "editor" },
    });
    expect(editorRes.ok).toBe(false);
    if (!editorRes.ok) {
      expect(editorRes.status).toBe(403);
      expect(editorRes.response.headers.get("cache-control")).toBe("private, no-store");
      expect(editorRes.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }

    const lockedRes = evaluateIdentitySettingsSsrGate({
      ...baseInput,
      authorized: { ...baseInput.authorized, tenantStatus: "locked" },
    });
    expect(lockedRes).toEqual({
      ok: true,
      readOnly: true,
      isLocked: true,
      canWriteSettings: false,
    });

    const activeOwner = evaluateIdentitySettingsSsrGate(baseInput);
    expect(activeOwner).toEqual({
      ok: true,
      readOnly: false,
      isLocked: false,
      canWriteSettings: true,
    });

    // Fail-closed 503 response when PLATFORM_DB operator_hold check fails
    const failClosed = serviceUnavailableIdentitySsrResponse();
    expect(failClosed.status).toBe(503);
    expect(failClosed.headers.get("cache-control")).toBe("private, no-store");
    expect(failClosed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(failClosed.headers.get("retry-after")).toBe("30");
  });
});

describe("TASK-091 unit — Migration byte-for-byte parity, zero runtime DDL, and base-nova guardrails", () => {
  it("matches packages/db/migrations/tenant/0011_business_profile_structured.sql byte-for-byte and executes zero request-time DDL", () => {
    const sqlOnDisk = fs.readFileSync(
      path.join(repoRoot, "packages/db/migrations/tenant/0011_business_profile_structured.sql"),
      "utf8",
    );
    expect(BUSINESS_PROFILE_STRUCTURED_MIGRATION.version).toBe(11);
    expect(BUSINESS_PROFILE_STRUCTURED_MIGRATION.name).toBe("0011_business_profile_structured");
    expect(BUSINESS_PROFILE_STRUCTURED_MIGRATION_SQL).toBe(sqlOnDisk);

    const runtimeFiles = [
      "packages/db/src/business-profile/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/identity/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/identity/business-profile/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/identity/business-profile/publish.ts",
      "apps/web/src/pages/dashboard/[handle]/settings/identity/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/identity/_ssr-gate.ts",
      "apps/web/src/pages/dashboard/[handle]/settings/identity/_IdentitySettingsClient.tsx",
    ];

    for (const rel of runtimeFiles) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      expect(src, `${rel} must NOT execute runtime CREATE TABLE`).not.toMatch(/\bCREATE\s+TABLE\b/i);
      expect(src, `${rel} must NOT call ensure*Schema`).not.toMatch(/\bensure[A-Za-z0-9_]*Schema\b/);
    }

    const uiSrc = fs.readFileSync(
      path.join(
        repoRoot,
        "apps/web/src/pages/dashboard/[handle]/settings/identity/_IdentitySettingsClient.tsx",
      ),
      "utf8",
    );
    expect(uiSrc).not.toMatch(/@radix-ui\//);
    expect(uiSrc).not.toMatch(/\basChild\b/);
  });
});
