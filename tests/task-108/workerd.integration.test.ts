import { env } from "cloudflare:workers";
import { PNG_SIGNATURE } from "@punyasitus/core/qr/index";
import { createCatalogOffering, publishCatalogOffering, softDeleteCatalogOffering } from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { createPage, publishPage, trashPage } from "@punyasitus/db/pages/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenantHosts,
  tenants,
  users,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleTenantQrRequest,
  type TenantQrRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/qr/index.ts";
import { decodeQrPngToText, decodeQrSvgToText } from "./qr-decoder-helper.ts";

const BASE_TIME = 1_855_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT_ALPHA = {
  id: "01JT108A000000000000000001",
  orgId: "org_t108_alpha",
  handle: "t108-alpha",
  name: "Alpha Wisata Utama",
  subdomain: "t108-alpha.situsku.click",
  customWww: "www.t108-alpha.id",
  customApex: "t108-alpha.id",
} as const;

const TENANT_BETA = {
  id: "01JT108B000000000000000002",
  orgId: "org_t108_beta",
  handle: "t108-beta",
  name: "Beta Studio Lain",
  subdomain: "t108-beta.situsku.click",
} as const;

const TENANT_SUSPENDED = {
  id: "01JT108S000000000000000003",
  orgId: "org_t108_suspended",
  handle: "t108-suspended",
  name: "Situs Ditangguhkan",
  subdomain: "t108-suspended.situsku.click",
} as const;

const USER_OWNER = "usr_t108_owner";
const USER_EDITOR = "usr_t108_editor";
const USER_BETA_OWNER = "usr_t108_beta_owner";

function makeRuntimeEnv(): TenantQrRuntimeEnv {
  return {
    APP_ENV: "production",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: "test-auth-secret-task-108-minimum-32-chars!!",
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

async function seedUserAndMembership(params: {
  readonly userId: string;
  readonly email: string;
  readonly orgId: string;
  readonly role: "owner" | "admin" | "editor";
}): Promise<void> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  await pDb
    .insert(users)
    .values({
      id: params.userId,
      name: params.userId,
      email: params.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await pDb
    .insert(members)
    .values({
      id: `mem_${params.userId}_${params.orgId}`,
      organizationId: params.orgId,
      userId: params.userId,
      role: params.role,
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function seedTenantFixtures(): Promise<{
  readonly alphaDb: D1Database;
  readonly publishedPageId: number;
  readonly draftPageId: number;
  readonly trashedPageId: number;
  readonly publishedOfferingId: number;
  readonly draftOfferingId: number;
  readonly trashedOfferingId: number;
}> {
  const now = new Date(BASE_TIME);
  const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

  const seedOrgTenant = async (spec: {
    readonly id: string;
    readonly orgId: string;
    readonly handle: string;
    readonly name: string;
    readonly status: "active" | "trial" | "suspended";
    readonly subdomain: string;
    readonly customHosts?: readonly { readonly host: string; readonly primary: boolean }[];
  }) => {
    await pDb
      .insert(organizations)
      .values({ id: spec.orgId, name: spec.name, slug: spec.handle, createdAt: now, updatedAt: now })
      .onConflictDoNothing();

    await pDb
      .insert(tenants)
      .values({
        id: spec.id,
        organizationId: spec.orgId,
        handle: spec.handle,
        name: spec.name,
        vertical: "travel",
        status: spec.status,
        operatorHold: false,
        paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
        trialEndsAt: spec.status === "trial" ? new Date(BASE_TIME + 7 * DAY_MS) : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenants.id,
        set: {
          status: spec.status,
          paidThrough: spec.status === "active" ? new Date(BASE_TIME + 30 * DAY_MS) : null,
          updatedAt: now,
        },
      });

    await pDb.delete(tenantHosts).where(eq(tenantHosts.tenantId, spec.id));
    const hasPrimaryCustom = (spec.customHosts ?? []).some((h) => h.primary);
    await pDb.insert(tenantHosts).values({
      host: spec.subdomain,
      tenantId: spec.id,
      kind: "subdomain",
      status: "active",
      sslStatus: "active",
      isPrimary: !hasPrimaryCustom,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    for (const custom of spec.customHosts ?? []) {
      await pDb.insert(tenantHosts).values({
        host: custom.host,
        tenantId: spec.id,
        kind: "custom",
        status: "active",
        sslStatus: "active",
        isPrimary: custom.primary,
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  await seedOrgTenant({
    ...TENANT_ALPHA,
    status: "active",
    customHosts: [
      { host: TENANT_ALPHA.customWww, primary: true },
      { host: TENANT_ALPHA.customApex, primary: false },
    ],
  });
  await seedOrgTenant({ ...TENANT_BETA, status: "active" });
  await seedOrgTenant({ ...TENANT_SUSPENDED, status: "suspended" });

  await seedUserAndMembership({
    userId: USER_OWNER,
    email: "owner.t108@example.test",
    orgId: TENANT_ALPHA.orgId,
    role: "owner",
  });
  await seedUserAndMembership({
    userId: USER_EDITOR,
    email: "editor.t108@example.test",
    orgId: TENANT_ALPHA.orgId,
    role: "editor",
  });
  await seedUserAndMembership({
    userId: USER_OWNER,
    email: "owner.t108@example.test",
    orgId: TENANT_SUSPENDED.orgId,
    role: "owner",
  });
  await seedUserAndMembership({
    userId: USER_BETA_OWNER,
    email: "beta.t108@example.test",
    orgId: TENANT_BETA.orgId,
    role: "owner",
  });

  const alphaStub = openTenantStoreStub(
    env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    TENANT_ALPHA.id,
  );
  await orchestrateTenantMigration(env.PLATFORM_DB, alphaStub, TENANT_ALPHA.id, TENANT_MIGRATIONS);
  const alphaDb = createTenantDb(alphaStub);

  // Clean existing pages/offerings in alpha store for deterministic IDs
  await alphaDb.prepare("DELETE FROM resource_slugs").run();
  await alphaDb.prepare("DELETE FROM pages").run();
  await alphaDb.prepare("DELETE FROM offerings").run();

  const pubPage = await createPage(alphaDb, {
    title: "Tentang Alpha Wisata",
    slug: "tentang-kami",
    nowMs: BASE_TIME,
  });
  await publishPage(env.PLATFORM_DB, alphaDb, {
    tenantId: TENANT_ALPHA.id,
    pageId: pubPage.id,
    expectedVersion: pubPage.version,
    nowMs: BASE_TIME + 1000,
  });

  const draftPage = await createPage(alphaDb, {
    title: "Halaman Promo Draf",
    slug: "promo-draf",
    nowMs: BASE_TIME + 2000,
  });

  const trashedPage = await createPage(alphaDb, {
    title: "Halaman Lama Dihapus",
    slug: "halaman-dihapus",
    nowMs: BASE_TIME + 3000,
  });
  await trashPage(env.PLATFORM_DB, alphaDb, {
    tenantId: TENANT_ALPHA.id,
    pageId: trashedPage.id,
    expectedVersion: trashedPage.version,
    nowMs: BASE_TIME + 4000,
  });

  const pubOffering = await createCatalogOffering(alphaDb, {
    offeringType: "tour",
    title: "Paket Umrah 9 Hari",
    slug: "paket-umrah-9-hari",
    priceMode: "fixed",
    price: 29_500_000,
    ctaMode: "inquiry",
    attributes: {
      durationDays: 9,
      durationNights: 8,
      departureCity: "Jakarta",
      inclusions: ["Tiket PP", "Hotel Bintang 4"],
      exclusions: ["Paspor"],
      itinerary: [{ day: 1, title: "Keberangkatan", description: "Jakarta menuju Madinah" }],
    },
  });
  await publishCatalogOffering(env.PLATFORM_DB, alphaDb, {
    tenantId: TENANT_ALPHA.id,
    offeringId: pubOffering.id,
    expectedVersion: pubOffering.version,
    nowMs: BASE_TIME + 5000,
  });

  const draftOffering = await createCatalogOffering(alphaDb, {
    offeringType: "product",
    title: "Produk Draf Belum Terbit",
    slug: "produk-draf",
    priceMode: "fixed",
    price: 150_000,
    ctaMode: "inquiry",
    attributes: { sku: "DRF-001", specs: [] },
  });

  const trashedOffering = await createCatalogOffering(alphaDb, {
    offeringType: "service",
    title: "Layanan Terhapus",
    slug: "layanan-terhapus",
    priceMode: "on_request",
    ctaMode: "inquiry",
    attributes: { deliverables: ["Audit"], turnaround: "3 hari" },
  });
  await softDeleteCatalogOffering(env.PLATFORM_DB, alphaDb, {
    tenantId: TENANT_ALPHA.id,
    offeringId: trashedOffering.id,
    expectedVersion: trashedOffering.version,
    nowMs: BASE_TIME + 6000,
  });

  return {
    alphaDb,
    publishedPageId: pubPage.id,
    draftPageId: draftPage.id,
    trashedPageId: trashedPage.id,
    publishedOfferingId: pubOffering.id,
    draftOfferingId: draftOffering.id,
    trashedOfferingId: trashedOffering.id,
  };
}

describe("TASK-108: Scoped Tenant QR API in Cloudflare workerd", () => {
  let fixtures: Awaited<ReturnType<typeof seedTenantFixtures>>;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  beforeEach(async () => {
    fixtures = await seedTenantFixtures();
  });

  it("enforces app-host-only neutral 404, auth 401, cross-tenant 404, editor read access, and suspended 403", async () => {
    const rt = makeRuntimeEnv();

    // Non-app hosts -> neutral 404
    for (const host of ["punyasitus.com", "console.punyasitus.com", "www.t108-alpha.id"]) {
      const res = await handleTenantQrRequest(
        TENANT_ALPHA.id,
        new Request(`https://${host}/api/tenants/${TENANT_ALPHA.id}/qr?target=website&format=json`),
        rt,
        { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }

    // Unauthenticated -> 401
    const unauth = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(`https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=website&format=json`),
      rt,
      { authenticatedUser: null, nowMs: BASE_TIME },
    );
    expect(unauth.status).toBe(401);

    // Cross-tenant access -> neutral 404
    const crossTenant = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(`https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=website&format=json`),
      rt,
      { authenticatedUser: { id: USER_BETA_OWNER }, nowMs: BASE_TIME },
    );
    expect(crossTenant.status).toBe(404);

    // Editor (`member` role) has `content:read` -> 200
    const editorRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(`https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=website&format=json&utm=1`),
      rt,
      { authenticatedUser: { id: USER_EDITOR }, nowMs: BASE_TIME },
    );
    expect(editorRes.status).toBe(200);

    // Suspended tenant -> 403 SUBSCRIPTION_LOCKED
    const suspendedRes = await handleTenantQrRequest(
      TENANT_SUSPENDED.id,
      new Request(`https://app.punyasitus.com/api/tenants/${TENANT_SUSPENDED.id}/qr?target=website&format=json`),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(suspendedRes.status).toBe(403);
  });

  it("generates decodable SVG, PNG, and JSON for website, published page, and published offering — and reflects live primary domain switches immediately", async () => {
    const rt = makeRuntimeEnv();

    // 1. Published offering SVG (with utm=1)
    const svgRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=offering&id=${fixtures.publishedOfferingId}&format=svg&utm=1`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(svgRes.headers.get("Content-Disposition")).toBe(
      'attachment; filename="qr-tour-paket-umrah-9-hari.svg"',
    );
    expect(svgRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(svgRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(svgRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const svgBody = await svgRes.text();
    expect(decodeQrSvgToText(svgBody).text).toBe(
      "https://www.t108-alpha.id/tour/paket-umrah-9-hari?utm_source=qr",
    );

    // 2. Published page PNG (with utm=0)
    const pngRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=page&id=${fixtures.publishedPageId}&format=png&utm=0`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("Content-Type")).toBe("image/png");
    expect(pngRes.headers.get("Content-Disposition")).toBe(
      'attachment; filename="qr-tentang-kami.png"',
    );
    const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
    expect(Array.from(pngBytes.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
    expect(decodeQrPngToText(pngBytes).text).toBe("https://www.t108-alpha.id/tentang-kami");

    // 3. Switch primary domain in PLATFORM_DB from www.t108-alpha.id -> t108-alpha.id
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb
      .update(tenantHosts)
      .set({ isPrimary: false })
      .where(and(eq(tenantHosts.tenantId, TENANT_ALPHA.id), eq(tenantHosts.host, TENANT_ALPHA.customWww)));
    await pDb
      .update(tenantHosts)
      .set({ isPrimary: true })
      .where(and(eq(tenantHosts.tenantId, TENANT_ALPHA.id), eq(tenantHosts.host, TENANT_ALPHA.customApex)));

    const switchedPngRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=offering&id=${fixtures.publishedOfferingId}&format=png&utm=1`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(switchedPngRes.status).toBe(200);
    const switchedPngBytes = new Uint8Array(await switchedPngRes.arrayBuffer());
    expect(decodeQrPngToText(switchedPngBytes).text).toBe(
      "https://t108-alpha.id/tour/paket-umrah-9-hari?utm_source=qr",
    );

    const switchedJsonRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=website&format=json&utm=1`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(switchedJsonRes.status).toBe(200);
    const jsonPayload = (await switchedJsonRes.json()) as {
      readonly canonicalUrl: string;
      readonly svg: string;
      readonly pngDownloadUrl: string;
      readonly svgDownloadUrl: string;
    };
    expect(jsonPayload.canonicalUrl).toBe("https://t108-alpha.id/?utm_source=qr");
    expect(decodeQrSvgToText(jsonPayload.svg).text).toBe("https://t108-alpha.id/?utm_source=qr");
    expect(jsonPayload.pngDownloadUrl).toContain("format=png&utm=1");
    expect(jsonPayload.svgDownloadUrl).toContain("format=svg&utm=1");
  });

  it("refuses drafts with 409 DRAFT_QR_NOT_ALLOWED, trashed/missing items with 404, and spoofed query params with 422", async () => {
    const rt = makeRuntimeEnv();

    // Draft page -> 409 DRAFT_QR_NOT_ALLOWED
    const draftPageRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=page&id=${fixtures.draftPageId}&format=svg&utm=1`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(draftPageRes.status).toBe(409);
    const draftPageJson = (await draftPageRes.json()) as { readonly error: { readonly code: string } };
    expect(draftPageJson.error.code).toBe("DRAFT_QR_NOT_ALLOWED");

    // Draft offering -> 409 DRAFT_QR_NOT_ALLOWED
    const draftOfferingRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=offering&id=${fixtures.draftOfferingId}&format=png&utm=1`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(draftOfferingRes.status).toBe(409);
    const draftOfferingJson = (await draftOfferingRes.json()) as {
      readonly error: { readonly code: string };
    };
    expect(draftOfferingJson.error.code).toBe("DRAFT_QR_NOT_ALLOWED");

    // Trashed page & offering -> 404
    const trashedPageRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=page&id=${fixtures.trashedPageId}&format=svg`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(trashedPageRes.status).toBe(404);

    const trashedOffRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=offering&id=${fixtures.trashedOfferingId}&format=png`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(trashedOffRes.status).toBe(404);

    // Spoofed URL/host query param -> 422
    const spoofedRes = await handleTenantQrRequest(
      TENANT_ALPHA.id,
      new Request(
        `https://app.punyasitus.com/api/tenants/${TENANT_ALPHA.id}/qr?target=website&url=https://evil.example`,
      ),
      rt,
      { authenticatedUser: { id: USER_OWNER }, nowMs: BASE_TIME },
    );
    expect(spoofedRes.status).toBe(422);
  });
});
