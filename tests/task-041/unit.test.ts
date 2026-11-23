import fs from "node:fs";
import path from "node:path";
import {
  assertSafeTaxonomyDelete,
  buildTaxonomyTree,
  computeTaxonomyIndexable,
  getEligibleParentIds,
  getTaxonomyPublicBasePath,
  hasUsefulTaxonomyIntro,
  MAX_TAXONOMY_DEPTH,
  normalizeTaxonomySlug,
  TaxonomyDomainError,
  validateCreateTaxonomyFields,
  validateTaxonomyHierarchy,
  type TaxonomyHierarchyNode,
} from "@punyasitus/core/taxonomy/index";
import {
  TAXONOMY_ARCHIVE_SETTINGS_MIGRATION,
  TAXONOMY_ARCHIVE_SETTINGS_MIGRATION_SQL,
} from "@punyasitus/db/taxonomy/migrations";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("TASK-041 unit tests — Taxonomy Core Domain Rules & Static Guards", () => {
  it("enforces max depth 3, cycle prevention, and same offeringType parents", () => {
    const nodes: TaxonomyHierarchyNode[] = [
      { id: 1, kind: "post_category", offeringType: null, parentId: null, depth: 1 },
      { id: 2, kind: "post_category", offeringType: null, parentId: 1, depth: 2 },
      { id: 3, kind: "post_category", offeringType: null, parentId: 2, depth: 3 },
      { id: 4, kind: "post_category", offeringType: null, parentId: null, depth: 1 },
    ];

    expect(MAX_TAXONOMY_DEPTH).toBe(3);

    // Depth 1 -> 2 -> 3 succeeds
    const depth2 = validateTaxonomyHierarchy({
      kind: "post_category",
      offeringType: null,
      parentId: 1,
      allSameKindNodes: nodes,
    });
    expect(depth2.depth).toBe(2);

    const depth3 = validateTaxonomyHierarchy({
      kind: "post_category",
      offeringType: null,
      parentId: 2,
      allSameKindNodes: nodes,
    });
    expect(depth3.depth).toBe(3);

    // Depth 4 rejected with 422 TAXONOMY_CYCLE_OR_DEPTH
    let depth4Err: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "post_category",
        offeringType: null,
        parentId: 3,
        allSameKindNodes: nodes,
      });
    } catch (err) {
      depth4Err = err;
    }
    expect(depth4Err).toBeInstanceOf(TaxonomyDomainError);
    expect((depth4Err as TaxonomyDomainError).httpStatus).toBe(422);
    expect((depth4Err as TaxonomyDomainError).code).toBe("TAXONOMY_CYCLE_OR_DEPTH");

    // Self-parenting A -> A rejected with 422 TAXONOMY_CYCLE_OR_DEPTH
    let selfErr: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "post_category",
        offeringType: null,
        parentId: 1,
        selfId: 1,
        allSameKindNodes: nodes,
      });
    } catch (err) {
      selfErr = err;
    }
    expect(selfErr).toBeInstanceOf(TaxonomyDomainError);
    expect((selfErr as TaxonomyDomainError).code).toBe("TAXONOMY_CYCLE_OR_DEPTH");

    // Cycle A -> C -> B -> A rejected with 422 TAXONOMY_CYCLE_OR_DEPTH
    let cycleErr: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "post_category",
        offeringType: null,
        parentId: 3,
        selfId: 1,
        allSameKindNodes: nodes,
      });
    } catch (err) {
      cycleErr = err;
    }
    expect(cycleErr).toBeInstanceOf(TaxonomyDomainError);
    expect((cycleErr as TaxonomyDomainError).code).toBe("TAXONOMY_CYCLE_OR_DEPTH");

    // Moving subtree (id=2 has child id=3, height 1) under another depth-2 node would push child to depth 4
    const extended: TaxonomyHierarchyNode[] = [
      ...nodes,
      { id: 5, kind: "post_category", offeringType: null, parentId: 4, depth: 2 },
    ];
    let subtreeErr: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "post_category",
        offeringType: null,
        parentId: 5,
        selfId: 2,
        allSameKindNodes: extended,
      });
    } catch (err) {
      subtreeErr = err;
    }
    expect(subtreeErr).toBeInstanceOf(TaxonomyDomainError);
    expect((subtreeErr as TaxonomyDomainError).code).toBe("TAXONOMY_CYCLE_OR_DEPTH");
  });

  it("rejects non-null parentId on flat post_tag and mismatched offeringType parents", () => {
    // Flat tag parent rejection
    let tagErr: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "post_tag",
        offeringType: null,
        parentId: 1,
        allSameKindNodes: [],
      });
    } catch (err) {
      tagErr = err;
    }
    expect(tagErr).toBeInstanceOf(TaxonomyDomainError);
    expect((tagErr as TaxonomyDomainError).httpStatus).toBe(422);
    expect((tagErr as TaxonomyDomainError).code).toBe("INVALID_PARENT");

    // Offering category parent must match offeringType
    const catalogNodes: TaxonomyHierarchyNode[] = [
      { id: 10, kind: "offering_category", offeringType: "service", parentId: null, depth: 1 },
      { id: 11, kind: "offering_category", offeringType: "vehicle", parentId: null, depth: 1 },
    ];
    let mismatchErr: unknown;
    try {
      validateTaxonomyHierarchy({
        kind: "offering_category",
        offeringType: "vehicle",
        parentId: 10,
        allSameKindNodes: catalogNodes,
      });
    } catch (err) {
      mismatchErr = err;
    }
    expect(mismatchErr).toBeInstanceOf(TaxonomyDomainError);
    expect((mismatchErr as TaxonomyDomainError).httpStatus).toBe(422);
    expect((mismatchErr as TaxonomyDomainError).code).toBe("INVALID_PARENT");

    // Same offeringType parent succeeds
    const validCatalog = validateTaxonomyHierarchy({
      kind: "offering_category",
      offeringType: "vehicle",
      parentId: 11,
      allSameKindNodes: catalogNodes,
    });
    expect(validCatalog.depth).toBe(2);
  });

  it("normalizes slugs, builds sorted trees, computes eligible parents, and enforces PLAN §15.2 indexability", () => {
    expect(normalizeTaxonomySlug("post_category", "Kafe Caffè & Kuliner", 1)).toBe(
      "kafe-caffe-kuliner",
    );
    expect(normalizeTaxonomySlug("post_tag", "Promo 2026!", 2)).toBe("promo-2026");
    expect(getTaxonomyPublicBasePath("post_category", "kopi")).toBe("/blog/category/kopi");
    expect(getTaxonomyPublicBasePath("post_tag", "promo")).toBe("/blog/tag/promo");
    expect(getTaxonomyPublicBasePath("offering_category", "suv", "vehicle")).toBe(
      "/kendaraan/category/suv",
    );

    expect(hasUsefulTaxonomyIntro("Pendek")).toBe(false);
    expect(hasUsefulTaxonomyIntro("Panduan lengkap seputar operasional bisnis modern.")).toBe(true);
    expect(
      computeTaxonomyIndexable({
        indexOptIn: false,
        description: "Panduan lengkap seputar operasional bisnis modern.",
        publishedCount: 5,
      }),
    ).toBe(false);
    expect(
      computeTaxonomyIndexable({
        indexOptIn: true,
        description: "Terlalu singkat",
        publishedCount: 5,
      }),
    ).toBe(false);
    expect(
      computeTaxonomyIndexable({
        indexOptIn: true,
        description: "Panduan lengkap seputar operasional bisnis modern.",
        publishedCount: 0,
      }),
    ).toBe(false);
    expect(
      computeTaxonomyIndexable({
        indexOptIn: true,
        description: "Panduan lengkap seputar operasional bisnis modern.",
        publishedCount: 2,
      }),
    ).toBe(true);

    const items: TaxonomyHierarchyNode[] = [
      { id: 1, kind: "post_category", offeringType: null, parentId: null, depth: 1, sortOrder: 1, name: "Bisnis" },
      { id: 2, kind: "post_category", offeringType: null, parentId: 1, depth: 2, sortOrder: 0, name: "Pemasaran" },
      { id: 3, kind: "post_category", offeringType: null, parentId: 2, depth: 3, sortOrder: 0, name: "SEO Lokal" },
      { id: 4, kind: "post_category", offeringType: null, parentId: null, depth: 1, sortOrder: 0, name: "Arsitektur" },
    ];
    const tree = buildTaxonomyTree(items);
    expect(tree.roots.map((r) => r.item.id)).toEqual([4, 1]);
    expect(tree.flattened.map((n) => n.item.id)).toEqual([4, 1, 2, 3]);

    // Eligible parents for creating a new post_category: 1, 2, 4 (NOT 3 which is depth 3!)
    const eligibleForNew = getEligibleParentIds(items, {
      kind: "post_category",
      offeringType: null,
    });
    expect([...eligibleForNew].sort((a, b) => a - b)).toEqual([1, 2, 4]);

    // Eligible parents for editing node 2 (has child 3, height=1): only 1 and 4 (NOT self 2, NOT descendant 3!)
    const eligibleForNode2 = getEligibleParentIds(items, {
      kind: "post_category",
      offeringType: null,
      selfId: 2,
    });
    expect([...eligibleForNode2].sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it("enforces safe deletion guards (409 CATEGORY_HAS_CHILDREN and 409 TAXONOMY_IN_USE)", () => {
    expect(() =>
      assertSafeTaxonomyDelete(1, {
        childCount: 2,
        totalUsageCount: 0,
        publishedCount: 0,
        draftCount: 0,
        detach: true,
        reassignToId: 9,
      }),
    ).toThrowError(TaxonomyDomainError);

    try {
      assertSafeTaxonomyDelete(1, {
        childCount: 1,
        totalUsageCount: 0,
        publishedCount: 0,
        draftCount: 0,
        detach: false,
        reassignToId: null,
      });
    } catch (err) {
      expect((err as TaxonomyDomainError).httpStatus).toBe(409);
      expect((err as TaxonomyDomainError).code).toBe("CATEGORY_HAS_CHILDREN");
    }

    try {
      assertSafeTaxonomyDelete(2, {
        childCount: 0,
        totalUsageCount: 3,
        publishedCount: 2,
        draftCount: 1,
        detach: false,
        reassignToId: null,
      });
    } catch (err) {
      expect((err as TaxonomyDomainError).httpStatus).toBe(409);
      expect((err as TaxonomyDomainError).code).toBe("TAXONOMY_IN_USE");
    }

    // Passes when detach: true OR reassignToId is supplied
    expect(() =>
      assertSafeTaxonomyDelete(2, {
        childCount: 0,
        totalUsageCount: 3,
        publishedCount: 2,
        draftCount: 1,
        detach: true,
        reassignToId: null,
      }),
    ).not.toThrow();

    expect(() =>
      assertSafeTaxonomyDelete(2, {
        childCount: 0,
        totalUsageCount: 3,
        publishedCount: 2,
        draftCount: 1,
        detach: false,
        reassignToId: 5,
      }),
    ).not.toThrow();

    // Validates create payload & rejects forbidden tenant selectors
    expect(() =>
      validateCreateTaxonomyFields({
        kind: "post_category",
        name: "Valid",
        tenantId: "01JFORBIDDEN00000000000001",
      }),
    ).toThrow();
  });

  it("enforces static hygiene: zero @radix-ui/*, zero asChild, and zero runtime DDL in TASK-041 files", () => {
    const filesToCheck = [
      "packages/core/src/taxonomy/index.ts",
      "packages/db/src/taxonomy/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/categories/_shared.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/categories/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/categories/[categoryId].ts",
      "apps/web/src/pages/api/tenants/[tenantId]/tags/index.ts",
      "apps/web/src/pages/api/tenants/[tenantId]/tags/[tagId].ts",
      "apps/web/src/pages/dashboard/[handle]/posts/categories/_TaxonomyManagerClient.tsx",
      "apps/web/src/pages/dashboard/[handle]/posts/categories/index.astro",
      "apps/web/src/pages/dashboard/[handle]/posts/tags/index.astro",
      "apps/web/src/pages/dashboard/[handle]/catalog/categories/index.astro",
      "apps/web/src/pages/blog/category/_archive-resolver.ts",
      "apps/web/src/pages/blog/category/_BlogTaxonomyArchiveView.astro",
      "apps/web/src/pages/blog/category/[slug].astro",
      "apps/web/src/pages/blog/tag/[slug].astro",
      "apps/web/src/pages/layanan/category/_OfferingCategoryArchiveView.astro",
      "apps/web/src/pages/layanan/category/[slug].astro",
      "apps/web/src/pages/produk/category/[slug].astro",
      "apps/web/src/pages/tour/category/[slug].astro",
      "apps/web/src/pages/kendaraan/category/[slug].astro",
    ];

    for (const rel of filesToCheck) {
      const fullPath = path.join(REPO_ROOT, rel);
      expect(fs.existsSync(fullPath), `Missing file: ${rel}`).toBe(true);
      const src = fs.readFileSync(fullPath, "utf8");
      expect(src, `${rel} must not import @radix-ui/*`).not.toMatch(/@radix-ui\//);
      expect(src, `${rel} must not use asChild`).not.toMatch(/\basChild\b/);
      expect(src, `${rel} must not contain runtime CREATE TABLE / ALTER TABLE DDL`).not.toMatch(
        /\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i,
      );
    }

    // Verify `packages/db/src/taxonomy/index.ts` NEVER imports `migrations.ts` (zero runtime DDL!)
    const repoSrc = fs.readFileSync(path.join(REPO_ROOT, "packages/db/src/taxonomy/index.ts"), "utf8");
    expect(repoSrc).not.toMatch(/from\s+["']\.\/migrations(?:\.ts)?["']/);

    // Byte-for-byte parity between SQL migration file `0008_taxonomy_archive_settings.sql` and bundled TS string
    const migrationSqlFile = fs.readFileSync(
      path.join(REPO_ROOT, "packages/db/migrations/tenant/0008_taxonomy_archive_settings.sql"),
      "utf8",
    );
    expect(TAXONOMY_ARCHIVE_SETTINGS_MIGRATION.version).toBe(8);
    expect(TAXONOMY_ARCHIVE_SETTINGS_MIGRATION.name).toBe("0008_taxonomy_archive_settings");
    expect(TAXONOMY_ARCHIVE_SETTINGS_MIGRATION_SQL).toBe(migrationSqlFile);
  });
});
