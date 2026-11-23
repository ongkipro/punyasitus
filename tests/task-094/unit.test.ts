import fs from "node:fs";
import path from "node:path";
import {
  ABUSE_CATEGORIES,
  ABUSE_MODERATION_MIGRATION,
  buildAbuseModerationTenantNoticeEmail,
  maskReporterContact,
  normalizeReportedPath,
  PLATFORM_0021_ABUSE_MODERATION_SQL,
  safeDecodePathSegment,
  validatePublicAbuseReportInput,
} from "@punyasitus/db/abuse/index";
import {
  redactTenantActivityRow,
  TENANT_0015_ACTIVITY_LOG_INDEXES_SQL,
  TENANT_ACTIVITY_LOG_INDEXES_MIGRATION,
} from "@punyasitus/db/activity-log/index";
import { PLATFORM_MIGRATIONS } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-094 unit — Migrations, Validation, Redaction & Base UI Hygiene", () => {
  it("matches bundled migration SQL byte-for-byte with migration files without mutating initial migration checksums", () => {
    const platformSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/platform/0021_abuse_moderation.sql"),
      "utf8",
    );
    const tenantSql = fs.readFileSync(
      path.join(ROOT, "packages/db/migrations/tenant/0015_tenant_activity_log_indexes.sql"),
      "utf8",
    );

    expect(PLATFORM_0021_ABUSE_MODERATION_SQL).toBe(platformSql);
    expect(ABUSE_MODERATION_MIGRATION.version).toBe(21);
    expect(ABUSE_MODERATION_MIGRATION.name).toBe("0021_abuse_moderation");

    expect(TENANT_0015_ACTIVITY_LOG_INDEXES_SQL).toBe(tenantSql);
    expect(TENANT_ACTIVITY_LOG_INDEXES_MIGRATION.version).toBe(15);
    expect(TENANT_ACTIVITY_LOG_INDEXES_MIGRATION.name).toBe("0015_tenant_activity_log_indexes");

    // Preserve existing initial migrations untouched (TASK-001 checksum stability)
    expect(PLATFORM_MIGRATIONS[0]?.name).toBe("0001_initial_platform");
    expect(TENANT_MIGRATIONS[0]?.name).toBe("0001_initial_tenant");
  });

  it("validates and sanitizes public abuse report payloads strictly", () => {
    const valid = validatePublicAbuseReportInput(
      {
        category: "phishing",
        reportedPath: "/promo-hadiah",
        description: "Halaman ini meminta kode OTP dan kata sandi rekening bank pengunjung.",
        reporterEmail: "Pelapor@Contoh.ID",
      },
      "toko-uji.situsku.click",
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.data.category).toBe("phishing");
      expect(valid.data.reportedPath).toBe("/promo-hadiah");
      expect(valid.data.reporterEmail).toBe("pelapor@contoh.id");
    }

    // Same-host full URL normalizes cleanly to relative path
    const sameHostUrl = normalizeReportedPath(
      "https://toko-uji.situsku.click/blog/penipuan?utm_source=x#top",
      "toko-uji.situsku.click",
    );
    expect(sameHostUrl).toEqual({ ok: true, path: "/blog/penipuan" });

    // Cross-host URL is rejected
    const crossHostUrl = normalizeReportedPath(
      "https://evil.example.com/phish",
      "toko-uji.situsku.click",
    );
    expect(crossHostUrl.ok).toBe(false);

    // Query strings, fragments, and path traversals in reportedPath are rejected
    expect(normalizeReportedPath("/promo?a=1", "toko-uji.situsku.click").ok).toBe(false);
    expect(normalizeReportedPath("/../secret", "toko-uji.situsku.click").ok).toBe(false);
    expect(normalizeReportedPath("//evil.com/x", "toko-uji.situsku.click").ok).toBe(false);

    // Unknown fields rejected
    const unknownField = validatePublicAbuseReportInput(
      {
        category: "spam",
        reportedPath: "/",
        description: "Laporan spam berulang pada halaman utama.",
        extraField: "nope",
      },
      "toko-uji.situsku.click",
    );
    expect(unknownField.ok).toBe(false);

    // Invalid category & short description rejected
    const invalidFields = validatePublicAbuseReportInput(
      {
        category: "not_a_category",
        reportedPath: "/",
        description: "terlalu",
        reporterEmail: "bukan-email",
      },
      "toko-uji.situsku.click",
    );
    expect(invalidFields.ok).toBe(false);
    if (!invalidFields.ok) {
      expect(invalidFields.fields.map((f) => f.field)).toEqual(
        expect.arrayContaining(["category", "description", "reporterEmail"]),
      );
    }

    expect(ABUSE_CATEGORIES).toContain("phishing");
    expect(ABUSE_CATEGORIES).toContain("illegal_content");
  });

  it("masks reporter contact and produces PII-free moderation owner notice emails", () => {
    expect(maskReporterContact("pelapor.rahasiaku@example.com")).toBe("pe***@example.com");
    expect(maskReporterContact(null)).toBeNull();

    const email = buildAbuseModerationTenantNoticeEmail({
      ownerEmail: "owner@toko-uji.id",
      tenantName: "Toko Uji",
      tenantHandle: "toko-uji",
      action: "suspend",
      reportedPath: "/promo-palsu",
      reason:
        "Situs ditangguhkan karena laporan pelapor@rahasia.com dan token Bearer sk_live_1234567890abcdef.",
      reportId: "01JQ0000000000000000000001",
      appOrigin: "https://app.punyasitus.com",
    });

    expect(email.to).toBe("owner@toko-uji.id");
    expect(email.subject).toContain("ditangguhkan");
    expect(email.text).not.toContain("pelapor@rahasia.com");
    expect(email.text).not.toContain("sk_live_1234567890abcdef");
    expect(email.html).not.toContain("pelapor@rahasia.com");
    expect(email.html).toContain("/dashboard/toko-uji");
  });

  it("redacts emails, phone numbers, and secrets on tenant_activity_log reads", () => {
    const redacted = redactTenantActivityRow({
      id: 7,
      actor_user_id: "usr_owner_1",
      actor_role: "owner",
      action: "lead.deleted",
      resource_type: "lead",
      resource_id: "42",
      summary: "Hapus pesan dari budi@example.com / +6281234567890",
      metadata_json: JSON.stringify({
        leadId: 42,
        leadBody: "Isi pesan rahasia pelanggan",
        contactEmail: "budi@example.com",
        permanent: true,
      }),
      created_at: 1_763_000_000_000,
    });

    expect(redacted.summary).not.toContain("budi@example.com");
    expect(redacted.summary).not.toContain("081234567890");
    expect(redacted.metadata?.leadBody).toBe("[REDACTED]");
    expect(JSON.stringify(redacted.metadata)).not.toContain("budi@example.com");
    expect(redacted.metadata?.permanent).toBe(true);
    expect(redacted.actorUserId).toBe("usr_owner_1");

    // Finding 5: platform_operator actorUserId is ALWAYS masked to null for tenants
    const platformOpRow = redactTenantActivityRow({
      id: 8,
      actor_user_id: "usr_internal_superadmin_99",
      actor_role: "platform_operator",
      action: "moderation.content_unpublished",
      resource_type: "page",
      resource_id: "3",
      summary: "Halaman #3 dinonaktifkan oleh moderasi platform",
      metadata_json: JSON.stringify({ reportId: "01JQ0000000000000000000001" }),
      created_at: 1_763_000_000_100,
    });
    expect(platformOpRow.actorUserId).toBeNull();
    expect(platformOpRow.actorRole).toBe("platform_operator");

    // Finding 3: safe single decodeURIComponent normalization
    expect(safeDecodePathSegment("promo%2Dkhusus")).toBe("promo-khusus");
    expect(safeDecodePathSegment("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("uses base-nova primitives only with zero @radix-ui/* imports or asChild props in TASK-094 UI", () => {
    const uiFiles = [
      "apps/web/src/pages/console/abuse/index.astro",
      "apps/web/src/pages/console/abuse/_AbuseQueuePanel.tsx",
      "apps/web/src/pages/dashboard/[handle]/settings/activity/index.astro",
      "apps/web/src/pages/dashboard/[handle]/settings/activity/_ActivityLogPanel.tsx",
      "apps/web/src/pages/dashboard/[handle]/leads/index.astro",
      "apps/web/src/pages/dashboard/[handle]/leads/_LeadsInbox.tsx",
    ];
    for (const rel of uiFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src).not.toMatch(/@radix-ui\//);
      expect(src).not.toMatch(/\basChild\b/);
    }
  });
});
