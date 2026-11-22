import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  getPublishedSiteIdentity,
  getSiteIdentityForAdmin,
} from "@punyasitus/db/identity/index";
import {
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
} from "@punyasitus/db/platform";
import { getPublishedResource } from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import type { TenantIdentityRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/_shared.ts";
import { handleTenantIdentityRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/index.ts";
import { handleTenantIdentityPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts";
import { SYNTHETIC_TENANTS } from "../fixtures/tenants.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 14, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantIdentityRuntimeEnv> = {},
): TenantIdentityRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    ...overrides,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookiePair(response: Response): string {
  const cookies = getSetCookies(response.headers);
  const sessionHeader = cookies.find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!sessionHeader) {
    throw new Error(
      `Expected ${APP_SESSION_COOKIE_NAME} in Set-Cookie, got: ${JSON.stringify(cookies)}`,
    );
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makeAdminRequest(
  url: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly contentType?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) {
    headers.set("Cookie", options.cookie);
  }
  if (method !== "GET") {
    if (options.contentType !== null) {
      headers.set("Content-Type", options.contentType ?? "application/json");
    }
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? APP_ORIGIN);
    }
  }
  return new Request(url, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function signUpUser(
  email: string,
  name: string,
  runtimeEnv: TenantIdentityRuntimeEnv,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makeAdminRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
      body: { email, password: "StrongPassword!2026", name },
    }),
    runtimeEnv,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  return {
    userId: data.user?.id ?? "",
    cookie: extractSessionCookiePair(res),
  };
}

async function getTenantCacheVersion(tenantId: string): Promise<number> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const [row] = await db
    .select({ cacheVersion: tenants.cacheVersion })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new Error(`Tenant ${tenantId} not found`);
  return row.cacheVersion;
}

async function seedMediaItem(
  tenantDb: D1Database,
  params: {
    readonly id: number;
    readonly tenantId: string;
    readonly kind?: "image" | "video";
    readonly status?: "processing" | "ready" | "failed" | "quarantined";
  },
): Promise<void> {
  const kind = params.kind ?? "image";
  const status = params.status ?? "ready";
  const mime = kind === "image" ? "image/webp" : "video/mp4";
  const key = `t/${params.tenantId}/media/${params.id}.${kind === "image" ? "webp" : "mp4"}`;
  await tenantDb
    .prepare(
      `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, width, height, alt_text, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 40960, ?, 1200, 630, 'Brand Asset', ?, 1, ?, ?)`,
    )
    .bind(
      params.id,
      kind,
      key,
      mime,
      "a".repeat(64),
      status,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();
}

interface ProvisionedTwoTenants {
  readonly tenantA: {
    readonly id: string;
    readonly handle: string;
    readonly orgId: string;
    readonly db: D1Database;
  };
  readonly tenantB: {
    readonly id: string;
    readonly handle: string;
    readonly orgId: string;
    readonly db: D1Database;
  };
  readonly ownerA: { readonly userId: string; readonly cookie: string };
  readonly adminA: { readonly userId: string; readonly cookie: string };
  readonly editorA: { readonly userId: string; readonly cookie: string };
  readonly ownerB: { readonly userId: string; readonly cookie: string };
}

async function provisionTwoTenants(
  suffix: string,
  runtimeEnv: TenantIdentityRuntimeEnv,
): Promise<ProvisionedTwoTenants> {
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(BASE_NOW_MS);
  const paidThrough = new Date(BASE_NOW_MS + 30 * 24 * 60 * 60 * 1000);

  const tenantAId = `01JT008ALPHA${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const tenantBId = `01JT008BETA0${suffix.toUpperCase().padEnd(14, "0").slice(0, 14)}`;
  const handleA = `alpha-id-${suffix}`;
  const handleB = `beta-id-${suffix}`;
  const orgAId = `org-id-alpha-${suffix}`;
  const orgBId = `org-id-beta-${suffix}`;

  const ownerA = await signUpUser(`owner.a.id.${suffix}@example.test`, "Owner Alpha", runtimeEnv);
  const adminA = await signUpUser(`admin.a.id.${suffix}@example.test`, "Admin Alpha", runtimeEnv);
  const editorA = await signUpUser(`editor.a.id.${suffix}@example.test`, "Editor Alpha", runtimeEnv);
  const ownerB = await signUpUser(`owner.b.id.${suffix}@example.test`, "Owner Beta", runtimeEnv);

  await db.insert(organizations).values([
    { id: orgAId, name: "Alpha Studio", slug: handleA, createdAt: now, updatedAt: now },
    { id: orgBId, name: "Beta Klinik", slug: handleB, createdAt: now, updatedAt: now },
  ]);

  await db.insert(tenants).values([
    {
      id: tenantAId,
      organizationId: orgAId,
      handle: handleA,
      name: "Alpha Studio",
      status: "active",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: tenantBId,
      organizationId: orgBId,
      handle: handleB,
      name: "Beta Klinik",
      status: "active",
      paidThrough,
      cacheVersion: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(members).values([
    {
      id: `mem-id-oa-${suffix}`,
      organizationId: orgAId,
      userId: ownerA.userId,
      role: "owner",
      createdAt: now,
    },
    {
      id: `mem-id-aa-${suffix}`,
      organizationId: orgAId,
      userId: adminA.userId,
      role: "admin",
      createdAt: now,
    },
    {
      id: `mem-id-ea-${suffix}`,
      organizationId: orgAId,
      userId: editorA.userId,
      role: "editor",
      createdAt: now,
    },
    {
      id: `mem-id-ob-${suffix}`,
      organizationId: orgBId,
      userId: ownerB.userId,
      role: "owner",
      createdAt: now,
    },
  ]);

  const dbA = await openMigratedTenantDb(tenantAId);
  const dbB = await openMigratedTenantDb(tenantBId);

  // Seed owned media items in Tenant A (#10 logo light, #11 logo dark, #12 favicon, #13 OG, #14 quarantined, #15 video)
  await seedMediaItem(dbA, { id: 10, tenantId: tenantAId, kind: "image", status: "ready" });
  await seedMediaItem(dbA, { id: 11, tenantId: tenantAId, kind: "image", status: "ready" });
  await seedMediaItem(dbA, { id: 12, tenantId: tenantAId, kind: "image", status: "ready" });
  await seedMediaItem(dbA, { id: 13, tenantId: tenantAId, kind: "image", status: "ready" });
  await seedMediaItem(dbA, { id: 14, tenantId: tenantAId, kind: "image", status: "quarantined" });
  await seedMediaItem(dbA, { id: 15, tenantId: tenantAId, kind: "video", status: "ready" });

  // Seed foreign media item existing ONLY in Tenant B (#777)
  await seedMediaItem(dbB, { id: 777, tenantId: tenantBId, kind: "image", status: "ready" });

  return {
    tenantA: { id: tenantAId, handle: handleA, orgId: orgAId, db: dbA },
    tenantB: { id: tenantBId, handle: handleB, orgId: orgBId, db: dbB },
    ownerA,
    adminA,
    editorA,
    ownerB,
  };
}

describe("TASK-008 workerd integration — Site Identity & Brand Configuration API", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
  });

  it("saves draft identity (Owner & Admin) with owned logos/favicon/OG, isolates draft from public, and publishes atomically bumping resource version & PLATFORM_DB cache_version", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, tenantB, ownerA, adminA } = await provisionTwoTenants("01", runtimeEnv);

    // 1. Initial GET returns uninitialized state (version 0) with no-store & noindex
    const initRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("cache-control")).toBe("no-store");
    expect(initRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const initBody = (await initRes.json()) as {
      version: number;
      draft: unknown;
      published: unknown;
      hasUnpublishedChanges: boolean;
    };
    expect(initBody.version).toBe(0);
    expect(initBody.draft).toBeNull();
    expect(initBody.published).toBeNull();
    expect(initBody.hasUnpublishedChanges).toBe(false);

    const cacheVerABefore = await getTenantCacheVersion(tenantA.id);
    const cacheVerBBefore = await getTenantCacheVersion(tenantB.id);

    // 2. Owner saves draft via PUT with owned logos, favicon, OG image, WA E.164, social links
    const saveRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PUT", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: 0,
          siteSettings: {
            siteTitle: "Kopi Nusantara",
            tagline: "Roastery Spesialti Indonesia",
            timezone: "Asia/Jakarta",
            locale: "id-ID",
            activeThemeId: "compro",
            logoLightMediaId: 10,
            logoDarkMediaId: 11,
            faviconMediaId: 12,
            ogImageMediaId: 13,
            blogEnabled: true,
            catalogEnabled: true,
            aiTrainingPolicy: "disallow",
          },
          businessProfile: {
            businessName: "PT Kopi Nusantara Sejahtera",
            businessCategory: "CafeOrCoffeeShop",
            description: "Kopi spesialti pilihan langsung dari petani Nusantara.",
            address: "Jl. Kemang Raya No. 10",
            city: "Jakarta Selatan",
            province: "DKI Jakarta",
            postalCode: "12730",
            latitude: -6.2607,
            longitude: 106.8131,
            mapsUrl: "https://maps.google.com/?q=-6.2607,106.8131",
            weekdayHours: "Senin-Jumat 08:00-21:00",
            holidayHours: "Sabtu-Minggu 09:00-18:00",
            serviceAreas: ["Jakarta", "Depok", "Tangerang"],
            whatsappE164: "0812-3456-7890",
            phone: "021-7123456",
            email: "Halo@KopiNusantara.ID",
            socialLinks: [
              { platform: "instagram", url: "https://instagram.com/kopinusantara" },
              { platform: "website", url: "https://kopinusantara.id" },
            ],
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as {
      version: number;
      versions: { siteSettings: number; businessProfile: number };
      hasUnpublishedChanges: boolean;
      published: unknown;
      siteSettings: {
        siteTitle: string;
        logoMediaId: number | null;
        logoLightMediaId: number | null;
        logoDarkMediaId: number | null;
        faviconMediaId: number | null;
        ogImageMediaId: number | null;
      };
      businessProfile: {
        businessName: string;
        whatsappE164: string | null;
        phone: string | null;
        email: string | null;
        socialLinks: Array<{ platform: string; url: string }>;
      };
    };

    expect(saved.version).toBe(1);
    expect(saved.versions).toEqual({ siteSettings: 1, businessProfile: 1 });
    expect(saved.hasUnpublishedChanges).toBe(true);
    expect(saved.published).toBeNull();
    expect(saved.siteSettings.siteTitle).toBe("Kopi Nusantara");
    expect(saved.siteSettings.logoMediaId).toBe(10);
    expect(saved.siteSettings.logoLightMediaId).toBe(10);
    expect(saved.siteSettings.logoDarkMediaId).toBe(11);
    expect(saved.siteSettings.faviconMediaId).toBe(12);
    expect(saved.siteSettings.ogImageMediaId).toBe(13);
    expect(saved.businessProfile.whatsappE164).toBe("6281234567890");
    expect(saved.businessProfile.phone).toBe("62217123456");
    expect(saved.businessProfile.email).toBe("halo@kopinusantara.id");
    expect(saved.businessProfile.socialLinks).toHaveLength(2);

    // 3. Draft MUST NOT leak to public loaders or bump PLATFORM_DB cache_version!
    expect(await getPublishedSiteIdentity(tenantA.db)).toBeNull();
    expect(
      await getPublishedResource(tenantA.db, { resourceType: "site_settings", resourceId: 1 }),
    ).toBeNull();
    expect(
      await getPublishedResource(tenantA.db, { resourceType: "business_profile", resourceId: 1 }),
    ).toBeNull();
    expect(await getTenantCacheVersion(tenantA.id)).toBe(cacheVerABefore);

    // 4. Admin publishes identity atomically -> increments resource version AND PLATFORM_DB.tenants.cache_version!
    const pubRes = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        cookie: adminA.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(pubRes.status).toBe(200);
    expect(pubRes.headers.get("cache-control")).toBe("no-store");
    const pubBody = (await pubRes.json()) as {
      version: number;
      versions: { siteSettings: number; businessProfile: number };
      cacheVersion: number;
      hasUnpublishedChanges: boolean;
      published: {
        siteSettings: { siteTitle: string; logoMediaId: number; logoDarkMediaId: number };
        businessProfile: { whatsappE164: string; businessName: string };
      };
    };

    expect(pubBody.version).toBe(2);
    expect(pubBody.versions).toEqual({ siteSettings: 2, businessProfile: 2 });
    expect(pubBody.cacheVersion).toBeGreaterThan(cacheVerABefore);
    expect(pubBody.hasUnpublishedChanges).toBe(false);
    expect(pubBody.published.siteSettings.siteTitle).toBe("Kopi Nusantara");
    expect(pubBody.published.siteSettings.logoMediaId).toBe(10);
    expect(pubBody.published.siteSettings.logoDarkMediaId).toBe(11);
    expect(pubBody.published.businessProfile.whatsappE164).toBe("6281234567890");

    // Verify PLATFORM_DB.tenants.cache_version updated for Tenant A ONLY (Tenant B untouched!)
    expect(await getTenantCacheVersion(tenantA.id)).toBe(pubBody.cacheVersion);
    expect(await getTenantCacheVersion(tenantB.id)).toBe(cacheVerBBefore);

    // Public loader now returns the exact published identity snapshot
    const publicIdentity = await getPublishedSiteIdentity(tenantA.db);
    expect(publicIdentity?.siteSettings.siteTitle).toBe("Kopi Nusantara");
    expect(publicIdentity?.siteSettings.logoLightMediaId).toBe(10);
    expect(publicIdentity?.siteSettings.logoDarkMediaId).toBe(11);
    expect(publicIdentity?.siteSettings.faviconMediaId).toBe(12);
    expect(publicIdentity?.siteSettings.ogImageMediaId).toBe(13);
    expect(publicIdentity?.businessProfile.whatsappE164).toBe("6281234567890");

    // 5. Subsequent PATCH draft edit by Admin MUST NOT leak to public until re-published
    const patchRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
        cookie: adminA.cookie,
        body: {
          expectedVersion: 2,
          siteSettings: { siteTitle: "RAHASIA DRAFT REBRAND" },
          businessProfile: { whatsappE164: "0899-1111-2222" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 3_000 },
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      version: number;
      hasUnpublishedChanges: boolean;
      siteSettings: { siteTitle: string };
      published: { siteSettings: { siteTitle: string }; businessProfile: { whatsappE164: string } };
    };
    expect(patched.version).toBe(3);
    expect(patched.hasUnpublishedChanges).toBe(true);
    expect(patched.siteSettings.siteTitle).toBe("RAHASIA DRAFT REBRAND");
    expect(patched.published.siteSettings.siteTitle).toBe("Kopi Nusantara");
    expect(patched.published.businessProfile.whatsappE164).toBe("6281234567890");

    // Public loader STILL serves previously published snapshot & cache_version is UNCHANGED
    const publicDuringDraft = await getPublishedSiteIdentity(tenantA.db);
    expect(publicDuringDraft?.siteSettings.siteTitle).toBe("Kopi Nusantara");
    expect(publicDuringDraft?.businessProfile.whatsappE164).toBe("6281234567890");
    expect(await getTenantCacheVersion(tenantA.id)).toBe(pubBody.cacheVersion);
  });

  it("rejects foreign/missing/unready/non-image media IDs, unsafe URLs, unknown fields, and forbidden tenant selectors with 422 without mutating DB", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, tenantB, ownerA } = await provisionTwoTenants("02", runtimeEnv);

    // Seed valid baseline v1
    const baseline = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PUT", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: 0,
          siteSettings: { siteTitle: "Baseline Alpha", logoMediaId: 10 },
          businessProfile: { businessName: "PT Baseline Alpha", whatsappE164: "081234567890" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(baseline.status).toBe(200);

    const invalidCases: Array<{
      readonly name: string;
      readonly body: Record<string, unknown>;
      readonly expectedFieldCode: string;
    }> = [
      {
        name: "foreign logoMediaId existing only in Tenant B (#777)",
        body: { expectedVersion: 1, siteSettings: { logoMediaId: 777 } },
        expectedFieldCode: "MEDIA_NOT_FOUND",
      },
      {
        name: "foreign faviconMediaId existing only in Tenant B (#777)",
        body: { expectedVersion: 1, siteSettings: { faviconMediaId: 777 } },
        expectedFieldCode: "MEDIA_NOT_FOUND",
      },
      {
        name: "missing ogImageMediaId (#9999)",
        body: { expectedVersion: 1, siteSettings: { ogImageMediaId: 9999 } },
        expectedFieldCode: "MEDIA_NOT_FOUND",
      },
      {
        name: "quarantined media item in Tenant A (#14)",
        body: { expectedVersion: 1, siteSettings: { logoDarkMediaId: 14 } },
        expectedFieldCode: "MEDIA_NOT_FOUND",
      },
      {
        name: "video media item used as logo (#15)",
        body: { expectedVersion: 1, siteSettings: { logoMediaId: 15 } },
        expectedFieldCode: "MEDIA_NOT_FOUND",
      },
      {
        name: "unsafe javascript: social link",
        body: {
          expectedVersion: 1,
          businessProfile: {
            socialLinks: [{ platform: "instagram", url: "javascript:alert(1)" }],
          },
        },
        expectedFieldCode: "UNSAFE_URL",
      },
      {
        name: "unsafe private-host mapsUrl (169.254.169.254)",
        body: {
          expectedVersion: 1,
          businessProfile: {
            mapsUrl: "https://169.254.169.254/latest/meta-data",
          },
        },
        expectedFieldCode: "UNSAFE_URL",
      },
      {
        name: "unsafe non-HTTPS mapsUrl (http://)",
        body: {
          expectedVersion: 1,
          businessProfile: {
            mapsUrl: "http://maps.google.com/?q=-6.2,106.8",
          },
        },
        expectedFieldCode: "UNSAFE_URL",
      },
      {
        name: "invalid WhatsApp E.164 landline",
        body: {
          expectedVersion: 1,
          businessProfile: { whatsappE164: "021-7123456" },
        },
        expectedFieldCode: "INVALID_WHATSAPP",
      },
      {
        name: "unknown top-level field",
        body: {
          expectedVersion: 1,
          siteSettings: { siteTitle: "Should Fail" },
          unexpectedField: true,
        },
        expectedFieldCode: "UNKNOWN_FIELD",
      },
      {
        name: "forged top-level tenantId selector",
        body: {
          expectedVersion: 1,
          tenantId: tenantB.id,
          siteSettings: { siteTitle: "Should Fail" },
        },
        expectedFieldCode: "FORBIDDEN_TENANT_SELECTOR",
      },
      {
        name: "forged nested organizationId selector",
        body: {
          expectedVersion: 1,
          businessProfile: { organizationId: tenantB.orgId, businessName: "Hijack" },
        },
        expectedFieldCode: "FORBIDDEN_TENANT_SELECTOR",
      },
    ];

    for (const tc of invalidCases) {
      const res = await handleTenantIdentityRequest(
        tenantA.handle,
        makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
          cookie: ownerA.cookie,
          body: tc.body,
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 1_000 },
      );
      expect(res.status, tc.name).toBe(422);
      const errBody = (await res.json()) as {
        error: { code: string; fields?: Array<{ code: string }> };
      };
      expect(errBody.error.code, tc.name).toBe("VALIDATION_ERROR");
      expect(errBody.error.fields?.[0]?.code, tc.name).toBe(tc.expectedFieldCode);
    }

    // Verify Tenant A's stored draft was NEVER mutated (still v1 Baseline Alpha)
    const afterInvalid = await getSiteIdentityForAdmin(tenantA.db);
    expect(afterInvalid.version).toBe(1);
    expect(afterInvalid.siteSettings?.siteTitle).toBe("Baseline Alpha");
    expect(afterInvalid.siteSettings?.logoMediaId).toBe(10);

    // If owned media #10 is deleted AFTER draft save, publish MUST fail with 422 MEDIA_NOT_FOUND
    const cacheVerBefore = await getTenantCacheVersion(tenantA.id);
    await tenantA.db.prepare("DELETE FROM media_items WHERE id = 10").run();

    const pubMissingMedia = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 2_000 },
    );
    expect(pubMissingMedia.status).toBe(422);
    const pubErr = (await pubMissingMedia.json()) as {
      error: { code: string; fields?: Array<{ code: string }> };
    };
    expect(pubErr.error.code).toBe("VALIDATION_ERROR");
    expect(pubErr.error.fields?.[0]?.code).toBe("MEDIA_NOT_FOUND");
    expect(await getPublishedSiteIdentity(tenantA.db)).toBeNull();
    expect(await getTenantCacheVersion(tenantA.id)).toBe(cacheVerBefore);
  });

  it("enforces Editor 403 FORBIDDEN on mutations, 409 STALE_VERSION, 401 unauthenticated, 404 cross-tenant/host, CSRF, and 403 locked/suspended lifecycle", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const { tenantA, tenantB, ownerA, editorA } = await provisionTwoTenants("03", runtimeEnv);

    // 1. Seed valid v1 draft as Owner A
    const seedRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PUT", {
        cookie: ownerA.cookie,
        body: {
          expectedVersion: 0,
          siteSettings: { siteTitle: "Identitas Resmi" },
          businessProfile: { businessName: "PT Resmi" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS },
    );
    expect(seedRes.status).toBe(200);

    // 2. Editor role: allowed GET (read), REJECTED with 403 FORBIDDEN on PUT, PATCH, and POST publish without mutating DB!
    const editorGet = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "GET", {
        cookie: editorA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 500 },
    );
    expect(editorGet.status).toBe(200);

    const editorPut = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PUT", {
        cookie: editorA.cookie,
        body: {
          expectedVersion: 1,
          siteSettings: { siteTitle: "Editor Hack" },
          businessProfile: { businessName: "Editor Hack" },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 600 },
    );
    expect(editorPut.status).toBe(403);
    expect(((await editorPut.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    const editorPatch = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
        cookie: editorA.cookie,
        body: { expectedVersion: 1, siteSettings: { siteTitle: "Editor Patch Hack" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 700 },
    );
    expect(editorPatch.status).toBe(403);
    expect(((await editorPatch.json()) as { error: { code: string } }).error.code).toBe(
      "FORBIDDEN",
    );

    const cacheVerBeforeEditorPub = await getTenantCacheVersion(tenantA.id);
    const editorPub = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        cookie: editorA.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 800 },
    );
    expect(editorPub.status).toBe(403);
    expect(((await editorPub.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");

    // Verify DB & cache_version completely untouched after Editor denials
    const afterEditor = await getSiteIdentityForAdmin(tenantA.db);
    expect(afterEditor.version).toBe(1);
    expect(afterEditor.siteSettings?.siteTitle).toBe("Identitas Resmi");
    expect(afterEditor.published).toBeNull();
    expect(await getTenantCacheVersion(tenantA.id)).toBe(cacheVerBeforeEditorPub);

    // 3. Stale expectedVersion returns 409 STALE_VERSION on PATCH & POST publish without mutating DB
    const stalePatch = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 0, siteSettings: { siteTitle: "Stale Overwrite" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 900 },
    );
    expect(stalePatch.status).toBe(409);
    expect(((await stalePatch.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );

    const stalePublish = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 0 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_000 },
    );
    expect(stalePublish.status).toBe(409);
    expect(((await stalePublish.json()) as { error: { code: string } }).error.code).toBe(
      "STALE_VERSION",
    );
    expect((await getSiteIdentityForAdmin(tenantA.db)).version).toBe(1);
    expect(await getTenantCacheVersion(tenantA.id)).toBe(cacheVerBeforeEditorPub);

    // 4. Unauthenticated -> 401 UNAUTHENTICATED
    const unauthGet = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "GET"),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_100 },
    );
    expect(unauthGet.status).toBe(401);

    const unauthPub = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_100 },
    );
    expect(unauthPub.status).toBe(401);

    // 5. Cross-tenant non-member (Owner A accessing Tenant B) -> neutral 404
    const crossGet = await handleTenantIdentityRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/identity`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_200 },
    );
    expect(crossGet.status).toBe(404);

    const crossPatch = await handleTenantIdentityRequest(
      tenantB.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/identity`, "PATCH", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 0, siteSettings: { siteTitle: "Cross Hack" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_200 },
    );
    expect(crossPatch.status).toBe(404);

    // 6. Host isolation: public tenant host & console host return neutral 404
    const tenantHostRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(
        `https://${SYNTHETIC_TENANTS[0].subdomainHost}/api/tenants/${tenantA.handle}/identity`,
        "GET",
        { cookie: ownerA.cookie },
      ),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_300 },
    );
    expect(tenantHostRes.status).toBe(404);

    const consoleHostRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${CONSOLE_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_300 },
    );
    expect(consoleHostRes.status).toBe(404);

    // 7. Forged Origin on mutation -> 403
    const badOriginRes = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
        cookie: ownerA.cookie,
        origin: `https://${SYNTHETIC_TENANTS[0].subdomainHost}`,
        body: { expectedVersion: 1, siteSettings: { siteTitle: "CSRF" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_400 },
    );
    expect(badOriginRes.status).toBe(403);

    // 8. Locked tenant (H+4..H+7): Owner can READ (200), CANNOT mutate or publish (403 SUBSCRIPTION_LOCKED)
    const platformDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const fiveDaysAgo = new Date(BASE_NOW_MS - 5 * 24 * 60 * 60 * 1000);
    await platformDb
      .update(tenants)
      .set({ status: "locked", paidThrough: fiveDaysAgo })
      .where(eq(tenants.id, tenantA.id));

    const lockedGet = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "GET", {
        cookie: ownerA.cookie,
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_500 },
    );
    expect(lockedGet.status).toBe(200);

    const lockedPatch = await handleTenantIdentityRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity`, "PATCH", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 1, siteSettings: { siteTitle: "Blocked" } },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_500 },
    );
    expect(lockedPatch.status).toBe(403);
    expect(((await lockedPatch.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );

    const lockedPub = await handleTenantIdentityPublishRequest(
      tenantA.handle,
      makeAdminRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/identity/publish`, "POST", {
        cookie: ownerA.cookie,
        body: { expectedVersion: 1 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 1_500 },
    );
    expect(lockedPub.status).toBe(403);
    expect(((await lockedPub.json()) as { error: { code: string } }).error.code).toBe(
      "SUBSCRIPTION_LOCKED",
    );
  });
});
