import { useCallback, useState } from "react";
import {
  GlobeIcon,
  ImageIcon,
  SaveIcon,
  ShieldAlertIcon,
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

export interface IdentityInitialData {
  readonly siteTitle: string;
  readonly tagline: string;
  readonly timezone: string;
  readonly locale: string;
  readonly logoMediaId: number | null;
  readonly faviconMediaId: number | null;
  readonly businessName: string;
  readonly businessCategory: string;
  readonly description: string;
  readonly email: string;
  readonly phone: string;
  readonly whatsappE164: string;
  readonly address: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly mapsUrl: string;
  readonly weekdayHours: string;
  readonly holidayHours: string;
  readonly hasUnpublishedChanges: boolean;
  readonly version: number;
}

export interface IdentitySettingsClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialIdentity: IdentityInitialData;
}

interface IdentityApiPayload {
  readonly siteSettings: {
    readonly siteTitle: string;
    readonly tagline: string | null;
    readonly timezone: string;
    readonly locale: string;
    readonly logoMediaId: number | null;
    readonly faviconMediaId: number | null;
  } | null;
  readonly businessProfile: {
    readonly businessName: string;
    readonly businessCategory: string;
    readonly description: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly whatsappE164: string | null;
    readonly address: string | null;
    readonly city: string | null;
    readonly province: string | null;
    readonly postalCode: string | null;
    readonly mapsUrl: string | null;
    readonly weekdayHours: string | null;
    readonly holidayHours: string | null;
  } | null;
  readonly version: number;
  readonly hasUnpublishedChanges: boolean;
}

export function IdentitySettingsClient({
  handle,
  basePath,
  permissions,
  initialIdentity,
}: IdentitySettingsClientProps) {
  const [version, setVersion] = useState(initialIdentity.version);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    initialIdentity.hasUnpublishedChanges,
  );

  const [siteTitle, setSiteTitle] = useState(initialIdentity.siteTitle);
  const [tagline, setTagline] = useState(initialIdentity.tagline);
  const [timezone, setTimezone] = useState(initialIdentity.timezone);
  const [logoMediaId, setLogoMediaId] = useState<number | null>(initialIdentity.logoMediaId);
  const [faviconMediaId, setFaviconMediaId] = useState<number | null>(
    initialIdentity.faviconMediaId,
  );

  const [businessName, setBusinessName] = useState(initialIdentity.businessName);
  const [businessCategory, setBusinessCategory] = useState(initialIdentity.businessCategory);
  const [description, setDescription] = useState(initialIdentity.description);
  const [email, setEmail] = useState(initialIdentity.email);
  const [phone, setPhone] = useState(initialIdentity.phone);
  const [whatsappE164, setWhatsappE164] = useState(initialIdentity.whatsappE164);
  const [address, setAddress] = useState(initialIdentity.address);
  const [city, setCity] = useState(initialIdentity.city);
  const [province, setProvince] = useState(initialIdentity.province);
  const [postalCode, setPostalCode] = useState(initialIdentity.postalCode);
  const [mapsUrl, setMapsUrl] = useState(initialIdentity.mapsUrl);
  const [weekdayHours, setWeekdayHours] = useState(initialIdentity.weekdayHours);
  const [holidayHours, setHolidayHours] = useState(initialIdentity.holidayHours);

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
  const [pickerTarget, setPickerTarget] = useState<null | "logo" | "favicon">(null);

  useDirtyNavigationGuard(isDirty);

  const canMutate = permissions.canManageSettings && !permissions.isLocked;
  const readOnly = !canMutate;

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setBanner(null);
  }, []);

  function applyApiResponse(res: IdentityApiPayload) {
    if (res.siteSettings) {
      setSiteTitle(res.siteSettings.siteTitle);
      setTagline(res.siteSettings.tagline ?? "");
      setTimezone(res.siteSettings.timezone);
      setLogoMediaId(res.siteSettings.logoMediaId);
      setFaviconMediaId(res.siteSettings.faviconMediaId);
    }
    if (res.businessProfile) {
      setBusinessName(res.businessProfile.businessName);
      setBusinessCategory(res.businessProfile.businessCategory);
      setDescription(res.businessProfile.description ?? "");
      setEmail(res.businessProfile.email ?? "");
      setPhone(res.businessProfile.phone ?? "");
      setWhatsappE164(res.businessProfile.whatsappE164 ?? "");
      setAddress(res.businessProfile.address ?? "");
      setCity(res.businessProfile.city ?? "");
      setProvince(res.businessProfile.province ?? "");
      setPostalCode(res.businessProfile.postalCode ?? "");
      setMapsUrl(res.businessProfile.mapsUrl ?? "");
      setWeekdayHours(res.businessProfile.weekdayHours ?? "");
      setHolidayHours(res.businessProfile.holidayHours ?? "");
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
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function saveDraft(): Promise<number | null> {
    if (readOnly || submitting) return null;
    if (!validateLocally()) return null;

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

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
              logoMediaId,
              faviconMediaId,
            },
            businessProfile: {
              businessName: businessName.trim(),
              businessCategory: businessCategory.trim() || "LocalBusiness",
              description: description.trim() || null,
              email: email.trim() || null,
              phone: phone.trim() || null,
              whatsappE164: whatsappE164.trim() || null,
              address: address.trim() || null,
              city: city.trim() || null,
              province: province.trim() || null,
              postalCode: postalCode.trim() || null,
              mapsUrl: mapsUrl.trim() || null,
              weekdayHours: weekdayHours.trim() || null,
              holidayHours: holidayHours.trim() || null,
            },
          }),
        },
      );
      applyApiResponse(saved);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Draf identitas situs tersimpan",
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
              : "Gagal menyimpan identitas situs",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan identitas situs",
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
        title: "Identitas situs berhasil diterbitkan",
        message: `Profil bisnis dan identitas versi v${published.version} kini aktif di situs publik.`,
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
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              Identitas Situs &amp; Profil Bisnis
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="identity-version-badge">
              v{version}
            </Badge>
            {hasUnpublishedChanges && <Badge variant="warning">Perubahan draf</Badge>}
            {isDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Atur nama bisnis, tagline, logo, nomor WhatsApp utama, alamat, dan jam operasional.
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

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {!permissions.canManageSettings && !permissions.isLocked && (
        <Alert variant="warning" data-testid="identity-rbac-notice" data-state-panel="permission-denied">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca saja untuk peran {permissions.roleLabel}</AlertTitle>
          <AlertDescription>
            Peran Editor hanya dapat melihat identitas situs. Perubahan profil bisnis dan publikasi
            identitas hanya diizinkan untuk Pemilik Situs (Owner) atau Admin.
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

      {/* Brand Identity & Logo/Favicon */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identitas Merek &amp; Aset Visual</CardTitle>
          <CardDescription>
            Digunakan pada header situs, tab peramban, dan metadata publik.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          </div>

          <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-sm">
                <ImageIcon className="size-4 text-primary" aria-hidden="true" />
                <span>
                  Logo:{" "}
                  <strong className="tabular-nums">
                    {logoMediaId !== null ? `Media #${logoMediaId}` : "Belum dipilih"}
                  </strong>
                </span>
              </div>
              <div className="flex items-center gap-1">
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

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-sm">
                <ImageIcon className="size-4 text-primary" aria-hidden="true" />
                <span>
                  Favicon:{" "}
                  <strong className="tabular-nums">
                    {faviconMediaId !== null ? `Media #${faviconMediaId}` : "Belum dipilih"}
                  </strong>
                </span>
              </div>
              <div className="flex items-center gap-1">
                {faviconMediaId !== null && !readOnly && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Hapus favicon"
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
          </div>
        </CardContent>
      </Card>

      {/* Business Profile, Contact & Hours */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profil Bisnis, Kontak &amp; Jam Operasional</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="id-business-name" className="block text-sm font-medium text-foreground">
              Nama Bisnis / Perusahaan <span className="text-destructive">*</span>
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
              className="min-h-11 text-base md:min-h-9 md:text-sm"
              data-testid="identity-business-name"
            />
            <InlineFieldError message={fieldErrors["businessProfile.businessName"]} />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="id-category" className="block text-sm font-medium text-foreground">
              Kategori Bisnis
            </label>
            <Input
              id="id-category"
              value={businessCategory}
              disabled={readOnly}
              onChange={(e) => {
                setBusinessCategory(e.target.value);
                markDirty();
              }}
              placeholder="LocalBusiness / ProfessionalService"
              className="min-h-11 text-base md:min-h-9 md:text-sm"
            />
          </div>

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
              placeholder="Jelaskan secara singkat keunggulan dan cakupan layanan bisnis Anda."
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="id-whatsapp" className="block text-sm font-medium text-foreground">
              Nomor WhatsApp Utama (format 628... atau 08...)
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
            <InlineFieldError message={fieldErrors["businessProfile.mapsUrl"]} />
          </div>

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

          <div className="space-y-1.5">
            <label htmlFor="id-weekday-hours" className="block text-sm font-medium text-foreground">
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
            <label htmlFor="id-holiday-hours" className="block text-sm font-medium text-foreground">
              Jam Operasional Akhir Pekan / Libur
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
        </CardContent>
      </Card>

      <MediaPickerSheet
        open={pickerTarget !== null}
        onOpenChange={(o) => !o && setPickerTarget(null)}
        handle={handle}
        title={pickerTarget === "favicon" ? "Pilih Favicon Situs" : "Pilih Logo Situs"}
        selectedMediaId={pickerTarget === "favicon" ? faviconMediaId : logoMediaId}
        canUpload={permissions.canUploadMedia}
        onSelect={(item) => {
          if (pickerTarget === "logo") setLogoMediaId(item.id);
          else if (pickerTarget === "favicon") setFaviconMediaId(item.id);
          markDirty();
          setPickerTarget(null);
        }}
      />
    </form>
  );
}
