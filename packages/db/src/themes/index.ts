import {
  buildPublishedSnapshot,
  PublicationAtomicError,
  serializeDraftStoragePayload,
  SiteSettingsSnapshotSchema,
  StaleRevisionError,
  type SiteSettingsSnapshot,
} from "@punyasitus/core/content/index";
import {
  ThemeIncompatibleError,
  validateThemeConfigSnapshot,
  type ThemeCompatibilityReport,
  type ThemeCompatibilitySectionRef,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import { bumpTenantCacheVersion } from "../publication/index.ts";

/**
 * Theme Library Grant Repository & Atomic Theme Activation Engine
 * (REQ-046, REQ-018, REQ-021, REQ-034, REQ-036; PLAN §11.4; TASK-042).
 *
 * Uses existing `0001_initial_platform.sql` (`tenants`, `theme_catalog`,
 * `tenant_theme_entitlements`) and `0001_initial_tenant.sql` (`site_settings`,
 * `theme_configs`, `pages`, `posts`, `offerings`, `menus`, `media_items`,
 * `content_revisions`, `tenant_activity_log`) — ZERO schema migrations and ZERO runtime DDL.
 *
 * Key Invariants:
 * 1. Previous theme's `theme_configs` row stays 100% intact when switching themes and
 *    its published config is automatically recovered when switching back.
 * 2. Unpublished `draft_json` on BOTH `site_settings` and `theme_configs` is NEVER
 *    silently published and NEVER erased/overwritten during theme activation.
 * 3. ZERO tenant content rows (`pages`, `posts`, `offerings`, `menus`, `media_items`)
 *    are deleted or mutated during theme activation.
 * 4. Activation executes ALL writes inside ONE true all-or-nothing SQLite
 *    `tenantDb.batch([...])`: Statement 0 gates on BOTH `site_settings.version` AND
 *    target `theme_configs` version/existence, and every subsequent statement gates on
 *    `changes() = 1` + exact match predicates (ZERO partial writes on any concurrent race!).
 * 5. `PLATFORM_DB.tenants.cache_version` bump failure triggers a chained `changes() = 1`
 *    version-guarded compensation batch so interleaved writers can never leave tables inconsistent.
 */

const MAX_RETAINED_REVISIONS = 20 as const;

export interface TenantThemeGrantDto {
  readonly id: string;
  readonly tenantId: string;
  readonly themeId: string;
  readonly slug: string;
  readonly name: string;
  readonly tier: "included" | "paid_once" | "custom";
  readonly active: boolean;
  readonly grantedBy: string | null;
  readonly settlementId: string | null;
  readonly grantedAt: number;
}

export interface TenantPlatformThemeContext {
  readonly tenantId: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: string;
  readonly status: string;
  readonly agencyId: string | null;
  readonly cacheVersion: number;
  readonly grants: readonly TenantThemeGrantDto[];
}

export interface SavedThemeConfigRecord {
  readonly themeId: string;
  /** Published tokens only (NEVER sourced from unpublished `draft_json`). */
  readonly tokens: ThemeTokens | null;
  /** Published variants only (NEVER sourced from unpublished `draft_json`). */
  readonly variants: ThemeVariants | null;
  readonly hasDraft: boolean;
  readonly hasPublished: boolean;
  readonly version: number;
  readonly updatedAt: number;
}

export interface TenantContentCounts {
  readonly pages: number;
  readonly posts: number;
  readonly offerings: number;
  readonly offeringTypes: readonly string[];
  readonly menus: number;
  readonly media: number;
}

export interface TenantThemeLibraryDbState {
  readonly activeThemeId: string;
  readonly siteSettingsVersion: number;
  readonly siteSettingsUpdatedAt: number | null;
  readonly blogEnabled: boolean;
  readonly catalogEnabled: boolean;
  readonly savedThemeConfigs: ReadonlyMap<string, SavedThemeConfigRecord>;
  readonly pageSections: readonly ThemeCompatibilitySectionRef[];
  readonly contentCounts: TenantContentCounts;
}

interface RawGrantRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly theme_id: string;
  readonly granted_by: string | null;
  readonly settlement_id: string | null;
  readonly granted_at: number;
  readonly slug: string;
  readonly name: string;
  readonly tier: "included" | "paid_once" | "custom";
  readonly active: number;
}

interface RawTenantRow {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: string;
  readonly status: string;
  readonly agency_id: string | null;
  readonly cache_version: number;
}

interface RawSiteSettingsRow {
  readonly id: number;
  readonly site_title: string;
  readonly tagline: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly active_theme_id: string;
  readonly favicon_media_id: number | null;
  readonly og_image_media_id: number | null;
  readonly blog_enabled: number;
  readonly catalog_enabled: number;
  readonly ai_training_policy: "allow" | "disallow";
  readonly analytics_config_json: string | null;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawThemeConfigRow {
  readonly theme_id: string;
  readonly tokens_json: string;
  readonly variants_json: string;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
}

interface RawPageSectionRow {
  readonly id: number;
  readonly is_homepage: number;
  readonly draft_sections_json: string | null;
  readonly published_sections_json: string | null;
}

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractSectionsArrayFromStoredColumn(
  raw: string | null | undefined,
): ThemeCompatibilitySectionRef[] {
  const parsed = safeParseJson(raw);
  if (!parsed) return [];

  const collect = (arr: unknown[]): ThemeCompatibilitySectionRef[] => {
    const refs: ThemeCompatibilitySectionRef[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      refs.push({
        id: typeof rec.id === "string" ? rec.id : null,
        type: typeof rec.type === "string" ? rec.type : null,
        kind: typeof rec.kind === "string" ? rec.kind : null,
        schemaVersion: typeof rec.schemaVersion === "number" ? rec.schemaVersion : null,
        enabled: typeof rec.enabled === "boolean" ? rec.enabled : null,
      });
    }
    return refs;
  };

  if (Array.isArray(parsed)) {
    return collect(parsed);
  }

  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const refs: ThemeCompatibilitySectionRef[] = [];

    if (rec.data && typeof rec.data === "object" && !Array.isArray(rec.data)) {
      const dataRec = rec.data as Record<string, unknown>;
      if (Array.isArray(dataRec.sections)) {
        refs.push(...collect(dataRec.sections));
      }
    } else if (Array.isArray(rec.sections)) {
      refs.push(...collect(rec.sections));
    }

    if (
      rec._draftMetadata &&
      typeof rec._draftMetadata === "object" &&
      !Array.isArray(rec._draftMetadata)
    ) {
      const meta = rec._draftMetadata as Record<string, unknown>;
      if (typeof meta.draftSectionsJson === "string") {
        const metaParsed = safeParseJson(meta.draftSectionsJson);
        if (Array.isArray(metaParsed)) {
          refs.push(...collect(metaParsed));
        } else if (metaParsed && typeof metaParsed === "object" && !Array.isArray(metaParsed)) {
          const metaObj = metaParsed as Record<string, unknown>;
          if (Array.isArray(metaObj.sections)) {
            refs.push(...collect(metaObj.sections));
          }
        }
      }
    }

    return refs;
  }

  return [];
}

/**
 * Recovers ONLY a theme's explicitly PUBLISHED snapshot (`published_json`).
 * NEVER reads or promotes unpublished `draft_json` into live configuration (M3; REQ-036).
 */
function parsePublishedThemeSnapshot(row: RawThemeConfigRow): ThemeConfigSnapshot | null {
  if (!row.published_json) {
    return null;
  }
  const parsed = safeParseJson(row.published_json);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const rec = parsed as Record<string, unknown>;
    const candidate =
      rec.snapshotVersion === 1 && rec.data && typeof rec.data === "object" ? rec.data : rec;
    try {
      return validateThemeConfigSnapshot(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Loads active, tenant-scoped theme grants from `PLATFORM_DB` (`tenant_theme_entitlements`
 * joined to active `theme_catalog` rows) strictly filtered by `WHERE tte.tenant_id = ?`.
 */
export async function loadTenantThemeGrantsFromPlatformDb(
  platformDb: D1Database,
  tenantId: string,
): Promise<readonly TenantThemeGrantDto[]> {
  const rows = await platformDb
    .prepare(
      `SELECT tte.id,
              tte.tenant_id,
              tte.theme_id,
              tte.granted_by,
              tte.settlement_id,
              tte.granted_at,
              tc.slug,
              tc.name,
              tc.tier,
              tc.active
       FROM tenant_theme_entitlements tte
       INNER JOIN theme_catalog tc ON tc.id = tte.theme_id
       WHERE tte.tenant_id = ?
         AND tc.active = 1
       ORDER BY tte.granted_at DESC`,
    )
    .bind(tenantId)
    .all<RawGrantRow>();

  return rows.results.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    themeId: r.theme_id,
    slug: r.slug,
    name: r.name,
    tier: r.tier,
    active: r.active === 1,
    grantedBy: r.granted_by,
    settlementId: r.settlement_id,
    grantedAt: Number(r.granted_at),
  }));
}

/**
 * Loads tenant control-plane theme context (`vertical`, `status`, `agency_id`, `cache_version`,
 * and strictly scoped `grants`) from `PLATFORM_DB`.
 */
export async function loadTenantPlatformThemeContext(
  platformDb: D1Database,
  tenantId: string,
): Promise<TenantPlatformThemeContext | null> {
  const [tenantRow, grants] = await Promise.all([
    platformDb
      .prepare(
        `SELECT id, handle, name, vertical, status, agency_id, cache_version
         FROM tenants
         WHERE id = ?
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<RawTenantRow>(),
    loadTenantThemeGrantsFromPlatformDb(platformDb, tenantId),
  ]);

  if (!tenantRow) {
    return null;
  }

  return {
    tenantId: tenantRow.id,
    handle: tenantRow.handle,
    name: tenantRow.name,
    vertical: tenantRow.vertical,
    status: tenantRow.status,
    agencyId: tenantRow.agency_id,
    cacheVersion: Number(tenantRow.cache_version ?? 1),
    grants,
  };
}

/**
 * Loads read-only tenant theme library state from `TenantStore`:
 * active theme, `site_settings` version, all per-theme saved `theme_configs` rows,
 * all active page sections (published + draft) for compatibility evaluation, and content counts.
 */
export async function loadTenantThemeLibraryDbState(
  tenantDb: D1Database,
): Promise<TenantThemeLibraryDbState> {
  const [
    siteRow,
    themeConfigRows,
    pageRows,
    postCountRow,
    offeringCountRow,
    offeringTypeRows,
    menuCountRow,
    mediaCountRow,
  ] = await Promise.all([
    tenantDb
      .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
      .first<RawSiteSettingsRow>(),
    tenantDb
      .prepare(
        "SELECT theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at FROM theme_configs ORDER BY updated_at DESC",
      )
      .all<RawThemeConfigRow>(),
    tenantDb
      .prepare(
        "SELECT id, is_homepage, draft_sections_json, published_sections_json FROM pages WHERE deleted_at IS NULL",
      )
      .all<RawPageSectionRow>(),
    tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM posts WHERE deleted_at IS NULL")
      .first<{ readonly cnt: number }>(),
    tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM offerings WHERE deleted_at IS NULL")
      .first<{ readonly cnt: number }>(),
    tenantDb
      .prepare("SELECT DISTINCT offering_type FROM offerings WHERE deleted_at IS NULL")
      .all<{ readonly offering_type: string }>(),
    tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM menus")
      .first<{ readonly cnt: number }>(),
    tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM media_items WHERE status = 'ready'")
      .first<{ readonly cnt: number }>(),
  ]);

  const savedThemeConfigs = new Map<string, SavedThemeConfigRecord>();
  for (const row of themeConfigRows.results) {
    const publishedSnapshot = parsePublishedThemeSnapshot(row);
    savedThemeConfigs.set(row.theme_id, {
      themeId: row.theme_id,
      tokens: publishedSnapshot?.tokens ?? null,
      variants: publishedSnapshot?.variants ?? null,
      hasDraft: Boolean(row.draft_json),
      hasPublished: publishedSnapshot !== null,
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    });
  }

  const pageSections: ThemeCompatibilitySectionRef[] = [];
  for (const page of pageRows.results) {
    pageSections.push(...extractSectionsArrayFromStoredColumn(page.published_sections_json));
    pageSections.push(...extractSectionsArrayFromStoredColumn(page.draft_sections_json));
  }

  return {
    activeThemeId: siteRow?.active_theme_id ?? "compro",
    siteSettingsVersion: siteRow ? Number(siteRow.version) : 0,
    siteSettingsUpdatedAt: siteRow ? Number(siteRow.updated_at) : null,
    blogEnabled: siteRow ? siteRow.blog_enabled === 1 : true,
    catalogEnabled: siteRow ? siteRow.catalog_enabled === 1 : true,
    savedThemeConfigs,
    pageSections,
    contentCounts: {
      pages: pageRows.results.length,
      posts: Number(postCountRow?.cnt ?? 0),
      offerings: Number(offeringCountRow?.cnt ?? 0),
      offeringTypes: offeringTypeRows.results.map((r) => r.offering_type),
      menus: Number(menuCountRow?.cnt ?? 0),
      media: Number(mediaCountRow?.cnt ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Atomic Theme Activation Engine (REQ-046, REQ-036; PLAN §11.4)
// ---------------------------------------------------------------------------

export interface ThemeActivationTarget {
  readonly id: string;
  readonly name: string;
  readonly defaultTokens: ThemeTokens;
  readonly defaultVariants: ThemeVariants;
}

export interface ActivateTenantThemeAtomicallyParams {
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly targetTheme: ThemeActivationTarget;
  readonly expectedVersion: number;
  readonly compatibility: ThemeCompatibilityReport;
  readonly nowMs?: number;
  /** Test-only hook invoked after pre-read and immediately before `tenantDb.batch()` to exercise real concurrency races. */
  readonly beforeBatchWrite?: () => Promise<void> | void;
  /** Test-only hook invoked right before `bumpTenantCacheVersion` to exercise compensation races. */
  readonly beforeCacheBump?: () => Promise<void> | void;
}

export interface ActivateTenantThemeAtomicallyResult {
  readonly activatedThemeId: string;
  readonly previousThemeId: string;
  readonly recoveredExistingConfig: boolean;
  readonly recoveredTokens: ThemeTokens;
  readonly recoveredVariants: ThemeVariants;
  readonly version: number;
  readonly themeConfigVersion: number;
  readonly cacheVersion: number;
  readonly activatedAt: string;
}

/**
 * Builds the next PUBLISHED `site_settings` snapshot strictly from existing PUBLISHED state
 * (or live baseline columns if never published yet) — NEVER sourcing unpublished `draft_json` (M2)!
 */
function buildNextPublishedSiteSettingsSnapshot(
  priorSiteRow: RawSiteSettingsRow | null,
  fallbackSiteTitle: string,
  nextThemeId: string,
): SiteSettingsSnapshot {
  const priorParsed = safeParseJson(priorSiteRow?.published_json);
  let priorData: Record<string, unknown> | null = null;
  if (priorParsed && typeof priorParsed === "object" && !Array.isArray(priorParsed)) {
    const rec = priorParsed as Record<string, unknown>;
    if (
      rec.snapshotVersion === 1 &&
      rec.data &&
      typeof rec.data === "object" &&
      !Array.isArray(rec.data)
    ) {
      priorData = rec.data as Record<string, unknown>;
    } else {
      priorData = rec;
    }
  }

  const candidate = {
    siteTitle:
      (typeof priorData?.siteTitle === "string" && priorData.siteTitle.trim()) ||
      priorSiteRow?.site_title ||
      fallbackSiteTitle,
    tagline:
      priorData && "tagline" in priorData
        ? priorData.tagline
        : (priorSiteRow?.tagline ?? null),
    timezone:
      (typeof priorData?.timezone === "string" && priorData.timezone) ||
      priorSiteRow?.timezone ||
      "Asia/Jakarta",
    locale:
      (typeof priorData?.locale === "string" && priorData.locale) ||
      priorSiteRow?.locale ||
      "id-ID",
    activeThemeId: nextThemeId,
    faviconMediaId:
      priorData && "faviconMediaId" in priorData
        ? priorData.faviconMediaId
        : (priorSiteRow?.favicon_media_id ?? null),
    ogImageMediaId:
      priorData && "ogImageMediaId" in priorData
        ? priorData.ogImageMediaId
        : (priorSiteRow?.og_image_media_id ?? null),
    blogEnabled:
      typeof priorData?.blogEnabled === "boolean"
        ? priorData.blogEnabled
        : priorSiteRow
          ? priorSiteRow.blog_enabled === 1
          : true,
    catalogEnabled:
      typeof priorData?.catalogEnabled === "boolean"
        ? priorData.catalogEnabled
        : priorSiteRow
          ? priorSiteRow.catalog_enabled === 1
          : true,
    aiTrainingPolicy:
      priorData?.aiTrainingPolicy === "disallow" || priorSiteRow?.ai_training_policy === "disallow"
        ? ("disallow" as const)
        : ("allow" as const),
    analyticsConfig:
      priorData && "analyticsConfig" in priorData
        ? priorData.analyticsConfig
        : safeParseJson(priorSiteRow?.analytics_config_json),
    siteVisibility:
      priorData?.siteVisibility === "noindex" ? ("noindex" as const) : ("public" as const),
  };

  return SiteSettingsSnapshotSchema.parse(candidate);
}

/**
 * Independently preserves ALL pending unpublished fields in `site_settings.draft_json`
 * while updating ONLY `activeThemeId` inside the draft payload (M2; REQ-036).
 * If `priorDraftJson` is null, returns `null` so we never fabricate an unpublished draft.
 */
function buildPreservedSiteSettingsDraftJson(
  priorDraftJson: string | null | undefined,
  nextThemeId: string,
): string | null {
  if (!priorDraftJson || !priorDraftJson.trim()) {
    return null;
  }

  const parsed = safeParseJson(priorDraftJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return priorDraftJson;
  }

  const rec = parsed as Record<string, unknown>;
  if (
    rec.snapshotVersion === 1 &&
    rec.data &&
    typeof rec.data === "object" &&
    !Array.isArray(rec.data)
  ) {
    return JSON.stringify({
      ...rec,
      data: {
        ...(rec.data as Record<string, unknown>),
        activeThemeId: nextThemeId,
      },
    });
  }

  try {
    return serializeDraftStoragePayload("site_settings", {
      ...rec,
      activeThemeId: nextThemeId,
    }).json;
  } catch {
    return JSON.stringify({
      ...rec,
      activeThemeId: nextThemeId,
    });
  }
}

function buildTargetThemeGuardClause(
  themeId: string,
  expectedThemeVersion: number,
): { readonly sql: string; readonly args: readonly unknown[] } {
  if (expectedThemeVersion > 0) {
    return {
      sql: "EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ? AND version = ?)",
      args: [themeId, expectedThemeVersion],
    };
  }
  return {
    sql: "NOT EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ?)",
    args: [themeId],
  };
}

/**
 * Atomically switches the tenant's active theme while preserving:
 * - 100% of the previous theme's `theme_configs` row (untouched & recoverable when switching back).
 * - 100% of unpublished `draft_json` on BOTH `site_settings` and `theme_configs` (never silently published or erased).
 * - 100% of tenant content (`pages`, `posts`, `offerings`, `menus`, `media_items` untouched).
 * - True all-or-nothing SQLite batch: Statement 0 gates on BOTH `site_settings.version` AND
 *   target `theme_configs` version/existence, so ANY concurrent race causes ZERO writes!
 * - Chained `changes() = 1` version-guarded compensation batch if `PLATFORM_DB` cache_version bump fails.
 */
export async function activateTenantThemeAtomically(
  params: ActivateTenantThemeAtomicallyParams,
): Promise<ActivateTenantThemeAtomicallyResult> {
  const nowMs = params.nowMs ?? Date.now();

  // 1. Compatibility gate BEFORE any DB write
  if (!params.compatibility.compatible) {
    throw new ThemeIncompatibleError(params.targetTheme.id, params.compatibility);
  }

  // 2. Read current state & snapshot rows for optimistic guard + compensation
  const [priorSiteRow, priorTargetThemeRow, homepageRow] = await Promise.all([
    params.tenantDb
      .prepare("SELECT * FROM site_settings WHERE id = 1 LIMIT 1")
      .first<RawSiteSettingsRow>(),
    params.tenantDb
      .prepare(
        "SELECT theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at FROM theme_configs WHERE theme_id = ? LIMIT 1",
      )
      .bind(params.targetTheme.id)
      .first<RawThemeConfigRow>(),
    params.tenantDb
      .prepare(
        "SELECT id, published_sections_json, draft_sections_json FROM pages WHERE is_homepage = 1 AND deleted_at IS NULL LIMIT 1",
      )
      .first<{
        readonly id: number;
        readonly published_sections_json: string | null;
        readonly draft_sections_json: string | null;
      }>(),
  ]);

  const currentSiteVersion = priorSiteRow ? Number(priorSiteRow.version) : 0;
  if (params.expectedVersion !== currentSiteVersion) {
    throw new StaleRevisionError({
      resourceType: "site_settings",
      resourceId: 1,
      expectedVersion: params.expectedVersion,
      actualVersion: currentSiteVersion,
    });
  }

  const previousThemeId = priorSiteRow?.active_theme_id ?? "compro";
  const nextSiteVersion = currentSiteVersion + 1;

  // 3. Recover target theme's PUBLISHED config ONLY (NEVER promote unpublished `draft_json`! M3)
  const recoveredPublishedSnapshot = priorTargetThemeRow
    ? parsePublishedThemeSnapshot(priorTargetThemeRow)
    : null;
  const recoveredExistingConfig = recoveredPublishedSnapshot !== null;

  const effectiveTargetSnapshot: ThemeConfigSnapshot = validateThemeConfigSnapshot({
    themeId: params.targetTheme.id,
    tokens: recoveredPublishedSnapshot?.tokens ?? params.targetTheme.defaultTokens,
    variants: recoveredPublishedSnapshot?.variants ?? params.targetTheme.defaultVariants,
  });

  const expectedTargetThemeVersion = priorTargetThemeRow ? Number(priorTargetThemeRow.version) : 0;
  const nextTargetThemeVersion = expectedTargetThemeVersion + 1;

  // Prepare canonical frozen envelopes BEFORE opening atomic SQLite batch
  // M2: Update `activeThemeId` on published snapshot from published state ONLY,
  //     and independently preserve all pending unpublished fields in `site_settings.draft_json`!
  const nextPublishedSiteSnapshot = buildNextPublishedSiteSettingsSnapshot(
    priorSiteRow,
    params.tenantName,
    params.targetTheme.id,
  );
  const siteEnvelope = buildPublishedSnapshot("site_settings", nextPublishedSiteSnapshot, {
    publishedAt: priorSiteRow?.published_at ?? nowMs,
    contentModifiedAt: nowMs,
  });
  const sitePublishedJson = JSON.stringify(siteEnvelope);
  const nextSiteDraftJson = buildPreservedSiteSettingsDraftJson(
    priorSiteRow?.draft_json,
    params.targetTheme.id,
  );

  const targetThemeEnvelope = buildPublishedSnapshot("theme_config", effectiveTargetSnapshot, {
    publishedAt: nowMs,
    contentModifiedAt: nowMs,
  });
  const targetThemePublishedJson = JSON.stringify(targetThemeEnvelope);
  const targetTokensJson = JSON.stringify(effectiveTargetSnapshot.tokens);
  const targetVariantsJson = JSON.stringify(effectiveTargetSnapshot.variants);

  const activitySummary = recoveredExistingConfig
    ? `Tema situs diubah dari "${previousThemeId}" ke "${params.targetTheme.id}" (konfigurasi tersimpan dipulihkan).`
    : `Tema situs diubah dari "${previousThemeId}" ke "${params.targetTheme.id}".`;
  const activityMetaJson = JSON.stringify({
    previousThemeId,
    nextThemeId: params.targetTheme.id,
    recoveredExistingConfig,
    siteSettingsVersion: nextSiteVersion,
    themeConfigVersion: nextTargetThemeVersion,
  });

  const targetThemeGuard = buildTargetThemeGuardClause(
    params.targetTheme.id,
    expectedTargetThemeVersion,
  );

  // Optional test hook right before atomic batch execution (for deterministic concurrency tests)
  if (params.beforeBatchWrite) {
    await params.beforeBatchWrite();
  }

  // 4. Execute ONE true all-or-nothing SQLite `tenantDb.batch([...])` (M1):
  //    Statement 0 guards on BOTH `site_settings.version` AND `theme_configs` version/existence!
  //    If EITHER raced, Statement 0 affects 0 rows -> ALL subsequent statements see `changes() = 0` -> ZERO writes!
  const statements: D1PreparedStatement[] = [];

  // Statement 0: Update or insert `site_settings` gated on BOTH `site_settings` AND `theme_configs` guards
  if (priorSiteRow) {
    statements.push(
      params.tenantDb
        .prepare(
          `UPDATE site_settings
           SET active_theme_id = ?,
               draft_json = ?,
               published_json = ?,
               published_at = COALESCE(published_at, ?),
               content_modified_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND ${targetThemeGuard.sql}`,
        )
        .bind(
          params.targetTheme.id,
          nextSiteDraftJson,
          sitePublishedJson,
          siteEnvelope.publishedAt,
          siteEnvelope.contentModifiedAt,
          nowMs,
          currentSiteVersion,
          ...targetThemeGuard.args,
        ),
    );
  } else {
    statements.push(
      params.tenantDb
        .prepare(
          `INSERT INTO site_settings
             (id, site_title, tagline, timezone, locale, active_theme_id, blog_enabled, catalog_enabled,
              ai_training_policy, draft_json, published_json, published_at, content_modified_at, version, updated_at)
           SELECT 1, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE id = 1)
             AND ${targetThemeGuard.sql}`,
        )
        .bind(
          nextPublishedSiteSnapshot.siteTitle,
          nextPublishedSiteSnapshot.timezone,
          nextPublishedSiteSnapshot.locale,
          params.targetTheme.id,
          nextPublishedSiteSnapshot.blogEnabled ? 1 : 0,
          nextPublishedSiteSnapshot.catalogEnabled ? 1 : 0,
          nextPublishedSiteSnapshot.aiTrainingPolicy,
          sitePublishedJson,
          siteEnvelope.publishedAt,
          siteEnvelope.contentModifiedAt,
          nowMs,
          ...targetThemeGuard.args,
        ),
    );
  }

  // Statement 1: Activate / recover target theme row in `theme_configs`.
  // Gated immediately on Statement 0 (`changes() = 1`) + exact `site_settings` version & timestamp!
  // M3: `draft_json` is NEVER overwritten or touched on UPDATE, and initialized to NULL on fresh INSERT!
  // Previous theme's row in `theme_configs` is NEVER overwritten or deleted!
  const siteSwappedGuardSql =
    "changes() = 1 AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND active_theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?)";

  if (priorTargetThemeRow) {
    statements.push(
      params.tenantDb
        .prepare(
          `UPDATE theme_configs
           SET tokens_json = ?,
               variants_json = ?,
               published_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE theme_id = ?
             AND version = ?
             AND ${siteSwappedGuardSql}`,
        )
        .bind(
          targetTokensJson,
          targetVariantsJson,
          targetThemePublishedJson,
          nowMs,
          params.targetTheme.id,
          expectedTargetThemeVersion,
          params.targetTheme.id,
          nextSiteVersion,
          sitePublishedJson,
          nowMs,
        ),
    );
  } else {
    statements.push(
      params.tenantDb
        .prepare(
          `INSERT INTO theme_configs
             (theme_id, tokens_json, variants_json, draft_json, published_json, version, updated_at)
           SELECT ?, ?, ?, NULL, ?, 1, ?
           WHERE NOT EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ?)
             AND ${siteSwappedGuardSql}`,
        )
        .bind(
          params.targetTheme.id,
          targetTokensJson,
          targetVariantsJson,
          targetThemePublishedJson,
          nowMs,
          params.targetTheme.id,
          params.targetTheme.id,
          nextSiteVersion,
          sitePublishedJson,
          nowMs,
        ),
    );
  }

  // Statement 2: Append audit entry to `tenant_activity_log` gated on BOTH writes succeeding
  statements.push(
    params.tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log
           (actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at)
         SELECT ?, ?, 'theme.activated', 'theme_config', ?, ?, ?, ?
         WHERE changes() = 1
           AND EXISTS (
             SELECT 1 FROM site_settings
             WHERE id = 1 AND active_theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?
           )
           AND EXISTS (
             SELECT 1 FROM theme_configs
             WHERE theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?
           )`,
      )
      .bind(
        params.actorUserId,
        params.actorRole,
        params.targetTheme.id,
        activitySummary,
        activityMetaJson,
        nowMs,
        params.targetTheme.id,
        nextSiteVersion,
        sitePublishedJson,
        nowMs,
        params.targetTheme.id,
        nextTargetThemeVersion,
        targetThemePublishedJson,
        nowMs,
      ),
  );

  // Statement 3 & 4 (when homepage exists): Record bounded `content_revisions` checkpoint
  // WITHOUT mutating the `pages` row at all!
  let revisionSnapshotJson: string | null = null;
  if (homepageRow) {
    revisionSnapshotJson = JSON.stringify({
      event: "theme.activated",
      previousThemeId,
      activeThemeId: params.targetTheme.id,
      themeConfigVersion: nextTargetThemeVersion,
      siteSettingsVersion: nextSiteVersion,
      homepagePublishedSnapshot: safeParseJson(homepageRow.published_sections_json),
    });

    statements.push(
      params.tenantDb
        .prepare(
          `INSERT INTO content_revisions (resource_type, resource_id, revision_number, snapshot_json, created_by, created_at)
           SELECT 'page', ?,
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = 'page' AND resource_id = ?), 0) + 1,
                  ?, ?, ?
           WHERE changes() = 1
             AND EXISTS (
               SELECT 1 FROM site_settings
               WHERE id = 1 AND active_theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?
             )
             AND EXISTS (
               SELECT 1 FROM theme_configs
               WHERE theme_id = ? AND version = ? AND published_json = ? AND updated_at = ?
             )`,
        )
        .bind(
          homepageRow.id,
          homepageRow.id,
          revisionSnapshotJson,
          params.actorUserId,
          nowMs,
          params.targetTheme.id,
          nextSiteVersion,
          sitePublishedJson,
          nowMs,
          params.targetTheme.id,
          nextTargetThemeVersion,
          targetThemePublishedJson,
          nowMs,
        ),
    );

    statements.push(
      params.tenantDb
        .prepare(
          `DELETE FROM content_revisions
           WHERE changes() = 1
             AND resource_type = 'page'
             AND resource_id = ?
             AND revision_number NOT IN (
               SELECT revision_number
               FROM content_revisions
               WHERE resource_type = 'page' AND resource_id = ?
               ORDER BY revision_number DESC
               LIMIT ?
             )`,
        )
        .bind(homepageRow.id, homepageRow.id, MAX_RETAINED_REVISIONS),
    );
  }

  const batchResults = await params.tenantDb.batch(statements);
  const siteChanges = batchResults[0]?.meta?.changes ?? 0;
  const themeChanges = batchResults[1]?.meta?.changes ?? 0;

  if (siteChanges !== 1 || themeChanges !== 1) {
    // True all-or-nothing guarantee (M1): if EITHER predicate failed, ZERO writes occurred!
    const latestSite = await params.tenantDb
      .prepare("SELECT version FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ readonly version: number }>();

    throw new StaleRevisionError({
      resourceType: siteChanges !== 1 ? "site_settings" : "theme_config",
      resourceId: siteChanges !== 1 ? 1 : params.targetTheme.id,
      expectedVersion: params.expectedVersion,
      actualVersion: latestSite ? Number(latestSite.version) : 0,
    });
  }

  if (params.beforeCacheBump) {
    await params.beforeCacheBump();
  }

  // 5. Bump PLATFORM_DB.tenants.cache_version EXACTLY ONCE!
  //    M4: On failure, execute ONE chained `changes() = 1` version-guarded compensating batch
  //    so an interleaved writer can NEVER leave `site_settings` and `theme_configs` inconsistent!
  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(params.platformDb, params.tenantId, nowMs);
  } catch (platformErr) {
    let compensated: boolean;
    try {
      const rollbackStmts: D1PreparedStatement[] = [];

      // Compensation Statement 0: Restore/delete `site_settings` ONLY if STILL at `nextSiteVersion`
      // AND target `theme_configs` is STILL at `nextTargetThemeVersion` (all-or-nothing rollback!)
      const rollbackThemeStillAtOurVersionSql =
        "EXISTS (SELECT 1 FROM theme_configs WHERE theme_id = ? AND version = ? AND updated_at = ?)";

      if (priorSiteRow) {
        rollbackStmts.push(
          params.tenantDb
            .prepare(
              `UPDATE site_settings
               SET active_theme_id = ?, draft_json = ?, published_json = ?, published_at = ?,
                   content_modified_at = ?, version = ?, updated_at = ?
               WHERE id = 1
                 AND version = ?
                 AND updated_at = ?
                 AND ${rollbackThemeStillAtOurVersionSql}`,
            )
            .bind(
              priorSiteRow.active_theme_id,
              priorSiteRow.draft_json,
              priorSiteRow.published_json,
              priorSiteRow.published_at,
              priorSiteRow.content_modified_at,
              priorSiteRow.version,
              priorSiteRow.updated_at,
              nextSiteVersion,
              nowMs,
              params.targetTheme.id,
              nextTargetThemeVersion,
              nowMs,
            ),
        );
      } else {
        rollbackStmts.push(
          params.tenantDb
            .prepare(
              `DELETE FROM site_settings
               WHERE id = 1
                 AND version = 1
                 AND updated_at = ?
                 AND ${rollbackThemeStillAtOurVersionSql}`,
            )
            .bind(nowMs, params.targetTheme.id, nextTargetThemeVersion, nowMs),
        );
      }

      // Compensation Statement 1: Restore/delete `theme_configs` ONLY if Statement 0 matched (`changes() = 1`)!
      if (priorTargetThemeRow) {
        rollbackStmts.push(
          params.tenantDb
            .prepare(
              `UPDATE theme_configs
               SET tokens_json = ?, variants_json = ?, draft_json = ?, published_json = ?, version = ?, updated_at = ?
               WHERE changes() = 1
                 AND theme_id = ?
                 AND version = ?
                 AND updated_at = ?`,
            )
            .bind(
              priorTargetThemeRow.tokens_json,
              priorTargetThemeRow.variants_json,
              priorTargetThemeRow.draft_json,
              priorTargetThemeRow.published_json,
              priorTargetThemeRow.version,
              priorTargetThemeRow.updated_at,
              params.targetTheme.id,
              nextTargetThemeVersion,
              nowMs,
            ),
        );
      } else {
        rollbackStmts.push(
          params.tenantDb
            .prepare(
              `DELETE FROM theme_configs
               WHERE changes() = 1
                 AND theme_id = ?
                 AND version = 1
                 AND updated_at = ?`,
            )
            .bind(params.targetTheme.id, nowMs),
        );
      }

      // Compensation Statement 2: Delete our `tenant_activity_log` ONLY if Statement 1 matched (`changes() = 1`)!
      rollbackStmts.push(
        params.tenantDb
          .prepare(
            `DELETE FROM tenant_activity_log
             WHERE changes() = 1
               AND action = 'theme.activated'
               AND resource_id = ?
               AND created_at = ?`,
          )
          .bind(params.targetTheme.id, nowMs),
      );

      // Compensation Statement 3: Delete our `content_revisions` entry ONLY if Statement 2 matched (`changes() = 1`)!
      if (homepageRow && revisionSnapshotJson !== null) {
        rollbackStmts.push(
          params.tenantDb
            .prepare(
              `DELETE FROM content_revisions
               WHERE changes() = 1
                 AND resource_type = 'page'
                 AND resource_id = ?
                 AND snapshot_json = ?
                 AND created_at = ?`,
            )
            .bind(homepageRow.id, revisionSnapshotJson, nowMs),
        );
      }

      const rbRes = await params.tenantDb.batch(rollbackStmts);
      compensated =
        (rbRes[0]?.meta?.changes ?? 0) === 1 && (rbRes[1]?.meta?.changes ?? 0) === 1;
    } catch {
      compensated = false;
    }

    throw new PublicationAtomicError(
      `Failed to bump tenant cache_version during atomic theme activation${
        compensated ? "; TenantStore rolled back cleanly" : "; TenantStore compensation incomplete"
      }`,
      { compensated, cause: platformErr },
    );
  }

  return {
    activatedThemeId: params.targetTheme.id,
    previousThemeId,
    recoveredExistingConfig,
    recoveredTokens: effectiveTargetSnapshot.tokens,
    recoveredVariants: effectiveTargetSnapshot.variants,
    version: nextSiteVersion,
    themeConfigVersion: nextTargetThemeVersion,
    cacheVersion,
    activatedAt: new Date(nowMs).toISOString(),
  };
}
