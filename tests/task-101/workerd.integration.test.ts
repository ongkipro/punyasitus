import { env } from "cloudflare:workers";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  applyPlatformPluginRuntimeMigration,
  TENANT_PLUGIN_LEDGER_MIGRATION,
  upsertPluginCatalogEntry,
} from "@punyasitus/db/plugins/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../apps/web/src/core/plugin-registry.ts";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";
import { handlePluginInboundWebhook } from "../../apps/web/src/pages/api/plugins/[pluginId]/webhook.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/index.ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import { runCoreWriteWithIsolatedPluginHooks } from "../../apps/web/src/worker/queues/plugins/index.ts";
import {
  LEAD_NOTIFIER_PLUGIN_ID,
  LEAD_NOTIFIER_TABLES,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  createLeadNotifierPlugin,
  sha256Hex,
  verifyWebhookSignature,
} from "../../packages/plugins/lead-notifier/index.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const NOW_MS = Date.UTC(2026, 10, 24, 3, 0, 0);
const TEST_GET_BOOKMARK = async () => `bm_t101_${NOW_MS}`;
const TEST_TG_WEBHOOK_SECRET = "t101-telegram-webhook-secret-9e8d7c6b5a4f";
const TEST_TG_BOT_TOKEN = "999000:TEST_TELEGRAM_BOT_TOKEN";

const TENANT_A = {
  id: "01JT101TENANTALPHA00000001",
  orgId: "org_t101_alpha",
  handle: "alpha-notifier",
  name: "PT Alpha Notifier",
  host: "alpha-notifier.situsku.click",
  ownerId: "user_t101_owner_a",
  editorId: "user_t101_editor_a",
};

const TENANT_B = {
  id: "01JT101TENANTBETA000000002",
  orgId: "org_t101_beta",
  handle: "beta-isolated",
  name: "CV Beta Isolated",
  host: "beta-isolated.situsku.click",
  ownerId: "user_t101_owner_b",
};

function getTenantStoreNs(): TenantStoreNamespaceLike {
  return env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
}

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: getTenantStoreNs(),
    TELEGRAM_WEBHOOK_SECRET: TEST_TG_WEBHOOK_SECRET,
  };
}

function makeAppRequest(
  path: string,
  init: {
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Request {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Origin", APP_ORIGIN);
    headers.set("Sec-Fetch-Site", "same-origin");
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

function makeTenantLeadRequest(tenantHost: string, body: Record<string, unknown>, idempotencyKey: string): Request {
  const origin = `https://${tenantHost}`;
  return new Request(`${origin}/api/leads`, {
    method: "POST",
    headers: {
      Host: tenantHost,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.42",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function seedTenant(spec: {
  readonly id: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly host: string;
  readonly ownerId: string;
  readonly editorId?: string;
}) {
  const db = env.PLATFORM_DB;
  const paidThrough = NOW_MS + 30 * 86_400_000;

  await db
    .prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(spec.ownerId, `Owner ${spec.handle}`, `${spec.ownerId}@example.com`, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(spec.orgId, spec.name, spec.handle, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    )
    .bind(`mem_${spec.ownerId}`, spec.orgId, spec.ownerId, NOW_MS)
    .run();

  if (spec.editorId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)`,
      )
      .bind(spec.editorId, `Editor ${spec.handle}`, `${spec.editorId}@example.com`, NOW_MS, NOW_MS)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'editor', ?)`,
      )
      .bind(`mem_${spec.editorId}`, spec.orgId, spec.editorId, NOW_MS)
      .run();
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 1, 1, ?, ?)`,
    )
    .bind(spec.id, spec.orgId, spec.handle, spec.name, paidThrough, NOW_MS, NOW_MS)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
    )
    .bind(spec.host, spec.id, NOW_MS, NOW_MS)
    .run();

  const stub = openTenantStoreStub(getTenantStoreNs(), spec.id);
  const mig = await orchestrateTenantMigration(
    db,
    stub,
    spec.id,
    [...TENANT_MIGRATIONS, TENANT_PLUGIN_LEDGER_MIGRATION],
    { now: () => NOW_MS },
  );
  expect(mig.httpStatus).toBe(200);
}

describe("TASK-101 workerd Integration: 1-Click Telegram Linking, Server-Gated Signed SSRF Webhook & Non-Blocking lead.created", () => {
  interface CapturedOutbound {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }

  let outboundMode: "ok" | "http_500" | "timeout" = "ok";
  const serverGrantedWebhookTenants = new Set<string>();
  const capturedTelegramCalls: CapturedOutbound[] = [];
  const capturedWebhookCalls: CapturedOutbound[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headersObj: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headersObj[k.toLowerCase()] = v;
    });

    if (url.includes("api.telegram.org")) {
      capturedTelegramCalls.push({ url, headers: headersObj, body });
    } else {
      capturedWebhookCalls.push({ url, headers: headersObj, body });
    }

    if (outboundMode === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }

    if (outboundMode === "http_500") {
      return new Response("simulated upstream 500", { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const leadNotifierPlugin = createLeadNotifierPlugin({
    telegramBotToken: TEST_TG_BOT_TOKEN,
    telegramBotUsername: "PunyaSitusBot",
    isWebhookEntitled: (tenantId) => serverGrantedWebhookTenants.has(tenantId),
    transport: {
      fetchFn: mockFetch,
      timeoutMs: 80,
      totalDeadlineMs: 250,
      retryBaseDelayMs: 0,
      sleepFn: async () => {},
      nowMs: () => NOW_MS,
    },
  });
  const registry = createPluginRegistry([leadNotifierPlugin]);

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS, () => NOW_MS);
    await applyPlatformPluginRuntimeMigration(env.PLATFORM_DB, () => NOW_MS);
    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
    await upsertPluginCatalogEntry(env.PLATFORM_DB, leadNotifierPlugin.manifest, NOW_MS);
  });

  it("executes full lifecycle: install -> 1-click Telegram link (single-use/15m/200-ack-on-reject) -> server-gated SSRF webhook & editor URL masking -> POST /api/leads non-blocking dispatch & failure isolation -> webhookEnabled toggle -> immediate unlink revocation", async () => {
    const tenantADb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_A.id));
    const tenantBDb = createTenantDb(openTenantStoreStub(getTenantStoreNs(), TENANT_B.id));

    // 1. Install `lead-notifier` on Tenant A ONLY (public_free 1-click install)
    const installRes = await handleTenantPluginsCollectionRequest(
      TENANT_A.handle,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins`, {
        method: "POST",
        body: { pluginId: LEAD_NOTIFIER_PLUGIN_ID },
      }),
      buildRuntimeEnv(),
      {
        authenticatedUser: { id: TENANT_A.ownerId },
        registry,
        nowMs: NOW_MS,
        getBookmark: TEST_GET_BOOKMARK,
      },
    );
    expect(installRes.status).toBe(200);

    // Tenant B (uninstalled) has ZERO `plg_lead_notifier__*` tables and gets 403/404 on admin API
    const tenantBTables = await tenantBDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plg_lead_notifier__%'")
      .all();
    expect(tenantBTables.results.length).toBe(0);

    const tenantBBlocked = await handleTenantPluginSubpathApiRequest(
      TENANT_B.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/status",
      makeAppRequest(`/api/tenants/${TENANT_B.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/status`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_B.ownerId }, registry, nowMs: NOW_MS },
    );
    expect([403, 404]).toContain(tenantBBlocked.status);

    // 2. Generate 15-minute single-use Telegram link token for Tenant A
    const tokenRes1 = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/telegram/link-token",
      makeAppRequest(
        `/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/telegram/link-token`,
        { method: "POST", body: {} },
      ),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS },
    );
    expect(tokenRes1.status).toBe(201);
    const tokenBody1 = (await tokenRes1.json()) as {
      readonly deepLink: string;
      readonly expiresAt: number;
      readonly expiresInSeconds: number;
      readonly singleUse: boolean;
    };
    expect(tokenBody1.singleUse).toBe(true);
    expect(tokenBody1.expiresInSeconds).toBe(900);
    expect(tokenBody1.expiresAt).toBe(NOW_MS + TELEGRAM_LINK_TOKEN_TTL_MS);
    expect(tokenBody1.deepLink.startsWith("https://t.me/PunyaSitusBot?start=")).toBe(true);

    const plaintextToken1 = new URL(tokenBody1.deepLink).searchParams.get("start") ?? "";
    expect(plaintextToken1.length).toBeGreaterThanOrEqual(20);

    // Verify DB stores ONLY SHA-256 hash, NEVER plaintext token!
    const storedTokenRow = await tenantADb
      .prepare(`SELECT token_hash, tenant_id, used_at FROM ${LEAD_NOTIFIER_TABLES.linkTokens} LIMIT 1`)
      .first<{ readonly token_hash: string; readonly tenant_id: string; readonly used_at: number | null }>();
    expect(storedTokenRow?.token_hash).toBe(await sha256Hex(plaintextToken1));
    expect(storedTokenRow?.token_hash).not.toBe(plaintextToken1);
    expect(storedTokenRow?.used_at).toBeNull();

    const makeTelegramUpdate = (token: string, chatId = 555001122) => ({
      update_id: 1001,
      message: {
        text: `/start ${token}`,
        chat: { id: chatId, type: "private", username: "budi_owner", first_name: "Budi" },
      },
    });

    // 3a. Missing X-Telegram-Bot-Api-Secret-Token -> 401 fail-closed
    const missingSecretRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        body: makeTelegramUpdate(plaintextToken1),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + 10_000 },
    );
    expect(missingSecretRes.status).toBe(401);

    // 3b. Wrong X-Telegram-Bot-Api-Secret-Token -> 401 fail-closed
    const wrongSecretRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "wrong-secret-token" },
        body: makeTelegramUpdate(plaintextToken1),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + 10_000 },
    );
    expect(wrongSecretRes.status).toBe(401);

    // 3c. Expired token (> 15m) -> HTTP 200 non-stalling ack with rejected:true, code:TOKEN_EXPIRED, ZERO chat linked
    const expiredRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: TEST_TG_WEBHOOK_SECRET },
        body: makeTelegramUpdate(plaintextToken1),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + TELEGRAM_LINK_TOKEN_TTL_MS + 1 },
    );
    expect(expiredRes.status).toBe(200);
    expect(await expiredRes.json()).toMatchObject({
      ok: false,
      linked: false,
      rejected: true,
      code: "TOKEN_EXPIRED",
    });
    const linkAfterExpired = await tenantADb
      .prepare(`SELECT chat_id FROM ${LEAD_NOTIFIER_TABLES.telegramLinks} LIMIT 1`)
      .first();
    expect(linkAfterExpired).toBeNull();

    // 3d. Valid token within 15m -> HTTP 200 OK & links chat once
    const linkedRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: TEST_TG_WEBHOOK_SECRET },
        body: makeTelegramUpdate(plaintextToken1),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + 60_000 },
    );
    expect(linkedRes.status).toBe(200);
    expect(await linkedRes.json()).toMatchObject({
      ok: true,
      linked: true,
      rejected: false,
      tenantId: TENANT_A.id,
      maskedLabel: "@bu***er",
    });

    // 3e. Replay of same token by attacker chatId -> HTTP 200 non-stalling ack with TOKEN_REPLAYED & original chatId intact!
    const replayRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: TEST_TG_WEBHOOK_SECRET },
        body: makeTelegramUpdate(plaintextToken1, 999888777),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + 65_000 },
    );
    expect(replayRes.status).toBe(200);
    expect(await replayRes.json()).toMatchObject({
      ok: false,
      linked: false,
      rejected: true,
      code: "TOKEN_REPLAYED",
    });
    const linkAfterReplay = await tenantADb
      .prepare(`SELECT chat_id FROM ${LEAD_NOTIFIER_TABLES.telegramLinks} WHERE id = 1`)
      .first<{ readonly chat_id: string }>();
    expect(linkAfterReplay?.chat_id).toBe("555001122");

    // 3f. Cross-tenant token targeting Tenant B (uninstalled) -> rejected without affecting Tenant A
    const crossTenantToken = `${TENANT_B.id.length}_${TENANT_B.id}_abcdefghijklmnop123456`;
    const crossTenantRes = await handlePluginInboundWebhook(
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: TEST_TG_WEBHOOK_SECRET },
        body: makeTelegramUpdate(crossTenantToken, 777666555),
      }),
      buildRuntimeEnv(),
      { registry, nowMs: NOW_MS + 70_000 },
    );
    expect([403, 404]).toContain(crossTenantRes.status);

    // 4a. HIGH-1: Tenant self-grant attempt via PATCH plugin config MUST fail with 422 VALIDATION_ERROR!
    const selfGrantRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}`, {
        method: "PATCH",
        body: {
          config: {
            telegramEnabled: true,
            webhookEnabled: true,
            webhookEntitled: true,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 75_000 },
    );
    expect(selfGrantRes.status).toBe(422);

    // Without server entitlement, POST /webhook MUST return 403 WEBHOOK_ENTITLEMENT_REQUIRED
    const unentitledWhRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/webhook",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        body: { targetUrl: "https://hooks.crm.example.com/leads/secret-token-xyz" },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 80_000 },
    );
    expect(unentitledWhRes.status).toBe(403);

    // 4b. Grant server-owned paid webhook entitlement & enable webhookEnabled config toggle
    serverGrantedWebhookTenants.add(TENANT_A.id);
    const enableWhConfigRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}`, {
        method: "PATCH",
        body: {
          config: {
            telegramEnabled: true,
            webhookEnabled: true,
            botUsername: "PunyaSitusBot",
            webhookMaxRetries: 3,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 85_000 },
    );
    expect(enableWhConfigRes.status).toBe(200);

    // SSRF targets (incl. DNS rebinding suffixes) rejected with 422
    for (const badUrl of [
      "http://hooks.crm.example.com/leads",
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/internal",
      "https://[::ffff:127.0.0.1]/internal",
      "https://127.0.0.1.nip.io/hook",
    ]) {
      const ssrfRes = await handleTenantPluginSubpathApiRequest(
        TENANT_A.handle,
        LEAD_NOTIFIER_PLUGIN_ID,
        "/webhook",
        makeAppRequest(
          `/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`,
          { method: "POST", body: { targetUrl: badUrl } },
        ),
        buildRuntimeEnv(),
        { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 90_000 },
      );
      expect(ssrfRes.status, `Expected SSRF 422 for ${badUrl}`).toBe(422);
    }

    // Valid HTTPS webhook with secret path token saved -> returns secretOnce & secretMasked
    const secretWebhookUrl = "https://hooks.crm.example.com/leads/secret-path-token-123";
    const saveWhRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/webhook",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/webhook`, {
        method: "POST",
        body: { targetUrl: secretWebhookUrl, enabled: true, maxRetries: 3 },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 95_000 },
    );
    expect(saveWhRes.status).toBe(200);
    const saveWhBody = (await saveWhRes.json()) as {
      readonly secretOnce: string;
      readonly webhook: { readonly secretMasked: string; readonly targetUrl: string };
    };
    expect(saveWhBody.secretOnce).toMatch(/^whsec_[a-f0-9]{48}$/);
    expect(saveWhBody.webhook.secretMasked).toBe(`whsec_****${saveWhBody.secretOnce.slice(-4)}`);

    // Owner GET /status sees full targetUrl, NEVER raw signing_secret or raw chat_id
    const ownerStatusRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/status",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/status`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 96_000 },
    );
    const ownerStatusText = await ownerStatusRes.text();
    expect(ownerStatusRes.status).toBe(200);
    expect(ownerStatusText).not.toContain(saveWhBody.secretOnce);
    expect(ownerStatusText).not.toContain("555001122");
    expect(JSON.parse(ownerStatusText).webhook.targetUrl).toBe(secretWebhookUrl);

    // MEDIUM-3: Editor (non-settings:write role) GET /status receives masked targetUrlSummary ONLY (no secret path token!)
    const editorStatusRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/status",
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/status`),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.editorId }, registry, nowMs: NOW_MS + 97_000 },
    );
    const editorStatusText = await editorStatusRes.text();
    expect(editorStatusRes.status).toBe(200);
    expect(editorStatusText).not.toContain("secret-path-token-123");
    const editorStatus = JSON.parse(editorStatusText) as {
      readonly webhook: { readonly targetUrl: string | null; readonly targetUrlSummary: string | null };
    };
    expect(editorStatus.webhook.targetUrl).toBeNull();
    expect(editorStatus.webhook.targetUrlSummary).toBe("https://hooks.crm.example.com");

    // 5. Real `POST /api/leads` + `lead.created` hook delivers BOTH Telegram (with wa.me CTA) AND signed webhook!
    outboundMode = "ok";
    capturedTelegramCalls.length = 0;
    capturedWebhookCalls.length = 0;

    const leadRun1 = await runCoreWriteWithIsolatedPluginHooks({
      coreWrite: async () => {
        const res = await handlePublicLeadPost(
          makeTenantLeadRequest(
            TENANT_A.host,
            {
              name: "Rina Wijaya",
              phone: "081234567890",
              email: "rina@contoh.id",
              message: "Saya ingin konsultasi pembangunan ruko 3 lantai.",
              privacyConsent: true,
              sourcePath: "/kontak",
            },
            "idem-t101-lead-1",
          ),
          {
            surface: "tenant",
            tenant: {
              id: TENANT_A.id,
              handle: TENANT_A.handle,
              name: TENANT_A.name,
              host: TENANT_A.host,
              status: "active",
            },
            tenantDb: tenantADb,
            platformDb: env.PLATFORM_DB,
            appEnv: "test",
            rateLimitSalt: "t101-test-salt",
            nowMs: NOW_MS + 100_000,
          },
        );
        const body = (await res.json()) as { readonly leadNumber: number; readonly status: string };
        return { status: res.status, leadNumber: body.leadNumber };
      },
      tenantId: TENANT_A.id,
      event: "lead.created",
      eventId: (core) => `lead:${core.leadNumber}`,
      buildPayload: (core) => ({
        leadId: core.leadNumber,
        name: "Rina Wijaya",
        phoneE164: "+6281234567890",
        email: "rina@contoh.id",
        message: "Saya ingin konsultasi pembangunan ruko 3 lantai.",
        pagePath: "/kontak",
        tenantName: TENANT_A.name,
        tenantHandle: TENANT_A.handle,
      }),
      hookDeps: {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS + 100_000,
      },
    });

    expect(leadRun1.coreResult.status).toBe(201);
    expect(leadRun1.coreResult.leadNumber).toBeGreaterThan(0);
    expect(leadRun1.hookOutcomes[0]?.outcome).toBe("completed");

    expect(capturedTelegramCalls.length).toBe(1);
    const tgPayload = JSON.parse(capturedTelegramCalls[0]!.body) as {
      readonly chat_id: string;
      readonly text: string;
      readonly reply_markup?: {
        readonly inline_keyboard: readonly (readonly { readonly text: string; readonly url: string }[])[];
      };
    };
    expect(tgPayload.chat_id).toBe("555001122");
    expect(tgPayload.text).toContain("Rina Wijaya");
    const waButtonUrl = tgPayload.reply_markup?.inline_keyboard[0]?.[0]?.url ?? "";
    expect(waButtonUrl).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);

    expect(capturedWebhookCalls.length).toBe(1);
    const whCall = capturedWebhookCalls[0]!;
    expect(whCall.url).toBe(secretWebhookUrl);
    expect(whCall.headers[WEBHOOK_EVENT_HEADER.toLowerCase()]).toBe("lead.created");
    expect(whCall.headers[WEBHOOK_DELIVERY_ID_HEADER.toLowerCase()]).toBeTruthy();
    const sigVerify = await verifyWebhookSignature({
      rawBody: whCall.body,
      signatureHeader: whCall.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] ?? "",
      secret: saveWhBody.secretOnce,
      nowMs: NOW_MS,
    });
    expect(sigVerify.ok).toBe(true);

    // 6. CRITICAL INVARIANT: Simulated Telegram/Webhook 500 AND Timeout STILL saves leads in TenantStore!
    for (const faultMode of ["http_500", "timeout"] as const) {
      outboundMode = faultMode;
      const leadFaultRun = await runCoreWriteWithIsolatedPluginHooks({
        coreWrite: async () => {
          const res = await handlePublicLeadPost(
            makeTenantLeadRequest(
              TENANT_A.host,
              {
                name: `Prospek ${faultMode}`,
                phone: "081299997777",
                email: `${faultMode}@contoh.id`,
                message: `Pesan tetap tersimpan walau notifier ${faultMode}.`,
                privacyConsent: true,
                sourcePath: "/kontak",
              },
              `idem-t101-fault-${faultMode}`,
            ),
            {
              surface: "tenant",
              tenant: {
                id: TENANT_A.id,
                handle: TENANT_A.handle,
                name: TENANT_A.name,
                host: TENANT_A.host,
                status: "active",
              },
              tenantDb: tenantADb,
              platformDb: env.PLATFORM_DB,
              appEnv: "test",
              rateLimitSalt: "t101-test-salt",
              nowMs: NOW_MS + (faultMode === "http_500" ? 200_000 : 300_000),
            },
          );
          const body = (await res.json()) as { readonly leadNumber: number };
          return { status: res.status, leadNumber: body.leadNumber };
        },
        tenantId: TENANT_A.id,
        event: "lead.created",
        eventId: (core) => `lead:${core.leadNumber}`,
        buildPayload: (core) => ({
          leadId: core.leadNumber,
          name: `Prospek ${faultMode}`,
          phoneE164: "+6281299997777",
          message: `Pesan tetap tersimpan walau notifier ${faultMode}.`,
          tenantName: TENANT_A.name,
        }),
        hookDeps: {
          platformDb: env.PLATFORM_DB,
          tenantStore: getTenantStoreNs(),
          registry,
          nowMs: NOW_MS + (faultMode === "http_500" ? 200_000 : 300_000),
        },
      });

      expect(leadFaultRun.coreResult.status).toBe(201);
      expect(leadFaultRun.hookOutcomes[0]?.outcome).toBe("completed");

      const persistedLead = await tenantADb
        .prepare("SELECT id, name FROM leads WHERE id = ? LIMIT 1")
        .bind(leadFaultRun.coreResult.leadNumber)
        .first<{ readonly id: number; readonly name: string }>();
      expect(persistedLead?.name).toBe(`Prospek ${faultMode}`);
    }

    const deliveryRows = await tenantADb
      .prepare(`SELECT channel, status, error_code, target_summary FROM ${LEAD_NOTIFIER_TABLES.deliveries}`)
      .all<{
        readonly channel: string;
        readonly status: string;
        readonly error_code: string | null;
        readonly target_summary: string | null;
      }>();
    const statuses = deliveryRows.results.map((r) => `${r.channel}:${r.status}`);
    expect(statuses).toContain("telegram:delivered");
    expect(statuses).toContain("webhook:delivered");
    expect(statuses).toContain("telegram:failed");
    expect(statuses).toContain("webhook:failed");
    expect(statuses).toContain("telegram:timed_out");
    expect(statuses).toContain("webhook:timed_out");
    expect(JSON.stringify(deliveryRows.results)).not.toContain(TEST_TG_BOT_TOKEN);
    expect(JSON.stringify(deliveryRows.results)).not.toContain(saveWhBody.secretOnce);
    expect(JSON.stringify(deliveryRows.results)).not.toContain("555001122");
    expect(JSON.stringify(deliveryRows.results)).not.toContain("secret-path-token-123");

    // 7. MEDIUM-6: Toggling `config.webhookEnabled: false` stops webhook delivery even when entitled & configured!
    outboundMode = "ok";
    const disableWhToggleRes = await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}`, {
        method: "PATCH",
        body: {
          config: {
            telegramEnabled: true,
            webhookEnabled: false,
            botUsername: "PunyaSitusBot",
            webhookMaxRetries: 3,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 350_000 },
    );
    expect(disableWhToggleRes.status).toBe(200);

    capturedTelegramCalls.length = 0;
    capturedWebhookCalls.length = 0;

    await runCoreWriteWithIsolatedPluginHooks({
      coreWrite: async () => ({ leadNumber: 998 }),
      tenantId: TENANT_A.id,
      event: "lead.created",
      eventId: () => "lead:998",
      buildPayload: () => ({
        leadId: 998,
        name: "Toggle Webhook Off",
        phoneE164: "+6281200001112",
        message: "Webhook nonaktif lewat config toggle.",
        tenantName: TENANT_A.name,
      }),
      hookDeps: {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS + 351_000,
      },
    });
    expect(capturedTelegramCalls.length).toBe(1);
    expect(capturedWebhookCalls.length).toBe(0);

    // Re-enable webhookEnabled, then Unlink Telegram to verify immediate Telegram revocation
    await handleTenantPluginDetailRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      makeAppRequest(`/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}`, {
        method: "PATCH",
        body: {
          config: {
            telegramEnabled: true,
            webhookEnabled: true,
            botUsername: "PunyaSitusBot",
            webhookMaxRetries: 3,
          },
        },
      }),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 390_000 },
    );

    const unlinkRes = await handleTenantPluginSubpathApiRequest(
      TENANT_A.handle,
      LEAD_NOTIFIER_PLUGIN_ID,
      "/telegram/unlink",
      makeAppRequest(
        `/api/tenants/${TENANT_A.handle}/plugins/${LEAD_NOTIFIER_PLUGIN_ID}/telegram/unlink`,
        { method: "POST", body: {} },
      ),
      buildRuntimeEnv(),
      { authenticatedUser: { id: TENANT_A.ownerId }, registry, nowMs: NOW_MS + 400_000 },
    );
    expect(unlinkRes.status).toBe(200);

    capturedTelegramCalls.length = 0;
    capturedWebhookCalls.length = 0;

    await runCoreWriteWithIsolatedPluginHooks({
      coreWrite: async () => ({ leadNumber: 999 }),
      tenantId: TENANT_A.id,
      event: "lead.created",
      eventId: () => "lead:999",
      buildPayload: () => ({
        leadId: 999,
        name: "Setelah Unlink",
        phoneE164: "+6281200001111",
        message: "Telegram tidak boleh terkirim lagi.",
        tenantName: TENANT_A.name,
      }),
      hookDeps: {
        platformDb: env.PLATFORM_DB,
        tenantStore: getTenantStoreNs(),
        registry,
        nowMs: NOW_MS + 401_000,
      },
    });

    expect(capturedTelegramCalls.length).toBe(0);
    expect(capturedWebhookCalls.length).toBe(1);
  });
});
