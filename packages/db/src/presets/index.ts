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
  ApplyStarterPresetInputSchema,
  buildCompanyProfileStarterComposition,
  computePresetOperationHash,
  computeSampleSectionIds,
  convertValidatedSectionToPublicPageSectionDto,
  detectSampleClaimsInSection,
  disableSampleSectionsForPageDraft,
  evaluatePresetChecklist,
  isM1AvailablePresetId,
  isOptionalCompanyProfileSection,
  mergePublishedPageSectionsNonDestructively,
  mergeStarterPresetDraftSections,
  PresetDomainError,
  PublishStarterPresetInputSchema,
  STARTER_PRESET_CATALOG,
  UpdatePresetDraftInputSchema,
  validatePresetSelectivePublish,
  type ApplyStarterPresetInput,
  type PresetApplyMode,
  type PresetChecklistSummary,
  type PresetSetupStatus,
  type PublishStarterPresetInput,
  type SampleClaimFinding,
  type StarterPresetCatalogEntry,
  type StarterPresetId,
  type StoredPresetApplyMode,
  type UpdatePresetDraftInput,
} from "@punyasitus/core/presets/index";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  isHealthBusinessCategory,
  validatePageSections,
  type AnyValidatedPageSection,
  type SectionValidationWarning,
} from "@punyasitus/core/theme/sections";
import { isUniqueConstraintError } from "../identifiers/index.ts";
import { bumpTenantCacheVersion } from "../publication/index.ts";
import {
  ensureStarterPresetsTables,
  hasStarterPresetsTables,
} from "./migrations.ts";

export {
  ensureStarterPresetsTables,
  hasStarterPresetsTables,
  TENANT_0012_STARTER_PRESETS_MIGRATION,
  TENANT_0012_STARTER_PRESETS_SQL,
} from "./migrations.ts";

/**
 * Per-Tenant Starter Preset Repository (`packages/db/src/presets/index.ts`;
 * REQ-047, REQ-019, REQ-034, REQ-036; PLAN §11.4; TASK-043).
 *
 * Guarantees:
 * - Operates strictly against one tenant's physically isolated `TenantStore`
 *   plus narrow `PLATFORM_DB` metadata (`tenants`, `tenant_hosts`).
 * - Applying a preset is strictly draft-only and idempotent by `operationKey`.
 * - Reapplying (even with a new `operationKey`) NEVER wipes user-edited draft
 *   sections, NEVER flips published status back to draft, and NEVER deletes or
 *   unpublishes existing pages, posts, offerings, menus, or media.
 * - Sample-marked `[Contoh]` sections are NEVER mirrored as `enabled: true` into
 *   `pages.draft_sections_json`, preventing generic page-publish leaks.
 * - Selective publish validates every selected section, blocks unedited sample
 *   claims and incomplete required checklist items, preserves all pre-existing
 *   live homepage sections non-destructively, gates revision + preset updates
 *   strictly on the page write, and rolls back cleanly on `cache_version` failure.
 */

const MAX_RETAINED_REVISIONS = 20;

export interface PresetMemberScope {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly role: Role;
  readonly tenantStatus: TenantStatus;
}

export interface PresetSectionStatusDto {
  readonly id: string;
  readonly type: AnyValidatedPageSection["type"];
  readonly order: number;
  readonly enabled: boolean;
  readonly optional: boolean;
  readonly selectedForPublish: boolean;
  readonly isPublished: boolean;
  readonly containsSampleCopy: boolean;
  readonly sampleFindings: readonly SampleClaimFinding[];
  readonly section: AnyValidatedPageSection;
}

export interface PresetContentSummaryDto {
  readonly pages: number;
  readonly publishedPages: number;
  readonly posts: number;
  readonly offerings: number;
  readonly menus: number;
  readonly media: number;
  readonly hasExistingHomepage: boolean;
  readonly homepageIsPublished: boolean;
  readonly isPopulatedTenant: boolean;
}

export interface PresetSetupStateDto {
  readonly presetId: StarterPresetId;
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

export interface TenantPresetStateDto {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly vertical: string;
  readonly businessCategory: string;
  readonly isHealthCategory: boolean;
  readonly activeThemeId: string;
  readonly cacheVersion: number;
  readonly catalog: readonly StarterPresetCatalogEntry[];
  readonly setup: PresetSetupStateDto | null;
  readonly checklist: PresetChecklistSummary;
  readonly contentSummary: PresetContentSummaryDto;
  readonly permissions: {
    readonly canRead: boolean;
    readonly canPreview: boolean;
    readonly canMutate: boolean;
    readonly isLocked: boolean;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  };
}

export interface ApplyStarterPresetResult {
  readonly state: TenantPresetStateDto;
  readonly operationKey: string;
  readonly applyMode: StoredPresetApplyMode;
  readonly idempotentReplay: boolean;
  readonly createdHomepageDraft: boolean;
  readonly createdHeaderMenuDraft: boolean;
  readonly preservedExistingContent: boolean;
}

export interface PublishStarterPresetResult {
  readonly state: TenantPresetStateDto;
  readonly publishedSectionIds: readonly string[];
  readonly unpublishedDraftSectionIds: readonly string[];
  readonly cacheVersion: number;
  readonly publishedAt: string;
  readonly revisionNumber: number;
}

interface RawPresetSetupRow {
  readonly id: number;
  readonly preset_id: StarterPresetId;
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

interface RawPresetOperationRow {
  readonly operation_key: string;
  readonly preset_id: StarterPresetId;
  readonly apply_mode: PresetApplyMode;
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

interface StoredOperationResultRecord {
  readonly applyMode: StoredPresetApplyMode;
  readonly createdHomepageDraft: boolean;
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

/**
 * Resolves a unique homepage slug across ALL rows in `pages` (including trashed
 * and non-homepage rows) so seeding or publishing never collides with `UNIQUE(slug)`.
 */
async function resolveAvailableHomepageSlug(tenantDb: D1Database): Promise<string> {
  const rows = await tenantDb
    .prepare("SELECT slug FROM pages WHERE slug = 'beranda' OR slug LIKE 'beranda-%'")
    .all<{ readonly slug: string }>();
  const taken = new Set(rows.results.map((r) => r.slug.toLowerCase()));
  if (!taken.has("beranda")) return "beranda";
  if (!taken.has("beranda-preset")) return "beranda-preset";
  for (let i = 2; i <= 1000; i += 1) {
    const candidate = `beranda-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `beranda-${Date.now().toString(36)}`;
}

function buildHomepagePageSnapshot(
  sections: readonly AnyValidatedPageSection[],
  meta: {
    readonly slug: string;
    readonly title: string;
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
    isHomepage: true,
    layoutMode: "standard",
    sections: [...mergedPublic],
    ...(meta.seo ? { seo: meta.seo } : {}),
  };
}

/**
 * Serializes draft sections for `pages.draft_sections_json`.
 * Strictly disables any sample-marked `[Contoh]` section BEFORE storing in
 * `pages.draft_sections_json` so generic page-publish flows (TASK-034/TASK-036)
 * can NEVER accidentally publish sample copy.
 */
function serializeHomepageDraftEnvelope(params: {
  readonly sections: readonly AnyValidatedPageSection[];
  readonly nextVersion: number;
  readonly slug: string;
  readonly title: string;
  readonly seo: PageSnapshot["seo"];
  readonly existingPublicDraftSections?: readonly PageSnapshot["sections"][number][];
}): { readonly json: string; readonly snapshot: PageSnapshot } {
  const sampleSafeSections = disableSampleSectionsForPageDraft(params.sections);

  const snapshot = buildHomepagePageSnapshot(sampleSafeSections, {
    slug: params.slug,
    title: params.title,
    seo: params.seo,
    existingPublicSections: params.existingPublicDraftSections,
  });

  const draftSectionsMetaJson = JSON.stringify({
    schemaVersion: 1,
    sourceVersion: params.nextVersion,
    enabledSignature: computePublicSectionsSignature(snapshot.sections),
    sections: sampleSafeSections,
  });

  const payload = serializeDraftStoragePayload("page", {
    ...snapshot,
    draftSectionsJson: draftSectionsMetaJson,
  });

  return {
    json: payload.json,
    snapshot,
  };
}

async function queryCount(tenantDb: D1Database, sql: string): Promise<number> {
  try {
    const row = await tenantDb.prepare(sql).first<{ readonly count?: number }>();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
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
}> {
  const tenantRow = await platformDb
    .prepare("SELECT handle, vertical, cache_version FROM tenants WHERE id = ? LIMIT 1")
    .bind(tenantId)
    .first<{
      readonly handle: string;
      readonly vertical: string | null;
      readonly cache_version: number | null;
    }>();

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
  };
}

async function loadHasGroupedPrivacyPage(tenantDb: D1Database): Promise<boolean> {
  try {
    const tableRow = await tenantDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'site_settings_grouped' LIMIT 1",
      )
      .first<{ readonly name?: string }>();
    if (!tableRow?.name) return false;
    const row = await tenantDb
      .prepare("SELECT draft_json, published_json FROM site_settings_grouped WHERE id = 1 LIMIT 1")
      .first<{ readonly draft_json: string | null; readonly published_json: string | null }>();
    const draft = safeParseJson<Record<string, unknown>>(row?.draft_json, {});
    const pub = safeParseJson<Record<string, unknown>>(row?.published_json, {});
    const draftPrivacy = draft.privacy as Record<string, unknown> | undefined;
    const pubPrivacy = pub.privacy as Record<string, unknown> | undefined;
    return Boolean(
      (typeof draftPrivacy?.privacyPageId === "number" && draftPrivacy.privacyPageId > 0) ||
        (typeof pubPrivacy?.privacyPageId === "number" && pubPrivacy.privacyPageId > 0),
    );
  } catch {
    return false;
  }
}

async function loadRawPresetSetupRow(tenantDb: D1Database): Promise<RawPresetSetupRow | null> {
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
    .first<RawPresetSetupRow>();
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

function hydrateSetupDto(
  row: RawPresetSetupRow,
  businessCategory: string,
): PresetSetupStateDto {
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
      optional: isOptionalCompanyProfileSection(section.id),
      selectedForPublish: selectedIds.has(section.id),
      isPublished: publishedIds.has(section.id),
      containsSampleCopy,
      sampleFindings,
      section,
    };
  });

  return {
    presetId: row.preset_id,
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
 * Loads the complete read-only starter preset state, live checklist, and
 * tenant content summary without performing any write or runtime DDL.
 */
export async function loadTenantPresetState(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
): Promise<TenantPresetStateDto> {
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
    menusCount,
    mediaCount,
    privacySlugCount,
    groupedPrivacy,
  ] = await Promise.all([
    loadPlatformContext(platformDb, member.tenantId, member.handle),
    tenantDb
      .prepare("SELECT site_title, active_theme_id FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly site_title: string | null; readonly active_theme_id: string | null }>(),
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
    loadRawPresetSetupRow(tenantDb),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL"),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL AND status = 'published'",
    ),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM posts WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM menus"),
    queryCount(tenantDb, "SELECT COUNT(*) AS count FROM media_items WHERE status = 'ready'"),
    queryCount(
      tenantDb,
      "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL AND slug IN ('kebijakan-privasi', 'privacy-policy', 'privacy', 'privasi')",
    ),
    loadHasGroupedPrivacyPage(tenantDb),
  ]);

  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";
  const setup = setupRow ? hydrateSetupDto(setupRow, businessCategory) : null;

  const hasCustomizedDraftSection = Boolean(
    setup?.sections.some(
      (s) =>
        !s.containsSampleCopy &&
        (s.type === "hero" || s.type === "about" || s.type === "contact_location"),
    ),
  );

  const hasExistingHomepage = homepageRow !== null;
  const homepageIsPublished = Boolean(
    homepageRow && homepageRow.status === "published" && homepageRow.published_sections_json,
  );
  const isPopulatedTenant =
    hasExistingHomepage || pagesCount > 0 || postsCount > 0 || offeringsCount > 0;

  const checklist = evaluatePresetChecklist({
    handle: member.handle,
    siteTitle: siteRow?.site_title ?? member.tenantName,
    businessName: profileRow?.business_name ?? member.tenantName,
    hasCustomizedDraftSection,
    nonTrashedPagesCount: pagesCount,
    nonTrashedOfferingsCount: offeringsCount,
    whatsappE164: profileRow?.whatsapp_e164 ?? null,
    phone: profileRow?.phone ?? null,
    email: profileRow?.email ?? null,
    hasPrivacyPage: privacySlugCount > 0 || groupedPrivacy,
    hasPreviewedPreset: Boolean(setupRow?.previewed_at),
    activeCustomHostname: platformCtx.activeCustomHostname,
    fallbackHost: platformCtx.fallbackHost,
  });

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
    catalog: STARTER_PRESET_CATALOG,
    setup,
    checklist,
    contentSummary: {
      pages: pagesCount,
      publishedPages: publishedPagesCount,
      posts: postsCount,
      offerings: offeringsCount,
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
 * Applies the M1 Company-Profile starter preset atomically and idempotently:
 * - Creates ONLY draft state (NEVER modifies `published_sections_json` or bumps `cache_version`).
 * - Idempotent by `operationKey`: retrying the same operation replays the stored result
 *   without duplicating pages, offerings, or menu items.
 * - Reusing an `operationKey` with a different payload fails with `409 IDEMPOTENCY_KEY_CONFLICT`.
 * - Reapplying with a NEW `operationKey` when a preset draft already exists preserves
 *   all user-edited draft sections, publish selections, status, and `apply_mode`.
 * - On a populated tenant, NEVER deletes or unpublishes existing pages, posts, offerings, or menus.
 * - Sample `[Contoh]` sections are NEVER enabled in `pages.draft_sections_json`.
 */
export async function applyStarterPresetAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
  rawInput: ApplyStarterPresetInput | unknown,
  options: { readonly nowMs?: number } = {},
): Promise<ApplyStarterPresetResult> {
  const parsed = ApplyStarterPresetInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PublicationValidationError(
      parsed.error.issues[0]?.message ?? "Input preset tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        code: "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }

  const input = parsed.data;
  if (!isM1AvailablePresetId(input.presetId)) {
    throw new PresetDomainError(
      422,
      "UNSUPPORTED_PRESET",
      `Preset "${input.presetId}" belum tersedia pada M1. Saat ini hanya preset company_profile yang dapat diterapkan (preset vertikal lainnya tersedia pada M2 TASK-066).`,
      [
        {
          field: "presetId",
          code: "UNSUPPORTED_PRESET",
          message: `Preset "${input.presetId}" is not supported in M1`,
        },
      ],
    );
  }

  await ensureStarterPresetsTables(tenantDb);

  const requestHash = computePresetOperationHash({
    presetId: input.presetId,
    applyMode: input.applyMode,
  });

  // 1. Idempotency check BEFORE any mutation
  const existingOp = await tenantDb
    .prepare(
      `SELECT operation_key, preset_id, apply_mode, request_hash, result_json, created_at
       FROM preset_setup_operations
       WHERE operation_key = ?
       LIMIT 1`,
    )
    .bind(input.operationKey)
    .first<RawPresetOperationRow>();

  if (existingOp) {
    if (existingOp.request_hash !== requestHash) {
      throw new PresetDomainError(
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "Kunci operasi (operationKey) sudah digunakan untuk parameter preset yang berbeda.",
        [
          {
            field: "operationKey",
            code: "IDEMPOTENCY_KEY_CONFLICT",
            message: "operationKey already bound to a different preset request payload",
          },
        ],
      );
    }
    const storedMeta = safeParseJson<StoredOperationResultRecord>(existingOp.result_json, {
      applyMode: "staged_draft",
      createdHomepageDraft: false,
      createdHeaderMenuDraft: false,
      preservedExistingContent: true,
    });
    const state = await loadTenantPresetState(platformDb, tenantDb, member);
    return {
      state,
      operationKey: input.operationKey,
      applyMode: storedMeta.applyMode,
      idempotentReplay: true,
      createdHomepageDraft: storedMeta.createdHomepageDraft,
      createdHeaderMenuDraft: storedMeta.createdHeaderMenuDraft,
      preservedExistingContent: storedMeta.preservedExistingContent,
    };
  }

  const nowMs = options.nowMs ?? Date.now();

  // 2. Inspect existing tenant profile & content so we NEVER delete/overwrite live content or user edits
  const [profileRow, homepageRow, existingSetup, pagesCount, postsCount, offeringsCount, headerMenuRow] =
    await Promise.all([
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
      loadRawPresetSetupRow(tenantDb),
      queryCount(tenantDb, "SELECT COUNT(*) AS count FROM pages WHERE deleted_at IS NULL"),
      queryCount(tenantDb, "SELECT COUNT(*) AS count FROM posts WHERE deleted_at IS NULL"),
      queryCount(tenantDb, "SELECT COUNT(*) AS count FROM offerings WHERE deleted_at IS NULL"),
      tenantDb
        .prepare("SELECT id FROM menus WHERE location = 'header' LIMIT 1")
        .first<{ readonly id: number }>(),
    ]);

  const businessName = profileRow?.business_name?.trim() || member.tenantName;
  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";

  const built = buildCompanyProfileStarterComposition({
    businessName,
    businessCategory,
    address: profileRow?.address ?? null,
    phone: profileRow?.phone ?? null,
    whatsappPhone: profileRow?.whatsapp_e164 ?? null,
    email: profileRow?.email ?? null,
  });

  const isPopulated =
    homepageRow !== null || pagesCount > 0 || postsCount > 0 || offeringsCount > 0;

  // Finding #2: When `preset_setups` already exists, a re-apply with a NEW operationKey
  // MUST preserve existing user-edited draft sections, selection, status, and apply_mode!
  if (existingSetup) {
    const existingRawSections = safeParseJson<unknown[]>(existingSetup.draft_sections_json, []);
    const existingValidated = validatePageSections(existingRawSections, { businessCategory });
    const mergedDraftSections = mergeStarterPresetDraftSections(
      existingValidated.sections,
      built.sections,
      businessCategory,
    );
    const mergedSampleIds = computeSampleSectionIds(mergedDraftSections);
    const preservedApplyMode = existingSetup.apply_mode;
    const preservedStatus = existingSetup.status;
    const preservedSelectedJson = existingSetup.selected_publish_section_ids_json;

    const opRecord: StoredOperationResultRecord = {
      applyMode: preservedApplyMode,
      createdHomepageDraft: false,
      createdHeaderMenuDraft: false,
      preservedExistingContent: true,
    };

    const reApplyStmts: D1PreparedStatement[] = [
      tenantDb
        .prepare(
          `UPDATE preset_setups
           SET draft_sections_json = ?,
               sample_section_ids_json = ?,
               selected_publish_section_ids_json = ?,
               status = ?,
               apply_mode = ?,
               last_operation_key = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1`,
        )
        .bind(
          JSON.stringify(mergedDraftSections),
          JSON.stringify(mergedSampleIds),
          preservedSelectedJson,
          preservedStatus,
          preservedApplyMode,
          input.operationKey,
          nowMs,
        ),
      tenantDb
        .prepare(
          `INSERT INTO preset_setup_operations
             (operation_key, preset_id, apply_mode, request_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.operationKey,
          input.presetId,
          input.applyMode,
          requestHash,
          JSON.stringify(opRecord),
          nowMs,
        ),
    ];

    try {
      await tenantDb.batch(reApplyStmts);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const racedOp = await tenantDb
          .prepare(
            `SELECT operation_key, preset_id, apply_mode, request_hash, result_json, created_at
             FROM preset_setup_operations
             WHERE operation_key = ?
             LIMIT 1`,
          )
          .bind(input.operationKey)
          .first<RawPresetOperationRow>();
        if (racedOp) {
          if (racedOp.request_hash !== requestHash) {
            throw new PresetDomainError(
              409,
              "IDEMPOTENCY_KEY_CONFLICT",
              "Kunci operasi (operationKey) sudah digunakan untuk parameter preset yang berbeda.",
            );
          }
          const storedMeta = safeParseJson<StoredOperationResultRecord>(racedOp.result_json, opRecord);
          const state = await loadTenantPresetState(platformDb, tenantDb, member);
          return {
            state,
            operationKey: input.operationKey,
            applyMode: storedMeta.applyMode,
            idempotentReplay: true,
            createdHomepageDraft: storedMeta.createdHomepageDraft,
            createdHeaderMenuDraft: storedMeta.createdHeaderMenuDraft,
            preservedExistingContent: storedMeta.preservedExistingContent,
          };
        }
      }
      throw err;
    }

    const state = await loadTenantPresetState(platformDb, tenantDb, member);
    return {
      state,
      operationKey: input.operationKey,
      applyMode: preservedApplyMode,
      idempotentReplay: false,
      createdHomepageDraft: false,
      createdHeaderMenuDraft: false,
      preservedExistingContent: true,
    };
  }

  // First-time preset initialization
  let storedApplyMode: StoredPresetApplyMode;
  if (!isPopulated && homepageRow === null) {
    storedApplyMode = "initialized_draft";
  } else if (input.applyMode === "merge_draft") {
    storedApplyMode = "merged_draft";
  } else {
    storedApplyMode = "staged_draft";
  }

  const preservedExistingContent = isPopulated;
  const statements: D1PreparedStatement[] = [];
  let homepageStmtIdx = -1;
  let menuStmtIdx = -1;

  // 3. Fresh tenant: create ONE draft-only homepage with guaranteed collision-free slug (Finding #5)
  //    and sample-disabled `pages.draft_sections_json` (Finding #6)!
  if (storedApplyMode === "initialized_draft" && homepageRow === null) {
    const freeSlug = await resolveAvailableHomepageSlug(tenantDb);
    const homepageDraft = serializeHomepageDraftEnvelope({
      sections: built.sections,
      nextVersion: 1,
      slug: freeSlug,
      title: `Beranda — ${businessName}`,
      seo: null,
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
        .bind(freeSlug, `Beranda — ${businessName}`, homepageDraft.json, nowMs, nowMs, freeSlug),
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
  }

  // 4. Fresh tenant with no header menu: seed ONE draft-only header menu using next available ID (Finding #4)
  if (storedApplyMode === "initialized_draft" && !headerMenuRow) {
    const builtHeaderMenu = buildMenuTree("header", [
      { id: "nav-beranda", label: "Beranda", targetType: "custom", href: "/", sortOrder: 0 },
      { id: "nav-layanan", label: "Layanan", targetType: "custom", href: "/layanan", sortOrder: 1 },
      { id: "nav-kontak", label: "Kontak", targetType: "custom", href: "#kontak", sortOrder: 2 },
    ]);
    const treeJson = JSON.stringify(builtHeaderMenu.tree);
    menuStmtIdx = statements.length;
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO menus
             (id, location, items_json, draft_items_json, published_items_json, version, created_at, updated_at)
           SELECT COALESCE((SELECT MAX(id) FROM menus), 0) + 1, 'header', ?, ?, NULL, 1, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM menus WHERE location = 'header')`,
        )
        .bind(treeJson, treeJson, nowMs, nowMs),
    );
  }

  // 5. Populated tenant with explicit `merge_draft`: append ONLY missing section types to homepage DRAFT
  //    while leaving `published_sections_json`, existing draft sections, and all other content 100% intact,
  //    AND keeping sample `[Contoh]` sections disabled in `pages.draft_sections_json` (Finding #6)!
  let finalDraftSections: readonly AnyValidatedPageSection[] = built.sections;
  if (storedApplyMode === "merged_draft" && homepageRow !== null) {
    const existingAdminDto = extractDraftSnapshotForAdmin("page", {
      resourceId: Number(homepageRow.id),
      status: homepageRow.status,
      deletedAt: homepageRow.deleted_at,
      draftJson: homepageRow.draft_sections_json,
      publishedJson: homepageRow.published_sections_json,
      publishedAt: homepageRow.published_at,
      contentModifiedAt: homepageRow.content_modified_at,
      version: Number(homepageRow.version),
      updatedAt: Number(homepageRow.updated_at),
    });

    const existingDraftSectionsMeta = safeParseJson<{
      readonly sections?: unknown[];
    }>(
      typeof existingAdminDto?.draftMetadata?.draftSectionsJson === "string"
        ? existingAdminDto.draftMetadata.draftSectionsJson
        : null,
      {},
    );

    let existingValidated: readonly AnyValidatedPageSection[] = [];
    if (
      Array.isArray(existingDraftSectionsMeta.sections) &&
      existingDraftSectionsMeta.sections.length > 0
    ) {
      try {
        existingValidated = validatePageSections(existingDraftSectionsMeta.sections, {
          businessCategory,
        }).sections;
      } catch {
        existingValidated = [];
      }
    }

    if (existingValidated.length > 0) {
      finalDraftSections = mergeStarterPresetDraftSections(
        existingValidated,
        built.sections,
        businessCategory,
      );
    }

    const nextHomepageVersion = Number(homepageRow.version) + 1;
    const mergedEnvelope = serializeHomepageDraftEnvelope({
      sections: finalDraftSections,
      nextVersion: nextHomepageVersion,
      slug: homepageRow.slug,
      title: homepageRow.title,
      seo: existingAdminDto?.draft?.seo ?? null,
      existingPublicDraftSections: existingAdminDto?.draft?.sections ?? [],
    });

    // ONLY update `draft_sections_json` — NEVER touch `published_sections_json` or `status`!
    statements.push(
      tenantDb
        .prepare(
          `UPDATE pages
           SET draft_sections_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?
             AND deleted_at IS NULL
             AND version = ?`,
        )
        .bind(mergedEnvelope.json, nowMs, Number(homepageRow.id), Number(homepageRow.version)),
    );
  }

  const finalSampleIds = computeSampleSectionIds(finalDraftSections);
  const finalSelectedIds = finalDraftSections.filter((s) => s.enabled).map((s) => s.id);
  const draftSectionsJson = JSON.stringify(finalDraftSections);
  const sampleIdsJson = JSON.stringify(finalSampleIds);
  const selectedIdsJson = JSON.stringify(finalSelectedIds);

  // 6. Insert singleton `preset_setups` row (always `status = 'draft'` on initial apply)
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
        input.presetId,
        storedApplyMode,
        draftSectionsJson,
        sampleIdsJson,
        selectedIdsJson,
        input.operationKey,
        nowMs,
        nowMs,
      ),
  );

  // 7. Record idempotency ledger entry in the SAME atomic batch
  const opStmtIdx = statements.length;
  const preliminaryOpRecord: StoredOperationResultRecord = {
    applyMode: storedApplyMode,
    createdHomepageDraft: homepageStmtIdx >= 0,
    createdHeaderMenuDraft: menuStmtIdx >= 0,
    preservedExistingContent,
  };
  statements.push(
    tenantDb
      .prepare(
        `INSERT INTO preset_setup_operations
           (operation_key, preset_id, apply_mode, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.operationKey,
        input.presetId,
        input.applyMode,
        requestHash,
        JSON.stringify(preliminaryOpRecord),
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
        .bind(input.operationKey)
        .first<RawPresetOperationRow>();
      if (racedOp) {
        if (racedOp.request_hash !== requestHash) {
          throw new PresetDomainError(
            409,
            "IDEMPOTENCY_KEY_CONFLICT",
            "Kunci operasi (operationKey) sudah digunakan untuk parameter preset yang berbeda.",
          );
        }
        const storedMeta = safeParseJson<StoredOperationResultRecord>(
          racedOp.result_json,
          preliminaryOpRecord,
        );
        const state = await loadTenantPresetState(platformDb, tenantDb, member);
        return {
          state,
          operationKey: input.operationKey,
          applyMode: storedMeta.applyMode,
          idempotentReplay: true,
          createdHomepageDraft: storedMeta.createdHomepageDraft,
          createdHeaderMenuDraft: storedMeta.createdHeaderMenuDraft,
          preservedExistingContent: storedMeta.preservedExistingContent,
        };
      }
    }
    throw err;
  }

  // Report actual `changes()` honestly for createdHomepageDraft / createdHeaderMenuDraft (Finding #4 & #5)
  const actualCreatedHomepageDraft =
    homepageStmtIdx >= 0 ? (batchResults[homepageStmtIdx]?.meta?.changes ?? 0) === 1 : false;
  const actualCreatedHeaderMenuDraft =
    menuStmtIdx >= 0 ? (batchResults[menuStmtIdx]?.meta?.changes ?? 0) === 1 : false;

  if (
    opStmtIdx >= 0 &&
    (actualCreatedHomepageDraft !== preliminaryOpRecord.createdHomepageDraft ||
      actualCreatedHeaderMenuDraft !== preliminaryOpRecord.createdHeaderMenuDraft)
  ) {
    const correctedRecord: StoredOperationResultRecord = {
      applyMode: storedApplyMode,
      createdHomepageDraft: actualCreatedHomepageDraft,
      createdHeaderMenuDraft: actualCreatedHeaderMenuDraft,
      preservedExistingContent,
    };
    await tenantDb
      .prepare("UPDATE preset_setup_operations SET result_json = ? WHERE operation_key = ?")
      .bind(JSON.stringify(correctedRecord), input.operationKey)
      .run();
  }

  const state = await loadTenantPresetState(platformDb, tenantDb, member);
  return {
    state,
    operationKey: input.operationKey,
    applyMode: storedApplyMode,
    idempotentReplay: false,
    createdHomepageDraft: actualCreatedHomepageDraft,
    createdHeaderMenuDraft: actualCreatedHeaderMenuDraft,
    preservedExistingContent,
  };
}

/**
 * Updates draft starter preset sections and publish-selection flags atomically:
 * - Strictly validates all sections via `validatePageSections` (unsupported types,
 *   unsafe URLs, duplicate singletons, or invalid configs fail with `422` and ZERO writes).
 * - Enforces optimistic concurrency via `expectedVersion` (`409 STALE_VERSION`).
 * - NEVER alters live published snapshots (`published_sections_json`) and NEVER
 *   mirrors sample-marked `[Contoh]` sections as `enabled: true` into `pages.draft_sections_json`.
 */
export async function updateStarterPresetDraftAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
  rawInput: UpdatePresetDraftInput | unknown,
  options: { readonly nowMs?: number } = {},
): Promise<TenantPresetStateDto> {
  const parsed = UpdatePresetDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PublicationValidationError(
      parsed.error.issues[0]?.message ?? "Perubahan draf preset tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        code: "VALIDATION_ERROR",
        message: issue.message,
      })),
    );
  }
  const input = parsed.data;

  await ensureStarterPresetsTables(tenantDb);

  const existingSetup = await loadRawPresetSetupRow(tenantDb);
  if (!existingSetup) {
    throw new PresetDomainError(
      404,
      "PRESET_NOT_INITIALIZED",
      "Preset pemula belum diterapkan pada situs ini. Terapkan preset terlebih dahulu.",
    );
  }

  const profileRow = await tenantDb
    .prepare("SELECT business_category FROM business_profile WHERE id = 1 LIMIT 1")
    .first<{ readonly business_category: string | null }>();
  const businessCategory = profileRow?.business_category?.trim() || "LocalBusiness";

  // 1. Validate EVERY section strictly BEFORE touching SQLite
  const validated = validatePageSections(input.sections, { businessCategory });
  const validIds = new Set(validated.sections.map((s) => s.id));

  // 2. Validate selectedPublishSectionIds if provided
  let nextSelectedIds: string[];
  if (input.selectedPublishSectionIds !== undefined) {
    const seen = new Set<string>();
    const invalidFields: { field: string; code: string; message: string; sectionId?: string }[] = [];
    for (const id of input.selectedPublishSectionIds) {
      if (seen.has(id)) {
        invalidFields.push({
          field: "selectedPublishSectionIds",
          code: "DUPLICATE_SECTION_SELECTION",
          message: `Bagian "${id}" dipilih lebih dari sekali.`,
          sectionId: id,
        });
      } else if (!validIds.has(id)) {
        invalidFields.push({
          field: "selectedPublishSectionIds",
          code: "UNKNOWN_SECTION_ID",
          message: `Bagian "${id}" tidak ada dalam daftar bagian draf.`,
          sectionId: id,
        });
      } else {
        seen.add(id);
      }
    }
    if (invalidFields.length > 0) {
      throw new PresetDomainError(
        422,
        "INVALID_SECTION_SELECTION",
        "Daftar bagian terpilih untuk penerbitan tidak valid.",
        invalidFields,
      );
    }
    nextSelectedIds = [...seen];
  } else {
    const prevSelected = new Set(parseStringArray(existingSetup.selected_publish_section_ids_json));
    nextSelectedIds = validated.sections
      .filter((s) => prevSelected.has(s.id) && s.enabled)
      .map((s) => s.id);
  }

  // 3. Optimistic concurrency check BEFORE write
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
  const sampleIds = computeSampleSectionIds(validated.sections);
  const statements: D1PreparedStatement[] = [
    tenantDb
      .prepare(
        `UPDATE preset_setups
         SET draft_sections_json = ?,
             sample_section_ids_json = ?,
             selected_publish_section_ids_json = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = 1 AND version = ?`,
      )
      .bind(
        JSON.stringify(validated.sections),
        JSON.stringify(sampleIds),
        JSON.stringify(nextSelectedIds),
        nowMs,
        input.expectedVersion,
      ),
  ];

  // If this preset initialized a fresh draft-only homepage (never published yet), keep its draft synced
  // with sample-marked sections strictly disabled (Finding #6)
  if (existingSetup.apply_mode === "initialized_draft") {
    const homepageRow = await loadActiveHomepageRow(tenantDb);
    if (homepageRow && homepageRow.status === "draft" && !homepageRow.published_sections_json) {
      const nextHomepageVersion = Number(homepageRow.version) + 1;
      const draftEnv = serializeHomepageDraftEnvelope({
        sections: validated.sections,
        nextVersion: nextHomepageVersion,
        slug: homepageRow.slug,
        title: homepageRow.title,
        seo: safeParseJson<PageSnapshot["seo"]>(homepageRow.seo_json, null),
      });
      statements.push(
        tenantDb
          .prepare(
            `UPDATE pages
             SET draft_sections_json = ?,
                 version = version + 1,
                 updated_at = ?
             WHERE changes() = 1
               AND id = ?
               AND status = 'draft'
               AND published_sections_json IS NULL
               AND version = ?`,
          )
          .bind(draftEnv.json, nowMs, Number(homepageRow.id), Number(homepageRow.version)),
      );
    }
  }

  const batchRes = await tenantDb.batch(statements);
  const updatedRows = batchRes[0]?.meta?.changes ?? 0;
  if (updatedRows !== 1) {
    const latest = await loadRawPresetSetupRow(tenantDb);
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: "preset-setup",
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest?.version ?? currentVersion),
    });
  }

  return loadTenantPresetState(platformDb, tenantDb, member);
}

/**
 * Records that the owner/admin inspected the responsive draft preview so the
 * checklist's `preview` item reflects verified completion.
 */
export async function markStarterPresetPreviewed(
  tenantDb: D1Database,
  nowMs = Date.now(),
): Promise<void> {
  if (!(await hasStarterPresetsTables(tenantDb))) {
    return;
  }
  await tenantDb
    .prepare("UPDATE preset_setups SET previewed_at = ? WHERE id = 1")
    .bind(nowMs)
    .run();
}

/**
 * Atomically publishes ONLY the validated, non-sample selected sections from the
 * starter preset composition into the tenant's homepage snapshot:
 * - Blocks unedited sample claims (`422 SAMPLE_CONTENT_BLOCKED`).
 * - Blocks incomplete required checklist items (`422 CHECKLIST_INCOMPLETE`, Finding #7),
 *   while missing optional modules NEVER block first publication.
 * - Non-destructively merges into pre-existing live homepage sections (Finding #1):
 *   existing published & draft sections are NEVER discarded or overwritten.
 * - Gates `content_revisions` INSERT strictly on `pages` write (`changes() = 1`) and
 *   gates `preset_setups` UPDATE on the committed `pages` row (Finding #3).
 * - On `cache_version` bump failure, compensates `preset_setups`, `pages` (with optimistic
 *   version guard), AND deletes the created `content_revisions` row cleanly (Finding #3).
 */
export async function publishStarterPresetSectionsAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  member: PresetMemberScope,
  rawInput: PublishStarterPresetInput | unknown,
  options: { readonly nowMs?: number } = {},
): Promise<PublishStarterPresetResult> {
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

  await ensureStarterPresetsTables(tenantDb);

  const existingSetup = await loadRawPresetSetupRow(tenantDb);
  if (!existingSetup) {
    throw new PresetDomainError(
      404,
      "PRESET_NOT_INITIALIZED",
      "Preset pemula belum diterapkan pada situs ini.",
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

  // 1. Strict selective publish validation (blocks invalid sections AND sample claims!)
  const selective = validatePresetSelectivePublish({
    presetId: input.presetId,
    draftSections: validatedDraft.sections,
    selectedSectionIds: input.selectedSectionIds,
    businessCategory,
  });

  // 2. Server-side required checklist enforcement (Finding #7):
  //    Required items (`identity`, `first_content`) must be complete; optional modules never block!
  const checklist = evaluatePresetChecklist({
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

  // 3. Optimistic version check BEFORE touching SQLite
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

  const pageSlug = priorHomepage?.slug ?? (await resolveAvailableHomepageSlug(tenantDb));
  const pageTitle = priorHomepage?.title ?? `Beranda — ${businessName}`;
  const pageSeo = safeParseJson<PageSnapshot["seo"]>(priorHomepage?.seo_json ?? null, null);
  const nextHomepageVersion = priorHomepage ? Number(priorHomepage.version) + 1 : 1;

  // Finding #1: Extract existing live published & draft homepage sections so we MERGE
  // non-destructively and NEVER discard pre-existing live/draft content!
  let existingPublishedSections: readonly PageSnapshot["sections"][number][] = [];
  let existingDraftPublicSections: readonly PageSnapshot["sections"][number][] = [];
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
  }

  // Build published snapshot merging ONLY validated selected preset sections onto existing live sections!
  const publishedPageSnapshot = buildHomepagePageSnapshot(selective.selectedSections, {
    slug: pageSlug,
    title: pageTitle,
    seo: pageSeo,
    existingPublicSections: existingPublishedSections,
  });

  const priorPublishedAt = priorHomepage?.published_at ?? nowMs;
  const pageEnvelope = buildPublishedSnapshot("page", publishedPageSnapshot, {
    publishedAt: priorPublishedAt,
    contentModifiedAt: nowMs,
  });
  const publishedPageJson = JSON.stringify(pageEnvelope);

  // Keep FULL preset draft composition in `preset_setups` and sample-safe merged draft in `pages`
  const selectedIdSet = new Set(selective.selectedSections.map((s) => s.id));
  const syncedFullDraftSections = validatedDraft.sections.map((section) => ({
    ...section,
    enabled: selectedIdSet.has(section.id),
  })) as readonly AnyValidatedPageSection[];

  const syncedDraftEnvelope = serializeHomepageDraftEnvelope({
    sections: syncedFullDraftSections,
    nextVersion: nextHomepageVersion,
    slug: pageSlug,
    title: pageTitle,
    seo: pageSeo,
    existingPublicDraftSections: existingDraftPublicSections,
  });

  const publishedSectionIds = selective.selectedSections.map((s) => s.id);
  const sampleSectionIds = computeSampleSectionIds(syncedFullDraftSections);

  // Finding #3: Execute `pages` write FIRST, chain `content_revisions` INSERT directly on
  // `changes() = 1`, and gate `preset_setups` UPDATE on the committed `pages` row!
  const statements: D1PreparedStatement[] = [];
  const homepageStmtIdx = 0;

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

  // Statement 1: `content_revisions` INSERT strictly chained to Statement 0 via `WHERE changes() = 1`!
  const revResourceIdExpr = priorHomepage
    ? `${Number(priorHomepage.id)}`
    : "(SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL AND version = 1 AND updated_at = ? LIMIT 1)";

  if (priorHomepage) {
    statements.push(
      tenantDb
        .prepare(
          `INSERT INTO content_revisions
             (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
           SELECT 'page',
                  ${revResourceIdExpr},
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = 'page' AND resource_id = ${revResourceIdExpr}), 0) + 1,
                  ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(publishedPageJson, member.userId, nowMs),
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
  }

  // Sync `sequences` allocator if homepage was freshly inserted
  if (priorHomepage === null) {
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

  // Trim revisions to MAX_RETAINED_REVISIONS (20)
  if (priorHomepage) {
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
          `DELETE FROM content_revisions
           WHERE resource_type = 'page'
             AND resource_id = (SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1)
             AND revision_number NOT IN (
               SELECT revision_number
               FROM content_revisions
               WHERE resource_type = 'page'
                 AND resource_id = (SELECT id FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1)
               ORDER BY revision_number DESC
               LIMIT ?
             )`,
        )
        .bind(MAX_RETAINED_REVISIONS),
    );
  }

  // Final statement: update `preset_setups` ONLY if `pages` was actually updated/inserted by THIS publish!
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
  const pageChanges = batchResults[homepageStmtIdx]?.meta?.changes ?? 0;
  const setupChanges = batchResults[setupStmtIdx]?.meta?.changes ?? 0;

  if (pageChanges !== 1 || setupChanges !== 1) {
    const latest = await loadRawPresetSetupRow(tenantDb);
    throw new StaleRevisionError({
      resourceType: "page",
      resourceId: "preset-setup",
      expectedVersion: input.expectedVersion,
      actualVersion: Number(latest?.version ?? currentVersion),
    });
  }

  const latestHomepage = await loadActiveHomepageRow(tenantDb);
  const publishedHomepageId = latestHomepage ? Number(latestHomepage.id) : (priorHomepage ? Number(priorHomepage.id) : null);

  // Bump PLATFORM_DB `tenants.cache_version` with full optimistic compensation (Finding #3):
  // restores `preset_setups`, restores `pages` with optimistic version guard, AND deletes the inserted revision!
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
      // Keep compensated = false when rollback batch fails
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

  const state = await loadTenantPresetState(platformDb, tenantDb, member);

  return {
    state,
    publishedSectionIds,
    unpublishedDraftSectionIds: selective.unpublishedDraftSectionIds,
    cacheVersion,
    publishedAt: new Date(nowMs).toISOString(),
    revisionNumber: Number(revRow?.rev ?? 1),
  };
}
