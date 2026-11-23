import { sanitizeNavigationHref } from "@punyasitus/core/content/index";
import {
  CLOSED_SECTION_TYPES,
  convertPublicPageSectionDtoToSectionInput,
  isClosedSectionType,
  isSingletonSectionType,
  PLATFORM_THEME_SECTION_PROFILES,
  resolveThemeSectionProfile,
  SectionRegistryValidationError,
  switchPageThemeLosslessly,
  validatePageSections,
  verifyPreviewPublishedSectionParity,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type LosslessThemeSwitchResult,
  type PlatformThemeId,
  type PlatformThemeSectionProfile,
  type PreviewPublishedParityResult,
  type PublicPageSectionDtoInput,
  type SectionOfferingItem,
  type SectionValidationWarning,
  type ValidatedPageSection,
} from "@punyasitus/core/theme/index";
import {
  buildWhatsAppUrl,
  formatOfferingPrice,
  normalizeIndonesianWhatsAppNumber,
} from "@punyasitus/core/wa-dispatcher";

/**
 * Web-Layer Closed Unified Section Registry & Dynamic Page Assembly Engine
 * (REQ-018, REQ-019, REQ-036, REQ-040; PLAN §7.3, §11.4, §14; TASK-013).
 *
 * Boundaries:
 * - Static closed mapping from section types to Astro component keys (zero
 *   dynamic paths, zero tenant-supplied code, zero React/admin/DB imports).
 * - Identical assembly pipeline for `/` (homepage) and `/{pageSlug}` (static pages),
 *   and identical order/toggle evaluation for preview DTOs and published snapshots.
 */

export const SECTION_COMPONENT_KEYS = [
  "SectionHero",
  "SectionFeatures",
  "SectionOfferingsGrid",
  "SectionRichText",
  "SectionGallery",
  "SectionTestimonials",
  "SectionFaq",
  "SectionBlogLatest",
  "SectionCtaBanner",
  "SectionContactLocation",
] as const;

export type SectionComponentKey = (typeof SECTION_COMPONENT_KEYS)[number];

export interface SectionRegistryEntry {
  readonly type: ClosedSectionType;
  readonly componentKey: SectionComponentKey;
  readonly labelId: string;
  readonly singleton: boolean;
  readonly defaultOfferingType?: "service" | "product" | "tour" | "vehicle";
}

export const SECTION_REGISTRY_MAP: Readonly<Record<ClosedSectionType, SectionRegistryEntry>> =
  Object.freeze({
    hero: {
      type: "hero",
      componentKey: "SectionHero",
      labelId: "Banner Utama (Hero)",
      singleton: true,
    },
    features: {
      type: "features",
      componentKey: "SectionFeatures",
      labelId: "Keunggulan & Fitur",
      singleton: false,
    },
    highlights: {
      type: "highlights",
      componentKey: "SectionFeatures",
      labelId: "Sorotan Utama",
      singleton: false,
    },
    trust_logos: {
      type: "trust_logos",
      componentKey: "SectionFeatures",
      labelId: "Mitra & Kredensial",
      singleton: false,
    },
    team: {
      type: "team",
      componentKey: "SectionFeatures",
      labelId: "Tim & Spesialis",
      singleton: false,
    },
    offerings_grid: {
      type: "offerings_grid",
      componentKey: "SectionOfferingsGrid",
      labelId: "Daftar Penawaran",
      singleton: false,
    },
    services_grid: {
      type: "services_grid",
      componentKey: "SectionOfferingsGrid",
      labelId: "Daftar Layanan",
      singleton: false,
      defaultOfferingType: "service",
    },
    products_grid: {
      type: "products_grid",
      componentKey: "SectionOfferingsGrid",
      labelId: "Katalog Produk",
      singleton: false,
      defaultOfferingType: "product",
    },
    tours_grid: {
      type: "tours_grid",
      componentKey: "SectionOfferingsGrid",
      labelId: "Paket Tur & Perjalanan",
      singleton: false,
      defaultOfferingType: "tour",
    },
    vehicles_grid: {
      type: "vehicles_grid",
      componentKey: "SectionOfferingsGrid",
      labelId: "Daftar Kendaraan",
      singleton: false,
      defaultOfferingType: "vehicle",
    },
    rich_text: {
      type: "rich_text",
      componentKey: "SectionRichText",
      labelId: "Konten Teks",
      singleton: false,
    },
    about: {
      type: "about",
      componentKey: "SectionRichText",
      labelId: "Tentang Kami",
      singleton: false,
    },
    gallery: {
      type: "gallery",
      componentKey: "SectionGallery",
      labelId: "Galeri Foto & Video",
      singleton: false,
    },
    testimonials: {
      type: "testimonials",
      componentKey: "SectionTestimonials",
      labelId: "Testimoni Pelanggan",
      singleton: false,
    },
    faq: {
      type: "faq",
      componentKey: "SectionFaq",
      labelId: "Pertanyaan Umum (FAQ)",
      singleton: false,
    },
    blog_latest: {
      type: "blog_latest",
      componentKey: "SectionBlogLatest",
      labelId: "Artikel Terbaru",
      singleton: false,
    },
    latest_posts: {
      type: "latest_posts",
      componentKey: "SectionBlogLatest",
      labelId: "Artikel Terbaru",
      singleton: false,
    },
    cta_banner: {
      type: "cta_banner",
      componentKey: "SectionCtaBanner",
      labelId: "Ajakan Aksi (CTA)",
      singleton: false,
    },
    cta_band: {
      type: "cta_band",
      componentKey: "SectionCtaBanner",
      labelId: "Ajakan Aksi (CTA)",
      singleton: false,
    },
    custom_form: {
      type: "custom_form",
      componentKey: "SectionCtaBanner",
      labelId: "Formulir Pertanyaan",
      singleton: false,
    },
    contact_location: {
      type: "contact_location",
      componentKey: "SectionContactLocation",
      labelId: "Kontak & Lokasi",
      singleton: false,
    },
    contact: {
      type: "contact",
      componentKey: "SectionContactLocation",
      labelId: "Kontak & Lokasi",
      singleton: false,
    },
    branches: {
      type: "branches",
      componentKey: "SectionContactLocation",
      labelId: "Lokasi & Cabang",
      singleton: false,
    },
  });

export function resolveSectionComponentEntry(type: unknown): SectionRegistryEntry {
  if (!isClosedSectionType(type)) {
    throw new SectionRegistryValidationError(
      "UNKNOWN_SECTION_TYPE",
      `Unknown section type "${String(type)}" in section registry`,
      [
        {
          field: "type",
          code: "UNKNOWN_SECTION_TYPE",
          message: `Section type "${String(type)}" is not registered`,
          sectionType: typeof type === "string" ? type : undefined,
        },
      ],
    );
  }
  return SECTION_REGISTRY_MAP[type];
}

export type PageAssemblyMode = "published" | "preview";
export type PageRouteKind = "home" | "page";

export interface ResolvedRenderableSection {
  readonly section: AnyValidatedPageSection;
  readonly entry: SectionRegistryEntry;
  readonly componentKey: SectionComponentKey;
  readonly surfaceTone: "surface" | "muted";
  readonly isFirstSection: boolean;
}

export interface AssemblePageSectionsInput {
  readonly routePath?: string;
  readonly pageSlug?: string | null;
  readonly isHomepage?: boolean;
  readonly themeId: string;
  readonly mode?: PageAssemblyMode;
  readonly businessCategory?: string | null;
  readonly sections: unknown;
}

export interface AssembledPageResult {
  readonly routeKind: PageRouteKind;
  readonly routePath: string;
  readonly pageSlug: string | null;
  readonly themeId: string;
  readonly themeProfile: PlatformThemeSectionProfile;
  readonly mode: PageAssemblyMode;
  readonly isPreview: boolean;
  readonly isHealthCategory: boolean;
  readonly allSections: readonly AnyValidatedPageSection[];
  readonly renderableSections: readonly ResolvedRenderableSection[];
  readonly disabledSectionIds: readonly string[];
  readonly warnings: readonly SectionValidationWarning[];
}

export type SafeAssemblePageResult =
  | { readonly ok: true; readonly assembled: AssembledPageResult }
  | { readonly ok: false; readonly error: SectionRegistryValidationError };

function isLegacyPublicPageSectionDtoArray(input: unknown): input is PublicPageSectionDtoInput[] {
  if (!Array.isArray(input) || input.length === 0) return false;
  const first = input[0];
  return Boolean(
    first &&
      typeof first === "object" &&
      !Array.isArray(first) &&
      "kind" in first &&
      !("type" in first),
  );
}

/**
 * Validates and assembles an ordered, render-ready list of page sections for
 * BOTH `/` (homepage) and `/{pageSlug}` (static pages), across all 6 platform
 * themes and granted custom themes, with identical ordering/toggle behavior
 * between preview DTOs and published snapshots.
 */
export function assemblePageSections(input: AssemblePageSectionsInput): AssembledPageResult {
  const mode: PageAssemblyMode = input.mode === "preview" ? "preview" : "published";
  const isHomepage =
    input.isHomepage ?? (input.routePath === "/" || !input.pageSlug || input.pageSlug === "beranda");
  const routeKind: PageRouteKind = isHomepage ? "home" : "page";
  const routePath =
    input.routePath ?? (isHomepage ? "/" : `/${(input.pageSlug ?? "").replace(/^\/+/, "")}`);

  const normalizedInput = isLegacyPublicPageSectionDtoArray(input.sections)
    ? input.sections.map((dto) => convertPublicPageSectionDtoToSectionInput(dto))
    : input.sections;

  const validated = validatePageSections(normalizedInput, {
    businessCategory: input.businessCategory,
  });

  const themeProfile = resolveThemeSectionProfile(input.themeId);

  let nonHeroToneIndex = 0;
  const renderableSections: ResolvedRenderableSection[] = validated.enabledSections.map(
    (section, index) => {
      const entry = SECTION_REGISTRY_MAP[section.type];
      const surfaceTone: "surface" | "muted" =
        section.type === "hero"
          ? "muted"
          : nonHeroToneIndex++ % 2 === 0
            ? "surface"
            : "muted";
      return {
        section,
        entry,
        componentKey: entry.componentKey,
        surfaceTone,
        isFirstSection: index === 0,
      };
    },
  );

  return {
    routeKind,
    routePath,
    pageSlug: isHomepage ? null : (input.pageSlug ?? null),
    themeId: input.themeId,
    themeProfile,
    mode,
    isPreview: mode === "preview",
    isHealthCategory: validated.isHealthCategory,
    allSections: validated.sections,
    renderableSections,
    disabledSectionIds: validated.disabledSectionIds,
    warnings: validated.warnings,
  };
}

/**
 * Non-throwing wrapper for Astro SSR rendering so invalid section configurations
 * fail safely without crashing the page shell or leaking raw payloads.
 */
export function safeAssemblePageSections(input: AssemblePageSectionsInput): SafeAssemblePageResult {
  try {
    return {
      ok: true,
      assembled: assemblePageSections(input),
    };
  } catch (err) {
    if (err instanceof SectionRegistryValidationError) {
      return { ok: false, error: err };
    }
    return {
      ok: false,
      error: new SectionRegistryValidationError(
        "INVALID_SECTION_CONFIG",
        err instanceof Error ? err.message : "Invalid section configuration",
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Public Formatting & Safe Link Helpers for Astro Section Components
// ---------------------------------------------------------------------------

export type { SectionOfferingItem };

const OFFERING_BASE_PATH: Readonly<Record<SectionOfferingItem["offeringType"], string>> = {
  service: "/layanan",
  product: "/produk",
  tour: "/tour",
  vehicle: "/kendaraan",
};

const OFFERING_TYPE_LABEL_ID: Readonly<Record<SectionOfferingItem["offeringType"], string>> = {
  service: "Layanan",
  product: "Produk",
  tour: "Paket Tur",
  vehicle: "Kendaraan",
};

const VEHICLE_STATUS_LABEL_ID: Readonly<Record<"available" | "booked" | "sold", string>> = {
  available: "Tersedia",
  booked: "Dipesan",
  sold: "Terjual",
};

export function getOfferingTypeLabelId(offeringType: SectionOfferingItem["offeringType"]): string {
  return OFFERING_TYPE_LABEL_ID[offeringType];
}

export function getVehicleUnitStatusLabelId(
  status: SectionOfferingItem["unitStatus"],
): string | null {
  if (!status) return null;
  return VEHICLE_STATUS_LABEL_ID[status];
}

export function buildSectionOfferingDetailHref(item: SectionOfferingItem): string {
  return `${OFFERING_BASE_PATH[item.offeringType]}/${item.slug}`;
}

export function formatSectionOfferingPriceText(item: SectionOfferingItem): string {
  switch (item.priceMode) {
    case "on_request":
      return formatOfferingPrice({ model: "on_request" });
    case "fixed":
      return formatOfferingPrice({
        model: "fixed",
        amountIdr: item.price ?? 0,
        negotiable: item.negotiable,
      });
    case "from":
      return formatOfferingPrice({
        model: "from",
        amountIdr: item.price ?? 0,
        negotiable: item.negotiable,
      });
    case "range":
      return formatOfferingPrice({
        model: "range",
        minAmountIdr: item.price ?? 0,
        maxAmountIdr: item.priceMax ?? item.price ?? 0,
        negotiable: item.negotiable,
      });
  }
}

export function formatIdrPlain(amount: number): string {
  const safe = Math.max(0, Math.round(amount));
  return `Rp ${String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export interface ResolvedOfferingCta {
  readonly label: string;
  readonly href: string;
  readonly isExternal: boolean;
  readonly isWhatsApp: boolean;
}

export function resolveSectionOfferingCta(
  item: SectionOfferingItem,
  options: {
    readonly fallbackWhatsappPhone?: string | null;
    readonly primaryOrigin?: string;
  } = {},
): ResolvedOfferingCta {
  const detailPath = buildSectionOfferingDetailHref(item);
  const priceText = formatSectionOfferingPriceText(item);

  if (item.ctaKind === "whatsapp") {
    const label = item.ctaLabel?.trim() || "Tanya via WhatsApp";
    if (item.ctaHref) {
      try {
        const safeHref = sanitizeNavigationHref(item.ctaHref);
        return {
          label,
          href: safeHref,
          isExternal: safeHref.startsWith("https://"),
          isWhatsApp: true,
        };
      } catch {
        // Fall through to WhatsApp builder
      }
    }
    const phone = item.whatsappPhone ?? options.fallbackWhatsappPhone ?? null;
    if (phone) {
      try {
        const wa = buildWhatsAppUrl({
          tenantPhone: phone,
          itemTitle: item.title,
          itemPrice: priceText,
          primaryOrigin: options.primaryOrigin ?? "https://situsku.click",
          canonicalPath: detailPath,
        });
        return {
          label,
          href: wa.url,
          isExternal: true,
          isWhatsApp: true,
        };
      } catch {
        // Fall back to safe detail path
      }
    }
    return {
      label,
      href: detailPath,
      isExternal: false,
      isWhatsApp: false,
    };
  }

  if (item.ctaKind === "external_link" && item.ctaHref) {
    try {
      const safeHref = sanitizeNavigationHref(item.ctaHref);
      return {
        label: item.ctaLabel?.trim() || "Lihat Penawaran",
        href: safeHref,
        isExternal: safeHref.startsWith("https://"),
        isWhatsApp: false,
      };
    } catch {
      return {
        label: item.ctaLabel?.trim() || "Lihat Detail",
        href: detailPath,
        isExternal: false,
        isWhatsApp: false,
      };
    }
  }

  const defaultLabel = item.ctaKind === "book" ? "Ajukan Jadwal" : "Minta Informasi";
  let resolvedHref = detailPath;
  if (item.ctaHref) {
    try {
      resolvedHref = sanitizeNavigationHref(item.ctaHref);
    } catch {
      resolvedHref = detailPath;
    }
  }
  return {
    label: item.ctaLabel?.trim() || defaultLabel,
    href: resolvedHref,
    isExternal: resolvedHref.startsWith("https://"),
    isWhatsApp: false,
  };
}

export function buildSafeWhatsAppDirectHref(
  rawPhone: string | null | undefined,
  greetingText = "Halo, saya ingin mendapatkan informasi lebih lanjut.",
): string | null {
  if (!rawPhone) return null;
  try {
    const normalized = normalizeIndonesianWhatsAppNumber(rawPhone);
    return `https://wa.me/${normalized}?text=${encodeURIComponent(greetingText)}`;
  } catch {
    return null;
  }
}

export function formatIndonesianPublishedDate(isoOrDate: string | null | undefined): string | null {
  if (!isoOrDate) return null;
  const parsed = new Date(isoOrDate);
  if (Number.isNaN(parsed.getTime())) return isoOrDate;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(parsed);
}

export {
  CLOSED_SECTION_TYPES,
  isClosedSectionType,
  isSingletonSectionType,
  PLATFORM_THEME_SECTION_PROFILES,
  resolveThemeSectionProfile,
  SectionRegistryValidationError,
  switchPageThemeLosslessly,
  validatePageSections,
  verifyPreviewPublishedSectionParity,
  type AnyValidatedPageSection,
  type ClosedSectionType,
  type LosslessThemeSwitchResult,
  type PlatformThemeId,
  type PlatformThemeSectionProfile,
  type PreviewPublishedParityResult,
  type SectionValidationWarning,
  type ValidatedPageSection,
};
