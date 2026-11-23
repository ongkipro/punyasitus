import { PlatformThemeIdSchema, ThemeIdSchema } from "../schemas/common.ts";
import type { PlatformThemeId } from "./index.ts";
import { SECTION_REGISTRY_SCHEMA_VERSION } from "./sections.ts";

/**
 * Theme Library Compatibility Evaluator & Tenant Grant Filtering Engine
 * (REQ-046, REQ-018, REQ-021, REQ-034, REQ-036; PLAN §11.4; TASK-042).
 *
 * Pure, side-effect-free domain rules shared by API handlers, DB atomic activation,
 * and admin UI surfaces:
 * - Evaluates whether a tenant's current sections, schema version, and enabled modules
 *   are compatible with a candidate theme before preview or activation.
 * - Filters theme catalogs strictly to built-in platform themes + active non-revoked
 *   grants scoped to THIS tenant (never leaking foreign tenant custom themes).
 */

export const THEME_LIBRARY_ERROR_CODES = [
  "THEME_NOT_FOUND",
  "THEME_NOT_GRANTED",
  "THEME_INCOMPATIBLE",
] as const;

export type ThemeLibraryErrorCode = (typeof THEME_LIBRARY_ERROR_CODES)[number];

export interface ThemeLibraryErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class ThemeLibraryError extends Error {
  readonly httpStatus: 403 | 404 | 422;
  readonly code: ThemeLibraryErrorCode;
  readonly fields: readonly ThemeLibraryErrorField[];

  constructor(
    httpStatus: 403 | 404 | 422,
    code: ThemeLibraryErrorCode,
    message: string,
    fields: readonly ThemeLibraryErrorField[] = [],
  ) {
    super(message);
    this.name = "ThemeLibraryError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.fields = fields;
  }
}

export class ThemeNotFoundError extends ThemeLibraryError {
  readonly themeId: string;

  constructor(themeId: string, message?: string) {
    super(
      404,
      "THEME_NOT_FOUND",
      message ?? `Tema "${themeId}" tidak ditemukan dalam registri platform.`,
      [
        {
          field: "themeId",
          code: "THEME_NOT_FOUND",
          message: `Theme "${themeId}" is not registered.`,
        },
      ],
    );
    this.name = "ThemeNotFoundError";
    this.themeId = themeId;
  }
}

export class ThemeNotGrantedError extends ThemeLibraryError {
  readonly themeId: string;

  constructor(themeId: string, message?: string) {
    super(
      403,
      "THEME_NOT_GRANTED",
      message ?? `Tema kustom "${themeId}" belum diberikan akses untuk situs ini.`,
      [
        {
          field: "themeId",
          code: "THEME_NOT_GRANTED",
          message: `Theme "${themeId}" is not granted to this tenant.`,
        },
      ],
    );
    this.name = "ThemeNotGrantedError";
    this.themeId = themeId;
  }
}

export class ThemeIncompatibleError extends ThemeLibraryError {
  readonly themeId: string;
  readonly compatibility: ThemeCompatibilityReport;

  constructor(
    themeId: string,
    compatibility: ThemeCompatibilityReport,
    message?: string,
  ) {
    const firstReason = compatibility.blockingReasons[0]?.message;
    super(
      422,
      "THEME_INCOMPATIBLE",
      message ??
        firstReason ??
        `Tema "${themeId}" tidak kompatibel dengan struktur konten situs saat ini.`,
      compatibility.blockingReasons.map((r) => ({
        field: r.field,
        code: r.code,
        message: r.message,
      })),
    );
    this.name = "ThemeIncompatibleError";
    this.themeId = themeId;
    this.compatibility = compatibility;
  }
}

// ---------------------------------------------------------------------------
// Compatibility Evaluation (REQ-046, PLAN §11.4)
// ---------------------------------------------------------------------------

export const REQUIRED_PUBLIC_THEME_ROUTES = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export type ThemeRequiredModule = "blog" | "catalog";

export interface ThemeCompatibilityCandidate {
  readonly id: string;
  readonly name: string;
  readonly schemaVersion: number;
  readonly tier: "included" | "paid_once" | "custom";
  readonly basePlatformThemeId?: PlatformThemeId;
  readonly supportedSectionTypes: readonly string[];
  readonly supportedRoutes?: readonly string[];
  readonly requiredModules?: readonly ThemeRequiredModule[];
  readonly recommendedOfferingTypes?: readonly string[];
}

export interface ThemeCompatibilitySectionRef {
  readonly id?: string | null;
  readonly type?: string | null;
  readonly kind?: string | null;
  readonly schemaVersion?: number | null;
  readonly enabled?: boolean | null;
}

export interface ThemeCompatibilityTenantContext {
  readonly vertical?: string | null;
  readonly blogEnabled?: boolean;
  readonly catalogEnabled?: boolean;
  readonly currentSchemaVersion?: number;
  readonly sections?: readonly ThemeCompatibilitySectionRef[];
  readonly contentCounts?: {
    readonly pages?: number;
    readonly posts?: number;
    readonly offerings?: number;
    readonly offeringTypes?: readonly string[];
    readonly menus?: number;
    readonly media?: number;
  };
}

export type ThemeCompatibilityBlockingCode =
  | "UNSUPPORTED_SECTION"
  | "SCHEMA_VERSION_MISMATCH"
  | "MISSING_REQUIRED_MODULE"
  | "MISSING_REQUIRED_ROUTE";

export interface ThemeCompatibilityBlockingReason {
  readonly code: ThemeCompatibilityBlockingCode;
  readonly field: string;
  readonly message: string;
}

export interface ThemeCompatibilityReport {
  readonly compatible: boolean;
  readonly supportedSections: readonly string[];
  readonly unsupportedSections: readonly string[];
  readonly blockingReasons: readonly ThemeCompatibilityBlockingReason[];
  readonly warnings: readonly string[];
  readonly fallbackNotes: readonly string[];
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
}

const PLATFORM_THEME_SET: ReadonlySet<string> = new Set<string>(PlatformThemeIdSchema.options);

function normalizeSectionType(ref: ThemeCompatibilitySectionRef): string | null {
  const raw = typeof ref.type === "string" && ref.type.trim()
    ? ref.type.trim()
    : typeof ref.kind === "string" && ref.kind.trim()
      ? ref.kind.trim()
      : null;
  return raw;
}

/**
 * Evaluates whether a tenant's current sections (published & draft), schema version,
 * and module settings are compatible with a candidate theme.
 *
 * Returns a structured compatibility report with:
 * - `compatible`: false if any blocking mismatch exists (unsupported section kind,
 *   unsupported schema version, missing required public route, or disabled required module).
 * - `supportedSections` / `unsupportedSections`: deduplicated section types present on tenant pages.
 * - `warnings`: non-blocking advisories (e.g. offering types outside theme's primary vertical).
 * - `fallbackNotes`: clear guarantees about content & prior theme configuration preservation.
 */
export function evaluateThemeCompatibility(
  candidate: ThemeCompatibilityCandidate,
  context: ThemeCompatibilityTenantContext = {},
): ThemeCompatibilityReport {
  const expectedSchemaVersion =
    typeof context.currentSchemaVersion === "number" && Number.isInteger(context.currentSchemaVersion)
      ? context.currentSchemaVersion
      : SECTION_REGISTRY_SCHEMA_VERSION;

  const supportedSet = new Set<string>(candidate.supportedSectionTypes);
  const supportedSections: string[] = [];
  const unsupportedSections: string[] = [];
  const seenSections = new Set<string>();
  const blockingReasons: ThemeCompatibilityBlockingReason[] = [];
  const warnings: string[] = [];
  const fallbackNotes: string[] = [];

  // 1. Candidate schema version check
  if (
    !Number.isInteger(candidate.schemaVersion) ||
    candidate.schemaVersion < 1 ||
    candidate.schemaVersion !== expectedSchemaVersion
  ) {
    blockingReasons.push({
      code: "SCHEMA_VERSION_MISMATCH",
      field: "schemaVersion",
      message: `Versi skema tema (${candidate.schemaVersion}) tidak cocok dengan versi skema situs saat ini (v${expectedSchemaVersion}).`,
    });
  }

  // 2. Required public route completeness check
  if (candidate.supportedRoutes && candidate.supportedRoutes.length > 0) {
    const routeSet = new Set(candidate.supportedRoutes);
    const missingRoutes = REQUIRED_PUBLIC_THEME_ROUTES.filter((r) => !routeSet.has(r));
    if (missingRoutes.length > 0) {
      blockingReasons.push({
        code: "MISSING_REQUIRED_ROUTE",
        field: "supportedRoutes",
        message: `Tema belum mendukung rute publik wajib: ${missingRoutes.join(", ")}.`,
      });
    }
  }

  // 3. Required module check (e.g. blog or catalog explicitly required by a bespoke theme)
  if (candidate.requiredModules && candidate.requiredModules.length > 0) {
    for (const mod of candidate.requiredModules) {
      if (mod === "blog" && context.blogEnabled === false) {
        blockingReasons.push({
          code: "MISSING_REQUIRED_MODULE",
          field: "modules.blog",
          message:
            "Tema ini memerlukan modul Artikel (Blog) dalam keadaan aktif. Aktifkan Blog di Pengaturan terlebih dahulu.",
        });
      }
      if (mod === "catalog" && context.catalogEnabled === false) {
        blockingReasons.push({
          code: "MISSING_REQUIRED_MODULE",
          field: "modules.catalog",
          message:
            "Tema ini memerlukan modul Katalog Penawaran dalam keadaan aktif. Aktifkan Katalog di Pengaturan terlebih dahulu.",
        });
      }
    }
  }

  // 4. Section kind & per-section schema version compatibility check
  const sections = context.sections ?? [];
  let highestIncompatibleSectionSchema: number | null = null;
  for (const sec of sections) {
    if (
      typeof sec.schemaVersion === "number" &&
      Number.isInteger(sec.schemaVersion) &&
      sec.schemaVersion > candidate.schemaVersion
    ) {
      if (
        highestIncompatibleSectionSchema === null ||
        sec.schemaVersion > highestIncompatibleSectionSchema
      ) {
        highestIncompatibleSectionSchema = sec.schemaVersion;
      }
    }

    const sectionType = normalizeSectionType(sec);
    if (!sectionType || seenSections.has(sectionType)) {
      continue;
    }
    seenSections.add(sectionType);

    if (supportedSet.has(sectionType)) {
      supportedSections.push(sectionType);
    } else {
      unsupportedSections.push(sectionType);
    }
  }

  if (highestIncompatibleSectionSchema !== null) {
    blockingReasons.push({
      code: "SCHEMA_VERSION_MISMATCH",
      field: "sections.schemaVersion",
      message: `Bagian halaman menggunakan skema v${highestIncompatibleSectionSchema}, sedangkan tema hanya mendukung hingga v${candidate.schemaVersion}.`,
    });
  }

  if (unsupportedSections.length > 0) {
    blockingReasons.push({
      code: "UNSUPPORTED_SECTION",
      field: "sections",
      message: `Tema "${candidate.name}" tidak mendukung tipe bagian: ${unsupportedSections.join(", ")}.`,
    });
  }

  // 5. Non-blocking vertical & offering-type advisories
  const offeringTypes = context.contentCounts?.offeringTypes ?? [];
  const recommendedOfferings = candidate.recommendedOfferingTypes ?? [];
  if (offeringTypes.length > 0 && recommendedOfferings.length > 0) {
    const recSet = new Set(recommendedOfferings);
    const outsideVertical = offeringTypes.filter((t) => !recSet.has(t));
    if (outsideVertical.length > 0) {
      warnings.push(
        `Penawaran bertipe (${outsideVertical.join(", ")}) berada di luar fokus utama tema ini, namun tetap tampil aman melalui tata letak katalog bersama tanpa kehilangan data.`,
      );
    }
  }

  if (
    context.vertical &&
    PLATFORM_THEME_SET.has(candidate.id) &&
    candidate.id !== context.vertical
  ) {
    fallbackNotes.push(
      `Tata letak visual akan menyesuaikan gaya "${candidate.name}" sementara seluruh halaman, artikel, katalog, menu, dan media situs tetap utuh.`,
    );
  }

  fallbackNotes.push(
    "Konfigurasi warna, tipografi, dan varian tema sebelumnya tetap tersimpan terpisah dan dapat dipulihkan saat beralih kembali.",
  );

  return {
    compatible: blockingReasons.length === 0,
    supportedSections,
    unsupportedSections,
    blockingReasons,
    warnings,
    fallbackNotes,
    schemaVersion: candidate.schemaVersion,
    expectedSchemaVersion,
  };
}

// ---------------------------------------------------------------------------
// Strict Tenant Grant Filtering (REQ-046, REQ-021, REQ-034)
// ---------------------------------------------------------------------------

export interface ThemeCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly tier: "included" | "paid_once" | "custom";
  readonly active?: boolean;
}

export interface TenantThemeEntitlementRecord {
  readonly tenantId: string;
  readonly themeId: string;
  readonly active?: boolean;
  readonly revokedAt?: number | null;
  readonly grantedBy?: string | null;
  readonly grantedAt?: number | null;
}

export interface GrantedThemeResolution<T extends ThemeCatalogEntry = ThemeCatalogEntry> {
  readonly entry: T;
  readonly grantSource: "platform_included" | "tenant_grant";
  readonly grant: TenantThemeEntitlementRecord | null;
}

function isActiveMatchingGrant(
  tenantId: string,
  themeId: string,
  grant: TenantThemeEntitlementRecord,
): boolean {
  return (
    grant.tenantId === tenantId &&
    grant.themeId === themeId &&
    grant.active !== false &&
    (grant.revokedAt === undefined || grant.revokedAt === null)
  );
}

/**
 * Filters a catalog of registered themes to ONLY those available to `tenantId`:
 * - Active built-in platform themes (`tier === "included"` & in `PLATFORM_THEME_IDS`).
 * - Active custom/paid themes explicitly granted to THIS `tenantId` (non-revoked).
 *
 * Custom themes granted to OTHER tenants are NEVER returned.
 */
export function filterGrantedThemesForTenant<T extends ThemeCatalogEntry>(
  tenantId: string,
  catalog: readonly T[],
  grants: readonly TenantThemeEntitlementRecord[],
): readonly GrantedThemeResolution<T>[] {
  const normalizedTenantId = tenantId.trim();
  if (!normalizedTenantId) {
    return [];
  }

  const results: GrantedThemeResolution<T>[] = [];
  const seen = new Set<string>();

  for (const entry of catalog) {
    if (entry.active === false || seen.has(entry.id)) {
      continue;
    }

    if (entry.tier === "included" && PLATFORM_THEME_SET.has(entry.id)) {
      seen.add(entry.id);
      results.push({
        entry,
        grantSource: "platform_included",
        grant: null,
      });
      continue;
    }

    const matchingGrant = grants.find((g) => isActiveMatchingGrant(normalizedTenantId, entry.id, g));
    if (matchingGrant) {
      seen.add(entry.id);
      results.push({
        entry,
        grantSource: "tenant_grant",
        grant: matchingGrant,
      });
    }
  }

  return results;
}

/**
 * Strict grant assertion for theme preview/activation:
 * - Malformed or unregistered `themeId` -> throws `ThemeNotFoundError` (`404 THEME_NOT_FOUND`).
 * - Registered custom/paid theme not granted to THIS tenant -> throws `ThemeNotGrantedError` (`403 THEME_NOT_GRANTED`).
 * - Included platform theme or explicitly granted custom theme -> returns resolution.
 */
export function verifyThemeGrantForTenant<T extends ThemeCatalogEntry>(
  tenantId: string,
  requestedThemeId: unknown,
  catalog: readonly T[],
  grants: readonly TenantThemeEntitlementRecord[],
): GrantedThemeResolution<T> {
  const normalizedTenantId = tenantId.trim();
  const rawThemeId = typeof requestedThemeId === "string" ? requestedThemeId.trim() : "";

  if (!rawThemeId || !ThemeIdSchema.safeParse(rawThemeId).success) {
    throw new ThemeNotFoundError(rawThemeId || "(kosong)");
  }

  const entry = catalog.find((item) => item.id === rawThemeId && item.active !== false);
  if (!entry) {
    throw new ThemeNotFoundError(rawThemeId);
  }

  if (entry.tier === "included" && PLATFORM_THEME_SET.has(entry.id)) {
    return {
      entry,
      grantSource: "platform_included",
      grant: null,
    };
  }

  const matchingGrant = normalizedTenantId
    ? grants.find((g) => isActiveMatchingGrant(normalizedTenantId, entry.id, g))
    : undefined;

  if (!matchingGrant) {
    throw new ThemeNotGrantedError(entry.id);
  }

  return {
    entry,
    grantSource: "tenant_grant",
    grant: matchingGrant,
  };
}
