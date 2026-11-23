import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
} from "@punyasitus/auth";
import {
  createMockOnlyVerifiedSettlementPolicy,
  type RawAutoLarisAdviceObservation,
} from "@punyasitus/core/billing/advice";
import { isThemeStoreReceiptPdfValid } from "@punyasitus/core/theme/variants";
import { applyBillingCouponsMigration } from "@punyasitus/db/billing/coupons/migrations";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { ensurePlatformOperatorRolesSchema, PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import type { ThemeStoreAdvicePort } from "@punyasitus/db/themes/store/index";
import {
  applyCommercialThemeStorePlatformMigration,
  applyTenantThemeStyleVariantsMigration,
} from "@punyasitus/db/themes/store/migrations";
import { beforeAll, describe, expect, it } from "vitest";
import { handleConsoleThemeStoreRequest } from "../../apps/web/src/pages/api/console/custom-themes/store.ts";
import {
  handleTenantThemesPreviewRequest,
  type TenantThemesRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/_shared.ts";
import { handleTenantThemesActivateRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/activate.ts";
import { handleTenantThemeStoreCheckoutRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/checkout.ts";
import { handleTenantThemesListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/index.ts";
import { handleTenantThemeOrderSettleRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/orders/[orderId]/settle.ts";
import { handleTenantThemeReceiptRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/receipts/[receiptId].ts";
import { handleTenantThemeVariantApplyRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/variants.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const NOW_MS = Date.UTC(2026, 10, 23, 6, 0, 0);

const OWNER_USER = { id: "usr_t096_owner", email: "owner@t096.id", name: "Budi Owner" } as const;
const EDITOR_USER = { id: "usr_t096_editor", email: "editor@t096.id", name: "Citra Editor" } as const;
const OPERATOR_USER = { id: "usr_t096_op", email: "op@punyasitus.com", name: "Super Operator" } as const;

const TENANT_A = {
  id: "01JT096TENANTA000000000001",
  orgId: "org_t096_alpha",
  handle: "t096-alpha",
  name: "T096 Alpha Corp",
} as const;

// Second website owned by the EXACT SAME owner user — MUST NOT inherit Tenant A's theme purchase!
const TENANT_B = {
  id: "01JT096TENANTB000000000002",
  orgId: "org_t096_beta",
  handle: "t096-beta",
  name: "T096 Beta Studio",
} as const;

function createStubAdvicePort(observation: RawAutoLarisAdviceObservation): ThemeStoreAdvicePort {
  return {
    async fetchAdvice() {
      return observation;
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildRuntimeEnv(): TenantThemesRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
  };
}

function appJsonRequest(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { "Content-Type": "application/json", Origin: APP_ORIGIN } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function migrateAndSeedTenantStore(tenantId: string, title: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as DurableObjectNamespace;
  const doId = ns.idFromName(tenantId);
  const stub = ns.get(doId);
  await runInDurableObject(stub, async (_instance, state) => {
    const storage = state.storage as unknown as StorageLike;
    applyTenantMigrations(storage, TENANT_MIGRATIONS, () => NOW_MS);
    applyTenantThemeStyleVariantsMigration(storage, () => NOW_MS);
  });

  const tenantDb = createTenantDb(
    openTenantStoreStub(env.TENANT_STORE as unknown as TenantStoreNamespaceLike, tenantId),
  );

  const homepagePublishedEnvelope = JSON.stringify({
    snapshotVersion: 1,
    resourceType: "page",
    publishedAt: NOW_MS,
    contentModifiedAt: NOW_MS,
    data: {
      slug: "beranda",
      title: "Beranda",
      isHomepage: true,
      layoutMode: "standard",
      sections: [
        {
          id: "sec-hero",
          kind: "hero",
          heading: `Selamat Datang di ${title}`,
          subheading: "Solusi terpercaya untuk bisnis Anda.",
          bodyHtml: null,
        },
        {
          id: "sec-faq",
          kind: "faq",
          heading: "Pertanyaan Umum",
          subheading: "Informasi layanan dan konsultasi.",
          bodyHtml: null,
        },
      ],
    },
  });

  // Seed real tenant content (pages + sections, posts, offerings, menus, media) to prove 0% loss
  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings
           (id, site_title, tagline, timezone, locale, active_theme_id, blog_enabled, catalog_enabled,
            ai_training_policy, version, updated_at)
         VALUES (1, ?, 'Solusi Profesional', 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, 'allow', 1, ?)`,
      )
      .bind(title, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile
           (id, business_name, business_category, description, version, updated_at)
         VALUES (1, ?, 'LocalBusiness', 'Profil bisnis resmi PunyaSitus.', 1, ?)`,
      )
      .bind(title, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages
           (id, slug, title, is_homepage, status, draft_sections_json, published_sections_json, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda', 1, 'published', ?, ?, 1, ?, ?)`,
      )
      .bind(homepagePublishedEnvelope, homepagePublishedEnvelope, NOW_MS, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO posts
           (id, slug, title, status, draft_body_json, published_body_json, version, created_at, updated_at)
         VALUES (1, 'artikel-perdana', 'Artikel Perdana', 'published', '{}', '{}', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO offerings
           (id, offering_type, slug, title, price_mode, price, cta_mode, status, attributes_version, attributes_json, version, created_at, updated_at)
         VALUES (1, 'service', 'jasa-konsultasi', 'Jasa Konsultasi B2B', 'fixed', 2500000, 'whatsapp', 'published', 1, '{}', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO menus (id, location, items_json, version, created_at, updated_at)
         VALUES (1, 'header', '[]', 1, ?, ?)`,
      )
      .bind(NOW_MS, NOW_MS),
  ]);

  return tenantDb;
}

describe("TASK-096 Workerd Integration: Style Variants, Pre-Purchase Preview, Per-Website Settlement & Receipt", () => {
  let tenantADb: D1Database;
  let tenantBDb: D1Database;
  let consoleOperator: Awaited<ReturnType<typeof createTwoFactorEnrolledOperatorFixture>>;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => NOW_MS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applyBillingCouponsMigration(env.PLATFORM_DB, () => NOW_MS);
    await applyCommercialThemeStorePlatformMigration(env.PLATFORM_DB, () => NOW_MS);

    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: TEST_CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });
    consoleOperator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "superadmin-t096@punyasitus.com",
      password: "OperatorStrongPassword!2026",
      name: "Superadmin T096",
      nowMs: NOW_MS,
    });

    await env.PLATFORM_DB.batch([
      // Users
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      ).bind(OWNER_USER.id, OWNER_USER.name, OWNER_USER.email, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      ).bind(EDITOR_USER.id, EDITOR_USER.name, EDITOR_USER.email, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
      ).bind(OPERATOR_USER.id, OPERATOR_USER.name, OPERATOR_USER.email, NOW_MS, NOW_MS),
      // Organizations
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(TENANT_A.orgId, TENANT_A.name, TENANT_A.handle, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(TENANT_B.orgId, TENANT_B.name, TENANT_B.handle, NOW_MS, NOW_MS),
      // Same owner owns BOTH Tenant A and Tenant B!
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
         VALUES ('mem_t096_a_owner', ?, ?, 'owner', ?)`,
      ).bind(TENANT_A.orgId, OWNER_USER.id, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
         VALUES ('mem_t096_a_editor', ?, ?, 'editor', ?)`,
      ).bind(TENANT_A.orgId, EDITOR_USER.id, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at)
         VALUES ('mem_t096_b_owner', ?, ?, 'owner', ?)`,
      ).bind(TENANT_B.orgId, OWNER_USER.id, NOW_MS),
      // Tenants
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, organization_id, handle, name, vertical, status, cache_version, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 1, 1, ?, ?)`,
      ).bind(TENANT_A.id, TENANT_A.orgId, TENANT_A.handle, TENANT_A.name, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, organization_id, handle, name, vertical, status, cache_version, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'compro', 'active', 1, 1, ?, ?)`,
      ).bind(TENANT_B.id, TENANT_B.orgId, TENANT_B.handle, TENANT_B.name, NOW_MS, NOW_MS),
      // Active promo coupon HEMAT20 (20% off)
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO promo_coupons
           (id, code, discount_kind, discount_value, eligible_plans_json, eligible_payer_types_json,
            max_redemptions, redeemed_count, starts_at, ends_at, active, created_by_user_id, version, created_at, updated_at)
         VALUES ('cpn_t096_hemat20', 'HEMAT20', 'percent', 20, '["monthly","yearly"]', '["tenant","agency"]',
                 50, 0, ?, ?, 1, ?, 1, ?, ?)`,
      ).bind(NOW_MS - 86_400_000, NOW_MS + 86_400_000, OPERATOR_USER.id, NOW_MS, NOW_MS),
      // Platform operator grant for console tests
      env.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO platform_operators (user_id, granted_by, reason, granted_at)
         VALUES (?, ?, 'TASK-096 test operator', ?)`,
      ).bind(OPERATOR_USER.id, OPERATOR_USER.id, NOW_MS),
    ]);

    tenantADb = await migrateAndSeedTenantStore(TENANT_A.id, TENANT_A.name);
    tenantBDb = await migrateAndSeedTenantStore(TENANT_B.id, TENANT_B.name);
  });

  it("allows safe pre-purchase draft preview (no-store, noindex) of paid_once theme while rejecting direct activation with 403 THEME_NOT_ENTITLED", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Pre-purchase draft preview succeeds with no-store & noindex and ZERO live change
    const previewRes = await handleTenantThemesPreviewRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/preview`, "POST", {
        themeId: "premium-atelier-editorial",
        styleVariantId: "midnight-atelier",
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );

    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Cache-Control")).toContain("no-store");
    expect(previewRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const previewBody = (await previewRes.json()) as {
      html: string;
      themeId: string;
      styleVariantId: string;
      entitled: boolean;
      isPreview: boolean;
    };
    expect(previewBody.themeId).toBe("premium-atelier-editorial");
    expect(previewBody.styleVariantId).toBe("midnight-atelier");
    expect(previewBody.entitled).toBe(false);
    expect(previewBody.isPreview).toBe(true);
    expect(previewBody.html).toContain('name="robots" content="noindex, nofollow"');

    // Live active theme in TenantStore MUST remain untouched ("compro")!
    const liveRow = await tenantADb
      .prepare("SELECT active_theme_id, version FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string; version: number }>();
    expect(liveRow?.active_theme_id).toBe("compro");
    expect(liveRow?.version).toBe(1);

    // 2. Direct activation of unpurchased paid_once theme returns 403 THEME_NOT_ENTITLED
    const activateRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        themeId: "premium-atelier-editorial",
        expectedVersion: 1,
        confirm: true,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );
    expect(activateRes.status).toBe(403);
    const activateErr = (await activateRes.json()) as { error: { code: string } };
    expect(activateErr.error.code).toBe("THEME_NOT_ENTITLED");

    // 3. Variant apply endpoint ALSO enforces 403 THEME_NOT_ENTITLED on unpurchased paid_once theme
    const variantRes = await handleTenantThemeVariantApplyRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/variants`, "POST", {
        themeId: "premium-atelier-editorial",
        styleVariantId: "ivory-obsidian",
        expectedVersion: 1,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );
    expect(variantRes.status).toBe(403);
    const variantErr = (await variantRes.json()) as { error: { code: string } };
    expect(variantErr.error.code).toBe("THEME_NOT_ENTITLED");
  });

  it("enforces RBAC (editor -> 403) and CSRF Origin check (mismatched Origin -> 403)", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // Editor rejected 403 on variant apply & checkout
    const editorVariantRes = await handleTenantThemeVariantApplyRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/variants`, "POST", {
        themeId: "compro",
        styleVariantId: "dark-executive",
        expectedVersion: 1,
      }),
      runtimeEnv,
      { authenticatedUser: EDITOR_USER, nowMs: NOW_MS },
    );
    expect(editorVariantRes.status).toBe(403);

    const editorCheckoutRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/checkout`, "POST", {
        themeId: "premium-atelier-editorial",
        channelCode: "QRIS",
      }),
      runtimeEnv,
      { authenticatedUser: EDITOR_USER, nowMs: NOW_MS },
    );
    expect(editorCheckoutRes.status).toBe(403);

    // CSRF Origin mismatch rejected 403
    const csrfRes = await handleTenantThemeVariantApplyRequest(
      TENANT_A.id,
      new Request(`${APP_ORIGIN}/api/tenants/${TENANT_A.id}/themes/variants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({
          themeId: "compro",
          styleVariantId: "dark-executive",
          expectedVersion: 1,
        }),
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );
    expect(csrfRes.status).toBe(403);
  });

  it("ignores client payment proof, verifies settlement via server AdvicePort (including review -> paid), issues snapshot-stable PDF receipt, and enforces strict per-website isolation", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const verifiedMockPolicy = createMockOnlyVerifiedSettlementPolicy();

    // 1. Reject client price override with 422
    const tamperedRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/checkout`, "POST", {
        themeId: "premium-atelier-editorial",
        channelCode: "QRIS",
        priceIdr: 10_000,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );
    expect(tamperedRes.status).toBe(422);
    const tamperedJson = (await tamperedRes.json()) as { error: { code: string } };
    expect(tamperedJson.error.code).toBe("THEME_CHECKOUT_CLIENT_PRICE_FORBIDDEN");

    // 2. Create server-priced checkout with coupon HEMAT20 (Rp 499.000 - 20% = Rp 399.200)
    const checkoutRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_A.id,
      appJsonRequest(
        `/api/tenants/${TENANT_A.id}/themes/checkout`,
        "POST",
        {
          themeId: "premium-atelier-editorial",
          channelCode: "QRIS",
          couponCode: "HEMAT20",
        },
        { "Idempotency-Key": "idem-t096-order-1" },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS },
    );
    expect(checkoutRes.status).toBe(201);
    const checkoutJson = (await checkoutRes.json()) as {
      order: {
        id: string;
        basePriceIdr: number;
        discountAmountIdr: number;
        netBaseAmountIdr: number;
        totalPayableIdr: number;
        couponCode: string;
        providerReffId: string;
        providerTransactionId: string;
      };
    };
    expect(checkoutJson.order.basePriceIdr).toBe(499_000);
    expect(checkoutJson.order.discountAmountIdr).toBe(99_800);
    expect(checkoutJson.order.netBaseAmountIdr).toBe(399_200);
    expect(checkoutJson.order.totalPayableIdr).toBe(399_200);
    expect(checkoutJson.order.couponCode).toBe("HEMAT20");

    // 2b. Single open order guard prevents concurrent duplicate open orders / coupon stacking race
    const duplicateOpenRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_A.id,
      appJsonRequest(
        `/api/tenants/${TENANT_A.id}/themes/checkout`,
        "POST",
        {
          themeId: "premium-atelier-editorial",
          channelCode: "QRIS",
          couponCode: "HEMAT20",
        },
        { "Idempotency-Key": "idem-t096-order-duplicate" },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 500 },
    );
    expect(duplicateOpenRes.status).toBe(409);
    const duplicateOpenErr = (await duplicateOpenRes.json()) as { error: { code: string } };
    expect(duplicateOpenErr.error.code).toBe("OPEN_ORDER_EXISTS");

    // 3a. Fail-closed WITHOUT server-side AdvicePort even if client POSTs forged PAID_SETTLED proof!
    const forgedNoPortRes = await handleTenantThemeOrderSettleRequest(
      TENANT_A.id,
      checkoutJson.order.id,
      appJsonRequest(
        `/api/tenants/${TENANT_A.id}/themes/orders/${checkoutJson.order.id}/settle`,
        "POST",
        {
          rc: "00",
          ket: "PAID",
          providerTransactionId: checkoutJson.order.providerTransactionId,
          reffId: checkoutJson.order.providerReffId,
          paymentStatus: "PAID_SETTLED",
          paidAmountIdr: 1,
          currency: "IDR",
          settledAtMs: Date.UTC(2030, 0, 1),
        },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 1000, settlementPolicy: verifiedMockPolicy },
    );
    expect(forgedNoPortRes.status).toBe(503);
    const forgedNoPortErr = (await forgedNoPortRes.json()) as { error: { code: string } };
    expect(forgedNoPortErr.error.code).toBe("AUTOLARIS_ADVICE_UNCONFIGURED");

    // 3b. Generic "OK" / "SUCCESS" from server AdvicePort NEVER unlocks entitlement & moves order to `review`
    //     even when client POST body tries to spoof `PAID_SETTLED`!
    const genericRes = await handleTenantThemeOrderSettleRequest(
      TENANT_A.id,
      checkoutJson.order.id,
      appJsonRequest(
        `/api/tenants/${TENANT_A.id}/themes/orders/${checkoutJson.order.id}/settle`,
        "POST",
        { paymentStatus: "PAID_SETTLED", rc: "00", paidAmountIdr: checkoutJson.order.totalPayableIdr },
      ),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: NOW_MS + 1500,
        settlementPolicy: verifiedMockPolicy,
        advicePort: createStubAdvicePort({
          rc: "00",
          ket: "OK",
          providerTransactionId: checkoutJson.order.providerTransactionId,
          reffId: checkoutJson.order.providerReffId,
          paymentStatus: "SUCCESS",
          shippingStatus: null,
          paidAmountIdr: checkoutJson.order.totalPayableIdr,
          currency: "IDR",
          settledAtMs: NOW_MS + 1500,
        }),
      },
    );
    expect(genericRes.status).toBe(200);
    const genericJson = (await genericRes.json()) as {
      settled: boolean;
      entitlement: unknown;
      order: { status: string };
    };
    expect(genericJson.settled).toBe(false);
    expect(genericJson.entitlement).toBeNull();
    expect(genericJson.order.status).toBe("review");

    // 4. Confirmed server AutoLaris Advice settles the SAME `review` order (`review -> paid`)!
    //    Also pass a spoofed future `settledAtMs` inside observation to prove server `nowMs` wins!
    const serverSettleNowMs = NOW_MS + 3000;
    const confirmedAdvicePort = createStubAdvicePort({
      rc: "00",
      ket: "PAID",
      providerTransactionId: checkoutJson.order.providerTransactionId,
      reffId: checkoutJson.order.providerReffId,
      paymentStatus: "PAID_SETTLED",
      shippingStatus: null,
      paidAmountIdr: checkoutJson.order.totalPayableIdr,
      currency: "IDR",
      settledAtMs: Date.UTC(2031, 5, 1),
    });

    const settleRes = await handleTenantThemeOrderSettleRequest(
      TENANT_A.id,
      checkoutJson.order.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/orders/${checkoutJson.order.id}/settle`, "POST", {}),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: serverSettleNowMs,
        settlementPolicy: verifiedMockPolicy,
        advicePort: confirmedAdvicePort,
      },
    );
    expect(settleRes.status).toBe(200);
    const settleJson = (await settleRes.json()) as {
      settled: boolean;
      idempotentReplay: boolean;
      order: { status: string; settledAtMs: number };
      entitlement: { id: string; tenantId: string; themeId: string };
      receipt: {
        id: string;
        receiptNumber: string;
        totalAmountIdr: number;
        issuedAtMs: number;
        pdfSha256: string;
        tenantNameSnapshot: string;
        payerNameSnapshot: string;
      };
    };
    expect(settleJson.settled).toBe(true);
    expect(settleJson.idempotentReplay).toBe(false);
    expect(settleJson.order.status).toBe("paid");
    expect(settleJson.order.settledAtMs).toBe(serverSettleNowMs);
    expect(settleJson.entitlement.tenantId).toBe(TENANT_A.id);
    expect(settleJson.entitlement.themeId).toBe("premium-atelier-editorial");
    expect(settleJson.receipt.receiptNumber).toBe("INV-THM-2026-000001");
    expect(settleJson.receipt.totalAmountIdr).toBe(399_200);
    expect(settleJson.receipt.issuedAtMs).toBe(serverSettleNowMs);
    expect(settleJson.receipt.tenantNameSnapshot).toBe(TENANT_A.name);
    expect(settleJson.receipt.payerNameSnapshot).toBe(OWNER_USER.name);

    // 5. Replay idempotency: re-posting settlement returns same entitlement & receipt without double-issuing
    const replayRes = await handleTenantThemeOrderSettleRequest(
      TENANT_A.id,
      checkoutJson.order.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/orders/${checkoutJson.order.id}/settle`, "POST", {}),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: NOW_MS + 4000,
        settlementPolicy: verifiedMockPolicy,
        advicePort: confirmedAdvicePort,
      },
    );
    expect(replayRes.status).toBe(200);
    const replayJson = (await replayRes.json()) as typeof settleJson;
    expect(replayJson.idempotentReplay).toBe(true);
    expect(replayJson.entitlement.id).toBe(settleJson.entitlement.id);
    expect(replayJson.receipt.receiptNumber).toBe("INV-THM-2026-000001");

    const receiptCount = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM theme_store_receipts WHERE tenant_id = ?",
    )
      .bind(TENANT_A.id)
      .first<{ cnt: number }>();
    expect(Number(receiptCount?.cnt)).toBe(1);

    // 6. Download valid %PDF-1.4 receipt for Tenant A & verify immutable snapshot hash stability
    //    even after Tenant A renames its site in `tenants`!
    await env.PLATFORM_DB.prepare("UPDATE tenants SET name = 'Renamed Alpha Corp' WHERE id = ?")
      .bind(TENANT_A.id)
      .run();

    const pdfRes = await handleTenantThemeReceiptRequest(
      TENANT_A.id,
      settleJson.receipt.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/receipts/${settleJson.receipt.id}`, "GET"),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 5000 },
    );
    await env.PLATFORM_DB.prepare("UPDATE tenants SET name = ? WHERE id = ?")
      .bind(TENANT_A.name, TENANT_A.id)
      .run();

    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdfRes.headers.get("Cache-Control")).toContain("no-store");
    expect(pdfRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    expect(await isThemeStoreReceiptPdfValid(pdfBytes)).toBe(true);
    expect(await sha256Hex(pdfBytes)).toBe(settleJson.receipt.pdfSha256);

    // 6b. SQLite immutability triggers block financial column mutation & paid -> pending reversion!
    await expect(
      env.PLATFORM_DB.prepare("UPDATE theme_store_orders SET total_payable_idr = 1 WHERE id = ?")
        .bind(checkoutJson.order.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    await expect(
      env.PLATFORM_DB.prepare("UPDATE theme_store_orders SET status = 'pending' WHERE id = ?")
        .bind(checkoutJson.order.id)
        .run(),
    ).rejects.toThrow(/immutable/i);

    // 7. STRICT PER-WEBSITE ISOLATION: Tenant B (same owner!) STILL gets 403 on activation & 404 on Tenant A receipt!
    const tenantBActivateRes = await handleTenantThemesActivateRequest(
      TENANT_B.id,
      appJsonRequest(`/api/tenants/${TENANT_B.id}/themes/activate`, "POST", {
        themeId: "premium-atelier-editorial",
        expectedVersion: 1,
        confirm: true,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 6000 },
    );
    expect(tenantBActivateRes.status).toBe(403);
    const tenantBActivateErr = (await tenantBActivateRes.json()) as { error: { code: string } };
    expect(tenantBActivateErr.error.code).toBe("THEME_NOT_ENTITLED");

    const tenantBReceiptRes = await handleTenantThemeReceiptRequest(
      TENANT_B.id,
      settleJson.receipt.id,
      appJsonRequest(`/api/tenants/${TENANT_B.id}/themes/receipts/${settleJson.receipt.id}`, "GET"),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 6000 },
    );
    expect(tenantBReceiptRes.status).toBe(404);
  });

  it("guarantees gap-free INV-THM receipt numbers across exhausted coupon race and pre-existing entitlement conflicts", async () => {
    const runtimeEnv = buildRuntimeEnv();
    const verifiedMockPolicy = createMockOnlyVerifiedSettlementPolicy();

    // Seed single-use coupon ONCE10 (max_redemptions = 1)
    await env.PLATFORM_DB.prepare(
      `INSERT OR IGNORE INTO promo_coupons
         (id, code, discount_kind, discount_value, eligible_plans_json, eligible_payer_types_json,
          max_redemptions, redeemed_count, starts_at, ends_at, active, created_by_user_id, version, created_at, updated_at)
       VALUES ('cpn_t096_once10', 'ONCE10', 'percent', 10, '["monthly","yearly"]', '["tenant","agency"]',
               1, 0, ?, ?, 1, ?, 1, ?, ?)`,
    )
      .bind(NOW_MS - 86_400_000, NOW_MS + 86_400_000, OPERATOR_USER.id, NOW_MS, NOW_MS)
      .run();

    // 1. Tenant B creates checkout with ONCE10, then ONCE10 is concurrently exhausted before settlement
    const cpnOrderRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_B.id,
      appJsonRequest(
        `/api/tenants/${TENANT_B.id}/themes/checkout`,
        "POST",
        {
          themeId: "premium-atelier-editorial",
          channelCode: "QRIS",
          couponCode: "ONCE10",
        },
        { "Idempotency-Key": "idem-t096-b-once10" },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 6100 },
    );
    expect(cpnOrderRes.status).toBe(201);
    const cpnOrder = ((await cpnOrderRes.json()) as {
      order: { id: string; providerReffId: string; providerTransactionId: string; totalPayableIdr: number };
    }).order;

    // Simulate concurrent exhaustion of ONCE10
    await env.PLATFORM_DB.prepare("UPDATE promo_coupons SET redeemed_count = 1 WHERE id = 'cpn_t096_once10'")
      .run();

    const exhaustedSettleRes = await handleTenantThemeOrderSettleRequest(
      TENANT_B.id,
      cpnOrder.id,
      appJsonRequest(`/api/tenants/${TENANT_B.id}/themes/orders/${cpnOrder.id}/settle`, "POST", {}),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: NOW_MS + 6200,
        settlementPolicy: verifiedMockPolicy,
        advicePort: createStubAdvicePort({
          rc: "00",
          ket: "PAID",
          providerTransactionId: cpnOrder.providerTransactionId,
          reffId: cpnOrder.providerReffId,
          paymentStatus: "PAID_SETTLED",
          shippingStatus: null,
          paidAmountIdr: cpnOrder.totalPayableIdr,
          currency: "IDR",
          settledAtMs: NOW_MS + 6200,
        }),
      },
    );
    expect(exhaustedSettleRes.status).toBe(409);
    const exhaustedErr = (await exhaustedSettleRes.json()) as { error: { code: string } };
    expect(exhaustedErr.error.code).toBe("COUPON_EXHAUSTED");

    // Verify order moved to review, NO entitlement granted, and sequence counter STILL 1 (zero burned!)
    const afterExhaustedOrder = await env.PLATFORM_DB.prepare(
      "SELECT status, safe_failure_code FROM theme_store_orders WHERE id = ?",
    )
      .bind(cpnOrder.id)
      .first<{ status: string; safe_failure_code: string }>();
    expect(afterExhaustedOrder?.status).toBe("review");
    expect(afterExhaustedOrder?.safe_failure_code).toBe("COUPON_EXHAUSTED");

    const seqAfterExhausted = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM theme_store_receipt_counters WHERE year = 2026",
    ).first<{ last_seq: number }>();
    expect(Number(seqAfterExhausted?.last_seq)).toBe(1);

    // 2. Tenant B creates checkout for premium-nusantara-flagship, then operator grants entitlement
    //    before settlement -> settlement MUST return 409 THEME_ALREADY_OWNED and burn ZERO sequence!
    const flagshipOrderRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_B.id,
      appJsonRequest(
        `/api/tenants/${TENANT_B.id}/themes/checkout`,
        "POST",
        {
          themeId: "premium-nusantara-flagship",
          channelCode: "QRIS",
        },
        { "Idempotency-Key": "idem-t096-b-flagship" },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 6300 },
    );
    expect(flagshipOrderRes.status).toBe(201);
    const flagshipOrder = ((await flagshipOrderRes.json()) as {
      order: { id: string; providerReffId: string; providerTransactionId: string; totalPayableIdr: number };
    }).order;

    // Operator grants entitlement to Tenant B
    const consoleGrantRes = await handleConsoleThemeStoreRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/custom-themes/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN },
        body: JSON.stringify({
          action: "grant",
          tenantId: TENANT_B.id,
          themeId: "premium-nusantara-flagship",
          reason: "Enterprise comp grant for TASK-096 test",
        }),
      }),
      runtimeEnv,
      {
        session: { id: consoleOperator.session.id, userId: consoleOperator.user.id },
        user: { id: consoleOperator.user.id, email: consoleOperator.user.email },
        nowMs: NOW_MS + 6350,
      },
    );
    expect(consoleGrantRes.status).toBe(201);

    const alreadyOwnedSettleRes = await handleTenantThemeOrderSettleRequest(
      TENANT_B.id,
      flagshipOrder.id,
      appJsonRequest(`/api/tenants/${TENANT_B.id}/themes/orders/${flagshipOrder.id}/settle`, "POST", {}),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: NOW_MS + 6400,
        settlementPolicy: verifiedMockPolicy,
        advicePort: createStubAdvicePort({
          rc: "00",
          ket: "PAID",
          providerTransactionId: flagshipOrder.providerTransactionId,
          reffId: flagshipOrder.providerReffId,
          paymentStatus: "PAID_SETTLED",
          shippingStatus: null,
          paidAmountIdr: flagshipOrder.totalPayableIdr,
          currency: "IDR",
          settledAtMs: NOW_MS + 6400,
        }),
      },
    );
    expect(alreadyOwnedSettleRes.status).toBe(409);
    const alreadyOwnedErr = (await alreadyOwnedSettleRes.json()) as { error: { code: string } };
    expect(alreadyOwnedErr.error.code).toBe("THEME_ALREADY_OWNED");

    const seqAfterOwnedConflict = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM theme_store_receipt_counters WHERE year = 2026",
    ).first<{ last_seq: number }>();
    expect(Number(seqAfterOwnedConflict?.last_seq)).toBe(1);

    // 3. Genuine purchase by Tenant A for premium-nusantara-flagship MUST receive exact contiguous INV-THM-2026-000002!
    const tenantAFlagshipRes = await handleTenantThemeStoreCheckoutRequest(
      TENANT_A.id,
      appJsonRequest(
        `/api/tenants/${TENANT_A.id}/themes/checkout`,
        "POST",
        {
          themeId: "premium-nusantara-flagship",
          channelCode: "VA_BCA",
        },
        { "Idempotency-Key": "idem-t096-a-flagship" },
      ),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 6500 },
    );
    expect(tenantAFlagshipRes.status).toBe(201);
    const tenantAFlagship = ((await tenantAFlagshipRes.json()) as {
      order: { id: string; providerReffId: string; providerTransactionId: string; totalPayableIdr: number };
    }).order;

    const contiguousSettleRes = await handleTenantThemeOrderSettleRequest(
      TENANT_A.id,
      tenantAFlagship.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/orders/${tenantAFlagship.id}/settle`, "POST", {}),
      runtimeEnv,
      {
        authenticatedUser: OWNER_USER,
        nowMs: NOW_MS + 6600,
        settlementPolicy: verifiedMockPolicy,
        advicePort: createStubAdvicePort({
          rc: "00",
          ket: "PAID",
          providerTransactionId: tenantAFlagship.providerTransactionId,
          reffId: tenantAFlagship.providerReffId,
          paymentStatus: "PAID_SETTLED",
          shippingStatus: null,
          paidAmountIdr: tenantAFlagship.totalPayableIdr,
          currency: "IDR",
          settledAtMs: NOW_MS + 6600,
        }),
      },
    );
    expect(contiguousSettleRes.status).toBe(200);
    const contiguousJson = (await contiguousSettleRes.json()) as {
      settled: boolean;
      receipt: { receiptNumber: string };
    };
    expect(contiguousJson.settled).toBe(true);
    expect(contiguousJson.receipt.receiptNumber).toBe("INV-THM-2026-000002");
  });

  it("activates purchased premium theme and switches style variants on Tenant A with 0% content loss", async () => {
    const runtimeEnv = buildRuntimeEnv();

    // 1. Apply built-in style variant on compro first
    const varRes = await handleTenantThemeVariantApplyRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/variants`, "POST", {
        themeId: "compro",
        styleVariantId: "dark-executive",
        expectedVersion: 1,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 7000 },
    );
    expect(varRes.status).toBe(200);
    const varJson = (await varRes.json()) as {
      activeThemeId: string;
      activeStyleVariantId: string;
      version: number;
    };
    expect(varJson.activeThemeId).toBe("compro");
    expect(varJson.activeStyleVariantId).toBe("dark-executive");
    expect(varJson.version).toBe(2);

    // 2. Activate purchased premium theme with midnight-atelier variant
    const actRes = await handleTenantThemesActivateRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes/activate`, "POST", {
        themeId: "premium-atelier-editorial",
        styleVariantId: "midnight-atelier",
        expectedVersion: 2,
        confirm: true,
      }),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 8000 },
    );
    expect(actRes.status).toBe(200);
    const actJson = (await actRes.json()) as {
      activeThemeId: string;
      activeStyleVariantId: string;
      contentSummary: { pages: number; posts: number; offerings: number; menus: number };
    };
    expect(actJson.activeThemeId).toBe("premium-atelier-editorial");
    expect(actJson.activeStyleVariantId).toBe("midnight-atelier");
    // 0% content loss verified!
    expect(actJson.contentSummary.pages).toBe(1);
    expect(actJson.contentSummary.posts).toBe(1);
    expect(actJson.contentSummary.offerings).toBe(1);
    expect(actJson.contentSummary.menus).toBe(1);

    // 3. List endpoint reflects owned premium theme + receipt + >=4 variants on every platform theme
    const listRes = await handleTenantThemesListRequest(
      TENANT_A.id,
      appJsonRequest(`/api/tenants/${TENANT_A.id}/themes`, "GET"),
      runtimeEnv,
      { authenticatedUser: OWNER_USER, nowMs: NOW_MS + 9000 },
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      themes: { id: string; styleVariants: unknown[] }[];
      premiumThemes: { id: string; entitled: boolean; receipt: { receiptNumber: string } | null }[];
    };
    for (const t of listJson.themes) {
      expect(t.styleVariants.length).toBeGreaterThanOrEqual(4);
    }
    const atelier = listJson.premiumThemes.find((p) => p.id === "premium-atelier-editorial");
    expect(atelier?.entitled).toBe(true);
    expect(atelier?.receipt?.receiptNumber).toBe("INV-THM-2026-000001");

    // 4. Tenant B remains untouched
    const tenantBLive = await tenantBDb
      .prepare("SELECT active_theme_id FROM site_settings WHERE id = 1")
      .first<{ active_theme_id: string }>();
    expect(tenantBLive?.active_theme_id).toBe("compro");
  });

  it("enforces host isolation, included-tier grant rejection (422), and 16 KiB body cap (413) on console Theme Store API", async () => {
    const runtimeEnv = buildRuntimeEnv();
    // Non-console host gets neutral 404
    const nonConsoleRes = await handleConsoleThemeStoreRequest(
      new Request(`${APP_ORIGIN}/api/console/custom-themes/store`, { method: "GET" }),
      runtimeEnv,
      {
        session: { id: "sess_op_1", userId: OPERATOR_USER.id },
        user: { id: OPERATOR_USER.id, email: OPERATOR_USER.email },
      },
    );
    expect(nonConsoleRes.status).toBe(404);

    // Console host without session gets 401
    const unauthConsoleRes = await handleConsoleThemeStoreRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/custom-themes/store`, { method: "GET" }),
      runtimeEnv,
      { session: null, user: null },
    );
    expect(unauthConsoleRes.status).toBe(401);

    // Console grant rejects `included` tier themes with 422 THEME_GRANT_NOT_APPLICABLE
    const includedGrantRes = await handleConsoleThemeStoreRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/custom-themes/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN },
        body: JSON.stringify({
          action: "grant",
          tenantId: TENANT_A.id,
          themeId: "compro",
          reason: "Should reject included theme grant",
        }),
      }),
      runtimeEnv,
      {
        session: { id: consoleOperator.session.id, userId: consoleOperator.user.id },
        user: { id: consoleOperator.user.id, email: consoleOperator.user.email },
        nowMs: NOW_MS + 10_000,
      },
    );
    expect(includedGrantRes.status).toBe(422);
    const includedGrantErr = (await includedGrantRes.json()) as { error: { code: string } };
    expect(includedGrantErr.error.code).toBe("THEME_GRANT_NOT_APPLICABLE");

    // Console store rejects oversized (>16 KiB) request body with 413 PAYLOAD_TOO_LARGE
    const hugeRes = await handleConsoleThemeStoreRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/custom-themes/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: CONSOLE_ORIGIN },
        body: JSON.stringify({
          action: "grant",
          tenantId: TENANT_A.id,
          themeId: "premium-atelier-editorial",
          reason: "x".repeat(17_000),
        }),
      }),
      runtimeEnv,
      {
        session: { id: consoleOperator.session.id, userId: consoleOperator.user.id },
        user: { id: consoleOperator.user.id, email: consoleOperator.user.email },
        nowMs: NOW_MS + 10_100,
      },
    );
    expect(hugeRes.status).toBe(413);
  });
});
