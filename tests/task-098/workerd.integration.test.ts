import { env } from "cloudflare:workers";
import { applySessionTwoFactorMigration } from "@punyasitus/auth";
import type { AgencyRuntimeEnv } from "@punyasitus/auth/agency/index";
import type { ConsoleRuntimeEnv } from "@punyasitus/auth/platform/index";
import { createMockOnlyVerifiedSettlementPolicy } from "@punyasitus/core/billing/index";
import { PLUGIN_MONTHLY_DURATION_MS } from "@punyasitus/core/plugins/billing";
import { applyAffiliateMigrations } from "@punyasitus/db/affiliates/index";
import {
  applyAffiliateCommissionLedgerMigrations,
  listAffiliateCommissionEntries,
} from "@punyasitus/db/affiliates/ledger/index";
import { addAgencyMember, applyAgencyPortalMigration } from "@punyasitus/db/agencies/index";
import { applyBillingCouponsMigration } from "@punyasitus/db/billing/coupons/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  ensurePlatformOperatorRolesSchema,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/index";
import {
  applyPluginStoreBillingMigrations,
  createPluginAddonOrder,
  installOrEnableStorePlugin,
  issuePluginPrivateGrant,
  PluginStoreError,
  revokePluginPrivateGrant,
  settlePluginAddonOrder,
  upsertConsolePluginCatalogItem,
  type PluginAddonAdvicePort,
} from "@punyasitus/db/plugins/store/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAgencyPluginCheckoutRequest } from "../../apps/web/src/pages/api/agency/plugins/checkout.ts";
import { handleAgencyPluginsOverviewRequest } from "../../apps/web/src/pages/api/agency/plugins/index.ts";
import { handleAgencyPluginOrderSettleRequest } from "../../apps/web/src/pages/api/agency/plugins/orders/[orderId]/settle.ts";
import { handleAgencyPluginReceiptPdfRequest } from "../../apps/web/src/pages/api/agency/plugins/receipts/[receiptId]/pdf.ts";
import { handleConsolePluginCatalogRequest } from "../../apps/web/src/pages/api/console/plugins/catalog.ts";
import { handleConsolePluginGrantsRequest } from "../../apps/web/src/pages/api/console/plugins/grants.ts";
import { handleConsoleCustomPluginRequests } from "../../apps/web/src/pages/api/console/plugins/requests.ts";
import type { TenantPluginRuntimeEnv } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/_shared.ts";
import { handleTenantPluginCheckoutRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/checkout.ts";
import { handleTenantCustomPluginDevRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/custom-dev.ts";
import { handleTenantPluginOrderSettleRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/orders/[orderId]/settle.ts";
import { handleTenantPluginReceiptPdfRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/receipts/[receiptId]/pdf.ts";
import { handleTenantPluginStoreItemRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/store/[pluginSlug].ts";
import { handleTenantPluginStoreListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/store.ts";
import { runPluginAddonExpirySweep } from "../../apps/web/src/worker/queues/billing/plugin-addons.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "task098-app-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "task098-console-secret-fedcba9876543210fedcba9876";
const NOW_MS = Date.UTC(2026, 10, 23, 5, 0, 0);
const MOCK_POLICY = createMockOnlyVerifiedSettlementPolicy();

function buildAppEnv(): TenantPluginRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function buildAgencyEnv(): AgencyRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function buildConsoleEnv(): ConsoleRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function jsonRequest(
  origin: string,
  pathname: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = {
    Origin: origin,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...extraHeaders,
  };
  return new Request(`${origin}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function createPaidAdvicePort(expectedAmountIdr: number): PluginAddonAdvicePort {
  return {
    async fetchAdvice(query) {
      return {
        rc: "00",
        ket: "Settlement confirmed",
        providerTransactionId: query.paymentAttemptId,
        reffId: query.providerReffId,
        paymentStatus: "PAID_SETTLED",
        shippingStatus: null,
        paidAmountIdr: expectedAmountIdr,
        currency: "IDR",
        settledAtMs: NOW_MS,
      };
    },
  };
}

async function seedTwoFactorOperator(params: {
  readonly userId: string;
  readonly email: string;
  readonly role?: "platform_superadmin" | "platform_support";
  readonly nowMs?: number;
}): Promise<{ readonly userId: string; readonly email: string; readonly sessionId: string }> {
  const ts = params.nowMs ?? NOW_MS;
  const sessionId = `sess_${params.userId}`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, 'Operator Test', ?, 1, 1, ?, ?)`,
    ).bind(params.userId, params.email, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, ts + 4 * 60 * 60 * 1000, `tok_${sessionId}`, params.userId, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO session_two_factor_verifications (session_id, user_id, verified_at, method, created_at, updated_at)
       VALUES (?, ?, ?, 'totp', ?, ?)`,
    ).bind(sessionId, params.userId, ts, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO platform_operators (user_id, granted_by, reason, granted_at, role)
       VALUES (?, ?, 'Bootstrap test operator', ?, ?)`,
    ).bind(params.userId, params.userId, ts, params.role ?? "platform_superadmin"),
  ]);
  return { userId: params.userId, email: params.email, sessionId };
}

async function seedAgencyAdmin(params: {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly agencyId: string;
  readonly agencyName: string;
  readonly discountPercent: number;
  readonly nowMs?: number;
}): Promise<{
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly agencyId: string;
}> {
  const ts = params.nowMs ?? NOW_MS;
  const sessionId = `sess_${params.userId}`;
  const orgId = `org_${params.agencyId}`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
    ).bind(params.userId, params.name, params.email, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(sessionId, ts + 8 * 60 * 60 * 1000, `tok_${sessionId}`, params.userId, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO session_two_factor_verifications (session_id, user_id, verified_at, method, created_at, updated_at)
       VALUES (?, ?, ?, 'totp', ?, ?)`,
    ).bind(sessionId, params.userId, ts, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(orgId, params.agencyName, params.agencyId.toLowerCase(), ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO agencies (
         id, organization_id, owner_user_id, name, status, discount_percent,
         unpaid_trial_cap, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'active', ?, 3, 1, ?, ?)`,
    ).bind(params.agencyId, orgId, params.userId, params.agencyName, params.discountPercent, ts, ts),
    env.PLATFORM_DB.prepare(
      `INSERT INTO agency_members (id, agency_id, user_id, role, status, invited_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'agency_owner', 'active', ?, ?, ?)`,
    ).bind(`agm_${params.agencyId}_owner`, params.agencyId, params.userId, params.userId, ts, ts),
  ]);
  return {
    userId: params.userId,
    email: params.email,
    name: params.name,
    sessionId,
    agencyId: params.agencyId,
  };
}

async function seedTenantFixture(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly status?: string;
  readonly agencyId?: string | null;
  readonly affiliateId?: string | null;
}) {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    ).bind(params.ownerUserId, `${params.name} Owner`, params.ownerEmail, NOW_MS, NOW_MS),
    env.PLATFORM_DB.prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(params.orgId, params.name, params.handle, NOW_MS, NOW_MS),
    env.PLATFORM_DB.prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_${params.tenantId}`, params.orgId, params.ownerUserId, NOW_MS),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (
         id, organization_id, handle, name, vertical, status, agency_id,
         referred_by_affiliate_id, paid_through, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      params.status ?? "active",
      params.agencyId ?? null,
      params.affiliateId ?? null,
      NOW_MS + 60 * 86_400_000,
      NOW_MS,
      NOW_MS,
    ),
  ]);
}

async function resetDb(): Promise<void> {
  const r2List = await env.MEDIA_BUCKET.list({ prefix: "platform/plugin-receipts/" });
  if (r2List.objects.length > 0) {
    await env.MEDIA_BUCKET.delete(r2List.objects.map((o) => o.key));
  }
  await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS plugin_addon_orders_no_delete").run();
  await env.PLATFORM_DB.prepare("DROP TRIGGER IF EXISTS plugin_addon_receipts_no_delete").run();
  await env.PLATFORM_DB.prepare(
    "DROP TRIGGER IF EXISTS affiliate_commission_entries_paid_no_delete",
  ).run();
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM plugin_custom_dev_requests"),
    env.PLATFORM_DB.prepare("DELETE FROM plugin_addon_receipts"),
    env.PLATFORM_DB.prepare("DELETE FROM plugin_addon_receipt_counters"),
    env.PLATFORM_DB.prepare("DELETE FROM plugin_addon_orders"),
    env.PLATFORM_DB.prepare("DELETE FROM plugin_tenant_entitlements"),
    env.PLATFORM_DB.prepare("DELETE FROM plugin_private_grants"),
    env.PLATFORM_DB.prepare("DELETE FROM tenant_plugin_entitlements"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_commission_entries"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_client_links"),
    env.PLATFORM_DB.prepare("DELETE FROM promo_coupons"),
    env.PLATFORM_DB.prepare("DELETE FROM migration_bookmarks"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliate_referrals"),
    env.PLATFORM_DB.prepare("DELETE FROM affiliates"),
    env.PLATFORM_DB.prepare("DELETE FROM agency_members"),
    env.PLATFORM_DB.prepare("DELETE FROM agencies"),
    env.PLATFORM_DB.prepare("DELETE FROM members"),
    env.PLATFORM_DB.prepare("DELETE FROM organizations"),
    env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
    env.PLATFORM_DB.prepare("DELETE FROM platform_operators"),
    env.PLATFORM_DB.prepare("DELETE FROM sessions"),
    env.PLATFORM_DB.prepare("DELETE FROM users"),
    env.PLATFORM_DB.prepare(
      "DELETE FROM plugin_catalog_items WHERE slug NOT IN ('seo-ai-autopilot', 'bio-links', 'wp-importer', 'wa-cs-rotator', 'lead-notifier-pro')",
    ),
  ]);
  await env.PLATFORM_DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS plugin_addon_orders_no_delete
     BEFORE DELETE ON plugin_addon_orders
     BEGIN SELECT RAISE(ABORT, 'plugin_addon_orders cannot be deleted'); END`,
  ).run();
  await env.PLATFORM_DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS plugin_addon_receipts_no_delete
     BEFORE DELETE ON plugin_addon_receipts
     BEGIN SELECT RAISE(ABORT, 'plugin_addon_receipts cannot be deleted'); END`,
  ).run();
}

describe("TASK-098 Workerd + D1 + TenantStore Integration Suite", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => NOW_MS);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await applyBillingCouponsMigration(env.PLATFORM_DB, () => NOW_MS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB, () => NOW_MS);
    await applyAgencyPortalMigration(env.PLATFORM_DB, () => NOW_MS);
    await applyAffiliateMigrations(env.PLATFORM_DB, () => NOW_MS);
    await applyAffiliateCommissionLedgerMigrations(env.PLATFORM_DB, () => NOW_MS);
    await applyPluginStoreBillingMigrations(env.PLATFORM_DB, () => NOW_MS);
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("enforces Custom Dev rate limit (3/day), blocks operator fulfillment (422 GRANT_REQUIRED) without active grant, and fulfills once linked", async () => {
    const tenantId = "01JT098TENANTCSTM000000001";
    await seedTenantFixture({
      tenantId,
      orgId: "org_t098_custom",
      handle: "studio-custom",
      name: "Studio Custom",
      ownerUserId: "usr_t098_owner1",
      ownerEmail: "owner1@example.com",
    });

    const operator = await seedTwoFactorOperator({
      userId: "usr_t098_op1",
      email: "op1@punyasitus.com",
      role: "platform_superadmin",
      nowMs: NOW_MS,
    });

    // Reject unknown keys on Custom Dev submission
    const unknownKeyRes = await handleTenantCustomPluginDevRequest(
      tenantId,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/custom-dev`, "POST", {
        serviceKind: "custom_plugin",
        title: "Kalkulator RAB",
        requirementsSummary: "Butuh kalkulator RAB kustom lengkap untuk penawaran kontraktor.",
        contactWhatsapp: "081234567890",
        hackedField: true,
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_owner1" }, nowMs: NOW_MS },
    );
    expect(unknownKeyRes.status).toBe(422);

    // Submit 3 valid requests (daily cap = 3)
    let firstRequestId = "";
    for (let i = 1; i <= 3; i += 1) {
      const res = await handleTenantCustomPluginDevRequest(
        tenantId,
        jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/custom-dev`, "POST", {
          serviceKind: "custom_plugin",
          title: `Plugin Kustom #${i}`,
          requirementsSummary:
            "Integrasi formulir kalkulator estimasi proyek dengan ringkasan PDF otomatis untuk tim sales.",
          contactWhatsapp: "081234567890",
          budgetRange: "Rp 4.000.000",
        }),
        buildAppEnv(),
        { authenticatedUser: { id: "usr_t098_owner1" }, nowMs: NOW_MS + i * 1000 },
      );
      expect(res.status).toBe(201);
      const data = (await res.json()) as { request: { id: string; serviceKind: string } };
      expect(data.request.serviceKind).toBe("custom_plugin");
      if (i === 1) firstRequestId = data.request.id;
    }

    // 4th request same day -> 429 DAILY_REQUEST_LIMIT_REACHED
    const fourthRes = await handleTenantCustomPluginDevRequest(
      tenantId,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/custom-dev`, "POST", {
        serviceKind: "custom_plugin",
        title: "Plugin Kustom #4",
        requirementsSummary: "Permintaan keempat pada hari yang sama harus terkena batas harian.",
        contactWhatsapp: "081234567890",
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_owner1" }, nowMs: NOW_MS + 5000 },
    );
    expect(fourthRes.status).toBe(429);

    // Operator quotes request first (`submitted -> quoted`)
    const quoteRes = await handleConsoleCustomPluginRequests(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/requests", "PATCH", {
        id: firstRequestId,
        status: "quoted",
        expectedVersion: 1,
        quoteAmountIdr: 4_500_000,
        reason: "Menyetujui estimasi biaya pengembangan plugin kustom RAB untuk klien.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 10_000,
      },
    );
    expect(quoteRes.status).toBe(200);

    // Operator attempts `fulfilled` WITHOUT an active `private_client` grant -> 422 GRANT_REQUIRED!
    const blockedFulfill = await handleConsoleCustomPluginRequests(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/requests", "PATCH", {
        id: firstRequestId,
        status: "fulfilled",
        expectedVersion: 2,
        reason: "Mencoba menyelesaikan permintaan tanpa menautkan izin aktif klien.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 12_000,
      },
    );
    expect(blockedFulfill.status).toBe(422);
    const blockedBody = (await blockedFulfill.json()) as { error: { code: string } };
    expect(blockedBody.error.code).toBe("GRANT_REQUIRED");

    // Operator creates `private_client` plugin & issues active grant to tenant
    const createCatalogRes = await handleConsolePluginCatalogRequest(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/catalog", "POST", {
        slug: "rab-kontraktor-privat",
        name: "Kalkulator RAB Kontraktor",
        tagline: "Estimasi proyek eksklusif klien",
        description: "Plugin privat kalkulator estimasi RAB khusus klien Studio Custom.",
        visibilityTier: "private_client",
        billingModel: "free",
        priceIdr: 0,
        reason: "Mendaftarkan plugin khusus klien rab-kontraktor-privat untuk kontrak proyek.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 15_000,
      },
    );
    expect(createCatalogRes.status).toBe(201);

    const grantRes = await handleConsolePluginGrantsRequest(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/grants", "POST", {
        pluginSlug: "rab-kontraktor-privat",
        tenantId,
        reason: "Memberikan izin aktif plugin rab-kontraktor-privat kepada Studio Custom.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 20_000,
      },
    );
    expect(grantRes.status).toBe(201);
    const { grant } = (await grantRes.json()) as { grant: { id: string } };

    // Now operator fulfills request with linked active grant -> 200!
    const fulfillRes = await handleConsoleCustomPluginRequests(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/requests", "PATCH", {
        id: firstRequestId,
        status: "fulfilled",
        expectedVersion: 2,
        linkedGrantId: grant.id,
        reason: "Plugin rab-kontraktor-privat selesai diuji dan izin aktif telah ditautkan.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 25_000,
      },
    );
    expect(fulfillRes.status).toBe(200);
    const fulfilledData = (await fulfillRes.json()) as {
      request: { status: string; linkedGrantId: string; linkedPluginSlug: string };
    };
    expect(fulfilledData.request.status).toBe("fulfilled");
    expect(fulfilledData.request.linkedGrantId).toBe(grant.id);
    expect(fulfilledData.request.linkedPluginSlug).toBe("rab-kontraktor-privat");
  });

  it("keeps private_client invisible (404/omitted) to ungranted tenant, usable by granted tenant, and immediately public upon 2FA operator promotion", async () => {
    const tenantGranted = "01JT098TENANTGRNT000000001";
    const tenantOther = "01JT098TENANTNGRN000000002";
    await seedTenantFixture({
      tenantId: tenantGranted,
      orgId: "org_t098_granted",
      handle: "klien-granted",
      name: "Klien Granted",
      ownerUserId: "usr_t098_g1",
      ownerEmail: "g1@example.com",
    });
    await seedTenantFixture({
      tenantId: tenantOther,
      orgId: "org_t098_other",
      handle: "klien-lain",
      name: "Klien Lain",
      ownerUserId: "usr_t098_g2",
      ownerEmail: "g2@example.com",
    });

    const operator = await seedTwoFactorOperator({
      userId: "usr_t098_op2",
      email: "op2@punyasitus.com",
      role: "platform_superadmin",
      nowMs: NOW_MS,
    });

    // Create private_client plugin & grant ONLY to tenantGranted
    await handleConsolePluginCatalogRequest(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/catalog", "POST", {
        slug: "crm-connector-bespoke",
        name: "CRM Connector Bespoke",
        tagline: "Sinkronisasi prospek ke ERP internal",
        description: "Plugin privat untuk integrasi CRM klien.",
        visibilityTier: "private_client",
        billingModel: "free",
        priceIdr: 0,
        reason: "Mendaftarkan plugin bespoke private_client untuk klien pertama.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS,
      },
    );

    await handleConsolePluginGrantsRequest(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/grants", "POST", {
        pluginSlug: "crm-connector-bespoke",
        tenantId: tenantGranted,
        reason: "Izin akses eksklusif crm-connector-bespoke untuk Klien Granted.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 1000,
      },
    );

    // Ungranted tenant: OMITTED from store list AND 404 on direct GET & POST install!
    const otherListRes = await handleTenantPluginStoreListRequest(
      tenantOther,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantOther}/plugins/store`, "GET"),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_g2" }, nowMs: NOW_MS + 2000 },
    );
    expect(otherListRes.status).toBe(200);
    const otherList = (await otherListRes.json()) as { items: { slug: string }[] };
    expect(otherList.items.some((i) => i.slug === "crm-connector-bespoke")).toBe(false);

    const otherDirectGet = await handleTenantPluginStoreItemRequest(
      tenantOther,
      "crm-connector-bespoke",
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantOther}/plugins/store/crm-connector-bespoke`, "GET"),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_g2" }, nowMs: NOW_MS + 2000 },
    );
    expect(otherDirectGet.status).toBe(404);

    const otherInstall = await handleTenantPluginStoreItemRequest(
      tenantOther,
      "crm-connector-bespoke",
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantOther}/plugins/store/crm-connector-bespoke`,
        "POST",
        {},
      ),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_g2" }, nowMs: NOW_MS + 2000 },
    );
    expect(otherInstall.status).toBe(404);

    // Granted tenant: VISIBLE and 1-click installable!
    const grantedInstall = await handleTenantPluginStoreItemRequest(
      tenantGranted,
      "crm-connector-bespoke",
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantGranted}/plugins/store/crm-connector-bespoke`,
        "POST",
        {},
      ),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_g1" }, nowMs: NOW_MS + 2000 },
    );
    expect(grantedInstall.status).toBe(200);

    // 2FA operator promotes `private_client` -> `public_paid` purely via metadata update!
    const promoteRes = await handleConsolePluginCatalogRequest(
      jsonRequest(CONSOLE_ORIGIN, "/api/console/plugins/catalog", "PATCH", {
        slug: "crm-connector-bespoke",
        name: "CRM Connector Pro",
        tagline: "Sinkronisasi prospek ke CRM/ERP",
        description: "Kini tersedia untuk semua tenant di Toko Plugin Berbayar.",
        visibilityTier: "public_paid",
        billingModel: "paid_once",
        priceIdr: 350_000,
        expectedVersion: 1,
        reason: "Mempromosikan plugin crm-connector-bespoke ke public_paid tanpa ubah kode.",
      }),
      buildConsoleEnv(),
      {
        session: { id: operator.sessionId, userId: operator.userId },
        user: { id: operator.userId, email: operator.email },
        nowMs: NOW_MS + 5000,
      },
    );
    expect(promoteRes.status).toBe(200);

    // Immediately visible to tenantOther in public store!
    const afterPromoteRes = await handleTenantPluginStoreListRequest(
      tenantOther,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantOther}/plugins/store`, "GET"),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_g2" }, nowMs: NOW_MS + 6000 },
    );
    const afterPromote = (await afterPromoteRes.json()) as {
      items: { slug: string; visibilityTier: string; priceIdr: number }[];
    };
    const promoted = afterPromote.items.find((i) => i.slug === "crm-connector-bespoke");
    expect(promoted).toBeDefined();
    expect(promoted?.visibilityTier).toBe("public_paid");
    expect(promoted?.priceIdr).toBe(350_000);
  });

  it("settles paid_once & paid_monthly via mocked AutoLaris Advice idempotently, generates PDF receipts, credits affiliate commission, and preserves plg_* data on expiry", async () => {
    const tenantId = "01JT098TENANTPAD0000000001";
    const affiliateUserId = "usr_t098_aff1";
    const affiliateId = "aff_t098_001";

    // Seed active affiliate + referred tenant
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, 'Mitra Aff', 'aff@example.com', 1, 0, ?, ?)`,
      ).bind(affiliateUserId, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO affiliates (
           id, user_id, referral_code, status, payout_method, payout_account_name,
           payout_account_number, version, created_at, updated_at
         ) VALUES (?, ?, 'MITRA98', 'active', 'BCA', 'Mitra Aff', '1234567890', 1, ?, ?)`,
      ).bind(affiliateId, affiliateUserId, NOW_MS, NOW_MS),
    ]);

    await seedTenantFixture({
      tenantId,
      orgId: "org_t098_paid",
      handle: "toko-paid",
      name: "Toko Paid",
      ownerUserId: "usr_t098_paid_owner",
      ownerEmail: "paid@example.com",
      affiliateId,
    });

    await env.PLATFORM_DB.prepare(
      `INSERT INTO affiliate_referrals (
         tenant_id, affiliate_id, referral_code, attribution_source,
         attributed_at, locked, version, created_at, updated_at
       ) VALUES (?, ?, 'MITRA98', 'cookie', ?, 1, 1, ?, ?)`,
    )
      .bind(tenantId, affiliateId, NOW_MS, NOW_MS, NOW_MS)
      .run();

    // Initialize real TenantStore DO and create a `plg_wa_cs_rotator__agents` table with real rows!
    const tenantStub = openTenantStoreStub(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      tenantId,
    );
    await orchestrateTenantMigration(env.PLATFORM_DB, tenantStub, tenantId, [
      ...TENANT_MIGRATIONS,
      TENANT_PLUGIN_LEDGER_MIGRATION,
    ]);
    const tenantDb = createTenantDb(tenantStub);
    await tenantDb
      .prepare(
        `CREATE TABLE IF NOT EXISTS plg_wa_cs_rotator__agents (
           id TEXT PRIMARY KEY,
           agent_name TEXT NOT NULL,
           phone TEXT NOT NULL
         )`,
      )
      .run();
    await tenantDb
      .prepare(
        `INSERT INTO plg_wa_cs_rotator__agents (id, agent_name, phone)
         VALUES ('ag_1', 'Rina Sales', '6281200001111'), ('ag_2', 'Budi Sales', '6281200002222')`,
      )
      .run();

    // Reject client-supplied price override -> 422!
    const forgedPriceRes = await handleTenantPluginCheckoutRequest(
      tenantId,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/checkout`, "POST", {
        pluginSlug: "wa-cs-rotator",
        channelCode: "QRIS",
        priceIdr: 100,
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_paid_owner" }, nowMs: NOW_MS },
    );
    expect(forgedPriceRes.status).toBe(422);

    // 1. Checkout `paid_monthly` (`wa-cs-rotator`, Rp 49.000)
    const monthlyCheckoutRes = await handleTenantPluginCheckoutRequest(
      tenantId,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/checkout`, "POST", {
        pluginSlug: "wa-cs-rotator",
        channelCode: "QRIS",
        idempotencyKey: "11111111-1111-4111-8111-111111111198",
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_paid_owner" }, nowMs: NOW_MS },
    );
    expect(monthlyCheckoutRes.status).toBe(201);
    const monthlyOrder = (
      (await monthlyCheckoutRes.json()) as {
        order: { id: string; totalPayableIdr: number; netAmountIdr: number };
      }
    ).order;
    expect(monthlyOrder.netAmountIdr).toBe(49_000);

    // Settle via mocked AutoLaris Advice
    const settleMonthly1 = await handleTenantPluginOrderSettleRequest(
      tenantId,
      monthlyOrder.id,
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantId}/plugins/orders/${monthlyOrder.id}/settle`,
        "POST",
        {},
      ),
      buildAppEnv(),
      {
        authenticatedUser: { id: "usr_t098_paid_owner" },
        advicePort: createPaidAdvicePort(monthlyOrder.totalPayableIdr),
        policy: MOCK_POLICY,
        nowMs: NOW_MS + 1000,
      },
    );
    expect(settleMonthly1.status).toBe(200);
    const settled1 = (await settleMonthly1.json()) as {
      settled: boolean;
      idempotentReplay: boolean;
      entitlement: { status: string; enabled: boolean; expiresAtMs: number };
      receipt: { id: string; receiptNumber: string };
      affiliateCommission: { status: string; entryKind: string; commissionIdr: number };
    };
    expect(settled1.settled).toBe(true);
    expect(settled1.idempotentReplay).toBe(false);
    expect(settled1.entitlement.status).toBe("active");
    expect(settled1.entitlement.enabled).toBe(true);
    expect(settled1.entitlement.expiresAtMs).toBe(NOW_MS + 1000 + PLUGIN_MONTHLY_DURATION_MS);
    expect(settled1.receipt.receiptNumber).toBe("INV-PLG-2026-000001");
    expect(settled1.affiliateCommission.status).toBe("created");
    expect(settled1.affiliateCommission.entryKind).toBe("first_payment");
    expect(settled1.affiliateCommission.commissionIdr).toBe(Math.floor((49_000 * 6000) / 10_000));

    // Duplicate Advice replay -> 100% idempotent (same receipt, no duplicate commission, no double expiry!)
    const settleMonthlyReplay = await handleTenantPluginOrderSettleRequest(
      tenantId,
      monthlyOrder.id,
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantId}/plugins/orders/${monthlyOrder.id}/settle`,
        "POST",
        {},
      ),
      buildAppEnv(),
      {
        authenticatedUser: { id: "usr_t098_paid_owner" },
        advicePort: createPaidAdvicePort(monthlyOrder.totalPayableIdr),
        policy: MOCK_POLICY,
        nowMs: NOW_MS + 5000,
      },
    );
    const replayData = (await settleMonthlyReplay.json()) as {
      idempotentReplay: boolean;
      receipt: { receiptNumber: string };
      entitlement: { expiresAtMs: number };
      affiliateCommission: { status: string };
    };
    expect(replayData.idempotentReplay).toBe(true);
    expect(replayData.receipt.receiptNumber).toBe("INV-PLG-2026-000001");
    expect(replayData.entitlement.expiresAtMs).toBe(settled1.entitlement.expiresAtMs);
    expect(replayData.affiliateCommission.status).toBe("duplicate");

    // Download immutable PDF receipt
    const pdfRes = await handleTenantPluginReceiptPdfRequest(
      tenantId,
      settled1.receipt.id,
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantId}/plugins/receipts/${settled1.receipt.id}/pdf`,
        "GET",
      ),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_paid_owner" }, nowMs: NOW_MS + 6000 },
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("Content-Type")).toBe("application/pdf");
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    // 2. Checkout & settle `paid_once` (`lead-notifier-pro`, Rp 299.000) -> sequential receipt #2 & renewal 20% commission!
    const onceCheckoutRes = await handleTenantPluginCheckoutRequest(
      tenantId,
      jsonRequest(APP_ORIGIN, `/api/tenants/${tenantId}/plugins/checkout`, "POST", {
        pluginSlug: "lead-notifier-pro",
        channelCode: "VA_BCA",
        idempotencyKey: "22222222-2222-4222-8222-222222222298",
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_paid_owner" }, nowMs: NOW_MS + 7000 },
    );
    expect(onceCheckoutRes.status).toBe(201);
    const onceOrder = (
      (await onceCheckoutRes.json()) as { order: { id: string; totalPayableIdr: number } }
    ).order;

    const settleOnceRes = await handleTenantPluginOrderSettleRequest(
      tenantId,
      onceOrder.id,
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${tenantId}/plugins/orders/${onceOrder.id}/settle`,
        "POST",
        {},
      ),
      buildAppEnv(),
      {
        authenticatedUser: { id: "usr_t098_paid_owner" },
        advicePort: createPaidAdvicePort(onceOrder.totalPayableIdr),
        policy: MOCK_POLICY,
        nowMs: NOW_MS + 8000,
      },
    );
    const settledOnce = (await settleOnceRes.json()) as {
      entitlement: { expiresAtMs: number | null; sourceKind: string };
      receipt: { receiptNumber: string };
      affiliateCommission: { status: string; entryKind: string; commissionIdr: number };
    };
    expect(settledOnce.entitlement.sourceKind).toBe("paid_once");
    expect(settledOnce.entitlement.expiresAtMs).toBeNull();
    expect(settledOnce.receipt.receiptNumber).toBe("INV-PLG-2026-000002");
    expect(settledOnce.affiliateCommission.status).toBe("created");
    expect(settledOnce.affiliateCommission.entryKind).toBe("renewal");
    expect(settledOnce.affiliateCommission.commissionIdr).toBe(Math.floor((299_000 * 2000) / 10_000));

    // Verify total affiliate ledger entries = exactly 2
    const ledgerEntries = await listAffiliateCommissionEntries(env.PLATFORM_DB, {
      affiliateId,
    });
    expect(ledgerEntries.length).toBe(2);

    // 3. Advance clock past +30d -> expireLapsedPluginAddons deactivates `wa-cs-rotator` WITHOUT deleting `plg_wa_cs_rotator__agents`!
    const sweepRes = await runPluginAddonExpirySweep(env.PLATFORM_DB, {
      nowMs: NOW_MS + PLUGIN_MONTHLY_DURATION_MS + 60_000,
      resolveTenantDb: (tid) => (tid === tenantId ? tenantDb : null),
    });
    expect(sweepRes.expiredCount).toBe(1);
    expect(sweepRes.expiredEntitlements[0]?.pluginSlug).toBe("wa-cs-rotator");

    // Verify `installed_plugins.enabled = 0` AND `plg_wa_cs_rotator__agents` rows 100% PRESERVED!
    const installedRow = await tenantDb
      .prepare("SELECT enabled FROM installed_plugins WHERE plugin_id = 'wa-cs-rotator'")
      .first<{ enabled: number }>();
    expect(installedRow?.enabled).toBe(0);

    const plgRows = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM plg_wa_cs_rotator__agents")
      .first<{ cnt: number }>();
    expect(Number(plgRows?.cnt)).toBe(2);

    // Meanwhile `paid_once` (`lead-notifier-pro`) remains active!
    const onceEnt = await env.PLATFORM_DB.prepare(
      "SELECT status, enabled FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = 'lead-notifier-pro'",
    )
      .bind(tenantId)
      .first<{ status: string; enabled: number }>();
    expect(onceEnt?.status).toBe("active");
    expect(onceEnt?.enabled).toBe(1);
  });

  it("routes agency-managed client purchases strictly to owning agency payer, blocks client checkout (403 AGENCY_PAYER_ONLY), and blocks cross-agency RBAC escalation (403/404)", async () => {
    const agencyA = await seedAgencyAdmin({
      userId: "usr_t098_agA_admin",
      email: "admin-a@agency.id",
      name: "Admin Agensi A",
      agencyId: "ag_t098_A",
      agencyName: "Agensi Alpha",
      discountPercent: 20,
      nowMs: NOW_MS,
    });

    const agencyB = await seedAgencyAdmin({
      userId: "usr_t098_agB_admin",
      email: "admin-b@agency.id",
      name: "Admin Agensi B",
      agencyId: "ag_t098_B",
      agencyName: "Agensi Beta",
      discountPercent: 10,
      nowMs: NOW_MS,
    });

    // Add agencyA's user as read-only `agency_staff` on Agency B to test cross-agency RBAC escalation!
    await addAgencyMember(env.PLATFORM_DB, {
      agencyId: agencyB.agencyId,
      targetUserId: agencyA.userId,
      role: "agency_staff",
      actorUserId: agencyB.userId,
      nowMs: NOW_MS,
    });

    const clientA = "01JT098CAGENCYAAA000000001";
    const clientB = "01JT098CAGENCYBBB000000002";
    await seedTenantFixture({
      tenantId: clientA,
      orgId: "org_t098_clientA",
      handle: "klien-alpha",
      name: "Klien Alpha",
      ownerUserId: "usr_t098_clientA_owner",
      ownerEmail: "client-a@example.com",
      agencyId: agencyA.agencyId,
    });
    await seedTenantFixture({
      tenantId: clientB,
      orgId: "org_t098_clientB",
      handle: "klien-beta",
      name: "Klien Beta",
      ownerUserId: "usr_t098_clientB_owner",
      ownerEmail: "client-b@example.com",
      agencyId: agencyB.agencyId,
    });

    // 1. Client tenant user attempts self-serve checkout -> 403 AGENCY_PAYER_ONLY!
    const clientCheckoutRes = await handleTenantPluginCheckoutRequest(
      clientA,
      jsonRequest(APP_ORIGIN, `/api/tenants/${clientA}/plugins/checkout`, "POST", {
        pluginSlug: "wa-cs-rotator",
        channelCode: "QRIS",
      }),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_clientA_owner" }, nowMs: NOW_MS },
    );
    expect(clientCheckoutRes.status).toBe(403);
    const clientErr = (await clientCheckoutRes.json()) as { error: { code: string } };
    expect(clientErr.error.code).toBe("AGENCY_PAYER_ONLY");

    // 2. Agency A admin tries cross-agency RBAC escalation by passing `agencyId: agencyB.agencyId` (where they are only `agency_staff`) -> 403 FORBIDDEN!
    const escalationRes = await handleAgencyPluginCheckoutRequest(
      jsonRequest(APP_ORIGIN, "/api/agency/plugins/checkout", "POST", {
        agencyId: agencyB.agencyId,
        tenantId: clientB,
        pluginSlug: "wa-cs-rotator",
        channelCode: "QRIS",
        idempotencyKey: "33333333-3333-4333-8333-333333333398",
      }),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        nowMs: NOW_MS,
      },
    );
    expect(escalationRes.status).toBe(403);

    // 3. Agency A admin tries buying for Agency B's client under Agency A -> neutral 404 NOT_FOUND!
    const foreignClientRes = await handleAgencyPluginCheckoutRequest(
      jsonRequest(APP_ORIGIN, "/api/agency/plugins/checkout", "POST", {
        agencyId: agencyA.agencyId,
        tenantId: clientB,
        pluginSlug: "wa-cs-rotator",
        channelCode: "QRIS",
        idempotencyKey: "44444444-4444-4444-8444-444444444498",
      }),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        nowMs: NOW_MS,
      },
    );
    expect(foreignClientRes.status).toBe(404);

    // 4. Agency A admin purchases `wa-cs-rotator` for own clientA with 20% agency discount -> 201!
    const agCheckoutRes = await handleAgencyPluginCheckoutRequest(
      jsonRequest(APP_ORIGIN, "/api/agency/plugins/checkout", "POST", {
        agencyId: agencyA.agencyId,
        tenantId: clientA,
        pluginSlug: "wa-cs-rotator",
        channelCode: "VA_BCA",
        idempotencyKey: "55555555-5555-4555-8555-555555555598",
      }),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        nowMs: NOW_MS,
      },
    );
    expect(agCheckoutRes.status).toBe(201);
    const agOrder = (
      (await agCheckoutRes.json()) as {
        order: {
          id: string;
          payerKind: string;
          payerAgencyId: string;
          grossAmountIdr: number;
          discountAmountIdr: number;
          netAmountIdr: number;
          totalPayableIdr: number;
        };
      }
    ).order;
    expect(agOrder.payerKind).toBe("agency");
    expect(agOrder.payerAgencyId).toBe(agencyA.agencyId);
    expect(agOrder.grossAmountIdr).toBe(49_000);
    expect(agOrder.discountAmountIdr).toBe(9_800); // 20% agency discount
    expect(agOrder.netAmountIdr).toBe(39_200);

    // Settle agency order via AutoLaris Advice -> activates entitlement, issues agency PDF receipt, 0 affiliate commission!
    const agSettleRes = await handleAgencyPluginOrderSettleRequest(
      agOrder.id,
      jsonRequest(APP_ORIGIN, `/api/agency/plugins/orders/${agOrder.id}/settle`, "POST", {}),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        advicePort: createPaidAdvicePort(agOrder.totalPayableIdr),
        policy: MOCK_POLICY,
        nowMs: NOW_MS + 1000,
      },
    );
    expect(agSettleRes.status).toBe(200);
    const agSettled = (await agSettleRes.json()) as {
      settled: boolean;
      receipt: { id: string; payerKind: string };
      affiliateCommission: { status: string; reason: string };
    };
    expect(agSettled.settled).toBe(true);
    expect(agSettled.receipt.payerKind).toBe("agency");
    expect(agSettled.affiliateCommission.status).toBe("ineligible");

    // Agency A can download PDF receipt; Agency B gets 404; client tenant gets 403 AGENCY_PAYER_ONLY!
    const agAPdf = await handleAgencyPluginReceiptPdfRequest(
      agSettled.receipt.id,
      jsonRequest(APP_ORIGIN, `/api/agency/plugins/receipts/${agSettled.receipt.id}/pdf`, "GET"),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        nowMs: NOW_MS + 2000,
      },
    );
    expect(agAPdf.status).toBe(200);

    const agBPdf = await handleAgencyPluginReceiptPdfRequest(
      agSettled.receipt.id,
      jsonRequest(APP_ORIGIN, `/api/agency/plugins/receipts/${agSettled.receipt.id}/pdf`, "GET"),
      buildAgencyEnv(),
      {
        session: { id: agencyB.sessionId, userId: agencyB.userId },
        user: { id: agencyB.userId, email: agencyB.email, name: agencyB.name },
        nowMs: NOW_MS + 2000,
      },
    );
    expect(agBPdf.status).toBe(404);

    const clientPdf = await handleTenantPluginReceiptPdfRequest(
      clientA,
      agSettled.receipt.id,
      jsonRequest(
        APP_ORIGIN,
        `/api/tenants/${clientA}/plugins/receipts/${agSettled.receipt.id}/pdf`,
        "GET",
      ),
      buildAppEnv(),
      { authenticatedUser: { id: "usr_t098_clientA_owner" }, nowMs: NOW_MS + 2000 },
    );
    expect(clientPdf.status).toBe(403);

    // Agency overview lists the entitlement and receipt
    const overviewRes = await handleAgencyPluginsOverviewRequest(
      jsonRequest(APP_ORIGIN, "/api/agency/plugins", "GET"),
      buildAgencyEnv(),
      {
        session: { id: agencyA.sessionId, userId: agencyA.userId },
        user: { id: agencyA.userId, email: agencyA.email, name: agencyA.name },
        nowMs: NOW_MS + 3000,
      },
    );
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      entitlements: { pluginSlug: string }[];
      receipts: { id: string }[];
    };
    expect(overview.entitlements.some((e) => e.pluginSlug === "wa-cs-rotator")).toBe(true);
    expect(overview.receipts.some((r) => r.id === agSettled.receipt.id)).toBe(true);
  });

  it("B1: revoking an agency-scoped private_client grant revokes client entitlements & legacy table without deleting plg_* rows", async () => {
    const operator = await seedTwoFactorOperator({
      userId: "usr_t098_op_b1",
      email: "op-b1@punyasitus.com",
      nowMs: NOW_MS,
    });
    const agency = await seedAgencyAdmin({
      userId: "usr_t098_ag_b1",
      email: "ag-b1@agency.id",
      name: "Agensi B1",
      agencyId: "ag_t098_B1",
      agencyName: "Agensi B1",
      discountPercent: 15,
      nowMs: NOW_MS,
    });

    const client1 = "01JT098B1CLIENT00000000001";
    const client2Direct = "01JT098B1CLIENT00000000002";
    await seedTenantFixture({
      tenantId: client1,
      orgId: "org_t098_b1_c1",
      handle: "b1-client-one",
      name: "B1 Client One",
      ownerUserId: "usr_t098_b1_c1",
      ownerEmail: "b1c1@example.com",
      agencyId: agency.agencyId,
    });
    await seedTenantFixture({
      tenantId: client2Direct,
      orgId: "org_t098_b1_c2",
      handle: "b1-client-two",
      name: "B1 Client Two",
      ownerUserId: "usr_t098_b1_c2",
      ownerEmail: "b1c2@example.com",
      agencyId: agency.agencyId,
    });

    // Seed real TenantStore DO with `plg_agency_bespoke__items` data on client1
    const stub1 = openTenantStoreStub(
      env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      client1,
    );
    await orchestrateTenantMigration(env.PLATFORM_DB, stub1, client1, [
      ...TENANT_MIGRATIONS,
      TENANT_PLUGIN_LEDGER_MIGRATION,
    ]);
    const tenantDb1 = createTenantDb(stub1);
    await tenantDb1
      .prepare("CREATE TABLE IF NOT EXISTS plg_agency_bespoke__items (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
      .run();
    await tenantDb1
      .prepare("INSERT INTO plg_agency_bespoke__items (id, label) VALUES ('item_1', 'Preserved Data')")
      .run();

    await upsertConsolePluginCatalogItem(env.PLATFORM_DB, {
      slug: "agency-bespoke",
      name: "Agency Bespoke Tool",
      visibilityTier: "private_client",
      billingModel: "free",
      priceIdr: 0,
      actorUserId: operator.userId,
      actorRole: "platform_superadmin",
      reason: "Mendaftarkan plugin khusus agensi untuk pengujian pencabutan izin.",
      nowMs: NOW_MS,
    });

    const agencyGrant = await issuePluginPrivateGrant(env.PLATFORM_DB, {
      pluginSlug: "agency-bespoke",
      agencyId: agency.agencyId,
      grantedByUserId: operator.userId,
      actorRole: "platform_superadmin",
      grantReason: "Memberikan izin plugin khusus kepada Agensi B1 untuk seluruh kliennya.",
      nowMs: NOW_MS + 1000,
    });

    // Client 2 also holds an independent direct grant (must survive agency grant revoke!)
    await issuePluginPrivateGrant(env.PLATFORM_DB, {
      pluginSlug: "agency-bespoke",
      tenantId: client2Direct,
      grantedByUserId: operator.userId,
      actorRole: "platform_superadmin",
      grantReason: "Izin langsung independen untuk Client Two agar tetap aktif.",
      nowMs: NOW_MS + 1500,
    });

    await installOrEnableStorePlugin(env.PLATFORM_DB, {
      tenantId: client1,
      pluginSlug: "agency-bespoke",
      actorUserId: "usr_t098_b1_c1",
      actorRole: "owner",
      nowMs: NOW_MS + 2000,
      tenantDb: tenantDb1,
    });
    await installOrEnableStorePlugin(env.PLATFORM_DB, {
      tenantId: client2Direct,
      pluginSlug: "agency-bespoke",
      actorUserId: "usr_t098_b1_c2",
      actorRole: "owner",
      nowMs: NOW_MS + 2000,
    });

    // Revoke the agency-scoped grant!
    await revokePluginPrivateGrant(env.PLATFORM_DB, {
      grantId: agencyGrant.id,
      actorUserId: operator.userId,
      actorRole: "platform_superadmin",
      reason: "Kontrak lisensi plugin khusus Agensi B1 telah berakhir.",
      nowMs: NOW_MS + 3000,
    });

    // Client 1 MUST be revoked in BOTH `plugin_tenant_entitlements` AND legacy `tenant_plugin_entitlements`
    const c1Ent = await env.PLATFORM_DB.prepare(
      "SELECT status, enabled FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = 'agency-bespoke'",
    )
      .bind(client1)
      .first<{ status: string; enabled: number }>();
    expect(c1Ent?.status).toBe("revoked");
    expect(c1Ent?.enabled).toBe(0);

    const c1Legacy = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenant_plugin_entitlements WHERE tenant_id = ? AND plugin_id = 'agency-bespoke'",
    )
      .bind(client1)
      .first<{ status: string }>();
    expect(c1Legacy?.status).toBe("revoked");

    // Client 1's `plg_*` data rows MUST remain 100% preserved!
    const preserved = await tenantDb1
      .prepare("SELECT COUNT(*) AS cnt FROM plg_agency_bespoke__items")
      .first<{ cnt: number }>();
    expect(Number(preserved?.cnt)).toBe(1);

    // Client 2 (independent direct grant) MUST remain active!
    const c2Ent = await env.PLATFORM_DB.prepare(
      "SELECT status, enabled FROM plugin_tenant_entitlements WHERE tenant_id = ? AND plugin_slug = 'agency-bespoke'",
    )
      .bind(client2Direct)
      .first<{ status: string; enabled: number }>();
    expect(c2Ent?.status).toBe("active");
    expect(c2Ent?.enabled).toBe(1);
  });

  it("B2: heals missing R2 PDF upload and legacy entitlement sync cleanly on idempotent settlement replay", async () => {
    const tenantId = "01JT098B2HEALR200000000001";
    await seedTenantFixture({
      tenantId,
      orgId: "org_t098_b2",
      handle: "b2-heal-site",
      name: "B2 Heal Site",
      ownerUserId: "usr_t098_b2",
      ownerEmail: "b2@example.com",
    });

    const created = await createPluginAddonOrder(env.PLATFORM_DB, {
      tenantId,
      pluginSlug: "lead-notifier-pro",
      payerKind: "tenant",
      payerUserId: "usr_t098_b2",
      channelCode: "QRIS",
      idempotencyKey: "bbbbbbbb-2222-4222-8222-222222222202",
      nowMs: NOW_MS,
    });

    const paidObs = await createPaidAdvicePort(created.order.totalPayableIdr).fetchAdvice({
      providerAccountId: created.order.providerAccountId,
      paymentAttemptId: created.order.paymentAttemptId,
      providerReffId: created.order.providerReffId,
    });

    // Simulate an R2 outage right after the D1 settlement batch commits!
    const failingBucket = {
      async put() {
        throw new Error("SIMULATED_R2_OUTAGE");
      },
      async head() {
        return null;
      },
      async get() {
        return null;
      },
    } as unknown as R2Bucket;

    await expect(
      settlePluginAddonOrder(env.PLATFORM_DB, {
        orderId: created.order.id,
        tenantId,
        observation: paidObs,
        policy: MOCK_POLICY,
        mediaBucket: failingBucket,
        nowMs: NOW_MS + 1000,
      }),
    ).rejects.toThrow("SIMULATED_R2_OUTAGE");

    // Verify D1 committed order as settled, R2 object is missing, and legacy entitlement wasn't synced yet
    const receiptRow = await env.PLATFORM_DB.prepare(
      "SELECT receipt_number, r2_object_key FROM plugin_addon_receipts WHERE order_id = ?",
    )
      .bind(created.order.id)
      .first<{ receipt_number: string; r2_object_key: string }>();
    expect(receiptRow?.receipt_number).toBe("INV-PLG-2026-000001");
    expect(await env.MEDIA_BUCKET.head(receiptRow!.r2_object_key)).toBeNull();

    const preHealLegacy = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenant_plugin_entitlements WHERE tenant_id = ? AND plugin_id = 'lead-notifier-pro'",
    )
      .bind(tenantId)
      .first<{ status: string }>();
    expect(preHealLegacy).toBeNull();

    // Replay settlement with healthy R2 bucket -> heals R2 PDF & legacy entitlement without changing receipt number!
    const replayed = await settlePluginAddonOrder(env.PLATFORM_DB, {
      orderId: created.order.id,
      tenantId,
      observation: paidObs,
      policy: MOCK_POLICY,
      mediaBucket: env.MEDIA_BUCKET,
      nowMs: NOW_MS + 2000,
    });
    expect(replayed.settled).toBe(true);
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.receipt?.receiptNumber).toBe("INV-PLG-2026-000001");
    expect(replayed.pdf).not.toBeNull();

    const uploadedObj = await env.MEDIA_BUCKET.get(receiptRow!.r2_object_key);
    expect(uploadedObj).not.toBeNull();
    const pdfBytes = new Uint8Array(await uploadedObj!.arrayBuffer());
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

    const postHealLegacy = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenant_plugin_entitlements WHERE tenant_id = ? AND plugin_id = 'lead-notifier-pro'",
    )
      .bind(tenantId)
      .first<{ status: string }>();
    expect(postHealLegacy?.status).toBe("active");
  });

  it("B3: atomically enforces coupon max_redemptions = 1 inside settlement batch and fails closed (422) on malformed eligible_payer_types_json", async () => {
    const tenant1 = "01JT098B3COUPON00000000001";
    const tenant2 = "01JT098B3COUPON00000000002";
    await seedTenantFixture({
      tenantId: tenant1,
      orgId: "org_t098_b3_1",
      handle: "b3-site-one",
      name: "B3 Site One",
      ownerUserId: "usr_t098_b3_1",
      ownerEmail: "b3a@example.com",
    });
    await seedTenantFixture({
      tenantId: tenant2,
      orgId: "org_t098_b3_2",
      handle: "b3-site-two",
      name: "B3 Site Two",
      ownerUserId: "usr_t098_b3_2",
      ownerEmail: "b3b@example.com",
    });

    // Seed 1-use coupon + malformed-JSON coupon
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO promo_coupons (
           id, code, discount_kind, discount_value, eligible_plans_json, eligible_payer_types_json,
           max_redemptions, redeemed_count, starts_at, ends_at, active, created_by_user_id,
           version, created_at, updated_at
         ) VALUES (
           'cpn_t098_once', 'ONCEONLY', 'fixed_idr', 10000, '["monthly"]', '["tenant"]',
           1, 0, ?, ?, 1, 'usr_t098_b3_1', 1, ?, ?
         )`,
      ).bind(NOW_MS - 10_000, NOW_MS + 86_400_000, NOW_MS, NOW_MS),
      env.PLATFORM_DB.prepare(
        `INSERT INTO promo_coupons (
           id, code, discount_kind, discount_value, eligible_plans_json, eligible_payer_types_json,
           max_redemptions, redeemed_count, starts_at, ends_at, active, created_by_user_id,
           version, created_at, updated_at
         ) VALUES (
           'cpn_t098_bad', 'BROKENJSON', 'percent', 10, '["monthly"]', '{not-valid-json',
           10, 0, ?, ?, 1, 'usr_t098_b3_1', 1, ?, ?
         )`,
      ).bind(NOW_MS - 10_000, NOW_MS + 86_400_000, NOW_MS, NOW_MS),
    ]);

    // 1. Malformed eligible_payer_types_json MUST fail closed with 422 INVALID_COUPON!
    await expect(
      createPluginAddonOrder(env.PLATFORM_DB, {
        tenantId: tenant1,
        pluginSlug: "wa-cs-rotator",
        payerKind: "tenant",
        payerUserId: "usr_t098_b3_1",
        channelCode: "QRIS",
        couponCode: "BROKENJSON",
        idempotencyKey: "cccccccc-3333-4333-8333-333333333301",
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({ status: 422, code: "INVALID_COUPON" });

    // 2. Two pending orders created while redeemed_count = 0 against max_redemptions = 1
    const ord1 = await createPluginAddonOrder(env.PLATFORM_DB, {
      tenantId: tenant1,
      pluginSlug: "wa-cs-rotator",
      payerKind: "tenant",
      payerUserId: "usr_t098_b3_1",
      channelCode: "QRIS",
      couponCode: "ONCEONLY",
      idempotencyKey: "cccccccc-3333-4333-8333-333333333302",
      nowMs: NOW_MS,
    });
    const ord2 = await createPluginAddonOrder(env.PLATFORM_DB, {
      tenantId: tenant2,
      pluginSlug: "wa-cs-rotator",
      payerKind: "tenant",
      payerUserId: "usr_t098_b3_2",
      channelCode: "QRIS",
      couponCode: "ONCEONLY",
      idempotencyKey: "cccccccc-3333-4333-8333-333333333303",
      nowMs: NOW_MS + 100,
    });

    // Settling ord1 atomically increments redeemed_count to 1 inside the settlement batch
    const obs1 = await createPaidAdvicePort(ord1.order.totalPayableIdr).fetchAdvice({
      providerAccountId: ord1.order.providerAccountId,
      paymentAttemptId: ord1.order.paymentAttemptId,
      providerReffId: ord1.order.providerReffId,
    });
    const res1 = await settlePluginAddonOrder(env.PLATFORM_DB, {
      orderId: ord1.order.id,
      tenantId: tenant1,
      observation: obs1,
      policy: MOCK_POLICY,
      nowMs: NOW_MS + 1000,
    });
    expect(res1.settled).toBe(true);
    expect(res1.receipt?.receiptNumber).toBe("INV-PLG-2026-000001");

    const couponAfter1 = await env.PLATFORM_DB.prepare(
      "SELECT redeemed_count FROM promo_coupons WHERE code = 'ONCEONLY'",
    ).first<{ redeemed_count: number }>();
    expect(Number(couponAfter1?.redeemed_count)).toBe(1);

    // Settling ord2 MUST fail closed with 409 COUPON_EXHAUSTED, keep redeemed_count = 1, and burn ZERO sequence!
    const obs2 = await createPaidAdvicePort(ord2.order.totalPayableIdr).fetchAdvice({
      providerAccountId: ord2.order.providerAccountId,
      paymentAttemptId: ord2.order.paymentAttemptId,
      providerReffId: ord2.order.providerReffId,
    });
    await expect(
      settlePluginAddonOrder(env.PLATFORM_DB, {
        orderId: ord2.order.id,
        tenantId: tenant2,
        observation: obs2,
        policy: MOCK_POLICY,
        nowMs: NOW_MS + 2000,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof PluginStoreError && e.status === 409 && e.code === "COUPON_EXHAUSTED",
    );

    const couponAfter2 = await env.PLATFORM_DB.prepare(
      "SELECT redeemed_count FROM promo_coupons WHERE code = 'ONCEONLY'",
    ).first<{ redeemed_count: number }>();
    expect(Number(couponAfter2?.redeemed_count)).toBe(1);

    const counterAfter2 = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM plugin_addon_receipt_counters WHERE year = 2026",
    ).first<{ last_seq: number }>();
    expect(Number(counterAfter2?.last_seq)).toBe(1);
  });

  it("B4: stacks two paid_monthly renewals (+60d total) cleanly even across a simulated CAS retry via D1 Proxy", async () => {
    const tenantId = "01JT098B4STACK000000000001";
    await seedTenantFixture({
      tenantId,
      orgId: "org_t098_b4",
      handle: "b4-stack-site",
      name: "B4 Stack Site",
      ownerUserId: "usr_t098_b4",
      ownerEmail: "b4@example.com",
    });

    // Create two pending `paid_monthly` orders for the same tenant & plugin
    const ord1 = await createPluginAddonOrder(env.PLATFORM_DB, {
      tenantId,
      pluginSlug: "wa-cs-rotator",
      payerKind: "tenant",
      payerUserId: "usr_t098_b4",
      channelCode: "QRIS",
      idempotencyKey: "dddddddd-4444-4444-8444-444444444401",
      nowMs: NOW_MS,
    });
    const ord2 = await createPluginAddonOrder(env.PLATFORM_DB, {
      tenantId,
      pluginSlug: "wa-cs-rotator",
      payerKind: "tenant",
      payerUserId: "usr_t098_b4",
      channelCode: "QRIS",
      idempotencyKey: "dddddddd-4444-4444-8444-444444444402",
      nowMs: NOW_MS + 100,
    });

    const obs1 = await createPaidAdvicePort(ord1.order.totalPayableIdr).fetchAdvice({
      providerAccountId: ord1.order.providerAccountId,
      paymentAttemptId: ord1.order.paymentAttemptId,
      providerReffId: ord1.order.providerReffId,
    });
    const obs2 = await createPaidAdvicePort(ord2.order.totalPayableIdr).fetchAdvice({
      providerAccountId: ord2.order.providerAccountId,
      paymentAttemptId: ord2.order.paymentAttemptId,
      providerReffId: ord2.order.providerReffId,
    });

    // Simulate a race where ord2 reads existingEntRow === null, then right before ord2's first
    // `batch()` commits, ord1 commits first (creating the entitlement at T0 + 30d)!
    // ord2's first CAS attempt MUST see 0 changes (zero burned sequence!), retry by re-reading
    // the live entitlement, and stack its +30d cleanly on top of ord1 -> T0 + 60d total!
    const t0 = NOW_MS + 5000;
    let intercepted = false;
    let ord1ReceiptNumber: string | null = null;
    const racingDb = new Proxy(env.PLATFORM_DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true;
              const r1 = await settlePluginAddonOrder(env.PLATFORM_DB, {
                orderId: ord1.order.id,
                tenantId,
                observation: obs1,
                policy: MOCK_POLICY,
                nowMs: t0,
              });
              ord1ReceiptNumber = r1.receipt?.receiptNumber ?? null;
            }
            return target.batch(stmts);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });

    const r2 = await settlePluginAddonOrder(racingDb, {
      orderId: ord2.order.id,
      tenantId,
      observation: obs2,
      policy: MOCK_POLICY,
      nowMs: t0,
    });

    expect(intercepted).toBe(true);
    expect(ord1ReceiptNumber).toBe("INV-PLG-2026-000001");
    expect(r2.settled).toBe(true);
    expect(r2.idempotentReplay).toBe(false);
    // Gap-free sequential receipt #2 (zero sequence burned during CAS retry!)
    expect(r2.receipt?.receiptNumber).toBe("INV-PLG-2026-000002");
    // Exact stacked +60d expiry (zero lost paid time!)
    expect(r2.entitlement?.expiresAtMs).toBe(t0 + 2 * PLUGIN_MONTHLY_DURATION_MS);

    const finalCounter = await env.PLATFORM_DB.prepare(
      "SELECT last_seq FROM plugin_addon_receipt_counters WHERE year = 2026",
    ).first<{ last_seq: number }>();
    expect(Number(finalCounter?.last_seq)).toBe(2);
  });
});
