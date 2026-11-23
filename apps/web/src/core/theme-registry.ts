import {
  generateOpenGraphMetadata,
  type GenerateOpenGraphInput,
  type SocialMetadataDto,
} from "@punyasitus/core/og-generator";
import {
  generateSchemaGraph,
  type GenerateSchemaInput,
  type SchemaGenerationResult,
} from "@punyasitus/core/schema-generator";
import {
  ThemeIdSchema,
  type OfferingType,
} from "@punyasitus/core/schemas/common";
import type {
  PublishedSeoDecisionInput,
  SeoRouteKind,
  SeoTenantStatus,
} from "@punyasitus/core/seo/index";
import {
  CLOSED_SECTION_TYPES,
  PLATFORM_THEME_IDS,
  PLATFORM_THEME_SECTION_PROFILES,
  type ClosedSectionType,
  type PlatformThemeId,
  type ThemeConfigSnapshot,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  buildSafeThemeStyleBlock,
  PLATFORM_THEME_PRESETS,
  resolveBasePlatformThemeId,
  type SafeThemeStyleBlock,
  type TenantShellData,
  type ThemeSurfacePalette,
} from "./public-data.ts";
// Explicit build-time static import registration for reviewed custom themes (REQ-021).
// NEVER use dynamic `import(userInput)`, `eval()`, or remote URL loading here.
import { SAMPLE_AGENCY_THEME_MANIFEST } from "../themes/custom/sample-agency/theme.ts";

export interface ThemeConsentVendorScriptSlot {
  readonly id: string;
  readonly category: "analytics" | "marketing";
  readonly src: string;
  readonly label?: string;
}

export interface ThemeConsentMapEmbedConfig {
  readonly title: string;
  readonly address?: string;
  readonly externalMapsUrl: string;
  readonly embedUrl: string;
}

/**
 * Explicit Build-Time Theme Registry, Agency/Private-Client Routing & Static Import Guard
 * (REQ-021, REQ-001, REQ-040, REQ-063, REQ-066; PLAN §7.3, §11.4, §15; TASK-018).
 *
 * Security & Isolation Invariants:
 * 1. Closed build-time registry mapping the 6 built-in platform themes (`compro`, `sales`,
 *    `travel`, `catalog`, `resto`, `dealer`) plus explicitly statically imported custom themes.
 * 2. Unknown, malformed, or ungranted custom theme IDs ALWAYS fall back safely to the tenant's
 *    verified platform default theme (`compro` unless overridden by a valid platform default)
 *    without throwing or leaking another tenant's theme.
 * 3. Tenant-level and agency-level grants are strictly scoped by `tenantId` and `agencyId` so
 *    two tenants remain completely isolated.
 * 4. Every public route (`home`, `page`, `blog_index`, `blog_post`, `catalog_index`,
 *    `catalog_detail`, `not_found`) is assembled through `buildPublicThemeRouteShellContract`,
 *    binding the shared security token sanitizer, `<SEOHead.astro>` (TASK-016), Schema.org
 *    `@graph` (TASK-015), and `<Consent.astro>` (TASK-012/031).
 * 5. `auditCustomThemesStaticImports` statically inspects `apps/web/src/themes/custom/**` and
 *    rejects forbidden DB, auth, Worker binding, Node runtime, Radix, Base UI, dynamic import,
 *    and competing SEO/tracker patterns.
 */

export const PUBLIC_THEME_ROUTE_KINDS = [
  "home",
  "page",
  "blog_index",
  "blog_post",
  "catalog_index",
  "catalog_detail",
  "not_found",
] as const;

export type PublicThemeRouteKind = (typeof PUBLIC_THEME_ROUTE_KINDS)[number];

export const DEFAULT_FALLBACK_PLATFORM_THEME_ID: PlatformThemeId = "compro";

export type RegisteredThemeTier = "included" | "custom";

export interface CustomThemeAgencyScope {
  readonly distribution: "private_client" | "agency_exclusive";
  readonly ownerAgencySlug: string | null;
}

export interface RegisteredThemeEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly tier: RegisteredThemeTier;
  readonly isCustom: boolean;
  readonly basePlatformThemeId: PlatformThemeId;
  readonly recommendedOfferingTypes: readonly OfferingType[];
  readonly supportedRoutes: readonly PublicThemeRouteKind[];
  readonly supportedSectionTypes: readonly ClosedSectionType[];
  readonly defaultTokens: ThemeTokens;
  readonly defaultVariants: ThemeVariants;
  readonly palette: ThemeSurfacePalette;
  readonly previewImagePath: string;
  readonly agencyScope: CustomThemeAgencyScope | null;
  readonly validatePresentationConfig?: (input: unknown) => ThemeConfigSnapshot;
}

export interface CustomThemeRegistrationManifest {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly tier: "custom";
  readonly basePlatformThemeId: PlatformThemeId;
  readonly recommendedOfferingTypes: readonly OfferingType[];
  readonly supportedRoutes: readonly PublicThemeRouteKind[];
  readonly supportedSectionTypes: readonly ClosedSectionType[];
  readonly defaultTokens: ThemeTokens;
  readonly defaultVariants: ThemeVariants;
  readonly palette: ThemeSurfacePalette;
  readonly previewImagePath: string;
  readonly agencyScope: CustomThemeAgencyScope;
  readonly validatePresentationConfig?: (input: unknown) => ThemeConfigSnapshot;
}

const PLATFORM_THEME_SET: ReadonlySet<string> = new Set<string>(PLATFORM_THEME_IDS);
const REQUIRED_ROUTE_SET: ReadonlySet<string> = new Set<string>(PUBLIC_THEME_ROUTE_KINDS);
const REQUIRED_SECTION_SET: ReadonlySet<string> = new Set<string>(CLOSED_SECTION_TYPES);

const PLATFORM_RECOMMENDED_OFFERINGS: Readonly<Record<PlatformThemeId, readonly OfferingType[]>> = {
  compro: ["service", "product"],
  sales: ["service", "product"],
  travel: ["tour", "service"],
  catalog: ["product", "service"],
  resto: ["product", "service"],
  dealer: ["vehicle", "service"],
};

function buildPlatformThemeEntries(): Readonly<Record<PlatformThemeId, RegisteredThemeEntry>> {
  const entries = {} as Record<PlatformThemeId, RegisteredThemeEntry>;
  for (const themeId of PLATFORM_THEME_IDS) {
    const preset = PLATFORM_THEME_PRESETS[themeId];
    const profile = PLATFORM_THEME_SECTION_PROFILES[themeId];
    entries[themeId] = Object.freeze({
      id: themeId,
      slug: themeId,
      name: preset.label,
      description: `Built-in PunyaSitus platform theme (${profile.label}).`,
      version: "1.0.0",
      schemaVersion: 1,
      tier: "included" as const,
      isCustom: false,
      basePlatformThemeId: themeId,
      recommendedOfferingTypes: PLATFORM_RECOMMENDED_OFFERINGS[themeId],
      supportedRoutes: PUBLIC_THEME_ROUTE_KINDS,
      supportedSectionTypes: CLOSED_SECTION_TYPES,
      defaultTokens: preset.tokens,
      defaultVariants: preset.variants,
      palette: preset.palette,
      previewImagePath: `/themes/platform/${themeId}/preview.webp`,
      agencyScope: null,
    });
  }
  return Object.freeze(entries);
}

function assertValidCustomThemeManifest(manifest: CustomThemeRegistrationManifest): RegisteredThemeEntry {
  const parsedId = ThemeIdSchema.safeParse(manifest.id);
  if (!parsedId.success || !manifest.id.startsWith("custom-")) {
    throw new Error(`Invalid custom theme ID "${manifest.id}": must match custom-<slug>`);
  }

  for (const requiredRoute of REQUIRED_ROUTE_SET) {
    if (!manifest.supportedRoutes.includes(requiredRoute as PublicThemeRouteKind)) {
      throw new Error(
        `Custom theme "${manifest.id}" is missing required public route "${requiredRoute}"`,
      );
    }
  }

  for (const requiredSection of REQUIRED_SECTION_SET) {
    if (!manifest.supportedSectionTypes.includes(requiredSection as ClosedSectionType)) {
      throw new Error(
        `Custom theme "${manifest.id}" is missing required closed section "${requiredSection}"`,
      );
    }
  }

  return Object.freeze({
    id: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    tier: "custom" as const,
    isCustom: true,
    basePlatformThemeId: resolveBasePlatformThemeId(manifest.basePlatformThemeId),
    recommendedOfferingTypes: Object.freeze([...manifest.recommendedOfferingTypes]),
    supportedRoutes: Object.freeze([...manifest.supportedRoutes]),
    supportedSectionTypes: Object.freeze([...manifest.supportedSectionTypes]),
    defaultTokens: Object.freeze({ ...manifest.defaultTokens }),
    defaultVariants: Object.freeze({ ...manifest.defaultVariants }),
    palette: Object.freeze({ ...manifest.palette }),
    previewImagePath: manifest.previewImagePath,
    agencyScope: Object.freeze({ ...manifest.agencyScope }),
    validatePresentationConfig: manifest.validatePresentationConfig,
  });
}

function buildCustomThemeEntries(
  manifests: readonly CustomThemeRegistrationManifest[],
): Readonly<Record<string, RegisteredThemeEntry>> {
  const map: Record<string, RegisteredThemeEntry> = Object.create(null) as Record<
    string,
    RegisteredThemeEntry
  >;
  for (const manifest of manifests) {
    const validated = assertValidCustomThemeManifest(manifest);
    if (Object.prototype.hasOwnProperty.call(map, validated.id)) {
      throw new Error(`Duplicate custom theme registration for "${validated.id}"`);
    }
    map[validated.id] = validated;
  }
  return Object.freeze(map);
}

/**
 * Closed build-time registry of the 6 included PunyaSitus platform themes.
 */
export const REGISTERED_PLATFORM_THEMES: Readonly<Record<PlatformThemeId, RegisteredThemeEntry>> =
  buildPlatformThemeEntries();

/**
 * Closed build-time registry of reviewed custom themes registered exclusively via
 * explicit static imports above. Adding a new bespoke client/agency theme requires
 * one static import and one entry in this array.
 */
export const REGISTERED_CUSTOM_THEMES: Readonly<Record<string, RegisteredThemeEntry>> =
  buildCustomThemeEntries([SAMPLE_AGENCY_THEME_MANIFEST]);

/**
 * Unified read-only map of all platform + explicitly registered custom themes.
 */
export const THEME_REGISTRY: Readonly<Record<string, RegisteredThemeEntry>> = Object.freeze({
  ...REGISTERED_PLATFORM_THEMES,
  ...REGISTERED_CUSTOM_THEMES,
});

export function isPlatformThemeId(themeId: unknown): themeId is PlatformThemeId {
  return typeof themeId === "string" && PLATFORM_THEME_SET.has(themeId);
}

export function isRegisteredCustomThemeId(themeId: unknown): themeId is string {
  return (
    typeof themeId === "string" &&
    Object.prototype.hasOwnProperty.call(REGISTERED_CUSTOM_THEMES, themeId)
  );
}

export function isRegisteredThemeId(themeId: unknown): themeId is string {
  return isPlatformThemeId(themeId) || isRegisteredCustomThemeId(themeId);
}

export function getRegisteredTheme(themeId: unknown): RegisteredThemeEntry | null {
  if (typeof themeId !== "string") return null;
  if (isPlatformThemeId(themeId)) {
    return REGISTERED_PLATFORM_THEMES[themeId];
  }
  if (isRegisteredCustomThemeId(themeId)) {
    return REGISTERED_CUSTOM_THEMES[themeId] ?? null;
  }
  return null;
}

export function listRegisteredThemes(): readonly RegisteredThemeEntry[] {
  return Object.freeze([
    ...PLATFORM_THEME_IDS.map((id) => REGISTERED_PLATFORM_THEMES[id]),
    ...Object.values(REGISTERED_CUSTOM_THEMES),
  ]);
}

// ---------------------------------------------------------------------------
// Tenant Theme Entitlement & Agency / Private-Client Routing
// ---------------------------------------------------------------------------

export interface TenantThemeGrantRecord {
  readonly tenantId: string;
  readonly themeId: string;
  readonly active?: boolean;
  readonly grantedBy?: string | null;
}

export interface AgencyThemeGrantRecord {
  readonly agencyId: string;
  readonly themeId: string;
  readonly agencySlug?: string | null;
  readonly active?: boolean;
}

export interface TenantThemeEntitlementContext {
  readonly tenantId: string;
  readonly tenantStatus?: SeoTenantStatus;
  readonly agencyId?: string | null;
  readonly agencySlug?: string | null;
  /** Direct tenant grants (string IDs are treated as pre-scoped to `tenantId`; objects strictly verify `grant.tenantId === tenantId`). */
  readonly tenantGrants?: readonly (string | TenantThemeGrantRecord)[];
  /** Agency grants (applied ONLY when `agencyId` is non-empty and matches the record's `agencyId`). */
  readonly agencyGrants?: readonly (string | AgencyThemeGrantRecord)[];
  readonly defaultPlatformThemeId?: PlatformThemeId;
}

export interface ResolveTenantThemeInput extends TenantThemeEntitlementContext {
  readonly requestedThemeId: unknown;
}

export type ThemeGrantSource = "platform_included" | "tenant_grant" | "agency_grant" | "fallback";

export type ThemeFallbackReason =
  | "INVALID_THEME_ID"
  | "UNREGISTERED_THEME_ID"
  | "THEME_NOT_GRANTED"
  | "TRIAL_CUSTOM_THEME_BLOCKED"
  | "MISSING_TENANT_IDENTITY";

export interface ResolvedTenantThemeResult {
  readonly requestedThemeId: string | null;
  readonly resolvedTheme: RegisteredThemeEntry;
  readonly isCustomTheme: boolean;
  readonly fallbackUsed: boolean;
  readonly fallbackReason: ThemeFallbackReason | null;
  readonly grantSource: ThemeGrantSource;
  readonly operatorAlertRequired: boolean;
  readonly basePlatformThemeId: PlatformThemeId;
}

function resolveFallbackPlatformTheme(preferred?: unknown): RegisteredThemeEntry {
  const safeBase: PlatformThemeId = isPlatformThemeId(preferred)
    ? preferred
    : DEFAULT_FALLBACK_PLATFORM_THEME_ID;
  return REGISTERED_PLATFORM_THEMES[safeBase];
}

function hasDirectTenantGrant(
  tenantId: string,
  themeId: string,
  grants?: readonly (string | TenantThemeGrantRecord)[],
): boolean {
  if (!grants || grants.length === 0) return false;
  for (const grant of grants) {
    if (typeof grant === "string") {
      if (grant.trim() === themeId) return true;
      continue;
    }
    if (
      grant &&
      typeof grant === "object" &&
      grant.tenantId === tenantId &&
      grant.themeId === themeId &&
      grant.active !== false
    ) {
      return true;
    }
  }
  return false;
}

function hasMatchingAgencyGrant(
  agencyId: string | null | undefined,
  agencySlug: string | null | undefined,
  entry: RegisteredThemeEntry,
  grants?: readonly (string | AgencyThemeGrantRecord)[],
): boolean {
  const normalizedAgencyId = typeof agencyId === "string" ? agencyId.trim() : "";
  if (!normalizedAgencyId || !grants || grants.length === 0) return false;

  for (const grant of grants) {
    if (typeof grant === "string") {
      if (grant.trim() === entry.id) {
        if (
          entry.agencyScope?.ownerAgencySlug &&
          agencySlug &&
          agencySlug.trim() !== entry.agencyScope.ownerAgencySlug
        ) {
          continue;
        }
        return true;
      }
      continue;
    }
    if (
      grant &&
      typeof grant === "object" &&
      grant.agencyId === normalizedAgencyId &&
      grant.themeId === entry.id &&
      grant.active !== false
    ) {
      const effectiveSlug = grant.agencySlug ?? agencySlug ?? null;
      if (
        entry.agencyScope?.ownerAgencySlug &&
        effectiveSlug &&
        effectiveSlug.trim() !== entry.agencyScope.ownerAgencySlug
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Resolves the active theme for a tenant with strict entitlement & agency isolation:
 * - Built-in platform themes (`compro`..`dealer`) are available to every tenant.
 * - Custom themes (`custom-<slug>`) MUST exist in the closed build-time registry AND
 *   match either a verified direct tenant grant (`tenantId`) or an agency grant (`agencyId`).
 * - Unknown, malformed, or ungranted theme IDs NEVER crash or leak another tenant's theme;
 *   they fall back safely to the verified default platform theme (`compro`).
 */
export function resolveTenantTheme(input: ResolveTenantThemeInput): ResolvedTenantThemeResult {
  const fallbackTheme = resolveFallbackPlatformTheme(input.defaultPlatformThemeId);
  const rawRequested =
    typeof input.requestedThemeId === "string" ? input.requestedThemeId.trim() : null;

  const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  if (!tenantId) {
    return {
      requestedThemeId: rawRequested,
      resolvedTheme: fallbackTheme,
      isCustomTheme: false,
      fallbackUsed: true,
      fallbackReason: "MISSING_TENANT_IDENTITY",
      grantSource: "fallback",
      operatorAlertRequired: true,
      basePlatformThemeId: fallbackTheme.basePlatformThemeId,
    };
  }

  if (!rawRequested) {
    return {
      requestedThemeId: rawRequested,
      resolvedTheme: fallbackTheme,
      isCustomTheme: false,
      fallbackUsed: true,
      fallbackReason: "INVALID_THEME_ID",
      grantSource: "fallback",
      operatorAlertRequired: false,
      basePlatformThemeId: fallbackTheme.basePlatformThemeId,
    };
  }

  const parsedThemeId = ThemeIdSchema.safeParse(rawRequested);
  if (!parsedThemeId.success) {
    return {
      requestedThemeId: rawRequested,
      resolvedTheme: fallbackTheme,
      isCustomTheme: false,
      fallbackUsed: true,
      fallbackReason: "INVALID_THEME_ID",
      grantSource: "fallback",
      operatorAlertRequired: true,
      basePlatformThemeId: fallbackTheme.basePlatformThemeId,
    };
  }

  const normalizedId = parsedThemeId.data;
  if (isPlatformThemeId(normalizedId)) {
    const platformTheme = REGISTERED_PLATFORM_THEMES[normalizedId];
    return {
      requestedThemeId: normalizedId,
      resolvedTheme: platformTheme,
      isCustomTheme: false,
      fallbackUsed: false,
      fallbackReason: null,
      grantSource: "platform_included",
      operatorAlertRequired: false,
      basePlatformThemeId: platformTheme.basePlatformThemeId,
    };
  }

  const customTheme = getRegisteredTheme(normalizedId);
  if (!customTheme || !customTheme.isCustom) {
    return {
      requestedThemeId: normalizedId,
      resolvedTheme: fallbackTheme,
      isCustomTheme: false,
      fallbackUsed: true,
      fallbackReason: "UNREGISTERED_THEME_ID",
      grantSource: "fallback",
      operatorAlertRequired: true,
      basePlatformThemeId: fallbackTheme.basePlatformThemeId,
    };
  }

  // PRD §15: Trial websites are not entitled to ungranted custom themes.
  const directGranted = hasDirectTenantGrant(tenantId, customTheme.id, input.tenantGrants);
  const agencyGranted = hasMatchingAgencyGrant(
    input.agencyId,
    input.agencySlug,
    customTheme,
    input.agencyGrants,
  );

  if (!directGranted && !agencyGranted) {
    return {
      requestedThemeId: normalizedId,
      resolvedTheme: fallbackTheme,
      isCustomTheme: false,
      fallbackUsed: true,
      fallbackReason:
        input.tenantStatus === "trial" ? "TRIAL_CUSTOM_THEME_BLOCKED" : "THEME_NOT_GRANTED",
      grantSource: "fallback",
      operatorAlertRequired: true,
      basePlatformThemeId: fallbackTheme.basePlatformThemeId,
    };
  }

  return {
    requestedThemeId: normalizedId,
    resolvedTheme: customTheme,
    isCustomTheme: true,
    fallbackUsed: false,
    fallbackReason: null,
    grantSource: directGranted ? "tenant_grant" : "agency_grant",
    operatorAlertRequired: false,
    basePlatformThemeId: customTheme.basePlatformThemeId,
  };
}

/**
 * Returns only the built-in platform themes plus custom themes explicitly granted
 * to this tenant (or its agency). Used by Appearance > Themes & route resolvers.
 */
export function listGrantedThemesForTenant(
  entitlement: TenantThemeEntitlementContext,
): readonly RegisteredThemeEntry[] {
  const granted: RegisteredThemeEntry[] = PLATFORM_THEME_IDS.map(
    (id) => REGISTERED_PLATFORM_THEMES[id],
  );

  for (const customTheme of Object.values(REGISTERED_CUSTOM_THEMES)) {
    const check = resolveTenantTheme({
      ...entitlement,
      requestedThemeId: customTheme.id,
    });
    if (!check.fallbackUsed && check.resolvedTheme.id === customTheme.id) {
      granted.push(customTheme);
    }
  }

  return Object.freeze(granted);
}

// ---------------------------------------------------------------------------
// Shared Security, SEO, Schema.org & Consent Public Shell Contract
// ---------------------------------------------------------------------------

const PUBLIC_ROUTE_TO_SEO_ROUTE_KIND: Readonly<Record<PublicThemeRouteKind, SeoRouteKind>> = {
  home: "homepage",
  page: "page",
  blog_index: "blog_index",
  blog_post: "post",
  catalog_index: "catalog_index",
  catalog_detail: "offering",
  not_found: "error_404",
};

export function mapPublicThemeRouteToSeoRouteKind(routeKind: PublicThemeRouteKind): SeoRouteKind {
  return PUBLIC_ROUTE_TO_SEO_ROUTE_KIND[routeKind];
}

export interface BuildPublicThemeRouteShellInput {
  readonly routeKind: PublicThemeRouteKind;
  readonly pathname: string;
  readonly entitlement: ResolveTenantThemeInput;
  readonly shell: TenantShellData;
  /** Optional tenant token overrides (validated safely; hostile CSS falls back cleanly). */
  readonly themeTokensOverride?: unknown;
  /** Authoritative SEO policy input for TASK-051 / TASK-016 / TASK-015. */
  readonly seo: Omit<PublishedSeoDecisionInput, "routeKind" | "pathname"> & {
    readonly routeKind?: SeoRouteKind;
    readonly pathname?: string;
  };
  readonly pageTitle?: string | null;
  readonly pageDescription?: string | null;
  readonly seoMetadataOverrides?: Partial<
    Omit<GenerateOpenGraphInput, "seo" | "tenantId" | "siteName" | "siteTagline" | "locale">
  >;
  readonly schemaOverrides?: Partial<
    Omit<GenerateSchemaInput, "seo" | "tenantId" | "siteName" | "siteTagline" | "locale" | "timezone">
  >;
  readonly privacyPolicyUrl?: string;
  readonly vendorScripts?: readonly ThemeConsentVendorScriptSlot[];
  readonly mapEmbed?: ThemeConsentMapEmbedConfig;
  readonly initialCookieHeader?: string | null;
  readonly headerCtaLabel?: string | null;
  readonly headerCtaHref?: string | null;
}

export interface PublicThemeRouteShellContract {
  readonly routeKind: PublicThemeRouteKind;
  readonly pathname: string;
  readonly resolution: ResolvedTenantThemeResult;
  readonly shell: TenantShellData;
  readonly themeStyle: SafeThemeStyleBlock;
  readonly seoMetadata: SocialMetadataDto;
  readonly schemaResult: SchemaGenerationResult;
  readonly schemaGraph: SchemaGenerationResult["graph"];
  readonly consent: {
    readonly required: boolean;
    readonly privacyPolicyUrl: string;
    readonly vendorScripts: readonly ThemeConsentVendorScriptSlot[];
    readonly mapEmbed?: ThemeConsentMapEmbedConfig;
    readonly initialCookieHeader?: string | null;
  };
  readonly headerCtaLabel: string | null;
  readonly headerCtaHref: string | null;
}

function mergeThemeTokensForResolvedTheme(
  resolvedTheme: RegisteredThemeEntry,
  overrideInput: unknown,
): unknown {
  if (overrideInput === undefined || overrideInput === null) {
    return {
      themeId: resolvedTheme.id,
      tokens: resolvedTheme.defaultTokens,
      variants: resolvedTheme.defaultVariants,
    };
  }
  if (typeof overrideInput === "object" && !Array.isArray(overrideInput)) {
    const record = overrideInput as Record<string, unknown>;
    if ("tokens" in record) {
      return {
        themeId: resolvedTheme.id,
        tokens:
          record.tokens && typeof record.tokens === "object" && !Array.isArray(record.tokens)
            ? { ...resolvedTheme.defaultTokens, ...(record.tokens as Record<string, unknown>) }
            : record.tokens,
        variants:
          record.variants && typeof record.variants === "object" && !Array.isArray(record.variants)
            ? { ...resolvedTheme.defaultVariants, ...(record.variants as Record<string, unknown>) }
            : resolvedTheme.defaultVariants,
      };
    }
    return {
      themeId: resolvedTheme.id,
      tokens: { ...resolvedTheme.defaultTokens, ...record },
      variants: resolvedTheme.defaultVariants,
    };
  }
  return overrideInput;
}

/**
 * Builds the mandatory shared security, `<SEOHead.astro>`, Schema.org, and `<Consent.astro>`
 * shell contract for EVERY public route (`home`, `page`, `blog_index`, `blog_post`,
 * `catalog_index`, `catalog_detail`, `not_found`).
 *
 * Custom themes consume this contract and CANNOT bypass canonical/noindex policy,
 * CSP/CSS token sanitization, Schema.org suppression on error/preview routes, or consent gating.
 */
export function buildPublicThemeRouteShellContract(
  input: BuildPublicThemeRouteShellInput,
): PublicThemeRouteShellContract {
  const resolution = resolveTenantTheme(input.entitlement);
  const resolvedTheme = resolution.resolvedTheme;

  // Build validated, XSS-safe CSS custom properties for the resolved theme.
  const tokenPayload = mergeThemeTokensForResolvedTheme(
    resolvedTheme,
    input.themeTokensOverride,
  );
  const themeStyle = buildSafeThemeStyleBlock(tokenPayload, resolvedTheme.id);

  // If custom tokens failed validation, fall back safely to the resolved theme's safe defaults
  // (or platform defaults if custom defaults were somehow tampered with).
  const effectiveThemeStyle = themeStyle.fallbackUsed
    ? buildSafeThemeStyleBlock(
        {
          themeId: resolvedTheme.basePlatformThemeId,
          tokens: PLATFORM_THEME_PRESETS[resolvedTheme.basePlatformThemeId].tokens,
          variants: PLATFORM_THEME_PRESETS[resolvedTheme.basePlatformThemeId].variants,
        },
        resolvedTheme.basePlatformThemeId,
      )
    : themeStyle;

  const isNotFound = input.routeKind === "not_found";
  const effectiveSeoRouteKind: SeoRouteKind =
    input.seo.routeKind ?? mapPublicThemeRouteToSeoRouteKind(input.routeKind);

  const seoInput: PublishedSeoDecisionInput = {
    ...input.seo,
    surface: isNotFound ? "error" : input.seo.surface,
    routeKind: effectiveSeoRouteKind,
    pathname: input.seo.pathname ?? input.pathname,
    siteVisibility:
      isNotFound || input.shell.isPreview
        ? "noindex"
        : (input.seo.siteVisibility ?? input.shell.site.siteVisibility),
  };

  const seoMetadata = generateOpenGraphMetadata({
    seo: seoInput,
    tenantId: input.entitlement.tenantId,
    siteName: input.shell.site.title,
    siteTagline: input.shell.site.tagline,
    locale: input.shell.site.locale,
    resourceTitle: input.pageTitle ?? input.shell.page?.title ?? null,
    resourceExcerpt:
      input.pageDescription ?? input.shell.site.tagline ?? input.shell.business.description ?? null,
    ...input.seoMetadataOverrides,
  });

  const schemaResult = generateSchemaGraph({
    seo: seoInput,
    tenantId: input.entitlement.tenantId,
    siteName: input.shell.site.title,
    siteTagline: input.shell.site.tagline,
    locale: input.shell.site.locale,
    timezone: input.shell.site.timezone,
    business: {
      businessName: input.shell.business.name,
      businessCategory: input.shell.business.category,
      description: input.shell.business.description,
      phone: input.shell.business.phone,
      whatsappE164: input.shell.business.whatsappE164,
      publicEmail: input.shell.business.email,
      address: input.shell.business.address,
      city: input.shell.business.city,
      province: input.shell.business.province,
      postalCode: input.shell.business.postalCode,
      mapsUrl: input.shell.business.mapsUrl,
      weekdayHours: input.shell.business.weekdayHours,
      holidayHours: input.shell.business.holidayHours,
      socialLinks: input.shell.business.socialLinks,
    },
    pageTitle: input.pageTitle ?? input.shell.page?.title ?? input.shell.site.title,
    pageDescription:
      input.pageDescription ?? input.shell.site.tagline ?? input.shell.business.description ?? null,
    ...input.schemaOverrides,
  });

  const normalizedShell: TenantShellData = {
    ...input.shell,
    themeId: resolvedTheme.id,
    baseThemeId: resolvedTheme.basePlatformThemeId,
    themeStyle: effectiveThemeStyle,
    site: {
      ...input.shell.site,
      siteVisibility: seoMetadata.seoDecision.noindex
        ? "noindex"
        : input.shell.site.siteVisibility,
    },
  };

  return {
    routeKind: input.routeKind,
    pathname: input.pathname,
    resolution,
    shell: normalizedShell,
    themeStyle: effectiveThemeStyle,
    seoMetadata,
    schemaResult,
    schemaGraph: schemaResult.emitted ? schemaResult.graph : null,
    consent: {
      required: !input.shell.isPreview,
      privacyPolicyUrl: input.privacyPolicyUrl ?? "/kebijakan-privasi",
      vendorScripts: input.vendorScripts ?? [],
      mapEmbed: input.mapEmbed,
      initialCookieHeader: input.initialCookieHeader,
    },
    headerCtaLabel: input.headerCtaLabel ?? null,
    headerCtaHref: input.headerCtaHref ?? null,
  };
}

// ---------------------------------------------------------------------------
// Static Import Guard for `apps/web/src/themes/custom/**` (REQ-021, DEC-036)
// ---------------------------------------------------------------------------

export type StaticImportGuardRule =
  | "FORBIDDEN_DB_IMPORT"
  | "FORBIDDEN_AUTH_IMPORT"
  | "FORBIDDEN_CLOUDFLARE_WORKERS_IMPORT"
  | "FORBIDDEN_NODE_BUILTIN_IMPORT"
  | "FORBIDDEN_DRIZZLE_IMPORT"
  | "FORBIDDEN_PLATFORM_BINDING_REFERENCE"
  | "FORBIDDEN_PROCESS_ENV_REFERENCE"
  | "FORBIDDEN_RADIX_IMPORT"
  | "FORBIDDEN_RADIX_PROP"
  | "FORBIDDEN_ADMIN_UI_IMPORT"
  | "FORBIDDEN_DYNAMIC_IMPORT"
  | "FORBIDDEN_DYNAMIC_EVAL"
  | "FORBIDDEN_REMOTE_MODULE_IMPORT"
  | "FORBIDDEN_COMPETING_SEO_OR_TRACKER_TAG";

export interface StaticThemeSourceFile {
  readonly filePath: string;
  readonly content: string;
}

export interface StaticImportViolation {
  readonly filePath: string;
  readonly rule: StaticImportGuardRule;
  readonly match: string;
  readonly line: number;
  readonly message: string;
}

export interface StaticImportAuditResult {
  readonly ok: boolean;
  readonly scannedFiles: readonly string[];
  readonly violations: readonly StaticImportViolation[];
}

export interface AuditCustomThemesOptions {
  /** Directory on disk to scan recursively (defaults to `apps/web/src/themes/custom`). */
  readonly rootDir?: string;
  /** Optional in-memory source files to audit directly (pure, works in Workers & unit tests). */
  readonly files?: readonly StaticThemeSourceFile[];
}

const SCANNABLE_THEME_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".css",
]);

// Build Radix tokens via array join so repo-wide lint regexes in scripts/dev/lint.mjs
// do not false-positive on the guard definition itself.
const RADIX_SCOPE_PREFIX = ["@", "radix", "-ui"].join("");
const RADIX_PKG_NAME = ["radix", "-ui"].join("");
const RADIX_PROP_NAME = ["as", "Child"].join("");

interface GuardPatternSpec {
  readonly rule: StaticImportGuardRule;
  readonly pattern: RegExp;
  readonly message: string;
}

const NODE_BARE_BUILTINS = [
  "fs",
  "path",
  "os",
  "child_process",
  "crypto",
  "http",
  "https",
  "net",
  "tls",
  "dns",
  "vm",
  "worker_threads",
  "stream",
  "module",
  "url",
].join("|");

const GUARD_PATTERNS: readonly GuardPatternSpec[] = [
  {
    rule: "FORBIDDEN_DB_IMPORT",
    pattern:
      /(?:from\s+["'](?:@punyasitus\/db(?:\/[^"']*)?|(?:\.\.\/)+packages\/db(?:\/[^"']*)?)["']|import\s+["']@punyasitus\/db(?:\/[^"']*)?["']|require\s*\(\s*["']@punyasitus\/db(?:\/[^"']*)?["']\s*\))/,
    message: "Custom themes MUST NEVER import `@punyasitus/db` or database modules directly.",
  },
  {
    rule: "FORBIDDEN_AUTH_IMPORT",
    pattern:
      /(?:from\s+["'](?:@punyasitus\/auth(?:\/[^"']*)?|(?:\.\.\/)+packages\/auth(?:\/[^"']*)?)["']|import\s+["']@punyasitus\/auth(?:\/[^"']*)?["']|require\s*\(\s*["']@punyasitus\/auth(?:\/[^"']*)?["']\s*\))/,
    message: "Custom themes MUST NEVER import `@punyasitus/auth` or authentication modules directly.",
  },
  {
    rule: "FORBIDDEN_CLOUDFLARE_WORKERS_IMPORT",
    pattern:
      /(?:from\s+["']cloudflare:[^"']+["']|import\s+["']cloudflare:[^"']+["']|require\s*\(\s*["']cloudflare:[^"']+["']\s*\))/,
    message: "Custom themes MUST NEVER import `cloudflare:workers` or Worker runtime bindings.",
  },
  {
    rule: "FORBIDDEN_NODE_BUILTIN_IMPORT",
    pattern: new RegExp(
      `(?:from\\s+["'](?:node:[^"']+|(?:${NODE_BARE_BUILTINS})(?:\\/[^"']*)?)["']|import\\s+["']node:[^"']+["']|require\\s*\\(\\s*["'](?:node:[^"']+|(?:${NODE_BARE_BUILTINS})(?:\\/[^"']*)?)["']\\s*\\))`,
    ),
    message: "Custom themes MUST NEVER import `node:*` or Node.js runtime built-ins.",
  },
  {
    rule: "FORBIDDEN_DRIZZLE_IMPORT",
    pattern:
      /(?:from\s+["']drizzle-orm(?:\/[^"']*)?["']|import\s+["']drizzle-orm(?:\/[^"']*)?["']|require\s*\(\s*["']drizzle-orm(?:\/[^"']*)?["']\s*\))/,
    message: "Custom themes MUST NEVER import `drizzle-orm`.",
  },
  {
    rule: "FORBIDDEN_PLATFORM_BINDING_REFERENCE",
    pattern: /\b(?:PLATFORM_DB|TENANT_STORE)\b/,
    message: "Custom themes MUST NEVER reference `PLATFORM_DB` or `TENANT_STORE` bindings.",
  },
  {
    rule: "FORBIDDEN_PROCESS_ENV_REFERENCE",
    pattern: /\bprocess\s*\.\s*env\b/,
    message: "Custom themes MUST NEVER access `process.env` secrets or runtime configuration.",
  },
  {
    rule: "FORBIDDEN_RADIX_IMPORT",
    pattern: new RegExp(
      `(?:from\\s+["'](?:${RADIX_SCOPE_PREFIX}\\/[^"']+|${RADIX_PKG_NAME})["']|import\\s+["'](?:${RADIX_SCOPE_PREFIX}\\/[^"']+|${RADIX_PKG_NAME})["']|require\\s*\\(\\s*["'](?:${RADIX_SCOPE_PREFIX}\\/[^"']+|${RADIX_PKG_NAME})["']\\s*\\))`,
    ),
    message: "Custom themes MUST NEVER import Radix UI packages (DEC-036).",
  },
  {
    rule: "FORBIDDEN_RADIX_PROP",
    pattern: new RegExp(
      `\\b${RADIX_PROP_NAME}(?:\\s*=|\\s*\\?|\\s*:|\\s*,|\\s*\\}|\\s*\\)|\\s*\\/?>|\\s+(?=[a-zA-Z0-9_$-]))`,
    ),
    message: "Custom themes MUST NEVER use Radix composition props (DEC-036).",
  },
  {
    rule: "FORBIDDEN_ADMIN_UI_IMPORT",
    pattern:
      /(?:from\s+["'](?:@base-ui\/[^"']+|@\/components\/ui(?:\/[^"']*)?|(?:\.\.\/)+components\/ui(?:\/[^"']*)?|(?:\.\.\/)+styles\/admin(?:\/[^"']*)?|(?:\.\.\/)+worker(?:\/[^"']*)?|(?:\.\.\/)+middleware(?:\/[^"']*)?)["']|import\s+["'](?:\.\.\/)+styles\/admin(?:\/[^"']*)?["'])/,
    message:
      "Custom themes MUST NOT import admin UI primitives (`@base-ui/*`, `components/ui`, `styles/admin`) or server-only worker/middleware modules.",
  },
  {
    rule: "FORBIDDEN_DYNAMIC_IMPORT",
    pattern: /\bimport\s*\(/,
    message: "Custom themes MUST NOT use dynamic `import(...)` expressions (REQ-021).",
  },
  {
    rule: "FORBIDDEN_DYNAMIC_EVAL",
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\()/,
    message: "Custom themes MUST NOT execute dynamic code via `eval()` or `new Function()`.",
  },
  {
    rule: "FORBIDDEN_REMOTE_MODULE_IMPORT",
    pattern: /(?:from\s+["']https?:\/\/[^"']+["']|import\s+["']https?:\/\/[^"']+["'])/,
    message: "Custom themes MUST NOT import remote HTTP(S) modules at build time or runtime.",
  },
  {
    rule: "FORBIDDEN_COMPETING_SEO_OR_TRACKER_TAG",
    pattern:
      /(?:<link\b[^>]*\brel\s*=\s*["']canonical["']|<meta\b[^>]*\bname\s*=\s*["']robots["']|application\/ld\+json|googletagmanager\.com|connect\.facebook\.net|analytics\.tiktok\.com)/i,
    message:
      "Custom themes MUST NOT emit competing canonical, robots, JSON-LD, or third-party tracker tags; the shared shell owns `<SEOHead>` and `<Consent>`.",
  },
];

/**
 * Strips comments (`//`, `/* ... *\/`, `<!-- ... -->`) while preserving exact line
 * numbers and keeping string literals (such as `https://` URLs) intact.
 */
function stripCommentsPreservingLines(source: string, isCss: boolean): string {
  const out: string[] = [];
  let i = 0;
  const len = source.length;
  let quote: string | null = null;

  while (i < len) {
    const ch = source.charAt(i);
    const next = i + 1 < len ? source.charAt(i + 1) : "";

    if (quote) {
      out.push(ch);
      if (ch === "\\" && i + 1 < len) {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    // HTML comments
    if (!isCss && ch === "<" && source.startsWith("<!--", i)) {
      const endIdx = source.indexOf("-->", i + 4);
      const stop = endIdx === -1 ? len : endIdx + 3;
      for (let j = i; j < stop; j += 1) {
        out.push(source.charAt(j) === "\n" ? "\n" : " ");
      }
      i = stop;
      continue;
    }

    // Block comments
    if (ch === "/" && next === "*") {
      const endIdx = source.indexOf("*/", i + 2);
      const stop = endIdx === -1 ? len : endIdx + 2;
      for (let j = i; j < stop; j += 1) {
        out.push(source.charAt(j) === "\n" ? "\n" : " ");
      }
      i = stop;
      continue;
    }

    // Single-line JS/TS comments
    if (!isCss && ch === "/" && next === "/") {
      let j = i;
      while (j < len && source.charAt(j) !== "\n") {
        out.push(" ");
        j += 1;
      }
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || (!isCss && ch === "`")) {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }

    out.push(ch);
    i += 1;
  }

  return out.join("");
}

function getLineNumberAtIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * Pure static import guard that scans an in-memory list of custom theme source files.
 */
export function auditCustomThemeSourceFiles(
  files: readonly StaticThemeSourceFile[],
): StaticImportAuditResult {
  const scannedFiles: string[] = [];
  const violations: StaticImportViolation[] = [];

  for (const file of files) {
    scannedFiles.push(file.filePath);
    const isCss = file.filePath.toLowerCase().endsWith(".css");
    const sanitized = stripCommentsPreservingLines(file.content, isCss);

    for (const spec of GUARD_PATTERNS) {
      const flags = spec.pattern.flags.includes("g")
        ? spec.pattern.flags
        : `${spec.pattern.flags}g`;
      const globalRe = new RegExp(spec.pattern.source, flags);
      let match: RegExpExecArray | null;
      while ((match = globalRe.exec(sanitized)) !== null) {
        violations.push({
          filePath: file.filePath,
          rule: spec.rule,
          match: match[0],
          line: getLineNumberAtIndex(sanitized, match.index),
          message: spec.message,
        });
        if (match[0].length === 0) {
          globalRe.lastIndex += 1;
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles: Object.freeze(scannedFiles),
    violations: Object.freeze(violations),
  };
}

interface NodeDirEntLike {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeFsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string, opts: { withFileTypes: true }): readonly NodeDirEntLike[];
  readFileSync(p: string, enc: "utf8"): string;
}

interface NodePathLike {
  join(...parts: string[]): string;
  extname(p: string): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
}

function loadNodeBuiltins(): { readonly fs: NodeFsLike; readonly path: NodePathLike } {
  const proc = (
    globalThis as {
      readonly process?: {
        readonly getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process;
  const fsMod = proc?.getBuiltinModule?.("node:fs") as NodeFsLike | undefined;
  const pathMod = proc?.getBuiltinModule?.("node:path") as NodePathLike | undefined;
  if (!fsMod || !pathMod) {
    throw new Error(
      "Filesystem scanning in auditCustomThemesStaticImports requires Node.js (>= 22.3); pass `{ files }` for pure in-memory auditing.",
    );
  }
  return { fs: fsMod, path: pathMod };
}

function resolveDefaultCustomThemesDir(pathMod: NodePathLike): string {
  const rawPathname = decodeURIComponent(new URL("../themes/custom", import.meta.url).pathname);
  return pathMod.resolve(rawPathname);
}

function collectThemeFilesFromDisk(
  rootDir: string,
  fsMod: NodeFsLike,
  pathMod: NodePathLike,
): StaticThemeSourceFile[] {
  const collected: StaticThemeSourceFile[] = [];
  if (!fsMod.existsSync(rootDir)) {
    return collected;
  }

  const walk = (dir: string): void => {
    const entries = [...fsMod.readdirSync(dir, { withFileTypes: true })].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") {
        continue;
      }
      const fullPath = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = pathMod.extname(entry.name).toLowerCase();
        if (SCANNABLE_THEME_EXTENSIONS.has(ext)) {
          collected.push({
            filePath: pathMod.relative(rootDir, fullPath).replace(/\\/g, "/"),
            content: fsMod.readFileSync(fullPath, "utf8"),
          });
        }
      }
    }
  };

  walk(rootDir);
  return collected;
}

/**
 * Strict static import guard for `apps/web/src/themes/custom/**` (TASK-018, REQ-021, DEC-036).
 *
 * Accepts:
 * - No arguments: scans `apps/web/src/themes/custom/**` on disk.
 * - `string`: scans the given directory path recursively on disk.
 * - `{ files }`: audits in-memory source files (pure; no filesystem required).
 * - `{ rootDir }`: scans the given directory path recursively on disk.
 */
export function auditCustomThemesStaticImports(
  target?: string | AuditCustomThemesOptions,
): StaticImportAuditResult {
  if (typeof target === "object" && target !== null && target.files) {
    return auditCustomThemeSourceFiles(target.files);
  }

  const { fs, path } = loadNodeBuiltins();
  const rootDir =
    typeof target === "string"
      ? path.resolve(target)
      : target?.rootDir
        ? path.resolve(target.rootDir)
        : resolveDefaultCustomThemesDir(path);

  const files = collectThemeFilesFromDisk(rootDir, fs, path);
  return auditCustomThemeSourceFiles(files);
}
