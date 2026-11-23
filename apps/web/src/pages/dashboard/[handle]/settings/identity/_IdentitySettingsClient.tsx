import { useCallback, useMemo, useRef, useState } from "react";
import {
  ALLOWED_CLOSED_DAYS,
  BUSINESS_CATEGORY_CATALOG,
  CLOSED_DAY_LABELS_ID,
  CREDENTIAL_TRUTHFULNESS_NOTICE,
  getPromptedCredentialsForCategory,
  resolveBusinessCategoryDefinition,
  type BrandAssetSourceKind,
  type BusinessWeekdayKey,
  type IndonesianBusinessCredentials,
  type IndonesianCredentialKey,
} from "@punyasitus/core/business-profile/index";
import {
  Building2Icon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  PlusIcon,
  SaveIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { MediaPickerSheet } from "@/components/admin/media";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface IdentityBrandAssetsSummary {
  readonly faviconSource: BrandAssetSourceKind;
  readonly ogImageSource: BrandAssetSourceKind;
  readonly derivedFavicon32Bytes?: number | null;
  readonly derivedAppleTouch180Bytes?: number | null;
  readonly derivedOgBytes?: number | null;
}

export interface IdentitySocialLinkRow {
  readonly platform: string;
  readonly url: string;
}

export interface IdentityInitialData {
  readonly siteTitle: string;
  readonly tagline: string;
  readonly timezone: string;
  readonly locale: string;
  readonly logoMediaId: number | null;
  readonly faviconMediaId: number | null;
  readonly ogImageMediaId?: number | null;
  readonly businessName: string;
  readonly legalName?: string;
  readonly businessCategory: string;
  readonly personRoleTitle?: string;
  readonly affiliatedOrgName?: string;
  readonly description: string;
  readonly email: string;
  readonly privacyContact?: string;
  readonly phone: string;
  readonly whatsappE164: string;
  readonly address: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly mapsUrl: string;
  readonly weekdayHours: string;
  readonly holidayHours: string;
  readonly closedDays?: readonly BusinessWeekdayKey[];
  readonly serviceAreas?: readonly string[];
  readonly socialLinks?: readonly IdentitySocialLinkRow[];
  readonly credentials?: IndonesianBusinessCredentials;
  readonly brandAssets?: IdentityBrandAssetsSummary;
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
}

export type IdentitySettingsTab = "identitas" | "profil";

export interface IdentitySettingsClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialIdentity: IdentityInitialData;
  readonly defaultTab?: IdentitySettingsTab;
}

interface IdentityApiPayload {
  readonly siteSettings: {
    readonly siteTitle: string;
    readonly tagline: string | null;
    readonly timezone: string;
    readonly locale: string;
    readonly logoMediaId: number | null;
    readonly faviconMediaId: number | null;
    readonly ogImageMediaId?: number | null;
  } | null;
  readonly businessProfile: {
    readonly businessName: string;
    readonly businessCategory: string;
    readonly businessCategoryKey?: string;
    readonly legalName?: string | null;
    readonly personRoleTitle?: string | null;
    readonly affiliatedOrgName?: string | null;
    readonly description: string | null;
    readonly email: string | null;
    readonly privacyContact?: string | null;
    readonly phone: string | null;
    readonly whatsappE164: string | null;
    readonly address: string | null;
    readonly city: string | null;
    readonly province: string | null;
    readonly postalCode: string | null;
    readonly mapsUrl: string | null;
    readonly weekdayHours: string | null;
    readonly holidayHours: string | null;
    readonly closedDays?: readonly BusinessWeekdayKey[];
    readonly serviceAreas?: readonly string[];
    readonly socialLinks?: readonly IdentitySocialLinkRow[];
    readonly credentials?: IndonesianBusinessCredentials;
  } | null;
  readonly brandAssets?: {
    readonly effective?: {
      readonly faviconSource: BrandAssetSourceKind;
      readonly ogImageSource: BrandAssetSourceKind;
    };
    readonly derivedFavicon32?: { readonly bytes: number } | null;
    readonly derivedAppleTouch180?: { readonly bytes: number } | null;
    readonly derivedOg1200x630?: { readonly bytes: number } | null;
  };
  readonly version: number;
  readonly hasUnpublishedChanges: boolean;
}

const SOCIAL_PLATFORM_OPTIONS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "x", label: "X / Twitter" },
  { value: "website", label: "Situs Lainnya" },
] as const;

function formatKiB(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export function IdentitySettingsClient({
  handle,
  basePath,
  permissions,
  initialIdentity,
  defaultTab = "identitas",
}: IdentitySettingsClientProps) {
  const initialCategoryDef = resolveBusinessCategoryDefinition(initialIdentity.businessCategory);

  const [activeTab, setActiveTab] = useState<IdentitySettingsTab>(defaultTab);
  const identitasTabRef = useRef<HTMLButtonElement | null>(null);
  const profilTabRef = useRef<HTMLButtonElement | null>(null);

  const [version, setVersion] = useState(initialIdentity.version);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    initialIdentity.hasUnpublishedChanges,
  );

  // Tab: Identitas (Site identity & visual brand assets)
  const [siteTitle, setSiteTitle] = useState(initialIdentity.siteTitle);
  const [tagline, setTagline] = useState(initialIdentity.tagline);
  const [timezone, setTimezone] = useState(initialIdentity.timezone);
  const [locale, setLocale] = useState(initialIdentity.locale || "id-ID");
  const [logoMediaId, setLogoMediaId] = useState<number | null>(initialIdentity.logoMediaId);
  const [faviconMediaId, setFaviconMediaId] = useState<number | null>(
    initialIdentity.faviconMediaId,
  );
  const [ogImageMediaId, setOgImageMediaId] = useState<number | null>(
    initialIdentity.ogImageMediaId ?? null,
  );
  const [brandAssetsSummary, setBrandAssetsSummary] = useState<IdentityBrandAssetsSummary>(
    initialIdentity.brandAssets ?? {
      faviconSource: initialIdentity.faviconMediaId !== null ? "explicit_override" : "unset",
      ogImageSource: (initialIdentity.ogImageMediaId ?? null) !== null ? "explicit_override" : "unset",
    },
  );

  // Tab: Profil (Structured business profile, Schema.org subtype, Indonesian credentials)
  const [businessName, setBusinessName] = useState(initialIdentity.businessName);
  const [legalName, setLegalName] = useState(initialIdentity.legalName ?? "");
  const [businessCategory, setBusinessCategory] = useState<string>(initialCategoryDef.key);
  const [personRoleTitle, setPersonRoleTitle] = useState(initialIdentity.personRoleTitle ?? "");
  const [affiliatedOrgName, setAffiliatedOrgName] = useState(
    initialIdentity.affiliatedOrgName ?? "",
  );
  const [description, setDescription] = useState(initialIdentity.description);
  const [email, setEmail] = useState(initialIdentity.email);
  const [privacyContact, setPrivacyContact] = useState(initialIdentity.privacyContact ?? "");
  const [phone, setPhone] = useState(initialIdentity.phone);
  const [whatsappE164, setWhatsappE164] = useState(initialIdentity.whatsappE164);
  const [address, setAddress] = useState(initialIdentity.address);
  const [city, setCity] = useState(initialIdentity.city);
  const [province, setProvince] = useState(initialIdentity.province);
  const [postalCode, setPostalCode] = useState(initialIdentity.postalCode);
  const [mapsUrl, setMapsUrl] = useState(initialIdentity.mapsUrl);
  const [weekdayHours, setWeekdayHours] = useState(initialIdentity.weekdayHours);
  const [holidayHours, setHolidayHours] = useState(initialIdentity.holidayHours);
  const [closedDays, setClosedDays] = useState<BusinessWeekdayKey[]>([
    ...(initialIdentity.closedDays ?? []),
  ]);
  const [serviceAreas, setServiceAreas] = useState<string[]>([
    ...(initialIdentity.serviceAreas ?? []),
  ]);
  const [newServiceArea, setNewServiceArea] = useState("");
  const [socialLinks, setSocialLinks] = useState<IdentitySocialLinkRow[]>([
    ...(initialIdentity.socialLinks ?? []),
  ]);
  const [credentials, setCredentials] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (initialIdentity.credentials) {
      for (const [k, v] of Object.entries(initialIdentity.credentials)) {
        if (typeof v === "string" && v.trim()) {
          init[k] = v;
        }
      }
    }
    return init;
  });

  const [isDirty, setIsDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);
  const [pickerTarget, setPickerTarget] = useState<null | "logo" | "favicon" | "og">(null);

  useDirtyNavigationGuard(isDirty);

  const canMutate = permissions.canManageSettings && !permissions.isLocked;
  const readOnly = !canMutate;

  const selectedCategoryDef = useMemo(
    () => resolveBusinessCategoryDefinition(businessCategory),
    [businessCategory],
  );
  const promptedCredentials = useMemo(
    () => getPromptedCredentialsForCategory(businessCategory),
    [businessCategory],
  );
  const groupedCategories = useMemo(() => {
    const map = new Map<string, typeof BUSINESS_CATEGORY_CATALOG[number][]>();
    for (const cat of BUSINESS_CATEGORY_CATALOG) {
      const list = map.get(cat.groupLabelId) ?? [];
      list.push(cat);
      map.set(cat.groupLabelId, list);
    }
    return Array.from(map.entries());
  }, []);

  const schemaBadgeLabel =
    selectedCategoryDef.entityProfileKind === "profile_person"
      ? `ProfilePage + Person (${selectedCategoryDef.schemaType})`
      : selectedCategoryDef.schemaType;

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setBanner(null);
  }, []);

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const next: IdentitySettingsTab =
        e.key === "Home"
          ? "identitas"
          : e.key === "End"
            ? "profil"
            : activeTab === "identitas"
              ? "profil"
              : "identitas";

      setActiveTab(next);
      if (next === "identitas") identitasTabRef.current?.focus();
      else profilTabRef.current?.focus();
    }
  }

  function applyApiResponse(res: IdentityApiPayload) {
    if (res.siteSettings) {
      setSiteTitle(res.siteSettings.siteTitle);
      setTagline(res.siteSettings.tagline ?? "");
      setTimezone(res.siteSettings.timezone);
      setLocale(res.siteSettings.locale || "id-ID");
      setLogoMediaId(res.siteSettings.logoMediaId);
      setFaviconMediaId(res.siteSettings.faviconMediaId);
      if (res.siteSettings.ogImageMediaId !== undefined) {
        setOgImageMediaId(res.siteSettings.ogImageMediaId ?? null);
      }
    }
    if (res.businessProfile) {
      setBusinessName(res.businessProfile.businessName);
      setBusinessCategory(
        resolveBusinessCategoryDefinition(
          res.businessProfile.businessCategoryKey ?? res.businessProfile.businessCategory,
        ).key,
      );
      if (res.businessProfile.legalName !== undefined) {
        setLegalName(res.businessProfile.legalName ?? "");
      }
      if (res.businessProfile.personRoleTitle !== undefined) {
        setPersonRoleTitle(res.businessProfile.personRoleTitle ?? "");
      }
      if (res.businessProfile.affiliatedOrgName !== undefined) {
        setAffiliatedOrgName(res.businessProfile.affiliatedOrgName ?? "");
      }
      setDescription(res.businessProfile.description ?? "");
      setEmail(res.businessProfile.email ?? "");
      if (res.businessProfile.privacyContact !== undefined) {
        setPrivacyContact(res.businessProfile.privacyContact ?? "");
      }
      setPhone(res.businessProfile.phone ?? "");
      setWhatsappE164(res.businessProfile.whatsappE164 ?? "");
      setAddress(res.businessProfile.address ?? "");
      setCity(res.businessProfile.city ?? "");
      setProvince(res.businessProfile.province ?? "");
      setPostalCode(res.businessProfile.postalCode ?? "");
      setMapsUrl(res.businessProfile.mapsUrl ?? "");
      setWeekdayHours(res.businessProfile.weekdayHours ?? "");
      setHolidayHours(res.businessProfile.holidayHours ?? "");
      if (res.businessProfile.closedDays !== undefined) {
        setClosedDays([...res.businessProfile.closedDays]);
      }
      if (res.businessProfile.serviceAreas !== undefined) {
        setServiceAreas([...res.businessProfile.serviceAreas]);
      }
      if (res.businessProfile.socialLinks !== undefined) {
        setSocialLinks([...res.businessProfile.socialLinks]);
      }
      if (res.businessProfile.credentials !== undefined) {
        const nextCreds: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.businessProfile.credentials)) {
          if (typeof v === "string" && v.trim()) nextCreds[k] = v;
        }
        setCredentials(nextCreds);
      }
    }
    if (res.brandAssets?.effective) {
      setBrandAssetsSummary({
        faviconSource: res.brandAssets.effective.faviconSource,
        ogImageSource: res.brandAssets.effective.ogImageSource,
        derivedFavicon32Bytes: res.brandAssets.derivedFavicon32?.bytes ?? null,
        derivedAppleTouch180Bytes: res.brandAssets.derivedAppleTouch180?.bytes ?? null,
        derivedOgBytes: res.brandAssets.derivedOg1200x630?.bytes ?? null,
      });
    }
    setVersion(res.version);
    setHasUnpublishedChanges(res.hasUnpublishedChanges);
  }

  function validateLocally(): boolean {
    const errs: Record<string, string> = {};
    if (!siteTitle.trim()) errs["siteSettings.siteTitle"] = "Nama situs wajib diisi.";
    if (!businessName.trim()) errs["businessProfile.businessName"] = "Nama bisnis wajib diisi.";
    if (mapsUrl.trim() && !mapsUrl.trim().startsWith("https://")) {
      errs["businessProfile.mapsUrl"] = "Tautan Google Maps harus diawali https://.";
    }
    for (let i = 0; i < socialLinks.length; i += 1) {
      const link = socialLinks[i];
      if (link && link.url.trim() && !link.url.trim().startsWith("https://")) {
        errs[`businessProfile.socialLinks[${i}].url`] = "Tautan media sosial harus diawali https://.";
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function buildCleanCredentialsPayload(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) {
      const trimmed = v.trim();
      if (trimmed) out[k] = trimmed;
    }
    return out;
  }

  async function saveDraft(): Promise<number | null> {
    if (readOnly || submitting) return null;
    if (!validateLocally()) return null;

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

    const cleanedSocialLinks = socialLinks
      .map((item) => ({ platform: item.platform, url: item.url.trim() }))
      .filter((item) => item.url.length > 0);

    try {
      const saved = await cmsFetchJson<IdentityApiPayload>(
        `/api/tenants/${encodeURIComponent(handle)}/identity`,
        {
          method: "PATCH",
          body: JSON.stringify({
            expectedVersion: version,
            siteSettings: {
              siteTitle: siteTitle.trim(),
              tagline: tagline.trim() || null,
              timezone: timezone.trim() || "Asia/Jakarta",
              locale: locale.trim() || "id-ID",
              logoMediaId,
              faviconMediaId,
              ogImageMediaId,
            },
            businessProfile: {
              businessName: businessName.trim(),
              legalName: legalName.trim() || null,
              businessCategory: selectedCategoryDef.key,
              personRoleTitle: personRoleTitle.trim() || null,
              affiliatedOrgName: affiliatedOrgName.trim() || null,
              description: description.trim() || null,
              email: email.trim() || null,
              privacyContact: privacyContact.trim() || null,
              phone: phone.trim() || null,
              whatsappE164: whatsappE164.trim() || null,
              address: address.trim() || null,
              city: city.trim() || null,
              province: province.trim() || null,
              postalCode: postalCode.trim() || null,
              mapsUrl: mapsUrl.trim() || null,
              weekdayHours: weekdayHours.trim() || null,
              holidayHours: holidayHours.trim() || null,
              closedDays,
              serviceAreas,
              socialLinks: cleanedSocialLinks,
              credentials: buildCleanCredentialsPayload(),
            },
          }),
        },
      );
      applyApiResponse(saved);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Draf identitas & profil bisnis tersimpan",
        message: `Perubahan disimpan pada versi v${saved.version}. Klik Terbitkan agar tampil di situs publik.`,
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
              ? "Akses ditolak untuk mengubah identitas"
              : "Gagal menyimpan identitas & profil bisnis",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan identitas & profil bisnis",
          message: "Gangguan koneksi terjadi. Isian Anda tetap dipertahankan.",
        });
      }
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePublishIdentity() {
    if (readOnly || submitting) return;
    let activeVersion = version;
    if (isDirty) {
      const nextVer = await saveDraft();
      if (nextVer === null) return;
      activeVersion = nextVer;
    }

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    try {
      const published = await cmsFetchJson<{
        readonly version: number;
        readonly hasUnpublishedChanges: boolean;
      }>(`/api/tenants/${encodeURIComponent(handle)}/identity/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: activeVersion }),
      });
      setVersion(published.version);
      setHasUnpublishedChanges(published.hasUnpublishedChanges);
      setBanner({
        tone: "success",
        title: "Identitas & profil bisnis berhasil diterbitkan",
        message: `Profil bisnis (${schemaBadgeLabel}) versi v${published.version} kini aktif di situs publik.`,
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menerbitkan identitas situs",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReloadLatest() {
    setReloading(true);
    try {
      const fresh = await cmsFetchJson<IdentityApiPayload>(
        `/api/tenants/${encodeURIComponent(handle)}/identity`,
      );
      applyApiResponse(fresh);
      setConflictMessage(null);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Versi terbaru identitas dimuat",
        message: `Formulir disinkronkan ke versi v${fresh.version}.`,
      });
    } catch (err) {
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang identitas",
        message: err instanceof Error ? err.message : "Silakan muat ulang halaman.",
      });
    } finally {
      setReloading(false);
    }
  }

  function toggleClosedDay(day: BusinessWeekdayKey) {
    if (readOnly) return;
    setClosedDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
    markDirty();
  }

  function addServiceArea() {
    const trimmed = newServiceArea.trim();
    if (!trimmed || readOnly) return;
    if (serviceAreas.length >= 20 || serviceAreas.includes(trimmed)) {
      setNewServiceArea("");
      return;
    }
    setServiceAreas((prev) => [...prev, trimmed]);
    setNewServiceArea("");
    markDirty();
  }

  function addSocialLink() {
    if (readOnly || socialLinks.length >= 10) return;
    setSocialLinks((prev) => [...prev, { platform: "instagram", url: "" }]);
    markDirty();
  }

  const effectiveFaviconStatus =
    faviconMediaId !== null
      ? "explicit_override"
      : brandAssetsSummary.faviconSource === "auto_derived_from_logo" || logoMediaId !== null
        ? "auto_derived_from_logo"
        : "unset";

  const effectiveOgStatus =
    ogImageMediaId !== null
      ? "explicit_override"
      : brandAssetsSummary.ogImageSource === "auto_derived_from_logo" || logoMediaId !== null
        ? "auto_derived_from_logo"
        : "unset";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveDraft();
      }}
      className="space-y-6 pb-16"
      data-testid="identity-settings-screen"
      data-dirty={isDirty ? "true" : "false"}
      data-version={String(version)}
      data-active-tab={activeTab}
    >
      {/* Header & Save/Publish Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Identitas Situs &amp; Profil Bisnis
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="identity-version-badge">
              v{version}
            </Badge>
            <Badge variant="secondary" data-testid="identity-schema-preview">
              Schema.org: {schemaBadgeLabel}
            </Badge>
            {hasUnpublishedChanges && <Badge variant="warning">Perubahan draf</Badge>}
            {isDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Kelola identitas merek, aset turunan logo, kategori Schema.org, kontak WhatsApp,
            privasi, dan perizinan bisnis Indonesia.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            disabled={readOnly || submitting}
            className="min-h-11 md:min-h-9"
            data-testid="identity-save-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            {submitting ? "Menyimpan..." : "Simpan Draf"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly || submitting}
            onClick={() => void handlePublishIdentity()}
            className="min-h-11 md:min-h-9"
            data-testid="identity-publish-btn"
          >
            <GlobeIcon className="size-4" aria-hidden="true" />
            Terbitkan Identitas
          </Button>
        </div>
      </div>

      {/* DESIGN.md Settings Tabs: Identitas & Profil (keyboard ArrowLeft/ArrowRight/Home/End) */}
      <div
        role="tablist"
        aria-label="Tab Pengaturan Identitas dan Profil Bisnis"
        className="flex flex-wrap gap-2 border-b border-border pb-2"
      >
        <button
          ref={identitasTabRef}
          type="button"
          role="tab"
          id="tab-identitas"
          aria-selected={activeTab === "identitas"}
          aria-controls="panel-identitas"
          tabIndex={activeTab === "identitas" ? 0 : -1}
          onClick={() => setActiveTab("identitas")}
          onKeyDown={handleTabKeyDown}
          data-testid="tab-identitas"
          className={`inline-flex min-h-11 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 ${
            activeTab === "identitas"
              ? "bg-primary text-primary-foreground"
              : "border border-border bg-card text-foreground hover:bg-muted"
          }`}
        >
          <ImageIcon className="size-4" aria-hidden="true" />
          Identitas
        </button>
        <button
          ref={profilTabRef}
          type="button"
          role="tab"
          id="tab-profil"
          aria-selected={activeTab === "profil"}
          aria-controls="panel-profil"
          tabIndex={activeTab === "profil" ? 0 : -1}
          onClick={() => setActiveTab("profil")}
          onKeyDown={handleTabKeyDown}
          data-testid="tab-profil"
          className={`inline-flex min-h-11 items-center gap-2 rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 ${
            activeTab === "profil"
              ? "bg-primary text-primary-foreground"
              : "border border-border bg-card text-foreground hover:bg-muted"
          }`}
        >
          <Building2Icon className="size-4" aria-hidden="true" />
          Profil
        </button>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {!permissions.canManageSettings && !permissions.isLocked && (
        <Alert
          variant="warning"
          data-testid="identity-rbac-notice"
          data-state-panel="permission-denied"
        >
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca saja untuk peran {permissions.roleLabel}</AlertTitle>
          <AlertDescription>
            Peran Editor tidak dapat mengubah atau menerbitkan profil bisnis. Perubahan identitas
            hanya diizinkan untuk Pemilik Situs (Owner) atau Admin.
          </AlertDescription>
        </Alert>
      )}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={handleReloadLatest}
        />
      )}

      {banner && (
        <Alert variant={banner.tone} data-testid="identity-feedback">
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* ===================================================================== */}
      {/* TAB 1: IDENTITAS (Site Title, Tagline, Timezone, Logo & Auto-Derived Assets) */}
      {/* ===================================================================== */}
      <div
        id="panel-identitas"
        role="tabpanel"
        aria-labelledby="tab-identitas"
        hidden={activeTab !== "identitas"}
        className="space-y-6"
        data-testid="panel-identitas"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identitas Merek &amp; Preferensi Situs</CardTitle>
            <CardDescription>
              Digunakan pada judul situs, tagline header, tab peramban, dan zona waktu publik.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="id-site-title" className="block text-sm font-medium text-foreground">
                Nama Situs <span className="text-destructive">*</span>
              </label>
              <Input
                id="id-site-title"
                value={siteTitle}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors["siteSettings.siteTitle"])}
                onChange={(e) => {
                  setSiteTitle(e.target.value);
                  markDirty();
                }}
                placeholder="Contoh: PT Nusantara Arsitek"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="identity-site-title"
              />
              <InlineFieldError message={fieldErrors["siteSettings.siteTitle"]} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="id-tagline" className="block text-sm font-medium text-foreground">
                Tagline Singkat
              </label>
              <Input
                id="id-tagline"
                value={tagline}
                disabled={readOnly}
                onChange={(e) => {
                  setTagline(e.target.value);
                  markDirty();
                }}
                placeholder="Solusi Desain & Konstruksi Terpadu"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="identity-tagline"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="id-timezone" className="block text-sm font-medium text-foreground">
                Zona Waktu
              </label>
              <select
                id="id-timezone"
                value={timezone}
                disabled={readOnly}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  markDirty();
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
              >
                <option value="Asia/Jakarta">WIB — Asia/Jakarta</option>
                <option value="Asia/Makassar">WITA — Asia/Makassar</option>
                <option value="Asia/Jayapura">WIT — Asia/Jayapura</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="id-locale" className="block text-sm font-medium text-foreground">
                Bahasa Utama Situs
              </label>
              <select
                id="id-locale"
                value={locale}
                disabled={readOnly}
                onChange={(e) => {
                  setLocale(e.target.value);
                  markDirty();
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
              >
                <option value="id-ID">Bahasa Indonesia (id-ID)</option>
                <option value="en-US">English (en-US)</option>
              </select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Logo &amp; Aset Merek Turunan Otomatis</CardTitle>
            <CardDescription>
              Mengunggah atau memilih Logo akan menurunkan Favicon (32×32 &amp; 180×180) dan Gambar
              Sharing Default (1200×630, &le; 300 KiB) secara otomatis jika belum diatur manual.
              Pilihan kustom Anda tidak akan pernah ditimpa.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Logo */}
            <div className="flex flex-col justify-between gap-3 rounded-md border border-border bg-muted/20 p-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">Logo Utama</span>
                  <Badge variant={logoMediaId !== null ? "secondary" : "outline"}>
                    {logoMediaId !== null ? `Media #${logoMediaId}` : "Belum dipilih"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Sumber utama untuk header situs, JSON-LD, dan turunan favicon/OG otomatis.
                </p>
              </div>
              <div className="flex items-center justify-end gap-1">
                {logoMediaId !== null && !readOnly && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Hapus logo"
                    onClick={() => {
                      setLogoMediaId(null);
                      markDirty();
                    }}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => setPickerTarget("logo")}
                  className="min-h-11 md:min-h-8"
                  data-testid="identity-pick-logo"
                >
                  Pilih Logo
                </Button>
              </div>
            </div>

            {/* Favicon override / auto-derived */}
            <div
              className="flex flex-col justify-between gap-3 rounded-md border border-border bg-muted/20 p-4"
              data-testid="identity-favicon-card"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">Favicon &amp; Ikon Tab</span>
                  <Badge
                    variant={
                      effectiveFaviconStatus === "explicit_override"
                        ? "default"
                        : effectiveFaviconStatus === "auto_derived_from_logo"
                          ? "secondary"
                          : "outline"
                    }
                    data-testid="identity-favicon-source-badge"
                  >
                    {effectiveFaviconStatus === "explicit_override"
                      ? `Override Kustom (#${faviconMediaId})`
                      : effectiveFaviconStatus === "auto_derived_from_logo"
                        ? "Otomatis dari Logo"
                        : "Belum diatur"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {effectiveFaviconStatus === "explicit_override"
                    ? "Menggunakan favicon kustom pilihan Anda (terlindungi dari auto-derivasi logo)."
                    : effectiveFaviconStatus === "auto_derived_from_logo"
                      ? `Turunan otomatis 32×32 & 180×180 WebP dari logo${
                          brandAssetsSummary.derivedFavicon32Bytes
                            ? ` (${formatKiB(brandAssetsSummary.derivedFavicon32Bytes)})`
                            : ""
                        }.`
                      : "Pilih logo atau unggah favicon kustom untuk ikon tab peramban."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-1">
                {faviconMediaId !== null && !readOnly && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Hapus override favicon"
                    onClick={() => {
                      setFaviconMediaId(null);
                      markDirty();
                    }}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => setPickerTarget("favicon")}
                  className="min-h-11 md:min-h-8"
                  data-testid="identity-pick-favicon"
                >
                  Pilih Favicon
                </Button>
              </div>
            </div>

            {/* OG Image override / auto-derived */}
            <div
              className="flex flex-col justify-between gap-3 rounded-md border border-border bg-muted/20 p-4"
              data-testid="identity-og-card"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    Gambar Sharing (OG 1200×630)
                  </span>
                  <Badge
                    variant={
                      effectiveOgStatus === "explicit_override"
                        ? "default"
                        : effectiveOgStatus === "auto_derived_from_logo"
                          ? "secondary"
                          : "outline"
                    }
                    data-testid="identity-og-source-badge"
                  >
                    {effectiveOgStatus === "explicit_override"
                      ? `Override Kustom (#${ogImageMediaId})`
                      : effectiveOgStatus === "auto_derived_from_logo"
                        ? "Otomatis dari Logo"
                        : "Belum diatur"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {effectiveOgStatus === "explicit_override"
                    ? "Menggunakan gambar OG kustom pilihan Anda (terlindungi dari auto-derivasi logo)."
                    : effectiveOgStatus === "auto_derived_from_logo"
                      ? `Turunan otomatis 1200×630 WebP ≤ 300 KiB untuk pratinjau WhatsApp & media sosial${
                          brandAssetsSummary.derivedOgBytes
                            ? ` (${formatKiB(brandAssetsSummary.derivedOgBytes)})`
                            : ""
                        }.`
                      : "Pilih logo atau unggah gambar OG kustom (1200×630, ≤ 300 KiB)."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-1">
                {ogImageMediaId !== null && !readOnly && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Hapus override gambar OG"
                    onClick={() => {
                      setOgImageMediaId(null);
                      markDirty();
                    }}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => setPickerTarget("og")}
                  className="min-h-11 md:min-h-8"
                  data-testid="identity-pick-og"
                >
                  Pilih Gambar OG
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ===================================================================== */}
      {/* TAB 2: PROFIL (Closed Category, Schema.org, Contact, Hours, Credentials) */}
      {/* ===================================================================== */}
      <div
        id="panel-profil"
        role="tabpanel"
        aria-labelledby="tab-profil"
        hidden={activeTab !== "profil"}
        className="space-y-6"
        data-testid="panel-profil"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profil Bisnis &amp; Kategori Schema.org</CardTitle>
            <CardDescription>
              Kategori yang dipilih memetakan data terstruktur Schema.org secara otomatis dan
              menampilkan kolom perizinan Indonesia yang relevan (semua opsional).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="id-business-name"
                className="block text-sm font-medium text-foreground"
              >
                Nama Bisnis / Merek / Nama Publik <span className="text-destructive">*</span>
              </label>
              <Input
                id="id-business-name"
                value={businessName}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors["businessProfile.businessName"])}
                onChange={(e) => {
                  setBusinessName(e.target.value);
                  markDirty();
                }}
                placeholder="Contoh: Travel Rahmatan Nusantara"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="identity-business-name"
              />
              <InlineFieldError message={fieldErrors["businessProfile.businessName"]} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="id-legal-name" className="block text-sm font-medium text-foreground">
                Nama Badan Usaha / Legal / Dealer Resmi
              </label>
              <Input
                id="id-legal-name"
                value={legalName}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors["businessProfile.legalName"])}
                onChange={(e) => {
                  setLegalName(e.target.value);
                  markDirty();
                }}
                placeholder="Contoh: PT Rahmatan Wisata Mandiri"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="identity-legal-name"
              />
              <InlineFieldError message={fieldErrors["businessProfile.legalName"]} />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="id-category" className="block text-sm font-medium text-foreground">
                Kategori Bisnis (Pemetaan Schema.org Resmi)
              </label>
              <select
                id="id-category"
                value={businessCategory}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors["businessProfile.businessCategory"])}
                onChange={(e) => {
                  setBusinessCategory(e.target.value);
                  markDirty();
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                data-testid="identity-business-category"
              >
                {groupedCategories.map(([groupLabel, items]) => (
                  <optgroup key={groupLabel} label={groupLabel}>
                    {items.map((cat) => (
                      <option key={cat.key} value={cat.key}>
                        {cat.labelId} — {cat.entityProfileKind === "profile_person" ? "ProfilePage + Person" : cat.schemaType}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>
                  Tipe Schema.org aktif: <strong className="text-foreground">{schemaBadgeLabel}</strong>{" "}
                  (didukung Google Search; tidak pernah menggunakan subtipe usang).
                </span>
              </p>
              <InlineFieldError message={fieldErrors["businessProfile.businessCategory"]} />
            </div>

            {selectedCategoryDef.entityProfileKind === "profile_person" && (
              <>
                <div className="space-y-1.5">
                  <label
                    htmlFor="id-person-role"
                    className="block text-sm font-medium text-foreground"
                  >
                    Jabatan / Peran Profesional
                  </label>
                  <Input
                    id="id-person-role"
                    value={personRoleTitle}
                    disabled={readOnly}
                    onChange={(e) => {
                      setPersonRoleTitle(e.target.value);
                      markDirty();
                    }}
                    placeholder="Contoh: Senior Sales Executive / Pembicara B2B"
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                    data-testid="identity-person-role"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="id-affiliated-org"
                    className="block text-sm font-medium text-foreground"
                  >
                    Dealer / Perusahaan Afiliasi Resmi
                  </label>
                  <Input
                    id="id-affiliated-org"
                    value={affiliatedOrgName}
                    disabled={readOnly}
                    onChange={(e) => {
                      setAffiliatedOrgName(e.target.value);
                      markDirty();
                    }}
                    placeholder="Contoh: Auto2000 Sudirman Jakarta"
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                    data-testid="identity-affiliated-org"
                  />
                </div>
              </>
            )}

            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="id-desc" className="block text-sm font-medium text-foreground">
                Deskripsi Bisnis
              </label>
              <textarea
                id="id-desc"
                rows={3}
                maxLength={1000}
                value={description}
                disabled={readOnly}
                onChange={(e) => {
                  setDescription(e.target.value);
                  markDirty();
                }}
                placeholder="Jelaskan secara singkat layanan, keunggulan, dan wilayah layanan bisnis Anda."
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm"
              />
            </div>
          </CardContent>
        </Card>

        {/* Contextual Optional Indonesian Credentials */}
        <Card data-testid="identity-credentials-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                Perizinan &amp; Kredensial Indonesia (Opsional)
              </CardTitle>
              <Badge variant="outline">Fakta Pemilik Situs</Badge>
            </div>
            <CardDescription>{CREDENTIAL_TRUTHFULNESS_NOTICE}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedCategoryDef.isRegulatedProfessional && (
              <Alert variant="warning">
                <ShieldCheckIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Panduan Kategori Profesi Teregulasi</AlertTitle>
                <AlertDescription>
                  Sajikan nomor izin praktik secara informatif dan jujur sesuai ketentuan etika
                  profesi/Permenkes tanpa klaim berlebihan atau ulasan buatan.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {promptedCredentials.map((credDef) => {
                const key: IndonesianCredentialKey = credDef.key;
                const val = credentials[key] ?? "";
                const errKey = `businessProfile.credentials.${key}`;
                return (
                  <div key={key} className="space-y-1.5">
                    <label
                      htmlFor={`id-cred-${key}`}
                      className="block text-sm font-medium text-foreground"
                    >
                      {credDef.labelId}
                    </label>
                    <Input
                      id={`id-cred-${key}`}
                      value={val}
                      disabled={readOnly}
                      aria-invalid={Boolean(fieldErrors[errKey])}
                      onChange={(e) => {
                        setCredentials((prev) => ({ ...prev, [key]: e.target.value }));
                        markDirty();
                      }}
                      placeholder={credDef.placeholder}
                      className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                      data-testid={`identity-cred-${key}`}
                    />
                    <p className="text-xs text-muted-foreground">{credDef.helpTextId}</p>
                    <InlineFieldError message={fieldErrors[errKey]} />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Contact, Privacy Contact & Social Links */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kontak Publik, Privasi &amp; Media Sosial</CardTitle>
            <CardDescription>
              Nomor WhatsApp, telepon, kontak privasi UU PDP, dan tautan media sosial (HTTPS saja).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="id-whatsapp" className="block text-sm font-medium text-foreground">
                  Nomor WhatsApp Utama (628... atau 08...)
                </label>
                <Input
                  id="id-whatsapp"
                  value={whatsappE164}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors["businessProfile.whatsappE164"])}
                  onChange={(e) => {
                    setWhatsappE164(e.target.value);
                    markDirty();
                  }}
                  placeholder="6281234567890"
                  className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                  data-testid="identity-whatsapp"
                />
                <InlineFieldError message={fieldErrors["businessProfile.whatsappE164"]} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="id-phone" className="block text-sm font-medium text-foreground">
                  Telepon Bisnis
                </label>
                <Input
                  id="id-phone"
                  value={phone}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors["businessProfile.phone"])}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    markDirty();
                  }}
                  placeholder="021-5550199"
                  className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                />
                <InlineFieldError message={fieldErrors["businessProfile.phone"]} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="id-email" className="block text-sm font-medium text-foreground">
                  Email Kontak Publik
                </label>
                <Input
                  id="id-email"
                  type="email"
                  value={email}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors["businessProfile.email"])}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    markDirty();
                  }}
                  placeholder="halo@bisnisanda.co.id"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  data-testid="identity-email"
                />
                <InlineFieldError message={fieldErrors["businessProfile.email"]} />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="id-privacy-contact"
                  className="block text-sm font-medium text-foreground"
                >
                  Kontak Privasi Data (UU PDP)
                </label>
                <Input
                  id="id-privacy-contact"
                  value={privacyContact}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors["businessProfile.privacyContact"])}
                  onChange={(e) => {
                    setPrivacyContact(e.target.value);
                    markDirty();
                  }}
                  placeholder="privasi@bisnisanda.co.id atau 0812..."
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                  data-testid="identity-privacy-contact"
                />
                <p className="text-xs text-muted-foreground">
                  Ditampilkan pada formulir leads &amp; catatan privasi publik (email, WhatsApp,
                  atau tautan HTTPS).
                </p>
                <InlineFieldError message={fieldErrors["businessProfile.privacyContact"]} />
              </div>
            </div>

            {/* Social links */}
            <div className="space-y-2 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  Tautan Media Sosial (maks 10, wajib https://)
                </span>
                {!readOnly && socialLinks.length < 10 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addSocialLink}
                    className="min-h-11 md:min-h-8"
                    data-testid="identity-add-social"
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    Tambah Tautan
                  </Button>
                )}
              </div>
              {socialLinks.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Belum ada tautan media sosial ditambahkan.
                </p>
              ) : (
                <div className="space-y-2">
                  {socialLinks.map((item, idx) => (
                    <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto]">
                      <select
                        aria-label={`Platform media sosial ${idx + 1}`}
                        value={item.platform}
                        disabled={readOnly}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          setSocialLinks((prev) =>
                            prev.map((row, i) =>
                              i === idx ? { ...row, platform: nextVal } : row,
                            ),
                          );
                          markDirty();
                        }}
                        className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                      >
                        {SOCIAL_PLATFORM_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <div>
                        <Input
                          type="url"
                          aria-label={`URL media sosial ${idx + 1}`}
                          value={item.url}
                          disabled={readOnly}
                          aria-invalid={Boolean(
                            fieldErrors[`businessProfile.socialLinks[${idx}].url`],
                          )}
                          onChange={(e) => {
                            const nextUrl = e.target.value;
                            setSocialLinks((prev) =>
                              prev.map((row, i) => (i === idx ? { ...row, url: nextUrl } : row)),
                            );
                            markDirty();
                          }}
                          placeholder="https://instagram.com/bisnisanda"
                          className="min-h-11 text-base md:min-h-9 md:text-sm"
                        />
                        <InlineFieldError
                          message={fieldErrors[`businessProfile.socialLinks[${idx}].url`]}
                        />
                      </div>
                      {!readOnly && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Hapus tautan media sosial ${idx + 1}`}
                          onClick={() => {
                            setSocialLinks((prev) => prev.filter((_, i) => i !== idx));
                            markDirty();
                          }}
                          className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
                        >
                          <Trash2Icon className="size-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Address, Service Areas & Operating Hours */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Alamat, Area Layanan &amp; Jam Operasional
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="id-address" className="block text-sm font-medium text-foreground">
                Alamat Lengkap
              </label>
              <Input
                id="id-address"
                value={address}
                disabled={readOnly}
                onChange={(e) => {
                  setAddress(e.target.value);
                  markDirty();
                }}
                placeholder="Jl. Jenderal Sudirman No. 45"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="identity-address"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:col-span-2">
              <div className="space-y-1.5">
                <label htmlFor="id-city" className="block text-sm font-medium text-foreground">
                  Kota / Kabupaten
                </label>
                <Input
                  id="id-city"
                  value={city}
                  disabled={readOnly}
                  onChange={(e) => {
                    setCity(e.target.value);
                    markDirty();
                  }}
                  placeholder="Jakarta Selatan"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="id-province" className="block text-sm font-medium text-foreground">
                  Provinsi
                </label>
                <Input
                  id="id-province"
                  value={province}
                  disabled={readOnly}
                  onChange={(e) => {
                    setProvince(e.target.value);
                    markDirty();
                  }}
                  placeholder="DKI Jakarta"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="id-postal" className="block text-sm font-medium text-foreground">
                  Kode Pos
                </label>
                <Input
                  id="id-postal"
                  value={postalCode}
                  disabled={readOnly}
                  onChange={(e) => {
                    setPostalCode(e.target.value);
                    markDirty();
                  }}
                  placeholder="12190"
                  className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                />
              </div>
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label htmlFor="id-maps" className="block text-sm font-medium text-foreground">
                Tautan Google Maps (https://)
              </label>
              <Input
                id="id-maps"
                type="url"
                value={mapsUrl}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors["businessProfile.mapsUrl"])}
                onChange={(e) => {
                  setMapsUrl(e.target.value);
                  markDirty();
                }}
                placeholder="https://maps.google.com/?q=..."
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Ditampilkan sebagai tautan peta statis di situs publik (iframe peta hanya dimuat
                setelah pengunjung mengklik).
              </p>
              <InlineFieldError message={fieldErrors["businessProfile.mapsUrl"]} />
            </div>

            {/* Service Areas */}
            <div className="space-y-2 md:col-span-2">
              <label
                htmlFor="id-service-area-input"
                className="block text-sm font-medium text-foreground"
              >
                Wilayah / Area Layanan (maks 20)
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="id-service-area-input"
                  value={newServiceArea}
                  disabled={readOnly}
                  onChange={(e) => setNewServiceArea(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addServiceArea();
                    }
                  }}
                  placeholder="Contoh: Jabodetabek, Bandung"
                  className="min-h-11 flex-1 text-base md:min-h-9 md:text-sm"
                  data-testid="identity-service-area-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={readOnly || !newServiceArea.trim()}
                  onClick={addServiceArea}
                  className="min-h-11 md:min-h-9"
                  data-testid="identity-add-service-area"
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  Tambah
                </Button>
              </div>
              {serviceAreas.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {serviceAreas.map((area) => (
                    <Badge key={area} variant="secondary" className="gap-1">
                      {area}
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={`Hapus area ${area}`}
                          onClick={() => {
                            setServiceAreas((prev) => prev.filter((a) => a !== area));
                            markDirty();
                          }}
                          className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
                        >
                          <XIcon className="size-3" aria-hidden="true" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="id-weekday-hours"
                className="block text-sm font-medium text-foreground"
              >
                Jam Operasional Hari Kerja
              </label>
              <Input
                id="id-weekday-hours"
                value={weekdayHours}
                disabled={readOnly}
                onChange={(e) => {
                  setWeekdayHours(e.target.value);
                  markDirty();
                }}
                placeholder="Senin–Jumat 08.30–17.00 WIB"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="id-holiday-hours"
                className="block text-sm font-medium text-foreground"
              >
                Jam Operasional Akhir Pekan / Hari Libur
              </label>
              <Input
                id="id-holiday-hours"
                value={holidayHours}
                disabled={readOnly}
                onChange={(e) => {
                  setHolidayHours(e.target.value);
                  markDirty();
                }}
                placeholder="Sabtu 09.00–13.00 WIB, Minggu Tutup"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
              />
            </div>

            {/* Closed Days */}
            <fieldset className="space-y-2 md:col-span-2">
              <legend className="text-sm font-medium text-foreground">
                Hari Tutup Rutin (Opsional)
              </legend>
              <div className="flex flex-wrap gap-2">
                {ALLOWED_CLOSED_DAYS.map((day) => {
                  const checked = closedDays.includes(day);
                  return (
                    <label
                      key={day}
                      className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm md:min-h-9 ${
                        checked
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card text-muted-foreground"
                      } ${readOnly ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={readOnly}
                        onChange={() => toggleClosedDay(day)}
                        className="size-4 accent-primary"
                        data-testid={`identity-closed-day-${day}`}
                      />
                      <span>{CLOSED_DAY_LABELS_ID[day]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </CardContent>
        </Card>
      </div>

      <MediaPickerSheet
        open={pickerTarget !== null}
        onOpenChange={(o) => {
          if (!o) setPickerTarget(null);
        }}
        handle={handle}
        title={
          pickerTarget === "logo"
            ? "Pilih Logo Utama Situs"
            : pickerTarget === "favicon"
              ? "Pilih Override Favicon Kustom"
              : "Pilih Override Gambar Sharing (OG)"
        }
        onSelect={(item) => {
          if (pickerTarget === "logo") {
            setLogoMediaId(item.id);
          } else if (pickerTarget === "favicon") {
            setFaviconMediaId(item.id);
          } else if (pickerTarget === "og") {
            setOgImageMediaId(item.id);
          }
          markDirty();
        }}
      />
    </form>
  );
}
