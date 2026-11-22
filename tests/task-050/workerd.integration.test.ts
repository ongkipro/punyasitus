import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_SESSION_COOKIE_NAME } from "@punyasitus/auth";
import {
  MAX_PREVIEW_REQUEST_BYTES,
  PREVIEW_CACHE_CONTROL_HEADER,
  PREVIEW_HEADER_NAME,
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_PRAGMA_HEADER,
  PREVIEW_ROBOTS_HEADER,
  type DraftPreviewApiResponse,
} from "@punyasitus/core/preview/index";
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
  members,
  organizations,
  PLATFORM_MIGRATIONS,
  platformSchema,
  sessions,
  tenants,
  tenantThemeEntitlements,
  themeCatalog,
} from "@punyasitus/db/platform";
import {
  getPublishedResource,
  publishResourceAtomically,
  saveDraftResource,
} from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { serveWithRevisionedEdgeCache } from "../../apps/web/src/core/cache.ts";
import { loadPublishedTenantShellData } from "../../apps/web/src/core/public-data.ts";
import { handleBetterAuthRequest } from "../../apps/web/src/pages/api/auth/[...all].ts";
import {
  handleTenantPreviewRequest,
  type TenantPreviewRuntimeEnv,
} from "../../apps/web/src/pages/api/tenants/[tenantId]/preview/_shared.ts";

const APP_ORIGIN = "https://app.punyasitus.com";
const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const TEST_APP_SECRET = "test-app-auth-secret-0123456789abcdef0123456789abcdef";
const TEST_CONSOLE_SECRET = "test-console-auth-secret-fedcba9876543210fedcba9876543210";
const BASE_NOW_MS = Date.UTC(2026, 10, 22, 16, 0, 0);

const TENANT_A = {
  id: "01JT050TENANTA000000000001",
  orgId: "org_t050_alpha",
  handle: "t050-alpha",
  name: "T050 Alpha Arsitek",
  host: "t050-alpha.situsku.click",
} as const;

const TENANT_B = {
  id: "01JT050TENANTB000000000002",
  orgId: "org_t050_beta",
  handle: "t050-beta",
  name: "T050 Beta Klinik",
  host: "t050-beta.situsku.click",
} as const;

function buildRuntimeEnv(
  overrides: Partial<TenantPreviewRuntimeEnv> = {},
): TenantPreviewRuntimeEnv {
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
    throw new Error(`Expected ${APP_SESSION_COOKIE_NAME} cookie, got: ${JSON.stringify(cookies)}`);
  }
  return (sessionHeader.split(";")[0] ?? "").trim();
}

function makePreviewRequest(
  url: string,
  method: "GET" | "POST" = "POST",
  options: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly rawBody?: string;
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
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
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
  runtimeEnv: TenantPreviewRuntimeEnv,
): Promise<{ readonly userId: string; readonly cookie: string }> {
  const res = await handleBetterAuthRequest(
    makePreviewRequest(`${APP_ORIGIN}/api/auth/sign-up/email`, "POST", {
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
       VALUES (?, ?, ?, ?, 24576, ?, 1200, 630, ?, ?, 1, ?, ?)`,
    )
    .bind(
      params.id,
      kind,
      key,
      mime,
      `${params.id}`.padStart(64, "a"),
      `Asset ${params.id} (${params.tenantId})`,
      status,
      BASE_NOW_MS,
      BASE_NOW_MS,
    )
    .run();
}

function assertStrictPreviewResponseHeaders(res: Response): void {
  expect(res.headers.get("Cache-Control")).toBe(PREVIEW_CACHE_CONTROL_HEADER);
  expect(res.headers.get("Pragma")).toBe(PREVIEW_PRAGMA_HEADER);
  expect(res.headers.get("X-Robots-Tag")).toBe(PREVIEW_ROBOTS_HEADER);
  expect(res.headers.get(PREVIEW_HEADER_NAME)).toBe("1");
  expect(res.headers.get("X-PunyaSitus-Cache")).toBe("BYPASS");
  expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
}

describe("TASK-050: In-Process Draft Preview & Admin Security on workerd", () => {
  let tenantDbA: D1Database;
  let tenantDbB: D1Database;
  let ownerA: { readonly userId: string; readonly cookie: string };
  let editorA: { readonly userId: string; readonly cookie: string };
  let ownerB: { readonly userId: string; readonly cookie: string };
  const runtimeEnv = buildRuntimeEnv();

  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    const now = new Date(BASE_NOW_MS);

    for (const spec of [TENANT_A, TENANT_B]) {
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
          schemaVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    // Seed custom theme catalog + grant custom-alpha-pro ONLY to Tenant A
    await pDb
      .insert(themeCatalog)
      .values([
        {
          id: "custom-alpha-pro",
          slug: "custom-alpha-pro",
          name: "Alpha Pro Custom Theme",
          tier: "custom",
          priceIdr: 0,
          active: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "custom-beta-only",
          slug: "custom-beta-only",
          name: "Beta Only Custom Theme",
          tier: "custom",
          priceIdr: 0,
          active: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .onConflictDoNothing();

    await pDb
      .insert(tenantThemeEntitlements)
      .values({
        id: "ent_t050_alpha_custom",
        tenantId: TENANT_A.id,
        themeId: "custom-alpha-pro",
        grantedBy: null,
        grantedAt: now,
      })
      .onConflictDoNothing();

    [tenantDbA, tenantDbB] = await Promise.all([
      openMigratedTenantDb(TENANT_A.id),
      openMigratedTenantDb(TENANT_B.id),
    ]);

    ownerA = await signUpUser("owner-a@t050.example", "Owner Alpha", runtimeEnv);
    editorA = await signUpUser("editor-a@t050.example", "Editor Alpha", runtimeEnv);
    ownerB = await signUpUser("owner-b@t050.example", "Owner Beta", runtimeEnv);

    await pDb
      .insert(members)
      .values([
        {
          id: "mem_t050_owner_a",
          organizationId: TENANT_A.orgId,
          userId: ownerA.userId,
          role: "owner",
          createdAt: now,
        },
        {
          id: "mem_t050_editor_a",
          organizationId: TENANT_A.orgId,
          userId: editorA.userId,
          role: "editor",
          createdAt: now,
        },
        {
          id: "mem_t050_owner_b",
          organizationId: TENANT_B.orgId,
          userId: ownerB.userId,
          role: "owner",
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    // Seed owned media: #101 in Tenant A ONLY, #202 in Tenant B ONLY
    await seedMediaItem(tenantDbA, { id: 101, tenantId: TENANT_A.id, kind: "image", status: "ready" });
    await seedMediaItem(tenantDbB, { id: 202, tenantId: TENANT_B.id, kind: "image", status: "ready" });

    // Seed published homepage v1 -> publish -> save unpublished draft v3 in Tenant A
    await tenantDbA
      .prepare(
        `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, status, version, created_at, updated_at)
         VALUES (1, 'beranda', 'Beranda Publik', 1, '[]', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_NOW_MS + 1000,
      draft: {
        slug: "beranda",
        title: "Beranda Publik Resmi",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "hero-pub",
            kind: "hero",
            heading: "Judul Publik Live",
            subheading: "Konten resmi yang sedang tayang",
            bodyHtml: "<p>Deskripsi publik resmi.</p>",
          },
        ],
      },
    });

    await publishResourceAtomically(env.PLATFORM_DB, tenantDbA, {
      tenantId: TENANT_A.id,
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 2,
      actorUserId: ownerA.userId,
      nowMs: BASE_NOW_MS + 2000,
    });

    // Now save a private unpublished draft v3 -> v4 containing hostile script/form/link to verify inert rendering
    await saveDraftResource(tenantDbA, {
      resourceType: "page",
      resourceId: 1,
      expectedVersion: 3,
      nowMs: BASE_NOW_MS + 3000,
      draft: {
        slug: "beranda",
        title: "DRAF RAHASIA PELUNCURAN 2027",
        isHomepage: true,
        layoutMode: "standard",
        sections: [
          {
            id: "hero-draft",
            kind: "hero",
            heading: "Headline Draf Rahasia Q4",
            subheading: "Hanya terlihat di pratinjau admin",
            bodyHtml:
              '<p>Paragraf draf terbaru.</p><script>window.__leakedScript=1</script><form action="https://evil.example/post"><button type="submit">Kirim</button></form>',
            ctaLabel: "Kunjungi Partner",
            ctaHref: "https://partner.example/promo",
          },
        ],
        seo: {
          ogImageMediaId: 101,
        },
        draftNotes: "Catatan internal rahasia editor",
      },
    });

    // Seed draft post #1 in Tenant A
    await tenantDbA
      .prepare(
        `INSERT INTO posts (id, slug, title, excerpt, draft_body_json, status, version, created_at, updated_at)
         VALUES (1, 'panduan-draf', 'Artikel Draf', NULL, '{"schemaVersion":1,"blocks":[]}', 'draft', 1, ?, ?)`,
      )
      .bind(BASE_NOW_MS, BASE_NOW_MS)
      .run();

    await saveDraftResource(tenantDbA, {
      resourceType: "post",
      resourceId: 1,
      expectedVersion: 1,
      nowMs: BASE_NOW_MS + 4000,
      draft: {
        slug: "panduan-draf",
        title: "Panduan Draf SEO Bisnis",
        excerpt: "Ringkasan artikel draf",
        coverMediaId: 101,
        body: {
          schemaVersion: 1,
          blocks: [
            { type: "heading", level: 2, text: "Langkah Pertama" },
            { type: "paragraph", text: "Konten artikel yang belum terbit." },
            { type: "image", mediaId: 101 },
          ],
        },
        readingTimeMinutes: 4,
        showToc: true,
      },
    });
  });

  it("renders authorized draft preview in-process with inert HTML & strict headers while keeping public reads and edge cache untouched", async () => {
    const res = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: {
          resourceKind: "page",
          resourceId: 1,
          expectedVersion: 4,
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 5000 },
    );

    expect(res.status).toBe(200);
    assertStrictPreviewResponseHeaders(res);

    const payload = (await res.json()) as DraftPreviewApiResponse;
    expect(payload.isPreview).toBe(true);
    expect(payload.version).toBe(4);
    expect(payload.resourceKind).toBe("page");
    expect(payload.resourceId).toBe(1);
    expect(payload.hasUnpublishedChanges).toBe(true);
    expect(payload.sandbox).toBe(PREVIEW_IFRAME_SANDBOX);

    // Draft content is rendered in-process
    expect(payload.html).toContain("DRAF RAHASIA PELUNCURAN 2027");
    expect(payload.html).toContain("Headline Draf Rahasia Q4");
    expect(payload.html).toContain("Mode Pratinjau Draf");

    // Draft-only notes, scripts, forms, and external navigation are completely neutralized/stripped!
    expect(payload.html).not.toContain("Catatan internal rahasia editor");
    expect(payload.html.toLowerCase()).not.toContain("<script");
    expect(payload.html).not.toContain("__leakedScript");
    expect(payload.html).not.toMatch(/\shref\s*=\s*"https:\/\/partner\.example/i);
    expect(payload.html).toContain('data-preview-href="https://partner.example/promo"');
    expect(payload.html).toContain('data-preview-inert="link"');
    expect(payload.html).toContain('<meta name="robots" content="noindex, nofollow" />');

    // Public published reads remain 100% untouched (ZERO draft leak!)
    const publicPage = await getPublishedResource(tenantDbA, { resourceType: "page", resourceId: 1 });
    expect(publicPage?.data.title).toBe("Beranda Publik Resmi");
    expect(JSON.stringify(publicPage)).not.toContain("DRAF RAHASIA");

    const publicShell = await loadPublishedTenantShellData(tenantDbA, {
      previewMode: false,
      fallbackSiteTitle: TENANT_A.name,
    });
    expect(publicShell.isPreview).toBe(false);
    expect(publicShell.page?.title).toBe("Beranda Publik Resmi");
    expect(JSON.stringify(publicShell)).not.toContain("DRAF RAHASIA");

    // Edge cache strictly bypasses preview responses and never leaks draft HTML to public visitors
    const cache = (caches as unknown as { readonly default: Cache }).default;
    const edgePreview = await serveWithRevisionedEdgeCache({
      request: new Request(`https://${TENANT_A.host}/?preview=1`),
      tenantId: TENANT_A.id,
      host: TENANT_A.host,
      cacheVersion: 2,
      isPreview: true,
      cache,
      render: async () =>
        new Response(payload.html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            [PREVIEW_HEADER_NAME]: "1",
          },
        }),
    });
    expect(edgePreview.cacheStatus).toBe("BYPASS");
    expect(edgePreview.bypassReason).toBe("preview_request");
  });

  it("renders draft post with verified tenant-owned media (#101) and allows granted custom theme", async () => {
    const res = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: {
          resourceKind: "post",
          resourceId: 1,
          expectedVersion: 2,
          themeId: "custom-alpha-pro",
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 6000 },
    );

    expect(res.status).toBe(200);
    assertStrictPreviewResponseHeaders(res);
    const data = (await res.json()) as DraftPreviewApiResponse;
    expect(data.themeId).toBe("custom-alpha-pro");
    expect(data.html).toContain("Panduan Draf SEO Bisnis");
    expect(data.html).toContain("Media terverifikasi #101");
  });

  it("rejects cross-tenant media references (#202 owned by Tenant B) with 422 MEDIA_NOT_FOUND", async () => {
    const res = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: {
          resourceKind: "post",
          resourceId: 1,
          expectedVersion: 2,
          draftOverride: {
            post: {
              slug: "panduan-draf",
              title: "Percobaan Media Lintas Tenant",
              coverMediaId: 202, // Exists ONLY in Tenant B!
              body: {
                schemaVersion: 1,
                blocks: [{ type: "paragraph", text: "Isi" }],
              },
              readingTimeMinutes: 2,
              showToc: false,
            },
          },
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 7000 },
    );

    expect(res.status).toBe(422);
    assertStrictPreviewResponseHeaders(res);
    const err = (await res.json()) as {
      error: { code: string; fields?: Array<{ field: string; code: string }> };
    };
    expect(err.error.code).toBe("VALIDATION_ERROR");
    expect(err.error.fields?.some((f) => f.code === "MEDIA_NOT_FOUND")).toBe(true);
  });

  it("rejects unregistered or ungranted custom themes visibly with 422 UNREGISTERED_THEME", async () => {
    for (const themeId of ["custom-beta-only", "custom-does-not-exist"]) {
      const res = await handleTenantPreviewRequest(
        TENANT_A.handle,
        makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
          cookie: ownerA.cookie,
          body: {
            resourceKind: "home",
            themeId,
          },
        }),
        runtimeEnv,
        { nowMs: BASE_NOW_MS + 8000 },
      );

      expect(res.status).toBe(422);
      assertStrictPreviewResponseHeaders(res);
      const err = (await res.json()) as {
        error: { code: string; fields?: Array<{ code: string }> };
      };
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.fields?.some((f) => f.code === "UNREGISTERED_THEME")).toBe(true);
    }
  });

  it("enforces wrong-tenant (404), wrong-role (403 for editor on theme/identity), and allows editor on content preview (200)", async () => {
    // 1. Wrong-tenant: Owner B attempting to preview Tenant A -> neutral 404
    const crossTenantRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerB.cookie,
        body: { resourceKind: "page", resourceId: 1, expectedVersion: 4 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9000 },
    );
    expect(crossTenantRes.status).toBe(404);
    assertStrictPreviewResponseHeaders(crossTenantRes);

    // 2. Wrong-role: Editor A attempting to preview theme/identity override -> 403 FORBIDDEN
    const wrongRoleRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: editorA.cookie,
        body: { resourceKind: "theme", themeId: "travel" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9500 },
    );
    expect(wrongRoleRes.status).toBe(403);
    assertStrictPreviewResponseHeaders(wrongRoleRes);
    const wrongRoleBody = (await wrongRoleRes.json()) as { error: { code: string } };
    expect(wrongRoleBody.error.code).toBe("FORBIDDEN");

    // 3. Valid role: Editor A previewing saved page draft -> 200 OK
    const editorPageRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: editorA.cookie,
        body: { resourceKind: "page", resourceId: 1, expectedVersion: 4 },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 9600 },
    );
    expect(editorPageRes.status).toBe(200);
    assertStrictPreviewResponseHeaders(editorPageRes);
  });

  it("rejects stale expectedVersion with 409 STALE_VERSION", async () => {
    const res = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: {
          resourceKind: "page",
          resourceId: 1,
          expectedVersion: 3, // Current version is 4!
        },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 10_000 },
    );

    expect(res.status).toBe(409);
    assertStrictPreviewResponseHeaders(res);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STALE_VERSION");
  });

  it("rejects wrong hosts (404), CSRF/Origin mismatches (403), oversized payloads (413), and forbidden selectors (422)", async () => {
    // Tenant host -> neutral 404
    const tenantHostRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`https://${TENANT_A.host}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        origin: `https://${TENANT_A.host}`,
        body: { resourceKind: "home" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_000 },
    );
    expect(tenantHostRes.status).toBe(404);
    assertStrictPreviewResponseHeaders(tenantHostRes);

    // Console host -> neutral 404
    const consoleHostRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${CONSOLE_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        origin: CONSOLE_ORIGIN,
        body: { resourceKind: "home" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_100 },
    );
    expect(consoleHostRes.status).toBe(404);

    // CSRF Origin mismatch -> 403 FORBIDDEN
    const badOriginRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        origin: `https://${TENANT_A.host}`,
        body: { resourceKind: "home" },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_200 },
    );
    expect(badOriginRes.status).toBe(403);
    assertStrictPreviewResponseHeaders(badOriginRes);

    // Non-JSON Content-Type -> 403 FORBIDDEN
    const badContentTypeRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        contentType: "text/plain",
        rawBody: '{"resourceKind":"home"}',
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_300 },
    );
    expect(badContentTypeRes.status).toBe(403);

    // Oversized > 128 KiB payload -> 413 PAYLOAD_TOO_LARGE
    const oversizedRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        rawBody: JSON.stringify({
          resourceKind: "home",
          padding: "x".repeat(MAX_PREVIEW_REQUEST_BYTES + 128),
        }),
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_400 },
    );
    expect(oversizedRes.status).toBe(413);
    assertStrictPreviewResponseHeaders(oversizedRes);

    // Forbidden selector key -> 422 VALIDATION_ERROR
    const forbiddenKeyRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: ownerA.cookie,
        body: { resourceKind: "home", tenantId: TENANT_B.id },
      }),
      runtimeEnv,
      { nowMs: BASE_NOW_MS + 11_500 },
    );
    expect(forbiddenKeyRes.status).toBe(422);
    assertStrictPreviewResponseHeaders(forbiddenKeyRes);
  });

  it("rejects expired sessions with 401 UNAUTHENTICATED and guarantees expired sessions cannot refresh previews", async () => {
    const tempUser = await signUpUser("expiring@t050.example", "Expiring Owner", runtimeEnv);
    const pDb = createSqliteDrizzle(env.PLATFORM_DB, platformSchema);
    await pDb.insert(members).values({
      id: "mem_t050_expiring_a",
      organizationId: TENANT_A.orgId,
      userId: tempUser.userId,
      role: "owner",
      createdAt: new Date(BASE_NOW_MS),
    });

    // Confirm valid session works before expiry
    const beforeExpiry = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: tempUser.cookie,
        body: { resourceKind: "page", resourceId: 1, expectedVersion: 4 },
      }),
      runtimeEnv,
      { nowMs: Date.now() },
    );
    expect(beforeExpiry.status).toBe(200);

    // Advance clock past app session absolute ceiling (+31 days) -> MUST fail 401 & revoke session (no refresh!)
    const futureMs = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const expiredRes = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: tempUser.cookie,
        body: { resourceKind: "page", resourceId: 1, expectedVersion: 4 },
      }),
      runtimeEnv,
      { nowMs: futureMs },
    );
    expect(expiredRes.status).toBe(401);
    assertStrictPreviewResponseHeaders(expiredRes);
    const expiredBody = (await expiredRes.json()) as { error: { code: string } };
    expect(expiredBody.error.code).toBe("UNAUTHENTICATED");
    // No Set-Cookie refreshing the expired session
    expect(getSetCookies(expiredRes.headers)).toHaveLength(0);

    // Subsequent retry even at current clock MUST STILL fail 401 because the expired session was invalidated
    const remainingSessions = await pDb
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, tempUser.userId));
    expect(remainingSessions).toHaveLength(0);

    const retryAfterExpiry = await handleTenantPreviewRequest(
      TENANT_A.handle,
      makePreviewRequest(`${APP_ORIGIN}/api/tenants/${TENANT_A.handle}/preview`, "POST", {
        cookie: tempUser.cookie,
        body: { resourceKind: "page", resourceId: 1, expectedVersion: 4 },
      }),
      runtimeEnv,
      { nowMs: Date.now() },
    );
    expect(retryAfterExpiry.status).toBe(401);
  });
});
