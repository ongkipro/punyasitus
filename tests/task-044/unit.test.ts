import fs from "node:fs";
import path from "node:path";
import {
  collectReferencedMediaIdsFromRow,
  computeTrashRetentionMeta,
  extractMediaIdsFromJsonValue,
  resolveContentPublicPath,
  resolveContentSlugNamespace,
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
} from "@punyasitus/db/trash/index";
import { describe, expect, it, vi } from "vitest";
import {
  resolveTrashSsrGate,
  type TrashSsrGateAstroLike,
} from "../../apps/web/src/pages/dashboard/[handle]/pages/_trash-ssr-gate.ts";
import {
  CONTENT_PURGE_CRON_JOB_DEFINITIONS,
  CONTENT_PURGE_SWEEP_TOPIC,
} from "../../apps/web/src/worker/queues/content-purge/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function createMockAstro(overrides: {
  readonly handle?: string;
  readonly surface?: "app" | "tenant" | "marketing" | "console";
  readonly tenantStatus?: "trial" | "active" | "grace" | "locked" | "suspended" | "recovery" | "purging" | "purged";
  readonly role?: "owner" | "admin" | "editor" | "agency_admin" | "platform_operator";
  readonly memberHandle?: string;
  readonly authenticated?: boolean;
}): TrashSsrGateAstroLike {
  const handle = overrides.handle ?? "alpha-studio";
  const authenticated = overrides.authenticated !== false;
  return {
    params: { handle },
    locals: {
      surface: overrides.surface ?? "app",
      isLocalLoopback: false,
      authUser: authenticated
        ? ({
            id: "user_01",
            email: "owner@alpha.test",
            name: "Budi Santoso",
          } as App.Locals["authUser"])
        : null,
      authorizedTenantMember: authenticated
        ? ({
            tenantId: "01JTRASH000000000000000001",
            organizationId: "org_01",
            handle: overrides.memberHandle ?? handle,
            tenantName: "PT Nusantara Arsitek",
            tenantStatus: overrides.tenantStatus ?? "active",
            memberId: "mem_01",
            userId: "user_01",
            dbRole: overrides.role === "editor" ? "editor" : overrides.role === "admin" ? "admin" : "owner",
            role: overrides.role ?? "owner",
          } as App.Locals["authorizedTenantMember"])
        : null,
      tenant: null,
      tenantDb: null,
    } as unknown as App.Locals,
    response: { headers: new Headers() },
  };
}

function createMockPlatformDb(row: {
  readonly status: string;
  readonly operator_hold: number;
  readonly vertical?: string;
  readonly operator_hold_reason?: string | null;
  readonly trial_ends_at?: number | null;
  readonly primary_host?: string | null;
}): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          vertical: "compro",
          operator_hold_reason: null,
          trial_ends_at: null,
          primary_host: null,
          ...row,
        }),
      }),
    }),
  } as unknown as D1Database;
}

describe("TASK-044 unit: trash retention, media extraction, SSR lifecycle/RBAC gate, and zero-DDL guard", () => {
  it("computes 30-day retention countdown and expiry accurately", () => {
    const deletedAt = Date.UTC(2026, 10, 1, 0, 0, 0);
    const day10 = deletedAt + 10 * 86_400_000;
    const metaActive = computeTrashRetentionMeta(deletedAt, day10);
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(metaActive.daysRemaining).toBe(20);
    expect(metaActive.isExpired).toBe(false);
    expect(metaActive.purgeEligibleAt).toBe(new Date(deletedAt + TRASH_RETENTION_MS).toISOString());

    const day30Exact = deletedAt + TRASH_RETENTION_MS;
    const metaExpired = computeTrashRetentionMeta(deletedAt, day30Exact);
    expect(metaExpired.daysRemaining).toBe(0);
    expect(metaExpired.isExpired).toBe(true);
  });

  it("maps slug namespaces and public paths accurately across pages, posts, and offering types", () => {
    expect(resolveContentSlugNamespace("page", null)).toBe("pages");
    expect(resolveContentSlugNamespace("post", null)).toBe("blog");
    expect(resolveContentSlugNamespace("offering", "service")).toBe("layanan");
    expect(resolveContentSlugNamespace("offering", "product")).toBe("produk");
    expect(resolveContentSlugNamespace("offering", "tour")).toBe("tour");
    expect(resolveContentSlugNamespace("offering", "vehicle")).toBe("kendaraan");

    expect(resolveContentPublicPath("page", "beranda", null, true)).toBe("/");
    expect(resolveContentPublicPath("page", "tentang-kami", null, false)).toBe("/tentang-kami");
    expect(resolveContentPublicPath("post", "tips-desain", null)).toBe("/blog/tips-desain");
    expect(resolveContentPublicPath("offering", "paket-bali", "tour")).toBe("/tour/paket-bali");
  });

  it("extracts nested media IDs cleanly from pages, posts, and offerings without duplicates", () => {
    const nested = new Set<number>();
    extractMediaIdsFromJsonValue(
      {
        sections: [
          { kind: "hero", mediaId: 11, items: [{ imageMediaId: 12 }, { ogImageMediaId: 11 }] },
          { kind: "gallery", galleryMediaIds: [15, 16, -1, "bad"] },
        ],
      },
      nested,
    );
    expect([...nested].sort((a, b) => a - b)).toEqual([11, 12, 15, 16]);

    const offeringIds = collectReferencedMediaIdsFromRow("offering", {
      cover_media_id: 21,
      video_media_id: 22,
      gallery_media_ids_json: JSON.stringify([23, 21, 24]),
      seo_json: JSON.stringify({ ogImageMediaId: 25 }),
    });
    expect(offeringIds).toEqual([21, 22, 23, 24, 25]);
  });

  it("enforces SSR lifecycle gate BEFORE any TenantStore DB reads (purging/purged -> 404, suspended/recovery/operatorHold -> 302)", async () => {
    const fakeTenantDb = {} as D1Database;
    const fakeNamespace = {} as never;

    for (const terminalStatus of ["purging", "purged"] as const) {
      const bindSpy = vi.fn(() => fakeTenantDb);
      const res = await resolveTrashSsrGate(
        createMockAstro({ tenantStatus: terminalStatus }),
        {
          APP_ENV: "production",
          PLATFORM_DB: createMockPlatformDb({ status: terminalStatus, operator_hold: 0 }),
          TENANT_STORE: fakeNamespace,
        },
        { bindTenantDb: bindSpy },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(404);
        expect(res.response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(res.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      }
      expect(bindSpy).not.toHaveBeenCalled();
    }

    for (const blockedStatus of ["suspended", "recovery"] as const) {
      const bindSpy = vi.fn(() => fakeTenantDb);
      const res = await resolveTrashSsrGate(
        createMockAstro({ tenantStatus: blockedStatus }),
        {
          APP_ENV: "production",
          PLATFORM_DB: createMockPlatformDb({ status: blockedStatus, operator_hold: 0 }),
          TENANT_STORE: fakeNamespace,
        },
        { bindTenantDb: bindSpy },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(302);
        expect(res.response.headers.get("Location")).toBe("/dashboard/alpha-studio/service-status");
        expect(res.response.headers.get("Cache-Control")).toBe("private, no-store");
      }
      expect(bindSpy).not.toHaveBeenCalled();
    }

    // Live operator_hold = 1 in PLATFORM_DB redirects to service-status BEFORE any TenantStore read
    const holdBindSpy = vi.fn(() => fakeTenantDb);
    const holdRes = await resolveTrashSsrGate(
      createMockAstro({ tenantStatus: "active" }),
      {
        APP_ENV: "production",
        PLATFORM_DB: createMockPlatformDb({
          status: "active",
          operator_hold: 1,
          operator_hold_reason: "Investigasi penyalahgunaan",
        }),
        TENANT_STORE: fakeNamespace,
      },
      { bindTenantDb: holdBindSpy },
    );
    expect(holdRes.ok).toBe(false);
    if (!holdRes.ok) {
      expect(holdRes.response.status).toBe(302);
      expect(holdRes.response.headers.get("Location")).toBe("/dashboard/alpha-studio/service-status");
    }
    // Fail closed with 503 when live PLATFORM_DB query throws (ZERO TenantStore DB reads)
    const errorBindSpy = vi.fn(() => fakeTenantDb);
    const failingPlatformDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1_TRANSIENT_FAILURE");
          },
        }),
      }),
    } as unknown as D1Database;
    const failClosedRes = await resolveTrashSsrGate(
      createMockAstro({ tenantStatus: "active" }),
      {
        APP_ENV: "production",
        PLATFORM_DB: failingPlatformDb,
        TENANT_STORE: fakeNamespace,
      },
      { bindTenantDb: errorBindSpy },
    );
    expect(failClosedRes.ok).toBe(false);
    if (!failClosedRes.ok) {
      expect(failClosedRes.response.status).toBe(503);
      expect(failClosedRes.response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(failClosedRes.response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(failClosedRes.response.headers.get("Retry-After")).toBe("30");
    }
    expect(errorBindSpy).not.toHaveBeenCalled();
  });

  it("registers createContentPurgeJobRegistry() and schedules daily content trash purge in apps/web/src/worker/index.ts", () => {
    expect(CONTENT_PURGE_CRON_JOB_DEFINITIONS.length).toBe(1);
    expect(CONTENT_PURGE_CRON_JOB_DEFINITIONS[0]?.topic).toBe(CONTENT_PURGE_SWEEP_TOPIC);
    expect(CONTENT_PURGE_CRON_JOB_DEFINITIONS[0]?.cadence).toBe("daily");

    const workerSource = fs.readFileSync(path.join(ROOT, "apps/web/src/worker/index.ts"), "utf8");
    expect(workerSource).toContain("createContentPurgeJobRegistry");
    expect(workerSource).toContain("...createContentPurgeJobRegistry()");
    expect(workerSource).toContain("CONTENT_PURGE_CRON_JOB_DEFINITIONS");
    expect(workerSource).toContain("...CONTENT_PURGE_CRON_JOB_DEFINITIONS");
  });

  it("enforces SSR cross-tenant neutral 404, locked read-only mode, and owner/admin vs editor purge permissions", async () => {
    const fakeTenantDb = {} as D1Database;
    const fakeNamespace = {} as never;

    // Cross-tenant handle mismatch -> neutral 404, zero TenantStore reads
    const crossBindSpy = vi.fn(() => fakeTenantDb);
    const crossRes = await resolveTrashSsrGate(
      createMockAstro({ handle: "beta-shop", memberHandle: "alpha-studio" }),
      { APP_ENV: "production", TENANT_STORE: fakeNamespace },
      { bindTenantDb: crossBindSpy },
    );
    expect(crossRes.ok).toBe(false);
    if (!crossRes.ok) expect(crossRes.response.status).toBe(404);
    expect(crossBindSpy).not.toHaveBeenCalled();

    // Locked tenant -> read-only (`canWriteContent: false`, `canPurgeContent: false`)
    const lockedRes = await resolveTrashSsrGate(
      createMockAstro({ tenantStatus: "locked", role: "owner" }),
      {
        APP_ENV: "production",
        PLATFORM_DB: createMockPlatformDb({ status: "locked", operator_hold: 0 }),
        TENANT_STORE: fakeNamespace,
      },
      { bindTenantDb: () => fakeTenantDb },
    );
    expect(lockedRes.ok).toBe(true);
    if (lockedRes.ok) {
      expect(lockedRes.ctx.permissions.isLocked).toBe(true);
      expect(lockedRes.ctx.permissions.canWriteContent).toBe(false);
      expect(lockedRes.ctx.permissions.canPurgeContent).toBe(false);
    }

    // Editor on active tenant -> can restore (`canWriteContent: true`), CANNOT purge permanently
    const editorRes = await resolveTrashSsrGate(
      createMockAstro({ tenantStatus: "active", role: "editor" }),
      {
        APP_ENV: "production",
        PLATFORM_DB: createMockPlatformDb({ status: "active", operator_hold: 0 }),
        TENANT_STORE: fakeNamespace,
      },
      { bindTenantDb: () => fakeTenantDb },
    );
    expect(editorRes.ok).toBe(true);
    if (editorRes.ok) {
      expect(editorRes.ctx.permissions.canWriteContent).toBe(true);
      expect(editorRes.ctx.permissions.canPurgeContent).toBe(false);
    }

    // Owner/Admin on active tenant -> can restore AND permanently purge
    for (const role of ["owner", "admin"] as const) {
      const privilegedRes = await resolveTrashSsrGate(
        createMockAstro({ tenantStatus: "active", role }),
        {
          APP_ENV: "production",
          PLATFORM_DB: createMockPlatformDb({ status: "active", operator_hold: 0 }),
          TENANT_STORE: fakeNamespace,
        },
        { bindTenantDb: () => fakeTenantDb },
      );
      expect(privilegedRes.ok).toBe(true);
      if (privilegedRes.ok) {
        expect(privilegedRes.ctx.permissions.canWriteContent).toBe(true);
        expect(privilegedRes.ctx.permissions.canPurgeContent).toBe(true);
      }
    }
  });

  it("contains ZERO request-time runtime DDL across all TASK-044 runtime modules", () => {
    const runtimeFiles = [
      "packages/db/src/trash/types.ts",
      "packages/db/src/trash/references.ts",
      "packages/db/src/trash/index.ts",
      "apps/web/src/worker/queues/content-purge/handler.ts",
      "apps/web/src/worker/queues/content-purge/index.ts",
      "apps/web/src/pages/dashboard/[handle]/pages/_trash-ssr-gate.ts",
      "apps/web/src/pages/dashboard/[handle]/pages/_ContentTrashClient.tsx",
      "apps/web/src/pages/dashboard/[handle]/pages/trash.astro",
      "apps/web/src/pages/dashboard/[handle]/posts/trash.astro",
      "apps/web/src/pages/dashboard/[handle]/catalog/trash.astro",
      "apps/web/src/pages/api/tenants/[tenantId]/pages/trash.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/pages/[pageId]/purge.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/posts/trash.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/posts/[postId]/purge.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/catalog/trash.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/trash.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/restore.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/catalog/[offeringId]/purge.ts",
    ];

    const forbiddenDdlPattern = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|ensure[A-Za-z0-9_]*Schema)\b/i;
    for (const rel of runtimeFiles) {
      const fullPath = path.join(ROOT, rel);
      const source = fs.readFileSync(fullPath, "utf8");
      // Strip block & line comments before checking executable SQL/code
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(forbiddenDdlPattern.test(stripped), `Forbidden runtime DDL found in ${rel}`).toBe(false);
    }
  });
});
