import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  BarChart3Icon,
  BookOpenIcon,
  Building2Icon,
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  GlobeIcon,
  ImageIcon,
  Link2Icon,
  MapPinIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  ALLOWED_BUSINESS_CATEGORIES,
  ALLOWED_ITEMS_PER_PAGE,
  ALLOWED_SOCIAL_PLATFORMS,
  ALL_OFFERING_TYPES,
  FIXED_PUBLIC_ROUTES,
  formatDateOnlyPreservingSemantics,
  formatTimestampInTenantTimezone,
  RECOMMENDED_INDONESIAN_TIMEZONES,
  validateGoogleMapsReviewUrl,
  type EditableSettingsTab,
  type GroupedSettingsSnapshot,
  type HomepageMode,
  type ItemsPerPageOption,
  type SettingsSocialPlatform,
} from "@punyasitus/core/settings/index";
import { evaluateGoogleBusinessProfileChecklist } from "@punyasitus/core/presets/index";
import type { OfferingType } from "@punyasitus/core/schemas/common";
import type { GroupedSettingsAdminDto, SettingsPageOption } from "@punyasitus/db/settings/index";
import {
  CmsApiError,
  cmsFetchJson,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor/cms-client-helpers";
import { MediaPickerSheet } from "@/components/admin/media";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { GroupedSettingsPermissions } from "@/core/settings";

export interface GroupedSettingsWorkspaceProps {
  readonly handle: string;
  readonly basePath: string;
  readonly publicSiteHref: string;
  readonly initialTab: EditableSettingsTab;
  readonly permissions: GroupedSettingsPermissions;
  readonly initialState: GroupedSettingsAdminDto;
  readonly initialLoadError?: string | null;
}

interface GroupApiResponse {
  readonly group: string;
  readonly draftVersion: number;
  readonly publishedVersion: number;
  readonly version: number;
  readonly hasUnpublishedChanges: boolean;
  readonly updatedAt: string | null;
  readonly publishedAt: string | null;
  readonly draft?: GroupedSettingsSnapshot;
  readonly published?: GroupedSettingsSnapshot | null;
  readonly availablePages?: readonly SettingsPageOption[];
}

interface TabConfig {
  readonly id: EditableSettingsTab;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
}

const SETTINGS_TABS: readonly TabConfig[] = [
  {
    id: "general",
    label: "Umum",
    shortLabel: "Umum",
    description: "Nama situs, tagline, logo, favicon, zona waktu, dan email publik.",
  },
  {
    id: "business",
    label: "Bisnis & Kontak",
    shortLabel: "Bisnis",
    description: "Profil bisnis, kategori Schema.org, WhatsApp, alamat, jam operasional, dan media sosial.",
  },
  {
    id: "reading",
    label: "Membaca & Beranda",
    shortLabel: "Membaca",
    description: "Mode beranda, aktif/nonaktif blog & katalog penawaran, serta jumlah item per halaman.",
  },
  {
    id: "seo",
    label: "SEO & Sosial",
    shortLabel: "SEO",
    description: "Judul & deskripsi default, gambar OG, visibilitas mesin pencari, dan token verifikasi.",
  },
  {
    id: "privacy",
    label: "Privasi",
    shortLabel: "Privasi",
    description: "Halaman kebijakan privasi, teks banner persetujuan, dan versi kebijakan.",
  },
] as const;

const OFFERING_LABELS: Readonly<Record<OfferingType, { readonly label: string; readonly route: string }>> = {
  service: { label: "Layanan", route: FIXED_PUBLIC_ROUTES.offerings.service },
  product: { label: "Produk", route: FIXED_PUBLIC_ROUTES.offerings.product },
  tour: { label: "Paket Tur", route: FIXED_PUBLIC_ROUTES.offerings.tour },
  vehicle: { label: "Kendaraan", route: FIXED_PUBLIC_ROUTES.offerings.vehicle },
};

const BUSINESS_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  LocalBusiness: "Bisnis Lokal (LocalBusiness)",
  Organization: "Organisasi / Perusahaan (Organization)",
  TravelAgency: "Biro Travel & Umrah (TravelAgency)",
  Restaurant: "Restoran & Kuliner (Restaurant)",
  AutoDealer: "Dealer Kendaraan (AutoDealer)",
  MedicalClinic: "Klinik Kesehatan (MedicalClinic)",
  LegalService: "Jasa Hukum / Notaris (LegalService)",
  AccountingService: "Jasa Akuntansi & Pajak (AccountingService)",
  EducationalOrganization: "Lembaga Pendidikan (EducationalOrganization)",
  HomeAndConstructionBusiness: "Konstruksi & Properti (HomeAndConstructionBusiness)",
  Store: "Toko Ritel (Store)",
  RealEstateAgent: "Agen Properti (RealEstateAgent)",
  FinancialService: "Layanan Keuangan (FinancialService)",
  SportsActivityLocation: "Fasilitas Olahraga (SportsActivityLocation)",
  HealthAndBeautyBusiness: "Kecantikan & Perawatan (HealthAndBeautyBusiness)",
  LodgingBusiness: "Penginapan & Hotel (LodgingBusiness)",
};

const SOCIAL_LABELS: Readonly<Record<SettingsSocialPlatform, string>> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X (Twitter)",
  website: "Situs Web Lain",
};

const SAMPLE_UTC_INSTANT_ISO = "2026-12-15T16:30:00.000Z";
const SAMPLE_DATE_ONLY_DEPARTURE = "2026-12-15";

type MediaPickerTarget = null | "logo" | "logoLight" | "logoDark" | "favicon" | "ogImage";

export function GroupedSettingsWorkspace({
  handle,
  basePath,
  publicSiteHref,
  initialTab,
  permissions,
  initialState,
  initialLoadError = null,
}: GroupedSettingsWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<EditableSettingsTab>(initialTab);
  const tabButtonRefs = useRef<Partial<Record<EditableSettingsTab, HTMLButtonElement | null>>>({});

  // Authoritative server version & metadata
  const [version, setVersion] = useState(initialState.version);
  const [publishedVersion, setPublishedVersion] = useState(initialState.publishedVersion);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    initialState.hasUnpublishedChanges,
  );
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialState.updatedAt);
  const [publishedAt, setPublishedAt] = useState<string | null>(initialState.publishedAt);
  const [availablePages, setAvailablePages] = useState<readonly SettingsPageOption[]>(
    initialState.availablePages,
  );

  // Group 1: General
  const [siteTitle, setSiteTitle] = useState(initialState.draft.general.siteTitle);
  const [tagline, setTagline] = useState(initialState.draft.general.tagline ?? "");
  const [timezone, setTimezone] = useState(initialState.draft.general.timezone);
  const [locale] = useState(initialState.draft.general.locale);
  const [publicEmail, setPublicEmail] = useState(initialState.draft.general.publicEmail ?? "");
  const [logoMediaId, setLogoMediaId] = useState<number | null>(
    initialState.draft.general.logoMediaId,
  );
  const [logoLightMediaId, setLogoLightMediaId] = useState<number | null>(
    initialState.draft.general.logoLightMediaId,
  );
  const [logoDarkMediaId, setLogoDarkMediaId] = useState<number | null>(
    initialState.draft.general.logoDarkMediaId,
  );
  const [faviconMediaId, setFaviconMediaId] = useState<number | null>(
    initialState.draft.general.faviconMediaId,
  );

  // Group 2: Business & Contact
  const [businessName, setBusinessName] = useState(initialState.draft.business.businessName);
  const [businessCategory, setBusinessCategory] = useState(
    initialState.draft.business.businessCategory,
  );
  const [description, setDescription] = useState(initialState.draft.business.description ?? "");
  const [phone, setPhone] = useState(initialState.draft.business.phone ?? "");
  const [whatsappE164, setWhatsappE164] = useState(initialState.draft.business.whatsappE164 ?? "");
  const [businessEmail, setBusinessEmail] = useState(initialState.draft.business.email ?? "");
  const [address, setAddress] = useState(initialState.draft.business.address ?? "");
  const [city, setCity] = useState(initialState.draft.business.city ?? "");
  const [province, setProvince] = useState(initialState.draft.business.province ?? "");
  const [postalCode, setPostalCode] = useState(initialState.draft.business.postalCode ?? "");
  const [mapsUrl, setMapsUrl] = useState(initialState.draft.business.mapsUrl ?? "");
  const [googleMapsReviewUrl, setGoogleMapsReviewUrl] = useState(
    initialState.draft.business.googleMapsReviewUrl ?? "",
  );
  const [publishedGoogleMapsReviewUrl, setPublishedGoogleMapsReviewUrl] = useState<string | null>(
    initialState.published?.business?.googleMapsReviewUrl ?? null,
  );
  const [copiedGbpSiteUrl, setCopiedGbpSiteUrl] = useState(false);
  const [weekdayHours, setWeekdayHours] = useState(initialState.draft.business.weekdayHours ?? "");
  const [holidayHours, setHolidayHours] = useState(initialState.draft.business.holidayHours ?? "");
  const [serviceAreas, setServiceAreas] = useState<string[]>([
    ...initialState.draft.business.serviceAreas,
  ]);
  const [newServiceArea, setNewServiceArea] = useState("");
  const [socialLinks, setSocialLinks] = useState<
    Array<{ platform: SettingsSocialPlatform; url: string }>
  >(initialState.draft.business.socialLinks.map((s) => ({ platform: s.platform, url: s.url })));

  // Group 3: Reading & Homepage
  const [homepageMode, setHomepageMode] = useState<HomepageMode>(
    initialState.draft.reading.homepageMode,
  );
  const [homepagePageId, setHomepagePageId] = useState<number | null>(
    initialState.draft.reading.homepagePageId,
  );
  const [blogEnabled, setBlogEnabled] = useState(initialState.draft.reading.blogEnabled);
  const [catalogEnabled, setCatalogEnabled] = useState(initialState.draft.reading.catalogEnabled);
  const [enabledOfferingTypes, setEnabledOfferingTypes] = useState<OfferingType[]>([
    ...initialState.draft.reading.enabledOfferingTypes,
  ]);
  const [itemsPerPage, setItemsPerPage] = useState<ItemsPerPageOption>(
    initialState.draft.reading.itemsPerPage,
  );

  // Group 4: SEO & Social Defaults
  const [defaultTitle, setDefaultTitle] = useState(initialState.draft.seo.defaultTitle ?? "");
  const [defaultDescription, setDefaultDescription] = useState(
    initialState.draft.seo.defaultDescription ?? "",
  );
  const [ogImageMediaId, setOgImageMediaId] = useState<number | null>(
    initialState.draft.seo.ogImageMediaId,
  );
  const [siteVisibility, setSiteVisibility] = useState<"public" | "noindex">(
    initialState.draft.seo.siteVisibility,
  );
  const [aiTrainingPolicy, setAiTrainingPolicy] = useState<"allow" | "disallow">(
    initialState.draft.seo.aiTrainingPolicy,
  );
  const [googleSiteVerification, setGoogleSiteVerification] = useState(
    initialState.draft.seo.googleSiteVerification ?? "",
  );
  const [bingSiteVerification, setBingSiteVerification] = useState(
    initialState.draft.seo.bingSiteVerification ?? "",
  );

  // Group 5: Privacy & Consent
  const [privacyPageId, setPrivacyPageId] = useState<number | null>(
    initialState.draft.privacy.privacyPageId,
  );
  const [consentBannerText, setConsentBannerText] = useState(
    initialState.draft.privacy.consentBannerText ?? "",
  );
  const [consentPolicyVersion, setConsentPolicyVersion] = useState(
    initialState.draft.privacy.consentPolicyVersion,
  );

  // Dirty flags per tab & async UI states
  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<EditableSettingsTab, boolean>>>({});
  const [savingGroup, setSavingGroup] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "destructive" | "warning";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [pickerTarget, setPickerTarget] = useState<MediaPickerTarget>(null);

  const hasAnyDirty = useMemo(() => Object.values(dirtyTabs).some(Boolean), [dirtyTabs]);
  const isCurrentTabDirty = Boolean(dirtyTabs[activeTab]);
  useDirtyNavigationGuard(hasAnyDirty);

  const canMutate = permissions.canWriteSettings && !permissions.isLocked;
  const canPublish = permissions.canPublishSettings && !permissions.isLocked;
  const readOnly = !canMutate;

  const publishedPages = useMemo(
    () => availablePages.filter((p) => p.isPublished),
    [availablePages],
  );

  const markTabDirty = useCallback((tab: EditableSettingsTab) => {
    setDirtyTabs((prev) => ({ ...prev, [tab]: true }));
    setBanner(null);
    setConflictMessage(null);
  }, []);

  const hydrateFromSnapshot = useCallback(
    (snapshot: GroupedSettingsSnapshot, meta: {
      readonly version: number;
      readonly publishedVersion: number;
      readonly hasUnpublishedChanges: boolean;
      readonly updatedAt: string | null;
      readonly publishedAt: string | null;
      readonly availablePages?: readonly SettingsPageOption[];
      readonly publishedSnapshot?: GroupedSettingsSnapshot | null;
    }) => {
      setSiteTitle(snapshot.general.siteTitle);
      setTagline(snapshot.general.tagline ?? "");
      setTimezone(snapshot.general.timezone);
      setPublicEmail(snapshot.general.publicEmail ?? "");
      setLogoMediaId(snapshot.general.logoMediaId);
      setLogoLightMediaId(snapshot.general.logoLightMediaId);
      setLogoDarkMediaId(snapshot.general.logoDarkMediaId);
      setFaviconMediaId(snapshot.general.faviconMediaId);

      setBusinessName(snapshot.business.businessName);
      setBusinessCategory(snapshot.business.businessCategory);
      setDescription(snapshot.business.description ?? "");
      setPhone(snapshot.business.phone ?? "");
      setWhatsappE164(snapshot.business.whatsappE164 ?? "");
      setBusinessEmail(snapshot.business.email ?? "");
      setAddress(snapshot.business.address ?? "");
      setCity(snapshot.business.city ?? "");
      setProvince(snapshot.business.province ?? "");
      setPostalCode(snapshot.business.postalCode ?? "");
      setMapsUrl(snapshot.business.mapsUrl ?? "");
      setGoogleMapsReviewUrl(snapshot.business.googleMapsReviewUrl ?? "");
      if (meta.publishedSnapshot !== undefined) {
        setPublishedGoogleMapsReviewUrl(
          meta.publishedSnapshot?.business?.googleMapsReviewUrl ?? null,
        );
      }
      setWeekdayHours(snapshot.business.weekdayHours ?? "");
      setHolidayHours(snapshot.business.holidayHours ?? "");
      setServiceAreas([...snapshot.business.serviceAreas]);
      setSocialLinks(
        snapshot.business.socialLinks.map((item) => ({
          platform: item.platform,
          url: item.url,
        })),
      );

      setHomepageMode(snapshot.reading.homepageMode);
      setHomepagePageId(snapshot.reading.homepagePageId);
      setBlogEnabled(snapshot.reading.blogEnabled);
      setCatalogEnabled(snapshot.reading.catalogEnabled);
      setEnabledOfferingTypes([...snapshot.reading.enabledOfferingTypes]);
      setItemsPerPage(snapshot.reading.itemsPerPage);

      setDefaultTitle(snapshot.seo.defaultTitle ?? "");
      setDefaultDescription(snapshot.seo.defaultDescription ?? "");
      setOgImageMediaId(snapshot.seo.ogImageMediaId);
      setSiteVisibility(snapshot.seo.siteVisibility);
      setAiTrainingPolicy(snapshot.seo.aiTrainingPolicy);
      setGoogleSiteVerification(snapshot.seo.googleSiteVerification ?? "");
      setBingSiteVerification(snapshot.seo.bingSiteVerification ?? "");

      setPrivacyPageId(snapshot.privacy.privacyPageId);
      setConsentBannerText(snapshot.privacy.consentBannerText ?? "");
      setConsentPolicyVersion(snapshot.privacy.consentPolicyVersion);

      setVersion(meta.version);
      setPublishedVersion(meta.publishedVersion);
      setHasUnpublishedChanges(meta.hasUnpublishedChanges);
      setUpdatedAt(meta.updatedAt);
      setPublishedAt(meta.publishedAt);
      if (meta.availablePages) {
        setAvailablePages(meta.availablePages);
      }
    },
    [],
  );

  // Keep browser URL query in sync without full reload when switching tabs
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      if (url.pathname.endsWith("/settings") || url.pathname.endsWith("/settings/")) {
        url.searchParams.set("group", activeTab);
        window.history.replaceState(null, "", url.toString());
      }
    } catch {
      // Ignore history API restrictions
    }
  }, [activeTab]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SETTINGS_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const target = SETTINGS_TABS[nextIndex];
    if (target) {
      setActiveTab(target.id);
      tabButtonRefs.current[target.id]?.focus();
    }
  }

  async function reloadLatestFromServer() {
    if (reloading) return;
    setReloading(true);
    setLoadError(null);
    setConflictMessage(null);
    setFieldErrors({});
    try {
      const latest = await cmsFetchJson<GroupedSettingsAdminDto>(
        `/api/tenants/${encodeURIComponent(handle)}/settings`,
      );
      hydrateFromSnapshot(latest.draft, {
        version: latest.version,
        publishedVersion: latest.publishedVersion,
        hasUnpublishedChanges: latest.hasUnpublishedChanges,
        updatedAt: latest.updatedAt,
        publishedAt: latest.publishedAt,
        availablePages: latest.availablePages,
        publishedSnapshot: latest.published,
      });
      setDirtyTabs({});
      setBanner({
        tone: "success",
        title: "Versi terbaru dimuat",
        message: `Seluruh pengaturan disinkronkan ke versi v${latest.version}.`,
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Gagal memuat pengaturan terbaru dari server. Coba lagi.";
      setLoadError(msg);
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang pengaturan",
        message: msg,
      });
    } finally {
      setReloading(false);
    }
  }

  function buildPayloadForTab(tab: EditableSettingsTab): Record<string, unknown> {
    switch (tab) {
      case "general":
        return {
          expectedVersion: version,
          siteTitle: siteTitle.trim(),
          tagline: tagline.trim() || null,
          timezone: timezone.trim() || "Asia/Jakarta",
          locale,
          publicEmail: publicEmail.trim() || null,
          logoMediaId,
          logoLightMediaId,
          logoDarkMediaId,
          faviconMediaId,
        };
      case "business":
        return {
          expectedVersion: version,
          businessName: businessName.trim(),
          businessCategory: businessCategory.trim() || "LocalBusiness",
          description: description.trim() || null,
          phone: phone.trim() || null,
          whatsappE164: whatsappE164.trim() || null,
          email: businessEmail.trim() || null,
          address: address.trim() || null,
          city: city.trim() || null,
          province: province.trim() || null,
          postalCode: postalCode.trim() || null,
          mapsUrl: mapsUrl.trim() || null,
          googleMapsReviewUrl: googleMapsReviewUrl.trim() || null,
          weekdayHours: weekdayHours.trim() || null,
          holidayHours: holidayHours.trim() || null,
          serviceAreas: serviceAreas.map((s) => s.trim()).filter(Boolean),
          socialLinks: socialLinks
            .map((link) => ({ platform: link.platform, url: link.url.trim() }))
            .filter((link) => link.url.length > 0),
        };
      case "reading":
        return {
          expectedVersion: version,
          homepageMode,
          homepagePageId: homepageMode === "page" ? homepagePageId : null,
          blogEnabled,
          catalogEnabled,
          enabledOfferingTypes: catalogEnabled ? enabledOfferingTypes : [],
          itemsPerPage,
        };
      case "seo":
        return {
          expectedVersion: version,
          defaultTitle: defaultTitle.trim() || null,
          defaultDescription: defaultDescription.trim() || null,
          ogImageMediaId,
          siteVisibility,
          aiTrainingPolicy,
          googleSiteVerification: googleSiteVerification.trim() || null,
          bingSiteVerification: bingSiteVerification.trim() || null,
        };
      case "privacy":
        return {
          expectedVersion: version,
          privacyPageId,
          consentBannerText: consentBannerText.trim() || null,
          consentPolicyVersion,
        };
    }
  }

  function validateClientTab(tab: EditableSettingsTab): boolean {
    const errs: Record<string, string> = {};
    if (tab === "general" && !siteTitle.trim()) {
      errs.siteTitle = "Nama situs wajib diisi.";
    }
    if (tab === "business") {
      if (!businessName.trim()) {
        errs.businessName = "Nama bisnis wajib diisi.";
      }
      if (mapsUrl.trim() && !mapsUrl.trim().startsWith("https://")) {
        errs.mapsUrl = "Tautan Google Maps harus diawali https://.";
      }
      if (googleMapsReviewUrl.trim()) {
        const reviewValidation = validateGoogleMapsReviewUrl(googleMapsReviewUrl.trim());
        if (!reviewValidation.ok) {
          errs.googleMapsReviewUrl = reviewValidation.message;
        }
      }
    }
    if (tab === "reading" && homepageMode === "page" && homepagePageId === null) {
      errs.homepagePageId = "Pilih halaman yang sudah diterbitkan sebagai beranda.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function saveActiveGroupDraft(): Promise<number | null> {
    if (readOnly || savingGroup || publishing) return null;
    if (!validateClientTab(activeTab)) return null;

    setSavingGroup(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const payload = buildPayloadForTab(activeTab);
      const saved = await cmsFetchJson<GroupApiResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/settings/${encodeURIComponent(activeTab)}`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
      );

      if (saved.draft) {
        hydrateFromSnapshot(saved.draft, {
          version: saved.version,
          publishedVersion: saved.publishedVersion,
          hasUnpublishedChanges: saved.hasUnpublishedChanges,
          updatedAt: saved.updatedAt,
          publishedAt: saved.publishedAt,
          availablePages: saved.availablePages,
          publishedSnapshot: saved.published,
        });
      } else {
        setVersion(saved.version);
        setPublishedVersion(saved.publishedVersion);
        setHasUnpublishedChanges(saved.hasUnpublishedChanges);
        setUpdatedAt(saved.updatedAt);
        setPublishedAt(saved.publishedAt);
      }

      setDirtyTabs((prev) => ({ ...prev, [activeTab]: false }));
      const tabLabel = SETTINGS_TABS.find((t) => t.id === activeTab)?.label ?? activeTab;
      setBanner({
        tone: "success",
        title: `Draf ${tabLabel} tersimpan`,
        message: `Perubahan disimpan pada draf versi v${saved.version}. Situs publik belum berubah sampai Anda menekan Terbitkan ke situs.`,
      });
      return saved.version;
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setBanner({
            tone: "destructive",
            title: err.isForbidden
              ? "Akses ditolak untuk menyimpan pengaturan"
              : "Validasi pengaturan gagal",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan draf pengaturan",
          message: "Gangguan koneksi terjadi. Isian Anda tetap dipertahankan untuk dicoba ulang.",
        });
      }
      return null;
    } finally {
      setSavingGroup(false);
    }
  }

  async function handlePublishSettings() {
    if (!canPublish || publishing || savingGroup) return;

    let versionToPublish = version;
    if (isCurrentTabDirty) {
      const savedVersion = await saveActiveGroupDraft();
      if (savedVersion === null) return;
      versionToPublish = savedVersion;
    }

    setPublishing(true);
    setConflictMessage(null);
    setBanner(null);

    try {
      const result = await cmsFetchJson<GroupApiResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/settings/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: versionToPublish,
            group: activeTab,
          }),
        },
      );

      setVersion(result.version);
      setPublishedVersion(result.publishedVersion);
      setHasUnpublishedChanges(false);
      setUpdatedAt(result.updatedAt);
      setPublishedAt(result.publishedAt);
      setPublishedGoogleMapsReviewUrl(
        result.published?.business?.googleMapsReviewUrl ?? (googleMapsReviewUrl.trim() || null),
      );
      setDirtyTabs({});
      setBanner({
        tone: "success",
        title: "Pengaturan berhasil diterbitkan",
        message: `Versi v${result.publishedVersion} kini aktif di situs publik dan cache halaman telah diperbarui secara atomik.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setBanner({
            tone: "destructive",
            title: err.isForbidden
              ? "Akses ditolak untuk menerbitkan pengaturan"
              : "Publikasi pengaturan gagal",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Publikasi gagal",
          message: "Gangguan jaringan terjadi saat menerbitkan pengaturan. Coba lagi.",
        });
      }
    } finally {
      setPublishing(false);
    }
  }

  function toggleOfferingType(offeringType: OfferingType) {
    if (readOnly) return;
    markTabDirty("reading");
    setEnabledOfferingTypes((prev) => {
      const exists = prev.includes(offeringType);
      const next = exists
        ? prev.filter((item) => item !== offeringType)
        : ALL_OFFERING_TYPES.filter((t) => prev.includes(t) || t === offeringType);
      setCatalogEnabled(next.length > 0);
      return next;
    });
  }

  function addServiceArea() {
    if (readOnly) return;
    const clean = newServiceArea.trim();
    if (!clean || serviceAreas.length >= 20) return;
    if (!serviceAreas.some((a) => a.toLowerCase() === clean.toLowerCase())) {
      setServiceAreas((prev) => [...prev, clean]);
      markTabDirty("business");
    }
    setNewServiceArea("");
  }

  function removeServiceArea(index: number) {
    if (readOnly) return;
    setServiceAreas((prev) => prev.filter((_, idx) => idx !== index));
    markTabDirty("business");
  }

  function addSocialLinkRow() {
    if (readOnly || socialLinks.length >= 10) return;
    setSocialLinks((prev) => [...prev, { platform: "instagram", url: "" }]);
    markTabDirty("business");
  }

  function updateSocialLink(index: number, patch: Partial<{ platform: SettingsSocialPlatform; url: string }>) {
    if (readOnly) return;
    setSocialLinks((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    );
    markTabDirty("business");
  }

  function removeSocialLink(index: number) {
    if (readOnly) return;
    setSocialLinks((prev) => prev.filter((_, idx) => idx !== index));
    markTabDirty("business");
  }

  const lastSavedFormatted = useMemo(
    () => formatTimestampInTenantTimezone(updatedAt, timezone, locale) ?? "Belum pernah disimpan",
    [updatedAt, timezone, locale],
  );
  const lastPublishedFormatted = useMemo(
    () =>
      formatTimestampInTenantTimezone(publishedAt, timezone, locale) ?? "Belum pernah diterbitkan",
    [publishedAt, timezone, locale],
  );
  const sampleUtcInTimezone = useMemo(
    () => formatTimestampInTenantTimezone(SAMPLE_UTC_INSTANT_ISO, timezone, locale) ?? "-",
    [timezone, locale],
  );
  const sampleDateOnlyFormatted = useMemo(
    () => formatDateOnlyPreservingSemantics(SAMPLE_DATE_ONLY_DEPARTURE, locale),
    [locale],
  );

  const googleMapsReviewValidation = useMemo(() => {
    const trimmed = googleMapsReviewUrl.trim();
    if (!trimmed) return null;
    return validateGoogleMapsReviewUrl(trimmed);
  }, [googleMapsReviewUrl]);

  const gbpChecklist = useMemo(
    () =>
      evaluateGoogleBusinessProfileChecklist({
        handle,
        publicSiteHref,
        googleMapsReviewUrl: googleMapsReviewUrl.trim() || null,
        hasPublishedReviewUrl: Boolean(
          publishedGoogleMapsReviewUrl &&
            publishedGoogleMapsReviewUrl === googleMapsReviewUrl.trim(),
        ),
        isSitePublished: publishedVersion > 0,
      }),
    [handle, publicSiteHref, googleMapsReviewUrl, publishedGoogleMapsReviewUrl, publishedVersion],
  );

  async function copyPublicSiteUrlForGbp() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(gbpChecklist.publicSiteUrl);
      }
      setCopiedGbpSiteUrl(true);
      window.setTimeout(() => setCopiedGbpSiteUrl(false), 2000);
    } catch {
      setCopiedGbpSiteUrl(false);
    }
  }

  const activeTabMeta = SETTINGS_TABS.find((t) => t.id === activeTab) ?? SETTINGS_TABS[0];

  return (
    <div className="space-y-6 pb-20 md:pb-6" data-testid="grouped-settings-workspace">
      {/* Page Header & Version / Publish Status Bar */}
      <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Pengaturan Situs
            </h1>
            <Badge
              variant="outline"
              className="font-mono text-xs tabular-nums"
              data-testid="settings-version-badge"
            >
              Draf v{version}
            </Badge>
            <Badge
              variant={publishedVersion > 0 ? "secondary" : "outline"}
              className="font-mono text-xs tabular-nums"
              data-testid="settings-live-version-badge"
            >
              {publishedVersion > 0 ? `Tayang v${publishedVersion}` : "Belum tayang"}
            </Badge>
            {hasUnpublishedChanges ? (
              <Badge variant="warning" data-testid="settings-unpublished-badge">
                Draf belum diterbitkan
              </Badge>
            ) : (
              <Badge variant="success" data-testid="settings-synced-badge">
                Sesuai versi tayang
              </Badge>
            )}
            {isCurrentTabDirty && (
              <Badge variant="outline" data-testid="settings-unsaved-badge">
                Perubahan belum disimpan
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Kelola identitas umum, profil bisnis, pengaturan membaca/beranda, SEO default, dan privasi.
            Simpan draf tanpa mengganggu situs publik, lalu terbitkan secara atomik saat siap.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <span className="inline-flex items-center gap-1" data-testid="settings-last-saved">
              <ClockIcon className="size-3.5" aria-hidden="true" />
              Terakhir disimpan: {lastSavedFormatted}
            </span>
            <span className="inline-flex items-center gap-1" data-testid="settings-last-published">
              <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
              Terakhir diterbitkan: {lastPublishedFormatted}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reloading || savingGroup || publishing}
            onClick={() => void reloadLatestFromServer()}
            className="min-h-11 md:min-h-9"
            data-testid="settings-reload-btn"
          >
            <RefreshCwIcon
              className={`size-4 ${reloading ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Muat ulang
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly || savingGroup || publishing || reloading}
            onClick={() => void saveActiveGroupDraft()}
            className="min-h-11 md:min-h-9"
            data-testid="settings-save-draft-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            {savingGroup ? "Menyimpan draf..." : "Simpan draf"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canPublish || publishing || savingGroup || reloading}
            onClick={() => void handlePublishSettings()}
            className="min-h-11 md:min-h-9"
            data-testid="settings-publish-btn"
          >
            <SendIcon className="size-4" aria-hidden="true" />
            {publishing ? "Menerbitkan..." : "Terbitkan ke situs"}
          </Button>
        </div>
      </div>

      {/* Permission / Locked / Conflict / Error / Success Banners */}
      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {!permissions.isLocked && !permissions.canWriteSettings && (
        <Alert variant="warning" data-testid="settings-readonly-permission-banner">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Peran Anda tidak memiliki izin untuk mengubah atau menerbitkan pengaturan situs.
            Hubungi Pemilik Situs atau Admin untuk melakukan perubahan.
          </AlertDescription>
        </Alert>
      )}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={reloadLatestFromServer}
          onDismiss={() => setConflictMessage(null)}
        />
      )}

      {loadError && !conflictMessage && (
        <Alert variant="destructive" data-testid="settings-load-error-banner">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat data pengaturan</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {banner && (
        <Alert
          variant={banner.tone === "success" ? "success" : banner.tone === "warning" ? "warning" : "destructive"}
          data-testid={`settings-banner-${banner.tone}`}
          role="status"
          aria-live="polite"
        >
          {banner.tone === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertTriangleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* Horizontal Accessible Tablist Navigation */}
      <div className="overflow-x-auto pb-1">
        <div
          role="tablist"
          aria-label="Grup pengaturan situs"
          className="inline-flex min-w-full items-center gap-1 rounded-lg border border-border bg-muted/60 p-1 sm:min-w-0"
        >
          {SETTINGS_TABS.map((tab, idx) => {
            const selected = activeTab === tab.id;
            const dirty = Boolean(dirtyTabs[tab.id]);
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabButtonRefs.current[tab.id] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                data-testid={`settings-tab-${tab.id}`}
                className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 ${
                  selected
                    ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.id === "general" && <SettingsIcon className="size-4" aria-hidden="true" />}
                {tab.id === "business" && <Building2Icon className="size-4" aria-hidden="true" />}
                {tab.id === "reading" && <BookOpenIcon className="size-4" aria-hidden="true" />}
                {tab.id === "seo" && <SearchIcon className="size-4" aria-hidden="true" />}
                {tab.id === "privacy" && <ShieldCheckIcon className="size-4" aria-hidden="true" />}
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.shortLabel}</span>
                {dirty && (
                  <span
                    className="size-2 rounded-full bg-primary"
                    aria-label="Ada perubahan belum disimpan"
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content Grid: Active Group Form + Related Modules Rail */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Active Tab Panel */}
        <div
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          className="min-w-0 space-y-5"
        >
          {reloading ? (
            <Card data-testid="settings-loading-skeleton">
              <CardHeader>
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-72" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-24 w-full" />
              </CardContent>
            </Card>
          ) : (
            <>
              {/* TAB 1: GENERAL */}
              {activeTab === "general" && (
                <Card>
                  <CardHeader>
                    <CardTitle>{activeTabMeta?.label}</CardTitle>
                    <CardDescription>{activeTabMeta?.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-site-title"
                          className="block text-sm font-medium text-foreground"
                        >
                          Nama Situs <span className="text-destructive">*</span>
                        </label>
                        <Input
                          id="settings-site-title"
                          data-testid="input-site-title"
                          value={siteTitle}
                          disabled={readOnly}
                          maxLength={120}
                          onChange={(e) => {
                            setSiteTitle(e.target.value);
                            markTabDirty("general");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Contoh: PT Nusantara Mandiri"
                        />
                        <InlineFieldError message={fieldErrors.siteTitle} />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-tagline"
                          className="block text-sm font-medium text-foreground"
                        >
                          Tagline Situs
                        </label>
                        <Input
                          id="settings-tagline"
                          data-testid="input-tagline"
                          value={tagline}
                          disabled={readOnly}
                          maxLength={240}
                          onChange={(e) => {
                            setTagline(e.target.value);
                            markTabDirty("general");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Deskripsi singkat di bawah nama situs"
                        />
                        <InlineFieldError message={fieldErrors.tagline} />
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-timezone"
                          className="block text-sm font-medium text-foreground"
                        >
                          Zona Waktu Tampilan (IANA)
                        </label>
                        <select
                          id="settings-timezone"
                          data-testid="select-timezone"
                          value={timezone}
                          disabled={readOnly}
                          onChange={(e) => {
                            setTimezone(e.target.value);
                            markTabDirty("general");
                          }}
                          className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 md:text-sm"
                        >
                          {RECOMMENDED_INDONESIAN_TIMEZONES.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}
                            </option>
                          ))}
                          {!RECOMMENDED_INDONESIAN_TIMEZONES.some((tz) => tz.value === timezone) && (
                            <option value={timezone}>{timezone}</option>
                          )}
                        </select>
                        <InlineFieldError message={fieldErrors.timezone} />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-public-email"
                          className="block text-sm font-medium text-foreground"
                        >
                          Email Publik Bisnis
                        </label>
                        <Input
                          id="settings-public-email"
                          data-testid="input-public-email"
                          type="email"
                          value={publicEmail}
                          disabled={readOnly}
                          onChange={(e) => {
                            setPublicEmail(e.target.value);
                            setBusinessEmail(e.target.value);
                            markTabDirty("general");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="halo@perusahaan.co.id"
                        />
                        <p className="text-xs text-muted-foreground">
                          Terpisah dari email akun login Better Auth Anda. Hanya email ini yang tampil ke publik.
                        </p>
                        <InlineFieldError message={fieldErrors.publicEmail} />
                      </div>
                    </div>

                    {/* Timezone UTC vs Date-Only Semantics Preview */}
                    <div
                      className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground"
                      data-testid="timezone-semantics-preview"
                    >
                      <div className="font-medium text-foreground">
                        Pratinjau Semantik Zona Waktu ({timezone})
                      </div>
                      <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 tabular-nums">
                        <div>
                          <span className="block text-muted-foreground">
                            Contoh timestamp UTC ({SAMPLE_UTC_INSTANT_ISO}):
                          </span>
                          <span className="font-medium text-foreground" data-testid="timezone-preview-utc">
                            {sampleUtcInTimezone}
                          </span>
                        </div>
                        <div>
                          <span className="block text-muted-foreground">
                            Contoh tanggal keberangkatan tur (date-only {SAMPLE_DATE_ONLY_DEPARTURE}):
                          </span>
                          <span className="font-medium text-foreground" data-testid="timezone-preview-date-only">
                            {sampleDateOnlyFormatted} (tetap tidak bergeser)
                          </span>
                        </div>
                      </div>
                    </div>

                    <Separator />

                    {/* Brand Media Assets (Logo variants + Favicon) */}
                    <div className="space-y-3">
                      <h2 className="text-sm font-semibold text-foreground">
                        Aset Identitas Visual (Logo & Favicon)
                      </h2>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(
                          [
                            {
                              key: "logo",
                              label: "Logo Utama",
                              value: logoMediaId,
                              setter: setLogoMediaId,
                            },
                            {
                              key: "logoLight",
                              label: "Logo Mode Terang",
                              value: logoLightMediaId,
                              setter: setLogoLightMediaId,
                            },
                            {
                              key: "logoDark",
                              label: "Logo Mode Gelap",
                              value: logoDarkMediaId,
                              setter: setLogoDarkMediaId,
                            },
                            {
                              key: "favicon",
                              label: "Favicon Situs",
                              value: faviconMediaId,
                              setter: setFaviconMediaId,
                            },
                          ] as const
                        ).map((asset) => (
                          <div
                            key={asset.key}
                            className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-3"
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-foreground">{asset.label}</div>
                              <div className="text-xs text-muted-foreground tabular-nums">
                                {asset.value ? `Media #${asset.value}` : "Belum dipilih"}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={readOnly}
                                onClick={() => setPickerTarget(asset.key)}
                                className="min-h-11 md:min-h-8"
                                data-testid={`pick-media-${asset.key}`}
                              >
                                <ImageIcon className="size-3.5" aria-hidden="true" />
                                Pilih
                              </Button>
                              {asset.value !== null && !readOnly && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Hapus ${asset.label}`}
                                  onClick={() => {
                                    asset.setter(null);
                                    markTabDirty("general");
                                  }}
                                  className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                >
                                  <XIcon className="size-3.5" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      <InlineFieldError
                        message={
                          fieldErrors.logoMediaId ??
                          fieldErrors.logoLightMediaId ??
                          fieldErrors.logoDarkMediaId ??
                          fieldErrors.faviconMediaId
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* TAB 2: BUSINESS & CONTACT */}
              {activeTab === "business" && (
                <Card className="min-w-0 overflow-hidden">
                  <CardHeader>
                    <CardTitle>{activeTabMeta?.label}</CardTitle>
                    <CardDescription>{activeTabMeta?.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 space-y-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="min-w-0 space-y-1.5">
                        <label
                          htmlFor="settings-business-name"
                          className="block text-sm font-medium text-foreground"
                        >
                          Nama Resmi Bisnis <span className="text-destructive">*</span>
                        </label>
                        <Input
                          id="settings-business-name"
                          data-testid="input-business-name"
                          value={businessName}
                          disabled={readOnly}
                          maxLength={160}
                          onChange={(e) => {
                            setBusinessName(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                        />
                        <InlineFieldError message={fieldErrors.businessName} />
                      </div>

                      <div className="min-w-0 space-y-1.5">
                        <label
                          htmlFor="settings-business-category"
                          className="block text-sm font-medium text-foreground"
                        >
                          Kategori Bisnis (Schema.org)
                        </label>
                        <select
                          id="settings-business-category"
                          data-testid="select-business-category"
                          value={businessCategory}
                          disabled={readOnly}
                          onChange={(e) => {
                            setBusinessCategory(e.target.value);
                            markTabDirty("business");
                          }}
                          className="flex min-h-11 w-full min-w-0 max-w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9 md:text-sm"
                        >
                          {ALLOWED_BUSINESS_CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {BUSINESS_CATEGORY_LABELS[cat] ?? cat}
                            </option>
                          ))}
                        </select>
                        <InlineFieldError message={fieldErrors.businessCategory} />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="settings-business-desc"
                        className="block text-sm font-medium text-foreground"
                      >
                        Deskripsi Bisnis
                      </label>
                      <textarea
                        id="settings-business-desc"
                        data-testid="input-business-description"
                        rows={3}
                        maxLength={1000}
                        disabled={readOnly}
                        value={description}
                        onChange={(e) => {
                          setDescription(e.target.value);
                          markTabDirty("business");
                        }}
                        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 md:text-sm"
                        placeholder="Ringkasan layanan utama, keunggulan, dan wilayah cakupan bisnis Anda."
                      />
                      <InlineFieldError message={fieldErrors.description} />
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-whatsapp"
                          className="block text-sm font-medium text-foreground"
                        >
                          WhatsApp Utama (628...)
                        </label>
                        <Input
                          id="settings-whatsapp"
                          data-testid="input-whatsapp"
                          value={whatsappE164}
                          disabled={readOnly}
                          onChange={(e) => {
                            setWhatsappE164(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                          placeholder="6281234567890"
                        />
                        <InlineFieldError message={fieldErrors.whatsappE164 ?? fieldErrors.whatsappNumber} />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-phone"
                          className="block text-sm font-medium text-foreground"
                        >
                          Telepon Kantor
                        </label>
                        <Input
                          id="settings-phone"
                          data-testid="input-phone"
                          value={phone}
                          disabled={readOnly}
                          onChange={(e) => {
                            setPhone(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                          placeholder="021-5551234"
                        />
                        <InlineFieldError message={fieldErrors.phone} />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-business-email"
                          className="block text-sm font-medium text-foreground"
                        >
                          Email Kontak Publik
                        </label>
                        <Input
                          id="settings-business-email"
                          data-testid="input-business-email"
                          type="email"
                          value={businessEmail}
                          disabled={readOnly}
                          onChange={(e) => {
                            setBusinessEmail(e.target.value);
                            setPublicEmail(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="info@bisnis.co.id"
                        />
                        <InlineFieldError message={fieldErrors.email ?? fieldErrors.publicEmail} />
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-1.5 md:col-span-2">
                        <label
                          htmlFor="settings-address"
                          className="block text-sm font-medium text-foreground"
                        >
                          Alamat Publik (Opsional untuk bisnis berbasis area layanan)
                        </label>
                        <Input
                          id="settings-address"
                          data-testid="input-address"
                          value={address}
                          disabled={readOnly}
                          maxLength={500}
                          onChange={(e) => {
                            setAddress(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Jl. Sudirman No. 10"
                        />
                        <InlineFieldError message={fieldErrors.address} />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-city"
                          className="block text-sm font-medium text-foreground"
                        >
                          Kota / Kabupaten
                        </label>
                        <Input
                          id="settings-city"
                          data-testid="input-city"
                          value={city}
                          disabled={readOnly}
                          onChange={(e) => {
                            setCity(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label
                            htmlFor="settings-province"
                            className="block text-sm font-medium text-foreground"
                          >
                            Provinsi
                          </label>
                          <Input
                            id="settings-province"
                            data-testid="input-province"
                            value={province}
                            disabled={readOnly}
                            onChange={(e) => {
                              setProvince(e.target.value);
                              markTabDirty("business");
                            }}
                            className="min-h-11 text-base md:min-h-9 md:text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label
                            htmlFor="settings-postal"
                            className="block text-sm font-medium text-foreground"
                          >
                            Kode Pos
                          </label>
                          <Input
                            id="settings-postal"
                            data-testid="input-postal-code"
                            value={postalCode}
                            disabled={readOnly}
                            onChange={(e) => {
                              setPostalCode(e.target.value);
                              markTabDirty("business");
                            }}
                            className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-maps-url"
                          className="block text-sm font-medium text-foreground"
                        >
                          Tautan Google Maps (HTTPS)
                        </label>
                        <Input
                          id="settings-maps-url"
                          data-testid="input-maps-url"
                          value={mapsUrl}
                          disabled={readOnly}
                          onChange={(e) => {
                            setMapsUrl(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="https://maps.google.com/..."
                        />
                        <InlineFieldError message={fieldErrors.mapsUrl} />
                      </div>
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-weekday-hours"
                          className="block text-sm font-medium text-foreground"
                        >
                          Jam Operasional Hari Kerja
                        </label>
                        <Input
                          id="settings-weekday-hours"
                          data-testid="input-weekday-hours"
                          value={weekdayHours}
                          disabled={readOnly}
                          onChange={(e) => {
                            setWeekdayHours(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Senin–Jumat 08.00–17.00 WIB"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-holiday-hours"
                          className="block text-sm font-medium text-foreground"
                        >
                          Jam Operasional Akhir Pekan / Libur
                        </label>
                        <Input
                          id="settings-holiday-hours"
                          data-testid="input-holiday-hours"
                          value={holidayHours}
                          disabled={readOnly}
                          onChange={(e) => {
                            setHolidayHours(e.target.value);
                            markTabDirty("business");
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Sabtu 09.00–14.00 WIB, Minggu Tutup"
                        />
                      </div>
                    </div>

                    <Separator />

                    {/* Google Maps Review Link (REQ-074, TASK-073) */}
                    <div id="google-maps-review" className="min-w-0 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label
                          htmlFor="settings-google-maps-review-url"
                          className="block text-sm font-medium text-foreground"
                        >
                          Tautan Ulasan Google Maps (Opsional)
                        </label>
                        {googleMapsReviewValidation && (
                          <Badge
                            variant={googleMapsReviewValidation.ok ? "success" : "destructive"}
                            data-testid="google-maps-review-url-status"
                          >
                            {googleMapsReviewValidation.ok
                              ? "Tautan Google Maps valid"
                              : "Format tautan tidak diizinkan"}
                          </Badge>
                        )}
                      </div>
                      <Input
                        id="settings-google-maps-review-url"
                        data-testid="input-google-maps-review-url"
                        type="url"
                        value={googleMapsReviewUrl}
                        disabled={readOnly}
                        maxLength={2048}
                        aria-invalid={Boolean(
                          fieldErrors.googleMapsReviewUrl ||
                            (googleMapsReviewValidation && !googleMapsReviewValidation.ok),
                        )}
                        aria-describedby="settings-google-maps-review-help"
                        onChange={(e) => {
                          setGoogleMapsReviewUrl(e.target.value);
                          setFieldErrors((prev) => {
                            if (!prev.googleMapsReviewUrl) return prev;
                            const next = { ...prev };
                            delete next.googleMapsReviewUrl;
                            return next;
                          });
                          markTabDirty("business");
                        }}
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                        placeholder="https://g.page/r/.../review atau https://maps.app.goo.gl/..."
                      />
                      <InlineFieldError
                        message={
                          fieldErrors.googleMapsReviewUrl ??
                          (googleMapsReviewValidation && !googleMapsReviewValidation.ok
                            ? googleMapsReviewValidation.message
                            : undefined)
                        }
                      />
                      <p
                        id="settings-google-maps-review-help"
                        className="break-words text-xs leading-relaxed text-muted-foreground"
                      >
                        Menerima tautan HTTPS resmi Google Maps saja:{" "}
                        <code className="break-all">https://g.page/r/.../review</code>,{" "}
                        <code className="break-all">https://maps.app.goo.gl/...</code>,{" "}
                        <code className="break-all">https://www.google.com/maps/...</code>,{" "}
                        <code className="break-all">https://maps.google.com/maps...</code>, atau{" "}
                        <code className="break-all">
                          https://search.google.com/local/writereview?placeid=...
                        </code>
                        . Tautan pengalihan seperti <code className="break-all">google.com/url</code>{" "}
                        ditolak. Ditampilkan sebagai tautan polos di bagian Testimoni &amp; Kontak
                        tanpa widget, skrip pihak ketiga, teks ulasan salinan, atau skema rating.
                      </p>
                    </div>

                    <Separator />

                    {/* Service Areas */}
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="settings-new-service-area"
                          className="text-sm font-medium text-foreground"
                        >
                          Area Layanan ({serviceAreas.length}/20)
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          id="settings-new-service-area"
                          data-testid="input-new-service-area"
                          value={newServiceArea}
                          disabled={readOnly || serviceAreas.length >= 20}
                          onChange={(e) => setNewServiceArea(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addServiceArea();
                            }
                          }}
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                          placeholder="Contoh: Jakarta Selatan, Bandung, Jabodetabek"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={readOnly || !newServiceArea.trim() || serviceAreas.length >= 20}
                          onClick={addServiceArea}
                          className="min-h-11 shrink-0 md:min-h-9"
                          data-testid="add-service-area-btn"
                        >
                          <PlusIcon className="size-4" aria-hidden="true" />
                          Tambah
                        </Button>
                      </div>
                      {serviceAreas.length === 0 ? (
                        <p className="text-xs text-muted-foreground" data-testid="empty-service-areas">
                          Belum ada area layanan ditambahkan. Kosongkan jika hanya melayani di alamat fisik.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {serviceAreas.map((area, idx) => (
                            <Badge key={`${area}-${idx}`} variant="secondary" className="gap-1.5 py-1">
                              <span>{area}</span>
                              {!readOnly && (
                                <button
                                  type="button"
                                  aria-label={`Hapus area ${area}`}
                                  onClick={() => removeServiceArea(idx)}
                                  className="rounded-xs hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
                                >
                                  <XIcon className="size-3" aria-hidden="true" />
                                </button>
                              )}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <Separator />

                    {/* Social Links */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Tautan Media Sosial ({socialLinks.length}/10)
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Hanya tautan HTTPS publik yang valid yang disertakan pada footer & Schema.org{" "}
                            <code>sameAs</code>.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly || socialLinks.length >= 10}
                          onClick={addSocialLinkRow}
                          className="min-h-11 shrink-0 md:min-h-8"
                          data-testid="add-social-link-btn"
                        >
                          <PlusIcon className="size-3.5" aria-hidden="true" />
                          Tambah tautan
                        </Button>
                      </div>

                      {socialLinks.length === 0 ? (
                        <div
                          className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground"
                          data-testid="empty-social-links"
                        >
                          Belum ada tautan media sosial. Tambahkan Instagram, LinkedIn, atau YouTube resmi bisnis Anda.
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {socialLinks.map((link, idx) => (
                            <div key={idx} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <select
                                aria-label={`Platform media sosial ${idx + 1}`}
                                value={link.platform}
                                disabled={readOnly}
                                onChange={(e) =>
                                  updateSocialLink(idx, {
                                    platform: e.target.value as SettingsSocialPlatform,
                                  })
                                }
                                className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground sm:w-40 md:min-h-9 md:text-sm"
                              >
                                {ALLOWED_SOCIAL_PLATFORMS.map((platform) => (
                                  <option key={platform} value={platform}>
                                    {SOCIAL_LABELS[platform]}
                                  </option>
                                ))}
                              </select>
                              <Input
                                aria-label={`URL media sosial ${idx + 1}`}
                                value={link.url}
                                disabled={readOnly}
                                onChange={(e) => updateSocialLink(idx, { url: e.target.value })}
                                placeholder="https://instagram.com/bisnisanda"
                                className="min-h-11 flex-1 text-base md:min-h-9 md:text-sm"
                                data-testid={`input-social-url-${idx}`}
                              />
                              {!readOnly && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Hapus tautan media sosial ${idx + 1}`}
                                  onClick={() => removeSocialLink(idx)}
                                  className="min-h-11 min-w-11 text-destructive md:min-h-9 md:min-w-9"
                                >
                                  <Trash2Icon className="size-4" aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <InlineFieldError message={fieldErrors.socialLinks} />
                    </div>
                  </CardContent>
                </Card>
              )}

              {activeTab === "business" && (
                <Card className="min-w-0 overflow-hidden" data-testid="gbp-checklist-card">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <MapPinIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                        <CardTitle className="break-words">{gbpChecklist.step.label}</CardTitle>
                      </div>
                      <Badge
                        variant={
                          gbpChecklist.completedCount === gbpChecklist.totalCount
                            ? "success"
                            : "outline"
                        }
                        className="shrink-0 tabular-nums"
                        data-testid="gbp-checklist-progress"
                      >
                        {gbpChecklist.completedCount}/{gbpChecklist.totalCount} selesai
                      </Badge>
                    </div>
                    <CardDescription>{gbpChecklist.step.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 space-y-5">
                    {/* Copyable website URL */}
                    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-muted-foreground">
                          Alamat situs untuk ditempel di Google Business Profile
                        </p>
                        <p
                          className="break-all font-mono text-sm text-foreground"
                          data-testid="gbp-public-site-url"
                        >
                          {gbpChecklist.publicSiteUrl}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void copyPublicSiteUrlForGbp()}
                        className="min-h-11 shrink-0 md:min-h-9"
                        data-testid="gbp-copy-site-url-btn"
                      >
                        {copiedGbpSiteUrl ? (
                          <>
                            <CheckIcon className="size-4" aria-hidden="true" />
                            Tersalin
                          </>
                        ) : (
                          <>
                            <CopyIcon className="size-4" aria-hidden="true" />
                            Salin URL
                          </>
                        )}
                      </Button>
                    </div>

                    {/* Verification status checklist */}
                    <ul className="space-y-2.5" aria-label="Status checklist Google Business Profile">
                      {gbpChecklist.items.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-start gap-2.5 rounded-md border border-border bg-card p-3"
                          data-testid={`gbp-checklist-item-${item.id}`}
                          data-done={item.done ? "true" : "false"}
                        >
                          <CheckCircle2Icon
                            className={`mt-0.5 size-4 shrink-0 ${
                              item.done ? "text-primary" : "text-muted-foreground/50"
                            }`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm font-medium text-foreground">{item.label}</p>
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {item.detail}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>

                    {/* Manual step-by-step instructions */}
                    <div className="space-y-2">
                      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Langkah Manual di Google Business Profile
                      </p>
                      <ol className="space-y-2 text-sm text-foreground">
                        {gbpChecklist.step.manualSteps.map((step) => (
                          <li key={step.id} className="flex items-start gap-2.5">
                            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold tabular-nums">
                              {step.order}
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">{step.title}</p>
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {step.detail}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>

                    {/* Official help links */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 max-w-full whitespace-normal text-left md:min-h-9"
                        data-testid="gbp-official-help-link"
                        render={
                          <a
                            href={gbpChecklist.step.officialHelpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          />
                        }
                      >
                        <span>Panduan Resmi Google Business Profile</span>
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 max-w-full whitespace-normal text-left md:min-h-9"
                        data-testid="gbp-review-help-link"
                        render={
                          <a
                            href={gbpChecklist.step.officialReviewLinkHelpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          />
                        }
                      >
                        <span>Cara Ambil Tautan Ulasan Google</span>
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 max-w-full whitespace-normal text-left md:min-h-9"
                        data-testid="gbp-punyasitus-help-link"
                        render={
                          <a
                            href={`https://punyasitus.com${gbpChecklist.step.helpArticleHref}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          />
                        }
                      >
                        <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>Artikel Bantuan PunyaSitus</span>
                      </Button>
                    </div>

                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {gbpChecklist.step.noApiNotice}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* TAB 3: READING & HOMEPAGE */}
              {activeTab === "reading" && (
                <Card>
                  <CardHeader>
                    <CardTitle>{activeTabMeta?.label}</CardTitle>
                    <CardDescription>{activeTabMeta?.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {/* Homepage Mode */}
                    <div className="space-y-3">
                      <fieldset className="space-y-2.5">
                        <legend className="text-sm font-medium text-foreground">
                          Tampilan Halaman Beranda (<code>/</code>)
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 transition-colors ${
                              homepageMode === "modular"
                                ? "border-primary bg-primary/5"
                                : "border-border bg-card"
                            } ${readOnly ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            <input
                              type="radio"
                              name="homepageMode"
                              value="modular"
                              checked={homepageMode === "modular"}
                              disabled={readOnly}
                              onChange={() => {
                                setHomepageMode("modular");
                                setHomepagePageId(null);
                                markTabDirty("reading");
                              }}
                              data-testid="radio-homepage-modular"
                              className="mt-1 size-4 accent-primary"
                            />
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                Beranda Modular Tema
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Gunakan susunan seksi beranda bawaan dari kustomisasi tema.
                              </div>
                            </div>
                          </label>

                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 transition-colors ${
                              homepageMode === "page"
                                ? "border-primary bg-primary/5"
                                : "border-border bg-card"
                            } ${readOnly ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            <input
                              type="radio"
                              name="homepageMode"
                              value="page"
                              checked={homepageMode === "page"}
                              disabled={readOnly}
                              onChange={() => {
                                setHomepageMode("page");
                                if (homepagePageId === null && publishedPages[0]) {
                                  setHomepagePageId(publishedPages[0].id);
                                }
                                markTabDirty("reading");
                              }}
                              data-testid="radio-homepage-page"
                              className="mt-1 size-4 accent-primary"
                            />
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                Halaman Statis Terbit
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Pilih halaman yang sudah diterbitkan. URL slug halaman tersebut akan dialihkan (308) ke{" "}
                                <code>/</code>.
                              </div>
                            </div>
                          </label>
                        </div>
                      </fieldset>

                      {homepageMode === "page" && (
                        <div className="space-y-1.5">
                          <label
                            htmlFor="settings-homepage-page"
                            className="block text-sm font-medium text-foreground"
                          >
                            Pilih Halaman Beranda
                          </label>
                          {publishedPages.length === 0 ? (
                            <Alert variant="warning" data-testid="empty-published-pages">
                              <AlertCircleIcon className="size-4" aria-hidden="true" />
                              <AlertTitle>Belum ada halaman yang diterbitkan</AlertTitle>
                              <AlertDescription>
                                Terbitkan minimal satu halaman di menu Halaman terlebih dahulu sebelum memilih mode halaman statis.
                              </AlertDescription>
                            </Alert>
                          ) : (
                            <select
                              id="settings-homepage-page"
                              data-testid="select-homepage-page"
                              value={homepagePageId ?? ""}
                              disabled={readOnly}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                setHomepagePageId(Number.isSafeInteger(val) && val > 0 ? val : null);
                                markTabDirty("reading");
                              }}
                              className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
                            >
                              <option value="">— Pilih halaman terbit —</option>
                              {publishedPages.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.title} (/{p.slug})
                                </option>
                              ))}
                            </select>
                          )}
                          <InlineFieldError message={fieldErrors.homepagePageId} />
                        </div>
                      )}
                    </div>

                    <Separator />

                    {/* Blog & Catalog Modules Toggle */}
                    <div className="space-y-4">
                      <div>
                        <h2 className="text-sm font-semibold text-foreground">
                          Visibilitas Modul Blog & Katalog Penawaran
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          Menonaktifkan modul menyembunyikan rute publik, tautan navigasi, dan entri sitemap secara otomatis tanpa menghapus konten Anda.
                        </p>
                      </div>

                      <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3.5">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <label
                              htmlFor="settings-blog-enabled"
                              className="text-sm font-medium text-foreground"
                            >
                              Aktifkan Blog & Artikel
                            </label>
                            <Badge variant="outline" className="font-mono text-xs">
                              {FIXED_PUBLIC_ROUTES.blog}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Rute tetap read-only. Menonaktifkan blog mengembalikan 404 pada <code>/blog</code> dan{" "}
                            <code>/blog/feed.xml</code> serta menghapusnya dari sitemap.
                          </p>
                        </div>
                        <input
                          id="settings-blog-enabled"
                          data-testid="toggle-blog-enabled"
                          type="checkbox"
                          checked={blogEnabled}
                          disabled={readOnly}
                          onChange={(e) => {
                            setBlogEnabled(e.target.checked);
                            markTabDirty("reading");
                          }}
                          className="mt-1 size-5 shrink-0 accent-primary"
                        />
                      </div>

                      <div className="space-y-3 rounded-md border border-border p-3.5">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <label
                              htmlFor="settings-catalog-enabled"
                              className="text-sm font-medium text-foreground"
                            >
                              Aktifkan Katalog Penawaran Bisnis
                            </label>
                            <p className="text-xs text-muted-foreground">
                              Pilih jenis penawaran yang aktif pada situs publik. Semua rute penawaran bersifat tetap (read-only) untuk mencegah konflik URL.
                            </p>
                          </div>
                          <input
                            id="settings-catalog-enabled"
                            data-testid="toggle-catalog-enabled"
                            type="checkbox"
                            checked={catalogEnabled}
                            disabled={readOnly}
                            onChange={(e) => {
                              const next = e.target.checked;
                              setCatalogEnabled(next);
                              if (next && enabledOfferingTypes.length === 0) {
                                setEnabledOfferingTypes([...ALL_OFFERING_TYPES]);
                              }
                              markTabDirty("reading");
                            }}
                            className="mt-1 size-5 shrink-0 accent-primary"
                          />
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2">
                          {ALL_OFFERING_TYPES.map((type) => {
                            const info = OFFERING_LABELS[type];
                            const checked = catalogEnabled && enabledOfferingTypes.includes(type);
                            return (
                              <label
                                key={type}
                                className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-sm ${
                                  checked ? "border-primary/50 bg-primary/5" : "border-border bg-muted/30"
                                } ${readOnly ? "opacity-65" : "cursor-pointer"}`}
                              >
                                <span className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={readOnly}
                                    onChange={() => toggleOfferingType(type)}
                                    data-testid={`toggle-offering-${type}`}
                                    className="size-4 accent-primary"
                                  />
                                  <span className="font-medium text-foreground">{info.label}</span>
                                </span>
                                <code className="text-xs text-muted-foreground">{info.route}</code>
                              </label>
                            );
                          })}
                        </div>
                        <InlineFieldError message={fieldErrors.enabledOfferingTypes} />
                      </div>
                    </div>

                    <Separator />

                    {/* Items per page */}
                    <div className="space-y-2">
                      <label
                        htmlFor="settings-items-per-page"
                        className="block text-sm font-medium text-foreground"
                      >
                        Jumlah Item per Halaman (Arsip Blog & Katalog)
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {ALLOWED_ITEMS_PER_PAGE.map((count) => {
                          const active = itemsPerPage === count;
                          return (
                            <Button
                              key={count}
                              type="button"
                              variant={active ? "default" : "outline"}
                              size="sm"
                              disabled={readOnly}
                              onClick={() => {
                                setItemsPerPage(count);
                                markTabDirty("reading");
                              }}
                              className="min-h-11 min-w-16 tabular-nums md:min-h-9"
                              data-testid={`items-per-page-${count}`}
                            >
                              {count} item
                            </Button>
                          );
                        })}
                      </div>
                      <InlineFieldError message={fieldErrors.itemsPerPage} />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* TAB 4: SEO & SOCIAL DEFAULTS */}
              {activeTab === "seo" && (
                <Card>
                  <CardHeader>
                    <CardTitle>{activeTabMeta?.label}</CardTitle>
                    <CardDescription>{activeTabMeta?.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="settings-default-title"
                          className="text-sm font-medium text-foreground"
                        >
                          Judul Default Situs (SEO Title Fallback)
                        </label>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {defaultTitle.length}/200 (saran 45–60)
                        </span>
                      </div>
                      <Input
                        id="settings-default-title"
                        data-testid="input-seo-default-title"
                        value={defaultTitle}
                        disabled={readOnly}
                        maxLength={200}
                        onChange={(e) => {
                          setDefaultTitle(e.target.value);
                          markTabDirty("seo");
                        }}
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                        placeholder="Contoh: PT Nusantara Mandiri — Solusi Konstruksi Terpercaya"
                      />
                      <InlineFieldError message={fieldErrors.defaultTitle} />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="settings-default-desc"
                          className="text-sm font-medium text-foreground"
                        >
                          Deskripsi Meta Default
                        </label>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {defaultDescription.length}/500 (saran 120–160)
                        </span>
                      </div>
                      <textarea
                        id="settings-default-desc"
                        data-testid="input-seo-default-description"
                        rows={3}
                        maxLength={500}
                        disabled={readOnly}
                        value={defaultDescription}
                        onChange={(e) => {
                          setDefaultDescription(e.target.value);
                          markTabDirty("seo");
                        }}
                        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:text-sm"
                        placeholder="Ringkasan default yang digunakan saat halaman belum memiliki deskripsi meta khusus."
                      />
                      <InlineFieldError message={fieldErrors.defaultDescription} />
                    </div>

                    {/* Default OG Image */}
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          Gambar Open Graph Default (WhatsApp & Media Sosial)
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {ogImageMediaId
                            ? `Media #${ogImageMediaId} (rasio 1200×630 WebP <= 300 KiB)`
                            : "Belum dipilih — menggunakan fallback sistem saat dibagikan."}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly}
                          onClick={() => setPickerTarget("ogImage")}
                          className="min-h-11 md:min-h-8"
                          data-testid="pick-media-ogImage"
                        >
                          <ImageIcon className="size-3.5" aria-hidden="true" />
                          Pilih Gambar
                        </Button>
                        {ogImageMediaId !== null && !readOnly && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Hapus gambar OG default"
                            onClick={() => {
                              setOgImageMediaId(null);
                              markTabDirty("seo");
                            }}
                            className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                          >
                            <XIcon className="size-3.5" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <Separator />

                    {/* Site Visibility (public vs noindex) */}
                    <div className="space-y-3">
                      <fieldset className="space-y-2.5">
                        <legend className="text-sm font-medium text-foreground">
                          Visibilitas Mesin Pencari (Indeksasi Situs)
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 ${
                              siteVisibility === "public"
                                ? "border-primary bg-primary/5"
                                : "border-border bg-card"
                            } ${readOnly ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            <input
                              type="radio"
                              name="siteVisibility"
                              value="public"
                              checked={siteVisibility === "public"}
                              disabled={readOnly}
                              onChange={() => {
                                setSiteVisibility("public");
                                markTabDirty("seo");
                              }}
                              data-testid="radio-visibility-public"
                              className="mt-1 size-4 accent-primary"
                            />
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                Publik (Dapat Diindeks)
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Mesin pencari dapat mengindeks halaman terbit dan membaca <code>/sitemap.xml</code>.
                              </div>
                            </div>
                          </label>

                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 ${
                              siteVisibility === "noindex"
                                ? "border-warning bg-warning/10"
                                : "border-border bg-card"
                            } ${readOnly ? "cursor-not-allowed opacity-70" : ""}`}
                          >
                            <input
                              type="radio"
                              name="siteVisibility"
                              value="noindex"
                              checked={siteVisibility === "noindex"}
                              disabled={readOnly}
                              onChange={() => {
                                setSiteVisibility("noindex");
                                markTabDirty("seo");
                              }}
                              data-testid="radio-visibility-noindex"
                              className="mt-1 size-4 accent-primary"
                            />
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                Noindex (Sembunyikan dari Indeks)
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Mengirim tag <code>noindex, follow</code> dan mengosongkan <code>/sitemap.xml</code>.
                              </div>
                            </div>
                          </label>
                        </div>
                      </fieldset>

                      {siteVisibility === "noindex" && (
                        <Alert variant="warning" data-testid="noindex-warning-callout">
                          <AlertTriangleIcon className="size-4" aria-hidden="true" />
                          <AlertTitle>Perhatian: Situs tetap dapat diakses publik</AlertTitle>
                          <AlertDescription>
                            Mengaktifkan <strong>noindex</strong> menghapus URL dari <code>/sitemap.xml</code> dan meminta mesin pencari tidak mengindeks situs, tetapi tidak menjadikan situs privat atau terkunci kata sandi. Penghapusan dari hasil pencarian juga memerlukan waktu.
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>

                    {/* AI Training Policy & Webmaster Verification Tokens */}
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-ai-policy"
                          className="block text-sm font-medium text-foreground"
                        >
                          Kebijakan Crawler Pelatihan AI
                        </label>
                        <select
                          id="settings-ai-policy"
                          data-testid="select-ai-policy"
                          value={aiTrainingPolicy}
                          disabled={readOnly}
                          onChange={(e) => {
                            setAiTrainingPolicy(e.target.value as "allow" | "disallow");
                            markTabDirty("seo");
                          }}
                          className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
                        >
                          <option value="allow">Izinkan crawler pencarian & AI (default)</option>
                          <option value="disallow">Tolak crawler pelatihan AI (tetap izinkan pencarian)</option>
                        </select>
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="settings-google-verify"
                          className="block text-sm font-medium text-foreground"
                        >
                          Token Google Search Console (Opsional)
                        </label>
                        <Input
                          id="settings-google-verify"
                          data-testid="input-google-verification"
                          value={googleSiteVerification}
                          disabled={readOnly}
                          maxLength={128}
                          onChange={(e) => {
                            setGoogleSiteVerification(e.target.value);
                            markTabDirty("seo");
                          }}
                          className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                          placeholder="Token polos tanpa tag HTML"
                        />
                        <p className="text-xs text-muted-foreground">
                          {googleSiteVerification.trim()
                            ? "Status: Terkonfigurasi (verifikasi akhir dilakukan di Google Search Console)."
                            : "Masukkan nilai atribut content saja, bukan seluruh tag meta."}
                        </p>
                        <InlineFieldError message={fieldErrors.googleSiteVerification} />
                      </div>
                    </div>

                    <div className="space-y-1.5 md:w-1/2">
                      <label
                        htmlFor="settings-bing-verify"
                        className="block text-sm font-medium text-foreground"
                      >
                        Token Bing Webmaster Tools (Opsional)
                      </label>
                      <Input
                        id="settings-bing-verify"
                        data-testid="input-bing-verification"
                        value={bingSiteVerification}
                        disabled={readOnly}
                        maxLength={64}
                        onChange={(e) => {
                          setBingSiteVerification(e.target.value);
                          markTabDirty("seo");
                        }}
                        className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                        placeholder="16–64 karakter alfanumerik"
                      />
                      <InlineFieldError message={fieldErrors.bingSiteVerification} />
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* TAB 5: PRIVACY & CONSENT */}
              {activeTab === "privacy" && (
                <Card>
                  <CardHeader>
                    <CardTitle>{activeTabMeta?.label}</CardTitle>
                    <CardDescription>{activeTabMeta?.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="settings-privacy-page"
                        className="block text-sm font-medium text-foreground"
                      >
                        Halaman Kebijakan Privasi
                      </label>
                      <select
                        id="settings-privacy-page"
                        data-testid="select-privacy-page"
                        value={privacyPageId ?? ""}
                        disabled={readOnly}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setPrivacyPageId(Number.isSafeInteger(val) && val > 0 ? val : null);
                          markTabDirty("privacy");
                        }}
                        className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
                      >
                        <option value="">— Tidak ditautkan —</option>
                        {availablePages.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title} (/{p.slug}){p.isPublished ? "" : " — Draf"}
                          </option>
                        ))}
                      </select>
                      <InlineFieldError message={fieldErrors.privacyPageId} />
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="settings-consent-text"
                        className="block text-sm font-medium text-foreground"
                      >
                        Teks Banner Persetujuan Cookie & Analitik
                      </label>
                      <textarea
                        id="settings-consent-text"
                        data-testid="input-consent-banner-text"
                        rows={3}
                        maxLength={500}
                        disabled={readOnly}
                        value={consentBannerText}
                        onChange={(e) => {
                          setConsentBannerText(e.target.value);
                          markTabDirty("privacy");
                        }}
                        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:text-sm"
                        placeholder="Situs ini menggunakan cookie analitik dan pemasaran hanya setelah Anda memberikan persetujuan."
                      />
                      <InlineFieldError message={fieldErrors.consentBannerText} />
                    </div>

                    <div className="space-y-1.5 sm:w-56">
                      <label
                        htmlFor="settings-consent-version"
                        className="block text-sm font-medium text-foreground"
                      >
                        Versi Kebijakan Persetujuan
                      </label>
                      <Input
                        id="settings-consent-version"
                        data-testid="input-consent-version"
                        type="number"
                        min={1}
                        max={100}
                        value={consentPolicyVersion}
                        disabled={readOnly}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100) {
                            setConsentPolicyVersion(parsed);
                            markTabDirty("privacy");
                          }
                        }}
                        className="min-h-11 text-base tabular-nums md:min-h-9 md:text-sm"
                      />
                      <p className="text-xs text-muted-foreground">
                        Menaikkan versi kebijakan meminta persetujuan ulang pengunjung di masa depan; sistem tidak pernah mengarang persetujuan secara retroaktif.
                      </p>
                      <InlineFieldError message={fieldErrors.consentPolicyVersion} />
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>

        {/* Right Rail: Related Settings Modules & Live Site Preview Link */}
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Modul Pengaturan Lainnya</CardTitle>
              <CardDescription className="text-xs">
                Tindakan operasional dan akses peran tertentu dikelola pada layar khusus masing-masing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <a
                href={`${basePath}/settings/analytics`}
                className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
                data-testid="related-link-analytics"
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <BarChart3Icon className="size-4 text-primary" aria-hidden="true" />
                  Analitik & Piksel
                </span>
                <Badge variant="outline" className="text-[11px]">
                  Owner/Admin
                </Badge>
              </a>

              {permissions.canManageDomains && (
                <a
                  href={`${basePath}/settings/domains`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
                  data-testid="related-link-domains"
                >
                  <span className="inline-flex items-center gap-2 font-medium">
                    <GlobeIcon className="size-4 text-primary" aria-hidden="true" />
                    Domain Kustom
                  </span>
                  <Badge variant="outline" className="text-[11px]">
                    Pemilik
                  </Badge>
                </a>
              )}

              {permissions.canManageMembers && (
                <a
                  href={`${basePath}/settings/members`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
                  data-testid="related-link-members"
                >
                  <span className="inline-flex items-center gap-2 font-medium">
                    <UsersIcon className="size-4 text-primary" aria-hidden="true" />
                    Anggota Tim
                  </span>
                  <Badge variant="outline" className="text-[11px]">
                    Pemilik
                  </Badge>
                </a>
              )}

              {permissions.canAccessBilling && (
                <a
                  href={`${basePath}/billing`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
                  data-testid="related-link-billing"
                >
                  <span className="inline-flex items-center gap-2 font-medium">
                    <CreditCardIcon className="size-4 text-primary" aria-hidden="true" />
                    Langganan & Tagihan
                  </span>
                  <Badge variant="outline" className="text-[11px]">
                    Pemilik
                  </Badge>
                </a>
              )}

              <a
                href="/account"
                className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
                data-testid="related-link-account"
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <UserIcon className="size-4 text-primary" aria-hidden="true" />
                  Akun Pribadi
                </span>
                <Badge variant="outline" className="text-[11px]">
                  Pribadi
                </Badge>
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Situs Publik Aktif</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 break-all font-mono text-foreground">
                <Link2Icon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>{publicSiteHref}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 w-full md:min-h-9"
                render={<a href={publicSiteHref} target="_blank" rel="noopener noreferrer" />}
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                Buka Situs Publik
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>

      {/* Media Picker Sheet (Base UI) */}
      <MediaPickerSheet
        handle={handle}
        open={pickerTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPickerTarget(null);
        }}
        title={
          pickerTarget === "favicon"
            ? "Pilih Favicon Situs"
            : pickerTarget === "ogImage"
              ? "Pilih Gambar Open Graph Default"
              : "Pilih Logo Situs"
        }
        selectedMediaId={
          pickerTarget === "logo"
            ? logoMediaId
            : pickerTarget === "logoLight"
              ? logoLightMediaId
              : pickerTarget === "logoDark"
                ? logoDarkMediaId
                : pickerTarget === "favicon"
                  ? faviconMediaId
                  : pickerTarget === "ogImage"
                    ? ogImageMediaId
                    : null
        }
        onSelect={(media) => {
          if (pickerTarget === "logo") {
            setLogoMediaId(media.id);
            markTabDirty("general");
          } else if (pickerTarget === "logoLight") {
            setLogoLightMediaId(media.id);
            markTabDirty("general");
          } else if (pickerTarget === "logoDark") {
            setLogoDarkMediaId(media.id);
            markTabDirty("general");
          } else if (pickerTarget === "favicon") {
            setFaviconMediaId(media.id);
            markTabDirty("general");
          } else if (pickerTarget === "ogImage") {
            setOgImageMediaId(media.id);
            markTabDirty("seo");
          }
          setPickerTarget(null);
        }}
      />
    </div>
  );
}
