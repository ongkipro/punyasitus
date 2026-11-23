import { useMemo, useState, type KeyboardEvent } from "react";
import type { OfferingType, TenantStatus } from "@punyasitus/core/schemas";
import {
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  evaluateSeoChecklist,
  getAllowedSchemaTypeOptions,
  MAX_SEO_FOCUS_KEYPHRASE_LENGTH,
  MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH,
  MAX_SEO_OVERRIDE_TITLE_LENGTH,
  RECOMMENDED_DESCRIPTION_MAX,
  RECOMMENDED_DESCRIPTION_MIN,
  RECOMMENDED_TITLE_MAX,
  RECOMMENDED_TITLE_MIN,
  resolveEffectiveSeoPreview,
  SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS,
  validateSearchAppearanceTemplateString,
  type AllowedResourceSchemaType,
  type PeerPublishedSeoSummary,
  type SearchAppearanceKind,
  type SearchAppearanceSettings,
  type SeoChecklistContentImage,
  type SeoEditorOverrideInput,
} from "@punyasitus/core/seo/editor";
import type { SeoRouteKind, SiteVisibility } from "@punyasitus/core/seo/index";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  SearchIcon,
  Share2Icon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Collapsed-by-default per-resource SEO Override Drawer (`TASK-052`, `REQ-053`, `DESIGN.md §8`).
 *
 * Hard Contracts:
 * - Hidden completely (`return null`) when `seoAutopilotEnabled === false`.
 * - Collapsed by default (`expanded = false`) with label
 *   "SEO & AI Otomatis Aktif — Ubah manual (opsional)".
 * - Four tabs: `Umum`, `Sosial`, `Skema & Fakta AI`, `Lanjutan`.
 * - Advisory checklist shows `"x dari y saran terpenuhi"` — ZERO numeric SEO score and
 *   NEVER blocks saving or publishing.
 * - Uses `base-nova` primitives only (Base UI `render` prop pattern).
 */

export type SeoDrawerTabId = "general" | "social" | "schema" | "advanced";

const SEO_DRAWER_TABS: ReadonlyArray<{
  readonly id: SeoDrawerTabId;
  readonly label: string;
}> = [
  { id: "general", label: "Umum" },
  { id: "social", label: "Sosial" },
  { id: "schema", label: "Skema & Fakta AI" },
  { id: "advanced", label: "Lanjutan" },
];

export interface SeoOverrideDrawerProps {
  readonly seoAutopilotEnabled?: boolean;
  readonly resourceKind: "page" | "post" | "offering";
  readonly offeringType?: OfferingType;
  readonly isHomepage?: boolean;
  readonly siteName: string;
  readonly tagline?: string | null;
  readonly siteDefaultTitle?: string | null;
  readonly siteDefaultDescription?: string | null;
  readonly siteDefaultOgMediaId?: number | null;
  readonly primaryHost: string;
  readonly tenantHandle: string;
  readonly tenantStatus: TenantStatus;
  readonly siteVisibility?: SiteVisibility;
  readonly searchAppearance?: SearchAppearanceSettings;
  readonly pathname: string;
  readonly resourceTitle: string;
  readonly slug: string;
  readonly resourceExcerpt?: string | null;
  readonly resourceFeaturedMediaId?: number | null;
  readonly publicationState: "draft" | "published" | "trashed";
  readonly hasVisibleFaqBlock?: boolean;
  readonly priceMode?: "fixed" | "from" | "range" | "on_request";
  readonly price?: number | null;
  readonly hasVisibleItinerary?: boolean;
  readonly firstParagraphText?: string;
  readonly headings?: readonly { readonly level: number; readonly text: string }[];
  readonly plainTextBody?: string;
  readonly internalLinkCount?: number;
  readonly images?: readonly SeoChecklistContentImage[];
  readonly publishedPeers?: readonly PeerPublishedSeoSummary[];
  readonly slugChangedWhilePublished?: boolean;
  readonly oldPublishedSlug?: string | null;
  readonly value: SeoEditorOverrideInput;
  readonly onChange: (next: SeoEditorOverrideInput) => void;
  readonly onPickOgMedia?: () => void;
  readonly readOnly?: boolean;
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

function fieldStateBadge(state: "overridden" | "inherited" | "default") {
  if (state === "overridden") {
    return (
      <Badge variant="info" className="text-[11px]">
        Diubah manual
      </Badge>
    );
  }
  if (state === "inherited") {
    return (
      <Badge variant="secondary" className="text-[11px]">
        Otomatis (template)
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[11px]">
      Bawaan
    </Badge>
  );
}

export function SeoOverrideDrawer({
  seoAutopilotEnabled = true,
  resourceKind,
  offeringType,
  isHomepage = false,
  siteName,
  tagline,
  siteDefaultTitle,
  siteDefaultDescription,
  siteDefaultOgMediaId,
  primaryHost,
  tenantHandle,
  tenantStatus,
  siteVisibility = "public",
  searchAppearance = DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  pathname,
  resourceTitle,
  slug,
  resourceExcerpt,
  resourceFeaturedMediaId,
  publicationState,
  hasVisibleFaqBlock = false,
  priceMode,
  price,
  hasVisibleItinerary = false,
  firstParagraphText,
  headings,
  plainTextBody,
  internalLinkCount,
  images,
  publishedPeers,
  slugChangedWhilePublished = false,
  oldPublishedSlug = null,
  value,
  onChange,
  onPickOgMedia,
  readOnly = false,
  fieldErrors = {},
}: SeoOverrideDrawerProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<SeoDrawerTabId>("general");

  const routeKind: SeoRouteKind =
    resourceKind === "page"
      ? isHomepage
        ? "homepage"
        : "page"
      : resourceKind === "post"
        ? "post"
        : "offering";

  const searchAppearanceKind: SearchAppearanceKind =
    resourceKind === "page"
      ? isHomepage
        ? "homepage"
        : "page"
      : resourceKind === "post"
        ? "post"
        : "catalog_item";

  const allowedSchemaOptions = useMemo(
    () =>
      getAllowedSchemaTypeOptions({
        resourceKind,
        offeringType,
        hasVisibleFaqBlock,
        priceMode,
        price,
        hasVisibleItinerary,
      }),
    [resourceKind, offeringType, hasVisibleFaqBlock, priceMode, price, hasVisibleItinerary],
  );

  const preview = useMemo(
    () =>
      resolveEffectiveSeoPreview({
        tenant: {
          tenantHandle,
          tenantStatus,
          primaryHost,
          primaryHostKind: primaryHost.endsWith(".situsku.click") ? "subdomain" : "custom",
          primaryHostStatus: "active",
          primaryHostSslStatus: "active",
          primaryHostVerified: true,
          verifiedTenantHosts: [primaryHost],
          servingHost: primaryHost,
        },
        siteName,
        tagline,
        siteDefaultTitle,
        siteDefaultDescription,
        siteDefaultOgMediaId,
        siteVisibility,
        searchAppearance,
        resourceKind,
        searchAppearanceKind,
        routeKind,
        pathname,
        resourceTitle,
        resourceExcerpt,
        resourceFeaturedMediaId,
        publicationState,
        seo: value,
        offeringType,
        hasVisibleFaqBlock,
        priceMode,
        price,
        hasVisibleItinerary,
      }),
    [
      tenantHandle,
      tenantStatus,
      primaryHost,
      siteName,
      tagline,
      siteDefaultTitle,
      siteDefaultDescription,
      siteDefaultOgMediaId,
      siteVisibility,
      searchAppearance,
      resourceKind,
      searchAppearanceKind,
      routeKind,
      pathname,
      resourceTitle,
      resourceExcerpt,
      resourceFeaturedMediaId,
      publicationState,
      value,
      offeringType,
      hasVisibleFaqBlock,
      priceMode,
      price,
      hasVisibleItinerary,
    ],
  );

  const checklist = useMemo(
    () =>
      evaluateSeoChecklist({
        resourceKind,
        effectiveTitle: preview.effectiveTitle,
        effectiveDescription: preview.effectiveDescription,
        isFallbackDescription: preview.isFallbackDescriptionWarning,
        slug,
        focusKeyphrase: value.focusKeyphrase ?? null,
        firstParagraphText,
        headings,
        plainTextBody,
        internalLinkCount,
        images,
        publishedPeers,
        slugChangedWhilePublished,
        oldPublishedSlug,
        noindex: Boolean(value.noindex),
      }),
    [
      resourceKind,
      preview.effectiveTitle,
      preview.effectiveDescription,
      preview.isFallbackDescriptionWarning,
      slug,
      value.focusKeyphrase,
      value.noindex,
      firstParagraphText,
      headings,
      plainTextBody,
      internalLinkCount,
      images,
      publishedPeers,
      slugChangedWhilePublished,
      oldPublishedSlug,
    ],
  );

  const titleTokenError = useMemo(() => {
    const raw = value.titleOverride ?? "";
    if (!raw.trim()) return null;
    const res = validateSearchAppearanceTemplateString(raw);
    return res.ok ? null : res.issue.message;
  }, [value.titleOverride]);

  const descTokenError = useMemo(() => {
    const raw = value.descriptionOverride ?? "";
    if (!raw.trim()) return null;
    const res = validateSearchAppearanceTemplateString(raw);
    return res.ok ? null : res.issue.message;
  }, [value.descriptionOverride]);

  // Hard invariant (DESIGN.md §8, TASK-052): hide completely when seo-ai-autopilot is disabled!
  if (!seoAutopilotEnabled) {
    return null;
  }

  function updateSeo(patch: Partial<SeoEditorOverrideInput>) {
    if (readOnly) return;
    onChange({
      ...value,
      ...patch,
    });
  }

  function insertToken(field: "titleOverride" | "descriptionOverride", token: string) {
    if (readOnly) return;
    const current = (value[field] ?? "").trim();
    const next = current ? `${current} ${token}` : token;
    updateSeo({ [field]: next });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = SEO_DRAWER_TABS[(currentIndex + 1) % SEO_DRAWER_TABS.length];
      if (next) {
        setActiveTab(next.id);
        document.getElementById(`seo-tab-btn-${next.id}`)?.focus();
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prev =
        SEO_DRAWER_TABS[(currentIndex - 1 + SEO_DRAWER_TABS.length) % SEO_DRAWER_TABS.length];
      if (prev) {
        setActiveTab(prev.id);
        document.getElementById(`seo-tab-btn-${prev.id}`)?.focus();
      }
    }
  }

  const ogSourceLabel =
    preview.ogImageSource === "resource_og_override"
      ? "Gambar OG khusus konten"
      : preview.ogImageSource === "resource_featured"
        ? "Diwarisi dari gambar utama konten"
        : preview.ogImageSource === "tenant_default"
          ? "Diwarisi dari gambar OG bawaan situs"
          : "Fallback otomatis PunyaSitus";

  return (
    <Card
      className="border-border bg-card"
      data-testid="seo-override-drawer"
      data-seo-expanded={expanded ? "true" : "false"}
    >
      <CardHeader className="block p-0">
        <button
          type="button"
          data-testid="seo-drawer-toggle"
          aria-expanded={expanded}
          aria-controls="seo-override-drawer-panel"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex min-h-14 w-full min-w-0 max-w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left whitespace-normal transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
            <div className="flex items-start gap-2">
              <SlidersHorizontalIcon
                className="mt-0.5 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span className="break-words text-sm font-semibold text-foreground">
                SEO &amp; AI Otomatis Aktif — Ubah manual (opsional)
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge
                variant={preview.effectiveIndexable ? "success" : "warning"}
                data-testid="seo-drawer-indexability-badge"
              >
                {preview.effectiveIndexable ? "Siap Terindeks" : "Noindex"}
              </Badge>
              <Badge variant="outline" data-testid="seo-drawer-checklist-pill">
                {checklist.summaryLabel}
              </Badge>
              <span className="max-w-full truncate font-mono text-[11px]">
                {preview.displayUrlPreview}
              </span>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            <span className="hidden sm:inline">{expanded ? "Tutup" : "Ubah"}</span>
            {expanded ? (
              <ChevronUpIcon className="size-4" aria-hidden="true" />
            ) : (
              <ChevronDownIcon className="size-4" aria-hidden="true" />
            )}
          </span>
        </button>
      </CardHeader>

      {expanded && (
        <CardContent
          id="seo-override-drawer-panel"
          data-testid="seo-drawer-panel"
          className="space-y-5 border-t border-border pt-4"
        >
          {/* Tab Strip (Zero Radix, full arrow-key support) */}
          <div
            role="tablist"
            aria-label="Pengaturan SEO manual"
            className="flex flex-wrap gap-1.5 border-b border-border pb-3"
          >
            {SEO_DRAWER_TABS.map((tab, idx) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`seo-tab-btn-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`seo-tabpanel-${tab.id}`}
                  data-testid={`seo-tab-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={
                    selected
                      ? "min-h-11 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9"
                      : "min-h-11 rounded-md border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9"
                  }
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* TAB 1: UMUM (General + Google Preview + Advisory Checklist) */}
          {activeTab === "general" && (
            <div
              role="tabpanel"
              id="seo-tabpanel-general"
              aria-labelledby="seo-tab-btn-general"
              className="space-y-5"
            >
              {/* Google Snippet Preview */}
              <div
                className="space-y-2 rounded-lg border border-border bg-muted/30 p-4"
                data-testid="seo-google-preview"
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <SearchIcon className="size-3.5" aria-hidden="true" />
                  <span>Pratinjau Hasil Pencarian (Ilustratif)</span>
                </div>
                <div className="space-y-1 rounded-md border border-border bg-card p-3.5">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {preview.displayUrlPreview}
                  </p>
                  <p
                    className="line-clamp-2 text-base font-semibold text-primary"
                    data-testid="seo-preview-title"
                  >
                    {preview.effectiveTitle || resourceTitle || "(Judul belum diisi)"}
                  </p>
                  <p
                    className="line-clamp-3 text-xs leading-relaxed text-muted-foreground"
                    data-testid="seo-preview-description"
                  >
                    {preview.effectiveDescription ||
                      "Tambahkan ringkasan atau deskripsi meta agar pengunjung memahami isi halaman."}
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Pratinjau bersifat ilustratif; mesin pencari dapat menyesuaikan judul atau
                  cuplikan sesuai kata kunci pencari dan tidak ada jaminan peringkat.
                </p>
              </div>

              {/* Title Override */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="seo-title-override"
                    className="text-sm font-medium text-foreground"
                  >
                    Judul SEO (Opsional)
                  </label>
                  <div className="flex items-center gap-2">
                    {fieldStateBadge(preview.fieldStates.title)}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Efektif: {preview.effectiveTitle.length} karakter (saran{" "}
                      {RECOMMENDED_TITLE_MIN}–{RECOMMENDED_TITLE_MAX})
                    </span>
                  </div>
                </div>
                <Input
                  id="seo-title-override"
                  data-testid="seo-title-override-input"
                  value={value.titleOverride ?? ""}
                  maxLength={MAX_SEO_OVERRIDE_TITLE_LENGTH}
                  disabled={readOnly}
                  aria-invalid={Boolean(titleTokenError || fieldErrors["seo.titleOverride"])}
                  aria-describedby="seo-title-tokens-help"
                  onChange={(e) =>
                    updateSeo({ titleOverride: e.target.value ? e.target.value : null })
                  }
                  placeholder={`Kosongkan untuk otomatis (${preview.effectiveTitle.slice(0, 60)})`}
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
                <div id="seo-title-tokens-help" className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-muted-foreground">Sisipkan token:</span>
                  {SEARCH_APPEARANCE_TOKEN_PLACEHOLDERS.map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      disabled={readOnly}
                      onClick={() => insertToken("titleOverride", tok)}
                      className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {tok}
                    </button>
                  ))}
                </div>
                {(titleTokenError || fieldErrors["seo.titleOverride"]) && (
                  <p
                    role="alert"
                    data-testid="seo-title-error"
                    className="text-xs font-medium text-destructive"
                  >
                    {titleTokenError ?? fieldErrors["seo.titleOverride"]}
                  </p>
                )}
              </div>

              {/* Meta Description Override */}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="seo-description-override"
                    className="text-sm font-medium text-foreground"
                  >
                    Deskripsi Meta (Opsional)
                  </label>
                  <div className="flex items-center gap-2">
                    {fieldStateBadge(preview.fieldStates.description)}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      Efektif: {preview.effectiveDescription.length} karakter (saran{" "}
                      {RECOMMENDED_DESCRIPTION_MIN}–{RECOMMENDED_DESCRIPTION_MAX})
                    </span>
                  </div>
                </div>
                <textarea
                  id="seo-description-override"
                  data-testid="seo-description-override-input"
                  rows={3}
                  maxLength={MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH}
                  disabled={readOnly}
                  aria-invalid={Boolean(descTokenError || fieldErrors["seo.descriptionOverride"])}
                  value={value.descriptionOverride ?? ""}
                  onChange={(e) =>
                    updateSeo({ descriptionOverride: e.target.value ? e.target.value : null })
                  }
                  placeholder="Kosongkan untuk otomatis dari ringkasan konten."
                  className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 md:text-sm"
                />
                {(descTokenError || fieldErrors["seo.descriptionOverride"]) && (
                  <p
                    role="alert"
                    data-testid="seo-description-error"
                    className="text-xs font-medium text-destructive"
                  >
                    {descTokenError ?? fieldErrors["seo.descriptionOverride"]}
                  </p>
                )}
              </div>

              {/* Focus Keyphrase */}
              <div className="space-y-1.5">
                <label
                  htmlFor="seo-focus-keyphrase"
                  className="block text-sm font-medium text-foreground"
                >
                  Frasa Kunci Fokus (Opsional)
                </label>
                <Input
                  id="seo-focus-keyphrase"
                  data-testid="seo-focus-keyphrase-input"
                  value={value.focusKeyphrase ?? ""}
                  maxLength={MAX_SEO_FOCUS_KEYPHRASE_LENGTH}
                  disabled={readOnly}
                  onChange={(e) =>
                    updateSeo({ focusKeyphrase: e.target.value ? e.target.value : null })
                  }
                  placeholder="Contoh: jasa renovasi kantor jakarta"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Digunakan untuk daftar periksa saran konten di bawah dan mendeteksi duplikasi
                  topik antar konten terbit di situs Anda.
                </p>
              </div>

              {/* Advisory Content Checklist (NO numeric score, NEVER blocks publish) */}
              <section
                aria-label="Daftar periksa saran konten SEO"
                data-testid="seo-advisory-checklist"
                className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Saran Kelengkapan Konten (Opsional)
                  </h3>
                  <Badge variant="secondary" data-testid="seo-checklist-summary">
                    {checklist.summaryLabel}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saran ini bersifat informatif untuk membantu kejelasan halaman dan{" "}
                  <strong className="font-medium text-foreground">
                    tidak pernah menghalangi penyimpanan atau publikasi
                  </strong>
                  .
                </p>
                <ul className="space-y-2">
                  {checklist.items.map((item) => (
                    <li
                      key={item.id}
                      data-checklist-item={item.id}
                      data-checklist-status={item.status}
                      className="flex items-start gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-xs"
                    >
                      {item.status === "pass" ? (
                        <CheckCircle2Icon
                          className="mt-0.5 size-4 shrink-0 text-success"
                          aria-hidden="true"
                        />
                      ) : (
                        <InfoIcon
                          className="mt-0.5 size-4 shrink-0 text-warning"
                          aria-hidden="true"
                        />
                      )}
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium text-foreground">{item.label}</p>
                        <p className="text-muted-foreground">{item.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          {/* TAB 2: SOSIAL (OG / WhatsApp / X summary_large_image Preview) */}
          {activeTab === "social" && (
            <div
              role="tabpanel"
              id="seo-tabpanel-social"
              aria-labelledby="seo-tab-btn-social"
              className="space-y-5"
            >
              <div
                className="space-y-2 rounded-lg border border-border bg-muted/30 p-4"
                data-testid="seo-social-preview"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Share2Icon className="size-3.5" aria-hidden="true" />
                    Pratinjau Berbagi WhatsApp &amp; X
                  </span>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    twitter:card = {preview.twitterCard}
                  </Badge>
                </div>
                <div className="overflow-hidden rounded-md border border-border bg-card">
                  <div className="flex h-28 items-center justify-center border-b border-border bg-muted/50 px-4 text-center text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <ImageIcon className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
                      <p className="font-medium text-foreground">
                        {preview.effectiveOgImageMediaId
                          ? `Gambar OG: Media #${preview.effectiveOgImageMediaId}`
                          : "Gambar OG Otomatis (1200×630 WebP)"}
                      </p>
                      <p className="text-[11px]">{ogSourceLabel}</p>
                    </div>
                  </div>
                  <div className="space-y-1 p-3.5">
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {primaryHost}
                    </p>
                    <p className="line-clamp-2 text-sm font-semibold text-foreground">
                      {preview.effectiveOgTitle || preview.effectiveTitle}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {preview.effectiveOgDescription || preview.effectiveDescription}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="seo-og-title" className="text-sm font-medium text-foreground">
                    Judul Berbagi Sosial / Open Graph (Opsional)
                  </label>
                  {fieldStateBadge(preview.fieldStates.ogTitle)}
                </div>
                <Input
                  id="seo-og-title"
                  data-testid="seo-og-title-input"
                  value={value.ogTitleOverride ?? ""}
                  maxLength={MAX_SEO_OVERRIDE_TITLE_LENGTH}
                  disabled={readOnly}
                  onChange={(e) =>
                    updateSeo({ ogTitleOverride: e.target.value ? e.target.value : null })
                  }
                  placeholder="Kosongkan untuk memakai Judul SEO efektif"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="seo-og-desc" className="text-sm font-medium text-foreground">
                    Deskripsi Berbagi Sosial / Open Graph (Opsional)
                  </label>
                  {fieldStateBadge(preview.fieldStates.ogDescription)}
                </div>
                <textarea
                  id="seo-og-desc"
                  data-testid="seo-og-desc-input"
                  rows={3}
                  maxLength={MAX_SEO_OVERRIDE_DESCRIPTION_LENGTH}
                  disabled={readOnly}
                  value={value.ogDescriptionOverride ?? ""}
                  onChange={(e) =>
                    updateSeo({ ogDescriptionOverride: e.target.value ? e.target.value : null })
                  }
                  placeholder="Kosongkan untuk memakai Deskripsi Meta efektif"
                  className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 md:text-sm"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    Gambar Berbagi (Open Graph)
                  </span>
                  {fieldStateBadge(preview.fieldStates.ogImage)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {value.ogImageMediaId ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                      <ImageIcon className="size-4 text-primary" aria-hidden="true" />
                      <span className="font-medium tabular-nums">
                        Media #{value.ogImageMediaId}
                      </span>
                      {!readOnly && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Hapus gambar OG khusus"
                          onClick={() => updateSeo({ ogImageMediaId: null })}
                        >
                          <XIcon className="size-3.5" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{ogSourceLabel}.</span>
                  )}
                  {onPickOgMedia && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={readOnly}
                      onClick={onPickOgMedia}
                      data-testid="seo-pick-og-image-btn"
                      className="min-h-11 md:min-h-9"
                    >
                      <ImageIcon className="size-4" aria-hidden="true" />
                      {value.ogImageMediaId ? "Ganti Gambar OG" : "Pilih dari Media"}
                    </Button>
                  )}
                </div>
                {fieldErrors["seo.ogImageMediaId"] && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {fieldErrors["seo.ogImageMediaId"]}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: SKEMA & FAKTA AI */}
          {activeTab === "schema" && (
            <div
              role="tabpanel"
              id="seo-tabpanel-schema"
              aria-labelledby="seo-tab-btn-schema"
              className="space-y-4"
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="seo-schema-type" className="text-sm font-medium text-foreground">
                    Tipe Data Terstruktur (Schema.org)
                  </label>
                  {fieldStateBadge(preview.fieldStates.schemaType)}
                </div>
                <select
                  id="seo-schema-type"
                  data-testid="seo-schema-type-select"
                  value={value.schemaType ?? ""}
                  disabled={readOnly}
                  onChange={(e) =>
                    updateSeo({
                      schemaType: (e.target.value || null) as AllowedResourceSchemaType | null,
                    })
                  }
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
                >
                  <option value="">
                    Otomatis ({allowedSchemaOptions[0]?.value ?? "WebPage"})
                  </option>
                  {allowedSchemaOptions.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={!opt.allowed}>
                      {opt.label}
                      {!opt.allowed ? " — belum memenuhi syarat konten" : ""}
                    </option>
                  ))}
                </select>
                {fieldErrors["seo.schemaType"] && (
                  <p
                    role="alert"
                    data-testid="seo-schema-error"
                    className="text-xs font-medium text-destructive"
                  >
                    {fieldErrors["seo.schemaType"]}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                {allowedSchemaOptions.map((opt) => (
                  <div
                    key={opt.value}
                    className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-foreground">{opt.value}</span>
                      <Badge variant={opt.allowed ? "secondary" : "outline"} className="text-[11px]">
                        {opt.allowed ? "Tersedia" : "Terkunci"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-muted-foreground">{opt.description}</p>
                    {!opt.allowed && opt.disabledReason && (
                      <p className="mt-1 font-medium text-warning">{opt.disabledReason}</p>
                    )}
                  </div>
                ))}
              </div>

              <Alert variant="info">
                <InfoIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Skema berasal dari fakta terlihat saja</AlertTitle>
                <AlertDescription>
                  JSON-LD dihasilkan otomatis oleh PunyaSitus dari konten yang benar-benar tampil
                  kepada pengunjung. Input JSON skema bebas atau skrip kustom sengaja tidak
                  diizinkan demi keamanan dan kebersihan data terstruktur.
                </AlertDescription>
              </Alert>
            </div>
          )}

          {/* TAB 4: LANJUTAN (Canonical Read-Only, Robots/Noindex Inheritance, Nofollow, Slug Warning) */}
          {activeTab === "advanced" && (
            <div
              role="tabpanel"
              id="seo-tabpanel-advanced"
              aria-labelledby="seo-tab-btn-advanced"
              className="space-y-5"
            >
              {/* Read-only Canonical URL */}
              <div className="space-y-1.5">
                <label
                  htmlFor="seo-canonical-readonly"
                  className="flex items-center gap-1.5 text-sm font-medium text-foreground"
                >
                  <GlobeIcon className="size-4 text-primary" aria-hidden="true" />
                  <span>URL Kanonis (Hanya-Baca)</span>
                </label>
                <Input
                  id="seo-canonical-readonly"
                  data-testid="seo-canonical-readonly"
                  readOnly
                  value={
                    preview.canonicalUrl ??
                    `Belum aktif (${publicationState === "draft" ? "masih draf" : "tidak terindeks"}) — proyeksi: ${preview.displayUrlPreview}`
                  }
                  className="min-h-11 bg-muted/40 font-mono text-xs text-foreground md:min-h-9"
                />
                <p className="text-xs text-muted-foreground">
                  URL kanonis diturunkan otomatis dari domain utama terverifikasi ({primaryHost})
                  sehingga tidak dapat dimanipulasi ke domain luar.
                </p>
              </div>

              {/* Effective Indexability & Robots Meta */}
              <div
                className="space-y-2 rounded-lg border border-border bg-muted/20 p-3.5"
                data-testid="seo-indexability-reasons"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Direktif Robots Efektif
                  </span>
                  <code className="rounded bg-card px-2 py-0.5 font-mono text-[11px] text-foreground">
                    {preview.robotsMeta}
                  </code>
                </div>
                <ul className="space-y-1.5">
                  {preview.indexabilityReasons.map((reason, idx) => (
                    <li
                      key={`${reason.code}-${idx}`}
                      data-indexability-reason={reason.code}
                      className="flex items-start gap-2 text-xs text-muted-foreground"
                    >
                      {reason.severity === "warning" ? (
                        <AlertTriangleIcon
                          className="mt-0.5 size-3.5 shrink-0 text-warning"
                          aria-hidden="true"
                        />
                      ) : (
                        <InfoIcon
                          className="mt-0.5 size-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                      )}
                      <span>{reason.message}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {preview.siteWideNoindexDominates && (
                <Alert variant="warning" data-testid="seo-site-wide-noindex-notice">
                  <ShieldAlertIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Kebijakan situs menimpa pengaturan halaman ini</AlertTitle>
                  <AlertDescription>
                    {tenantStatus === "trial"
                      ? "Situs uji coba selalu memancarkan noindex, nofollow hingga Anda mengaktifkan langganan berbayar."
                      : "Pengaturan visibilitas situs saat ini disetel ke noindex. Pilihan indeks per halaman tidak akan mengaktifkan indeks sampai visibilitas situs diubah ke Publik."}
                  </AlertDescription>
                </Alert>
              )}

              {/* Noindex & Nofollow Controls */}
              <div className="space-y-3">
                <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    data-testid="seo-noindex-checkbox"
                    checked={Boolean(value.noindex)}
                    disabled={readOnly}
                    onChange={(e) => updateSeo({ noindex: e.target.checked })}
                    className="mt-0.5 size-4 rounded border-input accent-primary"
                  />
                  <div className="space-y-0.5">
                    <span className="font-medium">
                      Sembunyikan dari hasil pencarian (<code>noindex</code>)
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Menghapus URL ini dari <code>/sitemap.xml</code> dan mengirim tag{" "}
                      <code>noindex</code>.
                    </p>
                  </div>
                </label>

                {checklist.noindexNotice && (
                  <Alert variant="warning" data-testid="seo-noindex-warning">
                    <AlertTriangleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Noindex bukan privasi</AlertTitle>
                    <AlertDescription>{checklist.noindexNotice.message}</AlertDescription>
                  </Alert>
                )}

                <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    data-testid="seo-nofollow-checkbox"
                    checked={Boolean(value.nofollow)}
                    disabled={readOnly}
                    onChange={(e) => updateSeo({ nofollow: e.target.checked })}
                    className="mt-0.5 size-4 rounded border-input accent-primary"
                  />
                  <div className="space-y-0.5">
                    <span className="font-medium">
                      Jangan ikuti tautan di halaman ini (<code>nofollow</code>)
                    </span>
                    <p className="text-xs text-muted-foreground">
                      Meminta mesin pencari tidak mengikuti tautan keluar pada konten ini.
                    </p>
                  </div>
                </label>
              </div>

              {/* Slug Change Warning */}
              {checklist.slugChangeNotice && (
                <Alert variant="warning" data-testid="seo-slug-change-warning">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Dampak Perubahan Slug pada Konten Terbit</AlertTitle>
                  <AlertDescription>{checklist.slugChangeNotice.message}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
