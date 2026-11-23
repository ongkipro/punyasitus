import fs from "node:fs";
import path from "node:path";
import {
  buildRevisionSnapshotEnvelope,
  buildRevisionSummaryText,
  computeRetainedRevisionNumbers,
  CONTENT_REVISION_HISTORY_MIGRATION,
  CURRENT_REVISION_SCHEMA_VERSION,
  formatRevisionId,
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
  parseRevisionId,
  RevisionSchemaUnsupportedError,
  RevisionValidationError,
  sanitizeRevisionSnapshotReferences,
  TENANT_0023_CONTENT_REVISION_HISTORY_SQL,
  validateAndParseRevisionSnapshot,
} from "@punyasitus/db/revisions/index";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-064: Content Revision History Unit Checks", () => {
  it("matches packages/db/migrations/tenant/0023_content_revision_history.sql byte-for-byte and keeps TENANT_MIGRATIONS untouched", () => {
    const diskSql = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/tenant/0023_content_revision_history.sql"),
      "utf8",
    );
    expect(TENANT_0023_CONTENT_REVISION_HISTORY_SQL).toBe(diskSql);
    expect(CONTENT_REVISION_HISTORY_MIGRATION.version).toBe(23);
    expect(CONTENT_REVISION_HISTORY_MIGRATION.name).toBe("0023_content_revision_history");
    // Invariant: NEVER modify 0001_initial_tenant or TENANT_MIGRATIONS length/checksums
    expect(TENANT_MIGRATIONS).toHaveLength(1);
    expect(TENANT_MIGRATIONS[0]?.name).toBe("0001_initial_tenant");
  });

  it("parses and formats deterministic composite revision IDs strictly", () => {
    expect(formatRevisionId("page", 12, 5)).toBe("page-12-5");
    expect(parseRevisionId("page-12-5")).toEqual({
      resourceType: "page",
      resourceId: 12,
      revisionNumber: 5,
      canonicalId: "page-12-5",
    });
    expect(parseRevisionId("post:7:19")).toEqual({
      resourceType: "post",
      resourceId: 7,
      revisionNumber: 19,
      canonicalId: "post-7-19",
    });
    expect(parseRevisionId("offering-101-1")?.canonicalId).toBe("offering-101-1");

    // Reject invalid/malicious IDs
    expect(parseRevisionId("lead-1-1")).toBeNull();
    expect(parseRevisionId("page-0-1")).toBeNull();
    expect(parseRevisionId("page-1-0")).toBeNull();
    expect(parseRevisionId("page--1-1")).toBeNull();
    expect(parseRevisionId("page-1-99999999999")).toBeNull();
    expect(parseRevisionId("page-1-1; DROP TABLE pages")).toBeNull();
  });

  it("retains exact latest 20 revisions and prunes older revision numbers deterministically", () => {
    const twentyFive = Array.from({ length: 25 }, (_, i) => i + 1);
    const { keep, prune } = computeRetainedRevisionNumbers(twentyFive);
    expect(keep).toHaveLength(MAX_CONTENT_REVISIONS_PER_RESOURCE);
    expect(keep[0]).toBe(25);
    expect(keep[keep.length - 1]).toBe(6);
    expect(prune).toEqual([5, 4, 3, 2, 1]);

    const ten = [3, 1, 10, 7, 2, 10];
    const small = computeRetainedRevisionNumbers(ten);
    expect(small.keep).toEqual([10, 7, 3, 2, 1]);
    expect(small.prune).toEqual([]);
  });

  it("strips sensitive/lead/secret keys when building revision snapshot envelopes", () => {
    const built = buildRevisionSnapshotEnvelope({
      resourceType: "page",
      triggerKind: "save",
      data: {
        slug: "tentang-kami",
        title: "Tentang Kami",
        isHomepage: false,
        layoutMode: "standard",
        sections: [],
        seo: null,
        password: "secret-password",
        apiKey: "sk_live_xxx",
        leads: [{ name: "Budi", phone: "+62812" }],
        phone_e164: "+628123456789",
        writeToken: "tok_123",
      },
    });
    expect(built.schemaVersion).toBe(CURRENT_REVISION_SCHEMA_VERSION);
    expect(built.summary).toContain("Simpan draf");
    const parsed = JSON.parse(built.json) as { data: Record<string, unknown> };
    expect(parsed.data.title).toBe("Tentang Kami");
    expect(parsed.data.password).toBeUndefined();
    expect(parsed.data.apiKey).toBeUndefined();
    expect(parsed.data.leads).toBeUndefined();
    expect(parsed.data.phone_e164).toBeUndefined();
    expect(parsed.data.writeToken).toBeUndefined();

    expect(
      buildRevisionSummaryText({
        resourceType: "post",
        triggerKind: "restore",
        title: "Tips SEO",
        slug: "tips-seo",
        restoredFromRevisionNumber: 4,
      }),
    ).toContain("revisi #4");
  });

  it("validates supported schemaVersion 1 snapshots and rejects corrupted or unsupported schemas with 422", () => {
    const validPageJson = buildRevisionSnapshotEnvelope({
      resourceType: "page",
      triggerKind: "save",
      data: {
        slug: "profil-perusahaan",
        title: "Profil Perusahaan",
        isHomepage: false,
        layoutMode: "standard",
        sections: [
          {
            id: "hero-1",
            kind: "hero",
            heading: "Solusi B2B Terpercaya",
            subheading: "Layanan resmi bergaransi",
            bodyHtml: null,
            ctaLabel: "Hubungi Kami",
            ctaHref: "/kontak",
          },
        ],
        seo: null,
      },
    }).json;

    const validated = validateAndParseRevisionSnapshot("page", validPageJson, {
      rowSchemaVersion: 1,
      rowTriggerKind: "save",
    });
    expect(validated.resourceType).toBe("page");
    expect(validated.schemaVersion).toBe(1);
    expect(validated.data.title).toBe("Profil Perusahaan");

    // Unsupported row schema version -> 422 RevisionSchemaUnsupportedError
    expect(() =>
      validateAndParseRevisionSnapshot("page", validPageJson, { rowSchemaVersion: 99 }),
    ).toThrow(RevisionSchemaUnsupportedError);

    // Unsupported envelope schemaVersion -> 422 RevisionSchemaUnsupportedError
    const futureEnvelope = JSON.stringify({
      snapshotVersion: 2,
      schemaVersion: 2,
      resourceType: "page",
      data: { slug: "a", title: "A", isHomepage: false, layoutMode: "standard", sections: [] },
    });
    expect(() => validateAndParseRevisionSnapshot("page", futureEnvelope)).toThrow(
      RevisionSchemaUnsupportedError,
    );

    // Corrupted JSON -> 422 RevisionValidationError
    expect(() => validateAndParseRevisionSnapshot("page", "{broken json")).toThrow(
      RevisionValidationError,
    );

    // Resource type mismatch -> 422 RevisionValidationError
    expect(() => validateAndParseRevisionSnapshot("post", validPageJson)).toThrow(
      RevisionValidationError,
    );

    // Forbidden tenant selector inside snapshot -> 422 RevisionValidationError
    const crossTenantEnvelope = JSON.stringify({
      snapshotVersion: 1,
      schemaVersion: 1,
      resourceType: "page",
      data: {
        slug: "profil",
        title: "Profil",
        tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        isHomepage: false,
        layoutMode: "standard",
        sections: [],
      },
    });
    expect(() => validateAndParseRevisionSnapshot("page", crossTenantEnvelope)).toThrow(
      RevisionValidationError,
    );
  });

  it("sanitizes missing media, taxonomy, and author references cleanly on post and offering snapshots", () => {
    const postEnvelope = buildRevisionSnapshotEnvelope({
      resourceType: "post",
      triggerKind: "save",
      data: {
        slug: "panduan-kantor",
        title: "Panduan Renovasi Kantor",
        excerpt: "Ringkasan artikel",
        body: {
          schemaVersion: 1,
          blocks: [
            { type: "paragraph", text: "Paragraf pembuka yang tetap aman." },
            { type: "image", mediaId: 999, text: "Foto yang sudah dihapus" },
            { type: "image", mediaId: 101, text: "Foto yang masih ada" },
          ],
        },
        primaryCategoryId: 50,
        categoryIds: [50, 51],
        tagIds: [60, 61],
        authorId: 70,
        coverMediaId: 999,
        readingTimeMinutes: 2,
        showToc: true,
        seo: { ogImageMediaId: 888 },
      },
    }).json;

    const parsedPost = validateAndParseRevisionSnapshot("post", postEnvelope);
    const { sanitized, report } = sanitizeRevisionSnapshotReferences(parsedPost, {
      mediaById: new Map([
        [101, { status: "ready", deletedAt: null }],
        [102, { status: "ready", deletedAt: 1700000000000 }],
      ]),
      taxonomyById: new Map([
        [51, { taxonomyType: "post_category", offeringType: null }],
        [61, { taxonomyType: "post_tag", offeringType: null }],
      ]),
      existingAuthorIds: new Set<number>(),
    });

    expect(sanitized.resourceType).toBe("post");
    if (sanitized.resourceType !== "post") throw new Error("Expected post snapshot");
    expect(sanitized.data.coverMediaId).toBeNull();
    expect(sanitized.data.seo?.ogImageMediaId).toBeNull();
    expect(sanitized.data.body.blocks).toHaveLength(2);
    expect(sanitized.data.primaryCategoryId).toBe(51);
    expect(sanitized.data.categoryIds).toEqual([51]);
    expect(sanitized.data.tagIds).toEqual([61]);
    expect(sanitized.data.authorId).toBeNull();
    expect(report.missingMediaIds).toEqual([888, 999]);
    expect(report.detachedMediaIds).toEqual([888, 999]);
    expect(report.missingTaxonomyIds).toEqual([50, 60]);
    expect(report.missingAuthorId).toBe(70);
    expect(report.warnings.length).toBeGreaterThanOrEqual(4);

    // Strict mode (`detachMissingReferences: false`) rejects missing refs with 422
    expect(() =>
      sanitizeRevisionSnapshotReferences(
        parsedPost,
        {
          mediaById: new Map([[101, { status: "ready", deletedAt: null }]]),
          taxonomyById: new Map(),
          existingAuthorIds: new Set<number>(),
        },
        { detachMissingReferences: false },
      ),
    ).toThrow(RevisionValidationError);
  });

  it("recursively strips missing, trashed, failed, and quarantined media IDs across page sections, post trees, and offering attributes/verticalAttributes", () => {
    // 1. Page with section.bodyHtml containing valid (#101), missing (#999), trashed (#102), and quarantined (#103)
    const pageEnvelope = buildRevisionSnapshotEnvelope({
      resourceType: "page",
      triggerKind: "save",
      data: {
        slug: "galeri-kami",
        title: "Galeri Proyek",
        isHomepage: false,
        layoutMode: "standard",
        sections: [
          {
            id: "sec-rich-1",
            kind: "rich_text",
            heading: "Portofolio",
            subheading: null,
            bodyHtml:
              '<p>Teks aman.</p><figure><img src="/media/101" alt="Foto valid"></figure><figure><img src="/media/999" alt="Foto hilang"></figure><figure><img src="/media/102" alt="Foto sampah"></figure><figure><img src="/media/103" alt="Foto karantina"></figure>',
          },
        ],
        seo: { ogImageMediaId: 102 },
      },
    }).json;

    const mediaLookup = new Map([
      [101, { status: "ready", deletedAt: null }],
      [102, { status: "ready", deletedAt: 1700000000000 }],
      [103, { status: "quarantined", deletedAt: null }],
      [104, { status: "failed", deletedAt: null }],
    ]);

    const parsedPage = validateAndParseRevisionSnapshot("page", pageEnvelope);
    const pageSan = sanitizeRevisionSnapshotReferences(parsedPage, {
      mediaById: mediaLookup,
      taxonomyById: new Map(),
      existingAuthorIds: new Set(),
    });
    if (pageSan.sanitized.resourceType !== "page") throw new Error("Expected page");
    const sanitizedHtml = pageSan.sanitized.data.sections[0]?.bodyHtml ?? "";
    expect(sanitizedHtml).toContain("/media/101");
    expect(sanitizedHtml).not.toContain("/media/999");
    expect(sanitizedHtml).not.toContain("/media/102");
    expect(sanitizedHtml).not.toContain("/media/103");
    expect(pageSan.sanitized.data.seo?.ogImageMediaId).toBeNull();
    expect(pageSan.report.missingMediaIds).toEqual([999]);
    expect(pageSan.report.trashedMediaIds).toEqual([102]);
    expect(pageSan.report.unavailableMediaIds).toEqual([103]);
    expect(pageSan.report.detachedMediaIds).toEqual([102, 103, 999]);

    // Strict mode (`detachMissingReferences: false`) rejects trashed/quarantined media with 422 too
    expect(() =>
      sanitizeRevisionSnapshotReferences(
        parsedPage,
        {
          mediaById: new Map([
            [101, { status: "ready", deletedAt: null }],
            [999, { status: "ready", deletedAt: null }],
            [102, { status: "ready", deletedAt: 1700000000000 }],
            [103, { status: "ready", deletedAt: null }],
          ]),
          taxonomyById: new Map(),
          existingAuthorIds: new Set(),
        },
        { detachMissingReferences: false },
      ),
    ).toThrow(RevisionValidationError);

    // 2. Offering with missing/trashed/failed media in cover, gallery, AND nested attributes/verticalAttributes
    const parsedOffering = validateAndParseRevisionSnapshot(
      "offering",
      buildRevisionSnapshotEnvelope({
        resourceType: "offering",
        triggerKind: "save",
        data: {
          offeringType: "service",
          slug: "jasa-desain",
          title: "Jasa Desain B2B",
          coverMediaId: 999,
          galleryMediaIds: [101, 102, 104],
          priceMode: "fixed",
          price: 2_500_000,
          ctaMode: "whatsapp",
          attributes: { duration: "2 minggu" },
          seo: { ogImageMediaId: 103 },
        },
      }).json,
      { tenantWhatsAppE164: "+6281234567890" },
    );
    if (parsedOffering.resourceType !== "offering") throw new Error("Expected offering");
    // Inject nested media keys inside verticalAttributes & validatedOffering.attributes (simulating legacy/extended attrs)
    const offeringWithAttrMedia: typeof parsedOffering = {
      ...parsedOffering,
      data: {
        ...parsedOffering.data,
        verticalAttributes: {
          ...parsedOffering.data.verticalAttributes,
          brochureMediaId: 999,
          sampleMediaIds: [101, 104],
        },
      },
      validatedOffering: {
        ...parsedOffering.validatedOffering,
        attributes: {
          ...(parsedOffering.validatedOffering.attributes as Record<string, unknown>),
          brochureMediaId: 999,
          sampleMediaIds: [101, 104],
        } as unknown as typeof parsedOffering.validatedOffering.attributes,
      },
    };

    const offSan = sanitizeRevisionSnapshotReferences(offeringWithAttrMedia, {
      mediaById: mediaLookup,
      taxonomyById: new Map(),
      existingAuthorIds: new Set(),
    });
    if (offSan.sanitized.resourceType !== "offering") throw new Error("Expected offering");
    expect(offSan.sanitized.data.coverMediaId).toBeNull();
    expect(offSan.sanitized.data.galleryMediaIds).toEqual([101]);
    expect(offSan.sanitized.data.seo?.ogImageMediaId).toBeNull();
    const cleanedAttrs = offSan.sanitized.validatedOffering.attributes as Record<string, unknown>;
    expect(cleanedAttrs.brochureMediaId).toBeUndefined();
    expect(cleanedAttrs.sampleMediaIds).toEqual([101]);
    const cleanedVertAttrs = (offSan.sanitized.data.verticalAttributes ?? {}) as Record<string, unknown>;
    expect(cleanedVertAttrs.brochureMediaId).toBeUndefined();
    expect(cleanedVertAttrs.sampleMediaIds).toEqual([101]);
    expect(offSan.report.detachedMediaIds).toEqual([102, 103, 104, 999]);
  });

  it("enforces base-nova guardrails on RevisionHistoryPanel (zero Sparkles, zero Radix, zero asChild)", () => {
    const panelPath = path.join(
      REPO_ROOT,
      "apps/web/src/components/admin/revisions/RevisionHistoryPanel.tsx",
    );
    const source = fs.readFileSync(panelPath, "utf8");
    expect(source).toContain("@base-ui/react/dialog");
    expect(source).not.toMatch(/@radix-ui\//);
    expect(source).not.toMatch(/\bSparkles\b/);
    expect(source).not.toMatch(/\basChild\b/);
    expect(source).toContain(
      "Pulihkan sebagai Draf — tidak mengubah halaman publik sebelum Anda klik Terbitkan",
    );
  });
});
