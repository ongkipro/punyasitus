import {
  attachServiceConsultationToDraftSnapshotJson,
  toCatalogServiceAttributes,
} from "@punyasitus/core/catalog/service";
import {
  attachTravelPackageToDraftSnapshotJson,
  toCatalogTourAttributes,
} from "@punyasitus/core/catalog/travel";
import {
  buildPublishedSnapshot,
  extractDraftSnapshotForAdmin,
  extractPublishedSnapshot,
  PublicationAtomicError,
  PublicationValidationError,
  serializeDraftStoragePayload,
  StaleRevisionError,
  type PageSnapshot,
} from "@punyasitus/core/content/index";
import { buildMenuTree } from "@punyasitus/core/menu-builder";
import {
  ApplyVerticalStarterPresetInputSchema,
  buildVerticalStarterComposition,
  computeSampleSectionIds,
  computeVerticalPresetSetupHash,
  convertValidatedSectionToPublicPageSectionDto,
  detectSampleClaimsInSection,
  disableSampleSectionsForPageDraft,
  evaluateVerticalLaunchChecklist,
  isOptionalVerticalSection,
  mergePublishedPageSectionsNonDestructively,
  mergeStarterPresetDraftSections,
  PresetDomainError,
  PublishStarterPresetInputSchema,
  resolveCanonicalVerticalPresetId,
  toStorageStarterPresetId,
  validateVerticalPresetSelectivePublish,
  VERTICAL_STARTER_PRESET_CATALOG,
  type ApplyVerticalStarterPresetInput,
  type BuiltVerticalStarterComposition,
  type PresetSetupStatus,
  type PublishStarterPresetInput,
  type StoredPresetApplyMode,
  type VerticalLaunchChecklistSummary,
  type VerticalStarterPresetCatalogEntry,
  type VerticalStarterPresetId,
} from "@punyasitus/core/presets/index";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import { extractGroupedSettingsExtension } from "@punyasitus/core/settings/index";
import {
  isHealthBusinessCategory,
  validatePageSections,
  type AnyValidatedPageSection,
  type SectionValidationWarning,
} from "@punyasitus/core/theme/sections";
import { validateIndonesianWhatsAppNumber } from "@punyasitus/core/wa-dispatcher";
import { createCatalogOffering } from "../catalog/index.ts";
import { isUniqueConstraintError } from "../identifiers/index.ts";
import { createOutlet, listOutletsForAdmin } from "../outlets/index.ts";
import { bumpTenantCacheVersion } from "../publication/index.ts";
import type { PresetMemberScope, PresetSectionStatusDto } from "./index.ts";
import { ensureStarterPresetsTables, hasStarterPresetsTables } from "./migrations.ts";

/**
 * M2 Additional Vertical Starter Presets Repository (`packages/db/src/presets/verticals.ts`;
 * TASK-066, REQ-047, REQ-028, REQ-029, REQ-030; PLAN §11.4).
 *
 * Guarantees:
 * - Zero new SQL migrations: reuses existing `TenantStore` tables (`preset_setups`,
 *   `preset_setup_operations`, `pages`, `offerings`, `branches`, `menus`, `sequences`,
 *   `site_settings`, `business_profile`, `tenant_activity_log`).
 * - Idempotent & crash/replay-safe by `(tenantId, presetId, setupKey)`: vertical draft
 *   offerings/outlets are seeded (with slug reuse on crash retry) BEFORE recording
 *   `preset_setup_operations` so a failed seed NEVER poisons the idempotency ledger.
 * - Strictly DRAFT-ONLY on apply: every created page, offering, and outlet has
 *   `status = 'draft'`, `published_* = NULL`, `published_at = NULL`, SQL `branches.active = 0`,
 *   draft header menu leaves `items_json = '[]'`, and ZERO `cache_version` publish bumps.
 * - Populated-tenant protection: existing pages, offerings, and outlets are NEVER
 *   overwritten, unpublished, or deleted; publishing merges non-destructively into both
 *   `published_sections_json` AND `draft_sections_json` metadata.
 * - Switching to a different vertical preset requires explicit `confirmSwitch: true`,
 *   preserves user-edited non-sample draft sections, and resets `preset_setups` status to
 *   `draft` with `published_section_ids_json = '[]'`.
 * - Publish failure during `bumpTenantCacheVersion` executes full compensating rollback
 *   restoring `preset_setups`, `pages`, and deleting the inserted `content_revisions` row.
 */

const MAX_RETAINED_REVISIONS = 20;

export interface VerticalContentSummaryDto {
  readonly pages: number;
  readonly publishedPages: number;
  readonly posts: number;
  readonly offerings: number;
  readonly serviceOfferings: number;
  readonly publishedServiceOfferings: number;
  readonly tourOfferings: number;
  readonly publishedTourOfferings: number;
  readonly outlets: number;
  readonly publishedOutlets: number;
  readonly menus: number;
  readonly media: number;
  readonly hasExistingHomepage: boolean;
  readonly homepageIsPublished: boolean;
  readonly isPopulatedTenant: boolean;
}

export interface VerticalPresetSetupStateDto {
  readonly presetId: VerticalStarterPresetId;
  readonly storagePresetId: "company_profile" | "services" | "travel" | "outlets";
  readonly applyMode: StoredPresetApplyMode;
  readonly status: PresetSetupStatus;
  readonly version: number;
  readonly lastOperationKey: string | null;
  readonly previewedAt: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sections: readonly PresetSectionStatusDto[];
  readonly sampleSectionIds: readonly string[];
  readonly selectedPublishSectionIds: readonly string[];
  readonly publishedSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
}

export interface VerticalPresetDashboardStateDto {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly vertical: string;
  readonly businessCategory: string;
  readonly isHealthCategory: boolean;
  readonly activeThemeId: string;
  readonly cacheVersion: number;
  readonly recommendedPresetId: VerticalStarterPresetId;
  readonly catalog: readonly VerticalStarterPresetCatalogEntry[];
  readonly setup: VerticalPresetSetupStateDto | null;
  readonly checklist: VerticalLaunchChecklistSummary;
  readonly checklistByPreset: Readonly<
    Record<VerticalStarterPresetId, VerticalLaunchChecklistSummary>
  >;
  readonly contentSummary: VerticalContentSummaryDto;
  readonly permissions: {
    readonly canRead: boolean;
    readonly canPreview: boolean;
    readonly canMutate: boolean;
    readonly isLocked: boolean;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  };
}

export interface ApplyVerticalStarterPresetResult {
  readonly presetId: VerticalStarterPresetId;
  readonly setupKey: string;
  readonly operationKey: string;
  readonly applyMode: StoredPresetApplyMode;
  readonly alreadyApplied: boolean;
  readonly idempotentReplay: boolean;
  readonly createdHomepageDraft: boolean;
  readonly createdPageSlugs: readonly string[];
  readonly createdOfferingSlugs: readonly string[];
  readonly createdOutletSlugs: readonly string[];
  readonly createdHeaderMenuDraft: boolean;
  readonly preservedExistingContent: boolean;
  readonly state: VerticalPresetDashboardStateDto;
}

export interface PublishVerticalStarterPresetResult {
  readonly presetId: VerticalStarterPresetId;
  readonly state: VerticalPresetDashboardStateDto;
  readonly publishedSectionIds: readonly string[];
  readonly unpublishedDraftSectionIds: readonly string[];
  readonly cacheVersion: number;
  readonly publishedAt: string;
  readonly revisionNumber: number;
}

interface RawVerticalPresetSetupRow {
  readonly id: number;
  readonly preset_id: "company_profile" | "services" | "travel" | "outlets";
  readonly apply_mode: StoredPresetApplyMode;
  readonly status: PresetSetupStatus;
  readonly draft_sections_json: string;
  readonly sample_section_ids_json: string;
  readonly selected_publish_section_ids_json: string;
  readonly published_section_ids_json: string | null;
  readonly last_operation_key: string | null;
  readonly previewed_at: number | null;
  readonly published_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RawVerticalOperationRow {
  readonly operation_key: string;
  readonly preset_id: string;
  readonly apply_mode: string;
  readonly request_hash: string;
  readonly result_json: string;
  readonly created_at: number;
}

interface RawHomepageRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly is_homepage: number;
  readonly draft_sections_json: string;
  readonly published_sections_json: string | null;
  readonly seo_json: string | null;
  readonly status: "draft" | "published" | "trashed";
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly deleted_at: number | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface StoredVerticalOperationRecord {
  readonly presetId: VerticalStarterPresetId;
  readonly applyMode: StoredPresetApplyMode;
  readonly createdHomepageDraft: boolean;
  readonly createdPageSlugs: readonly string[];
  readonly createdOfferingSlugs: readonly string[];
  readonly createdOutletSlugs: readonly string[];
  readonly createdHeaderMenuDraft: boolean;
  readonly preservedExistingContent: boolean;
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(Number(ms)).toISOString();
}

function parseStringArray(raw: string | null | undefined): string[] {
  const parsed = safeParseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mapTenantVerticalToRecommendedPreset(vertical: string): VerticalStarterPresetId {
  switch (vertical.trim().toLowerCase()) {
    case "sales":
    case "services":
      return "professional_services";
    case "travel":
      return "travel_umrah";
    case "resto":
    case "outlets":
      return "multi_outlet";
    default:
      return "company_profile";
  }
}

async function queryCount(tenantDb: D1Database, sql: string): Promise<number> {
  try {
    const row = await tenantDb.prepare(sql).first<{ readonly count?: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

async function resolveUniquePageSlug(tenantDb: D1Database, desiredSlug: string): Promise<string> {
  const clean = desiredSlug.trim().toLowerCase() || "halaman-preset";
  const rows = await tenantDb
    .prepare("SELECT slug FROM pages WHERE slug = ? OR slug LIKE ?")
    .bind(clean, `${clean}-%`)
    .all<{ readonly slug: string }>();
  const taken = new Set(rows.results.map((r) => r.slug.toLowerCase()));
  if (!taken.has(clean)) return clean;
  if (!taken.has(`${clean}-preset`)) return `${clean}-preset`;
  for (let i = 2; i <= 1000; i += 1) {
    const candidate = `${clean}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${clean}-${Date.now().toString(36)}`;
}

function computePublicSectionsSignature(
  sections: readonly PageSnapshot["sections"][number][],
): string {
  return JSON.stringify(
    sections.map((s) => ({
      id: s.id,
      kind: s.kind,
      heading: s.heading ?? null,
      subheading: s.subheading ?? null,
      bodyHtml: s.bodyHtml ?? null,
      ctaLabel: s.ctaLabel ?? null,
      ctaHref: s.ctaHref ?? null,
    })),
  );
}

function buildPageSnapshotForDraftOrPublish(
  sections: readonly AnyValidatedPageSection[],
  meta: {
    readonly slug: string;
    readonly title: string;
    readonly isHomepage: boolean;
    readonly seo: PageSnapshot["seo"];
    readonly existingPublicSections?: readonly PageSnapshot["sections"][number][];
  },
): PageSnapshot {
  const incomingPublic = sections
    .filter((s) => s.enabled)
    .map((s) => convertValidatedSectionToPublicPageSectionDto(s));
  const mergedPublic =
    meta.existingPublicSections && meta.existingPublicSections.length > 0
      ? mergePublishedPageSectionsNonDestructively(meta.existingPublicSections, incomingPublic)
      : incomingPublic;

  return {
    slug: meta.slug,
    title: meta.title,
    isHomepage: meta.isHomepage,
    layoutMode: "standard",
    sections: [...mergedPublic],
    ...(meta.seo ? { seo: meta.seo } : {}),
  };
}

/**
 * Non-destructively merges incoming preset draft sections with any existing
 * tenant-authored homepage draft sections (preserving all non-preset tenant draft
 * blocks, updating matching preset IDs in place, and avoiding duplicate singleton `hero`).
 */
function mergeHomepageDraftSectionsNonDestructively(
  existingDraftSections: readonly AnyValidatedPageSection[],
  incomingSections: readonly AnyValidatedPageSection[],
  businessCategory: string,
): readonly AnyValidatedPageSection[] {
  if (existingDraftSections.length === 0) {
    return incomingSections;
  }
  const incomingById = new Map<string, AnyValidatedPageSection>();
  for (const s of incomingSections) {
    incomingById.set(s.id, s);
  }

  const placedIds = new Set<string>();
  const combinedRaw: {
    id: string;
    type: AnyValidatedPageSection["type"];
    schemaVersion: number;
    enabled: boolean;
    order: number;
    config: unknown;
  }[] = [];

  for (const existing of existingDraftSections) {
    const replacement = incomingById.get(existing.id);
    if (replacement) {
      combinedRaw.push({
        id: replacement.id,
        type: replacement.type,
        schemaVersion: replacement.schemaVersion,
        enabled: replacement.enabled,
        order: combinedRaw.length,
        config: replacement.config,
      });
      placedIds.add(existing.id);
    } else {
      combinedRaw.push({
        id: existing.id,
        type: existing.type,
        schemaVersion: existing.schemaVersion,
        enabled: existing.enabled,
        order: combinedRaw.length,
        config: existing.config,
      });
    }
  }

  const hasHero = combinedRaw.some((s) => s.type === "hero");
  for (const incoming of incomingSections) {
    if (placedIds.has(incoming.id)) continue;
    if (incoming.type === "hero" && hasHero) continue;
    combinedRaw.push({
      id: incoming.id,
      type: incoming.type,
      schemaVersion: incoming.schemaVersion,
      enabled: incoming.enabled,
      order: combinedRaw.length,
      config: incoming.config,
    });
    placedIds.add(incoming.id);
  }

  return validatePageSections(combinedRaw, { businessCategory }).sections;
}

function serializeSampleSafePageDraftEnvelope(params: {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly nextVersion: number;
  readonly slug: string;
  readonly title: string;
  readonly isHomepage: boolean;
  readonly seo: PageSnapshot["seo"];
  readonly businessCategory?: string;
  readonly existingPublicDraftSections?: readonly PageSnapshot["sections"][number][];
  readonly existingDraftMetadata?: Readonly<Record<string, unknown>> | null;
}): { readonly json: string; readonly snapshot: PageSnapshot } {
  const sampleSafeIncoming = disableSampleSectionsForPageDraft(params.sections);

  // Preserve any pre-existing tenant-authored validated draft sections & custom metadata keys!
  const priorMeta = params.existingDraftMetadata ?? null;
  let mergedMetaSections: readonly AnyValidatedPageSection[] = sampleSafeIncoming;
  if (priorMeta && typeof priorMeta.draftSectionsJson === "string") {
    const parsedPriorMeta = safeParseJson<{ readonly sections?: unknown[] }>(
      priorMeta.draftSectionsJson,
      {},
    );
    if (Array.isArray(parsedPriorMeta.sections) && parsedPriorMeta.sections.length > 0) {
      try {
        const existingValidated = validatePageSections(parsedPriorMeta.sections, {
          businessCategory: params.businessCategory,
        }).sections;
        mergedMetaSections = mergeHomepageDraftSectionsNonDestructively(
          existingValidated,
          sampleSafeIncoming,
          params.businessCategory ?? "LocalBusiness",
        );
      } catch {
        mergedMetaSections = sampleSafeIncoming;
      }
    }
  }

  const snapshot = buildPageSnapshotForDraftOrPublish(sampleSafeIncoming, {
    slug: params.slug,
    title: params.title,
    isHomepage: params.isHomepage,
    seo: params.seo,
    existingPublicSections: params.existingPublicDraftSections,
  });

  const draftSectionsMetaJson = JSON.stringify({
    schemaVersion: 1,
    sourceVersion: params.nextVersion,
    enabledSignature: computePublicSectionsSignature(snapshot.sections),
    sections: mergedMetaSections,
  });

  // Preserve extra non-conflicting draft metadata keys from prior tenant draft
  const preservedExtraMeta: Record<string, unknown> = {};
  if (priorMeta) {
    for (const [k, v] of Object.entries(priorMeta)) {
      if (k !== "draftSectionsJson") {
        preservedExtraMeta[k] = v;
      }
    }
  }

  const payload = serializeDraftStoragePayload("page", {
    ...snapshot,
    ...preservedExtraMeta,
    draftSectionsJson: draftSectionsMetaJson,
  });

  return {
    json: payload.json,
    snapshot,
  };
}

function isCustomizedNonSampleSection(section: AnyValidatedPageSection): boolean {
  if (detectSampleClaimsInSection(section).length > 0) return false;
  // Empty disabled optional placeholders are not user-authored edits
  if (
    !section.enabled &&
    (section.type === "gallery" ||
      section.type === "trust_logos" ||
      section.type === "testimonials") &&
    section.config.items.length === 0
  ) {
    return false;
  }
  return true;
}

async function loadPlatformContext(
  platformDb: D1Database,
  tenantId: string,
  fallbackHandle: string,
): Promise<{
  readonly vertical: string;
  readonly cacheVersion: number;
  readonly activeCustomHostname: string | null;
  readonly fallbackHost: string;
  readonly operatorVerifiedPpiu: boolean;
}> {
  const tenantRow = await platformDb
    .prepare("SELECT handle, vertical, cache_version FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{
      readonly handle: string;
      readonly vertical: string | null;
      readonly cache_version: number | null;
    }>();

  let operatorVerifiedPpiu = false;
  try {
    const ppiuRow = await platformDb
      .prepare("SELECT operator_verified_ppiu FROM tenants WHERE id = ? LIMIT 1")
      .bind(tenantId)
      .first<{ readonly operator_verified_ppiu?: number | null }>();
    operatorVerifiedPpiu = Number(ppiuRow?.operator_verified_ppiu ?? 0) === 1;
  } catch {
    // Column may not exist on older platform fixtures; keep fail-closed default `false`
  }

  const hostsRes = await platformDb
    .prepare(
      `SELECT host, kind, status, ssl_status, is_primary
       FROM tenant_hosts
       WHERE tenant_id = ?
       ORDER BY is_primary DESC, created_at ASC`,
    )
    .bind(tenantId)
    .all<{
      readonly host: string;
      readonly kind: "subdomain" | "custom";
      readonly status: string;
      readonly ssl_status: string;
      readonly is_primary: number;
    }>();

  const activeCustom = hostsRes.results.find(
    (h) => h.kind === "custom" && h.status === "active" && h.ssl_status === "active",
  );
  const subdomainHost = hostsRes.results.find((h) => h.kind === "subdomain");
  const handle = tenantRow?.handle?.trim() || fallbackHandle;

  return {
    vertical: tenantRow?.vertical?.trim() || "compro",
    cacheVersion: Number(tenantRow?.cache_version ?? 1),
    activeCustomHostname: activeCustom?.host ?? null,
    fallbackHost: subdomainHost?.host ?? `${handle}.situsku.click`,
    operatorVerifiedPpiu,
  };
}

async function loadRawSetupRow(tenantDb: D1Database): Promise<RawVerticalPresetSetupRow | null> {
  if (!(await hasStarterPresetsTables(tenantDb))) {
    return null;
  }
  const row = await tenantDb
    .prepare(
      `SELECT id, preset_id, apply_mode, status, draft_sections_json,
              sample_section_ids_json, selected_publish_section_ids_json,
              published_section_ids_json, last_operation_key, previewed_at,
              published_at, version, created_at, updated_at
       FROM preset_setups
       WHERE id = 1
       LIMIT 1`,
    )
    .first<RawVerticalPresetSetupRow>();
  return row ?? null;
}

async function loadActiveHomepageRow(tenantDb: D1Database): Promise<RawHomepageRow | null> {
  const row = await tenantDb
    .prepare(
      `SELECT id, slug, title, is_homepage, draft_sections_json, published_sections_json,
              seo_json, status, published_at, content_modified_at, deleted_at,
              version, created_at, updated_at
       FROM pages
       WHERE is_homepage = 1 AND deleted_at IS NULL
       LIMIT 1`,
    )
    .first<RawHomepageRow>();
  return row ?? null;
}

function hydrateVerticalSetupDto(
  row: RawVerticalPresetSetupRow,
  businessCategory: string,
): VerticalPresetSetupStateDto {
  const canonicalPresetId =
    resolveCanonicalVerticalPresetId(row.preset_id) ?? "company_profile";
  const rawSections = safeParseJson<unknown[]>(row.draft_sections_json, []);
  const validated = validatePageSections(rawSections, { businessCategory });
  const selectedIds = new Set(parseStringArray(row.selected_publish_section_ids_json));
  const publishedIds = new Set(parseStringArray(row.published_section_ids_json));
  const computedSampleIds = new Set(computeSampleSectionIds(validated.sections));

  const sections: PresetSectionStatusDto[] = validated.sections.map((section) => {
    const sampleFindings = detectSampleClaimsInSection(section);
    const containsSampleCopy = sampleFindings.length > 0 || computedSampleIds.has(section.id);
    return {
      id: section.id,
      type: section.type,
      order: section.order,
      enabled: section.enabled,
      optional: isOptionalVerticalSection(canonicalPresetId, section.id),
      selectedForPublish: selectedIds.has(section.id),
      isPublished: publishedIds.has(section.id),
      containsSampleCopy,
      sampleFindings,
      section,
    };
  });

  return {
    presetId: canonicalPresetId,
    storagePresetId: row.preset_id,
    applyMode: row.apply_mode,
    status: row.status,
    version: Number(row.version),
    lastOperationKey: row.last_operation_key,
    previewedAt: toIsoOrNull(row.previewed_at),
    publishedAt: toIsoOrNull(row.published_at),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    sections,
    sampleSectionIds: sections.filter((s) => s.containsSampleCopy).map((s) => s.id),
    selectedPublishSectionIds: sections.filter((s) => s.selectedForPublish).map((s) => s.id),
    publishedSectionIds: sections.filter((s) => s.isPublished).map((s) => s.id),
    warnings: validated.warnings,
  };
}

/**
 * Loads the complete M2 vertical onboarding preset state, live vertical-aware
 * checklists (for all 4 verticals), and tenant content summary (read-only, zero DDL).
 */
export async function loadVerticalPresetDashboardState(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
): Promise<VerticalPresetDashboardStateDto> {
  const [
    platformCtx,
    siteRow,
    profileRow,
    homepageRow,
    setupRow,
    pagesCount,
    publishedPagesCount,
    postsCount,
    offeringsCount,
    serviceOfferingsCount,
    publishedServiceOfferingsCount,
    tourOfferingsCount,
    publishedTourOfferingsCount,
    menusCount,
    mediaCount,
    privacySlugCount,
    outletsAdmin,
  ] = await Promise.all([
    loadPlatformContext(platformDb, member.tenantId, member.handle),
    tenantDb
      .prepare(
        "SELECT site_title, active_theme_id, draft_json, published_json FROM site_settings WHERE id = 1 LIMIT 1",
      )
      .first<{
        readonly site_title: string | null;
        readonly active_theme_id: string | null;
        readonly draft_json: string | null;
        readonly published_json: string | null;
      }>(),
    tenantDb
      .prepare(
        `SELECT business_name, business_category, address, phone, whatsapp_e164, email
         FROM business_profile
         WHERE id = 1
         LIMIT 1`,
      )
      .first<{
        readonly business_name: string | null;
        readonly business_category: string | null;
        readonly address: string | null;
        readonly phone: string | null;
        readonly whatsapp_e164: string | null;
        readonly email: string | null;
      }>(),
    loadActiveHomepageRow(tenantDb),
    loadRawSetupRow(tenantDb),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL"),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL AND status = 'published'",
    ),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM posts WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL"),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL AND offering_type = 'service'",
    ),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL AND offering_type = 'service' AND status = 'published'",
    ),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL AND offering_type = 'tour'",
    ),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL AND offering_type = 'tour' AND status = 'published'",
    ),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM menus"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM media_items WHERE status = 'ready'"),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL AND slug IN ('kebijakan-privasi', 'privacy-policy', 'privacy', 'privasi')",
    ),
    listOutletsForAdmin(tenantDb).catch(() => ({
      items: [],
      total: 0,
      maxOutlets: 10 as const,
      remainingSlots: 10,
      primaryOutletId: null,
    })),
  ]);

  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";
  const setup = setupRow ? hydrateVerticalSetupDto(setupRow, businessCategory) : null;
  const recommendedPresetId =
    setup?.presetId ?? mapTenantVerticalToRecommendedPreset(platformCtx.vertical);

  const draftExt = extractGroupedSettingsExtension(siteRow?.draft_json);
  const pubExt = extractGroupedSettingsExtension(siteRow?.published_json);
  const googleMapsReviewUrl =
    pubExt.business.googleMapsReviewUrl ?? draftExt.business.googleMapsReviewUrl ?? null;
  const hasPublishedGoogleMapsReviewUrl = Boolean(pubExt.business.googleMapsReviewUrl);

  const hasCustomizedDraftSection = Boolean(
    setup?.sections.some(
      (s) =>
        !s.containsSampleCopy &&
        (s.type === "hero" || s.type === "about" || s.type === "contact_location"),
    ),
  );

  const publishedOutletsCount = outletsAdmin.items.filter(
    (o) => o.status === "published" && o.active,
  ).length;
  const hasExistingHomepage = homepageRow !== null;
  const homepageIsPublished = Boolean(
    homepageRow && homepageRow.status === "published" && homepageRow.published_sections_json,
  );
  const isPopulatedTenant =
    hasExistingHomepage ||
    pagesCount > 0 ||
    postsCount > 0 ||
    offeringsCount > 0 ||
    outletsAdmin.total > 0;

  const baseChecklistFacts = {
    handle: member.handle,
    siteTitle: siteRow?.site_title ?? member.tenantName,
    businessName: profileRow?.business_name ?? member.tenantName,
    hasCustomizedDraftSection,
    nonTrashedPagesCount: pagesCount,
    nonTrashedOfferingsCount: offeringsCount,
    serviceOfferingsCount,
    publishedServiceOfferingsCount,
    tourOfferingsCount,
    publishedTourOfferingsCount,
    hasUmrahSkPpiuVerified: platformCtx.operatorVerifiedPpiu,
    outletsCount: outletsAdmin.total,
    publishedOutletsCount,
    whatsappE164: profileRow?.whatsapp_e164 ?? null,
    phone: profileRow?.phone ?? null,
    email: profileRow?.email ?? null,
    hasPrivacyPage: privacySlugCount > 0,
    hasPreviewedPreset: Boolean(setupRow?.previewed_at),
    activeCustomHostname: platformCtx.activeCustomHostname,
    fallbackHost: platformCtx.fallbackHost,
    googleMapsReviewUrl,
    hasPublishedGoogleMapsReviewUrl,
  };

  const checklistByPreset: Record<VerticalStarterPresetId, VerticalLaunchChecklistSummary> = {
    company_profile: evaluateVerticalLaunchChecklist({
      ...baseChecklistFacts,
      presetId: "company_profile",
    }),
    professional_services: evaluateVerticalLaunchChecklist({
      ...baseChecklistFacts,
      presetId: "professional_services",
    }),
    travel_umrah: evaluateVerticalLaunchChecklist({
      ...baseChecklistFacts,
      presetId: "travel_umrah",
    }),
    multi_outlet: evaluateVerticalLaunchChecklist({
      ...baseChecklistFacts,
      presetId: "multi_outlet",
    }),
  };

  const activeChecklist = checklistByPreset[setup?.presetId ?? recommendedPresetId];
  const isLocked = member.tenantStatus === "locked";
  const canRead = member.role === "owner" || member.role === "admin";
  const canMutate =
    canRead &&
    (member.tenantStatus === "trial" ||
      member.tenantStatus === "active" ||
      member.tenantStatus === "grace");

  return {
    tenantId: member.tenantId,
    handle: member.handle,
    tenantName: member.tenantName,
    vertical: platformCtx.vertical,
    businessCategory,
    isHealthCategory: isHealthBusinessCategory(businessCategory),
    activeThemeId: siteRow?.active_theme_id?.trim() || "compro",
    cacheVersion: platformCtx.cacheVersion,
    recommendedPresetId,
    catalog: VERTICAL_STARTER_PRESET_CATALOG,
    setup,
    checklist: activeChecklist,
    checklistByPreset,
    contentSummary: {
      pages: pagesCount,
      publishedPages: publishedPagesCount,
      posts: postsCount,
      offerings: offeringsCount,
      serviceOfferings: serviceOfferingsCount,
      publishedServiceOfferings: publishedServiceOfferingsCount,
      tourOfferings: tourOfferingsCount,
      publishedTourOfferings: publishedTourOfferingsCount,
      outlets: outletsAdmin.total,
      publishedOutlets: publishedOutletsCount,
      menus: menusCount,
      media: mediaCount,
      hasExistingHomepage,
      homepageIsPublished,
      isPopulatedTenant,
    },
    permissions: {
      canRead,
      canPreview: canRead,
      canMutate,
      isLocked,
      role: member.role,
      tenantStatus: member.tenantStatus,
    },
  };
}

/**
 * Seeds vertical-specific draft offering or draft outlet template using the REAL
 * M2 module repositories (`createCatalogOffering` + lossless TASK-035/TASK-020 envelopes,
 * `createOutlet` from TASK-019) BEFORE `preset_setup_operations` is recorded.
 *
 * Replay-safe: if a previous crash already created the exact starter draft slug before
 * recording `preset_setup_operations`, reuses it without duplicating rows.
 */
async function seedVerticalModuleDraftArtifacts(
  tenantDb: D1Database,
  member: PresetMemberScope,
  built: BuiltVerticalStarterComposition,
  counts: { readonly offeringsCount: number; readonly outletsCount: number },
  nowMs: number,
  hooks?: {
    readonly createOfferingFn?: typeof createCatalogOffering;
    readonly createOutletFn?: typeof createOutlet;
  },
): Promise<{
  readonly createdOfferingSlugs: readonly string[];
  readonly createdOutletSlugs: readonly string[];
}> {
  const createOfferingImpl = hooks?.createOfferingFn ?? createCatalogOffering;
  const createOutletImpl = hooks?.createOutletFn ?? createOutlet;
  const createdOfferingSlugs: string[] = [];
  const createdOutletSlugs: string[] = [];

  // 1. Professional Services (TASK-035): create ONE draft service offering only when fresh
  if (built.starterServiceOffering) {
    const spec = built.starterServiceOffering;
    const existingStarter = await tenantDb
      .prepare(
        "SELECT id, slug, status FROM offerings WHERE offering_type = 'service' AND slug = ? AND deleted_at IS NULL LIMIT 1",
      )
      .bind(spec.slug)
      .first<{ readonly id: number; readonly slug: string; readonly status: string }>();

    if (existingStarter && existingStarter.status === "draft") {
      createdOfferingSlugs.push(existingStarter.slug);
    } else if (counts.offeringsCount === 0) {
      const legacyAttrs = toCatalogServiceAttributes(spec.serviceAttributes);
      const created = await createOfferingImpl(
        tenantDb,
        {
          offeringType: "service",
          slug: spec.slug,
          title: spec.title,
          summary: spec.summary,
          priceMode: spec.priceMode,
          price: spec.price,
          ctaMode: spec.ctaMode,
          attributes: legacyAttrs,
        },
        { nowMs, actorUserId: member.userId },
      );

      const row = await tenantDb
        .prepare("SELECT draft_snapshot_json FROM offerings WHERE id = ? AND version = ? LIMIT 1")
        .bind(created.id, created.version)
        .first<{ readonly draft_snapshot_json: string | null }>();
      const nextDraftJson = attachServiceConsultationToDraftSnapshotJson(
        row?.draft_snapshot_json,
        spec.serviceAttributes,
      );
      await tenantDb
        .prepare(
          "UPDATE offerings SET draft_snapshot_json = ?, status = 'draft', published_snapshot_json = NULL, published_at = NULL WHERE id = ? AND version = ?",
        )
        .bind(nextDraftJson, created.id, created.version)
        .run();

      createdOfferingSlugs.push(created.slug);
    }
  }

  // 2. Travel & Wisata (TASK-020): create ONE draft `general_tour` offering only when fresh
  if (built.starterTravelOffering) {
    const spec = built.starterTravelOffering;
    const existingStarter = await tenantDb
      .prepare(
        "SELECT id, slug, status FROM offerings WHERE offering_type = 'tour' AND slug = ? AND deleted_at IS NULL LIMIT 1",
      )
      .bind(spec.slug)
      .first<{ readonly id: number; readonly slug: string; readonly status: string }>();

    if (existingStarter && existingStarter.status === "draft") {
      createdOfferingSlugs.push(existingStarter.slug);
    } else if (counts.offeringsCount === 0) {
      const legacyAttrs = toCatalogTourAttributes(spec.travelAttributes, {});
      const created = await createOfferingImpl(
        tenantDb,
        {
          offeringType: "tour",
          slug: spec.slug,
          title: spec.title,
          summary: spec.summary,
          priceMode: spec.priceMode,
          price: spec.price,
          ctaMode: spec.ctaMode,
          attributes: legacyAttrs,
        },
        { nowMs, actorUserId: member.userId },
      );

      const row = await tenantDb
        .prepare("SELECT draft_snapshot_json FROM offerings WHERE id = ? AND version = ? LIMIT 1")
        .bind(created.id, created.version)
        .first<{ readonly draft_snapshot_json: string | null }>();
      const nextDraftJson = attachTravelPackageToDraftSnapshotJson(
        row?.draft_snapshot_json,
        spec.travelAttributes,
      );
      await tenantDb
        .prepare(
          "UPDATE offerings SET draft_snapshot_json = ?, status = 'draft', published_snapshot_json = NULL, published_at = NULL WHERE id = ? AND version = ?",
        )
        .bind(nextDraftJson, created.id, created.version)
        .run();

      createdOfferingSlugs.push(created.slug);
    }
  }

  // 3. Multi-Outlet (TASK-019): create ONE draft & inactive outlet template only when fresh
  if (built.starterOutletTemplate) {
    const spec = built.starterOutletTemplate;
    const existingOutlets = await listOutletsForAdmin(tenantDb);
    const existingStarter = existingOutlets.items.find(
      (o) => o.slug === spec.slug && o.status === "draft",
    );

    if (existingStarter) {
      createdOutletSlugs.push(existingStarter.slug);
    } else if (counts.outletsCount === 0) {
      const createdOutlet = await createOutletImpl(
        tenantDb,
        {
          name: spec.name,
          slug: spec.slug,
          address: spec.address,
          city: spec.city,
          province: spec.province,
          postalCode: spec.postalCode,
          phone: spec.phone,
          whatsappE164: spec.whatsappE164,
          mapsUrl: spec.mapsUrl,
          latitude: spec.latitude,
          longitude: spec.longitude,
          weeklyHours: [...spec.weeklyHours],
          holidayHours: [...spec.holidayHours],
          timezone: spec.timezone,
          isPrimary: spec.isPrimary,
          status: "draft",
          active: false,
        },
        {
          actorUserId: member.userId,
          actorRole: member.role,
          nowMs,
        },
      );
      createdOutletSlugs.push(createdOutlet.slug);
    }
  }

  return { createdOfferingSlugs, createdOutletSlugs };
}

/**
 * Atomically and idempotently applies ANY of the 4 vertical starter presets
 * (`company_profile`, `professional_services`, `travel_umrah`, `multi_outlet`):
 * - Strictly DRAFT-ONLY (ZERO published pages/offerings/outlets, ZERO `cache_version` bump,
 *   draft header menu stores `items_json = '[]'` and `published_items_json = NULL`).
 * - Crash/replay-safe idempotency: vertical draft offerings/outlets are seeded BEFORE
 *   `preset_setup_operations` is recorded so a seeding error never poisons `setupKey`.
 * - Switching from an existing preset to a different vertical requires explicit
 *   `confirmSwitch: true`, preserves user-edited non-sample draft sections, and resets
 *   `preset_setups` status to `draft` with `published_section_ids_json = '[]'`.
 * - Populated-tenant protection: existing user pages, offerings, posts, menus, and outlets
 *   are NEVER overwritten, unpublished, or deleted.
 */
export async function applyVerticalStarterPresetAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
  rawInput: ApplyVerticalStarterPresetInput | unknown,
  options: {
    readonly nowMs?: number;
    readonly createOfferingFn?: typeof createCatalogOffering;
    readonly createOutletFn?: typeof createOutlet;
  } = {},
): Promise<ApplyVerticalStarterPresetResult> {
  const parsed = ApplyVerticalStarterPresetInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PublicationValidationError(
      parsed.error.issues[0]?.message ?? "Input preset vertikal tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        code: "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }

  const input = parsed.data;
  const canonicalPresetId = resolveCanonicalVerticalPresetId(input.presetId);
  if (!canonicalPresetId) {
    throw new PresetDomainError(
      422,
      "UNSUPPORTED_PRESET",
      `Preset "${input.presetId}" tidak dikenali.`,
      [{ field: "presetId", code: "UNSUPPORTED_PRESET", message: `Unknown preset "${input.presetId}"` }],
    );
  }

  const setupKey = (input.setupKey ?? input.operationKey)!;
  const storagePresetId = toStorageStarterPresetId(canonicalPresetId);
  const requestHash = computeVerticalPresetSetupHash({
    tenantId: member.tenantId,
    presetId: canonicalPresetId,
    applyMode: input.applyMode,
    confirmSwitch: input.confirmSwitch,
  });

  await ensureStarterPresetsTables(tenantDb);

  // 1. Idempotency check BEFORE any write!
  const existingOp = await tenantDb
    .prepare(
      `SELECT operation_key, preset_id, apply_mode, request_hash, result_json, created_at
       FROM preset_setup_operations
       WHERE operation_key = ?
       LIMIT 1`,
    )
    .bind(setupKey)
    .first<RawVerticalOperationRow>();

  if (existingOp) {
    if (existingOp.request_hash !== requestHash) {
      throw new PresetDomainError(
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "Kunci setup (setupKey) sudah digunakan untuk parameter preset yang berbeda.",
        [
          {
            field: "setupKey",
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "setupKey already bound to a different preset request payload",
          },
        ],
      );
    }
    const stored = safeParseJson<StoredVerticalOperationRecord>(existingOp.result_json, {
      presetId: canonicalPresetId,
      applyMode: "staged_draft",
      createdHomepageDraft: false,
      createdPageSlugs: [],
      createdOfferingSlugs: [],
      createdOutletSlugs: [],
      createdHeaderMenuDraft: false,
      preservedExistingContent: true,
    });
    const state = await loadVerticalPresetDashboardState(platformDb, tenantDb, member);
    return {
      presetId: stored.presetId,
      setupKey,
      operationKey: setupKey,
      applyMode: stored.applyMode,
      alreadyApplied: true,
      idempotentReplay: true,
      createdHomepageDraft: stored.createdHomepageDraft,
      createdPageSlugs: stored.createdPageSlugs,
      createdOfferingSlugs: stored.createdOfferingSlugs,
      createdOutletSlugs: stored.createdOutletSlugs,
      createdHeaderMenuDraft: stored.createdHeaderMenuDraft,
      preservedExistingContent: stored.preservedExistingContent,
      state,
    };
  }

  const nowMs = options.nowMs ?? Date.now();

  // 2. Inspect ALL existing tenant data BEFORE writing so populated tenants are 100% protected!
  const [
    profileRow,
    homepageRow,
    existingSetup,
    pagesCount,
    postsCount,
    offeringsCount,
    headerMenuRow,
    outletsAdmin,
  ] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT business_name, business_category, address, phone, whatsapp_e164, email
         FROM business_profile
         WHERE id = 1
         LIMIT 1`,
      )
      .first<{
        readonly business_name: string | null;
        readonly business_category: string | null;
        readonly address: string | null;
        readonly phone: string | null;
        readonly whatsapp_e164: string | null;
        readonly email: string | null;
      }>(),
    loadActiveHomepageRow(tenantDb),
    loadRawSetupRow(tenantDb),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM posts WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL"),
    tenantDb
      .prepare("SELECT id FROM menus WHERE location = 'header' LIMIT 1")
      .first<{ readonly id: number }>(),
    listOutletsForAdmin(tenantDb).catch(() => ({
      items: [],
      total: 0,
      maxOutlets: 10 as const,
      remainingSlots: 10,
      primaryOutletId: null,
    })),
  ]);

  // 3. Enforce explicit confirmation when switching from an existing preset to a DIFFERENT preset
  if (existingSetup) {
    const existingCanonical =
      resolveCanonicalVerticalPresetId(existingSetup.preset_id) ?? "company_profile";
    if (existingCanonical !== canonicalPresetId && input.confirmSwitch !== true) {
      throw new PresetDomainError(
        409,
        "PRESET_SWITCH_CONFIRMATION_REQUIRED",
        `Situs ini sudah memiliki draf preset "${existingCanonical}". Kirim confirmSwitch: true untuk mengganti preset ke "${canonicalPresetId}" tanpa menghapus bagian yang sudah Anda sunting.`,
        [
          {
            field: "confirmSwitch",
            code: "PRESET_SWITCH_CONFIRMATION_REQUIRED",
            message: `Explicit confirmSwitch: true is required when switching from "${existingCanonical}" to "${canonicalPresetId}"`,
          },
        ],
      );
    }
  }

  const businessName = profileRow?.business_name?.trim() || member.tenantName;
  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";
  const validTenantWa =
    profileRow?.whatsapp_e164 && validateIndonesianWhatsAppNumber(profileRow.whatsapp_e164).ok
      ? profileRow.whatsapp_e164.trim()
      : null;

  const built = buildVerticalStarterComposition(canonicalPresetId, {
    businessName,
    businessCategory,
    address: profileRow?.address ?? null,
    phone: profileRow?.phone ?? null,
    whatsappPhone: validTenantWa,
    email: profileRow?.email ?? null,
  });

  const outletsCount = outletsAdmin.total;

  // Exclude an uncommitted draft starter offering/outlet from a prior crashed attempt
  // (when `!existingSetup`) so retrying with the same `setupKey` completes fresh initialization
  // and reuses the seeded starter slug without falsely tripping `isPopulated`!
  let effectiveOfferingsCount = offeringsCount;
  let effectiveOutletsCount = outletsCount;
  if (!existingSetup) {
    const starterOfferingType = built.starterServiceOffering
      ? "service"
      : built.starterTravelOffering
        ? "tour"
        : null;
    const starterOfferingSlug =
      built.starterServiceOffering?.slug ?? built.starterTravelOffering?.slug ?? null;

    if (starterOfferingType && starterOfferingSlug) {
      const uncommittedStarterRow = await tenantDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM offerings
           WHERE deleted_at IS NULL
             AND offering_type = ?
             AND slug = ?
             AND status = 'draft'
             AND published_at IS NULL`,
        )
        .bind(starterOfferingType, starterOfferingSlug)
        .first<{ readonly count?: number }>();
      effectiveOfferingsCount = Math.max(
        0,
        offeringsCount - Number(uncommittedStarterRow?.count ?? 0),
      );
    }

    const starterOutletSlug = built.starterOutletTemplate?.slug ?? null;
    if (starterOutletSlug) {
      const uncommittedStarterOutlets = outletsAdmin.items.filter(
        (o) => o.slug === starterOutletSlug && o.status === "draft" && !o.active,
      ).length;
      effectiveOutletsCount = Math.max(0, outletsCount - uncommittedStarterOutlets);
    }
  }

  const isPopulated =
    homepageRow !== null ||
    pagesCount > 0 ||
    postsCount > 0 ||
    effectiveOfferingsCount > 0 ||
    effectiveOutletsCount > 0;

  // 4. Seed vertical draft offerings/outlets FIRST (only for fresh tenants, BEFORE recording
  //    `preset_setup_operations`), so any failure here NEVER poisons the idempotency ledger!
  let createdOfferingSlugs: readonly string[] = [];
  let createdOutletSlugs: readonly string[] = [];
  if (!isPopulated && !existingSetup) {
    const seeded = await seedVerticalModuleDraftArtifacts(
      tenantDb,
      member,
      built,
      { offeringsCount: effectiveOfferingsCount, outletsCount: effectiveOutletsCount },
      nowMs,
      {
        createOfferingFn: options.createOfferingFn,
        createOutletFn: options.createOutletFn,
      },
    );
    createdOfferingSlugs = seeded.createdOfferingSlugs;
    createdOutletSlugs = seeded.createdOutletSlugs;
  }

  const createdPageSlugs: string[] = [];
  let createdHomepageDraft = false;
  let createdHeaderMenuDraft = false;
  let storedApplyMode: StoredPresetApplyMode;

  const statements: D1PreparedStatement[] = [];
  let homepageStmtIdx = -1;
  let menuStmtIdx = -1;
  const secondaryPageStmtIndices: { readonly idx: number; readonly slug: string }[] = [];

  if (existingSetup) {
    const existingCanonical =
      resolveCanonicalVerticalPresetId(existingSetup.preset_id) ?? "company_profile";
    const isSamePreset = existingCanonical === canonicalPresetId;
    const existingRaw = safeParseJson<unknown[]>(existingSetup.draft_sections_json, []);
    const existingValidated = validatePageSections(existingRaw, { businessCategory });

    let nextDraftSections: readonly AnyValidatedPageSection[];
    let nextSelectedIds: readonly string[];
    let nextStatus: PresetSetupStatus;
    let nextPublishedSectionIdsJson: string | null;
    let nextPublishedAt: number | null;
    let nextPreviewedAt: number | null;

    if (isSamePreset) {
      nextDraftSections = mergeStarterPresetDraftSections(
        existingValidated.sections,
        built.sections,
        businessCategory,
      );
      nextSelectedIds = parseStringArray(existingSetup.selected_publish_section_ids_json);
      nextStatus = existingSetup.status;
      nextPublishedSectionIdsJson = existingSetup.published_section_ids_json;
      nextPublishedAt = existingSetup.published_at;
      nextPreviewedAt = existingSetup.previewed_at;
      storedApplyMode = existingSetup.apply_mode;
    } else {
      // Confirmed switch: preserve any user-edited non-sample sections, merge new preset slots,
      // and cleanly reset `preset_setups` publish status to `draft` with empty `published_section_ids_json`!
      const preservedUserEdited = existingValidated.sections.filter(isCustomizedNonSampleSection);
      nextDraftSections =
        preservedUserEdited.length > 0
          ? mergeStarterPresetDraftSections(preservedUserEdited, built.sections, businessCategory)
          : built.sections;
      nextSelectedIds = nextDraftSections.filter((s) => s.enabled).map((s) => s.id);
      nextStatus = "draft";
      nextPublishedSectionIdsJson = "[]";
      nextPublishedAt = null;
      nextPreviewedAt = null;
      storedApplyMode = isPopulated ? "staged_draft" : "initialized_draft";
    }

    const nextSampleIds = computeSampleSectionIds(nextDraftSections);

    statements.push(
      tenantDb
        .prepare(
          `UPDATE preset_setups
           SET preset_id = ?,
               draft_sections_json = ?,
               sample_section_ids_json = ?,
               selected_publish_section_ids_json = ?,
               published_section_ids_json = ?,
               status = ?,
               apply_mode = ?,
               last_operation_key = ?,
               previewed_at = ?,
               published_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1`,
        )
        .bind(
          storagePresetId,
          JSON.stringify(nextDraftSections),
          JSON.stringify(nextSampleIds),
          JSON.stringify(nextSelectedIds),
          nextPublishedSectionIdsJson,
          nextStatus,
          storedApplyMode,
          setupKey,
          nextPreviewedAt,
          nextPublishedAt,
          nowMs,
        ),
    );
  } else {
    if (!isPopulated && homepageRow === null) {
      storedApplyMode = "initialized_draft";
    } else if (input.applyMode === "merge_draft") {
      storedApplyMode = "merged_draft";
    } else {
      storedApplyMode = "staged_draft";
    }

    // Fresh tenant only (0 existing pages): create draft homepage + draft secondary starter pages
    if (storedApplyMode === "initialized_draft" && pagesCount === 0 && homepageRow === null) {
      const freeHomeSlug = await resolveUniquePageSlug(tenantDb, "beranda");
      const homeDraft = serializeSampleSafePageDraftEnvelope({
        sections: built.sections,
        nextVersion: 1,
        slug: freeHomeSlug,
        title: `Beranda — ${businessName}`,
        isHomepage: true,
        seo: null,
        businessCategory,
      });

      homepageStmtIdx = statements.length;
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO pages
               (id, slug, title, is_homepage, draft_sections_json, published_sections_json,
                seo_json, status, published_at, content_modified_at, deleted_at, version, created_at, updated_at)
             SELECT MAX(COALESCE((SELECT next FROM sequences WHERE kind = 'page'), 0), COALESCE((SELECT MAX(id) FROM pages), 0)) + 1,
                    ?, ?, 1, ?, NULL, NULL, 'draft', NULL, NULL, NULL, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL)
               AND NOT EXISTS (SELECT 1 FROM pages WHERE slug = ?)`,
          )
          .bind(freeHomeSlug, `Beranda — ${businessName}`, homeDraft.json, nowMs, nowMs, freeHomeSlug),
      );
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO sequences (kind, next)
             SELECT 'page', id
             FROM pages
             WHERE changes() = 1 AND is_homepage = 1 AND deleted_at IS NULL AND updated_at = ?
             ON CONFLICT(kind) DO UPDATE SET next = MAX(sequences.next, excluded.next)`,
          )
          .bind(nowMs),
      );
      createdPageSlugs.push(freeHomeSlug);

      for (const secPage of built.secondaryPages) {
        const freeSecSlug = await resolveUniquePageSlug(tenantDb, secPage.slug);
        const secDraft = serializeSampleSafePageDraftEnvelope({
          sections: secPage.sections,
          nextVersion: 1,
          slug: freeSecSlug,
          title: secPage.title,
          isHomepage: false,
          seo: null,
          businessCategory,
        });
        const idx = statements.length;
        secondaryPageStmtIndices.push({ idx, slug: freeSecSlug });
        statements.push(
          tenantDb
            .prepare(
              `INSERT INTO pages
                 (id, slug, title, is_homepage, draft_sections_json, published_sections_json,
                  seo_json, status, published_at, content_modified_at, deleted_at, version, created_at, updated_at)
               SELECT MAX(COALESCE((SELECT next FROM sequences WHERE kind = 'page'), 0), COALESCE((SELECT MAX(id) FROM pages), 0)) + 1,
                      ?, ?, 0, ?, NULL, NULL, 'draft', NULL, NULL, NULL, 1, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM pages WHERE slug = ?)`,
            )
            .bind(freeSecSlug, secPage.title, secDraft.json, nowMs, nowMs, freeSecSlug),
        );
        statements.push(
          tenantDb
            .prepare(
              `INSERT INTO sequences (kind, next)
               SELECT 'page', id
               FROM pages
               WHERE changes() = 1 AND slug = ? AND deleted_at IS NULL
               ON CONFLICT(kind) DO UPDATE SET next = MAX(sequences.next, excluded.next)`,
            )
            .bind(freeSecSlug),
        );
      }
    }

    // Fresh tenant with no header menu: seed ONE strictly draft-only header menu
    // Keep `items_json = '[]'` and `published_items_json = NULL` so ZERO uncreated vertical links leak live!
    if (storedApplyMode === "initialized_draft" && !headerMenuRow) {
      const builtHeaderMenu = buildMenuTree(
        "header",
        built.headerNavItems.map((item, idx) => ({
          id: item.id,
          label: item.label,
          targetType: "custom" as const,
          href: item.href,
          sortOrder: idx,
        })),
      );
      const treeJson = JSON.stringify(builtHeaderMenu.tree);
      menuStmtIdx = statements.length;
      statements.push(
        tenantDb
          .prepare(
            `INSERT INTO menus
               (id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at)
             SELECT COALESCE((SELECT MAX(id) FROM menus), 0) + 1, 'header', '[]', ?, NULL, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM menus WHERE location = 'header')`,
          )
          .bind(treeJson, nowMs, nowMs),
      );
    }

    const finalSampleIds = computeSampleSectionIds(built.sections);
    const finalSelectedIds = built.defaultSelectedPublishSectionIds;

    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO preset_setups
             (id, preset_id, apply_mode, status, draft_sections_json, sample_section_ids_json,
              selected_publish_section_ids_json, published_section_ids_json, last_operation_key,
              previewed_at, published_at, version, created_at, updated_at)
           VALUES (1, ?, ?, 'draft', ?, ?, ?, NULL, ?, NULL, NULL, 1, ?, ?)`,
        )
        .bind(
          storagePresetId,
          storedApplyMode,
          JSON.stringify(built.sections),
          JSON.stringify(finalSampleIds),
          JSON.stringify(finalSelectedIds),
          setupKey,
          nowMs,
          nowMs,
        ),
    );
  }

  const operationRecord: StoredVerticalOperationRecord = {
    presetId: canonicalPresetId,
    applyMode: storedApplyMode,
    createdHomepageDraft: homepageStmtIdx >= 0,
    createdPageSlugs: [
      ...(homepageStmtIdx >= 0 && createdPageSlugs[0] ? [createdPageSlugs[0]] : []),
      ...secondaryPageStmtIndices.map((s) => s.slug),
    ],
    createdOfferingSlugs,
    createdOutletSlugs,
    createdHeaderMenuDraft: menuStmtIdx >= 0,
    preservedExistingContent: isPopulated,
  };

  // 5. Record idempotency ledger & audit log atomically AFTER all vertical draft artifacts exist!
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO preset_setup_operations
           (operation_key, preset_id, apply_mode, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        setupKey,
        storagePresetId,
        input.applyMode,
        requestHash,
        JSON.stringify(operationRecord),
        nowMs,
      ),
  );

  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log
           (actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at)
         VALUES (?, ?, 'preset.applied', 'preset', ?, ?, ?, ?)`,
      )
      .bind(
        member.userId,
        member.role,
        canonicalPresetId,
        `Menerapkan draf preset vertikal "${canonicalPresetId}"`,
        JSON.stringify({
          presetId: canonicalPresetId,
          storagePresetId,
          setupKey,
          applyMode: storedApplyMode,
          preservedExistingContent: isPopulated,
          createdOfferingSlugs,
          createdOutletSlugs,
        }),
        nowMs,
      ),
  );

  let batchResults: D1Result[];
  try {
    batchResults = await tenantDb.batch(statements);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const racedOp = await tenantDb
        .prepare(
          `SELECT operation_key, preset_id, apply_mode, request_hash, result_json, created_at
           FROM preset_setup_operations
           WHERE operation_key = ?
           LIMIT 1`,
        )
        .bind(setupKey)
        .first<RawVerticalOperationRow>();
      if (racedOp) {
        if (racedOp.request_hash !== requestHash) {
          throw new PresetDomainError(
            409,
            "IDEMPOTENCY_KEY_CONFLICT",
            "Kunci setup (setupKey) sudah digunakan untuk parameter preset yang berbeda.",
          );
        }
        const stored = safeParseJson<StoredVerticalOperationRecord>(
          racedOp.result_json,
          operationRecord,
        );
        const state = await loadVerticalPresetDashboardState(platformDb, tenantDb, member);
        return {
          presetId: stored.presetId,
          setupKey,
          operationKey: setupKey,
          applyMode: stored.applyMode,
          alreadyApplied: true,
          idempotentReplay: true,
          createdHomepageDraft: stored.createdHomepageDraft,
          createdPageSlugs: stored.createdPageSlugs,
          createdOfferingSlugs: stored.createdOfferingSlugs,
          createdOutletSlugs: stored.createdOutletSlugs,
          createdHeaderMenuDraft: stored.createdHeaderMenuDraft,
          preservedExistingContent: stored.preservedExistingContent,
          state,
        };
      }
    }
    throw err;
  }

  // Reconcile actual created page & menu counts from SQL `changes()`
  const actualCreatedPageSlugs: string[] = [];
  if (homepageStmtIdx >= 0 && (batchResults[homepageStmtIdx]?.meta?.changes ?? 0) === 1) {
    createdHomepageDraft = true;
    if (createdPageSlugs[0]) actualCreatedPageSlugs.push(createdPageSlugs[0]);
  }
  for (const sec of secondaryPageStmtIndices) {
    if ((batchResults[sec.idx]?.meta?.changes ?? 0) === 1) {
      actualCreatedPageSlugs.push(sec.slug);
    }
  }
  if (menuStmtIdx >= 0 && (batchResults[menuStmtIdx]?.meta?.changes ?? 0) === 1) {
    createdHeaderMenuDraft = true;
  }

  if (
    actualCreatedPageSlugs.length !== operationRecord.createdPageSlugs.length ||
    createdHomepageDraft !== operationRecord.createdHomepageDraft ||
    createdHeaderMenuDraft !== operationRecord.createdHeaderMenuDraft
  ) {
    const corrected: StoredVerticalOperationRecord = {
      ...operationRecord,
      createdHomepageDraft,
      createdPageSlugs: actualCreatedPageSlugs,
      createdHeaderMenuDraft,
    };
    await tenantDb
      .prepare("UPDATE preset_setup_operations SET result_json = ? WHERE operation_key = ?")
      .bind(JSON.stringify(corrected), setupKey)
      .run();
  }

  const state = await loadVerticalPresetDashboardState(platformDb, tenantDb, member);

  return {
    presetId: canonicalPresetId,
    setupKey,
    operationKey: setupKey,
    applyMode: storedApplyMode,
    alreadyApplied: false,
    idempotentReplay: false,
    createdHomepageDraft,
    createdPageSlugs: actualCreatedPageSlugs,
    createdOfferingSlugs,
    createdOutletSlugs,
    createdHeaderMenuDraft,
    preservedExistingContent: isPopulated,
    state,
  };
}

/**
 * Atomically publishes ONLY validated, non-sample selected homepage sections from
 * ANY of the 4 vertical presets (`company_profile`, `professional_services`,
 * `travel_umrah`, `multi_outlet`) while:
 * - Verifying `input.presetId` matches the stored setup's canonical preset (`409 PRESET_MISMATCH`),
 * - Leaving draft offerings, draft outlets, and unedited sample sections strictly unpublished,
 * - Merging non-destructively into existing homepage `published_sections_json` AND
 *   `draft_sections_json` metadata on populated tenants,
 * - Executing full compensating rollback (restoring `preset_setups`, `pages`, and deleting
 *   the inserted `content_revisions` row) if `bumpTenantCacheVersion` fails!
 */
export async function publishVerticalStarterPresetSectionsAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
  rawInput: PublishStarterPresetInput | unknown,
  options: { readonly nowMs?: number } = {},
): Promise<PublishVerticalStarterPresetResult> {
  const parsed = PublishStarterPresetInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PublicationValidationError(
      parsed.error.issues[0]?.message ?? "Permintaan penerbitan preset tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        code: "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }
  const input = parsed.data;
  const canonicalPresetId = resolveCanonicalVerticalPresetId(input.presetId);
  if (!canonicalPresetId) {
    throw new PresetDomainError(422, "UNSUPPORTED_PRESET", `Preset "${input.presetId}" tidak dikenali.`);
  }

  await ensureStarterPresetsTables(tenantDb);
  const existingSetup = await loadRawSetupRow(tenantDb);
  if (!existingSetup) {
    throw new PresetDomainError(
      404,
      "PRESET_NOT_INITIALIZED",
      "Preset pemula belum diterapkan pada situs ini.",
    );
  }

  // Verify requested presetId matches stored setup's canonical preset!
  const storedCanonicalPresetId =
    resolveCanonicalVerticalPresetId(existingSetup.preset_id) ?? "company_profile";
  if (storedCanonicalPresetId !== canonicalPresetId) {
    throw new PresetDomainError(
      409,
      "PRESET_MISMATCH",
      `Preset "${canonicalPresetId}" tidak cocok dengan preset aktif di draf ("${storedCanonicalPresetId}"). Muat ulang sebelum menerbitkan.`,
      [
        {
          field: "presetId",
          code: "PRESET_MISMATCH",
          message: `Active draft setup is "${storedCanonicalPresetId}", not "${canonicalPresetId}"`,
        },
      ],
    );
  }

  const [siteRow, profileRow, pagesCount, offeringsCount] = await Promise.all([
    tenantDb
      .prepare("SELECT site_title FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly site_title: string | null }>(),
    tenantDb
      .prepare(
        "SELECT business_name, business_category, phone, whatsapp_e164, email FROM business_profile WHERE id = 1 LIMIT 1",
      )
      .first<{
        readonly business_name: string | null;
        readonly business_category: string | null;
        readonly phone: string | null;
        readonly whatsapp_e164: string | null;
        readonly email: string | null;
      }>(),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL"),
  ]);

  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";
  const businessName = profileRow?.business_name?.trim() || member.tenantName;

  const rawDraftSections = safeParseJson<unknown[]>(existingSetup.draft_sections_json, []);
  const validatedDraft = validatePageSections(rawDraftSections, { businessCategory });

  const selective = validateVerticalPresetSelectivePublish({
    presetId: canonicalPresetId,
    draftSections: validatedDraft.sections,
    selectedSectionIds: input.selectedSectionIds,
    businessCategory,
  });

  const checklist = evaluateVerticalLaunchChecklist({
    presetId: canonicalPresetId,
    handle: member.handle,
    siteTitle: siteRow?.site_title ?? null,
    businessName: profileRow?.business_name ?? null,
    hasCustomizedDraftSection: selective.selectedSections.length > 0,
    nonTrashedPagesCount: pagesCount,
    nonTrashedOfferingsCount: offeringsCount,
    whatsappE164: profileRow?.whatsapp_e164 ?? null,
    phone: profileRow?.phone ?? null,
    email: profileRow?.email ?? null,
    hasPrivacyPage: false,
    hasPreviewedPreset: Boolean(existingSetup.previewed_at),
    activeCustomHostname: null,
    fallbackHost: `${member.handle}.situsku.click`,
  });

  const missingRequired = checklist.items.filter(
    (item) => item.requiredForPublish && item.status !== "done",
  );
  if (missingRequired.length > 0) {
    throw new PresetDomainError(
      422,
      "CHECKLIST_INCOMPLETE",
      `Lengkapi poin daftar periksa utama terlebih dahulu sebelum menerbitkan: ${missingRequired
        .map((i) => i.label)
        .join(", ")}.`,
      missingRequired.map((item) => ({
        field: `checklist.${item.id}`,
        code: "CHECKLIST_ITEM_REQUIRED",
        message: item.detail,
      })),
    );
  }

  const currentVersion = Number(existingSetup.version);
  if (input.expectedVersion !== currentVersion) {
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: "preset-setup",
      expectedVersion: input.expectedVersion,
      actualVersion: currentVersion,
    });
  }

  const nowMs = options.nowMs ?? Date.now();
  const priorHomepage = await loadActiveHomepageRow(tenantDb);
  const pageSlug = priorHomepage?.slug ?? (await resolveUniquePageSlug(tenantDb, "beranda"));
  const pageTitle = priorHomepage?.title ?? `Beranda — ${businessName}`;
  const pageSeo = safeParseJson<PageSnapshot["seo"]>(priorHomepage?.seo_json ?? null, null);
  const nextHomepageVersion = priorHomepage ? Number(priorHomepage.version) + 1 : 1;

  let existingPublishedSections: readonly PageSnapshot["sections"][number][] = [];
  let existingDraftPublicSections: readonly PageSnapshot["sections"][number][] = [];
  let existingDraftMetadata: Readonly<Record<string, unknown>> | null = null;
  if (priorHomepage) {
    const priorPublishedDto = extractPublishedSnapshot("page", {
      resourceId: Number(priorHomepage.id),
      status: priorHomepage.status,
      deletedAt: priorHomepage.deleted_at,
      draftJson: priorHomepage.draft_sections_json,
      publishedJson: priorHomepage.published_sections_json,
      publishedAt: priorHomepage.published_at,
      contentModifiedAt: priorHomepage.content_modified_at,
      version: Number(priorHomepage.version),
      updatedAt: Number(priorHomepage.updated_at),
    });
    existingPublishedSections = priorPublishedDto?.data.sections ?? [];

    const priorAdminDto = extractDraftSnapshotForAdmin("page", {
      resourceId: Number(priorHomepage.id),
      status: priorHomepage.status,
      deletedAt: priorHomepage.deleted_at,
      draftJson: priorHomepage.draft_sections_json,
      publishedJson: priorHomepage.published_sections_json,
      publishedAt: priorHomepage.published_at,
      contentModifiedAt: priorHomepage.content_modified_at,
      version: Number(priorHomepage.version),
      updatedAt: Number(priorHomepage.updated_at),
    });
    existingDraftPublicSections = priorAdminDto?.draft?.sections ?? existingPublishedSections;
    existingDraftMetadata = (priorAdminDto?.draftMetadata ?? null) as Readonly<
      Record<string, unknown>
    > | null;
  }

  const publishedPageSnapshot = buildPageSnapshotForDraftOrPublish(selective.selectedSections, {
    slug: pageSlug,
    title: pageTitle,
    isHomepage: true,
    seo: pageSeo,
    existingPublicSections: existingPublishedSections,
  });

  const priorPublishedAt = priorHomepage?.published_at ?? nowMs;
  const pageEnvelope = buildPublishedSnapshot("page", publishedPageSnapshot, {
    publishedAt: priorPublishedAt,
    contentModifiedAt: nowMs,
  });
  const publishedPageJson = JSON.stringify(pageEnvelope);

  const selectedIdSet = new Set(selective.selectedSections.map((s) => s.id));
  const syncedFullDraftSections = validatedDraft.sections.map((section) => ({
    ...section,
    enabled: selectedIdSet.has(section.id),
  })) as readonly AnyValidatedPageSection[];

  const syncedDraftEnvelope = serializeSampleSafePageDraftEnvelope({
    sections: syncedFullDraftSections,
    nextVersion: nextHomepageVersion,
    slug: pageSlug,
    title: pageTitle,
    isHomepage: true,
    seo: pageSeo,
    businessCategory,
    existingPublicDraftSections: existingDraftPublicSections,
    existingDraftMetadata,
  });

  const publishedSectionIds = selective.selectedSections.map((s) => s.id);
  const sampleSectionIds = computeSampleSectionIds(syncedFullDraftSections);

  const statements: D1PreparedStatement[] = [];
  if (priorHomepage === null) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO pages
             (id, slug, title, is_homepage, draft_sections_json, published_sections_json,
              seo_json, status, published_at, content_modified_at, deleted_at, version, created_at, updated_at)
           SELECT MAX(COALESCE((SELECT next FROM sequences WHERE kind = 'page'), 0), COALESCE((SELECT MAX(id) FROM pages), 0)) + 1,
                  ?, ?, 1, ?, ?, ?, 'published', ?, ?, NULL, 1, ?, ?
           WHERE EXISTS (SELECT 1 FROM preset_setups WHERE id = 1 AND version = ?)
             AND NOT EXISTS (SELECT 1 FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM pages WHERE slug = ?)`,
        )
        .bind(
          pageSlug,
          pageTitle,
          syncedDraftEnvelope.json,
          publishedPageJson,
          pageSeo ? JSON.stringify(pageSeo) : null,
          pageEnvelope.publishedAt,
          pageEnvelope.contentModifiedAt,
          nowMs,
          nowMs,
          input.expectedVersion,
          pageSlug,
        ),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET draft_sections_json = ?,
               published_sections_json = ?,
               status = 'published',
               published_at = ?,
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND is_homepage = 1
             AND deleted_at IS NULL
             AND version = ?
             AND EXISTS (SELECT 1 FROM preset_setups WHERE id = 1 AND version = ?)`,
        )
        .bind(
          syncedDraftEnvelope.json,
          publishedPageJson,
          pageEnvelope.publishedAt,
          pageEnvelope.contentModifiedAt,
          nowMs,
          Number(priorHomepage.id),
          Number(priorHomepage.version),
          input.expectedVersion,
        ),
    );
  }

  if (priorHomepage) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO content_revisions
             (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
           SELECT 'page',
                  ?,
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = 'page' AND resource_id = ?), 0) + 1,
                  ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          Number(priorHomepage.id),
          Number(priorHomepage.id),
          publishedPageJson,
          member.userId,
          nowMs,
        ),
    );
    statements.push(
      tenantDb
        .prepare(
          `DELETE FROM content_revisions
           WHERE resource_type = 'page'
             AND resource_id = ?
             AND revision_number NOT IN (
               SELECT revision_number
               FROM content_revisions
               WHERE resource_type = 'page' AND resource_id = ?
               ORDER BY revision_number DESC
               LIMIT ?
             )`,
        )
        .bind(Number(priorHomepage.id), Number(priorHomepage.id), MAX_RETAINED_REVISIONS),
    );
  } else {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO content_revisions
             (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
           SELECT 'page',
                  p.id,
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = 'page' AND resource_id = p.id), 0) + 1,
                  ?, ?, ?
           FROM pages p
           WHERE changes() = 1
             AND p.is_homepage = 1
             AND p.deleted_at IS NULL
             AND p.version = 1
             AND p.updated_at = ?`,
        )
        .bind(publishedPageJson, member.userId, nowMs, nowMs),
    );
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO sequences (kind, next)
           SELECT 'page', id
           FROM pages
           WHERE is_homepage = 1 AND deleted_at IS NULL AND version = 1 AND updated_at = ?
           ON CONFLICT(kind) DO UPDATE SET next = MAX(sequences.next, excluded.next)`,
        )
        .bind(nowMs),
    );
  }

  const setupStmtIdx = statements.length;
  statements.push(
    tenantDb
      .prepare(
        `UPDATE preset_setups
         SET status = 'published',
             draft_sections_json = ?,
             sample_section_ids_json = ?,
             selected_publish_section_ids_json = ?,
             published_section_ids_json = ?,
             published_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = 1
           AND version = ?
           AND EXISTS (
             SELECT 1 FROM pages
             WHERE is_homepage = 1
               AND deleted_at IS NULL
               AND version = ?
               AND updated_at = ?
               AND published_sections_json = ?
           )`,
      )
      .bind(
        JSON.stringify(syncedFullDraftSections),
        JSON.stringify(sampleSectionIds),
        JSON.stringify(publishedSectionIds),
        JSON.stringify(publishedSectionIds),
        nowMs,
        nowMs,
        input.expectedVersion,
        nextHomepageVersion,
        nowMs,
        publishedPageJson,
      ),
  );

  const batchResults = await tenantDb.batch(statements);
  if (
    (batchResults[0]?.meta?.changes ?? 0) !== 1 ||
    (batchResults[setupStmtIdx]?.meta?.changes ?? 0) !== 1
  ) {
    const latest = await loadRawSetupRow(tenantDb);
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: "preset-setup",
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest?.version ?? currentVersion),
    });
  }

  const latestHomepage = await loadActiveHomepageRow(tenantDb);
  const publishedHomepageId = latestHomepage
    ? Number(latestHomepage.id)
    : priorHomepage
      ? Number(priorHomepage.id)
      : null;

  // Bump PLATFORM_DB `tenants.cache_version` with FULL compensating rollback on failure (HIGH-1)!
  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(platformDb, member.tenantId, nowMs);
  } catch (err) {
    const rollbackStmts: D1PreparedStatement[] = [
      tenantDb
        .prepare(
          `UPDATE preset_setups
           SET status = ?,
               draft_sections_json = ?,
               sample_section_ids_json = ?,
               selected_publish_section_ids_json = ?,
               published_section_ids_json = ?,
               published_at = ?,
               version = ?,
               updated_at = ?
           WHERE id = 1 AND version = ?`,
        )
        .bind(
          existingSetup.status,
          existingSetup.draft_sections_json,
          existingSetup.sample_section_ids_json,
          existingSetup.selected_publish_section_ids_json,
          existingSetup.published_section_ids_json,
          existingSetup.published_at,
          existingSetup.version,
          existingSetup.updated_at,
          currentVersion + 1,
        ),
    ];

    if (publishedHomepageId !== null) {
      rollbackStmts.push(
        tenantDb
          .prepare(
            `DELETE FROM content_revisions
             WHERE resource_type = 'page'
               AND resource_id = ?
               AND created_at = ?
               AND snapshot_json = ?`,
          )
          .bind(publishedHomepageId, nowMs, publishedPageJson),
      );
    }

    if (priorHomepage) {
      rollbackStmts.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET draft_sections_json = ?,
                 published_sections_json = ?,
                 status = ?,
                 published_at = ?,
                 content_modified_at = ?,
                 version = ?,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            priorHomepage.draft_sections_json,
            priorHomepage.published_sections_json,
            priorHomepage.status,
            priorHomepage.published_at,
            priorHomepage.content_modified_at,
            priorHomepage.version,
            priorHomepage.updated_at,
            Number(priorHomepage.id),
            nextHomepageVersion,
          ),
      );
    } else {
      rollbackStmts.push(
        tenantDb
          .prepare("DELETE FROM pages WHERE is_homepage = 1 AND updated_at = ? AND version = 1")
          .bind(nowMs),
      );
    }

    let compensated = false;
    try {
      await tenantDb.batch(rollbackStmts);
      compensated = true;
    } catch {
      // Keep compensated = false if compensation batch itself fails
    }

    throw new PublicationAtomicError(
      err instanceof Error
        ? `Gagal memperbarui cache_version tenant: ${err.message}`
        : "Gagal memperbarui cache_version tenant",
      { compensated, cause: err },
    );
  }

  const revRow =
    publishedHomepageId !== null
      ? await tenantDb
          .prepare(
            "SELECT MAX(revision_number) AS rev FROM content_revisions WHERE resource_type = 'page' AND resource_id = ?",
          )
          .bind(publishedHomepageId)
          .first<{ readonly rev: number | null }>()
      : null;

  const state = await loadVerticalPresetDashboardState(platformDb, tenantDb, member);
  return {
    presetId: canonicalPresetId,
    state,
    publishedSectionIds,
    unpublishedDraftSectionIds: selective.unpublishedDraftSectionIds,
    cacheVersion,
    publishedAt: new Date(nowMs).toISOString(),
    revisionNumber: Number(revRow?.rev ?? 1),
  };
}
