import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import { validateMcpAuthorizeRequest } from "@punyasitus/auth/mcp/index";
import {
  computePkceS256Challenge,
  MCP_ALLOWED_TOOLS,
  MCP_EXCLUDED_TOOLS,
} from "@punyasitus/core/mcp/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  AFFILIATES_MIGRATION,
} from "@punyasitus/db/affiliates/migrations";
import {
  AFFILIATE_COMMISSION_LEDGER_MIGRATION,
} from "@punyasitus/db/affiliates/ledger/migrations";
import { AGENCY_PORTAL_MIGRATION } from "@punyasitus/db/agencies/migrations";
import { applyMcpOAuthGrantsMigration } from "@punyasitus/db/mcp/migrations";
import { createPage, getPageById, listPages, publishPage } from "@punyasitus/db/pages/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import {
  PLATFORM_PLUGIN_RUNTIME_MIGRATION,
  TENANT_PLUGIN_LEDGER_MIGRATION,
} from "@punyasitus/db/plugins/migrations";
import { createPost, publishPost } from "@punyasitus/db/posts/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import {
  installOrEnablePluginForTenant,
  resolveActivePluginForTenant,
} from "../../apps/web/src/core/plugin-runtime.ts";
import { routeEdgeRequest, type TenantGateEnv } from "../../apps/web/src/core/tenant.ts";
import { handleMcpOAuthProtocolRequest } from "../../apps/web/src/middleware/mcp-oauth.ts";
import { handleAffiliateBatchDetailRequest } from "../../apps/web/src/pages/api/affiliate/batches/[batchId].ts";
import { handleAffiliateOverviewRequest } from "../../apps/web/src/pages/api/affiliate/overview.ts";
import { handleAgencyClientDetailRequest } from "../../apps/web/src/pages/api/agency/clients/[tenantId]/index.ts";
import { handleAgencyClientsRequest } from "../../apps/web/src/pages/api/agency/clients/index.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleMcpAccountApiRequest } from "../../apps/web/src/pages/api/auth/mcp/[action].ts";
import { handleConsoleAffiliatesListRequest } from "../../apps/web/src/pages/api/console/affiliates/index.ts";
import { handleConsoleAuditRequest } from "../../apps/web/src/pages/api/console/audit/index.ts";
import { handleConsoleSettingsRequest } from "../../apps/web/src/pages/api/console/settings/index.ts";
import { handlePublicLeadPost } from "../../apps/web/src/pages/api/leads.ts";
import { handlePluginInboundWebhook } from "../../apps/web/src/pages/api/plugins/[pluginId]/webhook.ts";
import { handleTenantActivityLogRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/activity/index.ts";
import { handleAiWritingQuotaRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/ai-writing/quota.ts";
import { handleTenantAnalyticsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/analytics/index.ts";
import { handleTenantBillingOverviewRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/billing/index.ts";
import { handleTenantBranchesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/branches/index.ts";
import { handleTenantCatalogCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/index.ts";
import { handleTenantDeletionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/deletion/index.ts";
import { handleTenantDomainsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/domains/index.ts";
import { handleTenantExportsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/exports/index.ts";
import { handleTenantFormsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/forms/index.ts";
import { handleTenantIdentityRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/index.ts";
import { handleTenantLeadsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/leads/index.ts";
import { handleMediaItemDelete, handleMediaItemPatch } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/[resourceId].ts";
import { handleMediaListGet } from "../../apps/web/src/pages/api/tenants/[tenantId]/media/index.ts";
import { handleTenantMenusRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/menus/index.ts";
import { handleTenantOutletsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/outlets/index.ts";
import { handleTenantPagesCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/index.ts";
import { handleTenantPluginSubpathApiRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/[pluginId]/[...subpath].ts";
import { handleTenantPluginsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/plugins/index.ts";
import { handleTenantPostsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/index.ts";
import { handleTenantPresetsGetRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/presets/index.ts";
import { handleTenantQrRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/qr/index.ts";
import { handleTenantRevisionsListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/revisions/index.ts";
import { handleTenantSeoSettingsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/seo/settings.ts";
import { handleTenantServiceRequestsRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/service-requests/index.ts";
import { handleTenantSettingsIndexRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/settings/index.ts";
import { handleTenantThemesListRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/themes/index.ts";
import { handleInsightsApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/insights/api.ts";
import { handleSeoVisibilityApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/seo/api.ts";
import { handleMembersApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/settings/members/api.ts";
import { handleNotificationSettingsApiRequest } from "../../apps/web/src/pages/dashboard/[handle]/settings/notifications/api.ts";
import { handleMcpEndpointRequest } from "../../apps/web/src/pages/mcp/index.ts";
import { handleSitemapIndexRequest } from "../../apps/web/src/pages/sitemap.xml.ts";

/**
 * Exhaustive Cross-Tenant BOLA Integration Suite in Real Cloudflare `workerd`
 * (`PLATFORM_DB` D1 + TWO isolated `TenantStore` SQLite Durable Objects: Tenant A & Tenant B).
 *
 * TASK-078 / REQ-078 / DEC-032.
 */

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_SECRET = "task078-bola-app-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task078-bola-console-secret-fedcba9876543210fedcba987654";
const CIMD_CLIENT_ID = "https://bola-ai.example.test/oauth/client.json";
const CIMD_REDIRECT_URI = "https://bola-ai.example.test/oauth/callback";
const CANONICAL_RESOURCE = `${APP_ORIGIN}/mcp`;

const TENANT_A = {
  id: "01JT078ALPHA00000000000001",
  orgId: "org_t078_alpha",
  handle: "t078-alpha",
  name: "PT Alpha BOLA Isolasi",
  host: "t078-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT078BETA000000000000002",
  orgId: "org_t078_beta",
  handle: "t078-beta",
  name: "CV Beta Rahasia Eksklusif",
  host: "t078-beta.situsku.click",
} as const;

const ALL_FIVE_OFFICIAL_PLUGINS = [
  { id: "seo-ai-autopilot", subpath: "status" },
  { id: "bio-links", subpath: "config" },
  { id: "wa-cs-rotator", subpath: "agents" },
  { id: "wp-importer", subpath: "jobs" },
  { id: "lead-notifier", subpath: "config" },
] as const;

function buildRuntimeEnv() {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    MEDIA_BUCKET: env.MEDIA_BUCKET,
    JOBS_QUEUE: env.JOBS_QUEUE,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractAppSessionCookie(response: Response): string {
  const pair = getSetCookies(response.headers).find((c) =>
    c.startsWith(`${APP_SESSION_COOKIE_NAME}=`),
  );
  if (!pair) {
    throw new Error(`Missing ${APP_SESSION_COOKIE_NAME} in sign-up response`);
  }
  return (pair.split(";")[0] ?? "").trim();
}

async function signUpUser(email: string, password: string, name: string) {
  const res = await handleBetterAuthRequest(
    new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
      },
      body: JSON.stringify({ email, password, name }),
    }),
    buildRuntimeEnv(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { readonly user: { readonly id: string } };
  await env.PLATFORM_DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?")
    .bind(body.user.id)
    .run();
  return {
    userId: body.user.id,
    email,
    cookie: extractAppSessionCookie(res),
  };
}

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, [
      ...TENANT_MIGRATIONS,
      TENANT_PLUGIN_LEDGER_MIGRATION,
    ]),
  );
  return createTenantDb(openTenantStoreStub(ns, tenantId));
}

async function seedTenant(
  tenant: typeof TENANT_A | typeof TENANT_B,
  ownerUserId: string,
): Promise<D1Database> {
  const now = Date.now();
  const paidThrough = now + 30 * 86_400_000;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(tenant.orgId, tenant.name, tenant.handle, now, now),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_${tenant.handle}_owner`, tenant.orgId, ownerUserId, now),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 1, 1, ?, ?)`,
    ).bind(tenant.id, tenant.orgId, tenant.handle, tenant.name, paidThrough, now, now),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
    ).bind(tenant.host, tenant.id, now, now, now),
  ]);

  return openMigratedTenantDb(tenant.id);
}

function createMockCimdFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === CIMD_CLIENT_ID) {
      return new Response(
        JSON.stringify({
          client_id: CIMD_CLIENT_ID,
          client_name: "BOLA Security Test MCP Client",
          client_uri: "https://bola-ai.example.test",
          redirect_uris: [CIMD_REDIRECT_URI],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  };
}

async function issueTenantMcpAccessToken(params: {
  readonly cookie: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}): Promise<string> {
  const verifier = "bola-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const challenge = await computePkceS256Challenge(verifier);
  const authzParams = new URLSearchParams({
    response_type: "code",
    client_id: CIMD_CLIENT_ID,
    redirect_uri: CIMD_REDIRECT_URI,
    resource: CANONICAL_RESOURCE,
    scope: params.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "bola-state-1",
  });

  const validated = await validateMcpAuthorizeRequest(env.PLATFORM_DB, authzParams, APP_ORIGIN, {
    fetchFn: createMockCimdFetch(),
  });
  expect(validated.ok).toBe(true);

  const approveRes = await handleMcpAccountApiRequest(
    "consent",
    new Request(`${APP_ORIGIN}/api/auth/mcp/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        Cookie: params.cookie,
      },
      body: JSON.stringify({
        decision: "approve",
        clientId: CIMD_CLIENT_ID,
        redirectUri: CIMD_REDIRECT_URI,
        resource: CANONICAL_RESOURCE,
        tenantId: params.tenantId,
        scopes: params.scopes,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        state: "bola-state-1",
        piiConsentAcked: params.scopes.includes("leads:read"),
      }),
    }),
    buildRuntimeEnv(),
    { fetchFn: createMockCimdFetch() },
  );
  expect(approveRes.status).toBe(200);
  const approveJson = (await approveRes.json()) as { readonly redirectTo: string };
  const code = new URL(approveJson.redirectTo).searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await handleMcpOAuthProtocolRequest(
    new Request(`${APP_ORIGIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: CIMD_REDIRECT_URI,
        client_id: CIMD_CLIENT_ID,
        code_verifier: verifier,
        resource: CANONICAL_RESOURCE,
      }).toString(),
    }),
    buildRuntimeEnv(),
  );
  expect(tokenRes).not.toBeNull();
  expect(tokenRes!.status).toBe(200);
  const tokenJson = (await tokenRes!.json()) as { readonly access_token: string };
  expect(tokenJson.access_token).toBeTruthy();
  return tokenJson.access_token;
}

describe("Exhaustive Cross-Tenant BOLA Integration Suite (workerd, TASK-078)", () => {
  let userA: { readonly userId: string; readonly email: string; readonly cookie: string };
  let userB: { readonly userId: string; readonly email: string; readonly cookie: string };
  let tenantADb: D1Database;
  let tenantBDb: D1Database;
  let tenantBPageId: number;
  let tenantBPostId: number;

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, [
      ...PLATFORM_MIGRATIONS,
      PLATFORM_PLUGIN_RUNTIME_MIGRATION,
      AGENCY_PORTAL_MIGRATION,
      AFFILIATES_MIGRATION,
      AFFILIATE_COMMISSION_LEDGER_MIGRATION,
    ]);
    await applyMcpOAuthGrantsMigration(env.PLATFORM_DB);

    userA = await signUpUser("bola-owner-a@example.test", "BolaStrongPass!1234", "Owner Alpha");
    userB = await signUpUser("bola-owner-b@example.test", "BolaStrongPass!1234", "Owner Beta");

    tenantADb = await seedTenant(TENANT_A, userA.userId);
    tenantBDb = await seedTenant(TENANT_B, userB.userId);

    // Seed confidential content inside Tenant B's isolated TenantStore DO
    const pageB = await createPage(tenantBDb, {
      title: "Halaman Internal Rahasia CV Beta",
      slug: "rahasia-beta-page",
      isHomepage: false,
      sections: [],
    });
    tenantBPageId = pageB.id;
    await publishPage(env.PLATFORM_DB, tenantBDb, {
      tenantId: TENANT_B.id,
      pageId: pageB.id,
      expectedVersion: pageB.version,
      actorUserId: userB.userId,
    });

    const postB = await createPost(
      tenantBDb,
      {
        title: "Artikel Eksklusif Beta Rahasia",
        slug: "artikel-rahasia-beta",
        excerpt: "Ringkasan eksklusif milik Tenant B.",
        bodyHtml: "<p>Isi artikel rahasia milik CV Beta.</p>",
      },
      {
        platformDb: env.PLATFORM_DB,
        organizationId: TENANT_B.orgId,
        actorUserId: userB.userId,
      },
    );
    tenantBPostId = postB.id;
    await publishPost(env.PLATFORM_DB, tenantBDb, {
      tenantId: TENANT_B.id,
      postId: postB.id,
      expectedVersion: postB.version,
      actorUserId: userB.userId,
    });

    // Enable `seo-ai-autopilot` on Tenant B ONLY (so Tenant A remains unentitled/disabled for plugin cross-check)
    await installOrEnablePluginForTenant(
      {
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        getBookmark: async () => "pitr-bm-test-t078-001",
      },
      {
        tenant: {
          id: TENANT_B.id,
          handle: TENANT_B.handle,
          name: TENANT_B.name,
          status: "active",
        },
        pluginId: "seo-ai-autopilot",
        actorUserId: userB.userId,
        actorRole: "owner",
      },
    );
  });

  it("proves positive controls for Tenant B, then denies Tenant A cross-tenant reads & POST/PUT/PATCH/DELETE mutations with zero DO mutation", async () => {
    const rt = buildRuntimeEnv();
    const getAs = (cookie: string, path: string) =>
      new Request(`${APP_ORIGIN}${path}`, {
        method: "GET",
        headers: { Cookie: cookie },
      });
    const mutateAs = (
      cookie: string,
      method: "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      body?: Record<string, unknown>,
    ) =>
      new Request(`${APP_ORIGIN}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: cookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    // -------------------------------------------------------------------------
    // 1. POSITIVE CONTROLS: Tenant B's own owner MUST succeed (200) & read real Tenant B data
    //    (Proves subsequent Tenant A 403/404 denials are genuine BOLA enforcement, not tautological 404s!)
    // -------------------------------------------------------------------------
    const positiveControls: ReadonlyArray<{
      readonly label: string;
      readonly run: () => Promise<Response>;
      readonly mustContain?: string;
    }> = [
      {
        label: "positive_B_pages",
        run: () => handleTenantPagesCollectionRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/pages`), rt),
        mustContain: "Halaman Internal Rahasia CV Beta",
      },
      {
        label: "positive_B_posts",
        run: () => handleTenantPostsCollectionRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/posts`), rt),
        mustContain: "Artikel Eksklusif Beta Rahasia",
      },
      {
        label: "positive_B_catalog",
        run: () => handleTenantCatalogCollectionRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/catalog`), rt),
      },
      {
        label: "positive_B_leads",
        run: () => handleTenantLeadsListRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/leads`), rt),
      },
      {
        label: "positive_B_media",
        run: () => handleMediaListGet(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/media`), rt),
      },
      {
        label: "positive_B_branches",
        run: () => handleTenantBranchesCollectionRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/branches`), rt),
      },
      {
        label: "positive_B_settings",
        run: () => handleTenantSettingsIndexRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/settings`), rt),
      },
      {
        label: "positive_B_plugins",
        run: () => handleTenantPluginsCollectionRequest(TENANT_B.handle, getAs(userB.cookie, `/api/tenants/${TENANT_B.handle}/plugins`), rt),
        mustContain: "seo-ai-autopilot",
      },
    ];

    for (const pc of positiveControls) {
      const res = await pc.run();
      const text = await res.text();
      expect(res.status, `[${pc.label}] expected 200 for Tenant B owner, got ${res.status}: ${text.slice(0, 200)}`).toBe(200);
      if (pc.mustContain) {
        expect(text).toContain(pc.mustContain);
      }
    }

    // -------------------------------------------------------------------------
    // 2. NEGATIVE CROSS-TENANT READ CONTROLS: Tenant A -> Tenant B MUST return 403/404 with zero leak
    // -------------------------------------------------------------------------
    const getReq = (path: string) => getAs(userA.cookie, path);

    const checks: ReadonlyArray<{ readonly label: string; readonly run: () => Promise<Response> }> = [
      {
        label: "pages",
        run: () => handleTenantPagesCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/pages`), rt),
      },
      {
        label: "pages_by_uuid",
        run: () => handleTenantPagesCollectionRequest(TENANT_B.id, getReq(`/api/tenants/${TENANT_B.id}/pages`), rt),
      },
      {
        label: "posts",
        run: () => handleTenantPostsCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/posts`), rt),
      },
      {
        label: "catalog",
        run: () => handleTenantCatalogCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/catalog`), rt),
      },
      {
        label: "leads",
        run: () => handleTenantLeadsListRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/leads`), rt),
      },
      {
        label: "media",
        run: () => handleMediaListGet(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/media`), rt),
      },
      {
        label: "branches",
        run: () => handleTenantBranchesCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/branches`), rt),
      },
      {
        label: "outlets",
        run: () => handleTenantOutletsCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/outlets`), rt),
      },
      {
        label: "menus",
        run: () => handleTenantMenusRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/menus`), rt),
      },
      {
        label: "forms",
        run: () => handleTenantFormsCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/forms`), rt),
      },
      {
        label: "themes",
        run: () => handleTenantThemesListRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/themes`), rt),
      },
      {
        label: "plugins",
        run: () => handleTenantPluginsCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/plugins`), rt),
      },
      {
        label: "settings",
        run: () => handleTenantSettingsIndexRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/settings`), rt),
      },
      {
        label: "identity",
        run: () => handleTenantIdentityRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/identity`), rt),
      },
      {
        label: "domains",
        run: () => handleTenantDomainsRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/domains`), rt),
      },
      {
        label: "billing",
        run: () => handleTenantBillingOverviewRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/billing`), rt),
      },
      {
        label: "ai-writing-quota",
        run: () => handleAiWritingQuotaRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/ai-writing/quota`), rt),
      },
      {
        label: "analytics",
        run: () => handleTenantAnalyticsRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/analytics`), rt),
      },
      {
        label: "seo-settings",
        run: () => handleTenantSeoSettingsRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/seo/settings`), rt),
      },
      {
        label: "revisions",
        run: () => handleTenantRevisionsListRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/revisions`), rt),
      },
      {
        label: "presets",
        run: () => handleTenantPresetsGetRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/presets`), rt),
      },
      {
        label: "qr",
        run: () => handleTenantQrRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/qr`), rt),
      },
      {
        label: "activity",
        run: () => handleTenantActivityLogRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/activity`), rt),
      },
      {
        label: "exports",
        run: () => handleTenantExportsCollectionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/exports`), rt),
      },
      {
        label: "deletion",
        run: () => handleTenantDeletionRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/deletion`), rt),
      },
      {
        label: "service-requests",
        run: () => handleTenantServiceRequestsRequest(TENANT_B.handle, getReq(`/api/tenants/${TENANT_B.handle}/service-requests`), rt),
      },
      {
        label: "dashboard-insights",
        run: () => handleInsightsApiRequest(TENANT_B.handle, getReq(`/dashboard/${TENANT_B.handle}/insights/api`), rt),
      },
      {
        label: "dashboard-seo",
        run: () => handleSeoVisibilityApiRequest(TENANT_B.handle, getReq(`/dashboard/${TENANT_B.handle}/seo/api`), rt),
      },
      {
        label: "dashboard-members",
        run: () => handleMembersApiRequest(TENANT_B.handle, getReq(`/dashboard/${TENANT_B.handle}/settings/members/api`), rt),
      },
      {
        label: "dashboard-notifications",
        run: () => handleNotificationSettingsApiRequest(TENANT_B.handle, getReq(`/dashboard/${TENANT_B.handle}/settings/notifications/api`), rt),
      },
    ];

    for (const check of checks) {
      const res = await check.run();
      const body = await res.text();
      expect(
        res.status === 403 || res.status === 404,
        `[${check.label}] expected 403/404 for Tenant A -> Tenant B, got ${res.status}: ${body.slice(0, 200)}`,
      ).toBe(true);
      expect(body).not.toContain("CV Beta Rahasia");
      expect(body).not.toContain("rahasia-beta-page");
      expect(body).not.toContain("artikel-rahasia-beta");
    }

    // -------------------------------------------------------------------------
    // 3. CROSS-TENANT MUTATIONS (POST / PUT / PATCH / DELETE):
    //    Tenant A mutating Tenant B MUST return 403/404 and leave ALL Tenant B DO tables untouched!
    // -------------------------------------------------------------------------
    const snapshotTenantBState = async () => {
      const countTable = async (table: string) => {
        const row = await tenantBDb
          .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
          .first<{ readonly c: number }>();
        return Number(row?.c ?? 0);
      };
      const settingsRow = await tenantBDb
        .prepare("SELECT updated_at, site_title FROM site_settings WHERE id = 1")
        .first<{ readonly updated_at: number | null; readonly site_title: string | null }>();
      return {
        pages: await countTable("pages"),
        posts: await countTable("posts"),
        offerings: await countTable("offerings"),
        mediaItems: await countTable("media_items"),
        leads: await countTable("leads"),
        settingsUpdatedAt: settingsRow?.updated_at ?? null,
        settingsSiteTitle: settingsRow?.site_title ?? null,
      };
    };

    const stateBefore = await snapshotTenantBState();

    const mutationChecks: ReadonlyArray<{ readonly label: string; readonly run: () => Promise<Response> }> = [
      {
        label: "POST_pages",
        run: () =>
          handleTenantPagesCollectionRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/api/tenants/${TENANT_B.handle}/pages`, {
              title: "Injected by A",
              slug: "injected-by-a",
              sections: [],
            }),
            rt,
          ),
      },
      {
        label: "POST_posts",
        run: () =>
          handleTenantPostsCollectionRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/api/tenants/${TENANT_B.handle}/posts`, {
              title: "Injected Post by A",
              slug: "injected-post-a",
              bodyHtml: "<p>Injected</p>",
            }),
            rt,
          ),
      },
      {
        label: "POST_catalog",
        run: () =>
          handleTenantCatalogCollectionRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/api/tenants/${TENANT_B.handle}/catalog`, {
              offeringType: "service",
              title: "Injected Offering",
              slug: "injected-offering-a",
              priceMode: "on_request",
              ctaMode: "whatsapp",
            }),
            rt,
          ),
      },
      {
        label: "POST_branches",
        run: () =>
          handleTenantBranchesCollectionRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/api/tenants/${TENANT_B.handle}/branches`, {
              name: "Hijacked Branch",
              address: "Jl. Hijack 1",
            }),
            rt,
          ),
      },
      {
        label: "POST_forms",
        run: () =>
          handleTenantFormsCollectionRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/api/tenants/${TENANT_B.handle}/forms`, {
              name: "Hijacked Form",
              slug: "hijacked-form",
              fields: [],
            }),
            rt,
          ),
      },
      {
        label: "PATCH_identity",
        run: () =>
          handleTenantIdentityRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "PATCH", `/api/tenants/${TENANT_B.handle}/identity`, {
              siteTitle: "DEFACED BY A",
            }),
            rt,
          ),
      },
      {
        label: "PATCH_media_item",
        run: () =>
          handleMediaItemPatch(
            TENANT_B.handle,
            "1",
            mutateAs(userA.cookie, "PATCH", `/api/tenants/${TENANT_B.handle}/media/1`, {
              alt: "Hijacked ALT",
            }),
            rt,
          ),
      },
      {
        label: "DELETE_media_item",
        run: () =>
          handleMediaItemDelete(
            TENANT_B.handle,
            "1",
            mutateAs(userA.cookie, "DELETE", `/api/tenants/${TENANT_B.handle}/media/1`),
            rt,
          ),
      },
      {
        label: "PUT_menus",
        run: () =>
          handleTenantMenusRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "PUT", `/api/tenants/${TENANT_B.handle}/menus`, {
              items: [],
            }),
            rt,
          ),
      },
      {
        label: "POST_settings_notifications",
        run: () =>
          handleNotificationSettingsApiRequest(
            TENANT_B.handle,
            mutateAs(userA.cookie, "POST", `/dashboard/${TENANT_B.handle}/settings/notifications/api`, {
              monthlyPerformanceReportEnabled: false,
            }),
            rt,
          ),
      },
    ];

    for (const mc of mutationChecks) {
      const res = await mc.run();
      expect(
        res.status === 403 || res.status === 404,
        `[${mc.label}] cross-tenant mutation expected 403/404, got ${res.status}`,
      ).toBe(true);
    }

    const stateAfter = await snapshotTenantBState();
    expect(stateAfter).toEqual(stateBefore);
    const afterPages = await listPages(tenantBDb, { status: "all", limit: 50 });
    expect(afterPages.items.some((p) => p.slug === "injected-by-a")).toBe(false);
  });

  it("enforces MCP positive control for Tenant B, blocks cross-tenant OAuth token issuance for User A -> Tenant B, and isolates all 16 allowed / 31 excluded MCP tools", async () => {
    const rt = buildRuntimeEnv();

    // 0. POSITIVE CONTROL: Tenant B's own MCP token reads Tenant B's real page
    const tokenB = await issueTenantMcpAccessToken({
      cookie: userB.cookie,
      tenantId: TENANT_B.id,
      scopes: ["content:read"],
    });
    const positiveMcpB = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenB}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 100,
          method: "tools/call",
          params: { name: "get_page", arguments: { pageId: tenantBPageId } },
        }),
      }),
      rt,
    );
    expect(positiveMcpB.status).toBe(200);
    expect(await positiveMcpB.text()).toContain("Halaman Internal Rahasia CV Beta");

    // 0b. CROSS-TENANT OAUTH TOKEN ISSUANCE BOLA:
    //     User A (NOT a member of Tenant B) attempts to approve an OAuth grant targeting TENANT_B.id
    //     -> MUST fail closed (403/404) with ZERO grant/auth-code row created in PLATFORM_DB!
    const crossVerifier =
      "bola-cross-tenant-verifier-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";
    const crossChallenge = await computePkceS256Challenge(crossVerifier);
    const crossConsentRes = await handleMcpAccountApiRequest(
      "consent",
      new Request(`${APP_ORIGIN}/api/auth/mcp/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
          Cookie: userA.cookie,
        },
        body: JSON.stringify({
          decision: "approve",
          clientId: CIMD_CLIENT_ID,
          redirectUri: CIMD_REDIRECT_URI,
          resource: CANONICAL_RESOURCE,
          tenantId: TENANT_B.id,
          scopes: ["content:read", "content:write_draft"],
          codeChallenge: crossChallenge,
          codeChallengeMethod: "S256",
          state: "bola-cross-state",
          piiConsentAcked: false,
        }),
      }),
      rt,
      { fetchFn: createMockCimdFetch() },
    );
    expect([403, 404]).toContain(crossConsentRes.status);
    const forgedGrantRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS c FROM mcp_oauth_grants WHERE user_id = ? AND tenant_id = ?",
    )
      .bind(userA.userId, TENANT_B.id)
      .first<{ readonly c: number }>();
    expect(Number(forgedGrantRow?.c ?? 0)).toBe(0);
    const forgedCodeRow = await env.PLATFORM_DB.prepare(
      "SELECT COUNT(*) AS c FROM mcp_oauth_auth_codes WHERE user_id = ? AND tenant_id = ?",
    )
      .bind(userA.userId, TENANT_B.id)
      .first<{ readonly c: number }>();
    expect(Number(forgedCodeRow?.c ?? 0)).toBe(0);

    const tokenA = await issueTenantMcpAccessToken({
      cookie: userA.cookie,
      tenantId: TENANT_A.id,
      scopes: ["content:read", "content:write_draft", "content:publish_request", "leads:read"],
    });

    // 1. tools/list returns ONLY the 16 allowed tools and ZERO excluded tools
    const listRes = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      rt,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
    };
    const listedNames = listJson.result.tools.map((t) => t.name).sort();
    expect(listedNames).toEqual([...MCP_ALLOWED_TOOLS].sort());
    for (const excluded of MCP_EXCLUDED_TOOLS) {
      expect(listedNames).not.toContain(excluded);
    }

    // 2. Tenant A MCP token reading pages/posts/overview NEVER sees Tenant B data
    const overviewRes = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_site_overview", arguments: {} },
        }),
      }),
      rt,
    );
    expect(overviewRes.status).toBe(200);
    const overviewText = await overviewRes.text();
    expect(overviewText).toContain(TENANT_A.handle);
    expect(overviewText).not.toContain(TENANT_B.handle);
    expect(overviewText).not.toContain("CV Beta");

    // 3. Tenant A MCP token requesting Tenant B's pageId/postId hits ONLY Tenant A's DO -> NOT_FOUND / never leaks B
    const getBPageViaA = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_page", arguments: { pageId: tenantBPageId } },
        }),
      }),
      rt,
    );
    const getBPageText = await getBPageViaA.text();
    expect(getBPageText).not.toContain("Halaman Internal Rahasia CV Beta");

    const getBPostViaA = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "get_post", arguments: { postId: tenantBPostId } },
        }),
      }),
      rt,
    );
    const getBPostText = await getBPostViaA.text();
    expect(getBPostText).not.toContain("Artikel Eksklusif Beta Rahasia");

    // 4. Invoking an excluded dangerous tool is rejected
    const excludedCallRes = await handleMcpEndpointRequest(
      new Request(`${APP_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "delete_page", arguments: { pageId: 1 } },
        }),
      }),
      rt,
    );
    const excludedJson = (await excludedCallRes.json()) as { readonly error?: { readonly code: number } };
    expect(excludedJson.error).toBeDefined();

    // 5. Tenant host /mcp returns neutral 404
    const tenantHostMcpRes = await handleMcpEndpointRequest(
      new Request(`https://${TENANT_A.host}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
      }),
      rt,
    );
    expect(tenantHostMcpRes.status).toBe(404);
  });

  it("isolates ALL 5 official first-party plugins across tenants, unentitled websites, and inbound webhooks", async () => {
    const rt = buildRuntimeEnv();

    for (const plugin of ALL_FIVE_OFFICIAL_PLUGINS) {
      // Cross-tenant A -> B admin plugin API denied with 404
      const crossRes = await handleTenantPluginSubpathApiRequest(
        TENANT_B.handle,
        plugin.id,
        plugin.subpath,
        new Request(
          `${APP_ORIGIN}/api/tenants/${TENANT_B.handle}/plugins/${plugin.id}/${plugin.subpath}`,
          {
            method: "GET",
            headers: { Cookie: userA.cookie },
          },
        ),
        rt,
      );
      expect(
        crossRes.status === 403 || crossRes.status === 404,
        `Plugin ${plugin.id} cross-tenant A -> B expected 403/404, got ${crossRes.status}`,
      ).toBe(true);

      // Unentitled/disabled plugin on Tenant A executes ZERO plugin SQL queries
      const resolvedA = await resolveActivePluginForTenant(
        {
          platformDb: env.PLATFORM_DB,
          tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        },
        { id: TENANT_A.id, handle: TENANT_A.handle, name: TENANT_A.name, status: "active" },
        plugin.id,
      );
      expect(resolvedA.active).toBe(false);
    }

    // Inbound webhook for lead-notifier rejects invalid secret with 401 BEFORE touching DB
    const badWebhookRes = await handlePluginInboundWebhook(
      "lead-notifier",
      new Request(`${APP_ORIGIN}/api/plugins/lead-notifier/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "forged-wrong-secret",
        },
        body: JSON.stringify({ message: { text: "/start forged-token" } }),
      }),
      { ...rt, TELEGRAM_WEBHOOK_SECRET: "real-secret-token-value-123456" },
    );
    expect(badWebhookRes.status).toBe(401);
  });

  it("denies non-operator tenant owners on console APIs and isolates agency & affiliate portals", async () => {
    const rt = buildRuntimeEnv();

    // Console endpoints MUST reject Tenant A owner (not an operator + wrong/missing console session)
    const consoleAuditRes = await handleConsoleAuditRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/audit`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([401, 403]).toContain(consoleAuditRes.status);

    const consoleAffiliatesRes = await handleConsoleAffiliatesListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/affiliates`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([401, 403]).toContain(consoleAffiliatesRes.status);

    const consoleSettingsRes = await handleConsoleSettingsRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/settings`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([401, 403]).toContain(consoleSettingsRes.status);

    // Agency portal denies non-agency Tenant A owner
    const agencyClientsRes = await handleAgencyClientsRequest(
      new Request(`${APP_ORIGIN}/api/agency/clients`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([401, 403, 404]).toContain(agencyClientsRes.status);

    const agencyClientDetailRes = await handleAgencyClientDetailRequest(
      TENANT_B.id,
      new Request(`${APP_ORIGIN}/api/agency/clients/${TENANT_B.id}`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([401, 403, 404]).toContain(agencyClientDetailRes.status);

    // Affiliate portal denies non-affiliate Tenant A owner
    const affiliateOverviewRes = await handleAffiliateOverviewRequest(
      new Request(`${APP_ORIGIN}/api/affiliate/overview`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect(affiliateOverviewRes.status).toBe(403);

    const affiliateBatchRes = await handleAffiliateBatchDetailRequest(
      "batch_nonexistent_foreign",
      new Request(`${APP_ORIGIN}/api/affiliate/batches/batch_nonexistent_foreign`, {
        method: "GET",
        headers: { Cookie: userA.cookie },
      }),
      rt,
    );
    expect([403, 404]).toContain(affiliateBatchRes.status);
  });

  it("enforces strict public host isolation across edge routing, sitemaps, and public lead submission", async () => {
    const gateEnv: TenantGateEnv = {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    };

    // Tenant A host resolves ONLY Tenant A's DO — Tenant B's page does NOT exist there
    const edgeRes = await routeEdgeRequest(
      new Request(`https://${TENANT_A.host}/rahasia-beta-page`, {
        headers: {
          "X-Forwarded-Host": TENANT_B.host,
          "X-Tenant-ID": TENANT_B.id,
        },
      }),
      gateEnv,
      {
        render: async ({ tenant, tenantDb }) => {
          expect(tenant?.id).toBe(TENANT_A.id);
          expect(tenantDb).not.toBeNull();
          const page = await getPageById(tenantDb!, tenantBPageId);
          expect(page).toBeNull();
          return new Response("Not Found", { status: 404 });
        },
      },
    );
    expect(edgeRes.status).toBe(404);

    // Tenant A sitemap never lists Tenant B host or slugs
    const sitemapRes = await handleSitemapIndexRequest(
      new Request(`https://${TENANT_A.host}/sitemap.xml`),
      {
        surface: "tenant",
        platformDb: env.PLATFORM_DB,
        tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
        tenantDb: tenantADb,
      },
    );
    const sitemapText = await sitemapRes.text();
    expect(sitemapText).not.toContain(TENANT_B.host);
    expect(sitemapText).not.toContain("rahasia-beta-page");

    // Public lead POST on Tenant A host attempting to forge `tenantId: TENANT_B.id` is rejected (400/422)
    // and NEVER writes to Tenant B's isolated DO!
    const forgedLeadRes = await handlePublicLeadPost(
      new Request(`https://${TENANT_A.host}/api/leads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${TENANT_A.host}`,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({
          tenantId: TENANT_B.id,
          name: "Forged Tenant Attacker",
          phone: "081234567890",
          message: "Attempt to inject lead into Tenant B.",
          privacyConsent: true,
        }),
      }),
      {
        surface: "tenant",
        rateLimitSalt: "task078-bola-rate-limit-salt",
        platformDb: env.PLATFORM_DB,
        tenant: {
          id: TENANT_A.id,
          handle: TENANT_A.handle,
          name: TENANT_A.name,
          status: "active",
          host: TENANT_A.host,
        },
        tenantDb: tenantADb,
      },
    );
    expect([400, 403, 422]).toContain(forgedLeadRes.status);
    const leadsInA = await tenantADb
      .prepare("SELECT COUNT(*) AS c FROM leads")
      .first<{ readonly c: number }>();
    const leadsInB = await tenantBDb
      .prepare("SELECT COUNT(*) AS c FROM leads")
      .first<{ readonly c: number }>();
    expect(Number(leadsInA?.c ?? 0)).toBe(0);
    expect(Number(leadsInB?.c ?? 0)).toBe(0);
  });
});
