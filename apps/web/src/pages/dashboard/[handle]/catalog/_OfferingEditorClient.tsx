import { useCallback, useRef, useState } from "react";
import type {
  CatalogCtaMode,
  CatalogOfferingType,
  CatalogPriceMode,
  CatalogVehicleUnitStatus,
} from "@punyasitus/core/catalog/index";
import {
  htmlToRestrictedRichTextDoc,
  type RestrictedRichTextDoc,
} from "@punyasitus/core/content/index";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  EyeIcon,
  GlobeIcon,
  ImageIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  ContentStatusBadge,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  RestrictedRichTextEditor,
  slugifyClient,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { MediaPickerSheet, type MediaLibraryItemDto } from "@/components/admin/media";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface OfferingEditorInitialData {
  readonly id: number | null;
  readonly offeringType: CatalogOfferingType;
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly description: RestrictedRichTextDoc;
  readonly coverMediaId: number | null;
  readonly galleryMediaIds: readonly number[];
  readonly youtubeVideoId: string;
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
  readonly originalAmount: number | null;
  readonly badge: string;
  readonly ctaMode: CatalogCtaMode;
  readonly ctaLabel: string;
  readonly externalUrl: string;
  readonly whatsappOverride: string;
  readonly whatsappTemplate: string;
  readonly unitStatus: CatalogVehicleUnitStatus | null;
  readonly attributes: Record<string, unknown>;
  readonly status: "draft" | "published" | "trashed";
  readonly version: number;
}

export interface OfferingEditorClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialOffering: OfferingEditorInitialData;
}

function parseOptionalInt(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

function normalizeDescriptionInput(raw: unknown): RestrictedRichTextDoc {
  if (raw && typeof raw === "object" && "schemaVersion" in raw && "blocks" in raw) {
    return raw as RestrictedRichTextDoc;
  }
  if (typeof raw === "string" && raw.trim()) {
    return htmlToRestrictedRichTextDoc(raw);
  }
  return { schemaVersion: 1, blocks: [] };
}

export function OfferingEditorClient({
  handle,
  basePath,
  permissions,
  initialOffering,
}: OfferingEditorClientProps) {
  const [offeringId, setOfferingId] = useState<number | null>(initialOffering.id);
  const [version, setVersion] = useState(initialOffering.version);
  const [status, setStatus] = useState<"draft" | "published" | "trashed">(initialOffering.status);

  const [offeringType, setOfferingType] = useState<CatalogOfferingType>(
    initialOffering.offeringType,
  );
  const [title, setTitle] = useState(initialOffering.title);
  const [slug, setSlug] = useState(initialOffering.slug);
  const [slugTouched, setSlugTouched] = useState(Boolean(initialOffering.slug));
  const [summary, setSummary] = useState(initialOffering.summary);
  const [description, setDescription] = useState<RestrictedRichTextDoc>(
    initialOffering.description,
  );
  const [coverMediaId, setCoverMediaId] = useState<number | null>(initialOffering.coverMediaId);
  const [galleryMediaIds, setGalleryMediaIds] = useState<readonly number[]>(
    initialOffering.galleryMediaIds,
  );
  const [youtubeVideoId, setYoutubeVideoId] = useState(initialOffering.youtubeVideoId);

  const [priceMode, setPriceMode] = useState<CatalogPriceMode>(initialOffering.priceMode);
  const [priceStr, setPriceStr] = useState(
    initialOffering.price !== null ? String(initialOffering.price) : "",
  );
  const [priceMaxStr, setPriceMaxStr] = useState(
    initialOffering.priceMax !== null ? String(initialOffering.priceMax) : "",
  );
  const [originalAmountStr, setOriginalAmountStr] = useState(
    initialOffering.originalAmount !== null ? String(initialOffering.originalAmount) : "",
  );
  const [negotiable, setNegotiable] = useState(initialOffering.negotiable);
  const [badge, setBadge] = useState(initialOffering.badge);

  const [ctaMode, setCtaMode] = useState<CatalogCtaMode>(initialOffering.ctaMode);
  const [ctaLabel, setCtaLabel] = useState(initialOffering.ctaLabel);
  const [externalUrl, setExternalUrl] = useState(initialOffering.externalUrl);
  const [whatsappOverride, setWhatsappOverride] = useState(initialOffering.whatsappOverride);
  const [whatsappTemplate, setWhatsappTemplate] = useState(initialOffering.whatsappTemplate);

  const [unitStatus, setUnitStatus] = useState<CatalogVehicleUnitStatus>(
    initialOffering.unitStatus ?? "available",
  );
  const [attrs, setAttrs] = useState<Record<string, unknown>>(initialOffering.attributes);

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
  const [trashOpen, setTrashOpen] = useState(false);

  const [mediaPickerMode, setMediaPickerMode] = useState<
    | null
    | { readonly kind: "cover" }
    | { readonly kind: "gallery" }
    | { readonly kind: "inline"; readonly onPick: (media: MediaLibraryItemDto) => void }
  >(null);

  const bypassDirtyGuardRef = useRef(false);

  useDirtyNavigationGuard(isDirty, bypassDirtyGuardRef);

  const readOnly = !permissions.canWriteContent || status === "trashed";

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setBanner(null);
  }, []);

  function setAttr(key: string, val: unknown) {
    setAttrs((prev) => {
      const next = { ...prev };
      if (val === "" || val === null || val === undefined) {
        delete next[key];
      } else {
        next[key] = val;
      }
      return next;
    });
    markDirty();
  }

  function moveGalleryItem(idx: number, delta: -1 | 1) {
    if (readOnly) return;
    const target = idx + delta;
    if (target < 0 || target >= galleryMediaIds.length) return;
    setGalleryMediaIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });
    markDirty();
  }

  function removeGalleryItem(idx: number) {
    if (readOnly) return;
    setGalleryMediaIds((prev) => prev.filter((_, i) => i !== idx));
    markDirty();
  }

  function buildVerticalAttributes(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (offeringType === "service") {
      if (typeof attrs.duration === "string" && attrs.duration.trim()) out.duration = attrs.duration.trim();
      if (typeof attrs.turnaround === "string" && attrs.turnaround.trim()) out.turnaround = attrs.turnaround.trim();
      if (typeof attrs.serviceArea === "string" && attrs.serviceArea.trim()) out.serviceArea = attrs.serviceArea.trim();
      if (typeof attrs.warranty === "string" && attrs.warranty.trim()) out.warranty = attrs.warranty.trim();
      if (typeof attrs.serviceMode === "string" && attrs.serviceMode) out.serviceMode = attrs.serviceMode;
    } else if (offeringType === "product") {
      if (typeof attrs.sku === "string" && attrs.sku.trim()) out.sku = attrs.sku.trim();
      if (typeof attrs.brand === "string" && attrs.brand.trim()) out.brand = attrs.brand.trim();
      if (typeof attrs.stockStatus === "string" && attrs.stockStatus) out.stockStatus = attrs.stockStatus;
      if (typeof attrs.unit === "string" && attrs.unit.trim()) out.unit = attrs.unit.trim();
      if (typeof attrs.material === "string" && attrs.material.trim()) out.material = attrs.material.trim();
      if (typeof attrs.moq === "number" && attrs.moq >= 1) out.moq = attrs.moq;
    } else if (offeringType === "tour") {
      if (typeof attrs.destination === "string" && attrs.destination.trim()) out.destination = attrs.destination.trim();
      if (typeof attrs.departureCity === "string" && attrs.departureCity.trim()) out.departureCity = attrs.departureCity.trim();
      if (typeof attrs.durationDays === "number" && attrs.durationDays >= 1) out.durationDays = attrs.durationDays;
      if (typeof attrs.durationNights === "number" && attrs.durationNights >= 0) out.durationNights = attrs.durationNights;
      if (typeof attrs.airline === "string" && attrs.airline.trim()) out.airline = attrs.airline.trim();
      if (typeof attrs.hotel === "string" && attrs.hotel.trim()) out.hotel = attrs.hotel.trim();
      if (typeof attrs.ppiuNumber === "string" && attrs.ppiuNumber.trim()) out.ppiuNumber = attrs.ppiuNumber.trim();
    } else if (offeringType === "vehicle") {
      if (typeof attrs.brand === "string" && attrs.brand.trim()) out.brand = attrs.brand.trim();
      if (typeof attrs.model === "string" && attrs.model.trim()) out.model = attrs.model.trim();
      if (typeof attrs.year === "number" && attrs.year >= 1980) out.year = attrs.year;
      if (typeof attrs.condition === "string" && attrs.condition) out.condition = attrs.condition;
      if (typeof attrs.transmission === "string" && attrs.transmission) out.transmission = attrs.transmission;
      if (typeof attrs.fuelType === "string" && attrs.fuelType) out.fuelType = attrs.fuelType;
      if (typeof attrs.bodyType === "string" && attrs.bodyType) out.bodyType = attrs.bodyType;
      if (typeof attrs.mileageKm === "number" && attrs.mileageKm >= 0 && attrs.condition !== "new") {
        out.mileageKm = attrs.mileageKm;
      }
      if (typeof attrs.color === "string" && attrs.color.trim()) out.color = attrs.color.trim();
      if (typeof attrs.location === "string" && attrs.location.trim()) out.location = attrs.location.trim();
      if (typeof attrs.creditEstimateEnabled === "boolean") {
        out.creditEstimateEnabled = attrs.creditEstimateEnabled;
      }
    }
    return out;
  }

  function validateLocally(): boolean {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = "Nama penawaran wajib diisi.";
    const p = parseOptionalInt(priceStr);
    const pMax = parseOptionalInt(priceMaxStr);
    const orig = parseOptionalInt(originalAmountStr);

    if (priceMode !== "on_request" && p === null) {
      errs.price = "Harga IDR wajib diisi untuk mode harga ini.";
    }
    if (priceMode === "range" && (pMax === null || (p !== null && pMax <= p))) {
      errs.priceMax = "Harga maksimum harus lebih besar dari harga minimum.";
    }
    if (priceMode !== "on_request" && orig !== null && p !== null && orig <= p) {
      errs.originalAmount = "Harga coret (originalAmount) harus lebih tinggi dari harga saat ini.";
    }
    if (ctaMode === "external_link" && !externalUrl.trim().startsWith("https://")) {
      errs.externalUrl = "URL eksternal wajib dimulai dengan https://.";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function saveDraft(options?: {
    readonly keepSubmitting?: boolean;
  }): Promise<{ readonly id: number; readonly version: number; readonly status: "draft" | "published" | "trashed"; readonly slug: string } | null> {
    if (readOnly || (!options?.keepSubmitting && submitting)) return null;
    if (!validateLocally()) return null;

    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);
    setFieldErrors({});

    try {
      const parsedPrice = priceMode === "on_request" ? null : parseOptionalInt(priceStr);
      const parsedPriceMax = priceMode === "range" ? parseOptionalInt(priceMaxStr) : null;
      const parsedOrig = priceMode === "on_request" ? null : parseOptionalInt(originalAmountStr);

      const payload: Record<string, unknown> = {
        offeringType,
        title: title.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        summary: summary.trim() ? summary.trim() : null,
        description,
        coverMediaId,
        galleryMediaIds,
        youtubeVideoId: youtubeVideoId.trim() ? youtubeVideoId.trim() : null,
        priceMode,
        price: parsedPrice,
        priceMax: parsedPriceMax,
        negotiable,
        originalAmount: parsedOrig,
        badge: badge.trim() ? badge.trim() : null,
        ctaMode,
        ctaLabel: ctaLabel.trim() ? ctaLabel.trim() : null,
        externalUrl: ctaMode === "external_link" && externalUrl.trim() ? externalUrl.trim() : null,
        whatsappOverride: whatsappOverride.trim() ? whatsappOverride.trim() : null,
        whatsappTemplate: whatsappTemplate.trim() ? whatsappTemplate.trim() : null,
        unitStatus: offeringType === "vehicle" ? unitStatus : null,
        attributes: buildVerticalAttributes(),
      };

      type SavedResp = {
        readonly id: number;
        readonly version: number;
        readonly status: "draft" | "published" | "trashed";
        readonly slug: string;
      };

      let saved: SavedResp;
      if (offeringId === null) {
        saved = await cmsFetchJson<SavedResp>(
          `/api/tenants/${encodeURIComponent(handle)}/catalog`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        setOfferingId(saved.id);
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `${basePath}/catalog/${saved.id}`);
        }
      } else {
        saved = await cmsFetchJson<SavedResp>(
          `/api/tenants/${encodeURIComponent(handle)}/catalog/${offeringId}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...payload,
              version,
            }),
          },
        );
      }

      setVersion(saved.version);
      setStatus(saved.status);
      setSlug(saved.slug);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Draf penawaran tersimpan",
        message: `Penawaran tersimpan pada versi v${saved.version}.`,
      });
      return saved;
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.isStaleVersion) {
          setConflictMessage(err.message);
        } else {
          setFieldErrors(fieldErrorsToMap(err.fields));
          setBanner({
            tone: "destructive",
            title: "Gagal menyimpan penawaran",
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menyimpan penawaran",
          message: "Koneksi terganggu. Seluruh isian formulir tetap aman.",
        });
      }
      return null;
    } finally {
      if (!options?.keepSubmitting) {
        setSubmitting(false);
      }
    }
  }

  async function handlePublishOrUnpublish(action: "publish" | "unpublish") {
    if (!permissions.canPublishContent || submitting || status === "trashed") return;
    setSubmitting(true);
    setConflictMessage(null);
    setBanner(null);

    try {
      let activeId = offeringId;
      let activeVersion = version;

      if (activeId === null || isDirty) {
        const saved = await saveDraft({ keepSubmitting: true });
        if (!saved) return;
        activeId = saved.id;
        activeVersion = saved.version;
      }

      const res = await cmsFetchJson<{
        readonly version: number;
        readonly status: "draft" | "published" | "trashed";
      }>(`/api/tenants/${encodeURIComponent(handle)}/catalog/${activeId}/${action}`, {
        method: "POST",
        body: JSON.stringify({ version: activeVersion }),
      });
      setVersion(res.version);
      setStatus(res.status);
      setBanner({
        tone: "success",
        title:
          action === "publish" ? "Penawaran berhasil diterbitkan" : "Publikasi penawaran dibatalkan",
        message:
          action === "publish"
            ? `Penawaran versi v${res.version} kini tayang di katalog publik.`
            : "Penawaran dikembalikan menjadi draf.",
      });
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal mengubah status publikasi",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReloadLatest() {
    if (offeringId === null) return;
    setReloading(true);
    try {
      const fresh = await cmsFetchJson<Record<string, unknown>>(
        `/api/tenants/${encodeURIComponent(handle)}/catalog/${offeringId}`,
      );
      if (
        fresh.offeringType === "service" ||
        fresh.offeringType === "product" ||
        fresh.offeringType === "tour" ||
        fresh.offeringType === "vehicle"
      ) {
        setOfferingType(fresh.offeringType);
      }
      setTitle(String(fresh.title ?? ""));
      setSlug(String(fresh.slug ?? ""));
      setSlugTouched(false);
      setSummary(typeof fresh.summary === "string" ? fresh.summary : "");
      setDescription(normalizeDescriptionInput(fresh.description));
      setCoverMediaId(typeof fresh.coverMediaId === "number" ? fresh.coverMediaId : null);
      setGalleryMediaIds(Array.isArray(fresh.galleryMediaIds) ? (fresh.galleryMediaIds as number[]) : []);
      setYoutubeVideoId(typeof fresh.youtubeVideoId === "string" ? fresh.youtubeVideoId : "");
      setPriceMode((fresh.priceMode as CatalogPriceMode) ?? "fixed");
      setPriceStr(typeof fresh.price === "number" ? String(fresh.price) : "");
      setPriceMaxStr(typeof fresh.priceMax === "number" ? String(fresh.priceMax) : "");
      setOriginalAmountStr(
        typeof fresh.originalAmount === "number" ? String(fresh.originalAmount) : "",
      );
      setNegotiable(Boolean(fresh.negotiable));
      setBadge(typeof fresh.badge === "string" ? fresh.badge : "");
      setCtaMode((fresh.ctaMode as CatalogCtaMode) ?? "inquiry");
      setCtaLabel(typeof fresh.ctaLabel === "string" ? fresh.ctaLabel : "");
      setExternalUrl(typeof fresh.externalUrl === "string" ? fresh.externalUrl : "");
      setWhatsappOverride(typeof fresh.whatsappOverride === "string" ? fresh.whatsappOverride : "");
      setWhatsappTemplate(typeof fresh.whatsappTemplate === "string" ? fresh.whatsappTemplate : "");
      setUnitStatus(
        fresh.unitStatus === "available" || fresh.unitStatus === "booked" || fresh.unitStatus === "sold"
          ? fresh.unitStatus
          : "available",
      );
      if (fresh.attributes && typeof fresh.attributes === "object") {
        setAttrs(fresh.attributes as Record<string, unknown>);
      } else {
        setAttrs({});
      }
      setStatus((fresh.status as "draft" | "published" | "trashed") ?? "draft");
      setVersion(Number(fresh.version ?? 1));
      setFieldErrors({});
      setConflictMessage(null);
      setIsDirty(false);
      setBanner({
        tone: "success",
        title: "Versi terbaru penawaran dimuat",
        message: `Formulir kini menampilkan versi v${fresh.version}.`,
      });
    } catch (err) {
      setBanner({
        tone: "destructive",
        title: "Gagal memuat ulang penawaran",
        message: err instanceof Error ? err.message : "Silakan muat ulang halaman.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleConfirmTrash() {
    if (offeringId === null || !permissions.canWriteContent) return;
    setSubmitting(true);
    try {
      await cmsFetchJson(`/api/tenants/${encodeURIComponent(handle)}/catalog/${offeringId}`, {
        method: "DELETE",
        body: JSON.stringify({ version }),
      });
      bypassDirtyGuardRef.current = true;
      setIsDirty(false);
      setTrashOpen(false);
      window.location.assign(`${basePath}/catalog`);
    } catch (err) {
      setTrashOpen(false);
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setConflictMessage(err.message);
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal menghapus penawaran",
          message: err instanceof Error ? err.message : "Terjadi kesalahan.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const previewHref =
    offeringId !== null
      ? `${basePath}/preview?kind=offering&id=${offeringId}&version=${version}`
      : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void saveDraft();
      }}
      className="space-y-6 pb-16"
      data-testid="offering-editor-screen"
      data-dirty={isDirty ? "true" : "false"}
      data-version={String(version)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 -ml-2 md:min-h-8"
              render={<a href={`${basePath}/catalog`} />}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Daftar Katalog
            </Button>
            <ContentStatusBadge status={status} />
            <Badge variant="outline" className="tabular-nums" data-testid="offering-version-badge">
              v{version}
            </Badge>
            {isDirty && (
              <Badge variant="warning" data-testid="dirty-indicator">
                Belum disimpan
              </Badge>
            )}
          </div>
          <h1 className="truncate text-2xl font-bold tracking-[-0.02em] text-foreground">
            {offeringId === null ? "Tambah Penawaran Baru" : title || `Penawaran #${offeringId}`}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {previewHref && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              render={<a href={previewHref} />}
              data-testid="offering-preview-link"
            >
              <EyeIcon className="size-4" aria-hidden="true" />
              Pratinjau
            </Button>
          )}
          <Button
            type="submit"
            disabled={readOnly || submitting}
            className="min-h-11 md:min-h-9"
            data-testid="offering-save-btn"
          >
            <SaveIcon className="size-4" aria-hidden="true" />
            {submitting ? "Menyimpan..." : "Simpan Draf"}
          </Button>
          {status === "published" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={!permissions.canPublishContent || submitting}
              onClick={() => void handlePublishOrUnpublish("unpublish")}
              className="min-h-11 md:min-h-9"
              data-testid="offering-unpublish-btn"
            >
              Batalkan Terbit
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={!permissions.canPublishContent || submitting || status === "trashed"}
              onClick={() => void handlePublishOrUnpublish("publish")}
              className="min-h-11 md:min-h-9"
              data-testid="offering-publish-btn"
            >
              <GlobeIcon className="size-4" aria-hidden="true" />
              Terbitkan
            </Button>
          )}
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {conflictMessage && (
        <StaleWriteRecoveryBanner
          message={conflictMessage}
          reloading={reloading}
          onReloadLatest={handleReloadLatest}
        />
      )}

      {banner && (
        <Alert variant={banner.tone} data-testid="offering-editor-feedback">
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* Basic Info & Rich Description */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Informasi Utama Penawaran</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <label htmlFor="offering-type" className="block text-sm font-medium text-foreground">
                Tipe Penawaran
              </label>
              <select
                id="offering-type"
                value={offeringType}
                disabled={readOnly || offeringId !== null}
                onChange={(e) => {
                  setOfferingType(e.target.value as CatalogOfferingType);
                  setAttrs({});
                  markDirty();
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground disabled:opacity-60 md:min-h-9 md:text-sm"
                data-testid="offering-type-select"
              >
                <option value="service">Layanan (/layanan)</option>
                <option value="product">Produk (/produk)</option>
                <option value="tour">Paket Tur (/tour)</option>
                <option value="vehicle">Kendaraan (/kendaraan)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="offering-title" className="block text-sm font-medium text-foreground">
                Nama Penawaran <span className="text-destructive">*</span>
              </label>
              <Input
                id="offering-title"
                value={title}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors.title)}
                onChange={(e) => {
                  const next = e.target.value;
                  setTitle(next);
                  if (!slugTouched && offeringId === null) {
                    setSlug(slugifyClient(next));
                  }
                  markDirty();
                }}
                placeholder="Contoh: Paket Audit SEO Lokal"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="offering-title-input"
              />
              <InlineFieldError message={fieldErrors.title} />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="offering-slug" className="block text-sm font-medium text-foreground">
                Slug URL
              </label>
              <Input
                id="offering-slug"
                value={slug}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors.slug)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                  markDirty();
                }}
                placeholder="paket-audit-seo-lokal"
                className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                data-testid="offering-slug-input"
              />
              <InlineFieldError message={fieldErrors.slug} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="offering-summary" className="block text-sm font-medium text-foreground">
              Ringkasan Singkat
            </label>
            <textarea
              id="offering-summary"
              rows={2}
              maxLength={500}
              value={summary}
              disabled={readOnly}
              onChange={(e) => {
                setSummary(e.target.value);
                markDirty();
              }}
              placeholder="Ringkasan nilai utama penawaran untuk kartu katalog."
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:text-sm"
              data-testid="offering-summary-input"
            />
          </div>

          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-foreground">Deskripsi Lengkap</span>
            <RestrictedRichTextEditor
              id="offering-desc-editor"
              label="Deskripsi penawaran"
              value={description}
              readOnly={readOnly}
              onChange={(next) => {
                setDescription(next);
                markDirty();
              }}
              onRequestMediaPicker={(onPick) =>
                setMediaPickerMode({
                  kind: "inline",
                  onPick: (item) => onPick(item),
                })
              }
              testId="offering-richtext-editor"
            />
          </div>
        </CardContent>
      </Card>

      {/* Honest IDR Pricing & CTA */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Harga Rupiah (IDR) Transparan</CardTitle>
            <CardDescription>
              Pilih mode harga jujur tanpa angka buatan untuk mode Hubungi Kami.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="offering-price-mode" className="block text-sm font-medium text-foreground">
                Mode Harga
              </label>
              <select
                id="offering-price-mode"
                value={priceMode}
                disabled={readOnly}
                onChange={(e) => {
                  setPriceMode(e.target.value as CatalogPriceMode);
                  markDirty();
                }}
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                data-testid="offering-price-mode"
              >
                <option value="fixed">Harga tetap (Fixed)</option>
                <option value="from">Mulai dari (From)</option>
                <option value="range">Rentang harga (Range)</option>
                <option value="on_request">Hubungi kami (On Request)</option>
              </select>
            </div>

            {priceMode !== "on_request" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="offering-price" className="block text-sm font-medium text-foreground">
                    {priceMode === "range" ? "Harga Minimum (Rp)" : "Harga (Rp)"}
                  </label>
                  <Input
                    id="offering-price"
                    inputMode="numeric"
                    value={priceStr}
                    disabled={readOnly}
                    aria-invalid={Boolean(fieldErrors.price)}
                    onChange={(e) => {
                      setPriceStr(e.target.value);
                      markDirty();
                    }}
                    placeholder="1500000"
                    className="min-h-11 tabular-nums text-base md:min-h-9 md:text-sm"
                    data-testid="offering-price-input"
                  />
                  <InlineFieldError message={fieldErrors.price} />
                </div>

                {priceMode === "range" && (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="offering-price-max"
                      className="block text-sm font-medium text-foreground"
                    >
                      Harga Maksimum (Rp)
                    </label>
                    <Input
                      id="offering-price-max"
                      inputMode="numeric"
                      value={priceMaxStr}
                      disabled={readOnly}
                      aria-invalid={Boolean(fieldErrors.priceMax)}
                      onChange={(e) => {
                        setPriceMaxStr(e.target.value);
                        markDirty();
                      }}
                      placeholder="3500000"
                      className="min-h-11 tabular-nums text-base md:min-h-9 md:text-sm"
                      data-testid="offering-price-max-input"
                    />
                    <InlineFieldError message={fieldErrors.priceMax} />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label
                    htmlFor="offering-original-amount"
                    className="block text-sm font-medium text-foreground"
                  >
                    Harga Coret / Sebelum Diskon (opsional)
                  </label>
                  <Input
                    id="offering-original-amount"
                    inputMode="numeric"
                    value={originalAmountStr}
                    disabled={readOnly}
                    aria-invalid={Boolean(fieldErrors.originalAmount)}
                    onChange={(e) => {
                      setOriginalAmountStr(e.target.value);
                      markDirty();
                    }}
                    placeholder="2000000"
                    className="min-h-11 tabular-nums text-base md:min-h-9 md:text-sm"
                  />
                  <InlineFieldError message={fieldErrors.originalAmount} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="offering-badge" className="block text-sm font-medium text-foreground">
                  Label Sorotan / Badge (maks 40 karakter)
                </label>
                <Input
                  id="offering-badge"
                  maxLength={40}
                  value={badge}
                  disabled={readOnly}
                  onChange={(e) => {
                    setBadge(e.target.value);
                    markDirty();
                  }}
                  placeholder="Contoh: Terlaris, Promo Bulan Ini"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <label className="flex items-center gap-2.5 pt-2 text-sm font-medium text-foreground sm:pt-7">
                <input
                  type="checkbox"
                  checked={negotiable}
                  disabled={readOnly}
                  onChange={(e) => {
                    setNegotiable(e.target.checked);
                    markDirty();
                  }}
                  className="size-4 rounded border-input accent-primary"
                />
                <span>Harga dapat dinegosiasikan</span>
              </label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tombol Aksi (CTA) &amp; WhatsApp</CardTitle>
            <CardDescription>
              Arahkan calon pelanggan ke WhatsApp, formulir pesan, jadwal, atau tautan eksternal.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="offering-cta-mode" className="block text-sm font-medium text-foreground">
                  Tipe CTA
                </label>
                <select
                  id="offering-cta-mode"
                  value={ctaMode}
                  disabled={readOnly}
                  onChange={(e) => {
                    setCtaMode(e.target.value as CatalogCtaMode);
                    markDirty();
                  }}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                  data-testid="offering-cta-mode"
                >
                  <option value="whatsapp">WhatsApp langsung</option>
                  <option value="inquiry">Formulir Pesan / Inquiry</option>
                  <option value="book">Permintaan Jadwal / Booking</option>
                  <option value="external_link">Tautan Eksternal (Marketplace/Website)</option>
                </select>
                <InlineFieldError message={fieldErrors.ctaMode} />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="offering-cta-label" className="block text-sm font-medium text-foreground">
                  Label Tombol CTA
                </label>
                <Input
                  id="offering-cta-label"
                  maxLength={80}
                  value={ctaLabel}
                  disabled={readOnly}
                  onChange={(e) => {
                    setCtaLabel(e.target.value);
                    markDirty();
                  }}
                  placeholder="Contoh: Tanya via WhatsApp"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>
            </div>

            {ctaMode === "external_link" && (
              <div className="space-y-1.5">
                <label
                  htmlFor="offering-external-url"
                  className="block text-sm font-medium text-foreground"
                >
                  URL Eksternal (https://) <span className="text-destructive">*</span>
                </label>
                <Input
                  id="offering-external-url"
                  type="url"
                  value={externalUrl}
                  disabled={readOnly}
                  aria-invalid={Boolean(fieldErrors.externalUrl)}
                  onChange={(e) => {
                    setExternalUrl(e.target.value);
                    markDirty();
                  }}
                  placeholder="https://tokopedia.com/toko-anda/produk"
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
                <InlineFieldError message={fieldErrors.externalUrl} />
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="offering-wa-override"
                className="block text-sm font-medium text-foreground"
              >
                Nomor WhatsApp Khusus Penawaran (opsional, E.164 Indonesia)
              </label>
              <Input
                id="offering-wa-override"
                value={whatsappOverride}
                disabled={readOnly}
                aria-invalid={Boolean(fieldErrors.whatsappOverride)}
                onChange={(e) => {
                  setWhatsappOverride(e.target.value);
                  markDirty();
                }}
                placeholder="6281234567890"
                className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                data-testid="offering-wa-override"
              />
              <InlineFieldError message={fieldErrors.whatsappOverride} />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="offering-wa-template"
                className="block text-sm font-medium text-foreground"
              >
                Template Pesan WhatsApp (opsional)
              </label>
              <textarea
                id="offering-wa-template"
                rows={2}
                maxLength={1000}
                value={whatsappTemplate}
                disabled={readOnly}
                onChange={(e) => {
                  setWhatsappTemplate(e.target.value);
                  markDirty();
                }}
                placeholder="Halo, saya tertarik dengan {item_title} ({item_price}). Mohon info lebih lanjut."
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm"
              />
              <InlineFieldError message={fieldErrors.whatsappTemplate} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Media: Cover & 12-photo Gallery */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Foto Sampul &amp; Galeri ({galleryMediaIds.length}/12)</CardTitle>
          <CardDescription>
            Pilih foto utama dan hingga 12 foto galeri dengan pengurutan tombol Naik/Turun.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
              <ImageIcon className="size-4 text-primary" aria-hidden="true" />
              <span>
                Sampul:{" "}
                <strong className="tabular-nums">
                  {coverMediaId !== null ? `Media #${coverMediaId}` : "Belum dipilih"}
                </strong>
              </span>
              {coverMediaId !== null && !readOnly && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Hapus foto sampul"
                  onClick={() => {
                    setCoverMediaId(null);
                    markDirty();
                  }}
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </Button>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={readOnly}
              onClick={() => setMediaPickerMode({ kind: "cover" })}
              className="min-h-11 md:min-h-9"
              data-testid="offering-pick-cover"
            >
              Pilih Foto Sampul
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={readOnly || galleryMediaIds.length >= 12}
              onClick={() => setMediaPickerMode({ kind: "gallery" })}
              className="min-h-11 md:min-h-9"
              data-testid="offering-add-gallery"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              Tambah ke Galeri
            </Button>
          </div>

          {galleryMediaIds.length > 0 && (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {galleryMediaIds.map((mediaId, idx) => (
                <li
                  key={mediaId}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                >
                  <span className="tabular-nums">
                    #{idx + 1} · Media #{mediaId}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={readOnly || idx === 0}
                      onClick={() => moveGalleryItem(idx, -1)}
                      aria-label={`Pindahkan foto galeri ${idx + 1} naik`}
                    >
                      <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={readOnly || idx === galleryMediaIds.length - 1}
                      onClick={() => moveGalleryItem(idx, 1)}
                      aria-label={`Pindahkan foto galeri ${idx + 1} turun`}
                    >
                      <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="destructive"
                      disabled={readOnly}
                      onClick={() => removeGalleryItem(idx)}
                      aria-label={`Hapus foto galeri #${mediaId}`}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="max-w-sm space-y-1.5">
            <label htmlFor="offering-youtube" className="block text-sm font-medium text-foreground">
              ID Video YouTube (opsional, 11 karakter)
            </label>
            <Input
              id="offering-youtube"
              maxLength={11}
              value={youtubeVideoId}
              disabled={readOnly}
              onChange={(e) => {
                setYoutubeVideoId(e.target.value);
                markDirty();
              }}
              placeholder="dQw4w9WgXcQ"
              className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Vertical-Specific Typed Attributes */}
      <Card data-testid="offering-vertical-attributes">
        <CardHeader>
          <CardTitle className="text-base">Spesifikasi Khusus ({offeringType})</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {offeringType === "service" && (
            <>
              <AttrInput
                id="attr-duration"
                label="Durasi Layanan"
                value={String(attrs.duration ?? "")}
                disabled={readOnly}
                placeholder="Contoh: 2–3 hari kerja"
                onChange={(v) => setAttr("duration", v)}
              />
              <AttrInput
                id="attr-service-area"
                label="Area Layanan"
                value={String(attrs.serviceArea ?? "")}
                disabled={readOnly}
                placeholder="Jabodetabek / Seluruh Indonesia"
                onChange={(v) => setAttr("serviceArea", v)}
              />
              <div className="space-y-1.5">
                <label htmlFor="attr-service-mode" className="block text-sm font-medium text-foreground">
                  Metode Pelaksanaan
                </label>
                <select
                  id="attr-service-mode"
                  value={String(attrs.serviceMode ?? "")}
                  disabled={readOnly}
                  onChange={(e) => setAttr("serviceMode", e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                >
                  <option value="">Pilih metode</option>
                  <option value="onsite">Kunjungan lokasi (Onsite)</option>
                  <option value="remote">Daring (Remote)</option>
                  <option value="hybrid">Hibrida (Hybrid)</option>
                  <option value="in_store">Di tempat / Klinik / Bengkel</option>
                </select>
              </div>
              <AttrInput
                id="attr-warranty"
                label="Garansi / Jaminan"
                value={String(attrs.warranty ?? "")}
                disabled={readOnly}
                placeholder="Garansi 30 hari"
                onChange={(v) => setAttr("warranty", v)}
              />
            </>
          )}

          {offeringType === "product" && (
            <>
              <AttrInput
                id="attr-sku"
                label="Kode SKU"
                value={String(attrs.sku ?? "")}
                disabled={readOnly}
                placeholder="PRD-001"
                onChange={(v) => setAttr("sku", v)}
              />
              <AttrInput
                id="attr-brand"
                label="Merek"
                value={String(attrs.brand ?? "")}
                disabled={readOnly}
                placeholder="Nama merek"
                onChange={(v) => setAttr("brand", v)}
              />
              <div className="space-y-1.5">
                <label htmlFor="attr-stock" className="block text-sm font-medium text-foreground">
                  Status Stok
                </label>
                <select
                  id="attr-stock"
                  value={String(attrs.stockStatus ?? "")}
                  disabled={readOnly}
                  onChange={(e) => setAttr("stockStatus", e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                >
                  <option value="">Pilih status stok</option>
                  <option value="ready">Tersedia (Ready)</option>
                  <option value="preorder">Pre-order</option>
                  <option value="limited">Stok terbatas</option>
                  <option value="out_of_stock">Habis</option>
                </select>
              </div>
              <AttrInput
                id="attr-unit"
                label="Satuan"
                value={String(attrs.unit ?? "")}
                disabled={readOnly}
                placeholder="pcs / dus / paket"
                onChange={(v) => setAttr("unit", v)}
              />
              <AttrInput
                id="attr-material"
                label="Bahan / Material"
                value={String(attrs.material ?? "")}
                disabled={readOnly}
                placeholder="Kayu jati solid"
                onChange={(v) => setAttr("material", v)}
              />
            </>
          )}

          {offeringType === "tour" && (
            <>
              <AttrInput
                id="attr-destination"
                label="Destinasi"
                value={String(attrs.destination ?? "")}
                disabled={readOnly}
                placeholder="Bali / Makkah & Madinah"
                onChange={(v) => setAttr("destination", v)}
              />
              <AttrInput
                id="attr-departure-city"
                label="Kota Keberangkatan"
                value={String(attrs.departureCity ?? "")}
                disabled={readOnly}
                placeholder="Jakarta (CGK)"
                onChange={(v) => setAttr("departureCity", v)}
              />
              <AttrInput
                id="attr-duration-days"
                label="Durasi (Hari)"
                value={attrs.durationDays !== undefined ? String(attrs.durationDays) : ""}
                disabled={readOnly}
                placeholder="9"
                onChange={(v) => setAttr("durationDays", parseOptionalInt(v))}
              />
              <AttrInput
                id="attr-airline"
                label="Maskapai"
                value={String(attrs.airline ?? "")}
                disabled={readOnly}
                placeholder="Garuda Indonesia"
                onChange={(v) => setAttr("airline", v)}
              />
              <AttrInput
                id="attr-hotel"
                label="Akomodasi Hotel"
                value={String(attrs.hotel ?? "")}
                disabled={readOnly}
                placeholder="Hotel Bintang 4"
                onChange={(v) => setAttr("hotel", v)}
              />
              <AttrInput
                id="attr-ppiu"
                label="Nomor SK Kemenag / PPIU (opsional)"
                value={String(attrs.ppiuNumber ?? "")}
                disabled={readOnly}
                placeholder="U.123 Tahun 2024"
                onChange={(v) => setAttr("ppiuNumber", v)}
              />
            </>
          )}

          {offeringType === "vehicle" && (
            <>
              <div className="space-y-1.5">
                <label htmlFor="attr-unit-status" className="block text-sm font-medium text-foreground">
                  Status Unit
                </label>
                <select
                  id="attr-unit-status"
                  value={unitStatus}
                  disabled={readOnly}
                  onChange={(e) => {
                    setUnitStatus(e.target.value as CatalogVehicleUnitStatus);
                    markDirty();
                  }}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                >
                  <option value="available">Tersedia (Available)</option>
                  <option value="booked">Dipesan (Booked)</option>
                  <option value="sold">Terjual (Sold)</option>
                </select>
              </div>
              <AttrInput
                id="attr-veh-brand"
                label="Merek Kendaraan"
                value={String(attrs.brand ?? "")}
                disabled={readOnly}
                placeholder="Toyota / Honda"
                onChange={(v) => setAttr("brand", v)}
              />
              <AttrInput
                id="attr-veh-model"
                label="Model"
                value={String(attrs.model ?? "")}
                disabled={readOnly}
                placeholder="Avanza 1.5 G"
                onChange={(v) => setAttr("model", v)}
              />
              <AttrInput
                id="attr-veh-year"
                label="Tahun"
                value={attrs.year !== undefined ? String(attrs.year) : ""}
                disabled={readOnly}
                placeholder="2023"
                onChange={(v) => setAttr("year", parseOptionalInt(v))}
              />
              <div className="space-y-1.5">
                <label htmlFor="attr-veh-cond" className="block text-sm font-medium text-foreground">
                  Kondisi
                </label>
                <select
                  id="attr-veh-cond"
                  value={String(attrs.condition ?? "")}
                  disabled={readOnly}
                  onChange={(e) => setAttr("condition", e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                >
                  <option value="">Pilih kondisi</option>
                  <option value="new">Baru</option>
                  <option value="used">Bekas</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="attr-veh-trans" className="block text-sm font-medium text-foreground">
                  Transmisi
                </label>
                <select
                  id="attr-veh-trans"
                  value={String(attrs.transmission ?? "")}
                  disabled={readOnly}
                  onChange={(e) => setAttr("transmission", e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base md:min-h-9 md:text-sm"
                >
                  <option value="">Pilih transmisi</option>
                  <option value="automatic">Otomatis</option>
                  <option value="cvt">CVT</option>
                  <option value="manual">Manual</option>
                  <option value="ev">EV</option>
                </select>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {offeringId !== null && status !== "trashed" && permissions.canWriteContent && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => setTrashOpen(true)}
            className="min-h-11 md:min-h-9"
            data-testid="offering-editor-trash-btn"
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Pindahkan Penawaran ke Sampah
          </Button>
        </div>
      )}

      <MediaPickerSheet
        open={mediaPickerMode !== null}
        onOpenChange={(o) => !o && setMediaPickerMode(null)}
        handle={handle}
        selectedMediaId={mediaPickerMode?.kind === "cover" ? coverMediaId : null}
        canUpload={permissions.canUploadMedia}
        onSelect={(item) => {
          if (mediaPickerMode?.kind === "cover") {
            setCoverMediaId(item.id);
            markDirty();
          } else if (mediaPickerMode?.kind === "gallery") {
            setGalleryMediaIds((prev) =>
              prev.includes(item.id) || prev.length >= 12 ? prev : [...prev, item.id],
            );
            markDirty();
          } else if (mediaPickerMode?.kind === "inline") {
            mediaPickerMode.onPick(item);
          }
          setMediaPickerMode(null);
        }}
      />

      <ConfirmDestructiveDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={`Pindahkan "${title || "penawaran ini"}" ke Sampah?`}
        description="Penawaran akan ditarik dari katalog publik jika sedang terbit dan dipindahkan ke status Sampah."
        confirmLabel="Pindahkan ke Sampah"
        busy={submitting}
        onConfirm={handleConfirmTrash}
      />
    </form>
  );
}

function AttrInput({
  id,
  label,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onChange: (val: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-11 text-base md:min-h-9 md:text-sm"
      />
    </div>
  );
}
