import { env } from "cloudflare:workers";
import {
  APP_SESSION_COOKIE_NAME,
  applySessionTwoFactorMigration,
  AuthorizationError,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  resolveAuthorizedTenantMember,
} from "@punyasitus/auth";
import {
  createMemberInvitation,
  InvitationError,
  removeTenantMember,
  revokeMemberInvitation,
  updateTenantMemberRole,
} from "@punyasitus/auth/invitations/index";
import {
  applyPlatformMigrations,
  createSqliteDrizzle,
} from "@punyasitus/db/connections";
import { applySetupServiceStaffDeliveryMigration } from "@punyasitus/db/custom-themes/migrations";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformOperators,
  platformSchema,
  tenants,
  updatePlatformSettings,
} from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleConsoleCustomThemePackageDetailRequest } from "../../apps/web/src/pages/api/console/custom-themes/packages/[packageId].ts";
import { handleConsoleCustomThemePackagesRequest } from "../../apps/web/src/pages/api/console/custom-themes/packages/index.ts";
import { handleConsoleCustomThemeRequestDetail } from "../../apps/web/src/pages/api/console/custom-themes/requests/[requestId].ts";
import { handleConsoleCustomThemeRequestsListRequest } from "../../apps/web/src/pages/api/console/custom-themes/requests/index.ts";
import { handleTenantCustomThemeRequestsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/custom-theme-requests/index.ts";
import { handleTenantServiceRequestDetail } from "../../apps/web/src/pages/api/tenants/[tenantId]/service-requests/[requestId].ts";
import { handleTenantSetupStaffAccessRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/service-requests/[requestId]/staff-access.ts";
import type {
  TenantServiceRequestRuntimeEnv,
  TenantSetupPackageDto,
  TenantSetupRequestDto,
  TenantSetupSeatsDto,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/service-requests/_shared.ts";
import { handleTenantServiceRequestsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/service-requests/index.ts";
import { loadSetupServicePageOrGateResponse } from "../../apps/web/src/pages/dashboard/[handle]/setup-service/_page-gate.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const NOW_MS = Date.UTC(2026, 10, 23, 8, 0, 0);

function buildRuntimeEnv(
  overrides: Partial<TenantServiceRequestRuntimeEnv> = {},
): TenantServiceRequestRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
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

async function signUpUser(
  runtimeEnv: TenantServiceRequestRuntimeEnv,
  email: string,
  name: string,
) {
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
    email,
    name,
    cookie: extractCookiePair(res, APP_SESSION_COOKIE_NAME),
  };
}

let tenantSeq = 1;
async function provisionTenantFixture(
  tag: string,
  status: "active" | "trial" | "locked" | "suspended" | "purged",
  runtimeEnv: TenantServiceRequestRuntimeEnv,
) {
  const seq = String(tenantSeq++).padStart(4, "0");
  const tenantId = `01JT069TENANT000000000${seq}`;
  const orgId = `01JT069ORG000000000000${seq}`;
  const handle = `t069-${tag}-${seq}`;
  const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
  const now = new Date(NOW_MS);

  const owner = await signUpUser(runtimeEnv, `owner-${tag}-${seq}@example.test`, `Owner ${tag}`);
  const admin = await signUpUser(runtimeEnv, `admin-${tag}-${seq}@example.test`, `Admin ${tag}`);
  const editor = await signUpUser(runtimeEnv, `editor-${tag}-${seq}@example.test`, `Editor ${tag}`);

  await db.insert(organizations).values({
    id: orgId,
    name: `Usaha ${tag} ${seq}`,
    slug: `org-${handle}`,
    createdAt: now,
    updatedAt: now,
  });

  const dayMs = 24 * 60 * 60 * 1000;
  await db.insert(tenants).values({
    id: tenantId,
    organizationId: orgId,
    handle,
    name: `Usaha ${tag} ${seq}`,
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
    { id: `mem69_o_${seq}`, organizationId: orgId, userId: owner.userId, role: "owner", createdAt: now },
    { id: `mem69_a_${seq}`, organizationId: orgId, userId: admin.userId, role: "admin", createdAt: now },
    { id: `mem69_e_${seq}`, organizationId: orgId, userId: editor.userId, role: "editor", createdAt: now },
  ]);

  return { tenantId, orgId, handle, owner, admin, editor };
}

describe("TASK-069 workerd integration — Terima Beres Setup Service Packages, Requests & Staff Membership Lifecycle", () => {
  const runtimeEnv = buildRuntimeEnv();
  let operator: Awaited<ReturnType<typeof createTwoFactorEnrolledOperatorFixture>>;
  let staffUser: Awaited<ReturnType<typeof signUpUser>>;
  let nonOperatorUser: Awaited<ReturnType<typeof signUpUser>>;
  let tenantA: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let tenantB: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let lockedTenant: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let fullSeatsTenant: Awaited<ReturnType<typeof provisionTenantFixture>>;
  let hardeningTenant: Awaited<ReturnType<typeof provisionTenantFixture>>;

  let activePricedSetupPkgId = "";
  let activeQuoteSetupPkgId = "";
  let setupReqDeliveredId = "";

  const opOpts = () => ({
    session: { id: operator.session.id, userId: operator.user.id },
    user: { id: operator.user.id, email: operator.user.email },
    nowMs: NOW_MS,
  });

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    // Verify bundled migration helper is idempotent when invoked twice
    await applySetupServiceStaffDeliveryMigration(env.PLATFORM_DB);
    await applySetupServiceStaffDeliveryMigration(env.PLATFORM_DB);

    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "superadmin-t069@punyasitus.com",
      password: "OperatorStrongPassword!2026",
      name: "Superadmin T069",
      nowMs: NOW_MS,
    });

    await updatePlatformSettings(env.PLATFORM_DB, {
      actorUserId: operator.user.id,
      nowMs: NOW_MS,
      requestId: "req_init_settings_t069",
      payload: {
        salesWhatsapp: "0812-9000-6969",
        supportEmail: "halo@punyasitus.com",
        termsUrl: "https://punyasitus.com/syarat",
        privacyUrl: "https://punyasitus.com/privasi",
        expectedVersion: 0,
        reason: "Konfigurasi awal nomor WhatsApp sales untuk pengujian TASK-069",
      },
    });

    staffUser = await signUpUser(runtimeEnv, "spesialis-setup@punyasitus.com", "Rina Tim Setup");
    nonOperatorUser = await signUpUser(runtimeEnv, "random-user@example.test", "Pengguna Biasa");

    // Grant active platform_operators record to `staffUser` (required by Finding #6)
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await db.insert(platformOperators).values({
      userId: staffUser.userId,
      grantedBy: operator.user.id,
      reason: "Active setup delivery specialist operator grant for TASK-069 tests",
      grantedAt: new Date(NOW_MS),
      revokedAt: null,
    });

    tenantA = await provisionTenantFixture("alpha", "active", runtimeEnv);
    tenantB = await provisionTenantFixture("beta", "active", runtimeEnv);
    lockedTenant = await provisionTenantFixture("locked", "locked", runtimeEnv);
    fullSeatsTenant = await provisionTenantFixture("fullseat", "active", runtimeEnv);
    hardeningTenant = await provisionTenantFixture("harden", "active", runtimeEnv);
  });

  it("1. Shows clean empty setup state to owner/admin and denies editors, cross-tenant users, non-app hosts, and locked tenants", async () => {
    // Owner allowed
    const ownerRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(ownerRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const ownerJson = (await ownerRes.json()) as {
      packages: TenantSetupPackageDto[];
      requests: TenantSetupRequestDto[];
      seats: TenantSetupSeatsDto;
      canApproveStaff: boolean;
      contactWhatsappUrl: string | null;
    };
    expect(ownerJson.packages).toEqual([]);
    expect(ownerJson.requests).toEqual([]);
    expect(ownerJson.canApproveStaff).toBe(true);
    expect(ownerJson.seats).toMatchObject({ seatsUsed: 3, seatsLimit: 5, seatsRemaining: 2 });
    expect(ownerJson.contactWhatsappUrl).toContain("https://wa.me/6281290006969?text=");

    // Admin allowed to view & submit, but cannot approve staff membership
    const adminRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantA.admin.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(adminRes.status).toBe(200);
    const adminJson = (await adminRes.json()) as { canApproveStaff: boolean };
    expect(adminJson.canApproveStaff).toBe(false);

    // Editor denied (403)
    const editorRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantA.editor.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(editorRes.status).toBe(403);

    // Cross-tenant denied (404)
    const crossRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(crossRes.status).toBe(404);

    // Locked tenant denied on API (403 SUBSCRIPTION_LOCKED) and page gate (302 /service-status)
    const lockedRes = await handleTenantServiceRequestsRequest(
      lockedTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${lockedTenant.handle}/service-requests`, "GET", {
        cookie: lockedTenant.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(lockedRes.status).toBe(403);
    const lockedErr = (await lockedRes.json()) as { error: { code: string } };
    expect(lockedErr.error.code).toBe("SUBSCRIPTION_LOCKED");

    const lockedPageGate = await loadSetupServicePageOrGateResponse({
      platformDb: env.PLATFORM_DB,
      member: {
        tenantId: lockedTenant.tenantId,
        handle: lockedTenant.handle,
        tenantName: "Locked",
        userId: lockedTenant.owner.userId,
        role: "owner",
        tenantStatus: "locked",
      },
      nowMs: NOW_MS,
    });
    expect(lockedPageGate.ok).toBe(false);
    if (!lockedPageGate.ok) {
      expect(lockedPageGate.response.status).toBe(302);
    }

    // Tenant host returns 404
    const wrongHost = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`https://${tenantA.handle}.situsku.click/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(wrongHost.status).toBe(404);
  });

  it("2. Superadmin creates setup packages in sort order with audit while keeping custom_theme packages strictly isolated", async () => {
    // Non-console host returns 404
    const nonConsoleRes = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${APP_ORIGIN}/api/console/custom-themes/packages`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nonConsoleRes.status).toBe(404);

    // Stale step-up rejected (403)
    const staleStepUpRes = await handleConsoleCustomThemePackagesRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
        origin: CONSOLE_ORIGIN,
        body: {
          serviceKind: "setup",
          slug: "setup-stale-test",
          name: "Stale Test",
          description: "Seharusnya gagal karena 2FA kedaluwarsa",
          inclusions: ["Item 1"],
          startingPriceIdr: 500000,
          estimatedDuration: "3 hari",
          sortOrder: 1,
          active: true,
          reason: "Percobaan membuat paket saat step-up 2FA sudah kedaluwarsa",
        },
      }),
      runtimeEnv,
      {
        ...opOpts(),
        nowMs: NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000,
      },
    );
    expect(staleStepUpRes.status).toBe(403);

    // Create 3 packages: active priced setup (sort 10), active quote-only setup (sort 20), inactive setup (sort 5), and a custom_theme pkg
    const createPkg = async (body: Record<string, unknown>) => {
      const res = await handleConsoleCustomThemePackagesRequest(
        makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages`, "POST", {
          origin: CONSOLE_ORIGIN,
          body,
        }),
        runtimeEnv,
        opOpts(),
      );
      expect(res.status).toBe(201);
      return (await res.json()) as { package: { id: string; slug: string; version: number }; auditId: string };
    };

    const priced = await createPkg({
      serviceKind: "setup",
      slug: "setup-umkm-kilat",
      name: "Terima Beres UMKM Kilat",
      description: "Penyiapan beranda, profil bisnis, dan 5 layanan/produk utama.",
      inclusions: ["Input profil bisnis & logo", "5 halaman & layanan inti", "Integrasi WhatsApp CTA"],
      startingPriceIdr: 1_250_000,
      estimatedDuration: "3–5 hari kerja",
      sortOrder: 10,
      active: true,
      reason: "Menambahkan paket Terima Beres UMKM Kilat untuk katalog aktif",
    });
    activePricedSetupPkgId = priced.package.id;
    expect(priced.auditId).toBeTruthy();

    const quote = await createPkg({
      serviceKind: "setup",
      slug: "setup-korporat-penawaran",
      name: "Terima Beres Korporat",
      description: "Setup penuh multi-cabang dan katalog besar sesuai kebutuhan perusahaan.",
      inclusions: ["Migrasi materi hingga 50 item", "Setup multi-cabang & formulir"],
      startingPriceIdr: null,
      estimatedDuration: "7–10 hari kerja",
      sortOrder: 20,
      active: true,
      reason: "Menambahkan paket Terima Beres Korporat berbasis penawaran",
    });
    activeQuoteSetupPkgId = quote.package.id;

    await createPkg({
      serviceKind: "setup",
      slug: "setup-nonaktif",
      name: "Paket Setup Arsip",
      description: "Paket setup nonaktif yang tidak boleh muncul di tenant.",
      inclusions: ["Arsip"],
      startingPriceIdr: 900_000,
      estimatedDuration: "3 hari",
      sortOrder: 5,
      active: false,
      reason: "Menambahkan paket setup nonaktif untuk memastikan filter aktif bekerja",
    });

    await createPkg({
      serviceKind: "custom_theme",
      slug: "tema-kustom-terpisah",
      name: "Tema Kustom Eksklusif",
      description: "Paket tema kustom yang tidak boleh tercampur di halaman setup.",
      inclusions: ["Desain tema bespoke"],
      startingPriceIdr: 5_000_000,
      estimatedDuration: "14 hari kerja",
      sortOrder: 1,
      active: true,
      reason: "Menambahkan paket tema kustom untuk verifikasi isolasi service_kind",
    });

    // Verify stale version rejection on package PATCH
    const stalePatch = await handleConsoleCustomThemePackageDetailRequest(
      activePricedSetupPkgId,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/packages/${activePricedSetupPkgId}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 99,
          name: "Stale Update",
          reason: "Percobaan pembaruan versi lama harus gagal 409",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(stalePatch.status).toBe(409);

    // Tenant sees ONLY the 2 active `setup` packages in sort order (10 then 20)
    const tenantRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "GET", {
        cookie: tenantA.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(tenantRes.status).toBe(200);
    const data = (await tenantRes.json()) as { packages: TenantSetupPackageDto[] };
    expect(data.packages.map((p) => p.slug)).toEqual([
      "setup-umkm-kilat",
      "setup-korporat-penawaran",
    ]);
    expect(data.packages[0]?.priceLabel).toBe("Mulai dari Rp 1.250.000");
    expect(data.packages[1]?.priceLabel).toBe("Harga berdasarkan penawaran");
    expect(data.packages[1]?.isQuoteOnly).toBe(true);
  });

  it("3. Submits idempotent, 3/day-capped setup requests with strict Zod schema while keeping custom_theme quota independent", async () => {
    // Reject unknown/forbidden fields
    const badFieldRes = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-bad-field-001",
        body: {
          packageId: activePricedSetupPkgId,
          brandName: "Usaha Alpha",
          brief: "Tolong bantu setup situs kami.",
          status: "delivered",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(badFieldRes.status).toBe(422);

    // Submit setup request #1 (201)
    const payload1 = {
      packageId: activePricedSetupPkgId,
      brandName: "Klinik Alpha Sehat",
      brief: "Mohon bantu isi halaman beranda, 5 layanan perawatan, serta jadwal praktik.",
      referenceUrls: ["https://referensi-alpha.example.com"],
      budgetRange: "Rp 1,5 jt",
      contactPreference: "whatsapp",
    };
    const req1 = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-alpha-req-001",
        body: payload1,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(req1.status).toBe(201);
    const req1Json = (await req1.json()) as {
      created: boolean;
      idempotentReplay: boolean;
      request: TenantSetupRequestDto;
      dailyQuota: { used: number; limit: number; remaining: number };
    };
    expect(req1Json.created).toBe(true);
    expect(req1Json.idempotentReplay).toBe(false);
    expect(req1Json.request.requestCode.startsWith("TBR-")).toBe(true);
    expect(req1Json.request.serviceKind).toBe("setup");
    expect(req1Json.request.whatsappUrl).toContain("https://wa.me/6281290006969?text=");
    expect(req1Json.request.whatsappUrl).not.toContain("%2520");
    expect(req1Json.dailyQuota).toMatchObject({ used: 1, limit: 3, remaining: 2 });
    setupReqDeliveredId = req1Json.request.id;

    // Exact idempotent replay returns 200 with same ID and no extra quota consumed
    const replay1 = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-alpha-req-001",
        body: payload1,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(replay1.status).toBe(200);
    const replay1Json = (await replay1.json()) as {
      created: boolean;
      idempotentReplay: boolean;
      request: TenantSetupRequestDto;
      dailyQuota: { used: number };
    };
    expect(replay1Json.created).toBe(false);
    expect(replay1Json.idempotentReplay).toBe(true);
    expect(replay1Json.request.id).toBe(setupReqDeliveredId);
    expect(replay1Json.dailyQuota.used).toBe(1);

    // Reusing key with different payload -> 409 IDEMPOTENCY_KEY_REUSED
    const conflictKey = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-alpha-req-001",
        body: { ...payload1, brief: "Isi brief yang berbeda total dengan kunci lama" },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(conflictKey.status).toBe(409);

    // Requests #2 (admin) and #3 (owner) succeed; #4 hits 429 DAILY_REQUEST_LIMIT_REACHED
    const req2 = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.admin.cookie,
        idempotencyKey: "tbr-alpha-req-002",
        body: {
          packageId: activeQuoteSetupPkgId,
          brandName: "Klinik Alpha Cabang 2",
          brief: "Penyiapan profil cabang kedua dan formulir janji temu.",
          referenceUrls: [],
          contactPreference: "both",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(req2.status).toBe(201);

    const req3 = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-alpha-req-003",
        body: {
          packageId: null,
          brandName: "Klinik Alpha Konsultasi",
          brief: "Konsultasi paket penyiapan materi blog kesehatan.",
          referenceUrls: [],
          contactPreference: "email",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(req3.status).toBe(201);

    const req4 = await handleTenantServiceRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "tbr-alpha-req-004",
        body: {
          packageId: null,
          brandName: "Klinik Alpha Keempat",
          brief: "Seharusnya terkena batas 3 permintaan per hari.",
          referenceUrls: [],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(req4.status).toBe(429);
    const req4Err = (await req4.json()) as { error: { code: string } };
    expect(req4Err.error.code).toBe("DAILY_REQUEST_LIMIT_REACHED");

    // Cross-tenant detail returns 404
    const crossDetail = await handleTenantServiceRequestDetail(
      tenantB.handle,
      setupReqDeliveredId,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantB.handle}/service-requests/${setupReqDeliveredId}`, "GET", {
        cookie: tenantB.owner.cookie,
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(crossDetail.status).toBe(404);

    // Custom-theme request on the SAME tenant & SAME day STILL works independently!
    const customThemeReq = await handleTenantCustomThemeRequestsRequest(
      tenantA.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${tenantA.handle}/custom-theme-requests`, "POST", {
        cookie: tenantA.owner.cookie,
        idempotencyKey: "ctr-alpha-independent-001",
        body: {
          packageId: null,
          brandName: "Klinik Alpha Custom Theme",
          brief: "Permintaan tema kustom harus tetap bekerja tanpa terganggu kuota setup.",
          referenceUrls: ["https://contoh-tema.example.com"],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(customThemeReq.status).toBe(201);
  });

  it("4. Staff delivery flow: operator nominates staff -> owner approves (admin denied) -> staff joins free seat as Editor -> delivered WITHOUT theme grant removes staff membership idempotently", async () => {
    // 1. Operator transitions setup request #1 to `in_progress` and nominates named staff account
    const assignRes = await handleConsoleCustomThemeRequestDetail(
      setupReqDeliveredId,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${setupReqDeliveredId}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Memulai pengerjaan Terima Beres dan menugaskan spesialis setup untuk persetujuan pemilik",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(assignRes.status).toBe(200);
    const assignJson = (await assignRes.json()) as {
      request: {
        version: number;
        status: string;
        staffAccess: { state: string; staffEmail: string; staffName: string };
      };
      auditId: string;
    };
    expect(assignJson.request.status).toBe("in_progress");
    expect(assignJson.request.staffAccess.state).toBe("awaiting_owner_approval");
    expect(assignJson.request.staffAccess.staffEmail).toBe(staffUser.email);
    expect(assignJson.auditId).toBeTruthy();

    // Staff is NOT a member yet before owner approval (ZERO silent access / no impersonation!)
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: staffUser.userId,
        tenantId: tenantA.tenantId,
        requiredPermission: "content:write",
        surface: "app",
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // 2. Admin CANNOT approve staff membership -> 403 FORBIDDEN (owner-only!)
    const adminApproveRes = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      setupReqDeliveredId,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${setupReqDeliveredId}/staff-access`,
        "POST",
        {
          cookie: tenantA.admin.cookie,
          body: { action: "approve", expectedVersion: assignJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(adminApproveRes.status).toBe(403);

    // 3. Owner approves -> staff joins free seat (3 -> 4/5) with `setup_staff` role & audit!
    const ownerApproveRes = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      setupReqDeliveredId,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${setupReqDeliveredId}/staff-access`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: {
            action: "approve",
            expectedVersion: assignJson.request.version,
            reason: "Pemilik menyetujui akses sementara Tim Setup untuk pengisian konten",
          },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(ownerApproveRes.status).toBe(200);
    const approveJson = (await ownerApproveRes.json()) as {
      joined: boolean;
      waitingForSeat: boolean;
      request: TenantSetupRequestDto;
      seats: TenantSetupSeatsDto;
      auditId: string;
    };
    expect(approveJson.joined).toBe(true);
    expect(approveJson.waitingForSeat).toBe(false);
    expect(approveJson.request.staffAccess.state).toBe("active");
    expect(approveJson.seats).toMatchObject({ seatsUsed: 4, seatsLimit: 5, seatsRemaining: 1 });
    expect(approveJson.auditId).toBeTruthy();

    // 4. Verify live RBAC of joined staff account: canonical `editor`, NO billing/members/setup-service access!
    const staffMemberAuth = await resolveAuthorizedTenantMember(env.PLATFORM_DB, {
      userId: staffUser.userId,
      tenantId: tenantA.tenantId,
      requiredPermission: "content:publish",
      surface: "app",
      nowMs: NOW_MS,
    });
    expect(staffMemberAuth.dbRole).toBe("setup_staff");
    expect(staffMemberAuth.role).toBe("editor");

    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: staffUser.userId,
        tenantId: tenantA.tenantId,
        requiredPermission: "billing:read",
        surface: "app",
        nowMs: NOW_MS,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    // 5. Operator marks setup request `delivered` WITHOUT any theme grant -> 200 OK & removes staff membership!
    const deliverRes = await handleConsoleCustomThemeRequestDetail(
      setupReqDeliveredId,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${setupReqDeliveredId}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: approveJson.request.version,
          status: "delivered",
          reason: "Seluruh konten beranda dan layanan selesai disiapkan dan diserahkan ke pemilik",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(deliverRes.status).toBe(200);
    const deliverJson = (await deliverRes.json()) as {
      request: { status: string; staffAccess: { state: string }; deliveredThemeId: string | null };
      staffMembershipRemoved: boolean;
      auditId: string;
    };
    expect(deliverJson.request.status).toBe("delivered");
    expect(deliverJson.request.deliveredThemeId).toBeNull();
    expect(deliverJson.request.staffAccess.state).toBe("revoked");
    expect(deliverJson.staffMembershipRemoved).toBe(true);
    expect(deliverJson.auditId).toBeTruthy();

    // Staff access is immediately revoked (404)!
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: staffUser.userId,
        tenantId: tenantA.tenantId,
        requiredPermission: "content:read",
        surface: "app",
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Owner calling revoke again is idempotent (200, alreadyRevoked: true, zero error)
    const idempotentRevoke = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      setupReqDeliveredId,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${setupReqDeliveredId}/staff-access`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: { action: "revoke", expectedVersion: approveJson.request.version + 1 },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(idempotentRevoke.status).toBe(200);
    const idempJson = (await idempotentRevoke.json()) as { alreadyRevoked: boolean; seats: TenantSetupSeatsDto };
    expect(idempJson.alreadyRevoked).toBe(true);
    expect(idempJson.seats.seatsUsed).toBe(3);
  });

  it("5. Removes staff membership idempotently on `declined` and `cancelled` terminal states", async () => {
    const listRes = await handleConsoleCustomThemeRequestsListRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests?serviceKind=setup&tenant=${tenantA.handle}`, "GET"),
      runtimeEnv,
      opOpts(),
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      requests: { id: string; status: string; version: number }[];
    };
    const openReqs = listJson.requests.filter((r) => r.status === "new");
    expect(openReqs.length).toBeGreaterThanOrEqual(2);
    const reqForDecline = openReqs[0]!;
    const reqForCancel = openReqs[1]!;

    // A) Assign + Owner approve + Operator `declined` -> removes staff membership
    const assignDecline = await handleConsoleCustomThemeRequestDetail(
      reqForDecline.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${reqForDecline.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: reqForDecline.version,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan staf setup untuk permintaan cabang kedua sebelum ditolak",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(assignDecline.status).toBe(200);
    const adJson = (await assignDecline.json()) as { request: { version: number } };

    const approveDecline = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      reqForDecline.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${reqForDecline.id}/staff-access`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: { action: "approve", expectedVersion: adJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(approveDecline.status).toBe(200);
    const apdJson = (await approveDecline.json()) as { joined: boolean; request: { version: number } };
    expect(apdJson.joined).toBe(true);

    const declinedRes = await handleConsoleCustomThemeRequestDetail(
      reqForDecline.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${reqForDecline.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: apdJson.request.version,
          status: "declined",
          reason: "Ruang lingkup di luar cakupan layanan Terima Beres standar",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(declinedRes.status).toBe(200);
    const decJson = (await declinedRes.json()) as {
      staffMembershipRemoved: boolean;
      request: { status: string; staffAccess: { state: string } };
    };
    expect(decJson.request.status).toBe("declined");
    expect(decJson.request.staffAccess.state).toBe("revoked");
    expect(decJson.staffMembershipRemoved).toBe(true);

    // B) Assign + Owner approve + Owner revokes early + Operator `cancelled` -> idempotent 200!
    const assignCancel = await handleConsoleCustomThemeRequestDetail(
      reqForCancel.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${reqForCancel.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: reqForCancel.version,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan staf setup untuk permintaan konsultasi blog",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(assignCancel.status).toBe(200);
    const acJson = (await assignCancel.json()) as { request: { version: number } };

    const approveCancel = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      reqForCancel.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${reqForCancel.id}/staff-access`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: { action: "approve", expectedVersion: acJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(approveCancel.status).toBe(200);
    const apcJson = (await approveCancel.json()) as { request: { version: number } };

    const earlyRevoke = await handleTenantSetupStaffAccessRequest(
      tenantA.handle,
      reqForCancel.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${tenantA.handle}/service-requests/${reqForCancel.id}/staff-access`,
        "POST",
        {
          cookie: tenantA.owner.cookie,
          body: { action: "revoke", expectedVersion: apcJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(earlyRevoke.status).toBe(200);
    const revJson = (await earlyRevoke.json()) as { removed: boolean; request: { version: number } };
    expect(revJson.removed).toBe(true);

    const cancelledRes = await handleConsoleCustomThemeRequestDetail(
      reqForCancel.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${reqForCancel.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: revJson.request.version,
          status: "cancelled",
          reason: "Dibatalkan atas permintaan pemilik situs setelah peninjauan awal",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(cancelledRes.status).toBe(200);
    const canJson = (await cancelledRes.json()) as {
      staffMembershipRemoved: boolean;
      request: { status: string; staffAccess: { state: string } };
    };
    expect(canJson.request.status).toBe("cancelled");
    expect(canJson.request.staffAccess.state).toBe("revoked");
    expect(canJson.staffMembershipRemoved).toBe(false); // already removed — completely idempotent!
  });

  it("6. Waits with clear explanation when all 5 member seats are occupied, then joins after a seat is freed", async () => {
    // Fill fullSeatsTenant to 5/5 seats (3 active members + 2 unexpired pending invitations)
    const inv1 = await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: fullSeatsTenant.orgId,
      tenantId: fullSeatsTenant.tenantId,
      handle: fullSeatsTenant.handle,
      inviterUserId: fullSeatsTenant.owner.userId,
      email: "seat4@example.test",
      role: "editor",
      nowMs: NOW_MS,
    });
    await createMemberInvitation(env.PLATFORM_DB, {
      organizationId: fullSeatsTenant.orgId,
      tenantId: fullSeatsTenant.tenantId,
      handle: fullSeatsTenant.handle,
      inviterUserId: fullSeatsTenant.owner.userId,
      email: "seat5@example.test",
      role: "editor",
      nowMs: NOW_MS,
    });

    // Submit setup request on fullSeatsTenant
    const submitRes = await handleTenantServiceRequestsRequest(
      fullSeatsTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${fullSeatsTenant.handle}/service-requests`, "POST", {
        cookie: fullSeatsTenant.owner.cookie,
        idempotencyKey: "tbr-fullseat-req-001",
        body: {
          packageId: activePricedSetupPkgId,
          brandName: "Usaha Penuh Kursi",
          brief: "Bantu setup website kami meski saat ini 5 kursi anggota terpakai.",
          referenceUrls: [],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(submitRes.status).toBe(201);
    const subJson = (await submitRes.json()) as { request: TenantSetupRequestDto };

    // Operator moves to in_progress naming staffUser
    const assignRes = await handleConsoleCustomThemeRequestDetail(
      subJson.request.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${subJson.request.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan staf setup untuk tenant dengan 5 kursi terpakai",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(assignRes.status).toBe(200);
    const asgJson = (await assignRes.json()) as { request: { version: number } };

    // Owner approves while 5/5 seats are occupied -> NEVER bypasses 5-seat cap! Enters `waiting_seat` with explanation!
    const waitRes = await handleTenantSetupStaffAccessRequest(
      fullSeatsTenant.handle,
      subJson.request.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${fullSeatsTenant.handle}/service-requests/${subJson.request.id}/staff-access`,
        "POST",
        {
          cookie: fullSeatsTenant.owner.cookie,
          body: { action: "approve", expectedVersion: asgJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(waitRes.status).toBe(200);
    const waitJson = (await waitRes.json()) as {
      joined: boolean;
      waitingForSeat: boolean;
      waitReason: string | null;
      request: TenantSetupRequestDto;
      seats: TenantSetupSeatsDto;
      auditId: string;
    };
    expect(waitJson.joined).toBe(false);
    expect(waitJson.waitingForSeat).toBe(true);
    expect(waitJson.waitReason).toContain("5 kursi");
    expect(waitJson.request.staffAccess.state).toBe("waiting_seat");
    expect(waitJson.seats).toMatchObject({ seatsUsed: 5, seatsLimit: 5, seatsRemaining: 0 });
    expect(waitJson.auditId).toBeTruthy();

    // Staff still does NOT have access while waiting for a free seat!
    await expect(
      resolveAuthorizedTenantMember(env.PLATFORM_DB, {
        userId: staffUser.userId,
        tenantId: fullSeatsTenant.tenantId,
        requiredPermission: "content:read",
        surface: "app",
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Free 1 seat by revoking pending invitation #1 (5/5 -> 4/5)
    await revokeMemberInvitation(env.PLATFORM_DB, {
      organizationId: fullSeatsTenant.orgId,
      tenantId: fullSeatsTenant.tenantId,
      invitationId: inv1.invitation.invitationId,
      actorUserId: fullSeatsTenant.owner.userId,
      nowMs: NOW_MS,
    });

    // Owner retries approval -> now joins cleanly (4 -> 5/5)!
    const joinNowRes = await handleTenantSetupStaffAccessRequest(
      fullSeatsTenant.handle,
      subJson.request.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${fullSeatsTenant.handle}/service-requests/${subJson.request.id}/staff-access`,
        "POST",
        {
          cookie: fullSeatsTenant.owner.cookie,
          body: { action: "approve", expectedVersion: waitJson.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(joinNowRes.status).toBe(200);
    const joinNowJson = (await joinNowRes.json()) as {
      joined: boolean;
      waitingForSeat: boolean;
      request: TenantSetupRequestDto;
      seats: TenantSetupSeatsDto;
    };
    expect(joinNowJson.joined).toBe(true);
    expect(joinNowJson.waitingForSeat).toBe(false);
    expect(joinNowJson.request.staffAccess.state).toBe("active");
    expect(joinNowJson.seats).toMatchObject({ seatsUsed: 5, seatsLimit: 5, seatsRemaining: 0 });
  });

  it("7. Preserves custom-theme request delivery theme-grant enforcement unchanged and records setup audits", async () => {
    const ctListRes = await handleConsoleCustomThemeRequestsListRequest(
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests?serviceKind=custom_theme&tenant=${tenantA.handle}`, "GET"),
      runtimeEnv,
      opOpts(),
    );
    expect(ctListRes.status).toBe(200);
    const ctList = (await ctListRes.json()) as { requests: { id: string; version: number }[] };
    expect(ctList.requests.length).toBeGreaterThanOrEqual(1);
    const ctReq = ctList.requests[0]!;

    // Marking custom_theme delivered WITHOUT theme grant MUST still fail (422 or 409 THEME_GRANT_REQUIRED)!
    const noGrantRes = await handleConsoleCustomThemeRequestDetail(
      ctReq.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${ctReq.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: ctReq.version,
          status: "delivered",
          reason: "Percobaan menyelesaikan tema kustom tanpa grant harus tetap ditolak",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(noGrantRes.status).toBe(422);
    const noGrantJson = (await noGrantRes.json()) as { error: { code: string } };
    expect(noGrantJson.error.code).toBe("THEME_GRANT_REQUIRED");

    // Verify platform_audit recorded our setup service lifecycle actions
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, { limit: 50 });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("setup_service.request.staff_assigned");
    expect(actions).toContain("setup_service.staff_access.approved_and_joined");
    expect(actions).toContain("setup_service.staff_access.waiting_seat");
    expect(actions).toContain("setup_service.request.delivered");
  });

  it("8. Hardening checks: non-operator & non-in_progress nomination denied, agency_admin denied (403), setup_staff role locked & Team removal reconciles request, console CSRF/step-up denied, approve vs terminal race & locked owner revoke", async () => {
    const db = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);

    // Add an `agency_staff` member (canonical `agency_admin`) to hardeningTenant
    const agencyUser = await signUpUser(
      runtimeEnv,
      "agency-admin-t069@example.test",
      "Admin Agensi T069",
    );
    await db.insert(members).values({
      id: "mem69_agency_harden",
      organizationId: hardeningTenant.orgId,
      userId: agencyUser.userId,
      role: "agency_staff",
      createdAt: new Date(NOW_MS),
    });

    // Submit two setup requests on hardeningTenant
    const sub1Res = await handleTenantServiceRequestsRequest(
      hardeningTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests`, "POST", {
        cookie: hardeningTenant.owner.cookie,
        idempotencyKey: "tbr-harden-req-001",
        body: {
          packageId: activePricedSetupPkgId,
          brandName: "Usaha Hardening 1",
          brief: "Permintaan pertama untuk verifikasi keamanan staff membership.",
          referenceUrls: [],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(sub1Res.status).toBe(201);
    const req1 = ((await sub1Res.json()) as { request: TenantSetupRequestDto }).request;

    const sub2Res = await handleTenantServiceRequestsRequest(
      hardeningTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests`, "POST", {
        cookie: hardeningTenant.owner.cookie,
        idempotencyKey: "tbr-harden-req-002",
        body: {
          packageId: activePricedSetupPkgId,
          brandName: "Usaha Hardening 2",
          brief: "Permintaan kedua untuk verifikasi tabrakan penugasan staf & race.",
          referenceUrls: [],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(sub2Res.status).toBe(201);
    const req2 = ((await sub2Res.json()) as { request: TenantSetupRequestDto }).request;

    // (d1) Console PATCH rejects invalid CSRF Origin -> 403
    const badOriginRes = await handleConsoleCustomThemeRequestDetail(
      req1.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req1.id}`, "PATCH", {
        origin: "https://evil.example.com",
        body: {
          expectedVersion: 1,
          status: "contacted",
          reason: "Percobaan mutasi console dari origin lintas domain harus ditolak",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(badOriginRes.status).toBe(403);

    // (d2) Console PATCH rejects stale 2FA step-up -> 403 REAUTH_REQUIRED
    const staleStepUpPatch = await handleConsoleCustomThemeRequestDetail(
      req1.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req1.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "contacted",
          reason: "Percobaan mutasi console saat step-up 2FA sudah melewati 10 menit",
        },
      }),
      runtimeEnv,
      {
        ...opOpts(),
        nowMs: NOW_MS + DEFAULT_SECOND_FACTOR_WINDOW_MS + 30_000,
      },
    );
    expect(staleStepUpPatch.status).toBe(403);

    // (3a) Nominating staff on non-`in_progress` status (`quoted`) MUST fail 409!
    const nonProgressNom = await handleConsoleCustomThemeRequestDetail(
      req1.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req1.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "quoted",
          staffUserEmail: staffUser.email,
          reason: "Percobaan menugaskan staf sebelum status in_progress harus ditolak",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nonProgressNom.status).toBe(409);

    // (6a) Nominating a non-operator user MUST fail 422 STAFF_NOT_ACTIVE_OPERATOR!
    const nonOpNom = await handleConsoleCustomThemeRequestDetail(
      req1.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req1.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: nonOperatorUser.email,
          reason: "Percobaan menugaskan akun pengguna biasa yang bukan operator aktif",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nonOpNom.status).toBe(422);
    const nonOpJson = (await nonOpNom.json()) as { error: { code: string } };
    expect(nonOpJson.error.code).toBe("STAFF_NOT_ACTIVE_OPERATOR");

    // Nominate active operator `staffUser` on req1 (`status: in_progress`) -> 200 OK
    const nom1Res = await handleConsoleCustomThemeRequestDetail(
      req1.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req1.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan operator spesialis setup aktif untuk permintaan pertama",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nom1Res.status).toBe(200);
    const nom1Json = (await nom1Res.json()) as { request: { version: number } };

    // (1b) Nominating the SAME `staffUser` on req2 while already nominated on open req1 -> 409 STAFF_ALREADY_ASSIGNED!
    const duplicateNomRes = await handleConsoleCustomThemeRequestDetail(
      req2.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req2.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Percobaan menugaskan staf yang sama ke permintaan aktif kedua di tenant sama",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(duplicateNomRes.status).toBe(409);
    const dupNomJson = (await duplicateNomRes.json()) as { error: { code: string } };
    expect(dupNomJson.error.code).toBe("STAFF_ALREADY_ASSIGNED");

    // (b) `agency_admin` (`agency_staff`) MUST be rejected (403) on BOTH approve AND revoke!
    const agencyApprove = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req1.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req1.id}/staff-access`,
        "POST",
        {
          cookie: agencyUser.cookie,
          body: { action: "approve", expectedVersion: nom1Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(agencyApprove.status).toBe(403);

    const agencyRevoke = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req1.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req1.id}/staff-access`,
        "POST",
        {
          cookie: agencyUser.cookie,
          body: { action: "revoke", expectedVersion: nom1Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(agencyRevoke.status).toBe(403);

    // Owner approves req1 -> staff joins as `setup_staff` (4 -> 5/5 seats used: owner, admin, editor, agency_staff, setup_staff)
    const approve1Res = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req1.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req1.id}/staff-access`,
        "POST",
        {
          cookie: hardeningTenant.owner.cookie,
          body: { action: "approve", expectedVersion: nom1Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(approve1Res.status).toBe(200);
    const ap1Json = (await approve1Res.json()) as { joined: boolean; request: TenantSetupRequestDto };
    expect(ap1Json.joined).toBe(true);

    // Fetch the created `setup_staff` member ID
    const staffMemRow = await env.PLATFORM_DB
      .prepare("SELECT id, role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
      .bind(hardeningTenant.orgId, staffUser.userId)
      .first<{ readonly id: string; readonly role: string }>();
    expect(staffMemRow?.role).toBe("setup_staff");

    // (c1) `updateTenantMemberRole` MUST reject changing role of a `setup_staff` member (403 FORBIDDEN)!
    await expect(
      updateTenantMemberRole(env.PLATFORM_DB, {
        organizationId: hardeningTenant.orgId,
        tenantId: hardeningTenant.tenantId,
        actorUserId: hardeningTenant.owner.userId,
        targetMemberId: staffMemRow!.id,
        newRole: "admin",
        nowMs: NOW_MS,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof InvitationError && err.status === 403);

    // (c2) `removeTenantMember` on `setup_staff` atomically reconciles `custom_theme_requests` to `revoked`!
    const removedViaTeam = await removeTenantMember(env.PLATFORM_DB, {
      organizationId: hardeningTenant.orgId,
      tenantId: hardeningTenant.tenantId,
      actorUserId: hardeningTenant.owner.userId,
      targetMemberId: staffMemRow!.id,
      nowMs: NOW_MS,
    });
    expect(removedViaTeam.removedMemberId).toBe(staffMemRow!.id);

    const req1AfterTeamRemove = await handleTenantServiceRequestDetail(
      hardeningTenant.handle,
      req1.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req1.id}`,
        "GET",
        { cookie: hardeningTenant.owner.cookie },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(req1AfterTeamRemove.status).toBe(200);
    const req1AfterJson = (await req1AfterTeamRemove.json()) as { request: TenantSetupRequestDto };
    expect(req1AfterJson.request.staffAccess.state).toBe("revoked");

    // (a) Approve vs terminal-status race on req2: cannot resurrect a terminal request into `waiting_seat` or `active`!
    // First nominate `staffUser` on req2 (`in_progress`) — now allowed since req1 is revoked and member is removed!
    const nom2Res = await handleConsoleCustomThemeRequestDetail(
      req2.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req2.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan operator spesialis setup untuk pengujian race terminal vs approve",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nom2Res.status).toBe(200);
    const nom2Json = (await nom2Res.json()) as { request: { version: number } };

    // Race owner approve against operator `cancelled` at the SAME expectedVersion!
    const [raceApprove, raceCancel] = await Promise.all([
      handleTenantSetupStaffAccessRequest(
        hardeningTenant.handle,
        req2.id,
        makeRequest(
          `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req2.id}/staff-access`,
          "POST",
          {
            cookie: hardeningTenant.owner.cookie,
            body: { action: "approve", expectedVersion: nom2Json.request.version },
          },
        ),
        runtimeEnv,
        { nowMs: NOW_MS },
      ),
      handleConsoleCustomThemeRequestDetail(
        req2.id,
        makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req2.id}`, "PATCH", {
          origin: CONSOLE_ORIGIN,
          body: {
            expectedVersion: nom2Json.request.version,
            status: "cancelled",
            reason: "Pembatalan permintaan bersamaan dengan persetujuan pemilik situs",
          },
        }),
        runtimeEnv,
        opOpts(),
      ),
    ]);

    // Exactly ONE succeeded (200) and the other hit 409 OCC / invalid transition — NEVER both!
    const statuses = [raceApprove.status, raceCancel.status].sort();
    expect(statuses).toEqual([200, 409]);

    // If cancel won, verify req2 stayed `cancelled` + `revoked` (NOT `waiting_seat` or `active`)!
    // If approve won, transition req2 to `cancelled` now with the bumped version and verify cleanup!
    if (raceCancel.status === 200) {
      const checkReq2 = await handleTenantServiceRequestDetail(
        hardeningTenant.handle,
        req2.id,
        makeRequest(
          `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req2.id}`,
          "GET",
          { cookie: hardeningTenant.owner.cookie },
        ),
        runtimeEnv,
        { nowMs: NOW_MS },
      );
      const checkJson = (await checkReq2.json()) as { request: TenantSetupRequestDto };
      expect(checkJson.request.status).toBe("cancelled");
      expect(checkJson.request.staffAccess.state).toBe("revoked");
    } else {
      const winnerJson = (await raceApprove.json()) as { request: TenantSetupRequestDto };
      const cleanCancel = await handleConsoleCustomThemeRequestDetail(
        req2.id,
        makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req2.id}`, "PATCH", {
          origin: CONSOLE_ORIGIN,
          body: {
            expectedVersion: winnerJson.request.version,
            status: "cancelled",
            reason: "Pembatalan pasca-race memastikan keanggotaan staf terhapus bersih",
          },
        }),
        runtimeEnv,
        opOpts(),
      );
      expect(cleanCancel.status).toBe(200);
    }

    // (6b) Owner `revoke` MUST succeed even when tenant becomes `locked` (while `approve` stays 403 SUBSCRIPTION_LOCKED)!
    const sub3Res = await handleTenantServiceRequestsRequest(
      hardeningTenant.handle,
      makeRequest(`${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests`, "POST", {
        cookie: hardeningTenant.owner.cookie,
        idempotencyKey: "tbr-harden-req-003",
        body: {
          packageId: activePricedSetupPkgId,
          brandName: "Usaha Hardening Locked Revoke",
          brief: "Menguji pencabutan akses staf saat situs terkunci.",
          referenceUrls: [],
          contactPreference: "whatsapp",
        },
      }),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(sub3Res.status).toBe(201);
    const req3 = ((await sub3Res.json()) as { request: TenantSetupRequestDto }).request;

    const nom3Res = await handleConsoleCustomThemeRequestDetail(
      req3.id,
      makeRequest(`${CONSOLE_ORIGIN}/api/console/custom-themes/requests/${req3.id}`, "PATCH", {
        origin: CONSOLE_ORIGIN,
        body: {
          expectedVersion: 1,
          status: "in_progress",
          staffUserEmail: staffUser.email,
          reason: "Menugaskan staf setup sebelum situs memasuki status terkunci",
        },
      }),
      runtimeEnv,
      opOpts(),
    );
    expect(nom3Res.status).toBe(200);
    const nom3Json = (await nom3Res.json()) as { request: { version: number } };

    // Approve while active so staff joins
    const ap3Res = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req3.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req3.id}/staff-access`,
        "POST",
        {
          cookie: hardeningTenant.owner.cookie,
          body: { action: "approve", expectedVersion: nom3Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(ap3Res.status).toBe(200);
    const ap3Json = (await ap3Res.json()) as { request: TenantSetupRequestDto };

    // Move hardeningTenant into `locked` status (`paid_through = NOW_MS - 5 days`)
    const dayMs = 24 * 60 * 60 * 1000;
    await env.PLATFORM_DB
      .prepare("UPDATE tenants SET status = 'locked', paid_through = ? WHERE id = ?")
      .bind(NOW_MS - 5 * dayMs, hardeningTenant.tenantId)
      .run();

    // `approve` while locked -> 403 SUBSCRIPTION_LOCKED
    const approveLockedRes = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req3.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req3.id}/staff-access`,
        "POST",
        {
          cookie: hardeningTenant.owner.cookie,
          body: { action: "approve", expectedVersion: ap3Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(approveLockedRes.status).toBe(403);

    // `revoke` by strict owner while locked -> 200 OK & removes staff membership cleanly!
    const revokeLockedRes = await handleTenantSetupStaffAccessRequest(
      hardeningTenant.handle,
      req3.id,
      makeRequest(
        `${APP_ORIGIN}/api/tenants/${hardeningTenant.handle}/service-requests/${req3.id}/staff-access`,
        "POST",
        {
          cookie: hardeningTenant.owner.cookie,
          body: { action: "revoke", expectedVersion: ap3Json.request.version },
        },
      ),
      runtimeEnv,
      { nowMs: NOW_MS },
    );
    expect(revokeLockedRes.status).toBe(200);
    const revLockedJson = (await revokeLockedRes.json()) as {
      removed: boolean;
      request: TenantSetupRequestDto;
    };
    expect(revLockedJson.removed).toBe(true);
    expect(revLockedJson.request.staffAccess.state).toBe("revoked");
  });
});
