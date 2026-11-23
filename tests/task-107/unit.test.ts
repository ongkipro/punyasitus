import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateTenantApiEntitlement, type LiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import {
  buildSiteExportArchive,
  buildTenantExportR2Key,
  buildZipArchive,
  computeSelfServiceDeletionSchedule,
  DELETION_UNDO_WINDOW_MS,
  EXPORT_LINK_TTL_MS,
  getJakartaDayKey,
  hashExportDownloadToken,
  isEligibleTenantMediaR2Key,
  isWithinDeletionUndoWindow,
  MAX_EXPORT_ARCHIVE_BYTES,
  parseZipArchive,
  scrubSensitiveExportFields,
  secondsUntilNextJakartaDay,
  serializeExportLeadsCsv,
  signExportDownloadToken,
  validateDeletionConfirmationInput,
  verifyExportDownloadToken,
  ZipArchiveError,
} from "@punyasitus/core/exports/index";
import { TENANT_EXPORTS_AND_DELETION_MIGRATION_SQL } from "@punyasitus/db/exports/index";
import { evaluateDataSettingsSsrGate } from "../../apps/web/src/pages/dashboard/[handle]/settings/data/_ssr-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-107 unit tests — export ZIP, signing, sanitization, deletion & gates", () => {
  it("keeps bundled 0023 migration SQL byte-for-byte identical to platform SQL file", () => {
    const fileSql = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/platform/0023_tenant_exports_and_deletion.sql"),
      "utf8",
    );
    expect(TENANT_EXPORTS_AND_DELETION_MIGRATION_SQL).toBe(fileSql);
  });

  it("uses only base-nova / @base-ui/react primitives with zero @radix-ui or asChild", () => {
    const dataSettingsDir = path.join(
      REPO_ROOT,
      "apps/web/src/pages/dashboard/[handle]/settings/data",
    );
    const files = fs.readdirSync(dataSettingsDir);
    for (const file of files) {
      const src = fs.readFileSync(path.join(dataSettingsDir, file), "utf8");
      expect(src).not.toMatch(/@radix-ui\//);
      expect(src).not.toMatch(/\basChild\b/);
    }
  });

  it("builds and parses valid PKZIP archives with exact CRC-32 and UTF-8 fidelity", () => {
    const binaryPayload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0xff]);
    const zipBytes = buildZipArchive(
      [
        { path: "manifest.json", data: '{"ok":true,"label":"Situs Kopi Nusantara"}' },
        { path: "media/1-banner.png", data: binaryPayload },
      ],
      { defaultModifiedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0) },
    );

    // Standard PKZIP magic signature PK\x03\x04
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);

    const parsed = parseZipArchive(zipBytes);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.path).toBe("manifest.json");
    expect(new TextDecoder().decode(parsed[0]!.data)).toBe('{"ok":true,"label":"Situs Kopi Nusantara"}');
    expect(parsed[1]?.path).toBe("media/1-banner.png");
    expect(Array.from(parsed[1]!.data)).toEqual(Array.from(binaryPayload));
  });

  it("rejects path traversal, absolute paths, backslashes, duplicates, and size budget overflow in ZIP", () => {
    const unsafePaths = [
      "../secret.txt",
      "media/../../etc/passwd",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "media\\back.png",
      "media/./dot.png",
      "null\0byte.txt",
      "",
    ];
    for (const badPath of unsafePaths) {
      expect(() => buildZipArchive([{ path: badPath, data: "x" }])).toThrow(ZipArchiveError);
    }

    expect(() =>
      buildZipArchive([
        { path: "pages.json", data: "[]" },
        { path: "pages.json", data: "[]" },
      ]),
    ).toThrow(/Duplicate ZIP entry path/);

    expect(() =>
      buildZipArchive([{ path: "media/big.bin", data: new Uint8Array(4096) }], {
        maxTotalBytes: 2048,
      }),
    ).toThrow(/exceeds maximum allowed size/);
  });

  it("assembles complete site archive with scrubbed secrets, formula-safe CSV, and tenant-scoped media only", async () => {
    const validImg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const foreignImg = new Uint8Array([9, 9, 9, 9]);

    const built = await buildSiteExportArchive({
      exportId: "exp_01TEST0000000000000001",
      tenantId: "ten_alpha",
      tenantHandle: "kopi-alpha",
      tenantName: "Kopi Alpha",
      vertical: "catalog",
      siteSettings: {
        site_title: "Kopi Alpha",
        secretToken: "MUST_NOT_APPEAR",
        passwordHash: "HASH_MUST_NOT_APPEAR",
      },
      businessProfile: {
        business_name: "PT Kopi Alpha",
        apiKey: "API_KEY_MUST_NOT_APPEAR",
      },
      pages: [{ id: 1, slug: "beranda", title: "Beranda", accessToken: "NOPE" }],
      posts: [{ id: 2, slug: "artikel-1", title: "Artikel Kopi" }],
      offerings: [{ id: 3, slug: "arabika", title: "Arabika Gayo", price: 95000 }],
      leads: [
        {
          id: 10,
          name: "=HYPERLINK(\"http://evil\",\"Klik\")",
          phone: "+6281234567890",
          email: "budi@example.com",
          message: "+cmd|'/C calc'!A0",
          status: "new",
          preferredDate: null,
          preferredTime: null,
          branchId: null,
          sourceCategory: "direct",
          pagePath: "/kontak",
          utm: { utm_source: "ig" },
          internalNotes: "-1+1",
          createdAt: "2026-11-23T01:00:00.000Z",
          updatedAt: "2026-11-23T01:00:00.000Z",
        },
      ],
      mediaFiles: [
        {
          id: 101,
          r2Key: "t/ten_alpha/media/hero.webp",
          mimeType: "image/webp",
          bytes: validImg.byteLength,
          sha256: "abc",
          altText: "Hero",
          data: validImg,
        },
        {
          id: 102,
          r2Key: "t/ten_beta/media/stolen.webp",
          mimeType: "image/webp",
          bytes: foreignImg.byteLength,
          sha256: "def",
          altText: "Stolen",
          data: foreignImg,
        },
        {
          id: 103,
          r2Key: "t/ten_alpha/exports/old.zip",
          mimeType: "application/zip",
          bytes: foreignImg.byteLength,
          sha256: "ghi",
          altText: "Self export",
          data: foreignImg,
        },
      ],
      generatedAtMs: Date.UTC(2026, 10, 23, 5, 0, 0),
    });

    const entries = parseZipArchive(built.zipBytes);
    const byPath = new Map(entries.map((e) => [e.path, e]));

    expect(Array.from(byPath.keys())).toEqual([
      "manifest.json",
      "site.json",
      "pages.json",
      "posts.json",
      "offerings.json",
      "leads.csv",
      "media/101-hero.webp",
    ]);

    const siteText = new TextDecoder().decode(byPath.get("site.json")!.data);
    expect(siteText).toContain("Kopi Alpha");
    expect(siteText).not.toContain("MUST_NOT_APPEAR");
    expect(siteText).not.toContain("secretToken");
    expect(siteText).not.toContain("passwordHash");
    expect(siteText).not.toContain("apiKey");

    const pagesText = new TextDecoder().decode(byPath.get("pages.json")!.data);
    expect(pagesText).not.toContain("accessToken");
    expect(pagesText).not.toContain("NOPE");

    const leadsCsv = new TextDecoder().decode(byPath.get("leads.csv")!.data);
    expect(leadsCsv).toContain("'=HYPERLINK");
    expect(leadsCsv).toContain("'+cmd|");
    expect(leadsCsv).toContain("'-1+1");
    // Structured E.164 phone MUST remain faithful without leading formula-guard apostrophe
    expect(leadsCsv).toContain(",+6281234567890,");
    expect(leadsCsv).not.toContain("'+6281234567890");

    const manifest = JSON.parse(new TextDecoder().decode(byPath.get("manifest.json")!.data));
    expect(manifest.counts).toEqual({
      pages: 1,
      posts: 1,
      offerings: 1,
      leads: 1,
      mediaIncluded: 1,
      mediaSkipped: 2,
    });
    expect(manifest.truncated).toEqual({
      pages: false,
      posts: false,
      offerings: false,
      leads: false,
      media: false,
      any: false,
    });
    expect(manifest.skippedMedia.every((s: { reason: string }) => s.reason === "outside_tenant_prefix")).toBe(true);
    expect(built.sha256Hex).toMatch(/^[a-f0-9]{64}$/);
    expect(MAX_EXPORT_ARCHIVE_BYTES).toBe(32 * 1024 * 1024);
  });

  it("enforces strict R2 prefix scoping and secret scrubbing helpers", () => {
    expect(buildTenantExportR2Key("ten_abc", "exp_123")).toBe("t/ten_abc/exports/exp_123.zip");
    expect(() => buildTenantExportR2Key("../evil", "exp_123")).toThrow();

    expect(isEligibleTenantMediaR2Key("ten_abc", "t/ten_abc/media/a.webp")).toBe(true);
    expect(isEligibleTenantMediaR2Key("ten_abc", "t/ten_other/media/a.webp")).toBe(false);
    expect(isEligibleTenantMediaR2Key("ten_abc", "t/ten_abc/exports/x.zip")).toBe(false);
    expect(isEligibleTenantMediaR2Key("ten_abc", "t/ten_abc/trash/x.webp")).toBe(false);
    expect(isEligibleTenantMediaR2Key("ten_abc", "t/ten_abc/media/../other.webp")).toBe(false);

    const scrubbed = scrubSensitiveExportFields({
      ok: 1,
      nested: {
        title: "Keep",
        backupCodes: ["abc-def"],
        refresh_token: "rt_123",
      },
    });
    expect(scrubbed).toEqual({ ok: 1, nested: { title: "Keep" } });

    const csv = serializeExportLeadsCsv([
      {
        id: 1,
        name: "@formula",
        phone: "+628111111111",
        email: null,
        message: "Halo, \"tes\"",
        status: "new",
        preferredDate: null,
        preferredTime: null,
        branchId: null,
        sourceCategory: "direct",
        pagePath: "/",
        utm: null,
        internalNotes: null,
        createdAt: "2026-11-23T00:00:00.000Z",
        updatedAt: "2026-11-23T00:00:00.000Z",
      },
    ]);
    expect(csv).toContain("'@formula");
    expect(csv).toContain('"Halo, ""tes"""');
  });

  it("signs and verifies HMAC-SHA256 export tokens bound to owner, tenant, exportId, and 24h TTL", async () => {
    const secret = "unit-test-export-signing-secret-0123456789abcdef";
    const nowMs = Date.UTC(2026, 10, 23, 10, 0, 0);
    const expiresAtMs = nowMs + EXPORT_LINK_TTL_MS;

    const token = await signExportDownloadToken(secret, {
      exportId: "exp_01",
      tenantId: "ten_01",
      ownerUserId: "usr_owner",
      expiresAtMs,
    });
    const hash = await hashExportDownloadToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Valid 1ms before expiry
    const okRes = await verifyExportDownloadToken(secret, token, {
      exportId: "exp_01",
      tenantId: "ten_01",
      ownerUserId: "usr_owner",
      nowMs: expiresAtMs - 1,
    });
    expect(okRes.ok).toBe(true);

    // Expired at exact 24h boundary
    const expiredRes = await verifyExportDownloadToken(secret, token, {
      exportId: "exp_01",
      tenantId: "ten_01",
      ownerUserId: "usr_owner",
      nowMs: expiresAtMs,
    });
    expect(expiredRes).toEqual({ ok: false, reason: "expired" });

    // Wrong owner / wrong tenant / wrong exportId / wrong secret / tampered signature
    expect(
      await verifyExportDownloadToken(secret, token, {
        exportId: "exp_01",
        tenantId: "ten_01",
        ownerUserId: "usr_other",
        nowMs,
      }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });

    expect(
      await verifyExportDownloadToken(secret, token, {
        exportId: "exp_01",
        tenantId: "ten_other",
        ownerUserId: "usr_owner",
        nowMs,
      }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });

    expect(
      await verifyExportDownloadToken("different-secret-0123456789abcdef", token, {
        exportId: "exp_01",
        tenantId: "ten_01",
        ownerUserId: "usr_owner",
        nowMs,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });

    const tampered = `${token.slice(0, -2)}aa`;
    expect(
      await verifyExportDownloadToken(secret, tampered, {
        exportId: "exp_01",
        tenantId: "ten_01",
        ownerUserId: "usr_owner",
        nowMs,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("computes Jakarta (UTC+7) calendar day rollover and 7-day deletion undo schedule accurately", () => {
    // 2026-11-23 16:59:59 UTC == 2026-11-23 23:59:59 WIB
    expect(getJakartaDayKey(Date.UTC(2026, 10, 23, 16, 59, 59))).toBe("2026-11-23");
    expect(secondsUntilNextJakartaDay(Date.UTC(2026, 10, 23, 16, 59, 59))).toBe(1);
    // 2026-11-23 17:00:00 UTC == 2026-11-24 00:00:00 WIB
    expect(getJakartaDayKey(Date.UTC(2026, 10, 23, 17, 0, 0))).toBe("2026-11-24");

    const t0 = Date.UTC(2026, 10, 23, 10, 0, 0);
    const sched = computeSelfServiceDeletionSchedule(t0);
    expect(sched.deletionRequestedAtMs).toBe(t0);
    expect(sched.deletionDueAtMs).toBe(t0 + DELETION_UNDO_WINDOW_MS);
    expect(isWithinDeletionUndoWindow(sched.deletionDueAtMs, sched.deletionDueAtMs - 1)).toBe(true);
    expect(isWithinDeletionUndoWindow(sched.deletionDueAtMs, sched.deletionDueAtMs)).toBe(false);

    expect(
      validateDeletionConfirmationInput({
        expectedHandle: "kopi-alpha",
        confirmHandle: "  KOPI-ALPHA ",
        reason: "Pindah domain",
      }),
    ).toEqual({ ok: true, reason: "Pindah domain" });

    expect(
      validateDeletionConfirmationInput({
        expectedHandle: "kopi-alpha",
        confirmHandle: "kopi-beta",
      }).ok,
    ).toBe(false);
  });

  it("enforces owner-only SSR gate and API entitlement gate across roles and lifecycle states", () => {
    const ownerBase = {
      rawHandle: "kopi-alpha",
      surface: "app",
      isLocalLoopback: false,
      isLocalEnv: false,
      authUser: { id: "u1" },
      authorized: {
        tenantId: "t1",
        handle: "kopi-alpha",
        role: "owner" as const,
        dbRole: "owner" as const,
        tenantStatus: "active" as const,
      },
    };

    expect(evaluateDataSettingsSsrGate(ownerBase).ok).toBe(true);
    expect(
      evaluateDataSettingsSsrGate({
        ...ownerBase,
        authorized: { ...ownerBase.authorized, tenantStatus: "suspended" },
      }).ok,
    ).toBe(true);

    // Admin, editor, agency non-owner -> 403
    for (const nonOwner of [
      { role: "admin" as const, dbRole: "admin" as const },
      { role: "editor" as const, dbRole: "editor" as const },
      { role: "agency_admin" as const, dbRole: "agency_staff" as const },
    ]) {
      const res = evaluateDataSettingsSsrGate({
        ...ownerBase,
        authorized: { ...ownerBase.authorized, ...nonOwner },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(403);
    }

    // Foreign / tenant surface / purging / purged -> 404
    const foreign = evaluateDataSettingsSsrGate({ ...ownerBase, rawHandle: "other-site" });
    expect(foreign.ok ? 200 : foreign.status).toBe(404);
    const tenantSurface = evaluateDataSettingsSsrGate({ ...ownerBase, surface: "tenant" });
    expect(tenantSurface.ok ? 200 : tenantSurface.status).toBe(404);
    const purging = evaluateDataSettingsSsrGate({
      ...ownerBase,
      authorized: { ...ownerBase.authorized, tenantStatus: "purging" },
    });
    expect(purging.ok ? 200 : purging.status).toBe(404);

    // Entitlement gate check for suspended owner on /deletion/cancel & /exports
    const suspendedEntitlement = {
      tenantId: "t1",
      organizationId: "o1",
      handle: "kopi-alpha",
      tenantName: "Kopi Alpha",
      agencyId: null,
      version: 1,
      evaluation: {
        effectiveStatus: "suspended",
        storedStatus: "suspended",
        needsStoredSync: false,
        evaluatedAtMs: Date.now(),
        operatorHold: false,
        operatorHoldReason: null,
        retentionPausedAtMs: null,
        retentionPaused: false,
        suspensionReason: "stored_suspended",
        agencyManaged: false,
        publicAccess: {
          allowed: false,
          httpStatus: 503,
          noindex: true,
          customDomainAllowed: false,
          cacheable: false,
        },
        adminAccess: {
          mode: "payment_recovery_only",
          canEditContent: false,
          canPublish: false,
          canReadCms: false,
          canExportLeadsCsv: true,
          canAccessBilling: true,
          canSignOut: true,
          storageQuotaBytes: 0,
          writeDenyCode: "SUBSCRIPTION_LOCKED",
        },
        deadlines: {
          trialEndsAtMs: null,
          paidThroughMs: null,
          graceEndsAtMs: null,
          lockedEndsAtMs: null,
          deletionDueAtMs: null,
          trialEndsAtIso: null,
          paidThroughIso: null,
          graceEndsAtIso: null,
          lockedEndsAtIso: null,
          deletionDueAtIso: null,
          daysRemaining: null,
          nextTransitionAtMs: null,
        },
      },
    } as LiveTenantEntitlement;

    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/deletion/cancel",
        role: "owner",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/exports",
        role: "owner",
      }).allowed,
    ).toBe(true);
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/deletion/cancel",
        role: "admin",
      }),
    ).toMatchObject({ allowed: false, status: 403, code: "FORBIDDEN" });
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/exports",
        role: "agency_admin",
      }),
    ).toMatchObject({ allowed: false, status: 403, code: "FORBIDDEN" });
    // Missing/undefined role MUST fail closed (403 FORBIDDEN)
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/exports",
      }),
    ).toMatchObject({ allowed: false, status: 403, code: "FORBIDDEN" });
    expect(
      evaluateTenantApiEntitlement({
        entitlement: suspendedEntitlement,
        method: "POST",
        subPath: "/deletion/cancel",
      }),
    ).toMatchObject({ allowed: false, status: 403, code: "FORBIDDEN" });
  });
});
