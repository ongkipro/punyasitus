import {
  buildOgImageCandidateFromMediaRecord,
  generateOpenGraphMetadata,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_MAX_BYTES,
  OG_IMAGE_WIDTH,
  renderSeoHeadHtml,
  type GenerateOpenGraphInput,
  type MediaRecordLikeForOg,
  type OgImageCandidate,
  type SocialMetadataDto,
} from "@punyasitus/core/og-generator";
import {
  B2B_VERTICAL_BLUEPRINTS,
  getB2BBlueprint,
  type B2BBlueprintId,
} from "@punyasitus/core/presets/blueprints";
import {
  generateSchemaGraph,
  type GenerateSchemaInput,
  type SchemaGenerationResult,
} from "@punyasitus/core/schema-generator";
import type { OfferingType } from "@punyasitus/core/schemas/common";
import {
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  renderSearchAppearanceTemplate,
  renderVerificationMetaTags,
  type SearchAppearanceKind,
  type SearchAppearanceSettings,
  type VerificationTokensConfig,
} from "@punyasitus/core/seo/editor";
import {
  escapeHtmlAttribute,
  escapeHtmlText,
  INDEXABLE_ROBOTS_DIRECTIVES,
  sanitizeSeoDescription,
  sanitizeSeoText,
  validateCanonicalOrigin,
  type SeoRouteKind,
} from "@punyasitus/core/seo/index";

/**
 * Zero-Config SEO & AI Autopilot Core Engine
 * (`packages/plugins/seo-ai-autopilot/src/autopilot.ts`; REQ-102, DEC-039, DEC-042, PLAN §15.1 & §15.7).
 *
 * Pure, runtime-neutral (zero React / DOM / admin-CSS deps) so it can be imported safely
 * from `<SEOHead.astro>`, Cloudflare Worker routes, unit tests, and workerd integration tests.
 */

export const SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION = true as const;
export const SEO_AI_AUTOPILOT_TIER = "public_free" as const;

export const SEO_AI_AUTOPILOT_CAPABILITIES = [
  "programmatic_blueprint_meta",
  "whatsapp_safe_og_under_300kib",
  "schema_org_graph",
  "xml_sitemap_and_image_sitemap",
  "ai_split_robots_txt",
  "indexnow_custom_domain",
  "blog_rss_feed",
  "gbp_and_bing_places_copy_card",
  "collapsed_optional_manual_overrides",
] as const;

export type SeoAutopilotCapability = (typeof SEO_AI_AUTOPILOT_CAPABILITIES)[number];

export interface BlueprintMetaProfileInput {
  readonly siteName: string;
  readonly businessName?: string | null;
  readonly tagline?: string | null;
  readonly city?: string | null;
  readonly primaryService?: string | null;
  readonly blueprintId?: B2BBlueprintId | string | null;
  readonly vertical?: string | null;
}

export interface GenerateAutopilotBlueprintMetaInput {
  readonly routeKind: SeoRouteKind;
  readonly profile: BlueprintMetaProfileInput;
  readonly title?: string | null;
  readonly excerpt?: string | null;
  readonly category?: string | null;
  readonly offeringType?: OfferingType | null;
  readonly pageNumber?: number | null;
  readonly titleOverride?: string | null;
  readonly descriptionOverride?: string | null;
  readonly searchAppearance?: SearchAppearanceSettings | null;
}

export interface AutopilotBlueprintMetaResult {
  readonly title: string;
  readonly description: string;
  readonly blueprintId: B2BBlueprintId | null;
  readonly titleSource: "manual_override" | "search_appearance_template" | "blueprint_autopilot";
  readonly descriptionSource:
    | "manual_override"
    | "search_appearance_template"
    | "content_excerpt"
    | "blueprint_autopilot";
  readonly zeroConfigDerived: boolean;
}

const VERTICAL_TO_BLUEPRINT_FALLBACK: Readonly<Record<string, B2BBlueprintId>> = {
  compro: "b2b_corporate",
  sales: "sales_executive",
  travel: "travel_umrah_agency",
  catalog: "wa_catalog_showcase",
  resto: "offline_multibranch",
  dealer: "sales_executive",
};

const OFFERING_TYPE_LABEL_ID: Readonly<Record<OfferingType, string>> = {
  service: "Layanan",
  product: "Produk",
  tour: "Paket Tur",
  vehicle: "Kendaraan",
};

export function resolveBlueprintIdForAutopilot(
  blueprintId?: string | null,
  vertical?: string | null,
): B2BBlueprintId | null {
  if (blueprintId) {
    const direct = getB2BBlueprint(blueprintId.trim());
    if (direct) return direct.id;
  }
  if (vertical) {
    const mapped = VERTICAL_TO_BLUEPRINT_FALLBACK[vertical.trim().toLowerCase()];
    if (mapped) return mapped;
  }
  return null;
}

function mapRouteKindToAppearanceKind(routeKind: SeoRouteKind): SearchAppearanceKind | null {
  switch (routeKind) {
    case "homepage":
      return "homepage";
    case "page":
      return "page";
    case "post":
      return "post";
    case "offering":
      return "catalog_item";
    case "blog_index":
      return "blog_index";
    case "catalog_index":
      return "catalog_index";
    case "category_archive":
      return "post_category";
    case "tag_archive":
      return "post_tag";
    case "offering_category_archive":
      return "catalog_category";
    default:
      return null;
  }
}

function fillBlueprintTokens(
  template: string,
  values: {
    readonly businessName: string;
    readonly primaryService: string;
    readonly city: string;
    readonly tagline: string;
  },
): string {
  return template
    .replace(/\{\{\s*nama_bisnis\s*\}\}/gi, values.businessName)
    .replace(/\{\{\s*nama\s*\}\}/gi, values.businessName)
    .replace(/\{\{\s*layanan_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*produk_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*topik_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*destinasi_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*merek_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*kategori_produk\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*profesi_utama\s*\}\}/gi, values.primaryService)
    .replace(/\{\{\s*kota\s*\}\}/gi, values.city)
    .replace(/\{\{\s*area_layanan\s*\}\}/gi, values.city)
    .replace(/\{\{\s*tagline\s*\}\}/gi, values.tagline)
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\s+[|–—-]\s*(?=[|–—-]|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function appendPageQualifier(baseTitle: string, pageNumber?: number | null): string {
  if (typeof pageNumber === "number" && Number.isInteger(pageNumber) && pageNumber >= 2) {
    const suffix = ` — Halaman ${pageNumber}`;
    if (!baseTitle.includes(`Halaman ${pageNumber}`)) {
      return sanitizeSeoText(`${baseTitle}${suffix}`, { maxLength: 70 });
    }
  }
  return sanitizeSeoText(baseTitle, { maxLength: 70 });
}

/**
 * Generates zero-config programmatic Meta Title & Description derived from the tenant's
 * B2B Blueprint (`REQ-093`), business profile, and route content (`REQ-102`, `PLAN §15.1/§15.7`).
 *
 * Precedence:
 * 1. Explicit per-resource manual override (`titleOverride` / `descriptionOverride`)
 * 2. Published custom Search Appearance template (when explicitly customized)
 * 3. Programmatic B2B Blueprint autopilot pattern (zero manual configuration!)
 */
export function generateAutopilotBlueprintMeta(
  input: GenerateAutopilotBlueprintMetaInput,
): AutopilotBlueprintMetaResult {
  const siteName =
    sanitizeSeoText(input.profile.businessName || input.profile.siteName, { maxLength: 80 }) ||
    "PunyaSitus";
  const tagline = sanitizeSeoText(input.profile.tagline ?? "", { maxLength: 100 });
  const city = sanitizeSeoText(input.profile.city ?? "", { maxLength: 60 });
  const blueprintId = resolveBlueprintIdForAutopilot(
    input.profile.blueprintId,
    input.profile.vertical,
  );
  const blueprint = blueprintId ? B2B_VERTICAL_BLUEPRINTS[blueprintId] : null;
  const primaryService =
    sanitizeSeoText(
      input.profile.primaryService ??
        blueprint?.sidebarOffering.primaryMenuLabel ??
        (input.offeringType ? OFFERING_TYPE_LABEL_ID[input.offeringType] : "Layanan"),
      { maxLength: 60 },
    ) || "Layanan";

  const cleanContentTitle = sanitizeSeoText(input.title ?? "", { maxLength: 100 });
  const cleanExcerpt = sanitizeSeoDescription(input.excerpt ?? "");
  const cleanCategory = sanitizeSeoText(input.category ?? "", { maxLength: 60 });
  const sep = input.searchAppearance?.separator ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator;
  const pageNumber = input.pageNumber ?? null;

  const manualTitle = sanitizeSeoText(input.titleOverride ?? "", { maxLength: 70 });
  const manualDesc = sanitizeSeoDescription(input.descriptionOverride ?? "");

  // Check if a custom Search Appearance template was provided
  const appearanceKind = mapRouteKindToAppearanceKind(input.routeKind);
  const customAppearancePair =
    appearanceKind && input.searchAppearance
      ? input.searchAppearance.templates[appearanceKind]
      : null;

  const templateCtx = {
    title: cleanContentTitle || siteName,
    site_name: siteName,
    tagline: tagline || null,
    sep,
    category: cleanCategory || null,
    excerpt: cleanExcerpt || null,
    page: pageNumber,
  };

  // --- Title Resolution ---
  let title = "";
  let titleSource: AutopilotBlueprintMetaResult["titleSource"] = "blueprint_autopilot";

  if (manualTitle) {
    title = appendPageQualifier(manualTitle, pageNumber);
    titleSource = "manual_override";
  } else if (customAppearancePair?.titleTemplate) {
    const rendered = sanitizeSeoText(
      renderSearchAppearanceTemplate(customAppearancePair.titleTemplate, templateCtx),
      { maxLength: 70 },
    );
    if (rendered) {
      title = appendPageQualifier(rendered, pageNumber);
      titleSource = "search_appearance_template";
    }
  }

  if (!title) {
    if (input.routeKind === "homepage") {
      if (blueprint) {
        const bpTitle = fillBlueprintTokens(blueprint.metaTitleTemplate, {
          businessName: siteName,
          primaryService,
          city: city || "Indonesia",
          tagline: tagline || blueprint.shortDescription,
        });
        title = sanitizeSeoText(bpTitle, { maxLength: 70 });
      }
      if (!title) {
        title = sanitizeSeoText(
          tagline
            ? `${siteName} ${sep} ${tagline}`
            : city
              ? `${siteName} ${sep} ${primaryService} ${city}`
              : `${siteName} ${sep} ${primaryService}`,
          { maxLength: 70 },
        );
      }
    } else if (input.routeKind === "offering") {
      const typeLabel = input.offeringType ? OFFERING_TYPE_LABEL_ID[input.offeringType] : primaryService;
      const base = cleanContentTitle || typeLabel;
      const qualified = city ? `${base} ${sep} ${siteName} (${city})` : `${base} ${sep} ${siteName}`;
      title = appendPageQualifier(qualified, pageNumber);
    } else if (input.routeKind === "post") {
      const base = cleanContentTitle || "Artikel";
      title = appendPageQualifier(`${base} ${sep} ${siteName}`, pageNumber);
    } else if (input.routeKind === "blog_index") {
      title = appendPageQualifier(`Blog & Panduan ${sep} ${siteName}`, pageNumber);
    } else if (input.routeKind === "catalog_index") {
      const label = cleanContentTitle || (input.offeringType ? OFFERING_TYPE_LABEL_ID[input.offeringType] : primaryService);
      title = appendPageQualifier(`${label} ${sep} ${siteName}`, pageNumber);
    } else if (
      input.routeKind === "category_archive" ||
      input.routeKind === "tag_archive" ||
      input.routeKind === "offering_category_archive"
    ) {
      const archiveLabel = cleanCategory || cleanContentTitle || "Arsip";
      title = appendPageQualifier(`${archiveLabel} ${sep} ${siteName}`, pageNumber);
    } else {
      const base = cleanContentTitle || siteName;
      title = appendPageQualifier(
        base.toLowerCase() === siteName.toLowerCase() ? siteName : `${base} ${sep} ${siteName}`,
        pageNumber,
      );
    }
    titleSource = "blueprint_autopilot";
  }

  // --- Description Resolution ---
  let description = "";
  let descriptionSource: AutopilotBlueprintMetaResult["descriptionSource"] = "blueprint_autopilot";

  if (manualDesc) {
    description = manualDesc;
    descriptionSource = "manual_override";
  } else if (customAppearancePair?.descriptionTemplate) {
    const renderedDesc = sanitizeSeoDescription(
      renderSearchAppearanceTemplate(customAppearancePair.descriptionTemplate, templateCtx),
    );
    if (renderedDesc) {
      description = renderedDesc;
      descriptionSource = "search_appearance_template";
    }
  }

  if (!description && cleanExcerpt && input.routeKind !== "homepage") {
    description = cleanExcerpt;
    descriptionSource = "content_excerpt";
  }

  if (!description) {
    if (input.routeKind === "homepage" && blueprint) {
      description = sanitizeSeoDescription(
        fillBlueprintTokens(blueprint.metaDescriptionTemplate, {
          businessName: siteName,
          primaryService,
          city: city || "Indonesia",
          tagline: tagline || blueprint.shortDescription,
        }),
      );
    } else if (input.routeKind === "offering") {
      const label = cleanContentTitle || primaryService;
      const locPart = city ? ` di ${city}` : "";
      description = sanitizeSeoDescription(
        `Informasi lengkap ${label} dari ${siteName}${locPart}. Hubungi tim kami melalui WhatsApp atau formulir resmi untuk konsultasi.`,
      );
    } else if (input.routeKind === "post") {
      const label = cleanContentTitle || "artikel terbaru";
      description = sanitizeSeoDescription(
        `Baca panduan ${label} dari ${siteName}${cleanCategory ? ` dalam kategori ${cleanCategory}` : ""}.`,
      );
    } else if (input.routeKind === "blog_index") {
      description = sanitizeSeoDescription(
        `Kumpulan artikel, panduan, dan informasi resmi dari ${siteName}.`,
      );
    } else if (input.routeKind === "catalog_index") {
      const label = input.offeringType ? OFFERING_TYPE_LABEL_ID[input.offeringType] : primaryService;
      description = sanitizeSeoDescription(
        `Jelajahi daftar ${label.toLowerCase()} resmi dari ${siteName}${city ? ` di ${city}` : ""}.`,
      );
    } else if (
      input.routeKind === "category_archive" ||
      input.routeKind === "tag_archive" ||
      input.routeKind === "offering_category_archive"
    ) {
      const label = cleanCategory || cleanContentTitle || "pilihan";
      description = sanitizeSeoDescription(
        `Daftar konten ${label} yang dipublikasikan oleh ${siteName}.`,
      );
    } else {
      description = sanitizeSeoDescription(
        tagline
          ? `${cleanContentTitle ? `${cleanContentTitle} — ` : ""}${siteName}: ${tagline}`
          : `${cleanContentTitle || siteName}${city ? ` (${city})` : ""} — informasi resmi ${siteName}.`,
      );
    }
    descriptionSource = "blueprint_autopilot";
  }

  return {
    title,
    description,
    blueprintId,
    titleSource,
    descriptionSource,
    zeroConfigDerived: titleSource === "blueprint_autopilot" && descriptionSource !== "manual_override",
  };
}

// ---------------------------------------------------------------------------
// WhatsApp-Safe (< 300 KiB, 1200x630) Open Graph Helper
// ---------------------------------------------------------------------------

export interface ResolveAutopilotWhatsAppOgInput extends GenerateOpenGraphInput {
  readonly blueprintProfile?: BlueprintMetaProfileInput | null;
  readonly searchAppearance?: SearchAppearanceSettings | null;
  readonly resourceMedia?: MediaRecordLikeForOg | null;
  readonly tenantDefaultMedia?: MediaRecordLikeForOg | null;
  readonly mediaPublicBaseUrl?: string | null;
  readonly platformDomain?: string | null;
}

export interface AutopilotWhatsAppOgResult {
  readonly metadata: SocialMetadataDto;
  readonly blueprintMeta: AutopilotBlueprintMetaResult | null;
  readonly whatsAppSafeImage: boolean;
  readonly imageByteLimitBytes: typeof OG_IMAGE_MAX_BYTES;
  readonly imageDimensions: {
    readonly width: typeof OG_IMAGE_WIDTH;
    readonly height: typeof OG_IMAGE_HEIGHT;
  };
}

/**
 * Resolves WhatsApp-safe Open Graph & Twitter Card metadata (`1200x630`, `<= 300 KiB`)
 * enriched with Zero-Config Blueprint Title & Description when manual overrides are omitted.
 */
export function resolveAutopilotWhatsAppOgMetadata(
  input: ResolveAutopilotWhatsAppOgInput,
): AutopilotWhatsAppOgResult {
  const blueprintMeta = input.blueprintProfile
    ? generateAutopilotBlueprintMeta({
        routeKind: input.seo.routeKind,
        profile: input.blueprintProfile,
        title: input.resourceTitle,
        excerpt: input.resourceExcerpt,
        offeringType: input.offeringType,
        titleOverride: input.titleOverride ?? input.seo.resourceSeo?.titleOverride ?? null,
        descriptionOverride:
          input.descriptionOverride ?? input.seo.resourceSeo?.descriptionOverride ?? null,
        searchAppearance: input.searchAppearance,
      })
    : null;

  const tenantId = input.tenantId ?? "";
  const derivedResourceOg: OgImageCandidate | null =
    input.resourceOgImage ??
    (tenantId && input.resourceMedia
      ? buildOgImageCandidateFromMediaRecord({
          tenantId,
          media: input.resourceMedia,
          mediaPublicBaseUrl: input.mediaPublicBaseUrl,
          platformDomain: input.platformDomain,
          fallbackAlt: input.resourceTitle ?? input.siteName,
        })
      : null);

  const derivedTenantDefaultOg: OgImageCandidate | null =
    input.tenantDefaultOgImage ??
    (tenantId && input.tenantDefaultMedia
      ? buildOgImageCandidateFromMediaRecord({
          tenantId,
          media: input.tenantDefaultMedia,
          mediaPublicBaseUrl: input.mediaPublicBaseUrl,
          platformDomain: input.platformDomain,
          fallbackAlt: input.siteName,
        })
      : null);

  const metadata = generateOpenGraphMetadata({
    ...input,
    titleOverride: input.titleOverride ?? blueprintMeta?.title ?? null,
    descriptionOverride: input.descriptionOverride ?? blueprintMeta?.description ?? null,
    resourceOgImage: derivedResourceOg,
    tenantDefaultOgImage: derivedTenantDefaultOg,
  });

  const resolvedImg = metadata.og.image;
  const whatsAppSafeImage =
    resolvedImg !== null &&
    resolvedImg.width === OG_IMAGE_WIDTH &&
    resolvedImg.height === OG_IMAGE_HEIGHT &&
    resolvedImg.byteSize > 0 &&
    resolvedImg.byteSize <= OG_IMAGE_MAX_BYTES;

  return {
    metadata,
    blueprintMeta,
    whatsAppSafeImage,
    imageByteLimitBytes: OG_IMAGE_MAX_BYTES,
    imageDimensions: {
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
    },
  };
}

// ---------------------------------------------------------------------------
// Schema.org `@graph` Assembly & Plugin Gating Hook
// ---------------------------------------------------------------------------

export interface ResolveAutopilotSchemaGraphResult {
  readonly active: boolean;
  readonly emitted: boolean;
  readonly result: SchemaGenerationResult | null;
  readonly reason: "active" | "plugin_disabled" | "suppressed_by_policy";
}

/**
 * Single plugin gating hook for Schema.org `@graph` emission (`DEC-039`, `REQ-102`).
 * - When `seoAutopilotActive === false`: returns `null` with ZERO JSON-LD emission.
 * - When `seoAutopilotActive === true`: delegates to the single authoritative
 *   `generateSchemaGraph()` engine in `@punyasitus/core/schema-generator`.
 */
export function resolveAutopilotSchemaGraph(
  input: GenerateSchemaInput,
  options: { readonly seoAutopilotActive?: boolean } = {},
): ResolveAutopilotSchemaGraphResult {
  const active = options.seoAutopilotActive !== false;
  if (!active) {
    return {
      active: false,
      emitted: false,
      result: null,
      reason: "plugin_disabled",
    };
  }

  const result = generateSchemaGraph(input);
  return {
    active: true,
    emitted: result.emitted && result.graph !== null,
    result,
    reason: result.emitted && result.graph !== null ? "active" : "suppressed_by_policy",
  };
}

// ---------------------------------------------------------------------------
// Authoritative `<head>` Renderer with Active vs Disabled Safety Gating
// ---------------------------------------------------------------------------

export interface RenderAutopilotSeoHeadInput {
  readonly metadata: SocialMetadataDto;
  /**
   * Whether `seo-ai-autopilot` is active on this tenant.
   * Defaults to `true` when omitted for backward compatibility with existing callers/tests.
   */
  readonly seoAutopilotActive?: boolean;
  readonly jsonLd?: unknown | readonly unknown[];
  readonly omitTitle?: boolean;
  readonly omitDescription?: boolean;
  readonly publishedVerificationTokens?: VerificationTokensConfig | null;
  readonly blogEnabled?: boolean;
  readonly siteName?: string;
}

export interface RenderedAutopilotSeoHead {
  readonly html: string;
  readonly mode: "autopilot_active" | "minimal_disabled";
  readonly robotsEmitted: boolean;
  readonly robots: string;
  readonly schemaEmitted: boolean;
  readonly ogEmitted: boolean;
}

/**
 * Renders the single authoritative `<head>` HTML block for `<SEOHead.astro>` (`REQ-102`, `DEC-039`).
 *
 * CRITICAL INVARIANTS:
 * - When `seoAutopilotActive === false` (DISABLED):
 *   Emits ONLY minimal `<title>` (unless `omitTitle === true`) plus mandatory non-indexable
 *   safety `<meta name="robots" content="noindex, nofollow" />` whenever the route is `trial`,
 *   `suspended`, `recovery`, `noindex`, `draft`, `preview`, `error`, or `unknown_host`.
 *   Emits ZERO JSON-LD `@graph`, ZERO OG/Twitter expansion, ZERO webmaster tags, ZERO RSS link.
 * - When `seoAutopilotActive === true` (ACTIVE):
 *   Emits complete escaped SEO/OG/Twitter/Canonical/Pagination/JSON-LD `<head>` tags via
 *   `renderSeoHeadHtml`, plus optional published webmaster verification tags & RSS link.
 */
export function renderAutopilotSeoHead(
  input: RenderAutopilotSeoHeadInput,
): RenderedAutopilotSeoHead {
  const active = input.seoAutopilotActive !== false;
  const { metadata, omitTitle = false, omitDescription = false } = input;

  if (!active) {
    const lines: string[] = [];
    if (!omitTitle) {
      lines.push(`<title>${escapeHtmlText(metadata.title)}</title>`);
    }
    const mustEmitSafetyRobots = metadata.robots !== INDEXABLE_ROBOTS_DIRECTIVES;
    if (mustEmitSafetyRobots) {
      lines.push(`<meta name="robots" content="${escapeHtmlAttribute(metadata.robots)}" />`);
    }
    return {
      html: lines.join("\n"),
      mode: "minimal_disabled",
      robotsEmitted: mustEmitSafetyRobots,
      robots: metadata.robots,
      schemaEmitted: false,
      ogEmitted: false,
    };
  }

  const baseHtml = renderSeoHeadHtml(metadata, {
    jsonLd: input.jsonLd,
    includeTitle: !omitTitle,
    includeDescription: !omitDescription,
  });

  const extraLines: string[] = [];
  const canEmitDiscoveryExtras =
    metadata.canonical !== null &&
    metadata.verifiedOrigin !== null &&
    metadata.seoDecision.httpStatus === 200;

  if (canEmitDiscoveryExtras && input.blogEnabled === true && metadata.verifiedOrigin) {
    try {
      const safeOrigin = validateCanonicalOrigin(metadata.verifiedOrigin);
      const rssTitle = sanitizeSeoText(
        `RSS Feed — ${input.siteName || metadata.og.siteName}`,
        { maxLength: 120 },
      );
      extraLines.push(
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtmlAttribute(rssTitle)}" href="${escapeHtmlAttribute(`${safeOrigin}/blog/feed.xml`)}" />`,
      );
    } catch {
      // Ignore invalid origin cleanly
    }
  }

  if (canEmitDiscoveryExtras && input.publishedVerificationTokens) {
    for (const tag of renderVerificationMetaTags(input.publishedVerificationTokens)) {
      extraLines.push(tag);
    }
  }

  const html = extraLines.length > 0 ? `${baseHtml}\n${extraLines.join("\n")}` : baseHtml;

  return {
    html,
    mode: "autopilot_active",
    robotsEmitted: true,
    robots: metadata.robots,
    schemaEmitted: html.includes('type="application/ld+json"'),
    ogEmitted: html.includes('property="og:title"'),
  };
}
