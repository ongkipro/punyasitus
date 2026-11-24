import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  applySessionTwoFactorMigration,
  createAuth,
  createTwoFactorEnrolledOperatorFixture,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
} from "@punyasitus/auth";
import { createLocalMailSink } from "@punyasitus/core/email/index";
import { ensureAbuseModerationSchema } from "@punyasitus/db/abuse/index";
import { createCatalogOffering } from "@punyasitus/db/catalog/index";
import {
  applyPlatformMigrations,
  applyTenantMigrations,
  createTenantDb,
  openTenantStoreStub,
  type StorageLike,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  applySharedDomainProtectionMigration,
  ContentScreeningError,
  ensureTenantContentScreeningHoldsSchema,
  getScreeningReviewById,
  listTenantOwnerHeldNotices,
  listTrustWatchRuns,
  MAX_OPEN_REVIEWS_PER_TENANT,
  OWNER_SAFE_TAKEDOWN_NOTICE,
  publishFormWithScreening,
  publishResourceWithScreening,
} from "@punyasitus/db/content-screening/index";
import { applyEmailClaimsMigration } from "@punyasitus/db/email/index";
import { createTenantForm } from "@punyasitus/db/forms/index";
import { saveSiteIdentityDraft } from "@punyasitus/db/identity/index";
import { createPage } from "@punyasitus/db/pages/index";
import {
  ensurePlatformOperatorRolesSchema,
  listPlatformAuditEntries,
  PLATFORM_MIGRATIONS,
} from "@punyasitus/db/platform";
import { createPost } from "@punyasitus/db/posts/index";
import { saveDraftResource } from "@punyasitus/db/publication/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePublicPageRoute } from "../../apps/web/src/core/public-routes.ts";
import {
  handleConsoleScreeningDecisionRequest,
  handleConsoleScreeningDetailRequest,
  handleConsoleScreeningListRequest,
  handleConsoleScreeningRulesRequest,
  handleConsoleTenantTakedownRequest,
  handleConsoleTrustWatchRequest,
} from "../../apps/web/src/pages/api/console/abuse/_screening-shared.ts";
import type { ConsoleAbuseRuntimeEnv } from "../../apps/web/src/pages/api/console/abuse/_shared.ts";
import { handleTenantCatalogOfferingPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/publish.ts";
import { handleTenantIdentityPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/identity/publish.ts";
import { handleTenantPagePublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/publish.ts";
import { handleTenantPostPublishRequest } from "../../apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/publish.ts";
import {
  runDailyTrustWatch,
  type DnsProbePort,
  type TrustPositifListPort,
} from "../../apps/web/src/worker/cron/trust-watch.ts";

const CONSOLE_ORIGIN = "https://console.punyasitus.com";
const APP_ORIGIN = "https://app.punyasitus.com";
const APP_SECRET = "task103-app-auth-secret-0123456789abcdef0123456789abcdef";
const CONSOLE_SECRET = "task103-console-auth-secret-fedcba9876543210fedcba987654";
const DAY_MS = 24 * 60 * 60 * 1000;

async function openMigratedTenantDb(tenantId: string): Promise<D1Database> {
  const ns = env.TENANT_STORE as unknown as TenantStoreNamespaceLike;
  const doId = env.TENANT_STORE.idFromName(tenantId);
  const rawDoStub = env.TENANT_STORE.get(doId);
  await runInDurableObject(rawDoStub, (_instance, state) =>
    applyTenantMigrations(state.storage as unknown as StorageLike, TENANT_MIGRATIONS),
  );
  const db = createTenantDb(openTenantStoreStub(ns, tenantId));
  await ensureTenantContentScreeningHoldsSchema(db);
  return db;
}

function buildConsoleEnv(extra?: Partial<ConsoleAbuseRuntimeEnv>): ConsoleAbuseRuntimeEnv {
  return {
    APP_ENV: "test",
    PLATFORM_DOMAIN: "punyasitus.com",
    SAAS_ZONE: "situsku.click",
    PLATFORM_DB: env.PLATFORM_DB,
    TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: APP_SECRET,
    CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
    ...extra,
  };
}

async function seedTenantWithOwner(params: {
  readonly tenantId: string;
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly status?: string;
  readonly offboardingStartedAt?: number | null;
  readonly nowMs: number;
}): Promise<D1Database> {
  const status = params.status ?? "active";
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, ?, ?)`,
    ).bind(params.ownerUserId, "Pemilik Uji", params.ownerEmail, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(params.orgId, params.name, params.handle, params.nowMs, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO members (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`mem_${params.tenantId}`, params.orgId, params.ownerUserId, params.nowMs),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenants (
         id, organization_id, handle, name, vertical, status, operator_hold,
         paid_through, offboarding_started_at, cache_version, schema_version, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'compro', ?, 0, ?, ?, 1, 1, 1, ?, ?)`,
    ).bind(
      params.tenantId,
      params.orgId,
      params.handle,
      params.name,
      status,
      params.nowMs + 30 * DAY_MS,
      params.offboardingStartedAt ?? null,
      params.nowMs,
      params.nowMs,
    ),
    env.PLATFORM_DB.prepare(
      `INSERT OR REPLACE INTO tenant_hosts (
         host, tenant_id, kind, status, ssl_status, is_primary, version, created_at, updated_at
       ) VALUES (?, ?, 'subdomain', 'active', 'active', 1, 1, ?, ?)`,
    ).bind(`${params.handle}.situsku.click`, params.tenantId, params.nowMs, params.nowMs),
  ]);

  return openMigratedTenantDb(params.tenantId);
}

async function seedDraftPage(
  tenantDb: D1Database,
  params: {
    readonly slug: string;
    readonly title: string;
    readonly isHomepage?: boolean;
    readonly sections: readonly Record<string, unknown>[];
    readonly nowMs: number;
  },
): Promise<number> {
  const res = await tenantDb
    .prepare(
      `INSERT INTO pages (
         slug, title, is_homepage, draft_sections_json, published_sections_json,
         status, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'draft', 1, ?, ?)`,
    )
    .bind(
      params.slug,
      params.title,
      params.isHomepage ? 1 : 0,
      JSON.stringify(params.sections),
      params.nowMs,
      params.nowMs,
    )
    .run();
  return Number(res.meta.last_row_id);
}

describe("TASK-103 workerd integration — Publish Screening Gate, Operator Release, Trust+ Watch & One-Click Takedown", () => {
  beforeAll(async () => {
    await applyPlatformMigrations(env.PLATFORM_DB, PLATFORM_MIGRATIONS);
    await applySessionTwoFactorMigration(env.PLATFORM_DB);
    await ensurePlatformOperatorRolesSchema(env.PLATFORM_DB);
    await ensureAbuseModerationSchema(env.PLATFORM_DB);
    await applyEmailClaimsMigration(env.PLATFORM_DB);
    await applySharedDomainProtectionMigration(env.PLATFORM_DB);
  });

  it("holds seeded gambling keywords, denylisted link hosts, hidden ALT text, and custom-form labels across dashboard and MCP while allowing clean content", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 8, 0, 0);
    const tenantId = "01J103SCREENINGTENANT00001";
    const tenantDb = await seedTenantWithOwner({
      tenantId,
      orgId: "org_t103_screen",
      handle: "toko-screen-103",
      name: "Toko Uji Screening",
      ownerUserId: "usr_t103_owner_1",
      ownerEmail: "owner-screen@toko103.example",
      nowMs,
    });

    // 1. Seeded gambling keyword via dashboard -> held as draft with generic owner notice (zero matched term!)
    const gamblingPageId = await seedDraftPage(tenantDb, {
      slug: "promo-gacor",
      title: "Daftar Slot Gacor Maxwin Resmi",
      sections: [
        {
          id: "s1",
          kind: "rich_text",
          heading: "Bonus Harian",
          subheading: null,
          bodyHtml: "<p>Bonus deposit setiap hari.</p>",
        },
      ],
      nowMs,
    });

    const gamblingOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: gamblingPageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_1",
      nowMs,
    });

    expect(gamblingOutcome.outcome).toBe("held_for_review");
    expect(gamblingOutcome.held).toBe(true);
    if (gamblingOutcome.outcome === "held_for_review") {
      expect(gamblingOutcome.deduplicated).toBe(false);

      // Re-submitting identical held draft deduplicates to the exact same reviewId!
      const dupOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
        tenantId,
        resourceType: "page",
        resourceId: gamblingPageId,
        expectedVersion: 1,
        publishSource: "dashboard",
        actorUserId: "usr_t103_owner_1",
        nowMs: nowMs + 500,
      });
      expect(dupOutcome.outcome).toBe("held_for_review");
      if (dupOutcome.outcome === "held_for_review") {
        expect(dupOutcome.deduplicated).toBe(true);
        expect(dupOutcome.reviewId).toBe(gamblingOutcome.reviewId);
      }

      expect(gamblingOutcome.ownerNotice.message).toBe("Konten ditahan untuk ditinjau");
      expect(gamblingOutcome.ownerNotice.status).toBe("draft");
      expect(gamblingOutcome.ownerNotice.reason).toBe("held_for_review");
      expect(JSON.stringify(gamblingOutcome.ownerNotice).toLowerCase()).not.toContain("slot gacor");

      const row = await tenantDb
        .prepare("SELECT status, published_sections_json FROM pages WHERE id = ?")
        .bind(gamblingPageId)
        .first<{ readonly status: string; readonly published_sections_json: string | null }>();
      expect(row?.status).toBe("draft");
      expect(row?.published_sections_json).toBeNull();

      const review = await getScreeningReviewById(env.PLATFORM_DB, gamblingOutcome.reviewId);
      expect(review?.status).toBe("held_for_review");
      expect(review?.publishSource).toBe("dashboard");
      expect(review?.matchedCategories).toContain("gambling");

      // Owner-side held notices in TenantStore contain ZERO matched terms
      const ownerHolds = await listTenantOwnerHeldNotices(tenantDb);
      expect(ownerHolds.length).toBeGreaterThanOrEqual(1);
      expect(ownerHolds[0]?.message).toBe("Konten ditahan untuk ditinjau");
      expect(JSON.stringify(ownerHolds).toLowerCase()).not.toContain("slot gacor");
    }

    // 2. Denylisted link host via MCP publish -> held as draft with publishSource = "mcp"
    const linkPageId = await seedDraftPage(tenantDb, {
      slug: "partner-kami",
      title: "Daftar Mitra Resmi",
      sections: [
        {
          id: "s2",
          kind: "cta",
          heading: "Mitra Resmi",
          subheading: null,
          bodyHtml: null,
          ctaLabel: "Buka Portal Mitra",
          ctaHref: "https://vip.slotgacor.example/register",
        },
      ],
      nowMs,
    });

    const mcpOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: linkPageId,
      expectedVersion: 1,
      publishSource: "mcp",
      actorUserId: "usr_t103_owner_1",
      nowMs: nowMs + 1000,
    });
    expect(mcpOutcome.outcome).toBe("held_for_review");
    if (mcpOutcome.outcome === "held_for_review") {
      const review = await getScreeningReviewById(env.PLATFORM_DB, mcpOutcome.reviewId);
      expect(review?.publishSource).toBe("mcp");
      expect(review?.matchedFields).toContain("link_host");
    }

    // 3. Hidden ALT text (via TenantStore.media_items alt_text referenced by extraMediaIds AND HTML <img alt>)
    const mediaRes = await tenantDb
      .prepare(
        `INSERT INTO media_items (kind, r2_key, mime_type, bytes, sha256, alt_text, status, created_at, updated_at)
         VALUES ('image', 't/test/banner.webp', 'image/webp', 1200, 'abcd1234', 'Promo judi online togel macau 2026', 'ready', ?, ?)`,
      )
      .bind(nowMs, nowMs)
      .run();
    const mediaId = Number(mediaRes.meta.last_row_id);

    const hiddenAltPageId = await seedDraftPage(tenantDb, {
      slug: "galeri-produk",
      title: "Galeri Produk Kayu Jati",
      sections: [
        {
          id: "s3",
          kind: "gallery",
          heading: "Galeri Produk",
          subheading: "Produk unggulan buatan pengrajin Jepara",
          bodyHtml: null,
        },
      ],
      nowMs,
    });

    const altOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: hiddenAltPageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_1",
      extraMediaIds: [mediaId],
      nowMs: nowMs + 2000,
    });
    expect(altOutcome.outcome).toBe("held_for_review");
    if (altOutcome.outcome === "held_for_review") {
      const review = await getScreeningReviewById(env.PLATFORM_DB, altOutcome.reviewId);
      expect(review?.matchedFields).toContain("image_alt");
    }

    // 4. Custom-form label match -> form remains inactive draft
    const createdForm = await createTenantForm(tenantDb, {
      payload: {
        name: "Formulir Verifikasi Pelanggan",
        slug: "verif-pelanggan",
        fields: [
          {
            key: "pin_verifikasi",
            type: "short_text",
            label: "Masukkan PIN ATM untuk pencairan hadiah",
            required: true,
          },
        ],
        submitLabel: "Kirim",
        afterSubmitAction: "text",
        afterSubmitConfig: { message: "Terima kasih" },
      },
      actorUserId: "usr_t103_owner_1",
      nowMs,
    });
    const formOutcome = await publishFormWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      formId: createdForm.id,
      expectedVersion: createdForm.version,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_1",
      nowMs: nowMs + 3000,
    });
    expect(formOutcome.outcome).toBe("held_for_review");

    // 5. Clean Indonesian SME page -> publishes atomically!
    const cleanPageId = await seedDraftPage(tenantDb, {
      slug: "tentang-kami",
      title: "Tentang Bengkel Las Karya Mandiri",
      isHomepage: true,
      sections: [
        {
          id: "s4",
          kind: "hero",
          heading: "Jasa Pagar Minimalis & Kanopi Surabaya",
          subheading: null,
          bodyHtml: "<p>Berpengalaman lebih dari 10 tahun melayani rumah tinggal dan ruko.</p>",
        },
      ],
      nowMs,
    });

    const cleanOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: cleanPageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_1",
      nowMs: nowMs + 4000,
    });
    expect(cleanOutcome.outcome).toBe("published");
    expect(cleanOutcome.held).toBe(false);
    if (cleanOutcome.outcome === "published") {
      expect(cleanOutcome.published.cacheVersion).toBeGreaterThanOrEqual(2);
    }
  });

  it("allows operator release of a held false positive with 2FA step-up + audit, rejects non-console hosts & tampered snapshots, and supports custom rules", async () => {
    const nowMs = Date.UTC(2026, 10, 23, 9, 0, 0);
    const consoleEnv = buildConsoleEnv();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });

    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-t103-release@punyasitus.com",
      password: "Task103OpPassword!234",
      name: "Operator Keamanan 103",
      nowMs,
    });

    const tenantId = "01J103RELEASETENANT0000002";
    const tenantDb = await seedTenantWithOwner({
      tenantId,
      orgId: "org_t103_release",
      handle: "toko-release-103",
      name: "Toko Uji Rilis",
      ownerUserId: "usr_t103_owner_2",
      ownerEmail: "owner-release@toko103.example",
      nowMs,
    });

    // Non-console host MUST receive bare neutral 404
    const nonConsoleRes = await handleConsoleScreeningListRequest(
      new Request(`${APP_ORIGIN}/api/console/abuse/screening`, { method: "GET" }),
      consoleEnv,
      { nowMs },
    );
    expect(nonConsoleRes.status).toBe(404);
    expect(nonConsoleRes.headers.get("content-type")).toContain("text/plain");
    expect(await nonConsoleRes.text()).toBe("Not Found");

    // Hold a false-positive page (mentions "judol" inside an educational cyber-safety post)
    const fpPageId = await seedDraftPage(tenantDb, {
      slug: "edukasi-anti-judol",
      title: "Tips Edukasi Mencegah Bahaya Judol untuk Remaja",
      sections: [
        {
          id: "fp1",
          kind: "rich_text",
          heading: "Edukasi Sekolah",
          subheading: null,
          bodyHtml:
            "<p>Artikel penyuluhan sekolah untuk mengenali dan menghindari bahaya judol sejak dini.</p>",
        },
      ],
      nowMs,
    });

    const held = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: fpPageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_2",
      nowMs,
    });
    expect(held.outcome).toBe("held_for_review");
    if (held.outcome !== "held_for_review") throw new Error("Expected held_for_review");

    // Console list & detail return the held review
    const listRes = await handleConsoleScreeningListRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/screening?status=held_for_review`, {
        method: "GET",
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs },
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { items: { id: string }[] };
    expect(listJson.items.some((i) => i.id === held.reviewId)).toBe(true);

    const detailRes = await handleConsoleScreeningDetailRequest(
      held.reviewId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/screening/${held.reviewId}`, {
        method: "GET",
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs },
    );
    expect(detailRes.status).toBe(200);

    // Stale 2FA (>10 minutes elapsed) MUST be blocked with 403 REAUTH_REQUIRED
    const staleRes = await handleConsoleScreeningDecisionRequest(
      held.reviewId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/screening/${held.reviewId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          decision: "release",
          reason: "Artikel edukasi sekolah aman untuk dipublikasikan.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs: nowMs + DEFAULT_SECOND_FACTOR_WINDOW_MS + 60_000 },
    );
    expect(staleRes.status).toBe(403);

    // Fresh 2FA operator releases false positive -> publishes page atomically & writes platform_audit!
    const releaseRes = await handleConsoleScreeningDecisionRequest(
      held.reviewId,
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/screening/${held.reviewId}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
          "Idempotency-Key": "release-fp-1",
        },
        body: JSON.stringify({
          decision: "release",
          reason: "False positive terverifikasi: artikel edukasi pencegahan untuk sekolah.",
          expectedVersion: 1,
        }),
      }),
      consoleEnv,
      { nowMs, resolveTenantDb: () => tenantDb },
    );
    expect(releaseRes.status).toBe(200);
    const releaseJson = (await releaseRes.json()) as {
      review: { status: string };
      auditId: string;
      publishedVersion: number;
    };
    expect(releaseJson.review.status).toBe("released");
    expect(releaseJson.auditId).toBeTruthy();
    expect(releaseJson.publishedVersion).toBe(2);

    // Verify page is NOW published in TenantStore!
    const pageRow = await tenantDb
      .prepare("SELECT status, published_sections_json FROM pages WHERE id = ?")
      .bind(fpPageId)
      .first<{ readonly status: string; readonly published_sections_json: string | null }>();
    expect(pageRow?.status).toBe("published");
    expect(pageRow?.published_sections_json).not.toBeNull();

    // Verify immutable platform_audit entry exists
    const audits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.content_screening.release",
      tenantId,
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Verify operator-added custom domain rule immediately blocks subsequent publish
    const addRuleRes = await handleConsoleScreeningRulesRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/rules`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          ruleType: "domain",
          pattern: "judol-kustom-103.example",
          category: "gambling",
          severity: "high",
          reason: "Domain afiliasi judi baru ditemukan pada laporan harian.",
        }),
      }),
      consoleEnv,
      { nowMs },
    );
    expect(addRuleRes.status).toBe(201);

    const customRulePageId = await seedDraftPage(tenantDb, {
      slug: "promo-kustom",
      title: "Promo Eksklusif",
      sections: [
        {
          id: "c1",
          kind: "cta",
          heading: "Promo",
          subheading: null,
          bodyHtml: null,
          ctaLabel: "Gabung",
          ctaHref: "https://judol-kustom-103.example/join",
        },
      ],
      nowMs,
    });
    const customRuleOutcome = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: customRulePageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_2",
      nowMs: nowMs + 1000,
    });
    expect(customRuleOutcome.outcome).toBe("held_for_review");

    // Verify tampered draft after hold cannot sneak through operator release (409 SNAPSHOT_MISMATCH)
    if (customRuleOutcome.outcome === "held_for_review") {
      // First verify cross-review Idempotency-Key reuse on same tenant returns 409 IDEMPOTENCY_CONFLICT (never 500!)
      const crossIdempRes = await handleConsoleScreeningDecisionRequest(
        customRuleOutcome.reviewId,
        new Request(
          `${CONSOLE_ORIGIN}/api/console/abuse/screening/${customRuleOutcome.reviewId}/decision`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: CONSOLE_ORIGIN,
              Cookie: operator.cookieHeader,
              "Idempotency-Key": "release-fp-1",
            },
            body: JSON.stringify({
              decision: "reject",
              reason: "Mencoba memakai ulang Idempotency-Key dari review lain di tenant sama.",
              expectedVersion: 1,
            }),
          },
        ),
        consoleEnv,
        { nowMs: nowMs + 1200, resolveTenantDb: () => tenantDb },
      );
      expect(crossIdempRes.status).toBe(409);
      const crossIdempJson = (await crossIdempRes.json()) as { error?: { code?: string } };
      expect(crossIdempJson.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      await saveDraftResource(tenantDb, {
        resourceType: "page",
        resourceId: customRulePageId,
        expectedVersion: 1,
        draft: {
          slug: "promo-kustom",
          title: "Promo Diubah Diam-Diam",
          isHomepage: false,
          layoutMode: "standard",
          sections: [
            {
              id: "c1",
              kind: "rich_text",
              heading: "Diubah",
              subheading: null,
              bodyHtml: "<p>Diubah setelah ditahan</p>",
            },
          ],
        },
        nowMs: nowMs + 1500,
      });

      const mismatchRes = await handleConsoleScreeningDecisionRequest(
        customRuleOutcome.reviewId,
        new Request(
          `${CONSOLE_ORIGIN}/api/console/abuse/screening/${customRuleOutcome.reviewId}/decision`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: CONSOLE_ORIGIN,
              Cookie: operator.cookieHeader,
            },
            body: JSON.stringify({
              decision: "release",
              reason: "Mencoba merilis konten yang sudah berubah sejak ditahan.",
              expectedVersion: 1,
            }),
          },
        ),
        consoleEnv,
        { nowMs: nowMs + 2000, resolveTenantDb: () => tenantDb },
      );
      expect(mismatchRes.status).toBe(409);
    }
  });

  it("runs daily Trust+ watch with mockable ports (zero live network): flags fixture IP hit, deduplicates alerts to <=1/day, and returns unknown (never clean) on list or DNS failure", async () => {
    const day1MorningMs = Date.UTC(2026, 10, 24, 1, 0, 0); // 2026-11-24 08:00 WIB
    const day1EveningMs = Date.UTC(2026, 10, 24, 10, 0, 0); // 2026-11-24 17:00 WIB
    const day2MorningMs = Date.UTC(2026, 10, 25, 1, 0, 0); // 2026-11-25 08:00 WIB

    const flaggedIp = "198.51.100.77";
    const cleanIp = "203.0.113.10";
    const alertsReceived: string[] = [];

    const hitListPort: TrustPositifListPort = {
      async fetchIpList() {
        return { ok: true, ips: new Set([flaggedIp, "198.51.100.88"]) };
      },
    };
    const hitDnsPort: DnsProbePort = {
      async resolveIpv4(host) {
        if (host === "cname.situsku.click" || host === "situsku.click") {
          return { ok: true, ips: [flaggedIp] };
        }
        return { ok: true, ips: [cleanIp] };
      },
    };

    // 1. First run on Day 1 -> HIT + alert sent ONCE
    const run1 = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: hitDnsPort,
        emailPort: createLocalMailSink(),
        alertRecipients: ["ops-alert@punyasitus.com"],
        onAlert: (alert) => {
          alertsReceived.push(alert.messageKey);
        },
        nowMs: day1MorningMs,
        logger: () => {},
      },
    );
    expect(run1.status).toBe("hit");
    expect(run1.hits.some((h) => h.host === "cname.situsku.click" && h.ip === flaggedIp)).toBe(
      true,
    );
    expect(run1.alertSent).toBe(true);
    expect(run1.alertDeduplicated).toBe(false);
    expect(alertsReceived).toHaveLength(1);

    // 2. Second run on the SAME WIB day -> HIT still logged, alert deduplicated (at most 1/day!)
    const run2 = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: hitDnsPort,
        alertRecipients: ["ops-alert@punyasitus.com"],
        onAlert: (alert) => {
          alertsReceived.push(alert.messageKey);
        },
        nowMs: day1EveningMs,
        logger: () => {},
      },
    );
    expect(run2.status).toBe("hit");
    expect(run2.alertSent).toBe(false);
    expect(run2.alertDeduplicated).toBe(true);
    expect(alertsReceived).toHaveLength(1);

    // 3. List fetch failure -> MUST return "unknown" (NEVER "clean") and send ZERO alert
    const failingListPort: TrustPositifListPort = {
      async fetchIpList() {
        return { ok: false, errorCode: "TRUST_LIST_HTTP_503", message: "Upstream 503" };
      },
    };
    const runListFail = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: failingListPort,
        dnsPort: hitDnsPort,
        nowMs: day2MorningMs,
        logger: () => {},
      },
    );
    expect(runListFail.status).toBe("unknown");
    expect(runListFail.alertSent).toBe(false);
    expect(runListFail.run.errorCode).toBe("TRUST_LIST_HTTP_503");

    // 4. DNS failure on any target host -> MUST return "unknown" (NEVER "clean")
    const failingDnsPort: DnsProbePort = {
      async resolveIpv4(host) {
        if (host === "cname.situsku.click") {
          return { ok: false, errorCode: "DOH_TIMEOUT", message: "DoH timeout" };
        }
        return { ok: true, ips: [cleanIp] };
      },
    };
    const runDnsFail = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: failingDnsPort,
        nowMs: day2MorningMs + 60_000,
        logger: () => {},
      },
    );
    expect(runDnsFail.status).toBe("unknown");
    expect(runDnsFail.failures.some((f) => f.host === "cname.situsku.click")).toBe(true);

    // 5. All hosts resolve cleanly with zero hits -> "clean"
    const cleanDnsPort: DnsProbePort = {
      async resolveIpv4() {
        return { ok: true, ips: [cleanIp] };
      },
    };
    const runClean = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: cleanDnsPort,
        nowMs: day2MorningMs + 120_000,
        logger: () => {},
      },
    );
    expect(runClean.status).toBe("clean");
    expect(runClean.hits).toEqual([]);
    expect(runClean.failures).toEqual([]);

    const persistedRuns = await listTrustWatchRuns(env.PLATFORM_DB, 10);
    expect(persistedRuns.length).toBeGreaterThanOrEqual(5);

    // 6. Alert delivery failure on Day 3 MUST release daily claim slot so next run retries!
    const day3Ms = Date.UTC(2026, 10, 26, 1, 0, 0);
    const failedDeliveryRun = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: hitDnsPort,
        emailPort: null,
        jobsQueue: null,
        onAlert: () => {
          throw new Error("Simulated transient alert transport outage");
        },
        nowMs: day3Ms,
        logger: () => {},
      },
    );
    expect(failedDeliveryRun.status).toBe("hit");
    expect(failedDeliveryRun.alertSent).toBe(false);
    expect(failedDeliveryRun.alertDeduplicated).toBe(false);

    const retrySink = createLocalMailSink();
    const retryRun = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: hitDnsPort,
        emailPort: retrySink,
        alertRecipients: ["ops-retry@punyasitus.com"],
        nowMs: day3Ms + 60_000,
        logger: () => {},
      },
    );
    expect(retryRun.status).toBe("hit");
    expect(retryRun.alertSent).toBe(true);
    expect(retryRun.alertDeduplicated).toBe(false);
    expect(retrySink.list().length).toBe(1);

    // 7. Exceeding active tenant host scan cap MUST report "unknown" (never "clean")!
    const cappedRun = await runDailyTrustWatch(
      { PLATFORM_DB: env.PLATFORM_DB, SAAS_ZONE: "situsku.click" },
      {
        listPort: hitListPort,
        dnsPort: cleanDnsPort,
        maxTenantHosts: 1,
        nowMs: day3Ms + 120_000,
        logger: () => {},
      },
    );
    expect(cappedRun.hostsCapped).toBe(true);
    expect(cappedRun.status).toBe("unknown");
    expect(cappedRun.run.errorCode).toBe("TENANT_HOSTS_CAP_EXCEEDED");
  });

  it('executes one-click "Turunkan situs" atomically with audit so the next public request immediately returns the 503 suspended page', async () => {
    const nowMs = Date.UTC(2026, 10, 23, 11, 0, 0);
    const mailSink = createLocalMailSink();
    const consoleEnv = buildConsoleEnv();
    const consoleAuth = createAuth(env.PLATFORM_DB, {
      baseURL: CONSOLE_ORIGIN,
      secret: CONSOLE_SECRET,
      surface: "console",
      trustedOrigins: [CONSOLE_ORIGIN],
    });

    const operator = await createTwoFactorEnrolledOperatorFixture(env.PLATFORM_DB, {
      auth: consoleAuth,
      email: "op-t103-takedown@punyasitus.com",
      password: "Task103TakedownPassword!234",
      name: "Operator Takedown 103",
      nowMs,
    });

    const tenantId = "01J103TAKEDOWNTENANT000003";
    const handle = "situs-takedown-103";
    const tenantDb = await seedTenantWithOwner({
      tenantId,
      orgId: "org_t103_takedown",
      handle,
      name: "Situs Uji Takedown",
      ownerUserId: "usr_t103_owner_3",
      ownerEmail: "owner-takedown@toko103.example",
      nowMs,
    });

    // Publish homepage so public site is live before takedown
    const homeId = await seedDraftPage(tenantDb, {
      slug: "beranda",
      title: "Beranda Situs Uji",
      isHomepage: true,
      sections: [
        {
          id: "h1",
          kind: "hero",
          heading: "Selamat Datang",
          subheading: null,
          bodyHtml: "<p>Situs resmi bisnis lokal.</p>",
        },
      ],
      nowMs,
    });
    const pub = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: homeId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_3",
      nowMs,
    });
    expect(pub.outcome).toBe("published");

    // Verify public site serves BEFORE takedown (populates host cache too!)
    const publicDeps = {
      platformDb: env.PLATFORM_DB,
      tenantStore: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      saasZone: "situsku.click",
      appEnv: "test",
    };
    const beforePublic = await resolvePublicPageRoute(
      new Request(`https://${handle}.situsku.click/`, { method: "GET" }),
      publicDeps,
      "",
    );
    expect(beforePublic.kind).toBe("page");

    // Execute one-click "Turunkan situs" (homepage publish bumped tenants.version from 1 -> 2)
    const takedownRes = await handleConsoleTenantTakedownRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/takedown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
          "Idempotency-Key": "tkd-103-once",
        },
        body: JSON.stringify({
          tenantId,
          expectedTenantVersion: 2,
          reason: "Situs memuat promosi judi online melanggar kebijakan Trust+ Komdigi.",
        }),
      }),
      consoleEnv,
      { nowMs, emailPort: mailSink, resolveTenantDb: () => tenantDb },
    );
    expect(takedownRes.status).toBe(200);
    const takedownJson = (await takedownRes.json()) as {
      nextStatus: string;
      auditId: string;
      cacheVersion: number;
      replayed: boolean;
    };
    expect(takedownJson.nextStatus).toBe("suspended");
    expect(takedownJson.auditId).toBeTruthy();
    expect(takedownJson.replayed).toBe(false);

    // Replay with same Idempotency-Key returns 200 replayed: true
    const replayRes = await handleConsoleTenantTakedownRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/takedown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
          "Idempotency-Key": "tkd-103-once",
        },
        body: JSON.stringify({
          tenantId,
          expectedTenantVersion: 2,
          reason: "Situs memuat promosi judi online melanggar kebijakan Trust+ Komdigi.",
        }),
      }),
      consoleEnv,
      { nowMs, emailPort: mailSink, resolveTenantDb: () => tenantDb },
    );
    expect(replayRes.status).toBe(200);
    expect(((await replayRes.json()) as { replayed: boolean }).replayed).toBe(true);

    // Immediately next public request MUST return the suspended page (HTTP 503, no-store, noindex)!
    const afterPublic = await resolvePublicPageRoute(
      new Request(`https://${handle}.situsku.click/`, { method: "GET" }),
      publicDeps,
      "",
    );
    expect(afterPublic.kind).toBe("response");
    if (afterPublic.kind === "response") {
      expect(afterPublic.response.status).toBe(503);
      expect(afterPublic.response.headers.get("cache-control")).toContain("no-store");
      expect(afterPublic.response.headers.get("x-robots-tag")).toContain("noindex");
    }

    // Verify platform_audit recorded console.tenant.takedown with internal reason,
    // while owner email & tenants.operator_hold_reason received ONLY generic OWNER_SAFE_TAKEDOWN_NOTICE!
    const takedownAudits = await listPlatformAuditEntries(env.PLATFORM_DB, {
      action: "console.tenant.takedown",
      tenantId,
    });
    expect(takedownAudits.length).toBeGreaterThanOrEqual(1);

    const suspendedTenantRow = await env.PLATFORM_DB.prepare(
      "SELECT operator_hold_reason FROM tenants WHERE id = ? LIMIT 1",
    )
      .bind(tenantId)
      .first<{ readonly operator_hold_reason: string | null }>();
    expect(suspendedTenantRow?.operator_hold_reason).toBe(OWNER_SAFE_TAKEDOWN_NOTICE);
    expect(suspendedTenantRow?.operator_hold_reason).not.toContain("Trust+ Komdigi");
    const sentEmails = mailSink.list();
    expect(sentEmails.length).toBeGreaterThanOrEqual(1);
    expect(sentEmails[0]?.text).toContain(OWNER_SAFE_TAKEDOWN_NOTICE);
    expect(sentEmails[0]?.text).not.toContain("Trust+ Komdigi");

    // Verify cross-tenant reviewId rejection & required reviewExpectedVersion on takedown
    const tenantBId = "01J103XREVIEWTENANT000005";
    const tenantBDb = await seedTenantWithOwner({
      tenantId: tenantBId,
      orgId: "org_t103_xreview",
      handle: "situs-xreview-103",
      name: "Situs Uji Cross Review",
      ownerUserId: "usr_t103_owner_5",
      ownerEmail: "owner-xrev@toko103.example",
      nowMs,
    });
    const xPageId = await seedDraftPage(tenantBDb, {
      slug: "draft-override-hold",
      title: "Halaman Bersih Awal",
      sections: [
        {
          id: "x1",
          kind: "rich_text",
          heading: "Awal",
          subheading: null,
          bodyHtml: "<p>Konten awal</p>",
        },
      ],
      nowMs,
    });
    // Hold via draftOverride (Finding #10) so operator release can verify persisted held_snapshot_json!
    const overrideHeld = await publishResourceWithScreening(env.PLATFORM_DB, tenantBDb, {
      tenantId: tenantBId,
      resourceType: "page",
      resourceId: xPageId,
      expectedVersion: 1,
      publishSource: "mcp",
      draftOverride: {
        slug: "draft-override-hold",
        title: "Edukasi Anti Judol di Sekolah",
        isHomepage: false,
        layoutMode: "standard",
        sections: [
          {
            id: "x1",
            kind: "rich_text",
            heading: "Edukasi",
            subheading: null,
            bodyHtml: "<p>Materi edukasi anti judol untuk siswa.</p>",
          },
        ],
      },
      actorUserId: "usr_t103_owner_5",
      nowMs,
    });
    expect(overrideHeld.outcome).toBe("held_for_review");
    if (overrideHeld.outcome !== "held_for_review") throw new Error("Expected held_for_review");

    // Missing reviewExpectedVersion with reviewId -> 422 VALIDATION_ERROR
    const missingRevVerRes = await handleConsoleTenantTakedownRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/takedown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          tenantId: tenantBId,
          expectedTenantVersion: 1,
          reviewId: overrideHeld.reviewId,
          reason: "Pengujian wajib reviewExpectedVersion saat menyertakan reviewId.",
        }),
      }),
      consoleEnv,
      { nowMs },
    );
    expect(missingRevVerRes.status).toBe(422);

    // Cross-tenant reviewId (trying to close tenantB's review while taking down another tenant) -> 409!
    const tenantCId = "01J103CTENANT000000000006";
    await seedTenantWithOwner({
      tenantId: tenantCId,
      orgId: "org_t103_c",
      handle: "situs-c-103",
      name: "Situs C",
      ownerUserId: "usr_t103_owner_6",
      ownerEmail: "owner-c@toko103.example",
      nowMs,
    });
    const crossTenantRes = await handleConsoleTenantTakedownRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/takedown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          tenantId: tenantCId,
          expectedTenantVersion: 1,
          reviewId: overrideHeld.reviewId,
          reviewExpectedVersion: 1,
          reason: "Pengujian blokir lintas tenant antara tenantId dan reviewId.",
        }),
      }),
      consoleEnv,
      { nowMs },
    );
    expect(crossTenantRes.status).toBe(409);

    // Operator releases the draftOverride held review -> succeeds & publishes held override snapshot!
    const overrideReleaseRes = await handleConsoleScreeningDecisionRequest(
      overrideHeld.reviewId,
      new Request(
        `${CONSOLE_ORIGIN}/api/console/abuse/screening/${overrideHeld.reviewId}/decision`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: CONSOLE_ORIGIN,
            Cookie: operator.cookieHeader,
          },
          body: JSON.stringify({
            decision: "release",
            reason: "Materi edukasi sekolah via draftOverride aman untuk dirilis.",
            expectedVersion: 1,
          }),
        },
      ),
      consoleEnv,
      { nowMs, resolveTenantDb: () => tenantBDb },
    );
    expect(overrideReleaseRes.status).toBe(200);
    const releasedOverrideRow = await tenantBDb
      .prepare("SELECT status, title FROM pages WHERE id = ?")
      .bind(xPageId)
      .first<{ readonly status: string; readonly title: string }>();
    expect(releasedOverrideRow?.status).toBe("published");
    expect(releasedOverrideRow?.title).toBe("Edukasi Anti Judol di Sekolah");

    // Release lifecycle guard (Finding #9): suspended tenant review cannot be released (409 TENANT_NOT_ELIGIBLE)
    const suspPageId = await seedDraftPage(tenantDb, {
      slug: "hal-suspended-tenant",
      title: "Promo Slot Gacor Pada Situs Ditangguhkan",
      sections: [
        {
          id: "sp1",
          kind: "rich_text",
          heading: "Uji",
          subheading: null,
          bodyHtml: "<p>Slot gacor</p>",
        },
      ],
      nowMs,
    });
    const suspHeld = await publishResourceWithScreening(env.PLATFORM_DB, tenantDb, {
      tenantId,
      resourceType: "page",
      resourceId: suspPageId,
      expectedVersion: 1,
      publishSource: "dashboard",
      actorUserId: "usr_t103_owner_3",
      nowMs,
    });
    expect(suspHeld.outcome).toBe("held_for_review");
    if (suspHeld.outcome === "held_for_review") {
      const blockedRelease = await handleConsoleScreeningDecisionRequest(
        suspHeld.reviewId,
        new Request(
          `${CONSOLE_ORIGIN}/api/console/abuse/screening/${suspHeld.reviewId}/decision`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: CONSOLE_ORIGIN,
              Cookie: operator.cookieHeader,
            },
            body: JSON.stringify({
              decision: "release",
              reason: "Mencoba merilis konten pada situs yang sudah suspended.",
              expectedVersion: 1,
            }),
          },
        ),
        consoleEnv,
        { nowMs, resolveTenantDb: () => tenantDb },
      );
      expect(blockedRelease.status).toBe(409);
    }

    // Per-tenant open held review cap (Finding #11): 50 open rows -> 51st throws 429 TOO_MANY_PENDING_REVIEWS
    const floodTenantId = "01J103FLOODTENANT00000007";
    const floodTenantDb = await seedTenantWithOwner({
      tenantId: floodTenantId,
      orgId: "org_t103_flood",
      handle: "situs-flood-103",
      name: "Situs Flood Cap",
      ownerUserId: "usr_t103_owner_7",
      ownerEmail: "owner-flood@toko103.example",
      nowMs,
    });
    const floodStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < MAX_OPEN_REVIEWS_PER_TENANT; i += 1) {
      floodStmts.push(
        env.PLATFORM_DB.prepare(
          `INSERT INTO content_screening_reviews (
             id, tenant_id, resource_type, resource_id, resource_slug, resource_title,
             publish_source, expected_version, status, match_count,
             matched_categories_json, matched_fields_json, findings_json,
             content_sha256, ruleset_version, version, created_at, updated_at
           ) VALUES (?, ?, 'page', ?, 'slug', 'Judul', 'dashboard', 1, 'held_for_review', 1,
             '["gambling"]', '["title"]', '[]', ?, 1, 1, ?, ?)`,
        ).bind(
          `01J103FL${String(i).padStart(18, "0")}`,
          floodTenantId,
          String(i + 1),
          `hash_${i}`,
          nowMs + i,
          nowMs + i,
        ),
      );
    }
    await env.PLATFORM_DB.batch(floodStmts);

    const overflowPageId = await seedDraftPage(floodTenantDb, {
      slug: "overflow-51",
      title: "Promo Slot Gacor ke-51",
      sections: [
        {
          id: "ov1",
          kind: "rich_text",
          heading: "Overflow",
          subheading: null,
          bodyHtml: "<p>Slot gacor</p>",
        },
      ],
      nowMs,
    });
    let floodErr: unknown = null;
    try {
      await publishResourceWithScreening(env.PLATFORM_DB, floodTenantDb, {
        tenantId: floodTenantId,
        resourceType: "page",
        resourceId: overflowPageId,
        expectedVersion: 1,
        publishSource: "dashboard",
        actorUserId: "usr_t103_owner_7",
        nowMs,
      });
    } catch (err) {
      floodErr = err;
    }
    expect(floodErr).toBeInstanceOf(ContentScreeningError);
    expect((floodErr as ContentScreeningError).status).toBe(429);
    expect((floodErr as ContentScreeningError).code).toBe("TOO_MANY_PENDING_REVIEWS");

    // Verify Trust+ Watch Console API returns runs + standby fallback zone metadata
    const trustApiRes = await handleConsoleTrustWatchRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/trust-watch`, {
        method: "GET",
        headers: { Cookie: operator.cookieHeader },
      }),
      consoleEnv,
      { nowMs },
    );
    expect(trustApiRes.status).toBe(200);
    const trustJson = (await trustApiRes.json()) as {
      zones: { standbyFallback: { zone: string; automaticFailover: boolean } };
    };
    expect(trustJson.zones.standbyFallback.zone).toBe("situsku.my.id");
    expect(trustJson.zones.standbyFallback.automaticFailover).toBe(false);

    // Ineligible tenant (offboarding in progress) returns 409 TENANT_NOT_ELIGIBLE
    const offboardingTenantId = "01J103OFFBOARDTENANT000004";
    await seedTenantWithOwner({
      tenantId: offboardingTenantId,
      orgId: "org_t103_offboard",
      handle: "situs-offboard-103",
      name: "Situs Offboarding",
      ownerUserId: "usr_t103_owner_4",
      ownerEmail: "owner-offboard@toko103.example",
      status: "suspended",
      offboardingStartedAt: nowMs - 10_000,
      nowMs,
    });
    const ineligibleRes = await handleConsoleTenantTakedownRequest(
      new Request(`${CONSOLE_ORIGIN}/api/console/abuse/takedown`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: CONSOLE_ORIGIN,
          Cookie: operator.cookieHeader,
        },
        body: JSON.stringify({
          tenantId: offboardingTenantId,
          expectedTenantVersion: 1,
          reason: "Mencoba menurunkan situs yang sedang dalam proses penghapusan.",
        }),
      }),
      consoleEnv,
      { nowMs },
    );
    expect(ineligibleRes.status).toBe(409);
  });

  it("SEC-001 / M1-FU-03: enforces publishResourceWithScreening on all 4 direct dashboard publish endpoints (pages, posts, catalog, identity)", async () => {
    const nowMs = Date.UTC(2026, 10, 24, 5, 0, 0);
    const tenantId = "01J103DRECTP0BTENANT000008";
    const ownerUserId = "usr_t103_owner_8";
    const tenantDb = await seedTenantWithOwner({
      tenantId,
      orgId: "org_t103_direct_pub",
      handle: "toko-direct-pub-103",
      name: "Toko Direct Publish Screening",
      ownerUserId,
      ownerEmail: "owner-direct-pub@toko103.example",
      nowMs,
    });

    const sentIndexNowMessages: unknown[] = [];
    const runtimeEnv = {
      APP_ENV: "test",
      PLATFORM_DOMAIN: "punyasitus.com",
      SAAS_ZONE: "situsku.click",
      PLATFORM_DB: env.PLATFORM_DB,
      TENANT_STORE: env.TENANT_STORE as unknown as TenantStoreNamespaceLike,
      AUTH_SECRET: APP_SECRET,
      CONSOLE_AUTH_SECRET: CONSOLE_SECRET,
      JOBS_QUEUE: {
        async send(msg: unknown) {
          sentIndexNowMessages.push(msg);
        },
      },
    };

    const makeDashboardPublishReq = (pathname: string, body: Record<string, unknown>) =>
      new Request(`${APP_ORIGIN}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: APP_ORIGIN,
        },
        body: JSON.stringify(body),
      });

    const readCacheVersion = async (): Promise<number> => {
      const row = await env.PLATFORM_DB.prepare("SELECT cache_version FROM tenants WHERE id = ?")
        .bind(tenantId)
        .first<{ readonly cache_version: number }>();
      return Number(row?.cache_version ?? 0);
    };

    // ------------------------------------------------------------------
    // 1. Pages direct dashboard publish: flagged -> 202 held_for_review, clean -> 200 published
    // ------------------------------------------------------------------
    const badPage = await createPage(tenantDb, {
      title: "Promo Slot Gacor Maxwin Hari Ini",
      slug: "promo-slot-gacor-direct",
      isHomepage: false,
      nowMs,
    });
    const cacheBeforeBadPage = await readCacheVersion();
    const badPageRes = await handleTenantPagePublishRequest(
      tenantId,
      String(badPage.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/pages/${badPage.id}/publish`, {
        version: badPage.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 100 },
    );
    expect(badPageRes.status).toBe(202);
    expect(badPageRes.headers.get("cache-control")).toContain("no-store");
    const badPageBody = (await badPageRes.json()) as {
      outcome: string;
      held: boolean;
      status: string;
      reason: string;
      reviewId: string;
      message: string;
      ownerNotice: { held: boolean; status: string; reason: string; reviewId: string; message: string };
    };
    expect(badPageBody.outcome).toBe("held_for_review");
    expect(badPageBody.held).toBe(true);
    expect(badPageBody.status).toBe("draft");
    expect(badPageBody.message).toBe("Konten ditahan untuk ditinjau");
    expect(badPageBody.ownerNotice.reviewId).toBe(badPageBody.reviewId);
    // Zero keyword leakage to tenant owner!
    expect(JSON.stringify(badPageBody).toLowerCase()).not.toContain("slot gacor");
    expect(JSON.stringify(badPageBody).toLowerCase()).not.toContain("maxwin");
    expect(await readCacheVersion()).toBe(cacheBeforeBadPage);
    expect(sentIndexNowMessages.length).toBe(0);

    const badPageRow = await tenantDb
      .prepare("SELECT status, published_sections_json FROM pages WHERE id = ?")
      .bind(badPage.id)
      .first<{ readonly status: string; readonly published_sections_json: string | null }>();
    expect(badPageRow?.status).toBe("draft");
    expect(badPageRow?.published_sections_json).toBeNull();

    const badPageReview = await getScreeningReviewById(env.PLATFORM_DB, badPageBody.reviewId);
    expect(badPageReview?.publishSource).toBe("dashboard");
    expect(badPageReview?.resourceType).toBe("page");
    expect(badPageReview?.status).toBe("held_for_review");

    const cleanPage = await createPage(tenantDb, {
      title: "Tentang Bengkel Nusantara",
      slug: "tentang-bengkel",
      isHomepage: false,
      nowMs: nowMs + 200,
    });
    const cleanPageRes = await handleTenantPagePublishRequest(
      tenantId,
      String(cleanPage.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/pages/${cleanPage.id}/publish`, {
        version: cleanPage.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 300 },
    );
    expect(cleanPageRes.status).toBe(200);
    const cleanPageJson = (await cleanPageRes.json()) as {
      status: string;
      cacheVersion: number;
      revisionNumber: number;
    };
    expect(cleanPageJson.status).toBe("published");
    expect(cleanPageJson.cacheVersion).toBe(cacheBeforeBadPage + 1);
    expect(cleanPageJson.revisionNumber).toBe(1);

    // ------------------------------------------------------------------
    // 2. Posts direct dashboard publish: flagged -> 202 held_for_review, clean -> 200 published
    // ------------------------------------------------------------------
    const badPost = await createPost(tenantDb, {
      title: "Panduan Bisnis Harian",
      slug: "panduan-bisnis-judol",
      body: {
        schemaVersion: 1,
        blocks: [
          {
            type: "paragraph",
            text: "Kunjungi situs judi online terpercaya https://slotgacor88.xyz sekarang juga.",
          },
        ],
      },
      nowMs: nowMs + 400,
    });
    const cacheBeforeBadPost = await readCacheVersion();
    const sentBeforeBadPost = sentIndexNowMessages.length;
    const badPostRes = await handleTenantPostPublishRequest(
      tenantId,
      String(badPost.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/posts/${badPost.id}/publish`, {
        version: badPost.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 500 },
    );
    expect(badPostRes.status).toBe(202);
    expect(badPostRes.headers.get("cache-control")).toContain("no-store");
    const badPostBody = (await badPostRes.json()) as {
      outcome: string;
      held: boolean;
      status: string;
      reviewId: string;
      message: string;
    };
    expect(badPostBody.outcome).toBe("held_for_review");
    expect(badPostBody.held).toBe(true);
    expect(badPostBody.status).toBe("draft");
    expect(badPostBody.message).toBe("Konten ditahan untuk ditinjau");
    expect(JSON.stringify(badPostBody).toLowerCase()).not.toContain("judi online");
    expect(JSON.stringify(badPostBody).toLowerCase()).not.toContain("slotgacor88");
    expect(await readCacheVersion()).toBe(cacheBeforeBadPost);
    expect(sentIndexNowMessages.length).toBe(sentBeforeBadPost);

    const badPostRow = await tenantDb
      .prepare("SELECT status, published_body_json FROM posts WHERE id = ?")
      .bind(badPost.id)
      .first<{ readonly status: string; readonly published_body_json: string | null }>();
    expect(badPostRow?.status).toBe("draft");
    expect(badPostRow?.published_body_json).toBeNull();

    const badPostReview = await getScreeningReviewById(env.PLATFORM_DB, badPostBody.reviewId);
    expect(badPostReview?.publishSource).toBe("dashboard");
    expect(badPostReview?.resourceType).toBe("post");

    const cleanPost = await createPost(tenantDb, {
      title: "Tips Merawat Mesin Mobil Harian",
      slug: "tips-merawat-mesin-mobil",
      body: {
        schemaVersion: 1,
        blocks: [{ type: "paragraph", text: "Ganti oli mesin secara berkala setiap 5.000 km." }],
      },
      nowMs: nowMs + 600,
    });
    const cleanPostRes = await handleTenantPostPublishRequest(
      tenantId,
      String(cleanPost.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/posts/${cleanPost.id}/publish`, {
        version: cleanPost.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 700 },
    );
    expect(cleanPostRes.status).toBe(200);
    const cleanPostJson = (await cleanPostRes.json()) as {
      status: string;
      cacheVersion: number;
      substantiveChanged: boolean;
    };
    expect(cleanPostJson.status).toBe("published");
    expect(cleanPostJson.cacheVersion).toBe(cacheBeforeBadPost + 1);
    expect(cleanPostJson.substantiveChanged).toBe(true);

    // ------------------------------------------------------------------
    // 3. Catalog offering direct dashboard publish: flagged -> 202 held_for_review, clean -> 200 published
    // ------------------------------------------------------------------
    const badOffering = await createCatalogOffering(
      tenantDb,
      {
        offeringType: "product",
        title: "Paket Promo Togel Online Resmi",
        slug: "paket-promo-togel-online",
        summary: "Bonus besar setiap hari",
        priceMode: "fixed",
        price: 100_000,
        ctaMode: "inquiry",
        attributes: {},
      },
      { nowMs: nowMs + 800 },
    );
    const cacheBeforeBadOff = await readCacheVersion();
    const sentBeforeBadOff = sentIndexNowMessages.length;
    const badOffRes = await handleTenantCatalogOfferingPublishRequest(
      tenantId,
      String(badOffering.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/catalog/${badOffering.id}/publish`, {
        version: badOffering.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 900 },
    );
    expect(badOffRes.status).toBe(202);
    expect(badOffRes.headers.get("cache-control")).toContain("no-store");
    const badOffBody = (await badOffRes.json()) as {
      outcome: string;
      held: boolean;
      status: string;
      reviewId: string;
      message: string;
    };
    expect(badOffBody.outcome).toBe("held_for_review");
    expect(badOffBody.held).toBe(true);
    expect(badOffBody.status).toBe("draft");
    expect(badOffBody.message).toBe("Konten ditahan untuk ditinjau");
    expect(JSON.stringify(badOffBody).toLowerCase()).not.toContain("togel");
    expect(await readCacheVersion()).toBe(cacheBeforeBadOff);
    expect(sentIndexNowMessages.length).toBe(sentBeforeBadOff);

    const badOffRow = await tenantDb
      .prepare("SELECT status, published_snapshot_json FROM offerings WHERE id = ?")
      .bind(badOffering.id)
      .first<{ readonly status: string; readonly published_snapshot_json: string | null }>();
    expect(badOffRow?.status).toBe("draft");
    expect(badOffRow?.published_snapshot_json).toBeNull();

    const badOffReview = await getScreeningReviewById(env.PLATFORM_DB, badOffBody.reviewId);
    expect(badOffReview?.publishSource).toBe("dashboard");
    expect(badOffReview?.resourceType).toBe("offering");

    const cleanOffering = await createCatalogOffering(
      tenantDb,
      {
        offeringType: "product",
        title: "Kopi Arabika Gayo 250g",
        slug: "kopi-arabika-gayo-250g",
        summary: "Biji kopi sangrai medium dari dataran tinggi Gayo.",
        priceMode: "fixed",
        price: 95_000,
        ctaMode: "inquiry",
        attributes: {},
      },
      { nowMs: nowMs + 1_000 },
    );
    const cleanOffRes = await handleTenantCatalogOfferingPublishRequest(
      tenantId,
      String(cleanOffering.id),
      makeDashboardPublishReq(`/api/tenants/${tenantId}/catalog/${cleanOffering.id}/publish`, {
        version: cleanOffering.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 1_100 },
    );
    expect(cleanOffRes.status).toBe(200);
    const cleanOffJson = (await cleanOffRes.json()) as {
      status: string;
      cacheVersion: number;
      revisionNumber: number;
    };
    expect(cleanOffJson.status).toBe("published");
    expect(cleanOffJson.cacheVersion).toBe(cacheBeforeBadOff + 1);
    expect(cleanOffJson.revisionNumber).toBe(1);

    // ------------------------------------------------------------------
    // 4. Identity direct dashboard publish:
    //    (a) Flagged `site_settings` -> held (neither table published)
    //    (b) Clean `site_settings` + flagged `business_profile` -> held (neither table published)
    //    (c) Both clean -> 200 published cleanly
    // ------------------------------------------------------------------
    const badSiteIdentity = await saveSiteIdentityDraft(tenantDb, {
      siteSettings: {
        siteTitle: "Agen Slot Gacor 88 Resmi",
        tagline: "Portal informasi",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
      },
      businessProfile: {
        businessName: "PT Kopi Nusantara Sejahtera",
        businessCategory: "CafeOrCoffeeShop",
        description: "Kopi spesialti pilihan.",
      },
      nowMs: nowMs + 1_200,
    });
    const cacheBeforeBadSiteId = await readCacheVersion();
    const badSiteIdRes = await handleTenantIdentityPublishRequest(
      tenantId,
      makeDashboardPublishReq(`/api/tenants/${tenantId}/identity/publish`, {
        expectedVersion: badSiteIdentity.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 1_300 },
    );
    expect(badSiteIdRes.status).toBe(202);
    expect(badSiteIdRes.headers.get("cache-control")).toContain("no-store");
    const badSiteIdBody = (await badSiteIdRes.json()) as {
      outcome: string;
      held: boolean;
      reviewId: string;
      message: string;
    };
    expect(badSiteIdBody.outcome).toBe("held_for_review");
    expect(badSiteIdBody.held).toBe(true);
    expect(badSiteIdBody.message).toBe("Konten ditahan untuk ditinjau");
    expect(JSON.stringify(badSiteIdBody).toLowerCase()).not.toContain("slot gacor");
    expect(await readCacheVersion()).toBe(cacheBeforeBadSiteId);

    const unpublishedIdentityRowsA = await Promise.all([
      tenantDb
        .prepare("SELECT published_json FROM site_settings WHERE id = 1")
        .first<{ readonly published_json: string | null }>(),
      tenantDb
        .prepare("SELECT published_json FROM business_profile WHERE id = 1")
        .first<{ readonly published_json: string | null }>(),
    ]);
    expect(unpublishedIdentityRowsA[0]?.published_json).toBeNull();
    expect(unpublishedIdentityRowsA[1]?.published_json).toBeNull();

    // (b) Clean site_settings + flagged business_profile -> MUST hold both!
    const badProfileIdentity = await saveSiteIdentityDraft(tenantDb, {
      expectedVersion: badSiteIdentity.version,
      siteSettings: {
        siteTitle: "Kopi Nusantara Sejahtera",
        tagline: "Kopi lokal terbaik",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
      },
      businessProfile: {
        businessName: "Kopi Nusantara",
        businessCategory: "CafeOrCoffeeShop",
        description: "Daftar situs judi bola sbobet resmi terpercaya.",
      },
      nowMs: nowMs + 1_400,
    });
    const badProfileIdRes = await handleTenantIdentityPublishRequest(
      tenantId,
      makeDashboardPublishReq(`/api/tenants/${tenantId}/identity/publish`, {
        expectedVersion: badProfileIdentity.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 1_500 },
    );
    expect(badProfileIdRes.status).toBe(202);
    expect(badProfileIdRes.headers.get("cache-control")).toContain("no-store");
    const badProfileIdBody = (await badProfileIdRes.json()) as {
      outcome: string;
      held: boolean;
      reviewId: string;
      message: string;
    };
    expect(badProfileIdBody.outcome).toBe("held_for_review");
    expect(badProfileIdBody.held).toBe(true);
    expect(JSON.stringify(badProfileIdBody).toLowerCase()).not.toContain("sbobet");
    expect(await readCacheVersion()).toBe(cacheBeforeBadSiteId);

    const badProfileReview = await getScreeningReviewById(env.PLATFORM_DB, badProfileIdBody.reviewId);
    expect(badProfileReview?.publishSource).toBe("dashboard");
    expect(badProfileReview?.resourceType).toBe("business_profile");

    const unpublishedIdentityRowsB = await Promise.all([
      tenantDb
        .prepare("SELECT published_json FROM site_settings WHERE id = 1")
        .first<{ readonly published_json: string | null }>(),
      tenantDb
        .prepare("SELECT published_json FROM business_profile WHERE id = 1")
        .first<{ readonly published_json: string | null }>(),
    ]);
    expect(unpublishedIdentityRowsB[0]?.published_json).toBeNull();
    expect(unpublishedIdentityRowsB[1]?.published_json).toBeNull();

    // (c) Both clean -> publishes 200 cleanly!
    const cleanIdentity = await saveSiteIdentityDraft(tenantDb, {
      expectedVersion: badProfileIdentity.version,
      siteSettings: {
        siteTitle: "Kopi Nusantara Sejahtera",
        tagline: "Kopi lokal terbaik",
        timezone: "Asia/Jakarta",
        locale: "id-ID",
        activeThemeId: "compro",
      },
      businessProfile: {
        businessName: "PT Kopi Nusantara Sejahtera",
        businessCategory: "CafeOrCoffeeShop",
        description: "Kopi spesialti pilihan langsung dari petani Nusantara.",
      },
      nowMs: nowMs + 1_600,
    });
    const cleanIdRes = await handleTenantIdentityPublishRequest(
      tenantId,
      makeDashboardPublishReq(`/api/tenants/${tenantId}/identity/publish`, {
        expectedVersion: cleanIdentity.version,
      }),
      runtimeEnv,
      { authenticatedUser: { id: ownerUserId }, nowMs: nowMs + 1_700 },
    );
    expect(cleanIdRes.status).toBe(200);
    const cleanIdJson = (await cleanIdRes.json()) as {
      cacheVersion: number;
      hasUnpublishedChanges: boolean;
      published: { siteSettings: { siteTitle: string }; businessProfile: { businessName: string } };
    };
    expect(cleanIdJson.hasUnpublishedChanges).toBe(false);
    expect(cleanIdJson.published.siteSettings.siteTitle).toBe("Kopi Nusantara Sejahtera");
    expect(cleanIdJson.published.businessProfile.businessName).toBe("PT Kopi Nusantara Sejahtera");
    expect(cleanIdJson.cacheVersion).toBeGreaterThan(cacheBeforeBadSiteId);
  });
});
