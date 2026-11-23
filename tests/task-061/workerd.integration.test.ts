import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createSqliteDrizzle,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { applyCustomThemeServiceMigration } from "@punyasitus/db/custom-themes/migrations";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  tenants,
  tenantThemeEntitlements,
  themeCatalog,
  updatePlatformSettings,
} from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleConsoleCustomThemePackageDetailRequest } from "../../apps/web/src/pages/api/console/custom-themes/packages/[packageId].ts";
import { handleConsoleCustomThemePackagesRequest } from "../../apps/web/src/pages/api/console/custom-themes/packages/index.ts";
import { handleConsoleCustomThemeRequestDetail } from "../../apps/web/src/pages/api/console/custom-themes/requests/[requestId].ts";
import { handleConsoleCustomThemeRequestsListRequest } from "../../apps/web/src/pages/api/console/custom-themes/requests/index.ts";
import { handleTenantCustomThemePackagesRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/custom-theme-packages/index.ts";
import { handleTenantCustomThemeRequestDetail } from "../../apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/[requestId].ts";
import type {
  TenantCustomThemePackageDto,
  TenantCustomThemeRequestDto,
  TenantCustomThemeRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/_shared.ts";
import { handleTenantCustomThemeRequestsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/index.ts";
import { handleTenantThemesActivateRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/activate.ts";
import { handleTenantThemesListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/index.ts";
import { loadCustomThemeServicePageOrGateResponse } from "../../apps/web/src/pages/dashboard/[handle]/appearance/themes/custom/_page-gate.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const NOW_MS = Date.UTC(2026, 10, 23, 6, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantCustomThemeRuntimeEnv> = {},
): TenantCustomThemeRuntimeEnv & { readonly TENANT_STORE: TenantStoreNamespaceLike } {
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
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractCookiePair(response: Response, name: string): string {
  const found = getSetCookies(response.headers).find((c) => c.startsWith(`${name}=`));
  if (!found) {
    throw new Error(`Missing cookie ${name} in response`);
  }
  return (found.split(";")[0] ?? "").trim();
}

function makeRequest(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  options: {
    readonly origin?: string | null;
    readonly cookie?: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? new URL(url).origin);
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

let tenantSeq = 1;
async function provisionTenantFixture(
  tag: string,
  status: "active" | "trial" | "locked" | "suspended" | "purged",
  runtimeEnv: ReturnType<typeof buildRuntimeEnv>,
) {
  const seq = String(tenantSeq++).padStart(4, "0");
  const tenantId = `01JT061TENANT000000000${seq}`;
  const orgId = `01JT061ORG000000000000${seq}`;
  const handle = `t061-${tag}-${seq}`;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(NOW_MS);

  const signUp = async (email: string, name: string) => {
    const res = await handleBetterAuthRequest(
      makeRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
        origin: APP_ORIGIN,
        body: { email, password: "StrongPassword!2026", name },
      }),
      runtimeEnv,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { user?: { id: string } };
    return {
      userId: data.user?.id ?? "",
      cookie: extractCookiePair(res, APP_SESSION_COOKIE_NAME),
    };
  };

  const owner = await signUp(`owner-${tag}-${seq}@example.test`, `Owner ${tag}`);
  const admin = await signUp(`admin-${tag}-${seq}@example.test`, `Admin ${tag}`);
  const editor = await signUp(`editor-${tag}-${seq}@example.test`, `Editor ${tag}`);

  await db.insert(organizations).values({
    id: orgId,
    name: `Brand ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  const dayMs = 24 * 60 * 60 * 1000;
  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Brand ${tag} ${seq}`,
    vertical: "compro",
    status,
    operatorHold: false,
    trialEndsAt: status === "trial" ? new Date(NOW_MS + 5 * dayMs) : null,
    paidThrough:
      status === "active"
        ? new Date(NOW_MS + 30 * dayMs)
        : status === "locked"
          ? new Date(NOW_MS - 5 * dayMs)
          : null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(members).values([
    { id: `mem_o_${seq}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
    { id: `mem_a_${seq}`, organizationId: orgId, userId: admin.userId, role: "admin", createdAt: now },
    { id: `mem_e_${seq}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
  ]);

  return { tenantId, orgId, handle, owner, admin, editor };
}

describe("TASK-061 workerd integration — Custom Theme Service Packages, Requests & Delivery Grant", () => {
  const runtimeEnv = buildRuntimeEnv();
  let operator: Awaited<ReturnType<typeof createTwoFactorEnrolledOperatorFixture>>;
  let tenantA: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let tenantB: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let lockedTenant: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let raceTenant: Awaited<ReturnType<typeof provisionTenantFixture>>;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyCustomThemeServiceMigration(env.PLATFORM_DB);

    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "superadmin-t061@punyasitus.com",
      password: "OperatorStrongPassword!2026",
      name: "Superadmin T061",
      nowMs: NOW_MS,
    });

    // Configure platform sales WhatsApp & support email in platform_settings
    await updatePlatformSettings(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      nowMs: NOW_MS,
      requestId: "req_init_settings_t061",
      payload: {
        salesWhatsapp: "0812-9000-6161",
        supportEmail: "halo@punyasitus.com",
        termsUrl: "https://punyasitus.com/syarat",
        privacyUrl: "https://punyasitus.com/privasi",
        expectedVersion: 0,
        reason: "Konfigurasi awal nomor WhatsApp sales untuk pengujian TASK-061",
      },
    });

    tenantA = await provisionTenantFixture("alpha", "active", runtimeEnv);
    tenantB = await provisionTenantFixture("beta", "active", runtimeEnv);
    lockedTenant = await provisionTenantFixture("locked", "locked", runtimeEnv);
    raceTenant = await provisionTenantFixture("race", "active", runtimeEnv);
  });

  it("1. Empty package list shows clean contact-only state with default themes and ZERO invented packages", async () => {
    const res = await handleTenantCustomThemePackagesRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-packages`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const data = (await res.json()) as {
      packages: TenantCustomThemePackageDto[];
      defaultThemes: { id: string }[];
      grantedCustomThemes: { id: string }[];
      salesWhatsappConfigured: boolean;
      contactWhatsappUrl: string | null;
      dailyQuota: { used: number; limit: number; remaining: number };
    };
    expect(data.packages).toEqual([]);
    expect(data.defaultThemes.length).toBe(6);
    expect(data.grantedCustomThemes).toEqual([]);
    expect(data.salesWhatsappConfigured).toBe(true);
    expect(data.contactWhatsappUrl).toContain("https://wa.me/6281290006161?text=");
    expect(data.dailyQuota).toMatchObject({ used: 0, limit: 3, remaining: 3 });

    // Admin also allowed
    const adminRes = await handleTenantCustomThemePackagesRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-packages`, "GET", {
        cookie: tenantA.admin.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(adminRes.status).toBe(200);
  });

  it("2. Enforces strict RBAC, cross-tenant isolation, locked tenant denial, and host isolation", async () => {
    // Editor denied on packages & requests (403)
    const editorPkg = await handleTenantCustomThemePackagesRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-packages`, "GET", {
        cookie: tenantA.editor.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(editorPkg.status).toBe(403);

    const editorPost = await handleTenantCustomThemeRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
        cookie: tenantA.editor.cookie,
        idempotencyKey: "idem-editor-denied-01",
        body: { brandName: "Nope", brief: "Editor should not submit", referenceUrls: [] },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(editorPost.status).toBe(403);

    // Tenant B owner denied accessing Tenant A (404)
    const crossTenant = await handleTenantCustomThemePackagesRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-packages`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(crossTenant.status).toBe(404);

    // Locked tenant denied on packages API (403 SUBSCRIPTION_LOCKED), requests POST (403), and SSR page gate (302)
    const lockedApi = await handleTenantCustomThemePackagesRequest(
      lockedTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.handle}/custom-theme-packages`, "GET", {
        cookie: lockedTenant.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(lockedApi.status).toBe(403);

    const lockedPageGate = await loadCustomThemeServicePageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: lockedTenant.tenantId,
        handle: lockedTenant.handle,
        tenantName: "Locked Brand",
        userId: lockedTenant.owner.userId,
        role: "owner",
        tenantStatus: "locked",
      },
      nowMs: NOW_MS,
    });
    expect(lockedPageGate.ok).toBe(false);
    if (!lockedPageGate.ok) {
      expect(lockedPageGate.response.status).toBe(302);
      expect(lockedPageGate.response.headers.get("Location")).toBe(
        `/dashboard/${lockedTenant.handle}/service-status`,
      );
    }

    // Console endpoints return 404 on non-console hosts (app.punyasitus.com)
    const consoleOnAppHost = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${APP_ORIGIN}/api/console/custom-themes/packages`, "GET"),
      runtimeEnv,
      {
        session: { id: operator.session.id, userId: operator.user.id },
        user: { id: operator.user.id, email: operator.user.email },
        nowMs: NOW_MS,
      },
    );
    expect(consoleOnAppHost.status).toBe(404);

    // Tenant user with a real session denied on console host (403)
    const tenantSession = await env.PLATFORM_DB.prepare(
      "SELECT id FROM sessions WHERE user_id = ? LIMIT 1",
    )
      .bind(tenantA.owner.userId)
      .first<{ id: string }>();
    expect(tenantSession?.id).toBeTruthy();

    const tenantOnConsole = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "GET"),
      runtimeEnv,
      {
        session: { id: tenantSession!.id, userId: tenantA.owner.userId },
        user: { id: tenantA.owner.userId, email: "owner-alpha@example.test" },
        nowMs: NOW_MS,
      },
    );
    expect(tenantOnConsole.status).toBe(403);

    // Console mutation without fresh 2FA step-up rejected (403 REAUTH_REQUIRED)
    const staleStepUpRes = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
        body: {
          slug: "stale-stepup-pkg",
          name: "Stale StepUp",
          description: "Should fail without recent 2FA verification.",
          inclusions: ["Item 1"],
          startingPriceIdr: 2_500_000,
          estimatedDuration: "7 hari kerja",
          sortOrder: 10,
          active: true,
          reason: "Pengujian verifikasi 2FA step-up kedaluwarsa",
        },
      }),
      runtimeEnv,
      {
        session: { id: operator.session.id, userId: operator.user.id },
        user: { id: operator.user.id, email: operator.user.email },
        nowMs: NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000,
      },
    );
    expect(staleStepUpRes.status).toBe(403);
  });

  let pkgQuoteId = "";
  let pkgPricedId = "";
  let pkgPricedVersion = 1;

  it("3. Operators create, edit, reorder, and deactivate packages with version lock and atomic audit", async () => {
    const opOpts = {
      session: { id: operator.session.id, userId: operator.user.id },
      user: { id: operator.user.id, email: operator.user.email },
      nowMs: NOW_MS,
    };

    // Create 3 packages:
    // 1) Priced package (sortOrder: 20)
    const createPriced = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
        body: {
          slug: "brand-pro",
          name: "Paket Brand Pro",
          description: "Tema kustom lengkap untuk profil bisnis & katalog layanan.",
          inclusions: ["Desain khusus 5 halaman", "2 putaran revisi", "Optimasi Core Web Vitals"],
          startingPriceIdr: 4_500_000,
          estimatedDuration: "10–14 hari kerja",
          sortOrder: 20,
          active: true,
          reason: "Menambahkan paket tema kustom Brand Pro ke katalog resmi",
        },
      }),
      runtimeEnv,
      opOpts,
    );
    expect(createPriced.status).toBe(201);
    const pricedJson = (await createPriced.json()) as {
      package: { id: string; version: number; priceLabel: string };
      auditId: string;
    };
    pkgPricedId = pricedJson.package.id;
    pkgPricedVersion = pricedJson.package.version;
    expect(pricedJson.package.priceLabel).toBe("Mulai dari Rp 4.500.000");
    expect(pricedJson.auditId).toBeTruthy();

    // 2) Quote-only package (sortOrder: 10 — should render FIRST!)
    const createQuote = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
        body: {
          slug: "enterprise-bespoke",
          name: "Paket Korporat & Agensi",
          description: "Tema kustom berskala besar berdasarkan ruang lingkup proyek.",
          inclusions: ["Workshop sistem desain", "Halaman & komponen khusus"],
          startingPriceIdr: null,
          estimatedDuration: "3–4 minggu",
          sortOrder: 10,
          active: true,
          reason: "Menambahkan paket tema kustom berbasis penawaran khusus",
        },
      }),
      runtimeEnv,
      opOpts,
    );
    expect(createQuote.status).toBe(201);
    const quoteJson = (await createQuote.json()) as {
      package: { id: string; priceLabel: string };
    };
    pkgQuoteId = quoteJson.package.id;
    expect(quoteJson.package.priceLabel).toBe("Harga berdasarkan penawaran");

    // 3) Inactive package (sortOrder: 1 — MUST NOT appear for tenants!)
    const createInactive = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
        body: {
          slug: "draft-hidden-pkg",
          name: "Paket Draf Tersembunyi",
          description: "Belum dipublikasikan untuk tenant.",
          inclusions: ["Draf internal"],
          startingPriceIdr: 9_000_000,
          estimatedDuration: "2 minggu",
          sortOrder: 1,
          active: false,
          reason: "Membuat paket draf nonaktif untuk uji visibilitas tenant",
        },
      }),
      runtimeEnv,
      opOpts,
    );
    expect(createInactive.status).toBe(201);

    // Tenant sees ONLY active packages sorted by sort_order ASC (10 before 20)
    const tenantList = await handleTenantCustomThemePackagesRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-packages`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(tenantList.status).toBe(200);
    const tenantListJson = (await tenantList.json()) as {
      packages: TenantCustomThemePackageDto[];
    };
    expect(tenantListJson.packages.map((p) => p.slug)).toEqual(["enterprise-bespoke", "brand-pro"]);
    expect(tenantListJson.packages[0]?.priceLabel).toBe("Harga berdasarkan penawaran");
    expect(tenantListJson.packages[1]?.priceLabel).toBe("Mulai dari Rp 4.500.000");

    // Edit with stale version fails with 409 STALE_VERSION
    const staleEdit = await handleConsoleCustomThemePackageDetailRequest(
      pkgPricedId,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages/${pkgPricedId}`, "PATCH", {
        body: {
          expectedVersion: 99,
          startingPriceIdr: 5_000_000,
          reason: "Uji penolakan versi usang pada pembaruan paket",
        },
      }),
      runtimeEnv,
      opOpts,
    );
    expect(staleEdit.status).toBe(409);

    // Edit with valid version succeeds & increments version + writes audit
    const validEdit = await handleConsoleCustomThemePackageDetailRequest(
      pkgPricedId,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages/${pkgPricedId}`, "PATCH", {
        body: {
          expectedVersion: pkgPricedVersion,
          startingPriceIdr: 5_250_000,
          reason: "Penyesuaian harga mulai Paket Brand Pro untuk kuartal baru",
        },
      }),
      runtimeEnv,
      opOpts,
    );
    expect(validEdit.status).toBe(200);
    const editedJson = (await validEdit.json()) as {
      package: { version: number; priceLabel: string };
    };
    expect(editedJson.package.version).toBe(2);
    expect(editedJson.package.priceLabel).toBe("Mulai dari Rp 5.250.000");
    pkgPricedVersion = editedJson.package.version;

    // Verify audit trail recorded package mutations
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      targetType: "custom_theme_package",
      targetId: pkgPricedId,
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.some((a) => a.action === "custom_theme.package.created")).toBe(true);
    expect(audits.some((a) => a.action === "custom_theme.package.updated")).toBe(true);
  });

  let createdRequestId = "";
  let createdRequestCode = "";

  it("4. Enforces HTTPS-only/5-URL validation, zero-fetch, idempotent retry, single-encoded WA link, operator email, and atomic 3/day cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      // Reject non-HTTPS / private URL
      const badUrlRes = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-bad-url-0001",
          body: {
            packageId: pkgPricedId,
            brandName: "Alpha Konsultan",
            brief: "Uji penolakan URL tidak aman.",
            referenceUrls: ["http://insecure.example.com", "https://127.0.0.1/secret"],
            contactPreference: "whatsapp",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(badUrlRes.status).toBe(422);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Reject >5 URLs
      const sixUrlRes = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-six-url-0001",
          body: {
            packageId: pkgPricedId,
            brandName: "Alpha Konsultan",
            brief: "Uji batas maksimal 5 URL referensi.",
            referenceUrls: [
              "https://ref1.example.com",
              "https://ref2.example.com",
              "https://ref3.example.com",
              "https://ref4.example.com",
              "https://ref5.example.com",
              "https://ref6.example.com",
            ],
            contactPreference: "whatsapp",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(sixUrlRes.status).toBe(422);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Valid submission #1
      const submit1 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-001",
          body: {
            packageId: pkgPricedId,
            brandName: "Alpha Konsultan Nusantara",
            brief: "Butuh desain modern bergaya editorial korporat dengan tone hijau zamrud.",
            referenceUrls: ["https://ref1.example.com/inspo", "https://ref2.example.com/brand"],
            budgetRange: "Rp 5 jt – Rp 7 jt",
            contactPreference: "whatsapp",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(submit1.status).toBe(201);
      expect(fetchSpy).not.toHaveBeenCalled();

      const s1Json = (await submit1.json()) as {
        created: boolean;
        idempotentReplay: boolean;
        request: TenantCustomThemeRequestDto;
        dailyQuota: { used: number; remaining: number };
      };
      expect(s1Json.created).toBe(true);
      expect(s1Json.idempotentReplay).toBe(false);
      expect(s1Json.dailyQuota).toMatchObject({ used: 1, remaining: 2 });
      createdRequestId = s1Json.request.id;
      createdRequestCode = s1Json.request.requestCode;

      // Verify single-encoded WA link carries handle, requestCode, and packageName
      expect(s1Json.request.whatsappUrl).toBeTruthy();
      expect(s1Json.request.whatsappUrl!).not.toContain("%2520");
      const decodedWaText = new URL(s1Json.request.whatsappUrl!).searchParams.get("text") ?? "";
      expect(decodedWaText).toContain(tenantA.handle);
      expect(decodedWaText).toContain(createdRequestCode);
      expect(decodedWaText).toContain("Paket Brand Pro");

      // Verify operator email notification job was enqueued in job_ledger
      const emailJob = await env.PLATFORM_DB.prepare(
        `SELECT idempotency_key, topic, tenant_id
         FROM job_ledger
         WHERE topic = 'email.transactional.send'
           AND idempotency_key LIKE ?
         LIMIT 1`,
      )
        .bind(`custom-theme-request:${createdRequestId}:%`)
        .first<{ idempotency_key: string; topic: string; tenant_id: string }>();
      expect(emailJob).toBeTruthy();
      expect(emailJob?.tenant_id).toBe(tenantA.tenantId);

      // Idempotent retry with SAME key returns 200 without duplicating!
      const retry1 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-001",
          body: {
            packageId: pkgPricedId,
            brandName: "Alpha Konsultan Nusantara",
            brief: "Butuh desain modern bergaya editorial korporat dengan tone hijau zamrud.",
            referenceUrls: ["https://ref1.example.com/inspo", "https://ref2.example.com/brand"],
            budgetRange: "Rp 5 jt – Rp 7 jt",
            contactPreference: "whatsapp",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(retry1.status).toBe(200);
      const retry1Json = (await retry1.json()) as {
        created: boolean;
        idempotentReplay: boolean;
        request: TenantCustomThemeRequestDto;
        dailyQuota: { used: number };
      };
      expect(retry1Json.created).toBe(false);
      expect(retry1Json.idempotentReplay).toBe(true);
      expect(retry1Json.request.id).toBe(createdRequestId);
      expect(retry1Json.dailyQuota.used).toBe(1);

      // Reusing SAME Idempotency-Key with a DIFFERENT payload returns 409 IDEMPOTENCY_KEY_REUSED and keeps original untouched!
      const reusedKeyMismatch = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-001",
          body: {
            packageId: pkgPricedId,
            brandName: "Modified Brand Name",
            brief: "Different brief attempting to reuse an existing idempotency key.",
            referenceUrls: ["https://ref1.example.com/inspo"],
            budgetRange: "Rp 9 jt",
            contactPreference: "email",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(reusedKeyMismatch.status).toBe(409);
      const mismatchErr = (await reusedKeyMismatch.json()) as { error: { code: string } };
      expect(mismatchErr.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      const originalCheck = await handleTenantCustomThemeRequestDetail(
        tenantA.handle,
        createdRequestId,
        makeRequest(
          `${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests/${createdRequestId}`,
          "GET",
          { cookie: tenantA.owner.cookie },
        ),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(originalCheck.status).toBe(200);
      const origCheckJson = (await originalCheck.json()) as {
        request: TenantCustomThemeRequestDto;
      };
      expect(origCheckJson.request.brandName).toBe("Alpha Konsultan Nusantara");
      expect(origCheckJson.request.brief).toContain("hijau zamrud");

      // Cross-tenant detail read denied with 404
      const crossDetail = await handleTenantCustomThemeRequestDetail(
        tenantB.handle,
        createdRequestId,
        makeRequest(
          `${APP_ORIGIN}/api/tenants/${tenantB.handle}/custom-theme-requests/${createdRequestId}`,
          "GET",
          { cookie: tenantB.owner.cookie },
        ),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(crossDetail.status).toBe(404);

      // Submit #2 (undecided package) & #3 (quote-only package)
      const submit2 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.admin.cookie,
          idempotencyKey: "idem-alpha-req-002",
          body: {
            packageId: null,
            brandName: "Alpha Konsultan 2",
            brief: "Konsultasi awal belum memilih paket.",
            referenceUrls: [],
            contactPreference: "email",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(submit2.status).toBe(201);

      const submit3 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-003",
          body: {
            packageId: pkgQuoteId,
            brandName: "Alpha Konsultan 3",
            brief: "Permintaan ketiga hari ini untuk paket enterprise.",
            referenceUrls: ["https://ref3.example.com"],
            contactPreference: "both",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(submit3.status).toBe(201);

      // Idempotent retry of #3 STILL succeeds at limit (200)
      const retry3 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-003",
          body: {
            packageId: pkgQuoteId,
            brandName: "Alpha Konsultan 3",
            brief: "Permintaan ketiga hari ini untuk paket enterprise.",
            referenceUrls: ["https://ref3.example.com"],
            contactPreference: "both",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(retry3.status).toBe(200);

      // 4th distinct request today fails atomically with 429 DAILY_REQUEST_LIMIT_REACHED
      const submit4 = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
          cookie: tenantA.owner.cookie,
          idempotencyKey: "idem-alpha-req-004",
          body: {
            packageId: null,
            brandName: "Alpha Keempat",
            brief: "Harus ditolak karena melebihi batas 3 per hari.",
            referenceUrls: [],
            contactPreference: "whatsapp",
          },
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(submit4.status).toBe(429);
      const s4Err = (await submit4.json()) as { error: { code: string } };
      expect(s4Err.error.code).toBe("DAILY_REQUEST_LIMIT_REACHED");

      // Concurrent race test: 5 parallel distinct requests on fresh raceTenant -> strictly 3 succeed!
      const parallelResponses = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          handleTenantCustomThemeRequestsRequest(
            raceTenant.handle,
            makeRequest(
              `${APP_ORIGIN}/api/tenants/${raceTenant.handle}/custom-theme-requests`,
              "POST",
              {
                cookie: raceTenant.owner.cookie,
                idempotencyKey: `idem-race-req-00${n}`,
                body: {
                  packageId: null,
                  brandName: `Race Brand ${n}`,
                  brief: `Parallel submission attempt #${n}`,
                  referenceUrls: [],
                  contactPreference: "whatsapp",
                },
              },
            ),
            runtimeEnv,
            { nowMs: NOW_MS },
          ),
        ),
      );
      const createdCount = parallelResponses.filter((r) => r.status === 201).length;
      const limitedCount = parallelResponses.filter((r) => r.status === 429).length;
      expect(createdCount).toBe(3);
      expect(limitedCount).toBe(2);

      // Deactivating referenced package preserves existing requests and hides package from active list
      const deactRes = await handleConsoleCustomThemePackageDetailRequest(
        pkgPricedId,
        makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages/${pkgPricedId}`, "PATCH", {
          body: {
            expectedVersion: pkgPricedVersion,
            active: false,
            reason: "Menonaktifkan Paket Brand Pro tanpa menghapus permintaan lama",
          },
        }),
        runtimeEnv,
        {
          session: { id: operator.session.id, userId: operator.user.id },
          user: { id: operator.user.id, email: operator.user.email },
          nowMs: NOW_MS,
        },
      );
      expect(deactRes.status).toBe(200);

      const tenantReqsAfterDeact = await handleTenantCustomThemeRequestsRequest(
        tenantA.handle,
        makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "GET", {
          cookie: tenantA.owner.cookie,
        }),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      expect(tenantReqsAfterDeact.status).toBe(200);
      const listJson = (await tenantReqsAfterDeact.json()) as {
        requests: TenantCustomThemeRequestDto[];
      };
      expect(listJson.requests.some((r) => r.id === createdRequestId)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("5. Transitions request status with reason & audit, blocks delivered without theme grant, and makes delivered theme activatable", async () => {
    const opOpts = {
      session: { id: operator.session.id, userId: operator.user.id },
      user: { id: operator.user.id, email: operator.user.email },
      nowMs: NOW_MS,
    };

    // Console list returns tenantA's request
    const listRes = await handleConsoleCustomThemeRequestsListRequest(
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests?tenant=${tenantA.handle}`,
        "GET",
      ),
      runtimeEnv,
      opOpts,
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      requests: { id: string; status: string; version: number }[];
    };
    const targetReq = listData.requests.find((r) => r.id === createdRequestId);
    expect(targetReq?.status).toBe("new");

    // Transition new -> in_progress with mandatory reason
    const toProgress = await handleConsoleCustomThemeRequestDetail(
      createdRequestId,
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${createdRequestId}`,
        "PATCH",
        {
          body: {
            expectedVersion: targetReq!.version,
            status: "in_progress",
            reason: "Klien menyetujui penawaran dan pengerjaan tema dimulai",
            operatorNotes: "Target selesai minggu depan",
          },
        },
      ),
      runtimeEnv,
      opOpts,
    );
    expect(toProgress.status).toBe(200);
    const progressData = (await toProgress.json()) as {
      request: { status: string; version: number };
      auditId: string;
    };
    expect(progressData.request.status).toBe("in_progress");
    expect(progressData.auditId).toBeTruthy();

    // Attempt to mark `delivered` with an unregistered catalog-only theme -> 409 THEME_NOT_REGISTERED!
    const deliverUnregistered = await handleConsoleCustomThemeRequestDetail(
      createdRequestId,
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${createdRequestId}`,
        "PATCH",
        {
          body: {
            expectedVersion: progressData.request.version,
            status: "delivered",
            deliveredThemeId: "custom-not-in-registry",
            reason: "Mencoba menandai selesai dengan tema yang belum terdaftar di registri kode",
          },
        },
      ),
      runtimeEnv,
      opOpts,
    );
    expect(deliverUnregistered.status).toBe(409);
    const unregErr = (await deliverUnregistered.json()) as { error: { code: string } };
    expect(unregErr.error.code).toBe("THEME_NOT_REGISTERED");

    // Attempt to mark `delivered` WITHOUT an active tenant_theme_entitlements grant -> 409 THEME_GRANT_REQUIRED!
    const deliverWithoutGrant = await handleConsoleCustomThemeRequestDetail(
      createdRequestId,
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${createdRequestId}`,
        "PATCH",
        {
          body: {
            expectedVersion: progressData.request.version,
            status: "delivered",
            deliveredThemeId: "custom-sample-agency",
            reason: "Mencoba menandai selesai sebelum izin tema diberikan",
          },
        },
      ),
      runtimeEnv,
      opOpts,
    );
    expect(deliverWithoutGrant.status).toBe(409);
    const noGrantErr = (await deliverWithoutGrant.json()) as { error: { code: string } };
    expect(noGrantErr.error.code).toBe("THEME_GRANT_REQUIRED");

    // Grant registered custom theme `custom-sample-agency` to Tenant A
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(NOW_MS);
    await db
      .insert(themeCatalog)
      .values({
        id: "custom-sample-agency",
        slug: "custom-sample-agency",
        name: "Sample Agency Bespoke",
        tier: "custom",
        priceIdr: 0,
        active: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await db.insert(tenantThemeEntitlements).values({
      id: "01JT061GRANT00000000000001",
      tenantId: tenantA.tenantId,
      themeId: "custom-sample-agency",
      grantedBy: operator.user.id,
      settlementId: null,
      grantedAt: now,
    });

    // Now mark `delivered` WITH active theme grant -> 200 OK!
    const deliverWithGrant = await handleConsoleCustomThemeRequestDetail(
      createdRequestId,
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${createdRequestId}`,
        "PATCH",
        {
          body: {
            expectedVersion: progressData.request.version,
            status: "delivered",
            deliveredThemeId: "custom-sample-agency",
            reason: "Tema kustom custom-sample-agency telah selesai dan diberikan izin aktif",
          },
        },
      ),
      runtimeEnv,
      opOpts,
    );
    expect(deliverWithGrant.status).toBe(200);
    const deliveredJson = (await deliverWithGrant.json()) as {
      request: {
        status: string;
        version: number;
        deliveredThemeId: string | null;
        deliveredThemeGrantId: string | null;
      };
      auditId: string;
    };
    expect(deliveredJson.request.status).toBe("delivered");
    expect(deliveredJson.request.deliveredThemeId).toBe("custom-sample-agency");
    expect(deliveredJson.request.deliveredThemeGrantId).toBe("01JT061GRANT00000000000001");
    expect(deliveredJson.auditId).toBeTruthy();

    // Terminal state transition rejected (409)
    const terminalAttempt = await handleConsoleCustomThemeRequestDetail(
      createdRequestId,
      makeRequest(
        `${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${createdRequestId}`,
        "PATCH",
        {
          body: {
            expectedVersion: deliveredJson.request.version,
            status: "cancelled",
            reason: "Mencoba membatalkan permintaan yang sudah diserahkan",
          },
        },
      ),
      runtimeEnv,
      opOpts,
    );
    expect(terminalAttempt.status).toBe(409);

    // End-to-end activation proof (REQ-063 + REQ-046): Tenant A sees & activates delivered custom theme!
    const tenantDb = await openMigratedTenantDb(tenantA.tenantId);
    const listThemesRes = await handleTenantThemesListRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/themes`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS, resolveTenantDb: () => tenantDb },
    );
    expect(listThemesRes.status).toBe(200);
    const themesState = (await listThemesRes.json()) as {
      version: number;
      themes: { id: string; isCustom: boolean; compatibility: { compatible: boolean } }[];
    };
    const grantedEntry = themesState.themes.find((t) => t.id === "custom-sample-agency");
    expect(grantedEntry).toBeTruthy();
    expect(grantedEntry?.isCustom).toBe(true);
    expect(grantedEntry?.compatibility.compatible).toBe(true);

    const activateRes = await handleTenantThemesActivateRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/themes/activate`, "POST", {
        cookie: tenantA.owner.cookie,
        body: {
          themeId: "custom-sample-agency",
          expectedVersion: themesState.version,
          confirm: true,
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS, resolveTenantDb: () => tenantDb },
    );
    expect(activateRes.status).toBe(200);
    const activated = (await activateRes.json()) as { activeThemeId: string };
    expect(activated.activeThemeId).toBe("custom-sample-agency");

    // Audit trail contains both status change and delivery
    const reqAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      targetType: "custom_theme_request",
      targetId: createdRequestId,
    });
    expect(reqAudits.some((a) => a.action === "custom_theme.request.status_changed")).toBe(true);
    expect(reqAudits.some((a) => a.action === "custom_theme.request.delivered")).toBe(true);
  });
});
