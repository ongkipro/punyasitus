import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
} from "@punyasitus/db/platform";
import { publishResourceAtomically, saveDraftResource } from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadPublishedTenantShellData,
  PLATFORM_THEME_PRESETS,
} from "../../apps/web/src/core/public-data.ts";

const TENANT_A = {
  id: "01JT012TENANTA000000000001",
  orgId: "org_t012_alpha",
  handle: "t012-alpha",
  name: "T012 Nusantara Arsitek",
  host: "t012-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT012TENANTB000000000002",
  orgId: "org_t012_beta",
  handle: "t012-beta",
  name: "T012 Kedai Kopi Senja",
  host: "t012-beta.situsku.click",
} as const;

async function seedTenantDo(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly host: string;
}): Promise<D1Database> {
  const now = new Date();
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  await pDb
    .insert(organizations)
    .values({
      id: spec.orgId,
      name: spec.name,
      slug: spec.handle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenants)
    .values({
      id: spec.id,
      organizationId: spec.orgId,
      handle: spec.handle,
      name: spec.name,
      status: "active",
      cacheVersion: 1,
      schemaVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(tenantHosts)
    .values({
      host: spec.host,
      tenantId: spec.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(ns, spec.id);
  const mig = await orchestrateTenantMigration(env.PLATFORM_DB, stub, spec.id, TENANT_MIGRATIONS);
  expect(mig.httpStatus).toBe(200);
  return createTenantDb(stub);
}

describe("TASK-012: Published Tenant Shell Data Loader & Isolation on workerd", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    [tenantDbA, tenantDbB] = await Promise.all([
      seedTenantDo(TENANT_A),
      seedTenantDo(TENANT_B),
    ]);
  });

  it("loads ONLY published snapshots from TenantStore and never leaks draft edits", async () => {
    const t0 = 1_800_100_000_000;

    // Seed initial unpublished rows in Tenant A
    await tenantDbA.batch([
      tenantDbA
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, version, updated_at)
           VALUES (1, 'UNPUBLISHED INITIAL TITLE', 'Draft Tagline', 'sales', 1, ?)`,
        )
        .bind(t0),
      tenantDbA
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, description, city, version, updated_at)
           VALUES (1, 'UNPUBLISHED CORP', 'LocalBusiness', 'Deskripsi draf', 'Bandung', 1, ?)`,
        )
        .bind(t0),
      tenantDbA
        .prepare(
          `INSERT INTO theme_configs (theme_id, tokens_json, variants_json, version, updated_at)
           VALUES ('sales', ?, ?, 1, ?)`,
        )
        .bind(
          JSON.stringify({ primaryColor: "#7c2d12", secondaryColor: "#0f766e" }),
          JSON.stringify({ styleVariant: "default", headerVariant: "sticky-cta" }),
          t0,
        ),
      tenantDbA
        .prepare(
          `INSERT INTO menus (id, location, items_json, version, created_at, updated_at)
           VALUES (1, 'header', ?, 1, ?, ?)`,
        )
        .bind(
          JSON.stringify([{ label: "Draft Menu Item", href: "/draft", openInNewTab: false, children: [] }]),
          t0,
          t0,
        ),
      tenantDbA
        .prepare(
          `INSERT INTO menus (id, location, items_json, version, created_at, updated_at)
           VALUES (2, 'footer', ?, 1, ?, ?)`,
        )
        .bind(
          JSON.stringify([{ label: "Tentang", href: "/tentang", openInNewTab: false, children: [] }]),
          t0,
          t0,
        ),
      tenantDbA
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
           VALUES (1, 'beranda', 'DRAFT HOME ONLY', 1, '[]', 'draft', 1, ?, ?)`,
        )
        .bind(t0, t0),
    ]);

    // 1. Before publish: ZERO draft values may leak through loadPublishedTenantShellData
    const beforePublish = await loadPublishedTenantShellData(tenantDbA, {
      fallbackSiteTitle: "Fallback Aman",
    });
    expect(beforePublish.site.title).toBe("Fallback Aman");
    expect(beforePublish.business.name).toBe("Fallback Aman");
    expect(beforePublish.menus.header).toEqual([]);
    expect(beforePublish.menus.footer).toEqual([]);
    expect(beforePublish.page).toBeNull();
    expect(JSON.stringify(beforePublish)).not.toContain("UNPUBLISHED");
    expect(JSON.stringify(beforePublish)).not.toContain("DRAFT HOME ONLY");
    expect(JSON.stringify(beforePublish)).not.toContain("Draft Menu Item");

    // 2. Publish all Tenant A shell resources atomically
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        siteTitle: "Nusantara Arsitek",
        tagline: "Desain & Konstruksi B2B",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "sales",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "business_profile",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        businessName: "PT Nusantara Arsitek",
        businessCategory: "LocalBusiness",
        description: "Jasa arsitektur dan bangun kantor terpercaya.",
        city: "Jakarta Selatan",
        province: "DKI Jakarta",
        weekdayHours: "Senin–Jumat 08.00–17.00 WIB",
        phone: "6281234567890",
        email: "halo@nusantara-arsitek.id",
        socialLinks: [{ platform: "instagram", url: "https://instagram.com/nusantaraarsitek" }],
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "theme_config",
      resourceId: "sales",
      expectedVersion: 1,
      draftOverride: {
        themeId: "sales",
        tokens: {
          primaryColor: "#0f4c81",
          secondaryColor: "#0f766e",
          borderRadiusPx: 10,
          containerMaxWidthPx: 1200,
        },
        variants: {
          styleVariant: "default",
          headerVariant: "sticky-cta",
          footerVariant: "columns",
        },
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "menu",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        location: "header",
        items: [
          { label: "Beranda", href: "/", openInNewTab: false, children: [] },
          { label: "Layanan", href: "/layanan", openInNewTab: false, children: [] },
          { label: "Kontak", href: "/kontak", openInNewTab: false, children: [] },
        ],
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "menu",
      resourceId: 2,
      expectedVersion: 1,
      draftOverride: {
        location: "footer",
        items: [{ label: "Tentang Kami", href: "/tentang", openInNewTab: false, children: [] }],
      },
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        slug: "beranda",
        title: "Beranda Nusantara Arsitek",
        isHomepage: true,
        layoutMode: "standard",
        sections: [],
      },
    });

    const publishedShell = await loadPublishedTenantShellData(tenantDbA);
    expect(publishedShell.isPreview).toBe(false);
    expect(publishedShell.site.title).toBe("Nusantara Arsitek");
    expect(publishedShell.business.name).toBe("PT Nusantara Arsitek");
    expect(publishedShell.themeId).toBe("sales");
    expect(publishedShell.themeStyle.fallbackUsed).toBe(false);
    expect(publishedShell.themeStyle.css).toContain("--ps-brand-primary: #0f4c81");
    expect(publishedShell.menus.header.map((i) => i.label)).toEqual([
      "Beranda",
      "Layanan",
      "Kontak",
    ]);
    expect(publishedShell.menus.footer.map((i) => i.label)).toEqual(["Tentang Kami"]);
    expect(publishedShell.page?.title).toBe("Beranda Nusantara Arsitek");
    expect(publishedShell.layoutMode).toBe("standard");

    // 3. Save subsequent draft edits WITHOUT publishing -> public loader MUST STILL serve published v1!
    await saveDraftResource(tenantDbA, {
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 2,
      draft: {
        siteTitle: "SECRET DRAFT REBRAND",
        activeThemeId: "dealer",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        blogEnabled: true,
        catalogEnabled: true,
        aiTrainingPolicy: "allow",
        siteVisibility: "public",
        draftNotes: "Do not release yet",
      },
    });
    await saveDraftResource(tenantDbA, {
      resourceType: "theme_config",
      resourceId: "sales",
      expectedVersion: 2,
      draft: {
        themeId: "sales",
        tokens: {
          primaryColor: "#991b1b",
          secondaryColor: "#14532d",
        },
        variants: { styleVariant: "default" },
      },
    });
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      draft: {
        slug: "beranda",
        title: "SECRET DRAFT LANDING",
        isHomepage: true,
        layoutMode: "focused",
        sections: [],
      },
    });

    const afterDraftEdits = await loadPublishedTenantShellData(tenantDbA);
    expect(afterDraftEdits.site.title).toBe("Nusantara Arsitek");
    expect(afterDraftEdits.themeStyle.css).toContain("--ps-brand-primary: #0f4c81");
    expect(afterDraftEdits.themeStyle.css).not.toContain("#991b1b");
    expect(afterDraftEdits.page?.title).toBe("Beranda Nusantara Arsitek");
    expect(afterDraftEdits.layoutMode).toBe("standard");
    expect(JSON.stringify(afterDraftEdits)).not.toContain("SECRET DRAFT");
    expect(JSON.stringify(afterDraftEdits)).not.toContain("Do not release yet");

    // 4. Explicit previewMode: true with bounded override applies validated preview DTO cleanly
    const previewShell = await loadPublishedTenantShellData(tenantDbA, {
      previewMode: true,
      previewDraftOverride: {
        page: {
          slug: "beranda",
          title: "Pratinjau Landing Promo",
          isHomepage: true,
          layoutMode: "focused",
          sections: [],
        },
      },
    });
    expect(previewShell.isPreview).toBe(true);
    expect(previewShell.layoutMode).toBe("focused");
    expect(previewShell.page?.title).toBe("Pratinjau Landing Promo");
  });

  it("falls back safely without executable CSS when stored theme_config published_json is corrupted", async () => {
    // Directly inject malicious CSS payload into Tenant A's published_json column to simulate DB tampering
    const tamperedPayload = JSON.stringify({
      snapshotVersion: 1,
      resourceType: "theme_config",
      data: {
        themeId: "sales",
        tokens: {
          primaryColor: "#112233}</style><script>window.__pwn=1</script>",
          secondaryColor: "url(https://evil.example/bg.png)",
        },
        variants: { styleVariant: "default" },
      },
      publishedAt: 1_800_100_005_000,
      contentModifiedAt: 1_800_100_005_000,
    });

    await tenantDbA
      .prepare("UPDATE theme_configs SET published_json = ? WHERE theme_id = 'sales'")
      .bind(tamperedPayload)
      .run();

    const shell = await loadPublishedTenantShellData(tenantDbA);
    expect(shell.themeStyle.fallbackUsed).toBe(true);
    expect(shell.themeStyle.css).toContain(
      `--ps-brand-primary: ${PLATFORM_THEME_PRESETS.sales.tokens.primaryColor}`,
    );
    expect(shell.themeStyle.css.toLowerCase()).not.toContain("</style");
    expect(shell.themeStyle.css.toLowerCase()).not.toContain("<script");
    expect(shell.themeStyle.css.toLowerCase()).not.toContain("url(");
    expect(shell.themeStyle.css).not.toContain("evil.example");
  });

  it("enforces strict two-tenant isolation so Tenant A never reads Tenant B's shell data", async () => {
    const t0 = 1_800_100_010_000;

    await tenantDbB.batch([
      tenantDbB
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, version, updated_at)
           VALUES (1, 'Kedai Kopi Senja', 'Kopi Nusantara', 'resto', 1, ?)`,
        )
        .bind(t0),
      tenantDbB
        .prepare(
          `INSERT INTO business_profile (id, business_name, business_category, city, version, updated_at)
           VALUES (1, 'Kedai Kopi Senja Yogyakarta', 'Restaurant', 'Yogyakarta', 1, ?)`,
        )
        .bind(t0),
      tenantDbB
        .prepare(
          `INSERT INTO theme_configs (theme_id, tokens_json, variants_json, version, updated_at)
           VALUES ('resto', ?, ?, 1, ?)`,
        )
        .bind(
          JSON.stringify({ primaryColor: "#7c2d12", secondaryColor: "#14532d" }),
          JSON.stringify({ styleVariant: "default", headerVariant: "centered" }),
          t0,
        ),
      tenantDbB
        .prepare(
          `INSERT INTO menus (id, location, items_json, version, created_at, updated_at)
           VALUES (1, 'header', '[]', 1, ?, ?)`,
        )
        .bind(t0, t0),
    ]);

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
      tenantId: TENANT_B.id,
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: 1,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
      tenantId: TENANT_B.id,
      resourceType: "business_profile",
      resourceId: 1,
      expectedVersion: 1,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
      tenantId: TENANT_B.id,
      resourceType: "theme_config",
      resourceId: "resto",
      expectedVersion: 1,
    });
    await publishResourceAtomically(env.PLATFORM_DB, tenantDbB, {
      tenantId: TENANT_B.id,
      resourceType: "menu",
      resourceId: 1,
      expectedVersion: 1,
      draftOverride: {
        location: "header",
        items: [{ label: "Menu Kopi", href: "/menu", openInNewTab: false, children: [] }],
      },
    });

    const [shellA, shellB] = await Promise.all([
      loadPublishedTenantShellData(tenantDbA),
      loadPublishedTenantShellData(tenantDbB),
    ]);

    expect(shellA.site.title).toBe("Nusantara Arsitek");
    expect(shellA.themeId).toBe("sales");
    expect(JSON.stringify(shellA)).not.toContain("Kedai Kopi Senja");
    expect(JSON.stringify(shellA)).not.toContain("Menu Kopi");

    expect(shellB.site.title).toBe("Kedai Kopi Senja");
    expect(shellB.business.name).toBe("Kedai Kopi Senja Yogyakarta");
    expect(shellB.themeId).toBe("resto");
    expect(shellB.themeStyle.css).toContain("--ps-brand-primary: #7c2d12");
    expect(shellB.menus.header.map((i) => i.label)).toEqual(["Menu Kopi"]);
    expect(JSON.stringify(shellB)).not.toContain("Nusantara Arsitek");
  });
});
