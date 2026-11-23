import { z } from "zod";
import {
  escapeHtmlAttribute,
  escapeHtmlText,
  resolveEffectiveSeoText,
  resolvePublishedSeoDecision,
  sanitizeSeoText,
  validateCanonicalHostname,
  type PublishedSeoDecision,
  type ResourceSeoOverrides,
  type SeoDecisionReason,
  type SeoRouteKind,
  type SeoTenantStatus,
  type SiteVisibility,
  type VerifiedTenantHostInput,
} from "./index.ts";
import type { OfferingType } from "../schemas/common.ts";
import type { RestrictedRichTextDoc } from "../content/index.ts";

/**
 * TASK-052 / REQ-053 / REQ-055 / PLAN §15.3, §15.5, §15.7:
 * Shared SEO Editor Controls, Search Appearance Templates, Allowed Schema Matrix,
 * Advisory Checklist (zero numeric score, never blocks publish), and Webmaster
 * Verification Token Validation & Configured-vs-Externally-Verified State Machine.
 *
 * Pure, runtime-neutral, strict TypeScript — zero DB bindings, zero network calls.
 */

// ---------------------------------------------------------------------------
// 1. Fixed Search Appearance Templates & Token Grammar (PLAN §15.7)
// ---------------------------------------------------------------------------

export const SEARCH_APPEARANCE_TOKENS = [
  "title",
  "site_name",
  "tagline",
  "sep",
  "category",
  "excerpt",
  "page",
] as const;

export type SearchAppearanceToken = (typeof SEARCH_APPEARANCE_TOKENS)[number];

export const SEARCH_APPEARANCE_TOKEN_SET: ReadonlySet<string> = new Set(SEARCH_APPEARANCE_TOKENS);

export const SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS = SEARCH_APPEARANCE_TOKENS.map(
  (t) => `{{${t}}}`,
) as readonly `{{${SearchAppearanceToken}}}`[];

export const SEARCH_APPEARANCE_SEPARATORS = [
  "-",
  "|",
  "–",
  "—",
  "·",
  "•",
  ":",
  "/",
  "»",
] as const;

export type SearchAppearanceSeparator = (typeof SEARCH_APPEARANCE_SEPARATORS)[number];

export const SEARCH_APPEARANCE_KINDS = [
  "homepage",
  "page",
  "post",
  "catalog_item",
  "post_category",
  "post_tag",
  "catalog_category",
  "blog_index",
  "catalog_index",
] as const;

export type SearchAppearanceKind = (typeof SEARCH_APPEARANCE_KINDS)[number];

export const MAX_SEO_OVERRIDE_TITLE_LENGTH = 200 as const;
export const MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH = 500 as const;
export const MAX_SEO_FOCUS_KEYPHRASE_LENGTH = 100 as const;

export const RECOMMENDED_TITLE_MIN = 45 as const;
export const RECOMMENDED_TITLE_MAX = 60 as const;
export const RECOMMENDED_DESCRIPTION_MIN = 120 as const;
export const RECOMMENDED_DESCRIPTION_MAX = 160 as const;

export interface SearchAppearanceTemplatePair {
  readonly titleTemplate: string;
  readonly descriptionTemplate: string;
}

export type SearchAppearanceTemplatesMap = Readonly<
  Record<SearchAppearanceKind, SearchAppearanceTemplatePair>
>;

export interface SearchAppearanceSettings {
  readonly separator: SearchAppearanceSeparator;
  readonly templates: SearchAppearanceTemplatesMap;
}

export const DEFAULT_SEARCH_APPEARANCE_SETTINGS: SearchAppearanceSettings = {
  separator: "|",
  templates: {
    homepage: {
      titleTemplate: "{{site_name}} {{sep}} {{tagline}}",
      descriptionTemplate: "{{excerpt}}",
    },
    page: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    post: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    catalog_item: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    post_category: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    post_tag: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    catalog_category: {
      titleTemplate: "{{title}} {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    blog_index: {
      titleTemplate: "Blog {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
    catalog_index: {
      titleTemplate: "Katalog {{sep}} {{site_name}}",
      descriptionTemplate: "{{excerpt}}",
    },
  },
} as const;

export interface TemplateValidationIssue {
  readonly code: "UNKNOWN_TEMPLATE_TOKEN" | "INVALID_TEMPLATE_SYNTAX" | "DISALLOWED_HTML_OR_SCRIPT" | "CONTROL_CHARACTER";
  readonly message: string;
  readonly token?: string;
}

const UNICODE_BIDI_OR_ZW_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return UNICODE_BIDI_OR_ZW_RE.test(value);
}

const DISALLOWED_HTML_TAG_RE = /<\s*\/?\s*[a-z!/?][^>]*>/i;
const DISALLOWED_ANGLE_OR_SCRIPT_RE = /<\s*\/?\s*(?:script|iframe|style|meta|link|object|embed|svg|img|body|head)\b|javascript:/i;

/**
 * Validates a search appearance template string (or title/description override containing tokens).
 * Rejects:
 * - ASCII control characters
 * - HTML / script / meta tags
 * - Unbalanced `{{` or `}}` braces
 * - Any `{{token}}` outside the fixed 7-token allowlist (PLAN §15.7)
 */
export function validateSearchAppearanceTemplateString(
  raw: string,
): { readonly ok: true } | { readonly ok: false; readonly issue: TemplateValidationIssue } {
  if (hasControlChars(raw)) {
    return {
      ok: false,
      issue: {
        code: "CONTROL_CHARACTER",
        message: "Template tidak boleh mengandung karakter kontrol.",
      },
    };
  }

  if (DISALLOWED_ANGLE_OR_SCRIPT_RE.test(raw) || DISALLOWED_HTML_TAG_RE.test(raw)) {
    return {
      ok: false,
      issue: {
        code: "DISALLOWED_HTML_OR_SCRIPT",
        message: "Template SEO tidak boleh mengandung tag HTML atau skrip.",
      },
    };
  }

  // Scan strictly for `{{...}}` balanced tokens
  let cursor = 0;
  while (cursor < raw.length) {
    const openIdx = raw.indexOf("{{", cursor);
    const closeBeforeOpen = raw.indexOf("}}", cursor);

    if (closeBeforeOpen !== -1 && (openIdx === -1 || closeBeforeOpen < openIdx)) {
      return {
        ok: false,
        issue: {
          code: "INVALID_TEMPLATE_SYNTAX",
          message: 'Tanda penutup "}}" ditemukan tanpa pembuka "{{".',
        },
      };
    }

    if (openIdx === -1) {
      break;
    }

    const closeIdx = raw.indexOf("}}", openIdx + 2);
    if (closeIdx === -1) {
      return {
        ok: false,
        issue: {
          code: "INVALID_TEMPLATE_SYNTAX",
          message: 'Token template tidak ditutup dengan "}}".',
        },
      };
    }

    const inner = raw.slice(openIdx + 2, closeIdx);
    if (inner.includes("{") || inner.includes("}")) {
      return {
        ok: false,
        issue: {
          code: "INVALID_TEMPLATE_SYNTAX",
          message: `Sintaks token template tidak valid: "{{${inner}}}".`,
        },
      };
    }

    if (!SEARCH_APPEARANCE_TOKEN_SET.has(inner)) {
      return {
        ok: false,
        issue: {
          code: "UNKNOWN_TEMPLATE_TOKEN",
          token: inner,
          message: `Token template "{{${inner}}}" tidak dikenali. Token yang diizinkan: ${SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS.join(", ")}.`,
        },
      };
    }

    cursor = closeIdx + 2;
  }

  return { ok: true };
}

export interface SearchAppearanceTokenValues {
  readonly title?: string | null;
  readonly site_name?: string | null;
  readonly tagline?: string | null;
  readonly sep?: SearchAppearanceSeparator | null;
  readonly category?: string | null;
  readonly excerpt?: string | null;
  readonly page?: number | string | null;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders a validated search appearance template using concrete values.
 * Collapses dangling separators when optional values (such as tagline/category/page) are empty.
 * Escaping for HTML text/attribute contexts is applied separately by callers or via
 * `renderEscapedSearchAppearanceTemplate`.
 */
export function renderSearchAppearanceTemplate(
  template: string,
  values: SearchAppearanceTokenValues,
): string {
  const sep = values.sep ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator;
  const pageText =
    typeof values.page === "number"
      ? values.page > 1
        ? `Halaman ${values.page}`
        : ""
      : typeof values.page === "string"
        ? values.page.trim()
        : "";

  const tokenMap: Record<SearchAppearanceToken, string> = {
    title: sanitizeSeoText(values.title ?? "", { maxLength: MAX_SEO_OVERRIDE_TITLE_LENGTH }),
    site_name: sanitizeSeoText(values.site_name ?? "", { maxLength: 120 }),
    tagline: sanitizeSeoText(values.tagline ?? "", { maxLength: 160 }),
    sep,
    category: sanitizeSeoText(values.category ?? "", { maxLength: 100 }),
    excerpt: sanitizeSeoText(values.excerpt ?? "", { maxLength: MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH }),
    page: sanitizeSeoText(pageText, { maxLength: 40 }),
  };

  let rendered = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, tokenName: string) => {
    if (SEARCH_APPEARANCE_TOKEN_SET.has(tokenName)) {
      return tokenMap[tokenName as SearchAppearanceToken];
    }
    return "";
  });

  // Collapse consecutive whitespace and redundant separators left by empty optional tokens
  const sepRe = escapeRegExp(sep);
  rendered = rendered.replace(/\s+/g, " ").trim();
  const duplicateSepRe = new RegExp(`(?:\\s*${sepRe}\\s*){2,}`, "g");
  rendered = rendered.replace(duplicateSepRe, ` ${sep} `);
  const leadingSepRe = new RegExp(`^(?:${sepRe}\\s*)+`);
  const trailingSepRe = new RegExp(`(?:\\s*${sepRe})+$`);
  rendered = rendered.replace(leadingSepRe, "").replace(trailingSepRe, "").trim();

  return rendered;
}

export function renderEscapedSearchAppearanceTemplate(
  template: string,
  values: SearchAppearanceTokenValues,
  context: "html_text" | "html_attr" = "html_text",
): string {
  const plain = renderSearchAppearanceTemplate(template, values);
  return context === "html_attr" ? escapeHtmlAttribute(plain) : escapeHtmlText(plain);
}

// ---------------------------------------------------------------------------
// 2. Allowed Schema.org Types Per Content Kind (PLAN §15.4 & §15.7)
// ---------------------------------------------------------------------------

export type SeoEditorResourceKind = "page" | "post" | "offering" | "taxonomy";

export const ALLOWED_SCHEMA_TYPES_BY_KIND = {
  page: ["WebPage", "AboutPage", "ContactPage", "CollectionPage", "FAQPage"],
  post: ["BlogPosting", "Article", "NewsArticle"],
  offering_service: ["Service"],
  offering_product: ["Service", "Product"],
  offering_tour: ["Service", "TouristTrip"],
  offering_vehicle: ["Service", "Product"],
  outlet: ["LocalBusiness"],
} as const;

export type PageSchemaType = (typeof ALLOWED_SCHEMA_TYPES_BY_KIND.page)[number];
export type PostSchemaType = (typeof ALLOWED_SCHEMA_TYPES_BY_KIND.post)[number];
export type OfferingSchemaType = "Service" | "Product" | "TouristTrip";
export type AllowedResourceSchemaType = PageSchemaType | PostSchemaType | OfferingSchemaType;

export interface SchemaTypeEligibilityContext {
  readonly resourceKind: SeoEditorResourceKind;
  readonly offeringType?: OfferingType | null;
  readonly hasVisibleFaqBlock?: boolean;
  readonly priceMode?: "fixed" | "from" | "range" | "on_request" | null;
  readonly price?: number | null;
  readonly hasVisibleItinerary?: boolean;
}

export interface SchemaTypeOption {
  readonly value: AllowedResourceSchemaType;
  readonly label: string;
  readonly description: string;
  readonly allowed: boolean;
  readonly disabledReason?: string;
}

export function getDefaultSchemaTypeForResource(
  resourceKind: SeoEditorResourceKind,
  offeringType?: OfferingType | null,
): AllowedResourceSchemaType | null {
  switch (resourceKind) {
    case "page":
      return "WebPage";
    case "post":
      return "BlogPosting";
    case "offering":
      if (offeringType === "tour") return "Service";
      return "Service";
    case "taxonomy":
      return null;
  }
}

export function getAllowedSchemaTypeOptions(
  ctx: SchemaTypeEligibilityContext,
): readonly SchemaTypeOption[] {
  if (ctx.resourceKind === "page") {
    const hasFaq = Boolean(ctx.hasVisibleFaqBlock);
    return [
      {
        value: "WebPage",
        label: "WebPage (Bawaan)",
        description: "Halaman web umum perusahaan atau profil layanan.",
        allowed: true,
      },
      {
        value: "AboutPage",
        label: "AboutPage",
        description: "Halaman profil perusahaan, sejarah, atau tim.",
        allowed: true,
      },
      {
        value: "ContactPage",
        label: "ContactPage",
        description: "Halaman kontak, lokasi, dan saluran komunikasi resmi.",
        allowed: true,
      },
      {
        value: "CollectionPage",
        label: "CollectionPage",
        description: "Halaman direktori atau kumpulan layanan/informasi.",
        allowed: true,
      },
      {
        value: "FAQPage",
        label: "FAQPage (Hanya dengan blok FAQ terlihat)",
        description:
          "Kejelasan semantik untuk blok tanya-jawab yang terlihat publik. Google tidak lagi menampilkan fitur rich result FAQ.",
        allowed: hasFaq,
        ...(hasFaq
          ? {}
          : {
              disabledReason:
                "Tambahkan bagian Tanya Jawab (FAQ) yang terlihat publik pada halaman ini sebelum memilih FAQPage.",
            }),
      },
    ];
  }

  if (ctx.resourceKind === "post") {
    return [
      {
        value: "BlogPosting",
        label: "BlogPosting (Bawaan)",
        description: "Artikel blog informatif, panduan, atau opini bisnis.",
        allowed: true,
      },
      {
        value: "Article",
        label: "Article",
        description: "Artikel panjang atau publikasi umum non-berita.",
        allowed: true,
      },
      {
        value: "NewsArticle",
        label: "NewsArticle",
        description: "Pengumuman resmi atau berita terkini dengan tanggal jelas.",
        allowed: true,
      },
    ];
  }

  if (ctx.resourceKind === "offering") {
    const offeringType = ctx.offeringType ?? "service";
    if (offeringType === "service") {
      return [
        {
          value: "Service",
          label: "Service (Bawaan)",
          description: "Jasa atau layanan profesional sesuai fakta yang tampil di halaman.",
          allowed: true,
        },
      ];
    }

    if (offeringType === "tour") {
      const hasItinerary = Boolean(ctx.hasVisibleItinerary);
      return [
        {
          value: "Service",
          label: "Service (Bawaan)",
          description: "Layanan perjalanan umum.",
          allowed: true,
        },
        {
          value: "TouristTrip",
          label: "TouristTrip (Paket Tur)",
          description: "Skema perjalanan wisata dari fakta destinasi dan itinerary yang terlihat.",
          allowed: hasItinerary,
          ...(hasItinerary
            ? {}
            : {
                disabledReason:
                  "Lengkapi fakta destinasi atau rencana perjalanan (itinerary) yang terlihat publik sebelum memilih TouristTrip.",
              }),
        },
      ];
    }

    // product or vehicle
    const hasVisibleFixedOrFromPrice =
      (ctx.priceMode === "fixed" || ctx.priceMode === "from") &&
      typeof ctx.price === "number" &&
      ctx.price >= 0;

    return [
      {
        value: "Service",
        label: "Service (Bawaan)",
        description: "Penawaran katalog umum tanpa properti harga tetap.",
        allowed: true,
      },
      {
        value: "Product",
        label: "Product (Dengan Harga Terlihat)",
        description:
          "Hanya digunakan jika harga tetap atau mulai dari tampil nyata di halaman. Tidak memancarkan properti checkout/pengiriman.",
        allowed: hasVisibleFixedOrFromPrice,
        ...(hasVisibleFixedOrFromPrice
          ? {}
          : {
              disabledReason:
                "Schema Product hanya diizinkan jika mode harga adalah 'fixed' atau 'from' dengan nominal harga yang terlihat publik.",
            }),
      },
    ];
  }

  return [];
}

export function validateSchemaTypeForResource(
  schemaType: string | null | undefined,
  ctx: SchemaTypeEligibilityContext,
):
  | { readonly ok: true; readonly schemaType: AllowedResourceSchemaType | null }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  if (schemaType === undefined || schemaType === null || schemaType === "") {
    return { ok: true, schemaType: null };
  }

  if (ctx.resourceKind === "taxonomy") {
    return {
      ok: false,
      code: "SCHEMA_TYPE_NOT_ALLOWED",
      message: "Taksonomi tidak mendukung penggantian schemaType manual.",
    };
  }

  const options = getAllowedSchemaTypeOptions(ctx);
  const matched = options.find((opt) => opt.value === schemaType);
  if (!matched) {
    const allowedNames = options.map((opt) => opt.value).join(", ");
    return {
      ok: false,
      code: "SCHEMA_TYPE_NOT_ALLOWED",
      message: `Tipe skema "${schemaType}" tidak diizinkan untuk jenis konten ini. Pilihan yang tersedia: ${allowedNames}.`,
    };
  }

  if (!matched.allowed) {
    const code =
      schemaType === "FAQPage"
        ? "FAQ_BLOCK_REQUIRED"
        : schemaType === "Product"
          ? "PRODUCT_SCHEMA_REQUIRES_PRICE"
          : schemaType === "TouristTrip"
            ? "TOURIST_TRIP_REQUIRES_ITINERARY"
            : "SCHEMA_TYPE_NOT_ALLOWED";
    return {
      ok: false,
      code,
      message: matched.disabledReason ?? `Tipe skema "${schemaType}" belum memenuhi syarat konten terlihat.`,
    };
  }

  return { ok: true, schemaType: matched.value };
}

export interface PublishSafeSchemaResolution {
  readonly schemaType: AllowedResourceSchemaType | null;
  readonly downgraded: boolean;
  readonly reason: string | null;
}

/**
 * Re-validates a stored `schemaType` against current visible facts (FAQ block, fixed/from price,
 * visible itinerary) and safely downgrades to the resource's default schema type if the required
 * visible fact was removed before render/publish (PLAN §15.4 & §15.7).
 */
export function resolvePublishSafeSchemaType(
  storedSchemaType: string | null | undefined,
  ctx: SchemaTypeEligibilityContext,
): PublishSafeSchemaResolution {
  const defaultSchema = getDefaultSchemaTypeForResource(ctx.resourceKind, ctx.offeringType);
  if (storedSchemaType === undefined || storedSchemaType === null || storedSchemaType === "") {
    return { schemaType: defaultSchema, downgraded: false, reason: null };
  }
  const check = validateSchemaTypeForResource(storedSchemaType, ctx);
  if (check.ok && check.schemaType) {
    return { schemaType: check.schemaType, downgraded: false, reason: null };
  }
  return {
    schemaType: defaultSchema,
    downgraded: true,
    reason: check.ok ? null : check.message,
  };
}

// ---------------------------------------------------------------------------
// 3. Webmaster Verification Tokens & Configured-vs-Verified State (REQ-055, PLAN §15.5)
// ---------------------------------------------------------------------------

export const VERIFICATION_PROVIDERS = ["google", "bing", "yandex"] as const;
export type VerificationProvider = (typeof VERIFICATION_PROVIDERS)[number];

export const VERIFICATION_META_NAMES: Readonly<Record<VerificationProvider, string>> = {
  google: "google-site-verification",
  bing: "msvalidate.01",
  yandex: "yandex-verification",
} as const;

export const VERIFICATION_PROVIDER_LABELS: Readonly<Record<VerificationProvider, string>> = {
  google: "Google Search Console",
  bing: "Bing Webmaster Tools",
  yandex: "Yandex Webmaster (Opsional)",
} as const;

export const GOOGLE_VERIFICATION_TOKEN_RE = /^[A-Za-z0-9._-]{10,128}$/;
export const BING_VERIFICATION_TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
export const YANDEX_VERIFICATION_TOKEN_RE = /^[A-Za-z0-9]{8,64}$/;

export function validateVerificationToken(
  provider: VerificationProvider,
  raw: unknown,
):
  | { readonly ok: true; readonly token: string | null }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, token: null };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "INVALID_VERIFICATION_TOKEN",
      message: `Token verifikasi ${VERIFICATION_PROVIDER_LABELS[provider]} harus berupa teks.`,
    };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, token: null };
  }

  if (
    hasControlChars(trimmed) ||
    /[<>"'`=\s\\/;]/.test(trimmed) ||
    DISALLOWED_ANGLE_OR_SCRIPT_RE.test(trimmed)
  ) {
    return {
      ok: false,
      code: "INVALID_VERIFICATION_TOKEN",
      message: `Token ${VERIFICATION_PROVIDER_LABELS[provider]} hanya boleh berisi nilai atribut content polos (tanpa tag <meta>, tanda kutip, spasi, atau karakter HTML).`,
    };
  }

  const re =
    provider === "google"
      ? GOOGLE_VERIFICATION_TOKEN_RE
      : provider === "bing"
        ? BING_VERIFICATION_TOKEN_RE
        : YANDEX_VERIFICATION_TOKEN_RE;

  if (!re.test(trimmed)) {
    const ruleText =
      provider === "google"
        ? "10–128 karakter alfanumerik, titik (.), garis bawah (_), atau tanda hubung (-)"
        : provider === "bing"
          ? "16–64 karakter alfanumerik polos"
          : "8–64 karakter alfanumerik polos";
    return {
      ok: false,
      code: "INVALID_VERIFICATION_TOKEN",
      message: `Format token ${VERIFICATION_PROVIDER_LABELS[provider]} tidak valid (wajib ${ruleText}).`,
    };
  }

  return { ok: true, token: trimmed };
}

export interface VerificationTokensConfig {
  readonly google: string | null;
  readonly bing: string | null;
  readonly yandex: string | null;
}

export interface ExternalVerificationRecord {
  readonly verifiedHost: string;
  readonly verifiedAt: string;
  readonly verifiedByUserId: string;
  readonly note: string | null;
}

export type ExternalVerificationRecordsMap = Readonly<
  Record<VerificationProvider, ExternalVerificationRecord | null>
>;

export type VerificationEffectiveStatus =
  | "not_configured"
  | "configured"
  | "externally_verified"
  | "recheck_required";

export interface ProviderVerificationStatusView {
  readonly provider: VerificationProvider;
  readonly label: string;
  readonly metaName: string;
  readonly token: string | null;
  readonly publishedToken: string | null;
  readonly metaTagPreview: string | null;
  readonly status: VerificationEffectiveStatus;
  readonly statusLabel: string;
  readonly helperText: string;
  readonly externalVerification: ExternalVerificationRecord | null;
  readonly currentPrimaryHost: string;
  readonly domainChangedSinceVerification: boolean;
}

/**
 * Resolves configured vs externally-verified vs recheck-required state for a verification provider
 * against the tenant's CURRENT verified primary host (REQ-055, PLAN §15.5).
 *
 * Invariants:
 * - Local token save ALWAYS yields `"configured"`, NEVER `"externally_verified"`.
 * - If primary host changed after an external verification was recorded, status degrades to
 *   `"recheck_required"` because old-host verification does not prove ownership of the new domain.
 */
export function resolveProviderVerificationStatus(params: {
  readonly provider: VerificationProvider;
  readonly draftToken: string | null;
  readonly publishedToken: string | null;
  readonly externalVerification: ExternalVerificationRecord | null;
  readonly currentPrimaryHost: string;
}): ProviderVerificationStatusView {
  const normalizedHost = validateCanonicalHostname(params.currentPrimaryHost);
  const metaName = VERIFICATION_META_NAMES[params.provider];
  const label = VERIFICATION_PROVIDER_LABELS[params.provider];
  const activeToken = params.publishedToken ?? params.draftToken;

  const metaTagPreview = activeToken
    ? `<meta name="${metaName}" content="${escapeHtmlAttribute(activeToken)}" />`
    : null;

  if (!params.draftToken && !params.publishedToken) {
    return {
      provider: params.provider,
      label,
      metaName,
      token: null,
      publishedToken: null,
      metaTagPreview: null,
      status: "not_configured",
      statusLabel: "Belum dikonfigurasi",
      helperText:
        "Masukkan nilai token polos dari dashboard webmaster (hanya isi atribut content, bukan seluruh tag HTML).",
      externalVerification: null,
      currentPrimaryHost: normalizedHost,
      domainChangedSinceVerification: false,
    };
  }

  // If token was modified in draft vs published or not yet published, it is only configured locally
  const hasUnpublishedTokenChange = params.draftToken !== params.publishedToken;
  const ext = params.externalVerification;

  if (!params.publishedToken || hasUnpublishedTokenChange || !ext) {
    return {
      provider: params.provider,
      label,
      metaName,
      token: params.draftToken,
      publishedToken: params.publishedToken,
      metaTagPreview,
      status: "configured",
      statusLabel: "Terkonfigurasi (Belum terverifikasi eksternal)",
      helperText: !params.publishedToken
        ? "Token masih tersimpan sebagai draf. Terbitkan pengaturan SEO lalu lakukan verifikasi manual di dashboard webmaster."
        : hasUnpublishedTokenChange
          ? "Token diubah di draf. Terbitkan pengaturan lalu verifikasi ulang di dashboard webmaster."
          : `Tag meta aktif pada ${normalizedHost}. Selesaikan verifikasi manual di ${label}, lalu catat hasilnya di sini.`,
      externalVerification: hasUnpublishedTokenChange ? null : ext,
      currentPrimaryHost: normalizedHost,
      domainChangedSinceVerification: false,
    };
  }

  const verifiedHostNormalized = ext.verifiedHost.trim().toLowerCase();
  if (verifiedHostNormalized !== normalizedHost) {
    return {
      provider: params.provider,
      label,
      metaName,
      token: params.draftToken,
      publishedToken: params.publishedToken,
      metaTagPreview,
      status: "recheck_required",
      statusLabel: "Perlu verifikasi ulang (Domain berubah)",
      helperText: `Verifikasi eksternal sebelumnya tercatat pada ${verifiedHostNormalized}, sedangkan domain utama saat ini adalah ${normalizedHost}. Token pada domain lama tidak membuktikan kepemilikan domain baru.`,
      externalVerification: ext,
      currentPrimaryHost: normalizedHost,
      domainChangedSinceVerification: true,
    };
  }

  return {
    provider: params.provider,
    label,
    metaName,
    token: params.draftToken,
    publishedToken: params.publishedToken,
    metaTagPreview,
    status: "externally_verified",
    statusLabel: `Terverifikasi eksternal (${normalizedHost})`,
    helperText: `Verifikasi manual pada ${label} tercatat selesai untuk ${normalizedHost}. Status ini catatan operasional, bukan jaminan pengindeksan.`,
    externalVerification: ext,
    currentPrimaryHost: normalizedHost,
    domainChangedSinceVerification: false,
  };
}

/**
 * Emits ONLY fixed, known verification `<meta>` tags from validated published tokens.
 * Never accepts arbitrary tag names or raw HTML.
 */
export function renderVerificationMetaTags(
  publishedTokens: Partial<VerificationTokensConfig> | null | undefined,
): readonly string[] {
  if (!publishedTokens) return [];
  const tags: string[] = [];
  for (const provider of VERIFICATION_PROVIDERS) {
    const raw = publishedTokens[provider];
    const check = validateVerificationToken(provider, raw);
    if (check.ok && check.token) {
      tags.push(
        `<meta name="${VERIFICATION_META_NAMES[provider]}" content="${escapeHtmlAttribute(check.token)}" />`,
      );
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// 4. Strict Zod v4 `.strict()` Schemas for API & Persistence
// ---------------------------------------------------------------------------

const TemplateFieldSchema = (maxLength: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} tidak boleh kosong.`)
    .max(maxLength, `${label} maksimal ${maxLength} karakter.`)
    .superRefine((val, ctx) => {
      const check = validateSearchAppearanceTemplateString(val);
      if (!check.ok) {
        ctx.addIssue({
          code: "custom",
          message: check.issue.message,
        });
      }
    });

const OptionalOverrideTemplateFieldSchema = (maxLength: number, label: string) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} maksimal ${maxLength} karakter.`)
    .superRefine((val, ctx) => {
      if (val === "") return;
      const check = validateSearchAppearanceTemplateString(val);
      if (!check.ok) {
        ctx.addIssue({
          code: "custom",
          message: check.issue.message,
        });
      }
    });

const PlainSeoTextFieldSchema = (maxLength: number, label: string) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} maksimal ${maxLength} karakter.`)
    .refine((v) => !hasControlChars(v), `${label} tidak boleh mengandung karakter kontrol.`)
    .refine(
      (v) => !DISALLOWED_ANGLE_OR_SCRIPT_RE.test(v) && !DISALLOWED_HTML_TAG_RE.test(v),
      `${label} tidak boleh mengandung tag HTML atau skrip.`,
    );

export const SearchAppearanceSeparatorSchema = z.enum(SEARCH_APPEARANCE_SEPARATORS);

export const SearchAppearanceTemplatePairSchema = z
  .object({
    titleTemplate: TemplateFieldSchema(MAX_SEO_OVERRIDE_TITLE_LENGTH, "Template judul"),
    descriptionTemplate: TemplateFieldSchema(MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH, "Template deskripsi"),
  })
  .strict();

export const SearchAppearanceTemplatesPatchSchema = z
  .object({
    homepage: SearchAppearanceTemplatePairSchema.optional(),
    page: SearchAppearanceTemplatePairSchema.optional(),
    post: SearchAppearanceTemplatePairSchema.optional(),
    catalog_item: SearchAppearanceTemplatePairSchema.optional(),
    post_category: SearchAppearanceTemplatePairSchema.optional(),
    post_tag: SearchAppearanceTemplatePairSchema.optional(),
    catalog_category: SearchAppearanceTemplatePairSchema.optional(),
    blog_index: SearchAppearanceTemplatePairSchema.optional(),
    catalog_index: SearchAppearanceTemplatePairSchema.optional(),
  })
  .strict();

const VerificationTokenInputSchema = (provider: VerificationProvider) =>
  z
    .string()
    .nullable()
    .optional()
    .superRefine((val, ctx) => {
      if (val === undefined) return;
      const check = validateVerificationToken(provider, val);
      if (!check.ok) {
        ctx.addIssue({
          code: "custom",
          message: check.message,
        });
      }
    })
    .transform((val) => {
      if (val === undefined) return undefined;
      const check = validateVerificationToken(provider, val);
      return check.ok ? check.token : null;
    });

export const VerificationTokensPatchSchema = z
  .object({
    google: VerificationTokenInputSchema("google"),
    bing: VerificationTokenInputSchema("bing"),
    yandex: VerificationTokenInputSchema("yandex"),
  })
  .strict();

export const SeoEditorSettingsPatchSchema = z
  .object({
    separator: SearchAppearanceSeparatorSchema.optional(),
    templates: SearchAppearanceTemplatesPatchSchema.optional(),
    verification: VerificationTokensPatchSchema.optional(),
    version: z.number().int().min(1).max(2_147_483_647).optional(),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

export type SeoEditorSettingsPatchInput = z.infer<typeof SeoEditorSettingsPatchSchema>;

export const RecordExternalVerificationSchema = z
  .object({
    provider: z.enum(VERIFICATION_PROVIDERS),
    verifiedHost: z
      .string()
      .trim()
      .min(3)
      .max(253)
      .refine((v) => !hasControlChars(v) && !DISALLOWED_HTML_TAG_RE.test(v), "Host tidak valid."),
    note: PlainSeoTextFieldSchema(240, "Catatan verifikasi").nullable().optional(),
    version: z.number().int().min(1).max(2_147_483_647).optional(),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

export type RecordExternalVerificationInput = z.infer<typeof RecordExternalVerificationSchema>;

export const SeoEditorOverrideInputSchema = z
  .object({
    titleOverride: OptionalOverrideTemplateFieldSchema(
      MAX_SEO_OVERRIDE_TITLE_LENGTH,
      "Judul SEO",
    )
      .nullable()
      .optional(),
    descriptionOverride: OptionalOverrideTemplateFieldSchema(
      MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH,
      "Deskripsi meta",
    )
      .nullable()
      .optional(),
    focusKeyphrase: PlainSeoTextFieldSchema(MAX_SEO_FOCUS_KEYPHRASE_LENGTH, "Frasa kunci fokus")
      .nullable()
      .optional(),
    ogTitleOverride: PlainSeoTextFieldSchema(MAX_SEO_OVERRIDE_TITLE_LENGTH, "Judul Open Graph")
      .nullable()
      .optional(),
    ogDescriptionOverride: PlainSeoTextFieldSchema(
      MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH,
      "Deskripsi Open Graph",
    )
      .nullable()
      .optional(),
    ogImageMediaId: z.number().int().min(1).max(2_147_483_647).nullable().optional(),
    schemaType: z
      .enum([
        "WebPage",
        "AboutPage",
        "ContactPage",
        "CollectionPage",
        "FAQPage",
        "BlogPosting",
        "Article",
        "NewsArticle",
        "Service",
        "Product",
        "TouristTrip",
      ])
      .nullable()
      .optional(),
    noindex: z.boolean().optional(),
    nofollow: z.boolean().optional(),
  })
  .strict();

export type SeoEditorOverrideInput = z.infer<typeof SeoEditorOverrideInputSchema>;

export const ResourceSeoUpdateRequestSchema = z
  .object({
    seo: SeoEditorOverrideInputSchema.optional(),
    indexOptIn: z.boolean().optional(),
    version: z.number().int().min(1).max(2_147_483_647).optional(),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

export type ResourceSeoUpdateRequest = z.infer<typeof ResourceSeoUpdateRequestSchema>;

export const SeoAutopilotPluginConfigSchema = z
  .object({
    separator: SearchAppearanceSeparatorSchema.optional(),
    templates: SearchAppearanceTemplatesPatchSchema.optional(),
    verification: VerificationTokensPatchSchema.optional(),
    autoIndexNow: z.boolean().optional(),
  })
  .strict();

export type SeoAutopilotPluginConfig = z.infer<typeof SeoAutopilotPluginConfigSchema>;

// ---------------------------------------------------------------------------
// 5. Effective SEO Preview, Inheritance & Indexability Reasons (REQ-053)
// ---------------------------------------------------------------------------

export interface EffectiveSeoPreviewInput {
  readonly tenant: VerifiedTenantHostInput;
  readonly siteName: string;
  readonly tagline?: string | null;
  readonly siteDefaultTitle?: string | null;
  readonly siteDefaultDescription?: string | null;
  readonly siteDefaultOgMediaId?: number | null;
  readonly siteVisibility: SiteVisibility;
  readonly searchAppearance?: SearchAppearanceSettings | null;
  readonly resourceKind: SeoEditorResourceKind;
  readonly searchAppearanceKind: SearchAppearanceKind;
  readonly routeKind: SeoRouteKind;
  readonly pathname: string;
  readonly resourceTitle: string;
  readonly resourceExcerpt?: string | null;
  readonly categoryName?: string | null;
  readonly resourceFeaturedMediaId?: number | null;
  readonly publicationState: "published" | "draft" | "trashed";
  readonly seo: SeoEditorOverrideInput | ResourceSeoOverrides | null;
  readonly taxonomyOptIn?: boolean;
  readonly archiveItemCount?: number;
  readonly offeringType?: OfferingType | null;
  readonly hasVisibleFaqBlock?: boolean;
  readonly priceMode?: "fixed" | "from" | "range" | "on_request" | null;
  readonly price?: number | null;
  readonly hasVisibleItinerary?: boolean;
}

export type FieldInheritanceState = "overridden" | "inherited" | "default";

export interface IndexabilityReasonItem {
  readonly code: SeoDecisionReason | "resource_nofollow";
  readonly severity: "info" | "warning";
  readonly message: string;
}

export interface EffectiveSeoPreviewResult {
  readonly effectiveTitle: string;
  readonly effectiveDescription: string;
  readonly effectiveOgTitle: string;
  readonly effectiveOgDescription: string;
  readonly effectiveOgImageMediaId: number | null;
  readonly ogImageSource: "resource_og_override" | "resource_featured" | "tenant_default" | "generated_fallback";
  readonly twitterCard: "summary_large_image";
  readonly canonicalUrl: string | null;
  readonly displayUrlPreview: string;
  readonly effectiveSchemaType: AllowedResourceSchemaType | null;
  readonly schemaDowngradeWarning: string | null;
  readonly effectiveIndexable: boolean;
  readonly robotsMeta: string;
  readonly decision: PublishedSeoDecision;
  readonly indexabilityReasons: readonly IndexabilityReasonItem[];
  readonly siteWideNoindexDominates: boolean;
  readonly isFallbackDescriptionWarning: boolean;
  readonly fieldStates: {
    readonly title: FieldInheritanceState;
    readonly description: FieldInheritanceState;
    readonly ogTitle: FieldInheritanceState;
    readonly ogDescription: FieldInheritanceState;
    readonly ogImage: FieldInheritanceState;
    readonly schemaType: FieldInheritanceState;
    readonly noindex: FieldInheritanceState;
    readonly nofollow: FieldInheritanceState;
  };
}

function describeDecisionReasonId(reason: SeoDecisionReason): IndexabilityReasonItem {
  switch (reason) {
    case "indexable_published":
      return {
        code: reason,
        severity: "info",
        message: "Konten terbit dan memenuhi syarat untuk diindeks mesin pencari.",
      };
    case "trial_tenant_noindex":
      return {
        code: reason,
        severity: "warning",
        message:
          "Situs dalam masa uji coba (trial) selalu memancarkan noindex, nofollow di subdomain platform.",
      };
    case "site_wide_noindex":
      return {
        code: reason,
        severity: "warning",
        message:
          "Kebijakan situs menyeluruh (Pengaturan > SEO) menonaktifkan indeks. Kebijakan situs selalu menimpa pengaturan per halaman.",
      };
    case "resource_noindex":
      return {
        code: reason,
        severity: "warning",
        message: "Halaman ini ditandai noindex secara manual dan tidak masuk ke /sitemap.xml.",
      };
    case "resource_not_published":
      return {
        code: reason,
        severity: "info",
        message: "Konten masih berstatus draf atau sampah — belum tayang ke publik maupun sitemap.",
      };
    case "taxonomy_default_noindex":
      return {
        code: reason,
        severity: "warning",
        message:
          "Arsip kategori/tag bawaan berstatus noindex hingga Anda memilih ikut indeks dan memiliki konten terbit.",
      };
    case "empty_taxonomy_noindex":
    case "empty_archive_noindex":
      return {
        code: reason,
        severity: "warning",
        message:
          "Arsip tanpa konten terbit selalu berstatus noindex otomatis agar tidak menghasilkan halaman tipis.",
      };
    case "tenant_suspended":
    case "tenant_recovery":
      return {
        code: reason,
        severity: "warning",
        message: "Situs sedang ditangguhkan (HTTP 503, noindex) hingga layanan dipulihkan.",
      };
    default:
      return {
        code: reason,
        severity: "info",
        message: `Status kebijakan SEO: ${reason}.`,
      };
  }
}

export function resolveEffectiveSeoPreview(
  input: EffectiveSeoPreviewInput,
): EffectiveSeoPreviewResult {
  const appearance = input.searchAppearance ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS;
  const pair =
    appearance.templates[input.searchAppearanceKind] ??
    DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates[input.searchAppearanceKind];

  const tokenValues: SearchAppearanceTokenValues = {
    title: input.resourceTitle,
    site_name: input.siteName,
    tagline: input.tagline ?? "",
    sep: appearance.separator,
    category: input.categoryName ?? "",
    excerpt: input.resourceExcerpt ?? "",
    page: 1,
  };

  const rawTitleOverride = input.seo?.titleOverride?.trim() || null;
  const rawDescriptionOverride = input.seo?.descriptionOverride?.trim() || null;

  const templatedTitle = renderSearchAppearanceTemplate(
    rawTitleOverride ?? pair.titleTemplate,
    tokenValues,
  );
  const templatedDescription = renderSearchAppearanceTemplate(
    rawDescriptionOverride ?? pair.descriptionTemplate,
    tokenValues,
  );

  // Respect PLAN §15.3 title & description precedence via TASK-051 helper
  const resolvedText = resolveEffectiveSeoText({
    isHomepage: input.routeKind === "homepage",
    resourceTitle: input.resourceTitle,
    resourceTitleOverride:
      templatedTitle || (input.routeKind === "homepage" ? input.siteDefaultTitle ?? null : null),
    resourceDescriptionOverride: rawDescriptionOverride ? templatedDescription : null,
    resourceExcerpt: templatedDescription || input.resourceExcerpt || null,
    siteTitle: input.siteName,
    siteTagline: input.siteDefaultDescription ?? input.tagline ?? null,
    separator: appearance.separator,
  });

  const isFallbackDescriptionWarning =
    !rawDescriptionOverride && !(input.resourceExcerpt && input.resourceExcerpt.trim().length > 0);

  const decision = resolvePublishedSeoDecision({
    surface: "public_tenant",
    routeKind: input.routeKind,
    tenant: input.tenant,
    pathname: input.pathname,
    resourceState: input.publicationState,
    siteVisibility: input.siteVisibility,
    resourceSeo: {
      noindex: Boolean(input.seo?.noindex),
      nofollow: Boolean(input.seo?.nofollow),
    },
    taxonomyIndexOptIn: input.taxonomyOptIn,
    taxonomyHasUsefulIntro: Boolean(
      input.resourceExcerpt && input.resourceExcerpt.trim().length > 0,
    ),
    publishedItemCount: input.archiveItemCount,
  });

  // Also compute projected preview URL when content is still a draft so editor sees future canonical path
  let displayUrlPreview = decision.canonical ?? "";
  if (!displayUrlPreview) {
    const cleanHost = (input.tenant.primaryHost || `${input.tenant.tenantHandle}.situsku.click`)
      .trim()
      .toLowerCase();
    const cleanPath = input.pathname.startsWith("/") ? input.pathname : `/${input.pathname}`;
    displayUrlPreview = `https://${cleanHost}${cleanPath === "/" ? "/" : cleanPath.replace(/\/+$/, "")}`;
  }

  const reasons: IndexabilityReasonItem[] = [describeDecisionReasonId(decision.reason)];
  const siteWideNoindexDominates =
    input.siteVisibility === "noindex" || input.tenant.tenantStatus === "trial";

  if (
    decision.reason === "resource_not_published" &&
    input.siteVisibility === "noindex"
  ) {
    reasons.push(describeDecisionReasonId("site_wide_noindex"));
  }
  if (
    decision.reason === "resource_not_published" &&
    input.tenant.tenantStatus === "trial"
  ) {
    reasons.push(describeDecisionReasonId("trial_tenant_noindex"));
  }
  if (
    decision.reason === "resource_not_published" &&
    input.seo?.noindex
  ) {
    reasons.push(describeDecisionReasonId("resource_noindex"));
  }
  if (input.seo?.nofollow) {
    reasons.push({
      code: "resource_nofollow",
      severity: "info",
      message: "Tautan pada halaman ini ditandai nofollow (mesin pencari tidak mengikuti tautan keluar).",
    });
  }

  const rawOgTitle = input.seo?.ogTitleOverride?.trim() || null;
  const rawOgDesc = input.seo?.ogDescriptionOverride?.trim() || null;

  let effectiveOgImageMediaId: number | null = null;
  let ogImageSource: EffectiveSeoPreviewResult["ogImageSource"] = "generated_fallback";
  if (input.seo?.ogImageMediaId) {
    effectiveOgImageMediaId = input.seo.ogImageMediaId;
    ogImageSource = "resource_og_override";
  } else if (input.resourceFeaturedMediaId) {
    effectiveOgImageMediaId = input.resourceFeaturedMediaId;
    ogImageSource = "resource_featured";
  } else if (input.siteDefaultOgMediaId) {
    effectiveOgImageMediaId = input.siteDefaultOgMediaId;
    ogImageSource = "tenant_default";
  }

  const requestedSchema = input.seo?.schemaType ?? null;
  const publishSafeSchema = resolvePublishSafeSchemaType(requestedSchema, {
    resourceKind: input.resourceKind,
    offeringType: input.offeringType,
    hasVisibleFaqBlock: input.hasVisibleFaqBlock,
    priceMode: input.priceMode,
    price: input.price,
    hasVisibleItinerary: input.hasVisibleItinerary,
  });
  const effectiveSchemaType = publishSafeSchema.schemaType;

  return {
    effectiveTitle: resolvedText.title,
    effectiveDescription: resolvedText.description,
    effectiveOgTitle: rawOgTitle ?? resolvedText.title,
    effectiveOgDescription: rawOgDesc ?? resolvedText.description,
    effectiveOgImageMediaId,
    ogImageSource,
    twitterCard: "summary_large_image",
    canonicalUrl: decision.canonical,
    displayUrlPreview,
    effectiveSchemaType,
    schemaDowngradeWarning: publishSafeSchema.downgraded ? publishSafeSchema.reason : null,
    effectiveIndexable: decision.indexable,
    robotsMeta: decision.robotsMeta,
    decision,
    indexabilityReasons: reasons,
    siteWideNoindexDominates,
    isFallbackDescriptionWarning,
    fieldStates: {
      title: rawTitleOverride ? "overridden" : "inherited",
      description: rawDescriptionOverride
        ? "overridden"
        : input.resourceExcerpt?.trim()
          ? "inherited"
          : "default",
      ogTitle: rawOgTitle ? "overridden" : "inherited",
      ogDescription: rawOgDesc ? "overridden" : "inherited",
      ogImage: input.seo?.ogImageMediaId
        ? "overridden"
        : effectiveOgImageMediaId
          ? "inherited"
          : "default",
      schemaType: requestedSchema ? "overridden" : "default",
      noindex: input.seo?.noindex ? "overridden" : "default",
      nofollow: input.seo?.nofollow ? "overridden" : "default",
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Advisory Content Checklist — Zero Numeric Score, Never Blocks Publish (PLAN §15.3 & §15.7)
// ---------------------------------------------------------------------------

export interface SeoChecklistContentImage {
  readonly altText: string;
  readonly isDecorative?: boolean;
}

export interface PeerPublishedSeoSummary {
  readonly resourceKind: SeoEditorResourceKind;
  readonly resourceId: number;
  readonly title: string;
  readonly effectiveTitle: string;
  readonly effectiveDescription: string;
  readonly focusKeyphrase: string | null;
  readonly pathname: string;
}

export interface SeoChecklistInput {
  readonly resourceKind: SeoEditorResourceKind;
  readonly effectiveTitle: string;
  readonly effectiveDescription: string;
  readonly isFallbackDescription: boolean;
  readonly slug: string;
  readonly focusKeyphrase?: string | null;
  readonly firstParagraphText?: string | null;
  readonly headings?: readonly { readonly level: number; readonly text: string }[];
  readonly plainTextBody?: string | null;
  readonly internalLinkCount?: number;
  readonly images?: readonly SeoChecklistContentImage[];
  readonly publishedPeers?: readonly PeerPublishedSeoSummary[];
  readonly slugChangedWhilePublished?: boolean;
  readonly oldPublishedSlug?: string | null;
  readonly noindex?: boolean;
}

export type SeoChecklistItemStatus = "pass" | "advisory";

export interface SeoChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly status: SeoChecklistItemStatus;
  readonly blocking: false; // Hard invariant: advisory checklist NEVER blocks save or publish
  readonly detail: string;
}

export interface SlugChangeNotice {
  readonly active: boolean;
  readonly oldSlug: string;
  readonly newSlug: string;
  readonly message: string;
}

export interface NoindexNotice {
  readonly active: boolean;
  readonly message: string;
}

export interface SeoChecklistResult {
  readonly passedCount: number;
  readonly totalCount: number;
  readonly summaryLabel: string;
  readonly blocking: false;
  readonly items: readonly SeoChecklistItem[];
  readonly slugChangeNotice: SlugChangeNotice | null;
  readonly noindexNotice: NoindexNotice | null;
}

export function buildSlugChangeWarning(oldSlug: string, newSlug: string): SlugChangeNotice {
  return {
    active: true,
    oldSlug,
    newSlug,
    message:
      `URL lama (/${oldSlug}) akan dialihkan permanen (HTTP 308) ke URL baru (/${newSlug}) selama konten tetap terbit. ` +
      "Mesin pencari memerlukan waktu untuk mengonsolidasikan sinyal pencarian, dan melepaskan slug lama di kemudian hari dapat memutus tautan lama. " +
      "Perubahan URL tidak disertai jaminan peringkat tetap sama.",
  };
}

export function buildNoindexWarning(): NoindexNotice {
  return {
    active: true,
    message:
      "Mengaktifkan noindex menghapus konten ini dari /sitemap.xml dan meminta mesin pencari tidak menampilkannya, " +
      "tetapi konten tetap dapat diakses publik melalui tautan langsung (noindex bukan privasi atau kata sandi). " +
      "Penghapusan dari hasil pencarian yang sudah terindeks juga memerlukan waktu.",
  };
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyPhrase(value: string): string {
  return normalizeForMatch(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countWords(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

/**
 * Extracts structural text, headings, internal link count, and images from a
 * RestrictedRichTextDoc so the advisory checklist works consistently on client and server.
 */
export function extractChecklistSignalsFromRichTextDoc(
  doc: RestrictedRichTextDoc | null | undefined,
  primaryHost?: string | null,
): {
  readonly firstParagraphText: string;
  readonly headings: readonly { readonly level: number; readonly text: string }[];
  readonly plainTextBody: string;
  readonly internalLinkCount: number;
  readonly images: readonly SeoChecklistContentImage[];
} {
  if (!doc || !Array.isArray(doc.blocks)) {
    return {
      firstParagraphText: "",
      headings: [],
      plainTextBody: "",
      internalLinkCount: 0,
      images: [],
    };
  }

  let firstParagraphText = "";
  const headings: Array<{ readonly level: number; readonly text: string }> = [];
  const textParts: string[] = [];
  let internalLinkCount = 0;
  const images: SeoChecklistContentImage[] = [];
  const normalizedHost = primaryHost?.trim().toLowerCase() ?? "";

  for (const block of doc.blocks) {
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      textParts.push(text);
    }

    if (block.type === "paragraph" && !firstParagraphText && text) {
      firstParagraphText = text;
    }

    if (block.type === "heading" && text) {
      headings.push({ level: block.level ?? 2, text });
    }

    if (block.href && typeof block.href === "string") {
      const href = block.href.trim();
      if (href.startsWith("/") && !href.startsWith("//")) {
        internalLinkCount += 1;
      } else if (normalizedHost) {
        try {
          const parsed = new URL(href);
          if (parsed.hostname.toLowerCase() === normalizedHost) {
            internalLinkCount += 1;
          }
        } catch {
          // ignore malformed href
        }
      }
    }

    if (block.type === "image") {
      images.push({
        altText: text,
        isDecorative: false,
      });
    }
  }

  return {
    firstParagraphText,
    headings,
    plainTextBody: textParts.join(" "),
    internalLinkCount,
    images,
  };
}

/**
 * Evaluates structural & focus-keyphrase SEO guidance (PLAN §15.3 & §15.7).
 * - NEVER emits a numeric score (e.g. 0–100) or ranking promise.
 * - NEVER blocks saving or publishing (`blocking: false`).
 * - Deliberately omits Indonesian readability formulas (PLAN §15.7).
 */
export function evaluateSeoChecklist(input: SeoChecklistInput): SeoChecklistResult {
  const items: SeoChecklistItem[] = [];
  const titleLen = input.effectiveTitle.trim().length;
  const descLen = input.effectiveDescription.trim().length;

  // 1. Title length range (45–60 recommended)
  items.push({
    id: "title_length",
    label: "Panjang judul SEO",
    status:
      titleLen >= RECOMMENDED_TITLE_MIN && titleLen <= RECOMMENDED_TITLE_MAX
        ? "pass"
        : "advisory",
    blocking: false,
    detail:
      titleLen === 0
        ? "Judul efektif masih kosong."
        : titleLen < RECOMMENDED_TITLE_MIN
          ? `Judul efektif saat ini ${titleLen} karakter (saran ${RECOMMENDED_TITLE_MIN}–${RECOMMENDED_TITLE_MAX} karakter; mesin pencari dapat menyesuaikannya).`
          : titleLen > RECOMMENDED_TITLE_MAX
            ? `Judul efektif saat ini ${titleLen} karakter (saran ${RECOMMENDED_TITLE_MIN}–${RECOMMENDED_TITLE_MAX} karakter agar tidak terpotong di hasil pencarian).`
            : `Judul efektif ${titleLen} karakter (dalam rentang saran ${RECOMMENDED_TITLE_MIN}–${RECOMMENDED_TITLE_MAX} karakter).`,
  });

  // 2. Description length & fallback check (120–160 recommended)
  items.push({
    id: "description_length",
    label: "Panjang & ringkasan deskripsi meta",
    status:
      !input.isFallbackDescription &&
      descLen >= RECOMMENDED_DESCRIPTION_MIN &&
      descLen <= RECOMMENDED_DESCRIPTION_MAX
        ? "pass"
        : "advisory",
    blocking: false,
    detail: input.isFallbackDescription
      ? "Saat ini memakai deskripsi bawaan situs. Tambahkan ringkasan spesifik agar setiap halaman memiliki deskripsi unik."
      : descLen < RECOMMENDED_DESCRIPTION_MIN
        ? `Deskripsi meta ${descLen} karakter (saran ${RECOMMENDED_DESCRIPTION_MIN}–${RECOMMENDED_DESCRIPTION_MAX} karakter; mesin pencari dapat menulis ulang cuplikan).`
        : descLen > RECOMMENDED_DESCRIPTION_MAX
          ? `Deskripsi meta ${descLen} karakter (saran ${RECOMMENDED_DESCRIPTION_MIN}–${RECOMMENDED_DESCRIPTION_MAX} karakter agar tidak terpotong).`
          : `Deskripsi meta ${descLen} karakter dan spesifik untuk konten ini.`,
  });

  // 3. Focus keyphrase checks (when provided)
  const rawKeyphrase = input.focusKeyphrase?.trim() ?? "";
  const normKeyphrase = normalizeForMatch(rawKeyphrase);
  if (normKeyphrase) {
    const normTitle = normalizeForMatch(input.effectiveTitle);
    items.push({
      id: "keyphrase_in_title",
      label: "Frasa kunci pada judul",
      status: normTitle.includes(normKeyphrase) ? "pass" : "advisory",
      blocking: false,
      detail: normTitle.includes(normKeyphrase)
        ? `Frasa kunci "${rawKeyphrase}" sudah muncul di judul efektif.`
        : `Pertimbangkan menyertakan "${rawKeyphrase}" secara alami di judul.`,
    });

    const normDesc = normalizeForMatch(input.effectiveDescription);
    items.push({
      id: "keyphrase_in_description",
      label: "Frasa kunci pada deskripsi meta",
      status: normDesc.includes(normKeyphrase) ? "pass" : "advisory",
      blocking: false,
      detail: normDesc.includes(normKeyphrase)
        ? `Frasa kunci "${rawKeyphrase}" sudah muncul di deskripsi meta.`
        : `Pertimbangkan menyebut "${rawKeyphrase}" secara ringkas di deskripsi meta.`,
    });

    const slugKeyphrase = slugifyPhrase(rawKeyphrase);
    const normSlug = slugifyPhrase(input.slug);
    const inSlug = Boolean(slugKeyphrase) && normSlug.includes(slugKeyphrase);
    items.push({
      id: "keyphrase_in_slug",
      label: "Frasa kunci pada slug URL",
      status: inSlug ? "pass" : "advisory",
      blocking: false,
      detail: inSlug
        ? `Slug "/${input.slug}" sudah memuat frasa kunci.`
        : `Slug "/${input.slug}" belum memuat frasa kunci "${slugKeyphrase}".`,
    });

    const normFirstPara = normalizeForMatch(input.firstParagraphText ?? "");
    const inFirstPara = Boolean(normFirstPara) && normFirstPara.includes(normKeyphrase);
    items.push({
      id: "keyphrase_in_first_paragraph",
      label: "Frasa kunci pada paragraf pembuka",
      status: inFirstPara ? "pass" : "advisory",
      blocking: false,
      detail: inFirstPara
        ? "Paragraf pembuka sudah memuat frasa kunci fokus."
        : "Pertimbangkan memperkenalkan topik/frasa kunci fokus di paragraf pertama secara alami.",
    });

    const h2Headings = (input.headings ?? []).filter((h) => h.level === 2);
    const inH2 = h2Headings.some((h) => normalizeForMatch(h.text).includes(normKeyphrase));
    items.push({
      id: "keyphrase_in_h2",
      label: "Frasa kunci pada subjudul H2",
      status: inH2 ? "pass" : "advisory",
      blocking: false,
      detail: inH2
        ? "Setidaknya satu subjudul H2 memuat frasa kunci fokus."
        : "Pertimbangkan memasukkan frasa kunci fokus pada salah satu subjudul H2 jika relevan.",
    });

    // Cannibalization check against other published resources of the SAME tenant
    const cannibalPeer = (input.publishedPeers ?? []).find(
      (peer) =>
        peer.focusKeyphrase && normalizeForMatch(peer.focusKeyphrase) === normKeyphrase,
    );
    items.push({
      id: "keyphrase_cannibalization",
      label: "Keunikan frasa kunci antar konten terbit",
      status: cannibalPeer ? "advisory" : "pass",
      blocking: false,
      detail: cannibalPeer
        ? `Peringatan kanibalisasi: frasa kunci "${rawKeyphrase}" sudah dipakai oleh konten terbit "${cannibalPeer.title}" (${cannibalPeer.pathname}).`
        : "Belum ada konten terbit lain di situs ini yang memakai frasa kunci fokus yang sama.",
    });
  }

  // 4. Internal link presence
  const internalLinks = input.internalLinkCount ?? 0;
  items.push({
    id: "internal_link_present",
    label: "Tautan internal antar halaman situs",
    status: internalLinks >= 1 ? "pass" : "advisory",
    blocking: false,
    detail:
      internalLinks >= 1
        ? `Ditemukan ${internalLinks} tautan internal ke halaman di situs Anda.`
        : "Tambahkan minimal satu tautan internal ke halaman layanan, katalog, atau artikel relevan.",
  });

  // 5. Meaningful ALT text on non-decorative images
  const images = input.images ?? [];
  const missingAltCount = images.filter(
    (img) => !img.isDecorative && img.altText.trim().length === 0,
  ).length;
  items.push({
    id: "images_alt_text",
    label: "Teks ALT pada gambar bermakna",
    status: missingAltCount === 0 ? "pass" : "advisory",
    blocking: false,
    detail:
      images.length === 0
        ? "Tidak ada gambar bermakna yang kekurangan teks ALT."
        : missingAltCount === 0
          ? `Semua ${images.length} gambar bermakna sudah memiliki teks ALT (gambar dekoratif boleh dikosongkan).`
          : `${missingAltCount} gambar bermakna belum memiliki teks ALT deskriptif.`,
  });

  // 6. Heading order check (no skipped levels like H2 -> H4)
  const headings = input.headings ?? [];
  let headingOrderOk = true;
  let prevLevel = 1;
  for (const h of headings) {
    if (h.level > prevLevel + 1) {
      headingOrderOk = false;
      break;
    }
    prevLevel = h.level;
  }
  items.push({
    id: "heading_hierarchy",
    label: "Urutan subjudul (H2–H4)",
    status: headingOrderOk ? "pass" : "advisory",
    blocking: false,
    detail: headingOrderOk
      ? "Urutan struktur subjudul sudah runtut."
      : "Ditemukan lompatan tingkat subjudul (misalnya langsung dari H2 ke H4 tanpa H3). Rapikan urutan agar mudah dibaca pengunjung dan mesin pencari.",
  });

  // 7. Content length hint (structural, no readability score)
  const minWords = input.resourceKind === "post" ? 150 : 50;
  const wordCount = countWords(input.plainTextBody ?? "");
  items.push({
    id: "content_length_hint",
    label: "Kelengkapan isi konten",
    status: wordCount >= minWords ? "pass" : "advisory",
    blocking: false,
    detail:
      wordCount >= minWords
        ? `Panjang teks sekitar ${wordCount} kata — cukup informatif untuk pembaca.`
        : `Panjang teks saat ini sekitar ${wordCount} kata (saran minimal ~${minWords} kata yang menjawab kebutuhan pengunjung secara nyata).`,
  });

  // 8. Duplicate effective title / description across published peer resources of the tenant
  const normEffectiveTitle = normalizeForMatch(input.effectiveTitle);
  const dupTitlePeer =
    normEffectiveTitle.length > 0
      ? (input.publishedPeers ?? []).find(
          (peer) => normalizeForMatch(peer.effectiveTitle) === normEffectiveTitle,
        )
      : undefined;
  items.push({
    id: "duplicate_title_warning",
    label: "Keunikan judul SEO",
    status: dupTitlePeer ? "advisory" : "pass",
    blocking: false,
    detail: dupTitlePeer
      ? `Judul efektif sama dengan konten terbit "${dupTitlePeer.title}" (${dupTitlePeer.pathname}). Buat judul unik untuk tiap URL.`
      : "Judul efektif unik dibandingkan konten terbit lain di situs ini.",
  });

  const normEffectiveDesc = normalizeForMatch(input.effectiveDescription);
  const dupDescPeer =
    normEffectiveDesc.length > 0
      ? (input.publishedPeers ?? []).find(
          (peer) => normalizeForMatch(peer.effectiveDescription) === normEffectiveDesc,
        )
      : undefined;
  items.push({
    id: "duplicate_description_warning",
    label: "Keunikan deskripsi meta",
    status: dupDescPeer ? "advisory" : "pass",
    blocking: false,
    detail: dupDescPeer
      ? `Deskripsi meta sama dengan konten terbit "${dupDescPeer.title}" (${dupDescPeer.pathname}).`
      : "Deskripsi meta unik dibandingkan konten terbit lain di situs ini.",
  });

  const passedCount = items.filter((item) => item.status === "pass").length;
  const totalCount = items.length;

  return {
    passedCount,
    totalCount,
    summaryLabel: `${passedCount} dari ${totalCount} saran terpenuhi`,
    blocking: false,
    items,
    slugChangeNotice:
      input.slugChangedWhilePublished && input.oldPublishedSlug
        ? buildSlugChangeWarning(input.oldPublishedSlug, input.slug)
        : null,
    noindexNotice: input.noindex ? buildNoindexWarning() : null,
  };
}

// ---------------------------------------------------------------------------
// 7. Google Business Profile & Bing Places 1-Click Copy Formatter (DESIGN §8)
// ---------------------------------------------------------------------------

export interface BusinessDirectoryCopyInput {
  readonly businessName: string;
  readonly businessCategory?: string | null;
  readonly description?: string | null;
  readonly primaryOrigin: string;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly phone?: string | null;
  readonly whatsappE164?: string | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
}

/**
 * Formats ONLY factual owner-supplied business details for 1-click copy into
 * Google Business Profile & Bing Places (never fabricates addresses or private data).
 */
export function buildDirectoryListingCopyText(input: BusinessDirectoryCopyInput): string {
  const lines: string[] = [
    `Nama Bisnis: ${sanitizeSeoText(input.businessName, { maxLength: 160 })}`,
    `Situs Web: ${input.primaryOrigin}`,
  ];
  if (input.businessCategory?.trim()) {
    lines.push(`Kategori: ${sanitizeSeoText(input.businessCategory, { maxLength: 80 })}`);
  }
  const addressParts = [input.address, input.city, input.province, input.postalCode]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  if (addressParts.length > 0) {
    lines.push(`Alamat Publik: ${sanitizeSeoText(addressParts.join(", "), { maxLength: 300 })}`);
  }
  if (input.phone?.trim()) {
    lines.push(`Telepon: ${sanitizeSeoText(input.phone, { maxLength: 40 })}`);
  }
  if (input.whatsappE164?.trim()) {
    lines.push(`WhatsApp: +${input.whatsappE164.replace(/^\+/, "")}`);
  }
  if (input.weekdayHours?.trim()) {
    lines.push(`Jam Operasional: ${sanitizeSeoText(input.weekdayHours, { maxLength: 160 })}`);
  }
  if (input.holidayHours?.trim()) {
    lines.push(`Jam Akhir Pekan/Libur: ${sanitizeSeoText(input.holidayHours, { maxLength: 160 })}`);
  }
  if (input.description?.trim()) {
    lines.push(`Deskripsi Singkat: ${sanitizeSeoText(input.description, { maxLength: 500 })}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 8. Complete Tenant SEO Editor Settings Snapshot Types
// ---------------------------------------------------------------------------

export interface TenantSeoEditorSettingsState {
  readonly searchAppearance: SearchAppearanceSettings;
  readonly verificationTokens: VerificationTokensConfig;
  readonly externalVerifications: ExternalVerificationRecordsMap;
}

export function createDefaultTenantSeoEditorSettingsState(): TenantSeoEditorSettingsState {
  return {
    searchAppearance: {
      separator: DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator,
      templates: { ...DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates },
    },
    verificationTokens: {
      google: null,
      bing: null,
      yandex: null,
    },
    externalVerifications: {
      google: null,
      bing: null,
      yandex: null,
    },
  };
}

export function mergeSearchAppearanceSettings(
  base: SearchAppearanceSettings,
  patch: {
    readonly separator?: SearchAppearanceSeparator;
    readonly templates?: Partial<Record<SearchAppearanceKind, Partial<SearchAppearanceTemplatePair>>>;
  },
): SearchAppearanceSettings {
  const nextTemplates: Record<SearchAppearanceKind, SearchAppearanceTemplatePair> = {
    ...DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates,
    ...(base?.templates ?? {}),
  };
  if (patch.templates && typeof patch.templates === "object") {
    for (const kind of SEARCH_APPEARANCE_KINDS) {
      const override = patch.templates[kind];
      if (override && typeof override === "object") {
        const prev = nextTemplates[kind] ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates[kind];
        const nextTitle =
          typeof override.titleTemplate === "string" && override.titleTemplate.trim()
            ? override.titleTemplate.trim()
            : prev.titleTemplate;
        const nextDesc =
          typeof override.descriptionTemplate === "string" && override.descriptionTemplate.trim()
            ? override.descriptionTemplate.trim()
            : prev.descriptionTemplate;
        nextTemplates[kind] = {
          titleTemplate: nextTitle,
          descriptionTemplate: nextDesc,
        };
      }
    }
  }
  const validSep =
    patch.separator &&
    (SEARCH_APPEARANCE_SEPARATORS as readonly string[]).includes(patch.separator)
      ? patch.separator
      : (SEARCH_APPEARANCE_SEPARATORS as readonly string[]).includes(base?.separator)
        ? base.separator
        : DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator;
  return {
    separator: validSep,
    templates: nextTemplates,
  };
}

export function isTenantStatusReadOnlyForSeo(status: SeoTenantStatus): boolean {
  return (
    status === "locked" ||
    status === "suspended" ||
    status === "recovery" ||
    status === "purging" ||
    status === "purged" ||
    status === "destroyed"
  );
}
