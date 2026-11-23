import { PLATFORM_HOSTS } from "@punyasitus/core";
import {
  htmlToRestrictedRichTextDoc,
  type PageSnapshot,
  type PostSnapshot,
  type RestrictedRichTextDoc,
} from "@punyasitus/core/content/index";
import type { OfferingType, TenantStatus } from "@punyasitus/core/schemas";
import {
  buildDirectoryListingCopyText,
  createDefaultTenantSeoEditorSettingsState,
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  evaluateSeoChecklist,
  extractChecklistSignalsFromRichTextDoc,
  getAllowedSchemaTypeOptions,
  mergeSearchAppearanceSettings,
  RecordExternalVerificationSchema,
  renderVerificationMetaTags,
  resolveEffectiveSeoPreview,
  resolveProviderVerificationStatus,
  ResourceSeoUpdateRequestSchema,
  SeoEditorOverrideInputSchema,
  SeoEditorSettingsPatchSchema,
  validateSchemaTypeForResource,
  validateVerificationToken,
  VERIFICATION_PROVIDERS,
  type EffectiveSeoPreviewResult,
  type ExternalVerificationRecord,
  type PeerPublishedSeoSummary,
  type ProviderVerificationStatusView,
  type SchemaTypeOption,
  type SearchAppearanceKind,
  type SearchAppearanceSettings,
  type SeoChecklistContentImage,
  type SeoChecklistResult,
  type SeoEditorOverrideInput,
  type SeoEditorResourceKind,
  type TenantSeoEditorSettingsState,
  type VerificationProvider,
  type VerificationTokensConfig,
} from "@punyasitus/core/seo/editor";
import {
  validateCanonicalHostname,
  type AiTrainingPolicy,
  type SeoRouteKind,
  type SiteVisibility,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/index";
import { bumpTenantCacheVersion, getPublishedResource } from "../publication/index.ts";
import { computeEffectiveTenantStatus } from "../routing/index.ts";
import { applyTenantSeoEditorMigration } from "./migrations.ts";

export {
  applyTenantSeoEditorMigration,
  TENANT_0013_SEO_EDITOR_SETTINGS_MIGRATION,
  TENANT_0013_SEO_EDITOR_SETTINGS_SQL,
} from "./migrations.ts";

export const SEO_AI_AUTOPILOT_PLUGIN_ID = "seo-ai-autopilot" as const;
export const SEO_SETTINGS_TABLE = "plg_seo_ai_autopilot__settings" as const;

// ---------------------------------------------------------------------------
// Domain Errors
// ---------------------------------------------------------------------------

export interface SeoValidationFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class SeoValidationError extends Error {
  readonly status = 422 as const;
  readonly code = "VALIDATION_ERROR" as const;
  readonly fields: readonly SeoValidationFieldError[];

  constructor(message: string, fields: readonly SeoValidationFieldError[] = []) {
    super(message);
    this.name = "SeoValidationError";
    this.fields = fields;
  }
}

export class SeoConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "VERSION_CONFLICT" as const;
  readonly currentVersion: number;

  constructor(message: string, currentVersion: number) {
    super(message);
    this.name = "SeoConflictError";
    this.currentVersion = currentVersion;
  }
}

export class SeoPluginDisabledError extends Error {
  readonly status = 409 as const;
  readonly code = "PLUGIN_DISABLED" as const;

  constructor(
    message = "Plugin SEO & AI Autopilot sedang nonaktif. Aktifkan kembali terlebih dahulu untuk menyimpan pengaturan SEO.",
  ) {
    super(message);
    this.name = "SeoPluginDisabledError";
  }
}

export class SeoNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "SeoNotFoundError";
  }
}

export class SeoServiceUnavailableError extends Error {
  readonly status = 503 as const;
  readonly code = "SERVICE_UNAVAILABLE" as const;

  constructor(
    message = "Gagal menyinkronkan versi cache platform; perubahan telah dibatalkan secara aman. Silakan coba lagi.",
  ) {
    super(message);
    this.name = "SeoServiceUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function tableExists(tenantDb: D1Database, tableName: string): Promise<boolean> {
  try {
    const row = await tenantDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .bind(tableName)
      .first<{ readonly name: string }>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

async function tableHasColumn(
  tenantDb: D1Database,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  try {
    const rows = await tenantDb
      .prepare(`PRAGMA table_info(${tableName})`)
      .all<{ readonly name: string }>();
    return rows.results.some((r) => r.name === columnName);
  } catch {
    return false;
  }
}

function sanitizeSeededToken(provider: VerificationProvider, raw: unknown): string | null {
  const res = validateVerificationToken(provider, raw);
  return res.ok ? res.token : null;
}

function normalizeStoredSeoSettingsState(raw: unknown): TenantSeoEditorSettingsState {
  const defaults = createDefaultTenantSeoEditorSettingsState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  const saRaw =
    obj.searchAppearance && typeof obj.searchAppearance === "object" && !Array.isArray(obj.searchAppearance)
      ? (obj.searchAppearance as {
          readonly separator?: SearchAppearanceSettings["separator"];
          readonly templates?: Partial<
            Record<SearchAppearanceKind, Partial<{ titleTemplate: string; descriptionTemplate: string }>>
          >;
        })
      : {};
  const searchAppearance = mergeSearchAppearanceSettings(DEFAULT_SEARCH_APPEARANCE_SETTINGS, {
    ...(saRaw.separator ? { separator: saRaw.separator } : {}),
    ...(saRaw.templates && typeof saRaw.templates === "object" ? { templates: saRaw.templates } : {}),
  });

  const verRaw =
    obj.verificationTokens && typeof obj.verificationTokens === "object" && !Array.isArray(obj.verificationTokens)
      ? (obj.verificationTokens as Record<string, unknown>)
      : {};
  const verificationTokens: VerificationTokensConfig = {
    google: sanitizeSeededToken("google", verRaw.google),
    bing: sanitizeSeededToken("bing", verRaw.bing),
    yandex: sanitizeSeededToken("yandex", verRaw.yandex),
  };

  const extRaw =
    obj.externalVerifications &&
    typeof obj.externalVerifications === "object" &&
    !Array.isArray(obj.externalVerifications)
      ? (obj.externalVerifications as Record<string, unknown>)
      : {};
  const parseExt = (provider: VerificationProvider): ExternalVerificationRecord | null => {
    const entry = extRaw[provider];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.verifiedHost !== "string" ||
      typeof e.verifiedAt !== "string" ||
      typeof e.verifiedByUserId !== "string"
    ) {
      return null;
    }
    return {
      verifiedHost: e.verifiedHost,
      verifiedAt: e.verifiedAt,
      verifiedByUserId: e.verifiedByUserId,
      note: typeof e.note === "string" ? e.note : null,
    };
  };

  return {
    searchAppearance,
    verificationTokens,
    externalVerifications: {
      google: parseExt("google"),
      bing: parseExt("bing"),
      yandex: parseExt("yandex"),
    },
  };
}

interface TenantPlatformSeoContext {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly primaryHost: string;
  readonly primaryHostKind: "subdomain" | "custom";
  readonly primaryHostVerified: boolean;
  readonly saasZone: string;
  readonly verifiedHostInput: VerifiedTenantHostInput;
}

async function resolveTenantPlatformSeoContext(
  platformDb: D1Database,
  tenantId: string,
  options: { readonly saasZone?: string; readonly nowMs?: number } = {},
): Promise<TenantPlatformSeoContext> {
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  const saasZone = (options.saasZone ?? PLATFORM_HOSTS.saasZone).trim().toLowerCase();

  const row = await platformDb
    .prepare(
      `SELECT
         t.id AS id,
         t.handle AS handle,
         t.name AS name,
         t.status AS status,
         t.operator_hold AS operator_hold,
         t.trial_ends_at AS trial_ends_at,
         t.paid_through AS paid_through,
         ph.host AS primary_host,
         ph.kind AS primary_host_kind,
         ph.status AS primary_host_status,
         ph.ssl_status AS primary_host_ssl_status
       FROM tenants t
       LEFT JOIN tenant_hosts ph
         ON ph.tenant_id = t.id
         AND ph.is_primary = 1
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{
      readonly id: string;
      readonly handle: string;
      readonly name: string;
      readonly status: TenantStatus;
      readonly operator_hold: number;
      readonly trial_ends_at: number | null;
      readonly paid_through: number | null;
      readonly primary_host: string | null;
      readonly primary_host_kind: "subdomain" | "custom" | null;
      readonly primary_host_status: "pending" | "active" | "failed" | "moved" | "deleting" | null;
      readonly primary_host_ssl_status: string | null;
    }>();

  if (!row) {
    throw new SeoNotFoundError("Situs tidak ditemukan.");
  }

  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold: row.operator_hold === 1,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );

  const fallbackSubdomain = `${row.handle}.${saasZone}`;
  const isCustomActive =
    row.primary_host_kind === "custom" &&
    row.primary_host_status === "active" &&
    row.primary_host_ssl_status === "active" &&
    Boolean(row.primary_host);

  const primaryHost = isCustomActive ? row.primary_host!.trim().toLowerCase() : fallbackSubdomain;
  const primaryHostKind: "subdomain" | "custom" = isCustomActive ? "custom" : "subdomain";
  const primaryHostVerified = isCustomActive || row.primary_host_status !== "failed";

  const verifiedTenantHosts = [fallbackSubdomain];
  if (isCustomActive && row.primary_host) {
    verifiedTenantHosts.push(row.primary_host.trim().toLowerCase());
  }

  const verifiedHostInput: VerifiedTenantHostInput = {
    tenantHandle: row.handle,
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    primaryHost,
    primaryHostKind,
    primaryHostStatus: primaryHostVerified ? "active" : "pending",
    primaryHostSslStatus: primaryHostVerified ? "active" : "pending",
    primaryHostVerified,
    verifiedTenantHosts,
    servingHost: primaryHost,
  };

  return {
    tenantId: row.id,
    handle: row.handle,
    tenantName: row.name,
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    primaryHost,
    primaryHostKind,
    primaryHostVerified,
    saasZone,
    verifiedHostInput,
  };
}

// ---------------------------------------------------------------------------
// 1. Plugin Enablement State (`seo-ai-autopilot`)
// ---------------------------------------------------------------------------

/**
 * Checks whether `seo-ai-autopilot` is active for a tenant (`DEC-042`, `REQ-066`).
 * Default when no explicit row exists in `installed_plugins` is `true` (pre-installed free plugin);
 * an explicit row with `enabled = 0` disables the plugin and blocks SEO mutations (`409 PLUGIN_DISABLED`).
 */
export async function isSeoAutopilotEnabledForTenant(tenantDb: D1Database): Promise<boolean> {
  try {
    const row = await tenantDb
      .prepare(`SELECT enabled FROM installed_plugins WHERE plugin_id = ? LIMIT 1`)
      .bind(SEO_AI_AUTOPILOT_PLUGIN_ID)
      .first<{ readonly enabled: number }>();
    if (!row) return true;
    return Number(row.enabled) !== 0;
  } catch {
    return true;
  }
}

async function assertSeoAutopilotEnabled(tenantDb: D1Database): Promise<void> {
  const active = await isSeoAutopilotEnabledForTenant(tenantDb);
  if (!active) {
    throw new SeoPluginDisabledError();
  }
}

/**
 * Atomically enables or disables `seo-ai-autopilot` (upsert + audit in one `batch()`),
 * then bumps `PLATFORM_DB.tenants.cache_version` with rollback compensation on failure.
 */
export async function setSeoAutopilotEnabledForTenant(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly enabled: boolean;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly nowMs?: number;
  },
): Promise<{ readonly enabled: boolean }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const previous = await tenantDb
    .prepare(
      `SELECT version, enabled, config_json, schema_version, installed_at, updated_at
       FROM installed_plugins WHERE plugin_id = ? LIMIT 1`,
    )
    .bind(SEO_AI_AUTOPILOT_PLUGIN_ID)
    .first<{
      readonly version: string;
      readonly enabled: number;
      readonly config_json: string;
      readonly schema_version: number;
      readonly installed_at: number;
      readonly updated_at: number;
    }>();

  const enabledInt = input.enabled ? 1 : 0;
  const action = input.enabled ? "seo_autopilot.enabled" : "seo_autopilot.disabled";
  const summary = input.enabled
    ? "Mengaktifkan plugin SEO & AI Autopilot"
    : "Menonaktifkan plugin SEO & AI Autopilot (data tetap tersimpan aman)";

  await tenantDb.batch([
    tenantDb
      .prepare(
        `INSERT INTO installed_plugins (
           plugin_id, version, enabled, config_json, schema_version, installed_at, updated_at
         ) VALUES (?, '1.0.0', ?, '{}', 1, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .bind(SEO_AI_AUTOPILOT_PLUGIN_ID, enabledInt, nowMs, nowMs),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         ) VALUES (?, ?, ?, 'plugin', ?, ?, ?, ?)`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        action,
        SEO_AI_AUTOPILOT_PLUGIN_ID,
        summary,
        JSON.stringify({ enabled: input.enabled }),
        nowMs,
      ),
  ]);

  try {
    await bumpTenantCacheVersion(platformDb, input.tenantId, nowMs);
  } catch {
    // Compensate cleanly so TenantStore and PLATFORM_DB cache_version never diverge
    if (previous) {
      await tenantDb
        .prepare(
          `UPDATE installed_plugins
           SET enabled = ?, updated_at = ?
           WHERE plugin_id = ?`,
        )
        .bind(previous.enabled, previous.updated_at, SEO_AI_AUTOPILOT_PLUGIN_ID)
        .run();
    } else {
      await tenantDb
        .prepare(`DELETE FROM installed_plugins WHERE plugin_id = ?`)
        .bind(SEO_AI_AUTOPILOT_PLUGIN_ID)
        .run();
    }
    throw new SeoServiceUnavailableError();
  }

  return { enabled: input.enabled };
}

// ---------------------------------------------------------------------------
// 2. Global SEO Editor Settings (Templates + Webmaster Verification Tokens)
// ---------------------------------------------------------------------------

export interface TenantSeoSettingsRecord {
  readonly tenantId: string;
  readonly handle: string;
  readonly siteName: string;
  readonly tagline: string | null;
  readonly primaryHost: string;
  readonly primaryOrigin: string;
  readonly tenantStatus: TenantStatus;
  readonly siteVisibility: SiteVisibility;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly seoAutopilotEnabled: boolean;
  readonly draft: TenantSeoEditorSettingsState;
  readonly published: TenantSeoEditorSettingsState | null;
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly publishedAt: string | null;
  readonly verificationStatuses: readonly ProviderVerificationStatusView[];
  readonly publishedVerificationMetaTags: readonly string[];
  readonly sitemapUrl: string;
  readonly directoryListingCopyText: string;
}

interface RawSeoEditorSettingsRow {
  readonly draft_json: string;
  readonly published_json: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly published_at: number | null;
}

async function readSiteAndBusinessContext(tenantDb: D1Database, fallbackName: string): Promise<{
  readonly siteName: string;
  readonly tagline: string | null;
  readonly siteDefaultTitle: string | null;
  readonly siteDefaultDescription: string | null;
  readonly siteDefaultOgMediaId: number | null;
  readonly siteVisibility: SiteVisibility;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly groupedDraftGoogleToken: string | null;
  readonly groupedDraftBingToken: string | null;
  readonly groupedPublishedGoogleToken: string | null;
  readonly groupedPublishedBingToken: string | null;
  readonly groupedHasPublished: boolean;
  readonly businessProfile: {
    readonly businessName: string;
    readonly businessCategory: string | null;
    readonly description: string | null;
    readonly address: string | null;
    readonly city: string | null;
    readonly province: string | null;
    readonly postalCode: string | null;
    readonly phone: string | null;
    readonly whatsappE164: string | null;
    readonly weekdayHours: string | null;
    readonly holidayHours: string | null;
  };
}> {
  const [siteRow, publishedSite, groupedExists, businessRow] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT site_title, tagline, og_image_media_id, ai_training_policy
         FROM site_settings WHERE id = 1 LIMIT 1`,
      )
      .first<{
        readonly site_title: string;
        readonly tagline: string | null;
        readonly og_image_media_id: number | null;
        readonly ai_training_policy: AiTrainingPolicy;
      }>()
      .catch(() => null),
    getPublishedResource(tenantDb, { resourceType: "site_settings", resourceId: 1 }).catch(
      () => null,
    ),
    tableExists(tenantDb, "site_settings_grouped"),
    tenantDb
      .prepare(
        `SELECT business_name, business_category, description, address, city, province, postal_code,
                phone, whatsapp_e164, weekday_hours_json, holiday_hours_json
         FROM business_profile WHERE id = 1 LIMIT 1`,
      )
      .first<{
        readonly business_name: string;
        readonly business_category: string | null;
        readonly description: string | null;
        readonly address: string | null;
        readonly city: string | null;
        readonly province: string | null;
        readonly postal_code: string | null;
        readonly phone: string | null;
        readonly whatsapp_e164: string | null;
        readonly weekday_hours_json: string | null;
        readonly holiday_hours_json: string | null;
      }>()
      .catch(() => null),
  ]);

  let siteDefaultTitle: string | null = null;
  let siteDefaultDescription: string | null = null;
  let groupedDraftGoogleToken: string | null = null;
  let groupedDraftBingToken: string | null = null;
  let groupedPublishedGoogleToken: string | null = null;
  let groupedPublishedBingToken: string | null = null;
  let groupedHasPublished = false;

  if (groupedExists) {
    const groupedRow = await tenantDb
      .prepare(`SELECT published_json, draft_json FROM site_settings_grouped WHERE id = 1 LIMIT 1`)
      .first<{ readonly published_json: string | null; readonly draft_json: string | null }>()
      .catch(() => null);

    // Strictly separate grouped published_json vs draft_json — NEVER promote unpublished draft tokens!
    if (groupedRow?.published_json) {
      groupedHasPublished = true;
      const pubParsed = safeJsonParse(groupedRow.published_json) as Record<string, unknown> | null;
      const pubSeo =
        pubParsed?.seo && typeof pubParsed.seo === "object"
          ? (pubParsed.seo as Record<string, unknown>)
          : null;
      if (pubSeo) {
        siteDefaultTitle = typeof pubSeo.defaultTitle === "string" ? pubSeo.defaultTitle : null;
        siteDefaultDescription =
          typeof pubSeo.defaultDescription === "string" ? pubSeo.defaultDescription : null;
        groupedPublishedGoogleToken = sanitizeSeededToken("google", pubSeo.googleSiteVerification);
        groupedPublishedBingToken = sanitizeSeededToken("bing", pubSeo.bingSiteVerification);
      }
    }

    if (groupedRow?.draft_json) {
      const draftParsed = safeJsonParse(groupedRow.draft_json) as Record<string, unknown> | null;
      const draftSeo =
        draftParsed?.seo && typeof draftParsed.seo === "object"
          ? (draftParsed.seo as Record<string, unknown>)
          : null;
      if (draftSeo) {
        groupedDraftGoogleToken = sanitizeSeededToken("google", draftSeo.googleSiteVerification);
        groupedDraftBingToken = sanitizeSeededToken("bing", draftSeo.bingSiteVerification);
      }
    }
  }

  const siteName = publishedSite?.data.siteTitle ?? siteRow?.site_title ?? fallbackName;
  const tagline = publishedSite?.data.tagline ?? siteRow?.tagline ?? null;
  const siteVisibility: SiteVisibility = publishedSite?.data.siteVisibility ?? "public";
  const aiTrainingPolicy: AiTrainingPolicy =
    publishedSite?.data.aiTrainingPolicy ?? siteRow?.ai_training_policy ?? "allow";
  const siteDefaultOgMediaId =
    publishedSite?.data.ogImageMediaId ?? siteRow?.og_image_media_id ?? null;

  const parseHoursString = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const parsed = safeJsonParse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = (parsed as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
    return raw.startsWith("{") || raw.startsWith("[") ? null : raw;
  };

  return {
    siteName,
    tagline,
    siteDefaultTitle,
    siteDefaultDescription,
    siteDefaultOgMediaId,
    siteVisibility,
    aiTrainingPolicy,
    groupedDraftGoogleToken,
    groupedDraftBingToken,
    groupedPublishedGoogleToken,
    groupedPublishedBingToken,
    groupedHasPublished,
    businessProfile: {
      businessName: businessRow?.business_name ?? siteName,
      businessCategory: businessRow?.business_category ?? null,
      description: businessRow?.description ?? null,
      address: businessRow?.address ?? null,
      city: businessRow?.city ?? null,
      province: businessRow?.province ?? null,
      postalCode: businessRow?.postal_code ?? null,
      phone: businessRow?.phone ?? null,
      whatsappE164: businessRow?.whatsapp_e164 ?? null,
      weekdayHours: parseHoursString(businessRow?.weekday_hours_json),
      holidayHours: parseHoursString(businessRow?.holiday_hours_json),
    },
  };
}

function buildSeedPairFromGrouped(siteCtx: {
  readonly groupedDraftGoogleToken: string | null;
  readonly groupedDraftBingToken: string | null;
  readonly groupedPublishedGoogleToken: string | null;
  readonly groupedPublishedBingToken: string | null;
  readonly groupedHasPublished: boolean;
}): {
  readonly draftSeed: TenantSeoEditorSettingsState;
  readonly publishedSeed: TenantSeoEditorSettingsState;
} {
  const base = createDefaultTenantSeoEditorSettingsState();
  // `publishedSeed` ONLY uses published tokens from `site_settings_grouped.published_json`, NEVER `draft_json`!
  const publishedSeed: TenantSeoEditorSettingsState = {
    ...base,
    verificationTokens: {
      google: siteCtx.groupedHasPublished ? siteCtx.groupedPublishedGoogleToken : null,
      bing: siteCtx.groupedHasPublished ? siteCtx.groupedPublishedBingToken : null,
      yandex: null,
    },
  };
  const draftSeed: TenantSeoEditorSettingsState = {
    ...base,
    verificationTokens: {
      google: siteCtx.groupedDraftGoogleToken ?? publishedSeed.verificationTokens.google,
      bing: siteCtx.groupedDraftBingToken ?? publishedSeed.verificationTokens.bing,
      yandex: null,
    },
  };
  return { draftSeed, publishedSeed };
}

async function ensureSeoEditorSettingsRow(
  tenantDb: D1Database,
  seeds: {
    readonly draftSeed: TenantSeoEditorSettingsState;
    readonly publishedSeed: TenantSeoEditorSettingsState;
  },
  nowMs: number,
): Promise<RawSeoEditorSettingsRow> {
  await applyTenantSeoEditorMigration(tenantDb);
  const existing = await tenantDb
    .prepare(
      `SELECT draft_json, published_json, version, updated_at, published_at
       FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`,
    )
    .first<RawSeoEditorSettingsRow>();
  if (existing) {
    return existing;
  }
  const draftJson = JSON.stringify(seeds.draftSeed);
  const publishedJson = JSON.stringify(seeds.publishedSeed);
  await tenantDb
    .prepare(
      `INSERT OR IGNORE INTO ${SEO_SETTINGS_TABLE} (id, draft_json, published_json, version, updated_at, published_at)
       VALUES (1, ?, ?, 1, ?, ?)`,
    )
    .bind(draftJson, publishedJson, nowMs, nowMs)
    .run();

  const created = await tenantDb
    .prepare(
      `SELECT draft_json, published_json, version, updated_at, published_at
       FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`,
    )
    .first<RawSeoEditorSettingsRow>();
  if (!created) {
    throw new Error(`Failed to initialize ${SEO_SETTINGS_TABLE} singleton row`);
  }
  return created;
}

export async function getTenantSeoEditorSettings(
  platformDb: D1Database,
  tenantDb: D1Database,
  tenantId: string,
  options: { readonly saasZone?: string; readonly nowMs?: number } = {},
): Promise<TenantSeoSettingsRecord> {
  const [platformCtx, siteCtx, seoAutopilotEnabled, hasTable] = await Promise.all([
    resolveTenantPlatformSeoContext(platformDb, tenantId, options),
    readSiteAndBusinessContext(tenantDb, "Situs Bisnis"),
    isSeoAutopilotEnabledForTenant(tenantDb),
    tableExists(tenantDb, SEO_SETTINGS_TABLE),
  ]);

  let row: RawSeoEditorSettingsRow | null = null;
  if (hasTable) {
    row = await tenantDb
      .prepare(
        `SELECT draft_json, published_json, version, updated_at, published_at
         FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`,
      )
      .first<RawSeoEditorSettingsRow>()
      .catch(() => null);
  }

  const seeds = buildSeedPairFromGrouped(siteCtx);
  const draft = row ? normalizeStoredSeoSettingsState(safeJsonParse(row.draft_json)) : seeds.draftSeed;
  const published = row?.published_json
    ? normalizeStoredSeoSettingsState(safeJsonParse(row.published_json))
    : row
      ? null
      : seeds.publishedSeed;

  const hasUnpublishedChanges =
    published === null ||
    JSON.stringify({
      searchAppearance: draft.searchAppearance,
      verificationTokens: draft.verificationTokens,
    }) !==
      JSON.stringify({
        searchAppearance: published.searchAppearance,
        verificationTokens: published.verificationTokens,
      });

  const verificationStatuses: ProviderVerificationStatusView[] = VERIFICATION_PROVIDERS.map(
    (provider) =>
      resolveProviderVerificationStatus({
        provider,
        draftToken: draft.verificationTokens[provider],
        publishedToken: published?.verificationTokens[provider] ?? null,
        externalVerification:
          published?.externalVerifications[provider] ?? draft.externalVerifications[provider],
        currentPrimaryHost: platformCtx.primaryHost,
      }),
  );

  const primaryOrigin = `https://${platformCtx.primaryHost}`;
  const directoryListingCopyText = buildDirectoryListingCopyText({
    ...siteCtx.businessProfile,
    primaryOrigin,
  });

  return {
    tenantId: platformCtx.tenantId,
    handle: platformCtx.handle,
    siteName: siteCtx.siteName,
    tagline: siteCtx.tagline,
    primaryHost: platformCtx.primaryHost,
    primaryOrigin,
    tenantStatus: platformCtx.tenantStatus,
    siteVisibility: siteCtx.siteVisibility,
    aiTrainingPolicy: siteCtx.aiTrainingPolicy,
    seoAutopilotEnabled,
    draft,
    published,
    hasUnpublishedChanges,
    version: row ? Number(row.version) : 1,
    updatedAt: row ? new Date(Number(row.updated_at)).toISOString() : null,
    publishedAt: row?.published_at ? new Date(Number(row.published_at)).toISOString() : null,
    verificationStatuses,
    publishedVerificationMetaTags: renderVerificationMetaTags(published?.verificationTokens),
    sitemapUrl: `${primaryOrigin}/sitemap.xml`,
    directoryListingCopyText,
  };
}

export async function saveTenantSeoEditorSettingsDraft(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly patch: unknown;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<TenantSeoSettingsRecord> {
  await assertSeoAutopilotEnabled(tenantDb);

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const parsed = SeoEditorSettingsPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    throw new SeoValidationError(
      "Pengaturan SEO tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : "settings",
        code: issue.code.toUpperCase(),
        message: issue.message,
      })),
    );
  }

  const siteCtx = await readSiteAndBusinessContext(tenantDb, "Situs Bisnis");
  const row = await ensureSeoEditorSettingsRow(tenantDb, buildSeedPairFromGrouped(siteCtx), nowMs);

  if (Number(row.version) !== input.expectedVersion) {
    throw new SeoConflictError(
      `Pengaturan SEO sudah diperbarui oleh pengguna lain (versi saat ini v${row.version}). Muat ulang sebelum menyimpan.`,
      Number(row.version),
    );
  }

  const currentDraft = normalizeStoredSeoSettingsState(safeJsonParse(row.draft_json));
  const data = parsed.data;

  const nextSearchAppearance = mergeSearchAppearanceSettings(currentDraft.searchAppearance, {
    ...(data.separator !== undefined ? { separator: data.separator } : {}),
    ...(data.templates !== undefined ? { templates: data.templates } : {}),
  });

  const nextVerificationTokens: VerificationTokensConfig = {
    google:
      data.verification?.google !== undefined
        ? data.verification.google
        : currentDraft.verificationTokens.google,
    bing:
      data.verification?.bing !== undefined
        ? data.verification.bing
        : currentDraft.verificationTokens.bing,
    yandex:
      data.verification?.yandex !== undefined
        ? data.verification.yandex
        : currentDraft.verificationTokens.yandex,
  };

  const nextExternalVerifications = {
    google:
      nextVerificationTokens.google !== currentDraft.verificationTokens.google
        ? null
        : currentDraft.externalVerifications.google,
    bing:
      nextVerificationTokens.bing !== currentDraft.verificationTokens.bing
        ? null
        : currentDraft.externalVerifications.bing,
    yandex:
      nextVerificationTokens.yandex !== currentDraft.verificationTokens.yandex
        ? null
        : currentDraft.externalVerifications.yandex,
  };

  const nextDraft: TenantSeoEditorSettingsState = {
    searchAppearance: nextSearchAppearance,
    verificationTokens: nextVerificationTokens,
    externalVerifications: nextExternalVerifications,
  };

  const nextVersion = input.expectedVersion + 1;
  // Atomic OCC draft update + gated activity log in one SQLite batch (NEVER mutates `published_json`)
  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE ${SEO_SETTINGS_TABLE}
         SET draft_json = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = 1 AND version = ?`,
      )
      .bind(JSON.stringify(nextDraft), nowMs, input.expectedVersion),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'seo.settings.draft_saved', 'seo_settings', '1', ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 AND version = ? AND updated_at = ?)`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        "Menyimpan draf template tampilan pencarian / token verifikasi SEO",
        JSON.stringify({ separator: nextSearchAppearance.separator }),
        nowMs,
        nextVersion,
        nowMs,
      ),
  ]);

  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const fresh = await tenantDb
      .prepare(`SELECT version FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`)
      .first<{ readonly version: number }>();
    throw new SeoConflictError(
      `Konflik versi saat menyimpan draf pengaturan SEO (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
      Number(fresh?.version ?? input.expectedVersion),
    );
  }

  return getTenantSeoEditorSettings(platformDb, tenantDb, input.tenantId, {
    saasZone: input.saasZone,
    nowMs,
  });
}

export async function publishTenantSeoEditorSettings(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<TenantSeoSettingsRecord> {
  await assertSeoAutopilotEnabled(tenantDb);

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const siteCtx = await readSiteAndBusinessContext(tenantDb, "Situs Bisnis");
  const row = await ensureSeoEditorSettingsRow(tenantDb, buildSeedPairFromGrouped(siteCtx), nowMs);

  if (Number(row.version) !== input.expectedVersion) {
    throw new SeoConflictError(
      `Pengaturan SEO sudah berubah (versi saat ini v${row.version}). Muat ulang sebelum menerbitkan.`,
      Number(row.version),
    );
  }

  const draft = normalizeStoredSeoSettingsState(safeJsonParse(row.draft_json));
  const prevPublished = row.published_json
    ? normalizeStoredSeoSettingsState(safeJsonParse(row.published_json))
    : null;

  // Preserve external verification ONLY when published token is unchanged; changed/removed tokens reset external verification
  const nextPublished: TenantSeoEditorSettingsState = {
    searchAppearance: draft.searchAppearance,
    verificationTokens: draft.verificationTokens,
    externalVerifications: {
      google:
        draft.verificationTokens.google &&
        prevPublished?.verificationTokens.google === draft.verificationTokens.google
          ? prevPublished.externalVerifications.google
          : null,
      bing:
        draft.verificationTokens.bing &&
        prevPublished?.verificationTokens.bing === draft.verificationTokens.bing
          ? prevPublished.externalVerifications.bing
          : null,
      yandex:
        draft.verificationTokens.yandex &&
        prevPublished?.verificationTokens.yandex === draft.verificationTokens.yandex
          ? prevPublished.externalVerifications.yandex
          : null,
    },
  };

  // Optional atomic OCC sync of ONLY `published_json` verification tokens in `site_settings_grouped`:
  // - NEVER promote `site_settings_grouped.draft_json` into `published_json`!
  // - NEVER overwrite `site_settings_grouped.draft_json`!
  // - Skip grouped sync completely if `site_settings_grouped` does not exist OR `published_json IS NULL`.
  let groupedRow: {
    readonly published_json: string;
    readonly version: number;
    readonly updated_at: number;
    readonly published_at: number | null;
  } | null = null;
  let nextGroupedPublishedJson: string | null = null;

  if (await tableExists(tenantDb, "site_settings_grouped")) {
    const found = await tenantDb
      .prepare(
        `SELECT published_json, version, updated_at, published_at
         FROM site_settings_grouped WHERE id = 1 LIMIT 1`,
      )
      .first<{
        readonly published_json: string | null;
        readonly version: number;
        readonly updated_at: number;
        readonly published_at: number | null;
      }>();

    if (found && found.published_json !== null) {
      groupedRow = {
        published_json: found.published_json,
        version: Number(found.version),
        updated_at: Number(found.updated_at),
        published_at: found.published_at === null ? null : Number(found.published_at),
      };
      const parsedPub = (safeJsonParse(found.published_json) as Record<string, unknown> | null) ?? {};
      const prevPubSeo =
        parsedPub.seo && typeof parsedPub.seo === "object" && !Array.isArray(parsedPub.seo)
          ? (parsedPub.seo as Record<string, unknown>)
          : {};
      nextGroupedPublishedJson = JSON.stringify({
        ...parsedPub,
        seo: {
          ...prevPubSeo,
          googleSiteVerification: nextPublished.verificationTokens.google,
          bingSiteVerification: nextPublished.verificationTokens.bing,
        },
      });
    }
  }

  const nextJson = JSON.stringify(nextPublished);
  const nextVersion = input.expectedVersion + 1;

  const batchStmts: D1PreparedStatement[] = [];
  if (groupedRow && nextGroupedPublishedJson !== null) {
    // Statement 0 gates on BOTH our OCC version AND site_settings_grouped OCC version atomically
    batchStmts.push(
      tenantDb
        .prepare(
          `UPDATE ${SEO_SETTINGS_TABLE}
           SET draft_json = ?,
               published_json = ?,
               published_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1
             AND version = ?
             AND EXISTS (
               SELECT 1 FROM site_settings_grouped
               WHERE id = 1 AND version = ? AND published_json IS NOT NULL
             )`,
        )
        .bind(nextJson, nextJson, nowMs, nowMs, input.expectedVersion, groupedRow.version),
      tenantDb
        .prepare(
          `UPDATE site_settings_grouped
           SET published_json = ?,
               version = version + 1,
               updated_at = ?,
               published_at = ?
           WHERE id = 1
             AND version = ?
             AND EXISTS (
               SELECT 1 FROM ${SEO_SETTINGS_TABLE}
               WHERE id = 1 AND version = ? AND updated_at = ?
             )`,
        )
        .bind(
          nextGroupedPublishedJson,
          nowMs,
          nowMs,
          groupedRow.version,
          nextVersion,
          nowMs,
        ),
    );
  } else {
    batchStmts.push(
      tenantDb
        .prepare(
          `UPDATE ${SEO_SETTINGS_TABLE}
           SET draft_json = ?,
               published_json = ?,
               published_at = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = 1 AND version = ?`,
        )
        .bind(nextJson, nextJson, nowMs, nowMs, input.expectedVersion),
    );
  }

  batchStmts.push(
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'seo.settings.published', 'seo_settings', '1', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ${SEO_SETTINGS_TABLE}
           WHERE id = 1 AND version = ? AND updated_at = ?
         )`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        "Menerbitkan template tampilan pencarian dan pengaturan verifikasi webmaster",
        JSON.stringify({
          separator: nextPublished.searchAppearance.separator,
          configuredProviders: VERIFICATION_PROVIDERS.filter(
            (p) => nextPublished.verificationTokens[p] !== null,
          ),
        }),
        nowMs,
        nextVersion,
        nowMs,
      ),
  );

  const results = await tenantDb.batch(batchStmts);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const fresh = await tenantDb
      .prepare(`SELECT version FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`)
      .first<{ readonly version: number }>();
    throw new SeoConflictError(
      `Konflik versi saat menerbitkan pengaturan SEO (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
      Number(fresh?.version ?? input.expectedVersion),
    );
  }

  try {
    await bumpTenantCacheVersion(platformDb, input.tenantId, nowMs);
  } catch {
    // Compensate cleanly if cache_version bump fails — never silently succeed with stale edge cache
    const rollbackStmts: D1PreparedStatement[] = [
      tenantDb
        .prepare(
          `UPDATE ${SEO_SETTINGS_TABLE}
           SET draft_json = ?, published_json = ?, published_at = ?, version = ?, updated_at = ?
           WHERE id = 1 AND version = ?`,
        )
        .bind(
          row.draft_json,
          row.published_json,
          row.published_at,
          row.version,
          row.updated_at,
          nextVersion,
        ),
    ];
    if (groupedRow) {
      rollbackStmts.push(
        tenantDb
          .prepare(
            `UPDATE site_settings_grouped
             SET published_json = ?, version = ?, updated_at = ?, published_at = ?
             WHERE id = 1 AND version = ?`,
          )
          .bind(
            groupedRow.published_json,
            groupedRow.version,
            groupedRow.updated_at,
            groupedRow.published_at,
            groupedRow.version + 1,
          ),
      );
    }
    await tenantDb.batch(rollbackStmts);
    throw new SeoServiceUnavailableError();
  }

  return getTenantSeoEditorSettings(platformDb, tenantDb, input.tenantId, {
    saasZone: input.saasZone,
    nowMs,
  });
}

export async function recordExternalVerificationCheck(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly payload: unknown;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<TenantSeoSettingsRecord> {
  await assertSeoAutopilotEnabled(tenantDb);

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const parsed = RecordExternalVerificationSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new SeoValidationError(
      "Data pencatatan verifikasi eksternal tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : "verification",
        code: issue.code.toUpperCase(),
        message: issue.message,
      })),
    );
  }

  const platformCtx = await resolveTenantPlatformSeoContext(platformDb, input.tenantId, {
    saasZone: input.saasZone,
    nowMs,
  });

  let normalizedRequestedHost: string;
  try {
    normalizedRequestedHost = validateCanonicalHostname(parsed.data.verifiedHost);
  } catch {
    throw new SeoValidationError("Hostname verifikasi tidak valid.", [
      {
        field: "verifiedHost",
        code: "INVALID_HOST",
        message: "Hostname verifikasi bukan nama domain yang valid.",
      },
    ]);
  }

  if (normalizedRequestedHost !== platformCtx.primaryHost) {
    throw new SeoValidationError(
      "Hostname verifikasi harus cocok dengan domain utama terverifikasi situs saat ini.",
      [
        {
          field: "verifiedHost",
          code: "HOST_MISMATCH",
          message: `Domain utama aktif saat ini adalah "${platformCtx.primaryHost}", bukan "${normalizedRequestedHost}".`,
        },
      ],
    );
  }

  const siteCtx = await readSiteAndBusinessContext(tenantDb, platformCtx.tenantName);
  const row = await ensureSeoEditorSettingsRow(tenantDb, buildSeedPairFromGrouped(siteCtx), nowMs);

  if (Number(row.version) !== input.expectedVersion) {
    throw new SeoConflictError(
      `Pengaturan SEO sudah berubah (versi saat ini v${row.version}). Muat ulang terlebih dahulu.`,
      Number(row.version),
    );
  }

  const published = row.published_json
    ? normalizeStoredSeoSettingsState(safeJsonParse(row.published_json))
    : null;
  const draft = normalizeStoredSeoSettingsState(safeJsonParse(row.draft_json));
  const provider = parsed.data.provider;

  if (!published?.verificationTokens[provider]) {
    throw new SeoValidationError(
      "Token verifikasi harus disimpan dan diterbitkan terlebih dahulu sebelum mencatat hasil verifikasi eksternal.",
      [
        {
          field: "provider",
          code: "TOKEN_NOT_PUBLISHED",
          message: `Token verifikasi ${provider} belum diterbitkan pada domain utama.`,
        },
      ],
    );
  }

  const record: ExternalVerificationRecord = {
    verifiedHost: platformCtx.primaryHost,
    verifiedAt: new Date(nowMs).toISOString(),
    verifiedByUserId: input.actorUserId,
    note: parsed.data.note?.trim() || null,
  };

  const nextPublished: TenantSeoEditorSettingsState = {
    ...published,
    externalVerifications: {
      ...published.externalVerifications,
      [provider]: record,
    },
  };
  const nextDraft: TenantSeoEditorSettingsState = {
    ...draft,
    externalVerifications: {
      ...draft.externalVerifications,
      [provider]:
        draft.verificationTokens[provider] === published.verificationTokens[provider]
          ? record
          : null,
    },
  };

  const nextVersion = input.expectedVersion + 1;
  const results = await tenantDb.batch([
    tenantDb
      .prepare(
        `UPDATE ${SEO_SETTINGS_TABLE}
         SET draft_json = ?,
             published_json = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = 1 AND version = ?`,
      )
      .bind(JSON.stringify(nextDraft), JSON.stringify(nextPublished), nowMs, input.expectedVersion),
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'seo.verification.recorded', 'seo_settings', '1', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ${SEO_SETTINGS_TABLE}
           WHERE id = 1 AND version = ? AND updated_at = ?
         )`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        `Mencatat verifikasi eksternal ${provider} untuk ${platformCtx.primaryHost}`,
        JSON.stringify({ provider, verifiedHost: platformCtx.primaryHost }),
        nowMs,
        nextVersion,
        nowMs,
      ),
  ]);

  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const fresh = await tenantDb
      .prepare(`SELECT version FROM ${SEO_SETTINGS_TABLE} WHERE id = 1 LIMIT 1`)
      .first<{ readonly version: number }>();
    throw new SeoConflictError(
      `Konflik versi saat mencatat verifikasi eksternal (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
      Number(fresh?.version ?? input.expectedVersion),
    );
  }

  return getTenantSeoEditorSettings(platformDb, tenantDb, input.tenantId, {
    saasZone: input.saasZone,
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// 3. Per-Resource SEO Editor State, Preview, Checklist & Draft-Isolated Overrides
// ---------------------------------------------------------------------------

export interface ResourceSeoEditorState {
  readonly resourceKind: SeoEditorResourceKind;
  readonly resourceId: number;
  readonly title: string;
  readonly slug: string;
  readonly pathname: string;
  readonly status: "draft" | "published" | "trashed";
  readonly version: number;
  readonly seoAutopilotEnabled: boolean;
  readonly draftSeo: SeoEditorOverrideInput;
  readonly publishedSeo: SeoEditorOverrideInput | null;
  readonly indexOptIn?: boolean;
  readonly publishedCount?: number;
  readonly allowedSchemaTypes: readonly SchemaTypeOption[];
  readonly preview: EffectiveSeoPreviewResult;
  readonly checklist: SeoChecklistResult;
}

function offeringTypeToPathPrefix(offeringType: OfferingType): string {
  switch (offeringType) {
    case "service":
      return "/layanan";
    case "product":
      return "/produk";
    case "tour":
      return "/tour";
    case "vehicle":
      return "/kendaraan";
  }
}

function extractSeoFromEnvelopeOrColumn(
  envelopeRaw: string | null,
  fallbackSeoColumnRaw: string | null,
): SeoEditorOverrideInput {
  const envParsed = safeJsonParse(envelopeRaw) as Record<string, unknown> | null;
  let seoObj: unknown = null;
  if (envParsed && typeof envParsed === "object" && !Array.isArray(envParsed)) {
    const inner =
      envParsed.data && typeof envParsed.data === "object" && !Array.isArray(envParsed.data)
        ? (envParsed.data as Record<string, unknown>)
        : envParsed;
    if (inner.seo && typeof inner.seo === "object" && !Array.isArray(inner.seo)) {
      seoObj = inner.seo;
    }
  }
  if (!seoObj) {
    seoObj = safeJsonParse(fallbackSeoColumnRaw);
  }
  if (!seoObj || typeof seoObj !== "object" || Array.isArray(seoObj)) {
    return {};
  }
  const src = seoObj as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  if (typeof src.titleOverride === "string") normalized.titleOverride = src.titleOverride;
  else if (typeof src.seoTitle === "string") normalized.titleOverride = src.seoTitle;
  if (typeof src.descriptionOverride === "string")
    normalized.descriptionOverride = src.descriptionOverride;
  else if (typeof src.seoDescription === "string")
    normalized.descriptionOverride = src.seoDescription;
  if (typeof src.focusKeyphrase === "string") normalized.focusKeyphrase = src.focusKeyphrase;
  if (typeof src.ogTitleOverride === "string") normalized.ogTitleOverride = src.ogTitleOverride;
  if (typeof src.ogDescriptionOverride === "string")
    normalized.ogDescriptionOverride = src.ogDescriptionOverride;
  if (typeof src.ogImageMediaId === "number" && Number.isSafeInteger(src.ogImageMediaId)) {
    normalized.ogImageMediaId = src.ogImageMediaId;
  }
  if (typeof src.schemaType === "string") normalized.schemaType = src.schemaType;
  if (typeof src.noindex === "boolean") normalized.noindex = src.noindex;
  if (typeof src.nofollow === "boolean") normalized.nofollow = src.nofollow;

  const parsed = SeoEditorOverrideInputSchema.safeParse(normalized);
  return parsed.success ? parsed.data : {};
}

function extractPublishedPeerSummaries(
  tenantDb: D1Database,
  excludeKind: SeoEditorResourceKind,
  excludeId: number,
  siteName: string,
): Promise<readonly PeerPublishedSeoSummary[]> {
  return (async () => {
    const peers: PeerPublishedSeoSummary[] = [];

    const [pageRows, postRows, offeringRows] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT id, slug, title, is_homepage, published_sections_json, seo_json
           FROM pages
           WHERE status = 'published' AND deleted_at IS NULL
           LIMIT 200`,
        )
        .all<{
          readonly id: number;
          readonly slug: string;
          readonly title: string;
          readonly is_homepage: number;
          readonly published_sections_json: string | null;
          readonly seo_json: string | null;
        }>()
        .catch(() => ({ results: [] })),
      tenantDb
        .prepare(
          `SELECT id, slug, title, excerpt, published_body_json, seo_json
           FROM posts
           WHERE status = 'published' AND deleted_at IS NULL
           LIMIT 200`,
        )
        .all<{
          readonly id: number;
          readonly slug: string;
          readonly title: string;
          readonly excerpt: string | null;
          readonly published_body_json: string | null;
          readonly seo_json: string | null;
        }>()
        .catch(() => ({ results: [] })),
      tenantDb
        .prepare(
          `SELECT id, offering_type, slug, title, summary, published_snapshot_json, seo_json
           FROM offerings
           WHERE status = 'published' AND deleted_at IS NULL
           LIMIT 200`,
        )
        .all<{
          readonly id: number;
          readonly offering_type: OfferingType;
          readonly slug: string;
          readonly title: string;
          readonly summary: string | null;
          readonly published_snapshot_json: string | null;
          readonly seo_json: string | null;
        }>()
        .catch(() => ({ results: [] })),
    ]);

    for (const p of pageRows.results) {
      if (excludeKind === "page" && Number(p.id) === excludeId) continue;
      const seo = extractSeoFromEnvelopeOrColumn(p.published_sections_json, p.seo_json);
      peers.push({
        resourceKind: "page",
        resourceId: Number(p.id),
        title: p.title,
        effectiveTitle: seo.titleOverride?.trim() || `${p.title} | ${siteName}`,
        effectiveDescription: seo.descriptionOverride?.trim() || "",
        focusKeyphrase: seo.focusKeyphrase?.trim() || null,
        pathname: Number(p.is_homepage) === 1 ? "/" : `/${p.slug}`,
      });
    }

    for (const post of postRows.results) {
      if (excludeKind === "post" && Number(post.id) === excludeId) continue;
      const seo = extractSeoFromEnvelopeOrColumn(post.published_body_json, post.seo_json);
      peers.push({
        resourceKind: "post",
        resourceId: Number(post.id),
        title: post.title,
        effectiveTitle: seo.titleOverride?.trim() || `${post.title} | ${siteName}`,
        effectiveDescription: seo.descriptionOverride?.trim() || post.excerpt?.trim() || "",
        focusKeyphrase: seo.focusKeyphrase?.trim() || null,
        pathname: `/blog/${post.slug}`,
      });
    }

    for (const off of offeringRows.results) {
      if (excludeKind === "offering" && Number(off.id) === excludeId) continue;
      const seo = extractSeoFromEnvelopeOrColumn(off.published_snapshot_json, off.seo_json);
      peers.push({
        resourceKind: "offering",
        resourceId: Number(off.id),
        title: off.title,
        effectiveTitle: seo.titleOverride?.trim() || `${off.title} | ${siteName}`,
        effectiveDescription: seo.descriptionOverride?.trim() || off.summary?.trim() || "",
        focusKeyphrase: seo.focusKeyphrase?.trim() || null,
        pathname: `${offeringTypeToPathPrefix(off.offering_type)}/${off.slug}`,
      });
    }

    return peers;
  })();
}

function extractSectionsSignals(
  sectionsRaw: unknown,
  primaryHost: string,
): {
  readonly hasVisibleFaqBlock: boolean;
  readonly firstParagraphText: string;
  readonly headings: readonly { readonly level: number; readonly text: string }[];
  readonly plainTextBody: string;
  readonly internalLinkCount: number;
  readonly images: readonly SeoChecklistContentImage[];
} {
  let sections: readonly PageSnapshot["sections"][number][] = [];
  if (Array.isArray(sectionsRaw)) {
    sections = sectionsRaw as PageSnapshot["sections"];
  } else if (sectionsRaw && typeof sectionsRaw === "object") {
    const data = (sectionsRaw as Record<string, unknown>).data as Record<string, unknown> | undefined;
    if (data && Array.isArray(data.sections)) {
      sections = data.sections as PageSnapshot["sections"];
    }
  }

  let hasVisibleFaqBlock = false;
  let firstParagraphText = "";
  const headings: Array<{ readonly level: number; readonly text: string }> = [];
  const textParts: string[] = [];
  let internalLinkCount = 0;
  const images: SeoChecklistContentImage[] = [];

  for (const sec of sections) {
    if (sec.kind === "faq") {
      hasVisibleFaqBlock = true;
    }
    if (sec.heading?.trim()) {
      headings.push({ level: 2, text: sec.heading.trim() });
      textParts.push(sec.heading.trim());
    }
    if (sec.subheading?.trim()) {
      if (!firstParagraphText) firstParagraphText = sec.subheading.trim();
      textParts.push(sec.subheading.trim());
    }
    if (sec.ctaHref?.trim() && sec.ctaHref.trim().startsWith("/") && !sec.ctaHref.trim().startsWith("//")) {
      internalLinkCount += 1;
    }
    if (sec.bodyHtml?.trim()) {
      const doc = htmlToRestrictedRichTextDoc(sec.bodyHtml);
      const sig = extractChecklistSignalsFromRichTextDoc(doc, primaryHost);
      if (!firstParagraphText && sig.firstParagraphText) {
        firstParagraphText = sig.firstParagraphText;
      }
      headings.push(...sig.headings);
      if (sig.plainTextBody) textParts.push(sig.plainTextBody);
      internalLinkCount += sig.internalLinkCount;
      images.push(...sig.images);
    }
  }

  return {
    hasVisibleFaqBlock,
    firstParagraphText,
    headings,
    plainTextBody: textParts.join(" "),
    internalLinkCount,
    images,
  };
}

function hasTourVisibleItinerary(
  attributesRaw: unknown,
  descriptionText: string,
): boolean {
  if (attributesRaw && typeof attributesRaw === "object" && !Array.isArray(attributesRaw)) {
    const attrs = attributesRaw as Record<string, unknown>;
    if (typeof attrs.destination === "string" && attrs.destination.trim().length > 0) {
      return true;
    }
    if (Array.isArray(attrs.itinerary) && attrs.itinerary.length > 0) {
      return true;
    }
    if (typeof attrs.itinerary === "string" && attrs.itinerary.trim().length > 0) {
      return true;
    }
  }
  return /\b(?:hari\s*1|day\s*1|itinerary|rencana perjalanan)\b/i.test(descriptionText);
}

export async function getResourceSeoEditorState(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly resourceKind: SeoEditorResourceKind;
    readonly resourceId: number;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<ResourceSeoEditorState> {
  const [platformCtx, siteCtx, settingsRec] = await Promise.all([
    resolveTenantPlatformSeoContext(platformDb, input.tenantId, {
      saasZone: input.saasZone,
      nowMs: input.nowMs,
    }),
    readSiteAndBusinessContext(tenantDb, "Situs Bisnis"),
    getTenantSeoEditorSettings(platformDb, tenantDb, input.tenantId, {
      saasZone: input.saasZone,
      nowMs: input.nowMs,
    }),
  ]);
  const publishedPeers = await extractPublishedPeerSummaries(
    tenantDb,
    input.resourceKind,
    input.resourceId,
    siteCtx.siteName,
  );

  const searchAppearance = settingsRec.published?.searchAppearance ?? settingsRec.draft.searchAppearance;

  if (input.resourceKind === "page") {
    const row = await tenantDb
      .prepare(
        `SELECT id, slug, title, is_homepage, draft_sections_json, published_sections_json, seo_json, status, version
         FROM pages
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(input.resourceId)
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly is_homepage: number;
        readonly draft_sections_json: string;
        readonly published_sections_json: string | null;
        readonly seo_json: string | null;
        readonly status: "draft" | "published" | "trashed";
        readonly version: number;
      }>();

    if (!row) {
      throw new SeoNotFoundError("Halaman tidak ditemukan.");
    }

    const draftEnvelope = safeJsonParse(row.draft_sections_json);
    const draftSeo = extractSeoFromEnvelopeOrColumn(row.draft_sections_json, row.seo_json);
    const publishedSeo = row.published_sections_json
      ? extractSeoFromEnvelopeOrColumn(row.published_sections_json, row.seo_json)
      : null;

    const isHomepage = Number(row.is_homepage) === 1;
    const pathname = isHomepage ? "/" : `/${row.slug}`;
    const routeKind: SeoRouteKind = isHomepage ? "homepage" : "page";
    const searchAppearanceKind: SearchAppearanceKind = isHomepage ? "homepage" : "page";
    const signals = extractSectionsSignals(draftEnvelope, platformCtx.primaryHost);

    const preview = resolveEffectiveSeoPreview({
      tenant: platformCtx.verifiedHostInput,
      siteName: siteCtx.siteName,
      tagline: siteCtx.tagline,
      siteDefaultTitle: siteCtx.siteDefaultTitle,
      siteDefaultDescription: siteCtx.siteDefaultDescription,
      siteDefaultOgMediaId: siteCtx.siteDefaultOgMediaId,
      siteVisibility: siteCtx.siteVisibility,
      searchAppearance,
      resourceKind: "page",
      searchAppearanceKind,
      routeKind,
      pathname,
      resourceTitle: row.title,
      resourceExcerpt: signals.firstParagraphText || null,
      publicationState: row.status,
      seo: draftSeo,
      hasVisibleFaqBlock: signals.hasVisibleFaqBlock,
    });

    const checklist = evaluateSeoChecklist({
      resourceKind: "page",
      effectiveTitle: preview.effectiveTitle,
      effectiveDescription: preview.effectiveDescription,
      isFallbackDescription: preview.isFallbackDescriptionWarning,
      slug: row.slug,
      focusKeyphrase: draftSeo.focusKeyphrase ?? null,
      firstParagraphText: signals.firstParagraphText,
      headings: signals.headings,
      plainTextBody: signals.plainTextBody,
      internalLinkCount: signals.internalLinkCount,
      images: signals.images,
      publishedPeers,
      noindex: Boolean(draftSeo.noindex),
    });

    return {
      resourceKind: "page",
      resourceId: Number(row.id),
      title: row.title,
      slug: row.slug,
      pathname,
      status: row.status,
      version: Number(row.version),
      seoAutopilotEnabled: settingsRec.seoAutopilotEnabled,
      draftSeo,
      publishedSeo,
      allowedSchemaTypes: getAllowedSchemaTypeOptions({
        resourceKind: "page",
        hasVisibleFaqBlock: signals.hasVisibleFaqBlock,
      }),
      preview,
      checklist,
    };
  }

  if (input.resourceKind === "post") {
    const row = await tenantDb
      .prepare(
        `SELECT id, slug, title, excerpt, draft_body_json, published_body_json, cover_media_id, seo_json, status, version
         FROM posts
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(input.resourceId)
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly excerpt: string | null;
        readonly draft_body_json: string;
        readonly published_body_json: string | null;
        readonly cover_media_id: number | null;
        readonly seo_json: string | null;
        readonly status: "draft" | "published" | "trashed";
        readonly version: number;
      }>();

    if (!row) {
      throw new SeoNotFoundError("Artikel tidak ditemukan.");
    }

    const draftSeo = extractSeoFromEnvelopeOrColumn(row.draft_body_json, row.seo_json);
    const publishedSeo = row.published_body_json
      ? extractSeoFromEnvelopeOrColumn(row.published_body_json, row.seo_json)
      : null;

    const draftEnv = safeJsonParse(row.draft_body_json) as Record<string, unknown> | null;
    const bodyDoc =
      draftEnv?.data && typeof draftEnv.data === "object"
        ? ((draftEnv.data as Partial<PostSnapshot>).body as RestrictedRichTextDoc | undefined)
        : (draftEnv as RestrictedRichTextDoc | null);
    const signals = extractChecklistSignalsFromRichTextDoc(bodyDoc, platformCtx.primaryHost);
    const pathname = `/blog/${row.slug}`;

    const preview = resolveEffectiveSeoPreview({
      tenant: platformCtx.verifiedHostInput,
      siteName: siteCtx.siteName,
      tagline: siteCtx.tagline,
      siteDefaultTitle: siteCtx.siteDefaultTitle,
      siteDefaultDescription: siteCtx.siteDefaultDescription,
      siteDefaultOgMediaId: siteCtx.siteDefaultOgMediaId,
      siteVisibility: siteCtx.siteVisibility,
      searchAppearance,
      resourceKind: "post",
      searchAppearanceKind: "post",
      routeKind: "post",
      pathname,
      resourceTitle: row.title,
      resourceExcerpt: row.excerpt ?? (signals.firstParagraphText || null),
      resourceFeaturedMediaId: row.cover_media_id,
      publicationState: row.status,
      seo: draftSeo,
    });

    const checklist = evaluateSeoChecklist({
      resourceKind: "post",
      effectiveTitle: preview.effectiveTitle,
      effectiveDescription: preview.effectiveDescription,
      isFallbackDescription: preview.isFallbackDescriptionWarning,
      slug: row.slug,
      focusKeyphrase: draftSeo.focusKeyphrase ?? null,
      firstParagraphText: signals.firstParagraphText,
      headings: signals.headings,
      plainTextBody: signals.plainTextBody,
      internalLinkCount: signals.internalLinkCount,
      images: signals.images,
      publishedPeers,
      noindex: Boolean(draftSeo.noindex),
    });

    return {
      resourceKind: "post",
      resourceId: Number(row.id),
      title: row.title,
      slug: row.slug,
      pathname,
      status: row.status,
      version: Number(row.version),
      seoAutopilotEnabled: settingsRec.seoAutopilotEnabled,
      draftSeo,
      publishedSeo,
      allowedSchemaTypes: getAllowedSchemaTypeOptions({ resourceKind: "post" }),
      preview,
      checklist,
    };
  }

  if (input.resourceKind === "offering") {
    const row = await tenantDb
      .prepare(
        `SELECT id, offering_type, slug, title, summary, description, cover_media_id, price_mode, price,
                attributes_json, draft_snapshot_json, published_snapshot_json, seo_json, status, version
         FROM offerings
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(input.resourceId)
      .first<{
        readonly id: number;
        readonly offering_type: OfferingType;
        readonly slug: string;
        readonly title: string;
        readonly summary: string | null;
        readonly description: string | null;
        readonly cover_media_id: number | null;
        readonly price_mode: "fixed" | "from" | "range" | "on_request";
        readonly price: number | null;
        readonly attributes_json: string;
        readonly draft_snapshot_json: string | null;
        readonly published_snapshot_json: string | null;
        readonly seo_json: string | null;
        readonly status: "draft" | "published" | "trashed";
        readonly version: number;
      }>();

    if (!row) {
      throw new SeoNotFoundError("Penawaran katalog tidak ditemukan.");
    }

    const draftSeo = extractSeoFromEnvelopeOrColumn(row.draft_snapshot_json, row.seo_json);
    const publishedSeo = row.published_snapshot_json
      ? extractSeoFromEnvelopeOrColumn(row.published_snapshot_json, row.seo_json)
      : null;

    const descParsed = safeJsonParse(row.description);
    const descDoc: RestrictedRichTextDoc =
      descParsed && typeof descParsed === "object" && "blocks" in descParsed
        ? (descParsed as RestrictedRichTextDoc)
        : row.description
          ? htmlToRestrictedRichTextDoc(row.description)
          : { schemaVersion: 1, blocks: [] };
    const signals = extractChecklistSignalsFromRichTextDoc(descDoc, platformCtx.primaryHost);
    const attrsParsed = safeJsonParse(row.attributes_json);
    const hasItinerary =
      row.offering_type === "tour" && hasTourVisibleItinerary(attrsParsed, signals.plainTextBody);
    const pathname = `${offeringTypeToPathPrefix(row.offering_type)}/${row.slug}`;

    const preview = resolveEffectiveSeoPreview({
      tenant: platformCtx.verifiedHostInput,
      siteName: siteCtx.siteName,
      tagline: siteCtx.tagline,
      siteDefaultTitle: siteCtx.siteDefaultTitle,
      siteDefaultDescription: siteCtx.siteDefaultDescription,
      siteDefaultOgMediaId: siteCtx.siteDefaultOgMediaId,
      siteVisibility: siteCtx.siteVisibility,
      searchAppearance,
      resourceKind: "offering",
      searchAppearanceKind: "catalog_item",
      routeKind: "offering",
      pathname,
      resourceTitle: row.title,
      resourceExcerpt: row.summary ?? (signals.firstParagraphText || null),
      resourceFeaturedMediaId: row.cover_media_id,
      publicationState: row.status,
      seo: draftSeo,
      offeringType: row.offering_type,
      priceMode: row.price_mode,
      price: row.price,
      hasVisibleItinerary: hasItinerary,
    });

    const checklist = evaluateSeoChecklist({
      resourceKind: "offering",
      effectiveTitle: preview.effectiveTitle,
      effectiveDescription: preview.effectiveDescription,
      isFallbackDescription: preview.isFallbackDescriptionWarning,
      slug: row.slug,
      focusKeyphrase: draftSeo.focusKeyphrase ?? null,
      firstParagraphText: row.summary || signals.firstParagraphText,
      headings: signals.headings,
      plainTextBody: `${row.summary ?? ""} ${signals.plainTextBody}`.trim(),
      internalLinkCount: signals.internalLinkCount,
      images: signals.images,
      publishedPeers,
      noindex: Boolean(draftSeo.noindex),
    });

    return {
      resourceKind: "offering",
      resourceId: Number(row.id),
      title: row.title,
      slug: row.slug,
      pathname,
      status: row.status,
      version: Number(row.version),
      seoAutopilotEnabled: settingsRec.seoAutopilotEnabled,
      draftSeo,
      publishedSeo,
      allowedSchemaTypes: getAllowedSchemaTypeOptions({
        resourceKind: "offering",
        offeringType: row.offering_type,
        priceMode: row.price_mode,
        price: row.price,
        hasVisibleItinerary: hasItinerary,
      }),
      preview,
      checklist,
    };
  }

  // Taxonomy (`post_category` | `post_tag` | `offering_category`)
  const taxRow = await tenantDb
    .prepare(
      `SELECT id, taxonomy_type, offering_type, slug, name, description, version
       FROM taxonomies
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(input.resourceId)
    .first<{
      readonly id: number;
      readonly taxonomy_type: "post_category" | "post_tag" | "offering_category";
      readonly offering_type: OfferingType | null;
      readonly slug: string;
      readonly name: string;
      readonly description: string | null;
      readonly version: number;
    }>();

  if (!taxRow) {
    throw new SeoNotFoundError("Taksonomi tidak ditemukan.");
  }

  let indexOptIn = false;
  if (await tableExists(tenantDb, "taxonomy_archive_settings")) {
    const optRow = await tenantDb
      .prepare(`SELECT index_opt_in FROM taxonomy_archive_settings WHERE taxonomy_id = ? LIMIT 1`)
      .bind(taxRow.id)
      .first<{ readonly index_opt_in: number }>()
      .catch(() => null);
    indexOptIn = Number(optRow?.index_opt_in ?? 0) === 1;
  }

  const countRow =
    taxRow.taxonomy_type === "offering_category"
      ? await tenantDb
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM offering_taxonomies ot
             INNER JOIN offerings o ON o.id = ot.offering_id
             WHERE ot.taxonomy_id = ? AND o.status = 'published' AND o.deleted_at IS NULL`,
          )
          .bind(taxRow.id)
          .first<{ readonly cnt: number }>()
      : await tenantDb
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM post_taxonomies pt
             INNER JOIN posts p ON p.id = pt.post_id
             WHERE pt.taxonomy_id = ? AND p.status = 'published' AND p.deleted_at IS NULL`,
          )
          .bind(taxRow.id)
          .first<{ readonly cnt: number }>();

  const publishedCount = Number(countRow?.cnt ?? 0);
  const routeKind: SeoRouteKind =
    taxRow.taxonomy_type === "post_category"
      ? "category_archive"
      : taxRow.taxonomy_type === "post_tag"
        ? "tag_archive"
        : "offering_category_archive";
  const searchAppearanceKind: SearchAppearanceKind =
    taxRow.taxonomy_type === "post_category"
      ? "post_category"
      : taxRow.taxonomy_type === "post_tag"
        ? "post_tag"
        : "catalog_category";
  const pathname =
    taxRow.taxonomy_type === "post_category"
      ? `/blog/kategori/${taxRow.slug}`
      : taxRow.taxonomy_type === "post_tag"
        ? `/blog/tag/${taxRow.slug}`
        : `${offeringTypeToPathPrefix(taxRow.offering_type ?? "service")}/kategori/${taxRow.slug}`;

  const preview = resolveEffectiveSeoPreview({
    tenant: platformCtx.verifiedHostInput,
    siteName: siteCtx.siteName,
    tagline: siteCtx.tagline,
    siteDefaultTitle: siteCtx.siteDefaultTitle,
    siteDefaultDescription: siteCtx.siteDefaultDescription,
    siteDefaultOgMediaId: siteCtx.siteDefaultOgMediaId,
    siteVisibility: siteCtx.siteVisibility,
    searchAppearance,
    resourceKind: "taxonomy",
    searchAppearanceKind,
    routeKind,
    pathname,
    resourceTitle: taxRow.name,
    resourceExcerpt: taxRow.description,
    publicationState: "published",
    seo: null,
    taxonomyOptIn: indexOptIn,
    archiveItemCount: publishedCount,
  });

  const checklist = evaluateSeoChecklist({
    resourceKind: "taxonomy",
    effectiveTitle: preview.effectiveTitle,
    effectiveDescription: preview.effectiveDescription,
    isFallbackDescription: preview.isFallbackDescriptionWarning,
    slug: taxRow.slug,
    plainTextBody: taxRow.description ?? "",
    publishedPeers,
    noindex: !preview.effectiveIndexable,
  });

  return {
    resourceKind: "taxonomy",
    resourceId: Number(taxRow.id),
    title: taxRow.name,
    slug: taxRow.slug,
    pathname,
    status: "published",
    version: Number(taxRow.version),
    seoAutopilotEnabled: settingsRec.seoAutopilotEnabled,
    draftSeo: {},
    publishedSeo: null,
    indexOptIn,
    publishedCount,
    allowedSchemaTypes: [],
    preview,
    checklist,
  };
}

/**
 * Verifies `ogImageMediaId` belongs to this tenant, is `kind = 'image'`, `status = 'ready'`,
 * AND is not soft-deleted (`deleted_at IS NULL` when migration 0002 column is present).
 */
async function verifyOwnedReadyImageMedia(
  tenantDb: D1Database,
  mediaId: number,
): Promise<void> {
  const hasDeletedAt = await tableHasColumn(tenantDb, "media_items", "deleted_at");
  const sql = hasDeletedAt
    ? `SELECT id, kind, status FROM media_items WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    : `SELECT id, kind, status FROM media_items WHERE id = ? LIMIT 1`;

  const row = await tenantDb
    .prepare(sql)
    .bind(mediaId)
    .first<{ readonly id: number; readonly kind: string; readonly status: string }>();

  if (!row) {
    throw new SeoValidationError("Gambar Open Graph tidak ditemukan pada situs ini.", [
      {
        field: "seo.ogImageMediaId",
        code: "INVALID_MEDIA_ID",
        message: "Media tidak dimiliki situs ini atau sudah dihapus.",
      },
    ]);
  }
  if (row.kind !== "image" || row.status !== "ready") {
    throw new SeoValidationError("Gambar Open Graph harus berupa gambar siap pakai.", [
      {
        field: "seo.ogImageMediaId",
        code: "INVALID_MEDIA_STATUS",
        message: "Hanya gambar berstatus siap pakai (ready) yang dapat digunakan sebagai gambar OG.",
      },
    ]);
  }
}

/**
 * Patches draft SEO cleanly while preserving envelope shape:
 * - Envelope `{ snapshotVersion, resourceType, data: { ... } }` -> updates `data.seo`
 * - Raw seeded `RestrictedRichTextDoc` (`post` with `blocks` array) -> wraps cleanly in `{ snapshotVersion: 1, resourceType: "post", data: { ...fallbackBase, body: parsed, seo } }`
 * - Raw seeded sections array (`page`) -> wraps cleanly in `{ snapshotVersion: 1, resourceType: "page", data: { ...fallbackBase, sections: parsed, seo } }`
 */
function patchDraftEnvelopeSeoJson(
  rawDraftJson: string | null,
  resourceType: "page" | "post" | "offering",
  fallbackBase: Record<string, unknown>,
  nextSeo: SeoEditorOverrideInput,
): string {
  const parsed = safeJsonParse(rawDraftJson);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      return JSON.stringify({
        ...obj,
        data: {
          ...(obj.data as Record<string, unknown>),
          seo: nextSeo,
        },
      });
    }
    // Raw RestrictedRichTextDoc for post without snapshot envelope
    if (resourceType === "post" && Array.isArray(obj.blocks)) {
      return JSON.stringify({
        snapshotVersion: 1,
        resourceType: "post",
        data: {
          ...fallbackBase,
          body: obj,
          seo: nextSeo,
        },
      });
    }
    return JSON.stringify({
      ...obj,
      seo: nextSeo,
    });
  }

  if (resourceType === "page" && Array.isArray(parsed)) {
    return JSON.stringify({
      snapshotVersion: 1,
      resourceType: "page",
      data: {
        ...fallbackBase,
        sections: parsed,
        seo: nextSeo,
      },
    });
  }

  if (resourceType === "offering") {
    return JSON.stringify({
      ...fallbackBase,
      seo: nextSeo,
    });
  }

  return JSON.stringify({
    snapshotVersion: 1,
    resourceType,
    data: {
      ...fallbackBase,
      seo: nextSeo,
    },
  });
}

/**
 * Updates per-resource SEO overrides (or taxonomy indexOptIn) with:
 * - Server-side `seo-ai-autopilot` enabled gate (`409 PLUGIN_DISABLED` when disabled)
 * - Strict Zod v4 `.strict()` schema validation
 * - Allowed schema type per content kind + visible-fact checks (FAQPage / Product / TouristTrip)
 * - Tenant-owned ready non-trashed image check for `ogImageMediaId`
 * - Atomic OCC (`WHERE id = ? AND version = ?`) + gated `tenant_activity_log` in one `batch()`
 * - Strict draft isolation: on published pages/posts/offerings, ONLY updates draft snapshot!
 */
export async function updateResourceSeoOverrides(
  platformDb: D1Database,
  tenantDb: D1Database,
  input: {
    readonly tenantId: string;
    readonly resourceKind: SeoEditorResourceKind;
    readonly resourceId: number;
    readonly payload: unknown;
    readonly expectedVersion: number;
    readonly actorUserId: string;
    readonly actorRole: string;
    readonly saasZone?: string;
    readonly nowMs?: number;
  },
): Promise<ResourceSeoEditorState> {
  await assertSeoAutopilotEnabled(tenantDb);

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const parsed = ResourceSeoUpdateRequestSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new SeoValidationError(
      "Pengaturan SEO konten tidak valid.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : "seo",
        code: issue.code.toUpperCase(),
        message: issue.message,
      })),
    );
  }

  if (input.resourceKind === "taxonomy") {
    if (parsed.data.seo !== undefined) {
      throw new SeoValidationError("Taksonomi hanya mendukung pengaturan indexOptIn.", [
        {
          field: "seo",
          code: "UNSUPPORTED_FIELD",
          message: "Gunakan indexOptIn untuk mengatur indeksasi arsip taksonomi.",
        },
      ]);
    }
    if (typeof parsed.data.indexOptIn !== "boolean") {
      throw new SeoValidationError("Field indexOptIn wajib berupa boolean.", [
        {
          field: "indexOptIn",
          code: "REQUIRED",
          message: "Sertakan indexOptIn (true atau false).",
        },
      ]);
    }

    const taxRow = await tenantDb
      .prepare(`SELECT id, version, updated_at FROM taxonomies WHERE id = ? LIMIT 1`)
      .bind(input.resourceId)
      .first<{ readonly id: number; readonly version: number; readonly updated_at: number }>();
    if (!taxRow) {
      throw new SeoNotFoundError("Taksonomi tidak ditemukan.");
    }
    if (Number(taxRow.version) !== input.expectedVersion) {
      throw new SeoConflictError(
        `Taksonomi sudah diubah (versi saat ini v${taxRow.version}). Muat ulang sebelum menyimpan.`,
        Number(taxRow.version),
      );
    }

    await tenantDb
      .prepare(
        `CREATE TABLE IF NOT EXISTS taxonomy_archive_settings (
           taxonomy_id INTEGER PRIMARY KEY REFERENCES taxonomies(id) ON DELETE CASCADE,
           index_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (index_opt_in IN (0, 1)),
           updated_at INTEGER NOT NULL
         )`,
      )
      .run();

    const prevArchiveOpt = await tenantDb
      .prepare(`SELECT index_opt_in, updated_at FROM taxonomy_archive_settings WHERE taxonomy_id = ? LIMIT 1`)
      .bind(input.resourceId)
      .first<{ readonly index_opt_in: number; readonly updated_at: number }>();

    const nextVersion = input.expectedVersion + 1;
    const results = await tenantDb.batch([
      tenantDb
        .prepare(
          `UPDATE taxonomies
           SET version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(nowMs, input.resourceId, input.expectedVersion),
      tenantDb
        .prepare(
          `INSERT INTO taxonomy_archive_settings (taxonomy_id, index_opt_in, updated_at)
           SELECT ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND version = ? AND updated_at = ?)
           ON CONFLICT(taxonomy_id) DO UPDATE SET
             index_opt_in = excluded.index_opt_in,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.resourceId,
          parsed.data.indexOptIn ? 1 : 0,
          nowMs,
          input.resourceId,
          nextVersion,
          nowMs,
        ),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'seo.taxonomy.index_opt_in', 'taxonomy', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM taxonomies WHERE id = ? AND version = ? AND updated_at = ?)`,
        )
        .bind(
          input.actorUserId,
          input.actorRole,
          String(input.resourceId),
          parsed.data.indexOptIn
            ? "Mengaktifkan opsi indeks arsip taksonomi"
            : "Menonaktifkan opsi indeks arsip taksonomi",
          JSON.stringify({ indexOptIn: parsed.data.indexOptIn }),
          nowMs,
          input.resourceId,
          nextVersion,
          nowMs,
        ),
    ]);

    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      const fresh = await tenantDb
        .prepare(`SELECT version FROM taxonomies WHERE id = ? LIMIT 1`)
        .bind(input.resourceId)
        .first<{ readonly version: number }>();
      throw new SeoConflictError(
        `Konflik versi saat memperbarui indeksasi taksonomi (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
        Number(fresh?.version ?? input.expectedVersion),
      );
    }

    try {
      await bumpTenantCacheVersion(platformDb, input.tenantId, nowMs);
    } catch {
      const rollbackStmts: D1PreparedStatement[] = [
        tenantDb
          .prepare(`UPDATE taxonomies SET version = ?, updated_at = ? WHERE id = ? AND version = ?`)
          .bind(taxRow.version, taxRow.updated_at, input.resourceId, nextVersion),
      ];
      if (prevArchiveOpt) {
        rollbackStmts.push(
          tenantDb
            .prepare(
              `UPDATE taxonomy_archive_settings SET index_opt_in = ?, updated_at = ? WHERE taxonomy_id = ?`,
            )
            .bind(prevArchiveOpt.index_opt_in, prevArchiveOpt.updated_at, input.resourceId),
        );
      } else {
        rollbackStmts.push(
          tenantDb
            .prepare(`DELETE FROM taxonomy_archive_settings WHERE taxonomy_id = ?`)
            .bind(input.resourceId),
        );
      }
      await tenantDb.batch(rollbackStmts);
      throw new SeoServiceUnavailableError();
    }

    return getResourceSeoEditorState(platformDb, tenantDb, {
      tenantId: input.tenantId,
      resourceKind: "taxonomy",
      resourceId: input.resourceId,
      saasZone: input.saasZone,
      nowMs,
    });
  }

  if (parsed.data.seo === undefined) {
    throw new SeoValidationError("Objek seo wajib disertakan.", [
      { field: "seo", code: "REQUIRED", message: "Sertakan field seo untuk memperbarui override SEO." },
    ]);
  }

  const nextSeo = parsed.data.seo;
  if (typeof nextSeo.ogImageMediaId === "number") {
    await verifyOwnedReadyImageMedia(tenantDb, nextSeo.ogImageMediaId);
  }

  const nextVersion = input.expectedVersion + 1;

  if (input.resourceKind === "page") {
    const row = await tenantDb
      .prepare(
        `SELECT id, slug, title, is_homepage, draft_sections_json, status, version
         FROM pages
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(input.resourceId)
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly is_homepage: number;
        readonly draft_sections_json: string;
        readonly status: "draft" | "published" | "trashed";
        readonly version: number;
      }>();

    if (!row) {
      throw new SeoNotFoundError("Halaman tidak ditemukan.");
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new SeoConflictError(
        `Halaman sudah diubah (versi saat ini v${row.version}). Muat ulang sebelum menyimpan SEO.`,
        Number(row.version),
      );
    }

    const signals = extractSectionsSignals(safeJsonParse(row.draft_sections_json), "");
    const schemaCheck = validateSchemaTypeForResource(nextSeo.schemaType, {
      resourceKind: "page",
      hasVisibleFaqBlock: signals.hasVisibleFaqBlock,
    });
    if (!schemaCheck.ok) {
      throw new SeoValidationError(schemaCheck.message, [
        { field: "seo.schemaType", code: schemaCheck.code, message: schemaCheck.message },
      ]);
    }

    const nextDraftJson = patchDraftEnvelopeSeoJson(
      row.draft_sections_json,
      "page",
      {
        slug: row.slug,
        title: row.title,
        isHomepage: Number(row.is_homepage) === 1,
        sections: Array.isArray(safeJsonParse(row.draft_sections_json))
          ? safeJsonParse(row.draft_sections_json)
          : [],
      },
      nextSeo,
    );

    const updateStmt =
      row.status === "published"
        ? tenantDb
            .prepare(
              `UPDATE pages
               SET draft_sections_json = ?, version = version + 1, updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(nextDraftJson, nowMs, input.resourceId, input.expectedVersion)
        : tenantDb
            .prepare(
              `UPDATE pages
               SET draft_sections_json = ?, seo_json = ?, version = version + 1, updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(
              nextDraftJson,
              JSON.stringify(nextSeo),
              nowMs,
              input.resourceId,
              input.expectedVersion,
            );

    const results = await tenantDb.batch([
      updateStmt,
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'seo.resource.updated', 'page', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ? AND updated_at = ?)`,
        )
        .bind(
          input.actorUserId,
          input.actorRole,
          String(input.resourceId),
          `Memperbarui pengaturan SEO draf halaman #${input.resourceId}`,
          JSON.stringify({ schemaType: nextSeo.schemaType ?? null, noindex: Boolean(nextSeo.noindex) }),
          nowMs,
          input.resourceId,
          nextVersion,
          nowMs,
        ),
    ]);

    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      const fresh = await tenantDb
        .prepare(`SELECT version FROM pages WHERE id = ? LIMIT 1`)
        .bind(input.resourceId)
        .first<{ readonly version: number }>();
      throw new SeoConflictError(
        `Konflik versi saat menyimpan SEO halaman (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
        Number(fresh?.version ?? input.expectedVersion),
      );
    }

    return getResourceSeoEditorState(platformDb, tenantDb, {
      tenantId: input.tenantId,
      resourceKind: "page",
      resourceId: input.resourceId,
      saasZone: input.saasZone,
      nowMs,
    });
  }

  if (input.resourceKind === "post") {
    const row = await tenantDb
      .prepare(
        `SELECT id, slug, title, excerpt, draft_body_json, status, version
         FROM posts
         WHERE id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(input.resourceId)
      .first<{
        readonly id: number;
        readonly slug: string;
        readonly title: string;
        readonly excerpt: string | null;
        readonly draft_body_json: string;
        readonly status: "draft" | "published" | "trashed";
        readonly version: number;
      }>();

    if (!row) {
      throw new SeoNotFoundError("Artikel tidak ditemukan.");
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new SeoConflictError(
        `Artikel sudah diubah (versi saat ini v${row.version}). Muat ulang sebelum menyimpan SEO.`,
        Number(row.version),
      );
    }

    const schemaCheck = validateSchemaTypeForResource(nextSeo.schemaType, {
      resourceKind: "post",
    });
    if (!schemaCheck.ok) {
      throw new SeoValidationError(schemaCheck.message, [
        { field: "seo.schemaType", code: schemaCheck.code, message: schemaCheck.message },
      ]);
    }

    const nextDraftJson = patchDraftEnvelopeSeoJson(
      row.draft_body_json,
      "post",
      {
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
      },
      nextSeo,
    );

    const updateStmt =
      row.status === "published"
        ? tenantDb
            .prepare(
              `UPDATE posts
               SET draft_body_json = ?, version = version + 1, updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(nextDraftJson, nowMs, input.resourceId, input.expectedVersion)
        : tenantDb
            .prepare(
              `UPDATE posts
               SET draft_body_json = ?, seo_json = ?, version = version + 1, updated_at = ?
               WHERE id = ? AND version = ? AND deleted_at IS NULL`,
            )
            .bind(
              nextDraftJson,
              JSON.stringify(nextSeo),
              nowMs,
              input.resourceId,
              input.expectedVersion,
            );

    const results = await tenantDb.batch([
      updateStmt,
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'seo.resource.updated', 'post', ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND version = ? AND updated_at = ?)`,
        )
        .bind(
          input.actorUserId,
          input.actorRole,
          String(input.resourceId),
          `Memperbarui pengaturan SEO draf artikel #${input.resourceId}`,
          JSON.stringify({ schemaType: nextSeo.schemaType ?? null, noindex: Boolean(nextSeo.noindex) }),
          nowMs,
          input.resourceId,
          nextVersion,
          nowMs,
        ),
    ]);

    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      const fresh = await tenantDb
        .prepare(`SELECT version FROM posts WHERE id = ? LIMIT 1`)
        .bind(input.resourceId)
        .first<{ readonly version: number }>();
      throw new SeoConflictError(
        `Konflik versi saat menyimpan SEO artikel (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
        Number(fresh?.version ?? input.expectedVersion),
      );
    }

    return getResourceSeoEditorState(platformDb, tenantDb, {
      tenantId: input.tenantId,
      resourceKind: "post",
      resourceId: input.resourceId,
      saasZone: input.saasZone,
      nowMs,
    });
  }

  // Offering
  const row = await tenantDb
    .prepare(
      `SELECT id, offering_type, slug, title, summary, description, price_mode, price,
              attributes_json, draft_snapshot_json, status, version
       FROM offerings
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(input.resourceId)
    .first<{
      readonly id: number;
      readonly offering_type: OfferingType;
      readonly slug: string;
      readonly title: string;
      readonly summary: string | null;
      readonly description: string | null;
      readonly price_mode: "fixed" | "from" | "range" | "on_request";
      readonly price: number | null;
      readonly attributes_json: string;
      readonly draft_snapshot_json: string | null;
      readonly status: "draft" | "published" | "trashed";
      readonly version: number;
    }>();

  if (!row) {
    throw new SeoNotFoundError("Penawaran katalog tidak ditemukan.");
  }
  if (Number(row.version) !== input.expectedVersion) {
    throw new SeoConflictError(
      `Penawaran sudah diubah (versi saat ini v${row.version}). Muat ulang sebelum menyimpan SEO.`,
      Number(row.version),
    );
  }

  const descParsed = safeJsonParse(row.description);
  const descDoc: RestrictedRichTextDoc =
    descParsed && typeof descParsed === "object" && "blocks" in descParsed
      ? (descParsed as RestrictedRichTextDoc)
      : row.description
        ? htmlToRestrictedRichTextDoc(row.description)
        : { schemaVersion: 1, blocks: [] };
  const signals = extractChecklistSignalsFromRichTextDoc(descDoc, "");
  const hasItinerary =
    row.offering_type === "tour" &&
    hasTourVisibleItinerary(safeJsonParse(row.attributes_json), signals.plainTextBody);

  const schemaCheck = validateSchemaTypeForResource(nextSeo.schemaType, {
    resourceKind: "offering",
    offeringType: row.offering_type,
    priceMode: row.price_mode,
    price: row.price,
    hasVisibleItinerary: hasItinerary,
  });
  if (!schemaCheck.ok) {
    throw new SeoValidationError(schemaCheck.message, [
      { field: "seo.schemaType", code: schemaCheck.code, message: schemaCheck.message },
    ]);
  }

  const nextDraftJson = patchDraftEnvelopeSeoJson(
    row.draft_snapshot_json,
    "offering",
    {
      offeringType: row.offering_type,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
    },
    nextSeo,
  );

  const updateStmt =
    row.status === "published"
      ? tenantDb
          .prepare(
            `UPDATE offerings
             SET draft_snapshot_json = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .bind(nextDraftJson, nowMs, input.resourceId, input.expectedVersion)
      : tenantDb
          .prepare(
            `UPDATE offerings
             SET draft_snapshot_json = ?, seo_json = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          )
          .bind(
            nextDraftJson,
            JSON.stringify(nextSeo),
            nowMs,
            input.resourceId,
            input.expectedVersion,
          );

  const results = await tenantDb.batch([
    updateStmt,
    tenantDb
      .prepare(
        `INSERT INTO tenant_activity_log (
           actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
         )
         SELECT ?, ?, 'seo.resource.updated', 'offering', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM offerings WHERE id = ? AND version = ? AND updated_at = ?)`,
      )
      .bind(
        input.actorUserId,
        input.actorRole,
        String(input.resourceId),
        `Memperbarui pengaturan SEO draf penawaran #${input.resourceId}`,
        JSON.stringify({ schemaType: nextSeo.schemaType ?? null, noindex: Boolean(nextSeo.noindex) }),
        nowMs,
        input.resourceId,
        nextVersion,
        nowMs,
      ),
  ]);

  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    const fresh = await tenantDb
      .prepare(`SELECT version FROM offerings WHERE id = ? LIMIT 1`)
      .bind(input.resourceId)
      .first<{ readonly version: number }>();
    throw new SeoConflictError(
      `Konflik versi saat menyimpan SEO penawaran (versi saat ini v${fresh?.version ?? input.expectedVersion}).`,
      Number(fresh?.version ?? input.expectedVersion),
    );
  }

  return getResourceSeoEditorState(platformDb, tenantDb, {
    tenantId: input.tenantId,
    resourceKind: "offering",
    resourceId: input.resourceId,
    saasZone: input.saasZone,
    nowMs,
  });
}
