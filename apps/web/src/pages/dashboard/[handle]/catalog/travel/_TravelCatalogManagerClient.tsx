import { useMemo, useState } from "react";
import type { CatalogPriceMode } from "@punyasitus/core/catalog/index";
import {
  assertCanPublishTravelPackage,
  canPublishTravelPackage,
  formatTravelDateOnlyIndonesian,
  formatTravelDurationLabel,
  MAX_TRAVEL_DEPARTURES,
  MAX_TRAVEL_EXCLUSIONS,
  MAX_TRAVEL_HOTELS,
  MAX_TRAVEL_INCLUSIONS,
  MAX_TRAVEL_ITINERARY_DAYS,
  normalizeTravelDisplayModel,
  TRAVEL_PACKAGE_KIND_LABELS,
  TravelPublishGateError,
  TravelValidationError,
  validateTravelPackageAttributes,
  type TravelDeparture,
  type TravelHotel,
  type TravelItineraryDay,
  type TravelPackageAttributes,
  type TravelPackageKind,
  type TrustedTravelGateState,
} from "@punyasitus/core/catalog/travel";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckCircle2Icon,
  CompassIcon,
  GlobeIcon,
  HotelIcon,
  LockIcon,
  PlaneIcon,
  PlusIcon,
  SaveIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ContentStatusBadge,
  LockedTenantBanner,
} from "@/components/admin/editor";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export interface TravelCatalogPackageDto {
  readonly id: number;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly summary: string;
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly status: "draft" | "published" | "trashed";
  readonly version: number;
  readonly attributes: Record<string, unknown>;
}

export interface TravelCatalogManagerClientProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly canWriteTravel: boolean;
  readonly canPublishTravel: boolean;
  readonly initialPackages: readonly TravelCatalogPackageDto[];
  /**
   * Authoritative server-resolved DEC-042 compliance state (NEVER derived from client JSON).
   * Defaults strictly to fail-closed `{ operatorVerified: false, umrahCounselApproved: false }`.
   */
  readonly trustedGateState?: TrustedTravelGateState;
}

interface EditableHotelRow {
  readonly name: string;
  readonly city: string;
  readonly starClass: string;
  readonly distanceNote: string;
}

interface EditableItineraryRow {
  readonly title: string;
  readonly summary: string;
  readonly city: string;
  readonly meals: string;
}

interface EditableDepartureRow {
  readonly departureDate: string;
  readonly returnDate: string;
  readonly departureCity: string;
  readonly label: string;
}

interface EditorDraftState {
  readonly id: number | null;
  readonly version: number;
  readonly status: "draft" | "published" | "trashed";
  readonly title: string;
  readonly summary: string;
  readonly priceMode: CatalogPriceMode;
  readonly priceStr: string;
  readonly packageKind: TravelPackageKind;
  readonly destination: string;
  readonly departureCity: string;
  readonly durationDaysStr: string;
  readonly durationNightsStr: string;
  readonly airline: string;
  readonly transport: string;
  readonly accommodation: string;
  readonly hotels: readonly EditableHotelRow[];
  readonly travelInsurance: string;
  readonly officialVisa: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly itinerary: readonly EditableItineraryRow[];
  readonly departures: readonly EditableDepartureRow[];
  readonly skPpiuNumber: string;
  readonly skPihkNumber: string;
}

function buildEmptyDraft(): EditorDraftState {
  return {
    id: null,
    version: 1,
    status: "draft",
    title: "",
    summary: "",
    priceMode: "from",
    priceStr: "",
    packageKind: "general_tour",
    destination: "",
    departureCity: "",
    durationDaysStr: "4",
    durationNightsStr: "3",
    airline: "",
    transport: "",
    accommodation: "",
    hotels: [],
    travelInsurance: "",
    officialVisa: "",
    inclusions: ["Transportasi sesuai program", "Akomodasi hotel sesuai paket"],
    exclusions: ["Pengeluaran pribadi di luar program"],
    itinerary: [
      {
        title: "Keberangkatan & Kedatangan",
        summary: "Penjemputan peserta, check-in hotel, dan pengarahan jadwal perjalanan.",
        city: "",
        meals: "Makan Malam",
      },
    ],
    departures: [],
    skPpiuNumber: "",
    skPihkNumber: "",
  };
}

function dtoToDraft(pkg: TravelCatalogPackageDto): EditorDraftState {
  const attrs = pkg.attributes ?? {};
  const model = normalizeTravelDisplayModel(attrs);
  const rawSkPpiu =
    typeof attrs.skPpiuNumber === "string"
      ? attrs.skPpiuNumber
      : typeof attrs.ppiuNumber === "string"
        ? attrs.ppiuNumber
        : "";
  const rawSkPihk =
    typeof attrs.skPihkNumber === "string"
      ? attrs.skPihkNumber
      : typeof attrs.umrahLicense === "string"
        ? attrs.umrahLicense
        : "";

  return {
    id: pkg.id,
    version: pkg.version,
    status: pkg.status,
    title: pkg.title,
    summary: pkg.summary,
    priceMode: pkg.priceMode,
    priceStr: pkg.price !== null ? String(pkg.price) : "",
    packageKind: model.packageKind,
    destination: model.destination ?? "",
    departureCity: model.departureCity ?? "",
    durationDaysStr: String(model.durationDays ?? 4),
    durationNightsStr: String(model.durationNights ?? 3),
    airline: model.airline ?? "",
    transport: model.transport ?? "",
    accommodation: model.accommodation ?? "",
    hotels: model.hotels.map((h) => ({
      name: h.name,
      city: h.city ?? "",
      starClass: h.starClass ? String(h.starClass) : "",
      distanceNote: h.distanceNote ?? "",
    })),
    travelInsurance: model.travelInsurance ?? "",
    officialVisa: model.officialVisa ?? "",
    inclusions: model.inclusions.length > 0 ? [...model.inclusions] : [],
    exclusions: model.exclusions.length > 0 ? [...model.exclusions] : [],
    itinerary:
      model.itinerary.length > 0
        ? model.itinerary.map((d) => ({
            title: d.title,
            summary: d.summary,
            city: d.city ?? "",
            meals: d.meals ?? "",
          }))
        : [
            {
              title: "Hari Pertama",
              summary: "Kedatangan dan orientasi program perjalanan.",
              city: "",
              meals: "",
            },
          ],
    departures: model.departures.map((dep) => ({
      departureDate: dep.departureDate,
      returnDate: dep.returnDate ?? "",
      departureCity: dep.departureCity ?? "",
      label: dep.label ?? "",
    })),
    skPpiuNumber: rawSkPpiu,
    skPihkNumber: rawSkPihk,
  };
}

function parseIntOrFallback(raw: string, fallback: number): number {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return fallback;
  const num = Number(digits);
  return Number.isSafeInteger(num) ? num : fallback;
}

export function TravelCatalogManagerClient({
  handle,
  basePath,
  permissions,
  canWriteTravel,
  canPublishTravel,
  initialPackages,
  trustedGateState = { operatorVerified: false, umrahCounselApproved: false },
}: TravelCatalogManagerClientProps) {
  const [packages, setPackages] = useState<readonly TravelCatalogPackageDto[]>(initialPackages);
  const [draft, setDraft] = useState<EditorDraftState>(() =>
    initialPackages[0] ? dtoToDraft(initialPackages[0]) : buildEmptyDraft(),
  );
  const [newInclusion, setNewInclusion] = useState("");
  const [newExclusion, setNewExclusion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "warning" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const readOnly = !canWriteTravel || permissions.isLocked;
  const serverOperatorVerified = trustedGateState.operatorVerified === true;
  const serverCounselApproved = trustedGateState.umrahCounselApproved === true;

  const publishGate = useMemo(
    () =>
      canPublishTravelPackage(
        {
          packageKind: draft.packageKind,
          skPpiuNumber: draft.skPpiuNumber.trim() || null,
          skPihkNumber: draft.skPihkNumber.trim() || null,
        },
        trustedGateState,
      ),
    [draft.packageKind, draft.skPpiuNumber, draft.skPihkNumber, trustedGateState],
  );

  const durationPreview = formatTravelDurationLabel(
    parseIntOrFallback(draft.durationDaysStr, 0),
    parseIntOrFallback(draft.durationNightsStr, 0),
  );

  function updateDraft<K extends keyof EditorDraftState>(key: K, value: EditorDraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setBanner(null);
  }

  function selectPackage(pkg: TravelCatalogPackageDto) {
    setDraft(dtoToDraft(pkg));
    setFieldErrors({});
    setBanner(null);
  }

  function startNewPackage() {
    setDraft(buildEmptyDraft());
    setFieldErrors({});
    setBanner(null);
  }

  function buildValidatedAttributes(): TravelPackageAttributes {
    const durationDays = parseIntOrFallback(draft.durationDaysStr, 1);
    const durationNights = parseIntOrFallback(draft.durationNightsStr, 0);

    const hotels: TravelHotel[] = draft.hotels
      .filter((h) => h.name.trim().length > 0)
      .map((h) => {
        const star = parseIntOrFallback(h.starClass, 0);
        return {
          name: h.name.trim(),
          ...(h.city.trim() ? { city: h.city.trim() } : {}),
          ...(star >= 1 && star <= 5 ? { starClass: star } : {}),
          ...(h.distanceNote.trim() ? { distanceNote: h.distanceNote.trim() } : {}),
        };
      });

    const itinerary: TravelItineraryDay[] = draft.itinerary.map((day, idx) => ({
      dayNumber: idx + 1,
      title: day.title.trim(),
      summary: day.summary.trim(),
      ...(day.city.trim() ? { city: day.city.trim() } : {}),
      ...(day.meals.trim() ? { meals: day.meals.trim() } : {}),
    }));

    const departures: TravelDeparture[] = draft.departures
      .filter((dep) => dep.departureDate.trim().length > 0)
      .map((dep) => ({
        departureDate: dep.departureDate.trim(),
        ...(dep.returnDate.trim() ? { returnDate: dep.returnDate.trim() } : {}),
        ...(dep.departureCity.trim() ? { departureCity: dep.departureCity.trim() } : {}),
        ...(dep.label.trim() ? { label: dep.label.trim() } : {}),
      }));

    const inclusions = draft.inclusions.map((s) => s.trim()).filter(Boolean);
    const exclusions = draft.exclusions.map((s) => s.trim()).filter(Boolean);

    const raw: Record<string, unknown> = {
      packageKind: draft.packageKind,
      durationDays,
      durationNights,
      itinerary,
      ...(draft.destination.trim() ? { destination: draft.destination.trim() } : {}),
      ...(draft.departureCity.trim() ? { departureCity: draft.departureCity.trim() } : {}),
      ...(draft.airline.trim() ? { airline: draft.airline.trim() } : {}),
      ...(draft.transport.trim() ? { transport: draft.transport.trim() } : {}),
      ...(draft.accommodation.trim() ? { accommodation: draft.accommodation.trim() } : {}),
      ...(hotels.length > 0 ? { hotels } : {}),
      ...(inclusions.length > 0 ? { inclusions } : {}),
      ...(exclusions.length > 0 ? { exclusions } : {}),
      ...(draft.travelInsurance.trim() ? { travelInsurance: draft.travelInsurance.trim() } : {}),
      ...(draft.officialVisa.trim() ? { officialVisa: draft.officialVisa.trim() } : {}),
      ...(departures.length > 0 ? { departures } : {}),
      ...(draft.skPpiuNumber.trim() ? { skPpiuNumber: draft.skPpiuNumber.trim() } : {}),
      ...(draft.skPihkNumber.trim() ? { skPihkNumber: draft.skPihkNumber.trim() } : {}),
    };

    return validateTravelPackageAttributes(raw);
  }

  async function submitToTravelApi(action: "save_draft" | "publish") {
    if (readOnly) return;
    if (action === "publish" && !canPublishTravel) return;

    setFieldErrors({});
    setBanner(null);

    if (!draft.title.trim()) {
      setFieldErrors({ title: "Judul paket perjalanan wajib diisi." });
      setBanner({
        tone: "destructive",
        title: "Judul paket belum diisi",
        message: "Lengkapi judul paket tur sebelum menyimpan perubahan.",
      });
      return;
    }

    let validated: TravelPackageAttributes;
    try {
      validated = buildValidatedAttributes();
    } catch (err) {
      if (err instanceof TravelValidationError) {
        const mapped: Record<string, string> = {};
        for (const f of err.fields) {
          mapped[f.field] = f.message;
        }
        setFieldErrors(mapped);
        setBanner({
          tone: "destructive",
          title: "Periksa isian paket perjalanan",
          message: err.message,
        });
        return;
      }
      throw err;
    }

    if (action === "publish") {
      try {
        assertCanPublishTravelPackage(validated, trustedGateState);
      } catch (err) {
        if (err instanceof TravelPublishGateError) {
          setBanner({
            tone: "warning",
            title: "Publikasi paket Umrah/Haji ditahan (DEC-042)",
            message: err.reasons.map((r) => r.message).join(" "),
          });
          return;
        }
        throw err;
      }
    }

    const parsedPrice =
      draft.priceMode === "on_request" ? null : parseIntOrFallback(draft.priceStr, 0);

    setSubmitting(true);
    try {
      const saved = await cmsFetchJson<TravelCatalogPackageDto>(
        `/dashboard/${encodeURIComponent(handle)}/catalog/travel/api`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            ...(draft.id !== null ? { id: draft.id, expectedVersion: draft.version } : {}),
            title: draft.title.trim(),
            summary: draft.summary.trim() || null,
            priceMode: draft.priceMode,
            price: parsedPrice,
            travel: validated,
          }),
        },
      );

      setPackages((prev) => {
        const exists = prev.some((p) => p.id === saved.id);
        return exists ? prev.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...prev];
      });
      setDraft(dtoToDraft(saved));
      setBanner({
        tone: "success",
        title: action === "publish" ? "Paket berhasil dipublikasikan" : "Draf paket tersimpan",
        message:
          action === "publish"
            ? `Paket "${saved.title}" kini tampil di halaman publik ${saved.publicPath}.`
            : "Rencana perjalanan, jadwal keberangkatan, dan rincian paket berhasil disimpan sebagai draf.",
      });
    } catch (err) {
      const msg =
        err instanceof CmsApiError
          ? err.message
          : action === "publish"
            ? "Gagal mempublikasikan paket perjalanan."
            : "Gagal menyimpan draf paket perjalanan. Coba lagi.";
      setBanner({
        tone: "destructive",
        title: action === "publish" ? "Publikasi ditolak" : "Gagal menyimpan draf",
        message: msg,
      });
    } finally {
      setSubmitting(false);
    }
  }

  function moveItineraryDay(index: number, delta: -1 | 1) {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= draft.itinerary.length) return;
    const next = [...draft.itinerary];
    const [moved] = next.splice(index, 1);
    if (moved) {
      next.splice(target, 0, moved);
      updateDraft("itinerary", next);
    }
  }

  const publishDisabled =
    readOnly || !canPublishTravel || submitting || !publishGate.allowed;

  return (
    <div className="min-w-0 max-w-full space-y-6 overflow-x-clip" data-testid="travel-manager-root">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              render={<a href={`${basePath}/catalog`} />}
              className="-ml-2 min-h-10"
            >
              <ArrowLeftIcon className="size-4" />
              Kembali ke Katalog
            </Button>
            <Badge variant="outline">
              <CompassIcon className="size-3.5" />
              Modul Tur &amp; Umrah
            </Badge>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Pengelola Rencana Perjalanan &amp; Jadwal Keberangkatan
          </h1>
          <p className="text-sm text-muted-foreground">
            Susun durasi, maskapai, hotel, rencana perjalanan harian, dan jadwal keberangkatan
            berbasis tanggal kalender (konversi langsung ke WhatsApp, tanpa checkout OTA).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={readOnly || submitting}
            onClick={startNewPackage}
            className="min-h-11 sm:min-h-9"
            data-testid="travel-new-package-btn"
          >
            <PlusIcon className="size-4" />
            Paket Baru
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly || submitting}
            onClick={() => void submitToTravelApi("save_draft")}
            className="min-h-11 sm:min-h-9"
            data-testid="travel-save-draft-btn"
          >
            <SaveIcon className="size-4" />
            Simpan Draf
          </Button>
          <Button
            type="button"
            disabled={publishDisabled}
            onClick={() => void submitToTravelApi("publish")}
            className="min-h-11 sm:min-h-9"
            data-testid="travel-publish-btn"
          >
            <GlobeIcon className="size-4" />
            Publikasikan Paket
          </Button>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {banner && (
        <Alert
          variant={
            banner.tone === "success"
              ? "success"
              : banner.tone === "warning"
                ? "warning"
                : "destructive"
          }
          data-testid="travel-status-banner"
        >
          {banner.tone === "success" ? (
            <CheckCircle2Icon className="size-4" />
          ) : (
            <ShieldAlertIcon className="size-4" />
          )}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* Existing Tour Packages Switcher */}
      {packages.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Daftar Paket Tur Situs Anda</CardTitle>
            <CardDescription>
              Pilih paket untuk memperbarui rencana perjalanan atau buat paket baru.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {packages.map((pkg) => {
              const selected = draft.id === pkg.id;
              return (
                <button
                  key={pkg.id}
                  type="button"
                  onClick={() => selectPackage(pkg)}
                  data-testid={`travel-package-pill-${pkg.id}`}
                  className={`inline-flex min-h-11 max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors sm:min-h-9 ${
                    selected
                      ? "border-primary bg-primary/10 font-semibold text-foreground"
                      : "border-border bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  <span className="min-w-0 break-words">{pkg.title}</span>
                  <ContentStatusBadge status={pkg.status} />
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Main Editor Grid */}
      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* 1. Package Kind + Core Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <PlaneIcon className="size-4 text-primary" />
                Informasi Utama Paket
              </CardTitle>
              <CardDescription>
                Pilih jenis paket dan isi rincian durasi, destinasi, serta transportasi.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <label htmlFor="travel-title" className="block text-sm font-medium text-foreground">
                    Judul Paket Perjalanan
                  </label>
                  <Input
                    id="travel-title"
                    value={draft.title}
                    disabled={readOnly}
                    placeholder="Contoh: Paket Wisata Bali & Nusa Penida 4H3M"
                    onChange={(e) => updateDraft("title", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                  {fieldErrors.title && (
                    <p className="text-xs text-destructive">{fieldErrors.title}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-package-kind"
                    className="block text-sm font-medium text-foreground"
                  >
                    Jenis Paket
                  </label>
                  <select
                    id="travel-package-kind"
                    value={draft.packageKind}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateDraft("packageKind", e.target.value as TravelPackageKind)
                    }
                    data-testid="travel-package-kind-select"
                    className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base sm:min-h-9 sm:text-sm"
                  >
                    <option value="general_tour">{TRAVEL_PACKAGE_KIND_LABELS.general_tour}</option>
                    <option value="umrah">{TRAVEL_PACKAGE_KIND_LABELS.umrah}</option>
                    <option value="hajj">{TRAVEL_PACKAGE_KIND_LABELS.hajj}</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-destination"
                    className="block text-sm font-medium text-foreground"
                  >
                    Destinasi Utama
                  </label>
                  <Input
                    id="travel-destination"
                    value={draft.destination}
                    disabled={readOnly}
                    placeholder="Bali & Nusa Penida / Makkah & Madinah"
                    onChange={(e) => updateDraft("destination", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-duration-days"
                    className="block text-sm font-medium text-foreground"
                  >
                    Durasi Hari (1–60)
                  </label>
                  <Input
                    id="travel-duration-days"
                    type="number"
                    min={1}
                    max={60}
                    value={draft.durationDaysStr}
                    disabled={readOnly}
                    onChange={(e) => updateDraft("durationDaysStr", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                  {fieldErrors.durationDays && (
                    <p className="text-xs text-destructive">{fieldErrors.durationDays}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-duration-nights"
                    className="block text-sm font-medium text-foreground"
                  >
                    Durasi Malam (0–60)
                  </label>
                  <Input
                    id="travel-duration-nights"
                    type="number"
                    min={0}
                    max={60}
                    value={draft.durationNightsStr}
                    disabled={readOnly}
                    onChange={(e) => updateDraft("durationNightsStr", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                  {durationPreview && (
                    <p className="text-xs text-muted-foreground">Tampilan: {durationPreview}</p>
                  )}
                  {fieldErrors.durationNights && (
                    <p className="text-xs text-destructive">{fieldErrors.durationNights}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-departure-city"
                    className="block text-sm font-medium text-foreground"
                  >
                    Kota Keberangkatan
                  </label>
                  <Input
                    id="travel-departure-city"
                    value={draft.departureCity}
                    disabled={readOnly}
                    placeholder="Jakarta (CGK)"
                    onChange={(e) => updateDraft("departureCity", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="travel-airline" className="block text-sm font-medium text-foreground">
                    Maskapai Penerbangan
                  </label>
                  <Input
                    id="travel-airline"
                    value={draft.airline}
                    disabled={readOnly}
                    placeholder="Garuda Indonesia / Saudia Airlines"
                    onChange={(e) => updateDraft("airline", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  <label
                    htmlFor="travel-transport"
                    className="block text-sm font-medium text-foreground"
                  >
                    Transportasi Darat / Lokal
                  </label>
                  <Input
                    id="travel-transport"
                    value={draft.transport}
                    disabled={readOnly}
                    placeholder="Bus Pariwisata AC Eksekutif / Kereta Cepat Haramain"
                    onChange={(e) => updateDraft("transport", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-insurance"
                    className="block text-sm font-medium text-foreground"
                  >
                    Asuransi Perjalanan (Permenpar 6/2025)
                  </label>
                  <Input
                    id="travel-insurance"
                    value={draft.travelInsurance}
                    disabled={readOnly}
                    placeholder="Asuransi perjalanan & kecelakaan selama program"
                    onChange={(e) => updateDraft("travelInsurance", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="travel-visa"
                    className="block text-sm font-medium text-foreground"
                  >
                    Visa Resmi (opsional / 5 Pasti Umrah)
                  </label>
                  <Input
                    id="travel-visa"
                    value={draft.officialVisa}
                    disabled={readOnly}
                    placeholder="Visa Umrah resmi Kemenag / Visa Turis resmi"
                    onChange={(e) => updateDraft("officialVisa", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Hotels / Accommodation (<= 10) */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <HotelIcon className="size-4 text-primary" />
                  Akomodasi &amp; Daftar Hotel ({draft.hotels.length}/{MAX_TRAVEL_HOTELS})
                </CardTitle>
                <CardDescription>
                  Cantumkan hotel per kota (misalnya Makkah, Madinah, atau kota destinasi).
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || draft.hotels.length >= MAX_TRAVEL_HOTELS}
                onClick={() =>
                  updateDraft("hotels", [
                    ...draft.hotels,
                    { name: "", city: "", starClass: "4", distanceNote: "" },
                  ])
                }
                className="min-h-10 sm:min-h-8"
              >
                <PlusIcon className="size-4" />
                Tambah Hotel
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.hotels.length === 0 ? (
                <div className="space-y-2">
                  <label
                    htmlFor="travel-accommodation-text"
                    className="block text-sm font-medium text-foreground"
                  >
                    Ringkasan Akomodasi (jika belum dirinci per hotel)
                  </label>
                  <Input
                    id="travel-accommodation-text"
                    value={draft.accommodation}
                    disabled={readOnly}
                    placeholder="Hotel bintang 4 setaraf (sekamar berdua)"
                    onChange={(e) => updateDraft("accommodation", e.target.value)}
                    className="min-h-11 sm:min-h-9"
                  />
                </div>
              ) : (
                draft.hotels.map((hotel, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-12"
                  >
                    <div className="sm:col-span-4">
                      <label
                        htmlFor={`travel-hotel-${idx}-name`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Nama Hotel
                      </label>
                      <Input
                        id={`travel-hotel-${idx}-name`}
                        value={hotel.name}
                        disabled={readOnly}
                        placeholder="Pullman Zamzam"
                        onChange={(e) => {
                          const next = draft.hotels.map((h, i) =>
                            i === idx ? { ...h, name: e.target.value } : h,
                          );
                          updateDraft("hotels", next);
                        }}
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label
                        htmlFor={`travel-hotel-${idx}-city`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Kota
                      </label>
                      <Input
                        id={`travel-hotel-${idx}-city`}
                        value={hotel.city}
                        disabled={readOnly}
                        placeholder="Makkah"
                        onChange={(e) => {
                          const next = draft.hotels.map((h, i) =>
                            i === idx ? { ...h, city: e.target.value } : h,
                          );
                          updateDraft("hotels", next);
                        }}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`travel-hotel-${idx}-star`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Bintang
                      </label>
                      <select
                        id={`travel-hotel-${idx}-star`}
                        value={hotel.starClass}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = draft.hotels.map((h, i) =>
                            i === idx ? { ...h, starClass: e.target.value } : h,
                          );
                          updateDraft("hotels", next);
                        }}
                        className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                      >
                        <option value="">—</option>
                        <option value="5">★ 5</option>
                        <option value="4">★ 4</option>
                        <option value="3">★ 3</option>
                        <option value="2">★ 2</option>
                        <option value="1">★ 1</option>
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`travel-hotel-${idx}-distance`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Jarak / Catatan
                      </label>
                      <Input
                        id={`travel-hotel-${idx}-distance`}
                        value={hotel.distanceNote}
                        disabled={readOnly}
                        placeholder="±150 m"
                        onChange={(e) => {
                          const next = draft.hotels.map((h, i) =>
                            i === idx ? { ...h, distanceNote: e.target.value } : h,
                          );
                          updateDraft("hotels", next);
                        }}
                      />
                    </div>
                    <div className="flex items-end justify-end sm:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={readOnly}
                        aria-label={`Hapus hotel ${idx + 1}`}
                        onClick={() =>
                          updateDraft(
                            "hotels",
                            draft.hotels.filter((_, i) => i !== idx),
                          )
                        }
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* 3. Day-by-Day Itinerary Builder (1..30 days) */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">
                  Rencana Perjalanan Harian ({draft.itinerary.length}/{MAX_TRAVEL_ITINERARY_DAYS} Hari)
                </CardTitle>
                <CardDescription>
                  Ditampilkan sebagai akordeon HTML ramah aksesibilitas di halaman publik tanpa JavaScript.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || draft.itinerary.length >= MAX_TRAVEL_ITINERARY_DAYS}
                onClick={() =>
                  updateDraft("itinerary", [
                    ...draft.itinerary,
                    {
                      title: `Aktivitas Hari ${draft.itinerary.length + 1}`,
                      summary: "",
                      city: "",
                      meals: "",
                    },
                  ])
                }
                className="min-h-10 sm:min-h-8"
                data-testid="travel-add-day-btn"
              >
                <PlusIcon className="size-4" />
                Tambah Hari
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.itinerary.map((day, idx) => (
                <div
                  key={idx}
                  className="space-y-3 rounded-lg border border-border bg-card p-3.5"
                  data-testid={`travel-editor-day-${idx + 1}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="secondary">Hari {idx + 1}</Badge>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || idx === 0}
                        aria-label={`Naikkan hari ${idx + 1}`}
                        onClick={() => moveItineraryDay(idx, -1)}
                      >
                        <ArrowUpIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || idx === draft.itinerary.length - 1}
                        aria-label={`Turunkan hari ${idx + 1}`}
                        onClick={() => moveItineraryDay(idx, 1)}
                      >
                        <ArrowDownIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly || draft.itinerary.length <= 1}
                        aria-label={`Hapus hari ${idx + 1}`}
                        onClick={() =>
                          updateDraft(
                            "itinerary",
                            draft.itinerary.filter((_, i) => i !== idx),
                          )
                        }
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`travel-day-${idx}-title`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Judul Hari
                      </label>
                      <Input
                        id={`travel-day-${idx}-title`}
                        value={day.title}
                        disabled={readOnly}
                        placeholder="Contoh: Kedatangan & Orientasi Kota"
                        onChange={(e) => {
                          const next = draft.itinerary.map((d, i) =>
                            i === idx ? { ...d, title: e.target.value } : d,
                          );
                          updateDraft("itinerary", next);
                        }}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`travel-day-${idx}-city`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Kota (opsional)
                      </label>
                      <Input
                        id={`travel-day-${idx}-city`}
                        value={day.city}
                        disabled={readOnly}
                        placeholder="Madinah / Ubud"
                        onChange={(e) => {
                          const next = draft.itinerary.map((d, i) =>
                            i === idx ? { ...d, city: e.target.value } : d,
                          );
                          updateDraft("itinerary", next);
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`travel-day-${idx}-summary`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Ringkasan Aktivitas
                      </label>
                      <textarea
                        id={`travel-day-${idx}-summary`}
                        rows={2}
                        value={day.summary}
                        disabled={readOnly}
                        placeholder="Jelaskan agenda utama perjalanan hari ini..."
                        onChange={(e) => {
                          const next = draft.itinerary.map((d, i) =>
                            i === idx ? { ...d, summary: e.target.value } : d,
                          );
                          updateDraft("itinerary", next);
                        }}
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`travel-day-${idx}-meals`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Konsumsi (opsional)
                      </label>
                      <Input
                        id={`travel-day-${idx}-meals`}
                        value={day.meals}
                        disabled={readOnly}
                        placeholder="Sarapan, Siang, Malam"
                        onChange={(e) => {
                          const next = draft.itinerary.map((d, i) =>
                            i === idx ? { ...d, meals: e.target.value } : d,
                          );
                          updateDraft("itinerary", next);
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 4. Date-Only Departure Schedules (<= 24, ZERO seat inventory / OTA) */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarIcon className="size-4 text-primary" />
                  Jadwal Keberangkatan ({draft.departures.length}/{MAX_TRAVEL_DEPARTURES})
                </CardTitle>
                <CardDescription>
                  Tanggal kalender murni (YYYY-MM-DD, tidak bergeser antar zona waktu) tanpa penghitung kuota kursi atau checkout OTA.
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || draft.departures.length >= MAX_TRAVEL_DEPARTURES}
                onClick={() =>
                  updateDraft("departures", [
                    ...draft.departures,
                    {
                      departureDate: "",
                      returnDate: "",
                      departureCity: draft.departureCity,
                      label: "",
                    },
                  ])
                }
                className="min-h-10 sm:min-h-8"
                data-testid="travel-add-departure-btn"
              >
                <PlusIcon className="size-4" />
                Tambah Tanggal
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.departures.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  Belum ada jadwal keberangkatan. Klik &ldquo;Tambah Tanggal&rdquo; untuk
                  menampilkan daftar keberangkatan informatif kepada pengunjung.
                </p>
              ) : (
                draft.departures.map((dep, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-12"
                    data-testid={`travel-editor-departure-${idx}`}
                  >
                    <div className="sm:col-span-3">
                      <label
                        htmlFor={`travel-dep-${idx}-date`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Tanggal Berangkat
                      </label>
                      <Input
                        id={`travel-dep-${idx}-date`}
                        type="date"
                        value={dep.departureDate}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = draft.departures.map((d, i) =>
                            i === idx ? { ...d, departureDate: e.target.value } : d,
                          );
                          updateDraft("departures", next);
                        }}
                      />
                      {dep.departureDate && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatTravelDateOnlyIndonesian(dep.departureDate)}
                        </p>
                      )}
                    </div>
                    <div className="sm:col-span-3">
                      <label
                        htmlFor={`travel-dep-${idx}-return`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Tanggal Pulang (opsional)
                      </label>
                      <Input
                        id={`travel-dep-${idx}-return`}
                        type="date"
                        value={dep.returnDate}
                        disabled={readOnly}
                        onChange={(e) => {
                          const next = draft.departures.map((d, i) =>
                            i === idx ? { ...d, returnDate: e.target.value } : d,
                          );
                          updateDraft("departures", next);
                        }}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`travel-dep-${idx}-city`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Kota Berangkat
                      </label>
                      <Input
                        id={`travel-dep-${idx}-city`}
                        value={dep.departureCity}
                        disabled={readOnly}
                        placeholder="Jakarta"
                        onChange={(e) => {
                          const next = draft.departures.map((d, i) =>
                            i === idx ? { ...d, departureCity: e.target.value } : d,
                          );
                          updateDraft("departures", next);
                        }}
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label
                        htmlFor={`travel-dep-${idx}-label`}
                        className="mb-1 block text-xs font-medium text-muted-foreground"
                      >
                        Keterangan Grup
                      </label>
                      <Input
                        id={`travel-dep-${idx}-label`}
                        value={dep.label}
                        disabled={readOnly}
                        placeholder="Keberangkatan Reguler"
                        onChange={(e) => {
                          const next = draft.departures.map((d, i) =>
                            i === idx ? { ...d, label: e.target.value } : d,
                          );
                          updateDraft("departures", next);
                        }}
                      />
                    </div>
                    <div className="flex items-start justify-end pt-5 sm:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={readOnly}
                        aria-label={`Hapus jadwal ${idx + 1}`}
                        onClick={() =>
                          updateDraft(
                            "departures",
                            draft.departures.filter((_, i) => i !== idx),
                          )
                        }
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* 5. Inclusions & Exclusions (<= 20 each) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fasilitas Termasuk &amp; Tidak Termasuk</CardTitle>
              <CardDescription>
                Maksimal {MAX_TRAVEL_INCLUSIONS} poin termasuk dan {MAX_TRAVEL_EXCLUSIONS} poin tidak termasuk.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div className="space-y-3">
                <label
                  htmlFor="travel-new-inclusion"
                  className="block text-sm font-semibold text-foreground"
                >
                  Termasuk ({draft.inclusions.length}/{MAX_TRAVEL_INCLUSIONS})
                </label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="travel-new-inclusion"
                    value={newInclusion}
                    disabled={readOnly || draft.inclusions.length >= MAX_TRAVEL_INCLUSIONS}
                    placeholder="Tambah fasilitas termasuk..."
                    onChange={(e) => setNewInclusion(e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      readOnly ||
                      !newInclusion.trim() ||
                      draft.inclusions.length >= MAX_TRAVEL_INCLUSIONS
                    }
                    onClick={() => {
                      updateDraft("inclusions", [...draft.inclusions, newInclusion.trim()]);
                      setNewInclusion("");
                    }}
                  >
                    Tambah
                  </Button>
                </div>
                <ul className="space-y-1.5 text-sm">
                  {draft.inclusions.map((item, idx) => (
                    <li
                      key={idx}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                    >
                      <span className="min-w-0 break-words">{item}</span>
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-label={`Hapus fasilitas termasuk ${idx + 1}`}
                        onClick={() =>
                          updateDraft(
                            "inclusions",
                            draft.inclusions.filter((_, i) => i !== idx),
                          )
                        }
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-3">
                <label
                  htmlFor="travel-new-exclusion"
                  className="block text-sm font-semibold text-foreground"
                >
                  Tidak Termasuk ({draft.exclusions.length}/{MAX_TRAVEL_EXCLUSIONS})
                </label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="travel-new-exclusion"
                    value={newExclusion}
                    disabled={readOnly || draft.exclusions.length >= MAX_TRAVEL_EXCLUSIONS}
                    placeholder="Tambah pengecualian..."
                    onChange={(e) => setNewExclusion(e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      readOnly ||
                      !newExclusion.trim() ||
                      draft.exclusions.length >= MAX_TRAVEL_EXCLUSIONS
                    }
                    onClick={() => {
                      updateDraft("exclusions", [...draft.exclusions, newExclusion.trim()]);
                      setNewExclusion("");
                    }}
                  >
                    Tambah
                  </Button>
                </div>
                <ul className="space-y-1.5 text-sm">
                  {draft.exclusions.map((item, idx) => (
                    <li
                      key={idx}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                    >
                      <span className="min-w-0 break-words">{item}</span>
                      <button
                        type="button"
                        disabled={readOnly}
                        aria-label={`Hapus pengecualian ${idx + 1}`}
                        onClick={() =>
                          updateDraft(
                            "exclusions",
                            draft.exclusions.filter((_, i) => i !== idx),
                          )
                        }
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: DEC-042 Compliance & Publish Gate */}
        <div className="min-w-0 space-y-6">
          <Card data-testid="travel-compliance-gate-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {publishGate.allowed ? (
                  <ShieldCheckIcon className="size-4 text-success" />
                ) : (
                  <ShieldAlertIcon className="size-4 text-warning" />
                )}
                Status Publikasi &amp; Kepatuhan
              </CardTitle>
              <CardDescription>
                {draft.packageKind === "general_tour"
                  ? "Paket tur umum tidak memerlukan gerbang SK PPIU/PIHK."
                  : "Kepatuhan UU 8/2019 & DEC-042 untuk paket Umrah dan Haji Khusus."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.packageKind === "general_tour" ? (
                <Alert variant="success" data-testid="travel-general-tour-ready">
                  <CheckCircle2Icon className="size-4" />
                  <AlertTitle>Siap Dipublikasikan (Tur Umum)</AlertTitle>
                  <AlertDescription>
                    Paket tur umum dapat disimpan sebagai draf dan dipublikasikan langsung ke
                    halaman publik <code>/tour/[slug]</code> tanpa gerbang SK PPIU.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="travel-sk-license"
                      className="block text-sm font-medium text-foreground"
                    >
                      {draft.packageKind === "hajj"
                        ? "Nomor SK PIHK Kemenag (Wajib)"
                        : "Nomor SK PPIU Kemenag (Wajib)"}
                    </label>
                    <Input
                      id="travel-sk-license"
                      value={
                        draft.packageKind === "hajj" ? draft.skPihkNumber : draft.skPpiuNumber
                      }
                      disabled={readOnly}
                      placeholder={
                        draft.packageKind === "hajj" ? "HK.45 Tahun 2025" : "U.128 Tahun 2024"
                      }
                      onChange={(e) =>
                        updateDraft(
                          draft.packageKind === "hajj" ? "skPihkNumber" : "skPpiuNumber",
                          e.target.value,
                        )
                      }
                      data-testid="travel-sk-license-input"
                      className="min-h-11 sm:min-h-9"
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2 text-sm">
                    <p className="font-semibold text-foreground">Syarat Publikasi (DEC-042)</p>
                    <ul className="space-y-2" data-testid="travel-dec042-checklist">
                      <li className="flex items-center justify-between gap-2">
                        <span>
                          {draft.packageKind === "hajj" ? "Nomor SK PIHK" : "Nomor SK PPIU"} valid
                        </span>
                        <Badge
                          variant={
                            publishGate.reasons.some((r) => r.code === "UMRAH_LICENSE_REQUIRED")
                              ? "warning"
                              : "success"
                          }
                        >
                          {publishGate.reasons.some((r) => r.code === "UMRAH_LICENSE_REQUIRED")
                            ? "Belum valid"
                            : "Terisi"}
                        </Badge>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Verifikasi Operator Platform</span>
                        <Badge variant={serverOperatorVerified ? "success" : "warning"}>
                          {serverOperatorVerified ? "Terverifikasi" : "Menunggu Operator"}
                        </Badge>
                      </li>
                      <li className="flex items-center justify-between gap-2">
                        <span>Tinjauan Hukum Redaksi</span>
                        <Badge variant={serverCounselApproved ? "success" : "warning"}>
                          {serverCounselApproved ? "Disetujui" : "Menunggu Review"}
                        </Badge>
                      </li>
                    </ul>
                  </div>

                  {!publishGate.allowed && (
                    <Alert variant="warning" data-testid="travel-umrah-gate-alert">
                      <LockIcon className="size-4" />
                      <AlertTitle>Publikasi Umrah/Haji Diblokir (DEC-042)</AlertTitle>
                      <AlertDescription>
                        <ul className="mt-1 list-disc space-y-1 pl-4">
                          {publishGate.reasons.map((reason) => (
                            <li key={reason.code} data-denial-code={reason.code}>
                              {reason.message}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 font-medium">
                          Anda tetap dapat menyimpan perubahan ini sebagai Draf sementara menunggu
                          verifikasi operator.
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              <Separator />

              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">Prinsip Konversi B2B (DEC-038)</p>
                <p>
                  Halaman publik menampilkan rincian itinerary dan tanggal keberangkatan informatif
                  dengan tombol langsung ke WhatsApp. Tidak ada keranjang belanja, sistem tiket
                  otomatis, atau penghitung sisa kursi.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
