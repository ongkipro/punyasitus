import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSED_SECTION_TYPES, PLATFORM_THEME_IDS } from "@punyasitus/core/theme/index";
import { buildSafeThemeStyleBlock, type TenantShellData } from "../../apps/web/src/core/public-data.ts";
import {
  auditCustomThemesStaticImports,
  auditCustomThemeSourceFiles,
  buildPublicThemeRouteShellContract,
  DEFAULT_FALLBACK_PLATFORM_THEME_ID,
  getRegisteredTheme,
  isRegisteredCustomThemeId,
  isRegisteredThemeId,
  listGrantedThemesForTenant,
  listRegisteredThemes,
  PUBLIC_THEME_ROUTE_KINDS,
  REGISTERED_CUSTOM_THEMES,
  REGISTERED_PLATFORM_THEMES,
  resolveTenantTheme,
  THEME_REGISTRY,
} from "../../apps/web/src/core/theme-registry.ts";
import {
  SAMPLE_AGENCY_THEME_ID,
  SAMPLE_AGENCY_THEME_MANIFEST,
} from "../../apps/web/src/themes/custom/sample-agency/theme.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CUSTOM_THEMES_DIR = path.join(REPO_ROOT, "apps/web/src/themes/custom");
const THEME_REGISTRY_FILE = path.join(REPO_ROOT, "apps/web/src/core/theme-registry.ts");

function makeSampleShell(overrides: Partial<TenantShellData> = {}): TenantShellData {
  const themeStyle = buildSafeThemeStyleBlock(null, "compro");
  return {
    isPreview: false,
    layoutMode: "standard",
    themeId: "compro",
    baseThemeId: "compro",
    themeStyle,
    site: {
      title: "PT Studio Nusantara",
      tagline: "Konsultan Sistem & Arsitektur Digital",
      locale: "id-ID",
      timezone: "Asia/Jakarta",
      blogEnabled: true,
      catalogEnabled: true,
      siteVisibility: "public",
      analyticsConfig: null,
    },
    business: {
      name: "PT Studio Nusantara",
      category: "Organization",
      description: "Pendampingan desain dan rekayasa digital untuk korporasi B2B.",
      address: "Jl. Gatot Subroto Kav. 21",
      city: "Jakarta Selatan",
      province: "DKI Jakarta",
      postalCode: "12930",
      mapsUrl: "https://maps.google.com/?q=-6.2297,106.8295",
      weekdayHours: "Senin–Jumat 09.00–17.30 WIB",
      holidayHours: "Sabtu–Minggu Tutup",
      phone: "6281234567890",
      whatsappE164: "6281234567890",
      email: "halo@studio-nusantara.id",
      socialLinks: [{ platform: "linkedin", url: "https://linkedin.com/company/studionusantara" }],
    },
    menus: {
      header: [
        { label: "Beranda", href: "/", openInNewTab: false, children: [] },
        { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
        { label: "Blog", href: "/blog", openInNewTab: false, children: [] },
      ],
      footer: [{ label: "Tentang Kami", href: "/tentang-kami", openInNewTab: false, children: [] }],
      mobile: [],
    },
    page: {
      slug: "beranda",
      title: "Beranda",
      isHomepage: true,
      layoutMode: "standard",
      sections: [],
    },
    revisions: {
      siteSettingsVersion: 1,
      businessProfileVersion: 1,
      themeConfigVersion: 1,
      pageVersion: 1,
    },
    ...overrides,
  };
}

describe("TASK-018: Explicit Build-Time Theme Registry", () => {
  it("registers all 6 platform themes plus explicitly imported sample custom theme", () => {
    for (const id of PLATFORM_THEME_IDS) {
      expect(REGISTERED_PLATFORM_THEMES[id]).toBeDefined();
      expect(REGISTERED_PLATFORM_THEMES[id].tier).toBe("included");
      expect(REGISTERED_PLATFORM_THEMES[id].isCustom).toBe(false);
      expect(isRegisteredThemeId(id)).toBe(true);
      expect(isRegisteredCustomThemeId(id)).toBe(false);
    }

    expect(REGISTERED_CUSTOM_THEMES[SAMPLE_AGENCY_THEME_ID]).toBeDefined();
    expect(isRegisteredThemeId(SAMPLE_AGENCY_THEME_ID)).toBe(true);
    expect(isRegisteredCustomThemeId(SAMPLE_AGENCY_THEME_ID)).toBe(true);

    const entry = getRegisteredTheme(SAMPLE_AGENCY_THEME_ID);
    expect(entry).not.toBeNull();
    expect(entry?.tier).toBe("custom");
    expect(entry?.isCustom).toBe(true);
    expect(entry?.basePlatformThemeId).toBe("compro");
    expect(entry?.supportedRoutes).toEqual(PUBLIC_THEME_ROUTE_KINDS);
    expect(entry?.supportedSectionTypes).toEqual(CLOSED_SECTION_TYPES);
    expect(entry?.agencyScope).toEqual({
      distribution: "private_client",
      ownerAgencySlug: "sample-agency",
    });

    expect(THEME_REGISTRY[SAMPLE_AGENCY_THEME_ID]).toBe(entry);
    expect(listRegisteredThemes().length).toBeGreaterThanOrEqual(PLATFORM_THEME_IDS.length + 1);
  });

  it("validates sample-agency presentation config and rejects hostile CSS tokens", () => {
    const valid = SAMPLE_AGENCY_THEME_MANIFEST.validatePresentationConfig({
      tokens: { primaryColor: "#14213d" },
    });
    expect(valid.themeId).toBe(SAMPLE_AGENCY_THEME_ID);
    expect(valid.tokens.primaryColor).toBe("#14213d");

    expect(() =>
      SAMPLE_AGENCY_THEME_MANIFEST.validatePresentationConfig({
        tokens: { primaryColor: "#112233; background: url(https://evil.test/x)" },
      }),
    ).toThrow();
  });

  it("uses zero dynamic import(), eval(), or remote URL imports inside theme-registry.ts", () => {
    const src = fs.readFileSync(THEME_REGISTRY_FILE, "utf8");
    // Strip comments and string literals so we verify actual executable code only
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
    expect(codeOnly).not.toMatch(/\bimport\s*\(/);
    expect(codeOnly).not.toMatch(/\beval\s*\(/);
    expect(codeOnly).not.toMatch(/new\s+Function\s*\(/);
    expect(src).toContain('from "../themes/custom/sample-agency/theme.ts"');
  });
});

describe("TASK-018: Entitlement Isolation, Agency Routing & Safe Fallback", () => {
  it("resolves built-in platform themes for any valid tenant without special grants", () => {
    for (const id of PLATFORM_THEME_IDS) {
      const res = resolveTenantTheme({
        tenantId: "01JTESTTENANTALPHA00000001",
        requestedThemeId: id,
      });
      expect(res.fallbackUsed).toBe(false);
      expect(res.isCustomTheme).toBe(false);
      expect(res.grantSource).toBe("platform_included");
      expect(res.resolvedTheme.id).toBe(id);
      expect(res.operatorAlertRequired).toBe(false);
    }
  });

  it("falls back safely to compro (or valid defaultPlatformThemeId) on unknown, malformed, or path-traversal IDs", () => {
    const hostileIds = [
      "custom-nonexistent",
      "../default/Layout.astro",
      "https://evil.example/theme.js",
      "file:///etc/passwd",
      "custom-../../secret",
      "",
      "   ",
      null,
      undefined,
      42,
    ];

    for (const badId of hostileIds) {
      const res = resolveTenantTheme({
        tenantId: "01JTESTTENANTALPHA00000001",
        requestedThemeId: badId,
      });
      expect(res.fallbackUsed).toBe(true);
      expect(res.isCustomTheme).toBe(false);
      expect(res.grantSource).toBe("fallback");
      expect(res.resolvedTheme.id).toBe(DEFAULT_FALLBACK_PLATFORM_THEME_ID);
    }

    const customDefaultFallback = resolveTenantTheme({
      tenantId: "01JTESTTENANTALPHA00000001",
      requestedThemeId: "custom-does-not-exist",
      defaultPlatformThemeId: "travel",
    });
    expect(customDefaultFallback.fallbackUsed).toBe(true);
    expect(customDefaultFallback.fallbackReason).toBe("UNREGISTERED_THEME_ID");
    expect(customDefaultFallback.operatorAlertRequired).toBe(true);
    expect(customDefaultFallback.resolvedTheme.id).toBe("travel");
  });

  it("enforces strict two-tenant entitlement isolation for custom themes", () => {
    const tenantA = "01JTESTTENANTALPHA00000001";
    const tenantB = "01JTESTTENANTBETA000000002";

    const tenantAGrantRecord = {
      tenantId: tenantA,
      themeId: SAMPLE_AGENCY_THEME_ID,
      active: true,
      grantedBy: "operator-01",
    };

    // Tenant A is entitled -> resolves custom-sample-agency
    const resA = resolveTenantTheme({
      tenantId: tenantA,
      tenantStatus: "active",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: [tenantAGrantRecord],
    });
    expect(resA.fallbackUsed).toBe(false);
    expect(resA.isCustomTheme).toBe(true);
    expect(resA.grantSource).toBe("tenant_grant");
    expect(resA.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);

    // Tenant B has NO grant -> falls back safely to compro
    const resBNoGrant = resolveTenantTheme({
      tenantId: tenantB,
      tenantStatus: "active",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: [],
    });
    expect(resBNoGrant.fallbackUsed).toBe(true);
    expect(resBNoGrant.fallbackReason).toBe("THEME_NOT_GRANTED");
    expect(resBNoGrant.resolvedTheme.id).toBe("compro");
    expect(resBNoGrant.operatorAlertRequired).toBe(true);

    // Tenant B passed Tenant A's grant record -> MUST BE REJECTED!
    const resBCrossTenant = resolveTenantTheme({
      tenantId: tenantB,
      tenantStatus: "active",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: [tenantAGrantRecord],
    });
    expect(resBCrossTenant.fallbackUsed).toBe(true);
    expect(resBCrossTenant.fallbackReason).toBe("THEME_NOT_GRANTED");
    expect(resBCrossTenant.resolvedTheme.id).toBe("compro");

    // Revoked / inactive grant is rejected
    const resARevoked = resolveTenantTheme({
      tenantId: tenantA,
      tenantStatus: "active",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: [{ ...tenantAGrantRecord, active: false }],
    });
    expect(resARevoked.fallbackUsed).toBe(true);
    expect(resARevoked.resolvedTheme.id).toBe("compro");

    // Trial tenant without grant receives explicit TRIAL_CUSTOM_THEME_BLOCKED reason
    const resTrial = resolveTenantTheme({
      tenantId: tenantB,
      tenantStatus: "trial",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      tenantGrants: [],
    });
    expect(resTrial.fallbackUsed).toBe(true);
    expect(resTrial.fallbackReason).toBe("TRIAL_CUSTOM_THEME_BLOCKED");
    expect(resTrial.resolvedTheme.id).toBe("compro");

    // Listing granted themes isolates Tenant A vs Tenant B
    const grantedA = listGrantedThemesForTenant({
      tenantId: tenantA,
      tenantGrants: [tenantAGrantRecord],
    }).map((t) => t.id);
    const grantedB = listGrantedThemesForTenant({
      tenantId: tenantB,
      tenantGrants: [tenantAGrantRecord],
    }).map((t) => t.id);
    expect(grantedA).toContain(SAMPLE_AGENCY_THEME_ID);
    expect(grantedB).not.toContain(SAMPLE_AGENCY_THEME_ID);
    expect(grantedB).toEqual([...PLATFORM_THEME_IDS]);
  });

  it("enforces agency / private_client routing strictly by matching agencyId & ownerAgencySlug", () => {
    const agencyGrant = {
      agencyId: "agency-001",
      agencySlug: "sample-agency",
      themeId: SAMPLE_AGENCY_THEME_ID,
      active: true,
    };

    // Matching agency client -> granted via agency_grant
    const clientA = resolveTenantTheme({
      tenantId: "01JAGENCYCLIENTA0000000001",
      agencyId: "agency-001",
      agencySlug: "sample-agency",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      agencyGrants: [agencyGrant],
    });
    expect(clientA.fallbackUsed).toBe(false);
    expect(clientA.grantSource).toBe("agency_grant");
    expect(clientA.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);

    // Different agency -> rejected & safe fallback
    const clientOtherAgency = resolveTenantTheme({
      tenantId: "01JAGENCYCLIENTB0000000002",
      agencyId: "agency-999",
      agencySlug: "other-agency",
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      agencyGrants: [agencyGrant],
    });
    expect(clientOtherAgency.fallbackUsed).toBe(true);
    expect(clientOtherAgency.resolvedTheme.id).toBe("compro");

    // Non-agency direct tenant passed agency grant -> rejected
    const directTenant = resolveTenantTheme({
      tenantId: "01JDIRECTTENANT00000000003",
      agencyId: null,
      requestedThemeId: SAMPLE_AGENCY_THEME_ID,
      agencyGrants: [agencyGrant],
    });
    expect(directTenant.fallbackUsed).toBe(true);
    expect(directTenant.resolvedTheme.id).toBe("compro");
  });
});

describe("TASK-018: Shared Security, SEO, Schema.org & Consent Shell Contract", () => {
  const verifiedTenant = {
    tenantHandle: "studio-nusantara",
    tenantStatus: "active" as const,
  };

  it("wraps all 7 public routes with verified canonical/robots, JSON-LD, safe CSS tokens, and consent", () => {
    const pathsByRoute: Record<(typeof PUBLIC_THEME_ROUTE_KINDS)[number], string> = {
      home: "/",
      page: "/tentang-kami",
      blog_index: "/blog",
      blog_post: "/blog/arsitektur-multi-tenant",
      catalog_index: "/layanan",
      catalog_detail: "/layanan/audit-sistem-digital",
      not_found: "/halaman-tidak-ada",
    };

    for (const routeKind of PUBLIC_THEME_ROUTE_KINDS) {
      const contract = buildPublicThemeRouteShellContract({
        routeKind,
        pathname: pathsByRoute[routeKind],
        entitlement: {
          tenantId: "01JTESTTENANTALPHA00000001",
          tenantStatus: "active",
          requestedThemeId: SAMPLE_AGENCY_THEME_ID,
          tenantGrants: [{ tenantId: "01JTESTTENANTALPHA00000001", themeId: SAMPLE_AGENCY_THEME_ID }],
        },
        shell: makeSampleShell(),
        seo: {
          surface: "public_tenant",
          tenant: verifiedTenant,
          resourceState: routeKind === "not_found" ? "missing" : "published",
          publishedItemCount: 3,
        },
        pageTitle: routeKind === "home" ? null : `Judul ${routeKind}`,
      });

      expect(contract.resolution.resolvedTheme.id).toBe(SAMPLE_AGENCY_THEME_ID);
      expect(contract.themeStyle.tokens.primaryColor).toBe("#1c2d4a");
      expect(contract.consent.required).toBe(true);

      if (routeKind === "not_found") {
        expect(contract.seoMetadata.seoDecision.noindex).toBe(true);
        expect(contract.seoMetadata.canonical).toBeNull();
        expect(contract.seoMetadata.og.url).toBeNull();
        expect(contract.schemaResult.emitted).toBe(false);
        expect(contract.schemaGraph).toBeNull();
      } else {
        expect(contract.seoMetadata.seoDecision.noindex).toBe(false);
        expect(contract.seoMetadata.canonical).toBe(
          `https://studio-nusantara.situsku.click${pathsByRoute[routeKind]}`,
        );
        expect(contract.schemaResult.emitted).toBe(true);
        expect(contract.schemaGraph?.["@context"]).toBe("https://schema.org");
      }
    }
  });

  it("prevents custom themes from bypassing noindex on preview/trial and neutralizes hostile CSS tokens", () => {
    const previewContract = buildPublicThemeRouteShellContract({
      routeKind: "home",
      pathname: "/",
      entitlement: {
        tenantId: "01JTESTTENANTALPHA00000001",
        tenantStatus: "active",
        requestedThemeId: SAMPLE_AGENCY_THEME_ID,
        tenantGrants: [{ tenantId: "01JTESTTENANTALPHA00000001", themeId: SAMPLE_AGENCY_THEME_ID }],
      },
      shell: makeSampleShell({ isPreview: true }),
      themeTokensOverride: {
        primaryColor: "#112233}</style><script>window.__xss=1</script>",
      },
      seo: {
        surface: "preview",
        tenant: verifiedTenant,
      },
    });

    expect(previewContract.seoMetadata.seoDecision.noindex).toBe(true);
    expect(previewContract.seoMetadata.canonical).toBeNull();
    expect(previewContract.schemaGraph).toBeNull();
    expect(previewContract.themeStyle.css).not.toContain("__xss");
    expect(previewContract.themeStyle.css).not.toContain("</style>");
    expect(previewContract.themeStyle.css).not.toContain("<script>");
  });
});

describe("TASK-018: Static Import Guard (auditCustomThemesStaticImports)", () => {
  it("passes cleanly on the real apps/web/src/themes/custom/** directory with zero violations", () => {
    const audit = auditCustomThemesStaticImports(CUSTOM_THEMES_DIR);
    expect(audit.scannedFiles.length).toBeGreaterThanOrEqual(10);
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);

    // Also test zero-argument default path resolution
    const defaultAudit = auditCustomThemesStaticImports();
    expect(defaultAudit.ok).toBe(true);
    expect(defaultAudit.scannedFiles.length).toBe(audit.scannedFiles.length);
  });

  it("rejects every forbidden DB, auth, Worker, Node, env, Radix, dynamic import, and competing SEO vector", () => {
    const radixImport = `import * as Dialog from "${["@", "radix", "-ui/react-dialog"].join("")}";`;
    const radixProp = `<button ${["as", "Child"].join("")}={true}>Open</button>`;

    const cases: readonly { readonly name: string; readonly code: string; readonly expectedRule: string }[] = [
      {
        name: "@punyasitus/db",
        code: `import { getPublishedResource } from "@punyasitus/db/publication/index";`,
        expectedRule: "FORBIDDEN_DB_IMPORT",
      },
      {
        name: "@punyasitus/auth",
        code: `import { verifySession } from "@punyasitus/auth";`,
        expectedRule: "FORBIDDEN_AUTH_IMPORT",
      },
      {
        name: "cloudflare:workers",
        code: `import { env } from "cloudflare:workers";`,
        expectedRule: "FORBIDDEN_CLOUDFLARE_WORKERS_IMPORT",
      },
      {
        name: "node:fs",
        code: `import fs from "node:fs";`,
        expectedRule: "FORBIDDEN_NODE_BUILTIN_IMPORT",
      },
      {
        name: "drizzle-orm",
        code: `import { eq } from "drizzle-orm";`,
        expectedRule: "FORBIDDEN_DRIZZLE_IMPORT",
      },
      {
        name: "PLATFORM_DB reference",
        code: `const rows = await locals.runtime.env.PLATFORM_DB.prepare("SELECT 1").all();`,
        expectedRule: "FORBIDDEN_PLATFORM_BINDING_REFERENCE",
      },
      {
        name: "TENANT_STORE reference",
        code: `const stub = env.TENANT_STORE.idFromName("x");`,
        expectedRule: "FORBIDDEN_PLATFORM_BINDING_REFERENCE",
      },
      {
        name: "process.env",
        code: `const secret = process.env.AUTH_SECRET;`,
        expectedRule: "FORBIDDEN_PROCESS_ENV_REFERENCE",
      },
      {
        name: "Radix import",
        code: radixImport,
        expectedRule: "FORBIDDEN_RADIX_IMPORT",
      },
      {
        name: "Radix composition prop",
        code: radixProp,
        expectedRule: "FORBIDDEN_RADIX_PROP",
      },
      {
        name: "Base UI / admin UI import",
        code: `import { Button } from "@/components/ui/button";`,
        expectedRule: "FORBIDDEN_ADMIN_UI_IMPORT",
      },
      {
        name: "dynamic import(userInput)",
        code: `const mod = await import(themePath);`,
        expectedRule: "FORBIDDEN_DYNAMIC_IMPORT",
      },
      {
        name: "eval()",
        code: `const fn = eval("1 + 1");`,
        expectedRule: "FORBIDDEN_DYNAMIC_EVAL",
      },
      {
        name: "remote URL import",
        code: `import evil from "https://evil.example/theme.js";`,
        expectedRule: "FORBIDDEN_REMOTE_MODULE_IMPORT",
      },
      {
        name: "competing canonical tag",
        code: `<link rel="canonical" href="https://hijack.example/" />`,
        expectedRule: "FORBIDDEN_COMPETING_SEO_OR_TRACKER_TAG",
      },
    ];

    for (const tc of cases) {
      const result = auditCustomThemeSourceFiles([
        { filePath: `rogue-theme/${tc.name}.astro`, content: tc.code },
      ]);
      expect(result.ok, `Expected guard to fail for ${tc.name}`).toBe(false);
      expect(
        result.violations.some((v) => v.rule === tc.expectedRule),
        `Expected rule ${tc.expectedRule} for ${tc.name}, got ${JSON.stringify(result.violations)}`,
      ).toBe(true);
    }
  });

  it("scans a real temporary directory on disk and ignores comments while preserving https:// strings", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-t018-guard-"));
    try {
      const cleanDir = path.join(tmpDir, "clean-theme");
      const badDir = path.join(tmpDir, "bad-theme");
      fs.mkdirSync(cleanDir, { recursive: true });
      fs.mkdirSync(badDir, { recursive: true });

      fs.writeFileSync(
        path.join(cleanDir, "Layout.astro"),
        `---
// Documentation comment: never import @punyasitus/db or process.env here
const externalLink = "https://maps.google.com/?q=-6.2,106.8";
---
<a href={externalLink}>Lihat Peta</a>
`,
        "utf8",
      );

      const cleanAudit = auditCustomThemesStaticImports(cleanDir);
      expect(cleanAudit.ok).toBe(true);
      expect(cleanAudit.violations).toEqual([]);

      fs.writeFileSync(
        path.join(badDir, "Leak.ts"),
        `import { env } from "cloudflare:workers";\nexport const leak = () => process.env.SECRET;\n`,
        "utf8",
      );

      const badAudit = auditCustomThemesStaticImports(tmpDir);
      expect(badAudit.ok).toBe(false);
      expect(badAudit.violations.map((v) => v.rule)).toEqual(
        expect.arrayContaining([
          "FORBIDDEN_CLOUDFLARE_WORKERS_IMPORT",
          "FORBIDDEN_PROCESS_ENV_REFERENCE",
        ]),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
