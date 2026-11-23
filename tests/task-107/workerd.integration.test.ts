import { createMessageBatch } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  DELETION_UNDO_WINDOW_MS,
  EXPORT_LINK_TTL_MS,
  parseZipArchive,
  TENANT_EXPORT_CLEANUP_TOPIC,
  TENANT_EXPORT_GENERATE_TOPIC,
  TENANT_SELF_DELETION_SWEEP_TOPIC,
} from "@punyasitus/core/exports/index";
import {
  applyPlatformMigrations,
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  applyTenantExportsAndDeletionMigration,
  type ExportR2BucketLike,
} from "@punyasitus/db/exports/index";
import {
  applyTenantOffboardingMigration,
  type OffboardingCloudflareClientLike,
  type OffboardingTenantStoreNamespaceLike,
} from "@punyasitus/db/offboarding/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { clearHostResolutionCache, resolveTenantByHost } from "@punyasitus/db/routing/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateRequestGate } from "../../apps/web/src/core/tenant.ts";
import {
  executeAuthMiddleware,
  type AuthMiddlewareLocals,
  type AuthRuntimeEnv,
} from "../../apps/web/src/middleware/auth.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import { handleTenantDeletionCancelRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/deletion/cancel.ts";
import { handleTenantDeletionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/deletion/index.ts";
import { handleTenantExportDownloadRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/exports/[exportId]/download.ts";
import { handleTenantExportDetailRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/exports/[exportId]/index.ts";
import {
  type TenantOwnerDataRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/exports/_shared.ts";
import { handleTenantExportsCollectionRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/exports/index.ts";
import { processDurableQueueBatch } from "../../apps/web/src/worker/queues/index.ts";
import { createExportJobRegistry } from "../../apps/web/src/worker/queues/exports/index.ts";
import { applySessionTwoFactorMigration } from "@punyasitus/auth";

const APP_ORIGIN = "https://app.punyasitus.com";
const TEST_APP_SECRET = "test-t107-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-t107-console-auth-secret-fedcba9876543210fedcba9876543210";
const OWNER_PASSWORD = "StrongOwnerPassword!2026";

function buildAuthEnv(): AuthRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    PLATFORM_DB: env.PLATFORM_DB,
    AUTH_SECRET: TEST_APP_SECRET,
    CONSOLE_AUTH_SECRET: TEST_CONSOLE_SECRET,
  };
}

function buildDataEnv(extra?: Partial<TenantOwnerDataRuntimeEnv>): TenantOwnerDataRuntimeEnv {
  return {
    ...buildAuthEnv(),
    SAAS_ZONE: "situsku.click",
    MEDIA_BUCKET: env.MEDIA_BUCKET as unknown as ExportR2BucketLike,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    JOBS_QUEUE: null,
    ...extra,
  };
}

function createMiddlewareLocals(surface: "app" | "console" = "app"): AuthMiddlewareLocals {
  return {
    surface,
    host: surface === "app" ? "app.punyasitus.com" : "console.punyasitus.com",
    isLocalLoopback: false,
    tenant: null,
    tenantDb: null,
    authUser: null,
    authSession: null,
    authorizedTenantMember: null,
    tenantEntitlement: null,
    platformOperator: null,
    twoFactorVerifiedAtMs: null,
  };
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractSessionCookie(res: Response): string {
  const pair = getSetCookies(res.headers).find((c) => c.startsWith(`${APP_SESSION_COOKIE_NAME}=`));
  if (!pair) throw new Error("Missing app session cookie");
  return (pair.split(";")[0] ?? "").trim();
}

async function signUpUser(
  email: string,
  name: string,
  password = OWNER_PASSWORD,
): Promise<{ userId: string; sessionId: string; cookie: string }> {
  const req = new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
    },
    body: JSON.stringify({ email, password, name }),
  });
  const res = await handleBetterAuthRequest(req, buildAuthEnv());
  expect(res.status).toBe(200);
  const data = (await res.json()) as { user?: { id: string } };
  const userId = data.user?.id;
  if (!userId) throw new Error("Missing userId from signup");
  const sessionRow = await env.PLATFORM_DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ readonly id: string }>();
  if (!sessionRow) throw new Error("Missing session row");
  return { userId, sessionId: sessionRow.id, cookie: extractSessionCookie(res) };
}

function makeAppRequest(
  pathname: string,
  options: {
    method?: string;
    cookie?: string;
    origin?: string | null;
    body?: unknown;
    host?: string;
  } = {},
): Request {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    if (options.origin !== null) {
      headers.set("Origin", options.origin ?? APP_ORIGIN);
    }
  }
  const base = options.host ? `https://${options.host}` : APP_ORIGIN;
  return new Request(`${base}${pathname}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function seedTenantWithContent(params: {
  tenantId: string;
  orgId: string;
  handle: string;
  name: string;
  ownerUserId: string;
  customHost?: string;
  nowMs: number;
  paidThroughMs?: number;
  operatorHold?: boolean;
}) {
  const { tenantId, orgId, handle, name, ownerUserId, nowMs } = params;
  const paidThrough = params.paidThroughMs ?? nowMs + 30 * 86_400_000;

  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(orgId, name, handle, nowMs, nowMs),
    env.PLATFORM_DB.prepare(
      "INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(`mem_owner_${tenantId}`, orgId, ownerUserId, nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         operator_hold_reason, paid_through, cache_version, schema_version, version,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'catalog', 'active', ?, ?, ?, 1, 0, 1, ?, ?)`,
    ).bind(
      tenantId,
      orgId,
      handle,
      name,
      params.operatorHold ? 1 : 0,
      params.operatorHold ? "Peninjauan kepatuhan" : null,
      paidThrough,
      nowMs,
      nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', ?, ?, 1, ?, ?)`,
    ).bind(`${handle}.situsku.click`, tenantId, params.customHost ? 0 : 1, nowMs, nowMs, nowMs),
  ]);

  if (params.customHost) {
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, cf_custom_hostname_id, status, ssl_status, is_primary, verified_at, version, created_at, updated_at
       ) VALUES (?, ?, 'custom', ?, 'active', 'active', 1, ?, 1, ?, ?)`,
    )
      .bind(params.customHost, tenantId, `cf_host_${tenantId}`, nowMs, nowMs, nowMs)
      .run();
  }

  // Migrate TenantStore DO and seed pages, posts, offerings, leads, media_items
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const stub = openTenantStoreStub(ns, tenantId);
  await orchestrateTenantMigration(env.PLATFORM_DB, stub, tenantId, TENANT_MIGRATIONS);
  const tenantDb = createTenantDb(stub);

  const mediaKey = `t/${tenantId}/media/produk-utama.webp`;
  const mediaBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  await env.MEDIA_BUCKET.put(mediaKey, mediaBytes, {
    httpMetadata: { contentType: "image/webp" },
  });

  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO site_settings (
           id, site_title, tagline, timezone, locale, active_theme_id, version, updated_at
         ) VALUES (1, ?, 'Tagline Resmi', 'Asia/Jakarta', 'id-ID', 'catalog', 1, ?)`,
      )
      .bind(name, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO business_profile (
           id, business_name, business_category, whatsapp_e164, email, version, updated_at
         ) VALUES (1, ?, 'LocalBusiness', '+6281234567890', ?, 1, ?)`,
      )
      .bind(name, `halo@${handle}.id`, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO pages (
           id, slug, title, is_homepage, draft_sections_json, published_sections_json,
           status, published_at, version, created_at, updated_at
         ) VALUES (1, 'beranda', ?, 1, '[{"kind":"hero","heading":"Selamat Datang"}]', '[{"kind":"hero","heading":"Selamat Datang"}]', 'published', ?, 1, ?, ?)`,
      )
      .bind(`Beranda ${name}`, nowMs, nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO posts (
           id, slug, title, excerpt, draft_body_json, published_body_json,
           status, published_at, version, created_at, updated_at
         ) VALUES (1, 'artikel-pertama', ?, 'Ringkasan artikel', '{"type":"doc","content":[]}', '{"type":"doc","content":[]}', 'published', ?, 1, ?, ?)`,
      )
      .bind(`Artikel ${name}`, nowMs, nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO offerings (
           id, offering_type, slug, title, summary, price_mode, price,
           status, published_at, version, created_at, updated_at
         ) VALUES (1, 'product', 'paket-unggulan', ?, 'Deskripsi produk', 'fixed', 250000, 'published', ?, 1, ?, ?)`,
      )
      .bind(`Produk ${name}`, nowMs, nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO leads (
           id, name, phone_e164, email, message, source_category, page_path, status,
           version, created_at, updated_at
         ) VALUES (1, '=SUM(1+1)', '+6281299990001', 'pelanggan@example.com', 'Tanya harga ${handle}', 'direct', '/kontak', 'new', 1, ?, ?)`,
      )
      .bind(nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT OR REPLACE INTO media_items (
           id, kind, r2_key, mime_type, bytes, sha256, alt_text, status, version, created_at, updated_at
         ) VALUES (1, 'image', ?, 'image/webp', ?, 'deadbeef', 'Foto Produk', 'ready', 1, ?, ?)`,
      )
      .bind(mediaKey, mediaBytes.byteLength, nowMs, nowMs),
  ]);

  return { mediaKey, mediaBytes, tenantDb };
}

describe("TASK-107 workerd integration — Owner Full-Website Export Archive & Self-Service Deletion with Undo", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await applyTenantOffboardingMigration(env.PLATFORM_DB);
    await applyTenantExportsAndDeletionMigration(env.PLATFORM_DB);
  });

  beforeEach(async () => {
    clearHostResolutionCache();
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare("DELETE FROM tenant_export_jobs"),
      env.PLATFORM_DB.prepare("DELETE FROM tenant_deletion_requests"),
      env.PLATFORM_DB.prepare("DELETE FROM tenant_offboarding_runs"),
      env.PLATFORM_DB.prepare("DELETE FROM tenant_offboarding_warnings"),
      env.PLATFORM_DB.prepare("DELETE FROM job_ledger"),
      env.PLATFORM_DB.prepare("DELETE FROM deletion_tombstones"),
      env.PLATFORM_DB.prepare("DELETE FROM receipts"),
      env.PLATFORM_DB.prepare("DELETE FROM entitlement_grants"),
      env.PLATFORM_DB.prepare("DELETE FROM settlements"),
      env.PLATFORM_DB.prepare("DELETE FROM payment_attempts"),
      env.PLATFORM_DB.prepare("DELETE FROM billing_obligations"),
      env.PLATFORM_DB.prepare("DELETE FROM migration_bookmarks"),
      env.PLATFORM_DB.prepare("DELETE FROM tenant_hosts"),
      env.PLATFORM_DB.prepare("DELETE FROM tenants"),
      env.PLATFORM_DB.prepare("DELETE FROM members"),
      env.PLATFORM_DB.prepare("DELETE FROM organizations"),
      env.PLATFORM_DB.prepare("DELETE FROM session_two_factor_verifications"),
      env.PLATFORM_DB.prepare("DELETE FROM sessions"),
      env.PLATFORM_DB.prepare("DELETE FROM accounts"),
      env.PLATFORM_DB.prepare("DELETE FROM users"),
    ]);

    // Clean R2 bucket between tests
    const listed = await env.MEDIA_BUCKET.list();
    if (listed.objects.length > 0) {
      await env.MEDIA_BUCKET.delete(listed.objects.map((o) => o.key));
    }
  });

  it("generates owner-only ZIP archive via Durable Queue, enforces 1/day limit, 24h expiry, RBAC, and tenant isolation", async () => {
    const t0 = Date.UTC(2026, 10, 23, 4, 0, 0); // 11:00 WIB on 2026-11-23

    const ownerA = await signUpUser("owner-a@t107.test", "Owner Alpha");
    const adminA = await signUpUser("admin-a@t107.test", "Admin Alpha");
    const editorA = await signUpUser("editor-a@t107.test", "Editor Alpha");
    const agencyA = await signUpUser("agency-a@t107.test", "Agency Staff Alpha");
    const ownerB = await signUpUser("owner-b@t107.test", "Owner Beta");

    const seededA = await seedTenantWithContent({
      tenantId: "ten_t107_alpha",
      orgId: "org_t107_alpha",
      handle: "kopi-alpha",
      name: "Kopi Alpha",
      ownerUserId: ownerA.userId,
      nowMs: t0,
    });
    await seedTenantWithContent({
      tenantId: "ten_t107_beta",
      orgId: "org_t107_beta",
      handle: "baju-beta",
      name: "Baju Beta",
      ownerUserId: ownerB.userId,
      nowMs: t0,
    });

    // Add admin, editor, and agency_staff to Org Alpha
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m_adm', 'org_t107_alpha', ?, 'admin', ?)",
      ).bind(adminA.userId, t0),
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m_edi', 'org_t107_alpha', ?, 'editor', ?)",
      ).bind(editorA.userId, t0),
      env.PLATFORM_DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m_agn', 'org_t107_alpha', ?, 'agency_staff', ?)",
      ).bind(agencyA.userId, t0),
    ]);

    // 1. RBAC & host isolation denials
    for (const nonOwnerCookie of [adminA.cookie, editorA.cookie, agencyA.cookie]) {
      const denyPost = await handleTenantExportsCollectionRequest(
        "ten_t107_alpha",
        makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
          method: "POST",
          cookie: nonOwnerCookie,
          body: {},
        }),
        buildDataEnv(),
        { nowMs: t0 },
      );
      expect(denyPost.status).toBe(403);

      const denyGet = await handleTenantExportsCollectionRequest(
        "ten_t107_alpha",
        makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
          method: "GET",
          cookie: nonOwnerCookie,
        }),
        buildDataEnv(),
        { nowMs: t0 },
      );
      expect(denyGet.status).toBe(403);
    }

    // Foreign tenant owner gets 404 (no existence leak)
    const crossTenant = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "POST",
        cookie: ownerB.cookie,
        body: {},
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(crossTenant.status).toBe(404);

    // Bad CSRF Origin gets 403; tenant host gets 404
    const badOrigin = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "POST",
        cookie: ownerA.cookie,
        origin: "https://kopi-alpha.situsku.click",
        body: {},
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(badOrigin.status).toBe(403);

    const tenantHostReq = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "GET",
        cookie: ownerA.cookie,
        host: "kopi-alpha.situsku.click",
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(tenantHostReq.status).toBe(404);

    // 2. Owner requests export -> enqueued into Durable Queue & job_ledger
    const queuedEnvelopes: unknown[] = [];
    const queueEnv = buildDataEnv({
      JOBS_QUEUE: {
        async send(msg) {
          queuedEnvelopes.push(msg);
        },
      },
    });

    const postRes = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "POST",
        cookie: ownerA.cookie,
        body: {},
      }),
      queueEnv,
      { nowMs: t0 },
    );
    expect(postRes.status).toBe(202);
    const postJson = (await postRes.json()) as { export: { id: string; status: string } };
    expect(postJson.export.status).toBe("queued");
    expect(queuedEnvelopes).toHaveLength(1);

    // 3. Second export on the SAME Jakarta day is REFUSED with 429 RATE_LIMITED + Retry-After
    const sameDaySecond = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "POST",
        cookie: ownerA.cookie,
        body: {},
      }),
      queueEnv,
      { nowMs: t0 + 60_000 },
    );
    expect(sameDaySecond.status).toBe(429);
    expect(Number(sameDaySecond.headers.get("Retry-After"))).toBeGreaterThan(0);

    // 4. Durable Queue consumer builds ZIP in R2 under `t/ten_t107_alpha/exports/<id>.zip`
    const batch = createMessageBatch("punyasitus-jobs", [
      { id: "msg_exp_1", timestamp: new Date(t0), attempts: 1, body: queuedEnvelopes[0] },
    ]);
    const registry = createExportJobRegistry({
      now: () => t0 + 1000,
      signingSecret: TEST_APP_SECRET,
      mediaBucket: env.MEDIA_BUCKET as unknown as ExportR2BucketLike,
    });
    const batchRes = await processDurableQueueBatch(
      batch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
        TENANT_STORE: env.TENANT_STORE,
        APP_ENV: "test",
      },
      registry,
      { now: () => t0 + 1000 },
    );
    expect(batchRes.completed).toBe(1);

    // Verify object sits strictly under tenant R2 prefix
    const expectedR2Key = `t/ten_t107_alpha/exports/${postJson.export.id}.zip`;
    const r2Obj = await env.MEDIA_BUCKET.get(expectedR2Key);
    expect(r2Obj).not.toBeNull();

    // 5. Inspect job detail & download ZIP via signed URL
    const detailRes = await handleTenantExportDetailRequest(
      "ten_t107_alpha",
      postJson.export.id,
      makeAppRequest(`/api/tenants/ten_t107_alpha/exports/${postJson.export.id}`, {
        method: "GET",
        cookie: ownerA.cookie,
      }),
      buildDataEnv(),
      { nowMs: t0 + 2000 },
    );
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      export: { status: string; downloadUrl: string | null };
    };
    expect(detailJson.export.status).toBe("ready");
    expect(detailJson.export.downloadUrl).toContain("/download?token=");

    // Foreign owner trying to use Tenant A's valid signed download URL gets 404!
    const stolenDownload = await handleTenantExportDownloadRequest(
      "ten_t107_alpha",
      postJson.export.id,
      makeAppRequest(detailJson.export.downloadUrl!, {
        method: "GET",
        cookie: ownerB.cookie,
      }),
      buildDataEnv(),
      { nowMs: t0 + 2000 },
    );
    expect(stolenDownload.status).toBe(404);

    // Admin trying to use Tenant A's signed download URL gets 403!
    const adminDownload = await handleTenantExportDownloadRequest(
      "ten_t107_alpha",
      postJson.export.id,
      makeAppRequest(detailJson.export.downloadUrl!, {
        method: "GET",
        cookie: adminA.cookie,
      }),
      buildDataEnv(),
      { nowMs: t0 + 2000 },
    );
    expect(adminDownload.status).toBe(403);

    // Owner downloads valid ZIP and verifies EVERY file inside
    const downloadRes = await handleTenantExportDownloadRequest(
      "ten_t107_alpha",
      postJson.export.id,
      makeAppRequest(detailJson.export.downloadUrl!, {
        method: "GET",
        cookie: ownerA.cookie,
      }),
      buildDataEnv(),
      { nowMs: t0 + 2000 },
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("application/zip");
    expect(downloadRes.headers.get("Cache-Control")).toBe("private, no-store");
    expect(downloadRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(downloadRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const zipBytes = new Uint8Array(await downloadRes.arrayBuffer());
    const entries = parseZipArchive(zipBytes);
    const entryMap = new Map(entries.map((e) => [e.path, e]));

    expect(entryMap.has("manifest.json")).toBe(true);
    expect(entryMap.has("site.json")).toBe(true);
    expect(entryMap.has("pages.json")).toBe(true);
    expect(entryMap.has("posts.json")).toBe(true);
    expect(entryMap.has("offerings.json")).toBe(true);
    expect(entryMap.has("leads.csv")).toBe(true);
    expect(entryMap.has("media/1-produk-utama.webp")).toBe(true);

    const pagesJson = JSON.parse(new TextDecoder().decode(entryMap.get("pages.json")!.data));
    const postsJson = JSON.parse(new TextDecoder().decode(entryMap.get("posts.json")!.data));
    const offeringsJson = JSON.parse(new TextDecoder().decode(entryMap.get("offerings.json")!.data));
    const leadsCsv = new TextDecoder().decode(entryMap.get("leads.csv")!.data);

    expect(pagesJson.items[0].title).toBe("Beranda Kopi Alpha");
    expect(postsJson.items[0].title).toBe("Artikel Kopi Alpha");
    expect(offeringsJson.items[0].title).toBe("Produk Kopi Alpha");
    expect(leadsCsv).toContain("'=SUM(1+1)");
    expect(leadsCsv).toContain(",+6281299990001,");
    expect(leadsCsv).not.toContain("'+6281299990001");
    expect(leadsCsv).toContain("Tanya harga kopi-alpha");
    expect(leadsCsv).not.toContain("baju-beta");
    const manifestJson = JSON.parse(new TextDecoder().decode(entryMap.get("manifest.json")!.data));
    expect(manifestJson.truncated).toEqual({
      pages: false,
      posts: false,
      offerings: false,
      leads: false,
      media: false,
      any: false,
    });
    expect(Array.from(entryMap.get("media/1-produk-utama.webp")!.data)).toEqual(
      Array.from(seededA.mediaBytes),
    );

    // Zero secrets/password hashes in entire archive text
    const fullText = new TextDecoder().decode(zipBytes);
    expect(fullText).not.toContain(OWNER_PASSWORD);
    expect(fullText).not.toContain("Baju Beta");

    // 6. Link stops working after exact 24 hours -> 410 EXPORT_EXPIRED
    //    (Simulate owner with an active session 24 hours later)
    const after24h = t0 + 1000 + EXPORT_LINK_TTL_MS;
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE user_id = ?",
    )
      .bind(after24h - 60_000, after24h - 60_000, after24h + 86_400_000, ownerA.userId)
      .run();

    const expiredDownload = await handleTenantExportDownloadRequest(
      "ten_t107_alpha",
      postJson.export.id,
      makeAppRequest(detailJson.export.downloadUrl!, {
        method: "GET",
        cookie: ownerA.cookie,
      }),
      buildDataEnv(),
      { nowMs: after24h },
    );
    expect(expiredDownload.status).toBe(410);

    // 7. Cleanup cron job deletes expired export ZIP from R2 cleanly
    const cleanupBatch = createMessageBatch("punyasitus-jobs", [
      {
        id: "msg_cleanup_1",
        timestamp: new Date(t0 + EXPORT_LINK_TTL_MS + 5000),
        attempts: 1,
        body: {
          idempotencyKey: "cleanup:t107:1",
          topic: TENANT_EXPORT_CLEANUP_TOPIC,
          tenantId: null,
          payload: { scheduledAtMs: t0 + EXPORT_LINK_TTL_MS + 5000 },
        },
      },
    ]);
    await processDurableQueueBatch(
      cleanupBatch,
      { PLATFORM_DB: env.PLATFORM_DB, MEDIA_BUCKET: env.MEDIA_BUCKET },
      createExportJobRegistry({
        now: () => t0 + EXPORT_LINK_TTL_MS + 5000,
        mediaBucket: env.MEDIA_BUCKET as unknown as ExportR2BucketLike,
      }),
      { now: () => t0 + EXPORT_LINK_TTL_MS + 5000 },
    );
    expect(await env.MEDIA_BUCKET.get(expectedR2Key)).toBeNull();
    // Tenant media stays untouched!
    expect(await env.MEDIA_BUCKET.get(seededA.mediaKey)).not.toBeNull();

    // 8. Next Jakarta calendar day allows a new export!
    const nextDayMs = t0 + 24 * 60 * 60 * 1000;
    const nextDayRes = await handleTenantExportsCollectionRequest(
      "ten_t107_alpha",
      makeAppRequest("/api/tenants/ten_t107_alpha/exports", {
        method: "POST",
        cookie: ownerA.cookie,
        body: {},
      }),
      queueEnv,
      { nowMs: nextDayMs },
    );
    expect(nextDayRes.status).toBe(202);
    expect(queuedEnvelopes).toHaveLength(2);
    expect((queuedEnvelopes[1] as { topic: string }).topic).toBe(TENANT_EXPORT_GENERATE_TOPIC);
  });

  it("executes self-service deletion with step-up reauth, immediate offline, 7-day undo, and REQ-069 purge preserving billing & audit", async () => {
    const t0 = Date.UTC(2026, 10, 23, 5, 0, 0);

    const ownerA = await signUpUser("del-owner-a@t107.test", "Owner Del Alpha");
    const adminA = await signUpUser("del-admin-a@t107.test", "Admin Del Alpha");
    const ownerB = await signUpUser("del-owner-b@t107.test", "Owner Del Beta");

    const seededA = await seedTenantWithContent({
      tenantId: "ten_t107_del_a",
      orgId: "org_t107_del_a",
      handle: "toko-hapus",
      name: "Toko Hapus",
      ownerUserId: ownerA.userId,
      customHost: "toko-hapus.id",
      nowMs: t0,
    });
    const seededB = await seedTenantWithContent({
      tenantId: "ten_t107_del_b",
      orgId: "org_t107_del_b",
      handle: "toko-aman",
      name: "Toko Aman",
      ownerUserId: ownerB.userId,
      nowMs: t0,
    });

    await env.PLATFORM_DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m_del_adm', 'org_t107_del_a', ?, 'admin', ?)",
    )
      .bind(adminA.userId, t0)
      .run();

    // Seed billing obligation, payment attempt, settlement, and numbered receipt (MUST survive purge!)
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(
        `INSERT INTO billing_obligations (
           id, tenant_id, payer_type, plan_interval, status, gross_amount_idr,
           discount_amount_idr, net_amount_idr, due_at, paid_at, version, created_at, updated_at
         ) VALUES ('obl_t107_1', 'ten_t107_del_a', 'tenant', 'monthly', 'paid', 179000, 0, 179000, ?, ?, 1, ?, ?)`,
      ).bind(t0, t0, t0, t0),
      env.PLATFORM_DB.prepare(
        `INSERT INTO payment_attempts (
           id, obligation_id, tenant_id, channel, provider, amount_idr, state, version, created_at, updated_at
         ) VALUES ('pa_t107_1', 'obl_t107_1', 'ten_t107_del_a', 'QRIS', 'autolaris', 179000, 'settled', 1, ?, ?)`,
      ).bind(t0, t0),
      env.PLATFORM_DB.prepare(
        `INSERT INTO settlements (
           id, obligation_id, payment_attempt_id, tenant_id, amount_idr, settled_at, reconciled_via, created_at
         ) VALUES ('set_t107_1', 'obl_t107_1', 'pa_t107_1', 'ten_t107_del_a', 179000, ?, 'webhook', ?)`,
      ).bind(t0, t0),
      env.PLATFORM_DB.prepare(
        `INSERT INTO receipts (
           id, tenant_id, settlement_id, receipt_number, kind, amount_idr, r2_pdf_key, issued_at, created_at
         ) VALUES ('rcp_t107_1', 'ten_t107_del_a', 'set_t107_1', 'PS-2026-000107', 'receipt', 179000, 'receipts/2026/PS-2026-000107.pdf', ?, ?)`,
      ).bind(t0, t0),
    ]);

    // 1. Admin denied 403; Foreign tenant denied 404
    const adminDel = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: adminA.cookie,
        body: { confirmHandle: "toko-hapus", currentPassword: OWNER_PASSWORD },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(adminDel.status).toBe(403);

    const foreignDel = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerB.cookie,
        body: { confirmHandle: "toko-hapus", currentPassword: OWNER_PASSWORD },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(foreignDel.status).toBe(404);

    // 2. Wrong typed handle -> 422 VALIDATION_ERROR
    const wrongHandle = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerA.cookie,
        body: { confirmHandle: "salah-handle", currentPassword: OWNER_PASSWORD },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(wrongHandle.status).toBe(422);

    // 3. Missing / wrong password & no recent 2FA -> 403 REAUTH_REQUIRED
    const missingAuth = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerA.cookie,
        body: { confirmHandle: "toko-hapus" },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(missingAuth.status).toBe(403);
    expect(((await missingAuth.json()) as { error: { code: string } }).error.code).toBe(
      "REAUTH_REQUIRED",
    );

    const wrongPwd = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerA.cookie,
        body: { confirmHandle: "toko-hapus", currentPassword: "WrongPassword123!" },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(wrongPwd.status).toBe(403);

    // 4. Valid typed confirmation + valid password -> 202 Accepted, site offline AT ONCE!
    const schedRes = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerA.cookie,
        body: {
          confirmHandle: "toko-hapus",
          currentPassword: OWNER_PASSWORD,
          reason: "Tutup usaha sementara",
        },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(schedRes.status).toBe(202);
    const schedJson = (await schedRes.json()) as {
      deletion: { siteStatus: string; canCancelDeletion: boolean; activeRequest: { status: string } };
    };
    expect(schedJson.deletion.siteStatus).toBe("suspended");
    expect(schedJson.deletion.canCancelDeletion).toBe(true);
    expect(schedJson.deletion.activeRequest.status).toBe("scheduled");

    // Public site immediately returns HTTP 503 neutral maintenance page!
    const publicGate = await evaluateRequestGate(
      new Request("https://toko-hapus.id/"),
      {
        APP_ENV: "test",
        PLATFORM_DOMAIN: "punyasitus.com",
        SAAS_ZONE: "situsku.click",
        PLATFORM_DB: env.PLATFORM_DB,
      },
      { nowMs: t0 + 1000, bypassHostCache: true },
    );
    expect(publicGate.action).toBe("respond");
    if (publicGate.action === "respond") {
      expect(publicGate.response.status).toBe(503);
      expect(publicGate.response.headers.get("X-Robots-Tag")).toContain("noindex");
      const html = await publicGate.response.text();
      expect(html).toContain("Situs dalam perbaikan");
      expect(html).not.toContain("Toko Hapus");
    }

    // 5. Undo through REAL auth middleware before 7-day deadline (at T0 + 6 days)
    //    (Simulate owner returning with an active session on day 6)
    const undoAt = t0 + 6 * 86_400_000;
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE user_id = ?",
    )
      .bind(undoAt - 60_000, undoAt - 60_000, undoAt + 86_400_000, ownerA.userId)
      .run();
    const cancelReq = makeAppRequest("/api/tenants/ten_t107_del_a/deletion/cancel", {
      method: "POST",
      cookie: ownerA.cookie,
      body: { reason: "Berubah pikiran" },
    });
    const middlewareLocals = createMiddlewareLocals("app");
    const cancelViaMiddleware = await executeAuthMiddleware(
      { request: cancelReq, locals: middlewareLocals },
      () =>
        handleTenantDeletionCancelRequest("ten_t107_del_a", cancelReq, buildDataEnv(), {
          nowMs: undoAt,
          authenticatedUser: middlewareLocals.authUser ? { id: middlewareLocals.authUser.id } : null,
          authenticatedSession: middlewareLocals.authSession
            ? {
                id: middlewareLocals.authSession.id,
                createdAt: middlewareLocals.authSession.createdAt,
              }
            : null,
          activeOrganizationId: middlewareLocals.authSession?.activeOrganizationId ?? null,
        }),
      buildAuthEnv(),
      { nowMs: undoAt },
    );
    expect(cancelViaMiddleware.status).toBe(200);
    const cancelJson = (await cancelViaMiddleware.json()) as {
      canceled: boolean;
      restoredStatus: string;
    };
    expect(cancelJson.canceled).toBe(true);
    expect(cancelJson.restoredStatus).toBe("active");

    // Public site is immediately back online with zero data loss!
    const restoredResolution = await resolveTenantByHost(env.PLATFORM_DB, "toko-hapus.id", {
      nowMs: undoAt + 1000,
      bypassCache: true,
    });
    expect(restoredResolution.kind).toBe("resolved");
    if (restoredResolution.kind === "resolved") {
      expect(restoredResolution.tenant.effectiveStatus).toBe("active");
    }
    const survivingPage = await seededA.tenantDb
      .prepare("SELECT title FROM pages WHERE id = 1")
      .first<{ readonly title: string }>();
    expect(survivingPage?.title).toBe("Beranda Toko Hapus");

    // 6. Re-schedule deletion using recent 2FA verification (within 10 minutes), then let 7 days pass!
    const t1 = undoAt + 60_000;
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO session_two_factor_verifications (
         session_id, user_id, verified_at, method, created_at, updated_at
       ) VALUES (?, ?, ?, 'totp', ?, ?)`,
    )
      .bind(ownerA.sessionId, ownerA.userId, t1 - 60_000, t1 - 60_000, t1 - 60_000)
      .run();

    const sched2 = await handleTenantDeletionRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion", {
        method: "POST",
        cookie: ownerA.cookie,
        body: { confirmHandle: "toko-hapus" }, // No password needed because recent 2FA is verified!
      }),
      buildDataEnv(),
      { nowMs: t1 },
    );
    expect(sched2.status).toBe(202);

    // At exact 7-day boundary: cancel is REFUSED (409 DELETION_WINDOW_EXPIRED)
    const after7Days = t1 + DELETION_UNDO_WINDOW_MS;
    await env.PLATFORM_DB.prepare(
      "UPDATE sessions SET created_at = ?, updated_at = ?, expires_at = ? WHERE user_id = ?",
    )
      .bind(after7Days - 60_000, after7Days - 60_000, after7Days + 86_400_000, ownerA.userId)
      .run();
    const lateCancel = await handleTenantDeletionCancelRequest(
      "ten_t107_del_a",
      makeAppRequest("/api/tenants/ten_t107_del_a/deletion/cancel", {
        method: "POST",
        cookie: ownerA.cookie,
        body: {},
      }),
      buildDataEnv(),
      { nowMs: after7Days },
    );
    expect(lateCancel.status).toBe(409);

    // 7. Run `exports.deletion_sweep` via Durable Queue -> invokes existing REQ-069 purge path!
    const deletedCfHostnames: string[] = [];
    const cfMock: OffboardingCloudflareClientLike = {
      async deleteCustomHostname(id) {
        deletedCfHostnames.push(id);
        return { deleted: true, alreadyAbsent: false };
      },
    };

    const sweepBatch = createMessageBatch("punyasitus-jobs", [
      {
        id: "msg_del_sweep_1",
        timestamp: new Date(after7Days),
        attempts: 1,
        body: {
          idempotencyKey: "del-sweep:t107:1",
          topic: TENANT_SELF_DELETION_SWEEP_TOPIC,
          tenantId: "ten_t107_del_a",
          payload: { scheduledAtMs: after7Days, tenantId: "ten_t107_del_a" },
        },
      },
    ]);

    const sweepRes = await processDurableQueueBatch(
      sweepBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
        TENANT_STORE: env.TENANT_STORE,
      },
      createExportJobRegistry({
        now: () => after7Days,
        mediaBucket: env.MEDIA_BUCKET as unknown as ExportR2BucketLike,
        tenantStoreNamespace: env.TENANT_STORE as unknown as OffboardingTenantStoreNamespaceLike,
        cloudflareClient: cfMock,
      }),
      { now: () => after7Days },
    );
    expect(sweepRes.completed).toBe(1);

    // Verify full REQ-069 purge happened for Tenant A while billing & audit rows SURVIVE!
    expect(deletedCfHostnames).toEqual(["cf_host_ten_t107_del_a"]);

    const purgedTenant = await env.PLATFORM_DB.prepare(
      "SELECT status, handle, name FROM tenants WHERE id = 'ten_t107_del_a'",
    ).first<{ readonly status: string; readonly handle: string; readonly name: string }>();
    expect(purgedTenant?.status).toBe("purged");
    expect(purgedTenant?.handle).toMatch(/^purged-/);
    expect(purgedTenant?.name).toBe("Deleted Tenant");

    const delReqRow = await env.PLATFORM_DB.prepare(
      "SELECT status, purged_at FROM tenant_deletion_requests WHERE tenant_id = 'ten_t107_del_a' ORDER BY created_at DESC LIMIT 1",
    ).first<{ readonly status: string; readonly purged_at: number | null }>();
    expect(delReqRow?.status).toBe("purged");
    expect(delReqRow?.purged_at).toBe(after7Days);

    const tombstone = await env.PLATFORM_DB.prepare(
      "SELECT handle, quarantine_until FROM deletion_tombstones WHERE tenant_id = 'ten_t107_del_a'",
    ).first<{ readonly handle: string; readonly quarantine_until: number }>();
    expect(tombstone?.handle).toBe("toko-hapus");
    expect(tombstone?.quarantine_until).toBeGreaterThan(after7Days);

    // Tenant A R2 objects purged; Tenant B R2 objects completely intact!
    expect(await env.MEDIA_BUCKET.get(seededA.mediaKey)).toBeNull();
    expect(await env.MEDIA_BUCKET.get(seededB.mediaKey)).not.toBeNull();

    // Billing, settlements, numbered receipts, and platform_audit rows MUST remain intact (DEC-022)!
    const obligation = await env.PLATFORM_DB.prepare(
      "SELECT id, status, net_amount_idr FROM billing_obligations WHERE id = 'obl_t107_1'",
    ).first<{ readonly id: string; readonly status: string; readonly net_amount_idr: number }>();
    expect(obligation).toEqual({ id: "obl_t107_1", status: "paid", net_amount_idr: 179000 });

    const receipt = await env.PLATFORM_DB.prepare(
      "SELECT receipt_number, amount_idr FROM receipts WHERE id = 'rcp_t107_1'",
    ).first<{ readonly receipt_number: string; readonly amount_idr: number }>();
    expect(receipt).toEqual({ receipt_number: "PS-2026-000107", amount_idr: 179000 });

    const auditActions = await env.PLATFORM_DB.prepare(
      "SELECT action FROM platform_audit WHERE tenant_id = 'ten_t107_del_a' ORDER BY created_at ASC",
    ).all<{ readonly action: string }>();
    const actionNames = (auditActions.results ?? []).map((r) => r.action);
    expect(actionNames).toContain("tenant.deletion.requested");
    expect(actionNames).toContain("tenant.deletion.canceled");
    expect(actionNames).toContain("tenant.deletion.purge_claimed");
    expect(actionNames).toContain("tenant.offboarding.purged");
  });

  it("blocks self-service deletion while operator hold is active", async () => {
    const t0 = Date.UTC(2026, 10, 23, 6, 0, 0);
    const owner = await signUpUser("held-owner@t107.test", "Held Owner");
    await seedTenantWithContent({
      tenantId: "ten_t107_held",
      orgId: "org_t107_held",
      handle: "toko-ditahan",
      name: "Toko Ditahan",
      ownerUserId: owner.userId,
      nowMs: t0,
      operatorHold: true,
    });

    const res = await handleTenantDeletionRequest(
      "ten_t107_held",
      makeAppRequest("/api/tenants/ten_t107_held/deletion", {
        method: "POST",
        cookie: owner.cookie,
        body: { confirmHandle: "toko-ditahan", currentPassword: OWNER_PASSWORD },
      }),
      buildDataEnv(),
      { nowMs: t0 },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "OPERATOR_HOLD_ACTIVE",
    );
  });

  it("handles billing settlement during 7-day undo window, blocks unrelated mutations while suspended, enforces 2FA step-up, and recovers from enqueue/stale processing failures", async () => {
    const t0 = Date.UTC(2026, 10, 23, 7, 0, 0);
    const owner = await signUpUser("resilience-owner@t107.test", "Resilience Owner");
    await seedTenantWithContent({
      tenantId: "ten_t107_resil",
      orgId: "org_t107_resil",
      handle: "toko-resil",
      name: "Toko Resil",
      ownerUserId: owner.userId,
      nowMs: t0,
      paidThroughMs: t0 + 30 * 86_400_000, // paid well in the future!
    });

    // 1. Enqueue failure marks job `failed` so daily 1/day quota is NOT permanently locked!
    const failingQueueEnv = buildDataEnv({
      JOBS_QUEUE: {
        async send() {
          throw new Error("QUEUE_SEND_OUTAGE");
        },
      },
    });
    const failedPost = await handleTenantExportsCollectionRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/exports", {
        method: "POST",
        cookie: owner.cookie,
        body: {},
      }),
      failingQueueEnv,
      { nowMs: t0 },
    );
    expect(failedPost.status).toBe(503);

    // Retry on the SAME day succeeds once queue recovers!
    const queued: unknown[] = [];
    const recoveredQueueEnv = buildDataEnv({
      JOBS_QUEUE: {
        async send(m) {
          queued.push(m);
        },
      },
    });
    const retryPost = await handleTenantExportsCollectionRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/exports", {
        method: "POST",
        cookie: owner.cookie,
        body: {},
      }),
      recoveredQueueEnv,
      { nowMs: t0 + 5_000 },
    );
    expect(retryPost.status).toBe(202);
    const retryJson = (await retryPost.json()) as { export: { id: string } };

    // Simulate stale `processing` job (> 15 min) and verify cleanup reaps it to `failed`
    await env.PLATFORM_DB.prepare(
      "UPDATE tenant_export_jobs SET status = 'processing', updated_at = ? WHERE id = ?",
    )
      .bind(t0 + 5_000, retryJson.export.id)
      .run();

    const reapAt = t0 + 20 * 60_000;
    const reapBatch = createMessageBatch("punyasitus-jobs", [
      {
        id: "msg_reap_stale_1",
        timestamp: new Date(reapAt),
        attempts: 1,
        body: {
          idempotencyKey: "cleanup:stale:t107",
          topic: TENANT_EXPORT_CLEANUP_TOPIC,
          tenantId: null,
          payload: { scheduledAtMs: reapAt },
        },
      },
    ]);
    await processDurableQueueBatch(
      reapBatch,
      { PLATFORM_DB: env.PLATFORM_DB, MEDIA_BUCKET: env.MEDIA_BUCKET },
      createExportJobRegistry({ now: () => reapAt }),
      { now: () => reapAt },
    );
    const reapedRow = await env.PLATFORM_DB.prepare(
      "SELECT status, error_code FROM tenant_export_jobs WHERE id = ?",
    )
      .bind(retryJson.export.id)
      .first<{ readonly status: string; readonly error_code: string | null }>();
    expect(reapedRow).toEqual({ status: "failed", error_code: "STALE_PROCESSING_TIMEOUT" });

    // 2. When `users.two_factor_enabled = 1`, `currentPassword` alone CANNOT bypass active 2FA!
    await env.PLATFORM_DB.prepare("UPDATE users SET two_factor_enabled = 1 WHERE id = ?")
      .bind(owner.userId)
      .run();

    const bypassAttempt = await handleTenantDeletionRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/deletion", {
        method: "POST",
        cookie: owner.cookie,
        body: { confirmHandle: "toko-resil", currentPassword: OWNER_PASSWORD },
      }),
      buildDataEnv(),
      { nowMs: t0 + 10_000 },
    );
    expect(bypassAttempt.status).toBe(403);
    expect(((await bypassAttempt.json()) as { error: { code: string } }).error.code).toBe(
      "TOTP_REQUIRED",
    );

    // Record recent Better Auth 2FA session verification -> deletion succeeds!
    await env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO session_two_factor_verifications (
         session_id, user_id, verified_at, method, created_at, updated_at
       ) VALUES (?, ?, ?, 'totp', ?, ?)`,
    )
      .bind(owner.sessionId, owner.userId, t0 + 9_000, t0 + 9_000, t0 + 9_000)
      .run();

    const delOk = await handleTenantDeletionRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/deletion", {
        method: "POST",
        cookie: owner.cookie,
        body: { confirmHandle: "toko-resil" },
      }),
      buildDataEnv(),
      { nowMs: t0 + 10_000 },
    );
    expect(delOk.status).toBe(202);

    // 3. Paid tenant (`paid_through` in future) suspended by scheduled deletion:
    //    unrelated CMS writes are BLOCKED (403 SUBSCRIPTION_LOCKED) while owner `/deletion` & `/exports` pass!
    const cmsWriteReq = makeAppRequest("/api/tenants/ten_t107_resil/pages", {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Should Fail" },
    });
    const cmsLocals = createMiddlewareLocals("app");
    const cmsRes = await executeAuthMiddleware(
      { request: cmsWriteReq, locals: cmsLocals },
      async () => new Response("SHOULD_NOT_REACH", { status: 200 }),
      buildAuthEnv(),
      { nowMs: t0 + 15_000 },
    );
    expect(cmsRes.status).toBe(403);

    // 4. Simulate billing settlement flipping `tenants.status = 'active'` during the 7-day undo window:
    //    `cancel` MUST still succeed cleanly (never stuck in `scheduled`)!
    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', version = version + 1 WHERE id = 'ten_t107_resil'",
    ).run();

    const cancelAfterSettlement = await handleTenantDeletionCancelRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/deletion/cancel", {
        method: "POST",
        cookie: owner.cookie,
        body: {},
      }),
      buildDataEnv(),
      { nowMs: t0 + 20_000 },
    );
    expect(cancelAfterSettlement.status).toBe(200);
    const canceledState = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenant_deletion_requests WHERE tenant_id = 'ten_t107_resil' ORDER BY created_at DESC LIMIT 1",
    ).first<{ readonly status: string }>();
    expect(canceledState?.status).toBe("canceled");

    // 5. Re-schedule deletion, simulate settlement flipping `tenants.status = 'active'`,
    //    then let 7-day window expire -> sweep MUST STILL claim and purge cleanly!
    const del2 = await handleTenantDeletionRequest(
      "ten_t107_resil",
      makeAppRequest("/api/tenants/ten_t107_resil/deletion", {
        method: "POST",
        cookie: owner.cookie,
        body: { confirmHandle: "toko-resil" },
      }),
      buildDataEnv(),
      { nowMs: t0 + 30_000 },
    );
    expect(del2.status).toBe(202);

    await env.PLATFORM_DB.prepare(
      "UPDATE tenants SET status = 'active', version = version + 1 WHERE id = 'ten_t107_resil'",
    ).run();

    const after7d = t0 + 30_000 + DELETION_UNDO_WINDOW_MS;
    const sweepBatch = createMessageBatch("punyasitus-jobs", [
      {
        id: "msg_del_resil_sweep",
        timestamp: new Date(after7d),
        attempts: 1,
        body: {
          idempotencyKey: "del-sweep:resil:1",
          topic: TENANT_SELF_DELETION_SWEEP_TOPIC,
          tenantId: "ten_t107_resil",
          payload: { scheduledAtMs: after7d, tenantId: "ten_t107_resil" },
        },
      },
    ]);
    const sweepRes = await processDurableQueueBatch(
      sweepBatch,
      {
        PLATFORM_DB: env.PLATFORM_DB,
        MEDIA_BUCKET: env.MEDIA_BUCKET,
        TENANT_STORE: env.TENANT_STORE,
      },
      createExportJobRegistry({
        now: () => after7d,
        mediaBucket: env.MEDIA_BUCKET as unknown as ExportR2BucketLike,
        tenantStoreNamespace: env.TENANT_STORE as unknown as OffboardingTenantStoreNamespaceLike,
      }),
      { now: () => after7d },
    );
    expect(sweepRes.completed).toBe(1);

    const finalTenant = await env.PLATFORM_DB.prepare(
      "SELECT status FROM tenants WHERE id = 'ten_t107_resil'",
    ).first<{ readonly status: string }>();
    expect(finalTenant?.status).toBe("purged");
  });
});
