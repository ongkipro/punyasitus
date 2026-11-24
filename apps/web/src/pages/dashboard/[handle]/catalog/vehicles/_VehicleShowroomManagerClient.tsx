import { useMemo, useState } from "react";
import type { CatalogPriceMode, CatalogVehicleUnitStatus } from "@punyasitus/core/catalog/index";
import {
  computeStaticVehicleCreditEstimateTable,
  formatFlatAnnualRateBpsLabel,
  formatVehiclePriceLabel,
  MAX_CREDIT_DP_OPTIONS,
  MAX_CREDIT_TENOR_OPTIONS,
  normalizeVehicleDisplayModel,
  shouldRenderVehicleCreditTable,
  validateVehicleShowroomAttributes,
  VEHICLE_BODY_TYPE_LABELS,
  VEHICLE_CAR_BODY_TYPES,
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_LABELS,
  VEHICLE_CONDITION_LABELS,
  VEHICLE_CONDITIONS,
  VEHICLE_CREDIT_DISCLAIMER,
  VEHICLE_FUEL_LABELS,
  VEHICLE_FUELS,
  VEHICLE_MOTORCYCLE_BODY_TYPES,
  VEHICLE_PRICE_MODEL_LABELS,
  VEHICLE_PRICE_MODELS,
  VEHICLE_SHOWROOM_UNIT_STATUSES,
  VEHICLE_TRANSMISSION_LABELS,
  VEHICLE_TRANSMISSIONS,
  VEHICLE_UNIT_STATUS_BADGE_LABELS,
  VehicleValidationError,
  type VehicleBodyType,
  type VehicleCategory,
  type VehicleCondition,
  type VehicleFuel,
  type VehiclePriceModel,
  type VehicleShowroomAttributes,
  type VehicleShowroomUnitStatus,
  type VehicleTransmission,
} from "@punyasitus/core/catalog/vehicle";
import {
  ArrowLeftIcon,
  CalculatorIcon,
  CarFrontIcon,
  CheckCircle2Icon,
  GlobeIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  SaveIcon,
  ShieldAlertIcon,
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

export interface VehicleCatalogItemDto {
  readonly id: number;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly summary: string;
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly negotiable: boolean;
  readonly unitStatus: CatalogVehicleUnitStatus;
  readonly status: "draft" | "published" | "trashed";
  readonly version: number;
  readonly attributes: Record<string, unknown>;
}

export interface VehicleShowroomManagerClientProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly canWriteVehicles: boolean;
  readonly canPublishVehicles: boolean;
  readonly initialVehicles: readonly VehicleCatalogItemDto[];
}

interface EditorDraftState {
  readonly id: number | null;
  readonly version: number;
  readonly status: "draft" | "published" | "trashed";
  readonly title: string;
  readonly summary: string;
  readonly vehicleCategory: VehicleCategory;
  readonly brand: string;
  readonly model: string;
  readonly variant: string;
  readonly yearStr: string;
  readonly condition: VehicleCondition;
  readonly mileageKmStr: string;
  readonly transmission: VehicleTransmission;
  readonly fuel: VehicleFuel;
  readonly bodyType: VehicleBodyType;
  readonly color: string;
  readonly seatsStr: string;
  readonly engineCcStr: string;
  readonly location: string;
  readonly plateRegion: string;
  readonly stnkTaxExpiryDate: string;
  readonly ownershipCountStr: string;
  readonly priceModel: VehiclePriceModel;
  readonly priceIdrStr: string;
  readonly minPriceIdrStr: string;
  readonly maxPriceIdrStr: string;
  readonly negotiable: boolean;
  readonly unitStatus: VehicleShowroomUnitStatus;
  readonly hideSoldInGrids: boolean;
  readonly otrPriceNote: string;
  readonly salesWhatsappOverride: string;
  readonly creditEnabled: boolean;
  readonly flatAnnualRateBpsStr: string;
  readonly dpPercentsCsv: string;
  readonly tenorMonthsCsv: string;
}

function buildEmptyDraft(): EditorDraftState {
  return {
    id: null,
    version: 1,
    status: "draft",
    title: "",
    summary: "",
    vehicleCategory: "car",
    brand: "",
    model: "",
    variant: "",
    yearStr: String(new Date().getUTCFullYear()),
    condition: "used",
    mileageKmStr: "18500",
    transmission: "cvt",
    fuel: "bensin",
    bodyType: "mpv",
    color: "Putih Mutiara",
    seatsStr: "7",
    engineCcStr: "1496",
    location: "Jakarta Selatan",
    plateRegion: "B (Jakarta)",
    stnkTaxExpiryDate: "",
    ownershipCountStr: "1",
    priceModel: "fixed",
    priceIdrStr: "285000000",
    minPriceIdrStr: "",
    maxPriceIdrStr: "",
    negotiable: true,
    unitStatus: "available",
    hideSoldInGrids: false,
    otrPriceNote: "Harga OTR Jakarta, surat lengkap BPKB & faktur.",
    salesWhatsappOverride: "",
    creditEnabled: true,
    flatAnnualRateBpsStr: "650",
    dpPercentsCsv: "20, 30, 40",
    tenorMonthsCsv: "12, 24, 36, 48",
  };
}

function dtoToDraft(item: VehicleCatalogItemDto): EditorDraftState {
  const m = normalizeVehicleDisplayModel(item.attributes, {
    priceMode: item.priceMode,
    price: item.price,
    priceMax: item.priceMax,
    negotiable: item.negotiable,
    unitStatus: item.unitStatus,
  });

  const vehicleCategory: VehicleCategory = m.vehicleCategory ?? "car";
  const defaultBody: VehicleBodyType = vehicleCategory === "motorcycle" ? "matic" : "mpv";

  return {
    id: item.id,
    version: item.version,
    status: item.status,
    title: item.title,
    summary: item.summary,
    vehicleCategory,
    brand: m.brand ?? "",
    model: m.model ?? "",
    variant: m.variant ?? "",
    yearStr: m.year !== null ? String(m.year) : "",
    condition: m.condition ?? "used",
    mileageKmStr: m.condition === "used" && m.mileageKm !== null ? String(m.mileageKm) : "",
    transmission: m.transmission ?? "automatic",
    fuel: m.fuel ?? "bensin",
    bodyType: m.bodyType ?? defaultBody,
    color: m.color ?? "",
    seatsStr: m.seats !== null ? String(m.seats) : "",
    engineCcStr: m.engineCc !== null ? String(m.engineCc) : "",
    location: m.location ?? "",
    plateRegion: m.plateRegion ?? "",
    stnkTaxExpiryDate: m.stnkTaxExpiryDate ?? "",
    ownershipCountStr:
      m.condition === "used" && m.ownershipCount !== null ? String(m.ownershipCount) : "",
    priceModel: m.priceModel,
    priceIdrStr:
      (m.priceModel === "fixed" || m.priceModel === "from") && m.priceIdr !== null
        ? String(m.priceIdr)
        : "",
    minPriceIdrStr:
      m.priceModel === "range" && m.minPriceIdr !== null ? String(m.minPriceIdr) : "",
    maxPriceIdrStr:
      m.priceModel === "range" && m.maxPriceIdr !== null ? String(m.maxPriceIdr) : "",
    negotiable: m.negotiable,
    unitStatus: m.unitStatus,
    hideSoldInGrids: m.hideSoldInGrids,
    otrPriceNote: m.otrPriceNote ?? "",
    salesWhatsappOverride: m.salesWhatsappOverride ?? "",
    creditEnabled: m.creditEstimate?.enabled === true,
    flatAnnualRateBpsStr:
      m.creditEstimate !== null ? String(m.creditEstimate.flatAnnualRateBps) : "650",
    dpPercentsCsv: (m.creditEstimate?.dpPercents ?? [20, 30, 40]).join(", "),
    tenorMonthsCsv: (m.creditEstimate?.tenorMonths ?? [12, 24, 36, 48]).join(", "),
  };
}

type StrictIntParseResult =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "invalid" };

/**
 * Strict integer parser: rejects negative numbers, decimals, and non-digit characters
 * instead of silently stripping them.
 */
function parseStrictOptionalInt(raw: string): StrictIntParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) return { kind: "invalid" };
  return { kind: "ok", value: num };
}

function parseStrictCsvIntList(
  raw: string,
): { readonly ok: true; readonly values: number[] } | { readonly ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { ok: false };
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { ok: false };
    const num = Number(part);
    if (!Number.isSafeInteger(num)) return { ok: false };
    values.push(num);
  }
  return { ok: true, values };
}

function statusBadgeVariant(status: CatalogVehicleUnitStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "sold") return "destructive";
  if (status === "booked") return "outline";
  return "secondary";
}

export function VehicleShowroomManagerClient({
  handle,
  basePath,
  permissions,
  canWriteVehicles,
  canPublishVehicles,
  initialVehicles,
}: VehicleShowroomManagerClientProps) {
  const [vehicles, setVehicles] = useState<readonly VehicleCatalogItemDto[]>(initialVehicles);
  const [draft, setDraft] = useState<EditorDraftState>(() =>
    initialVehicles[0] ? dtoToDraft(initialVehicles[0]) : buildEmptyDraft(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "warning" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const readOnly = !canWriteVehicles || permissions.isLocked;

  const allowedBodyTypes: readonly VehicleBodyType[] =
    draft.vehicleCategory === "motorcycle"
      ? VEHICLE_MOTORCYCLE_BODY_TYPES
      : VEHICLE_CAR_BODY_TYPES;

  const parsedPriceIdrRes = parseStrictOptionalInt(draft.priceIdrStr);
  const parsedPriceIdr = parsedPriceIdrRes.kind === "ok" ? parsedPriceIdrRes.value : null;
  const parsedRateBpsRes = parseStrictOptionalInt(draft.flatAnnualRateBpsStr);
  const parsedRateBps = parsedRateBpsRes.kind === "ok" ? parsedRateBpsRes.value : null;
  const parsedDpPercentsRes = useMemo(
    () => parseStrictCsvIntList(draft.dpPercentsCsv),
    [draft.dpPercentsCsv],
  );
  const parsedTenorsRes = useMemo(
    () => parseStrictCsvIntList(draft.tenorMonthsCsv),
    [draft.tenorMonthsCsv],
  );
  const parsedDpPercents = parsedDpPercentsRes.ok ? parsedDpPercentsRes.values : [];
  const parsedTenors = parsedTenorsRes.ok ? parsedTenorsRes.values : [];

  const liveCreditPreview = useMemo(() => {
    if (
      !draft.creditEnabled ||
      draft.priceModel !== "fixed" ||
      parsedPriceIdr === null ||
      parsedRateBps === null ||
      !parsedDpPercentsRes.ok ||
      !parsedTenorsRes.ok
    ) {
      return null;
    }
    return computeStaticVehicleCreditEstimateTable({
      priceIdr: parsedPriceIdr,
      flatAnnualRateBps: parsedRateBps,
      dpPercents: parsedDpPercents,
      tenorMonths: parsedTenors,
    });
  }, [
    draft.creditEnabled,
    draft.priceModel,
    parsedPriceIdr,
    parsedRateBps,
    parsedDpPercentsRes.ok,
    parsedTenorsRes.ok,
    parsedDpPercents,
    parsedTenors,
  ]);

  const willRenderPublicCreditTable = shouldRenderVehicleCreditTable({
    publicationStatus: "published",
    unitStatus: draft.unitStatus,
    priceModel: draft.priceModel,
    priceIdr: parsedPriceIdr,
    creditEstimate:
      draft.creditEnabled &&
      parsedRateBps !== null &&
      parsedDpPercentsRes.ok &&
      parsedTenorsRes.ok
        ? {
            enabled: true,
            flatAnnualRateBps: parsedRateBps,
            dpPercents: parsedDpPercents,
            tenorMonths: parsedTenors,
          }
        : null,
  });

  function updateDraft(patch: Partial<EditorDraftState>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function handleCategoryChange(nextCategory: VehicleCategory) {
    const nextAllowed =
      nextCategory === "motorcycle" ? VEHICLE_MOTORCYCLE_BODY_TYPES : VEHICLE_CAR_BODY_TYPES;
    const nextBodyType = (nextAllowed as readonly string[]).includes(draft.bodyType)
      ? draft.bodyType
      : nextCategory === "motorcycle"
        ? "matic"
        : "mpv";
    updateDraft({
      vehicleCategory: nextCategory,
      bodyType: nextBodyType,
      seatsStr: nextCategory === "motorcycle" ? "" : draft.seatsStr || "5",
    });
  }

  function handleConditionChange(nextCondition: VehicleCondition) {
    if (nextCondition === "new") {
      // Clear used-only fields automatically to uphold REQ-079 new-unit invariant
      updateDraft({
        condition: "new",
        mileageKmStr: "",
        ownershipCountStr: "",
      });
    } else {
      updateDraft({
        condition: "used",
        mileageKmStr: draft.mileageKmStr || "15000",
        ownershipCountStr: draft.ownershipCountStr || "1",
      });
    }
  }

  function buildVehiclePayloadWithClientCheck(): {
    readonly payload: Record<string, unknown>;
    readonly parseErrors: Record<string, string>;
  } {
    const parseErrors: Record<string, string> = {};
    const yearRes = parseStrictOptionalInt(draft.yearStr);
    const mileageRes = parseStrictOptionalInt(draft.mileageKmStr);
    const seatsRes = parseStrictOptionalInt(draft.seatsStr);
    const engineCcRes = parseStrictOptionalInt(draft.engineCcStr);
    const ownershipRes = parseStrictOptionalInt(draft.ownershipCountStr);
    const priceRes = parseStrictOptionalInt(draft.priceIdrStr);
    const minPriceRes = parseStrictOptionalInt(draft.minPriceIdrStr);
    const maxPriceRes = parseStrictOptionalInt(draft.maxPriceIdrStr);

    if (yearRes.kind !== "ok") {
      parseErrors.year = "Tahun pembuatan harus berupa bilangan bulat positif (mis. 2024).";
    }
    if (draft.condition === "used" && mileageRes.kind === "invalid") {
      parseErrors.mileageKm = "Jarak tempuh harus berupa angka bulat non-negatif tanpa huruf/desimal.";
    }
    if (seatsRes.kind === "invalid") {
      parseErrors.seats = "Kapasitas kursi harus berupa angka bulat positif.";
    }
    if (engineCcRes.kind === "invalid") {
      parseErrors.engineCc = "Kapasitas mesin (cc) harus berupa angka bulat positif.";
    }
    if (draft.condition === "used" && ownershipRes.kind === "invalid") {
      parseErrors.ownershipCount = "Jumlah kepemilikan harus berupa angka bulat 1–10.";
    }
    if ((draft.priceModel === "fixed" || draft.priceModel === "from") && priceRes.kind === "invalid") {
      parseErrors.priceIdr = "Nominal harga harus berupa angka bulat Rupiah tanpa huruf/desimal.";
    }
    if (draft.priceModel === "range") {
      if (minPriceRes.kind === "invalid") {
        parseErrors.minPriceIdr = "Harga minimum harus berupa angka bulat Rupiah.";
      }
      if (maxPriceRes.kind === "invalid") {
        parseErrors.maxPriceIdr = "Harga maksimum harus berupa angka bulat Rupiah.";
      }
    }
    if (draft.creditEnabled) {
      if (parsedRateBpsRes.kind !== "ok") {
        parseErrors["creditEstimate.flatAnnualRateBps"] =
          "Suku bunga flat (bps) wajib berupa angka bulat 0–3000 (contoh: 650 untuk 6,5%).";
      }
      if (!parsedDpPercentsRes.ok) {
        parseErrors["creditEstimate.dpPercents"] =
          "Pilihan DP (%) harus berupa angka bulat dipisahkan koma (mis. 20, 30, 40).";
      }
      if (!parsedTenorsRes.ok) {
        parseErrors["creditEstimate.tenorMonths"] =
          "Pilihan tenor bulan harus berupa angka bulat dipisahkan koma (mis. 12, 24, 36, 48).";
      }
    }

    const payload: Record<string, unknown> = {
      vehicleCategory: draft.vehicleCategory,
      brand: draft.brand.trim(),
      model: draft.model.trim(),
      ...(draft.variant.trim() ? { variant: draft.variant.trim() } : {}),
      year: yearRes.kind === "ok" ? yearRes.value : 0,
      condition: draft.condition,
      ...(draft.condition === "used" && mileageRes.kind === "ok"
        ? { mileageKm: mileageRes.value }
        : {}),
      transmission: draft.transmission,
      fuel: draft.fuel,
      bodyType: draft.bodyType,
      color: draft.color.trim(),
      ...(seatsRes.kind === "ok" ? { seats: seatsRes.value } : {}),
      ...(engineCcRes.kind === "ok" ? { engineCc: engineCcRes.value } : {}),
      location: draft.location.trim(),
      ...(draft.plateRegion.trim() ? { plateRegion: draft.plateRegion.trim() } : {}),
      ...(draft.stnkTaxExpiryDate.trim() ? { stnkTaxExpiryDate: draft.stnkTaxExpiryDate.trim() } : {}),
      ...(draft.condition === "used" && ownershipRes.kind === "ok"
        ? { ownershipCount: ownershipRes.value }
        : {}),
      priceModel: draft.priceModel,
      ...(draft.priceModel === "fixed" || draft.priceModel === "from"
        ? { priceIdr: priceRes.kind === "ok" ? priceRes.value : null }
        : {}),
      ...(draft.priceModel === "range"
        ? {
            minPriceIdr: minPriceRes.kind === "ok" ? minPriceRes.value : null,
            maxPriceIdr: maxPriceRes.kind === "ok" ? maxPriceRes.value : null,
          }
        : {}),
      negotiable: draft.negotiable,
      unitStatus: draft.unitStatus,
      hideSoldInGrids: draft.hideSoldInGrids,
      ...(draft.otrPriceNote.trim() ? { otrPriceNote: draft.otrPriceNote.trim() } : {}),
      ...(draft.salesWhatsappOverride.trim()
        ? { salesWhatsappOverride: draft.salesWhatsappOverride.trim() }
        : {}),
      ...(draft.creditEnabled
        ? {
            creditEstimate: {
              enabled: true,
              flatAnnualRateBps: parsedRateBpsRes.kind === "ok" ? parsedRateBpsRes.value : -1,
              dpPercents: parsedDpPercents,
              tenorMonths: parsedTenors,
            },
          }
        : {}),
    };

    return { payload, parseErrors };
  }

  async function submitAction(action: "save_draft" | "publish") {
    if (readOnly || submitting) return;
    setBanner(null);
    setFieldErrors({});

    const cleanTitle = draft.title.trim();
    if (!cleanTitle) {
      setFieldErrors({ title: "Judul unit kendaraan wajib diisi." });
      setBanner({
        tone: "destructive",
        title: "Periksa kolom wajib",
        message: "Judul unit kendaraan wajib diisi sebelum menyimpan.",
      });
      return;
    }

    const { payload: rawVehicle, parseErrors } = buildVehiclePayloadWithClientCheck();
    if (Object.keys(parseErrors).length > 0) {
      setFieldErrors(parseErrors);
      setBanner({
        tone: "destructive",
        title: "Format angka tidak valid",
        message: Object.values(parseErrors)[0] ?? "Periksa kembali kolom angka yang diisi.",
      });
      return;
    }
    let validated: VehicleShowroomAttributes;
    try {
      validated = validateVehicleShowroomAttributes(rawVehicle);
    } catch (err) {
      if (err instanceof VehicleValidationError) {
        const nextErrors: Record<string, string> = {};
        for (const f of err.fields) {
          nextErrors[f.field] = f.message;
        }
        setFieldErrors(nextErrors);
        setBanner({
          tone: "destructive",
          title: "Validasi atribut kendaraan gagal",
          message: err.message,
        });
        return;
      }
      throw err;
    }

    setSubmitting(true);
    try {
      const saved = await cmsFetchJson<VehicleCatalogItemDto>(
        `/dashboard/${encodeURIComponent(handle)}/catalog/vehicles/api`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            id: draft.id ?? undefined,
            expectedVersion: draft.id !== null ? draft.version : undefined,
            title: cleanTitle,
            summary: draft.summary.trim() || null,
            vehicle: validated,
          }),
        },
      );

      setVehicles((prev) => {
        const exists = prev.some((item) => item.id === saved.id);
        return exists
          ? prev.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...prev];
      });
      setDraft(dtoToDraft(saved));
      setBanner({
        tone: "success",
        title: action === "publish" ? "Unit kendaraan diterbitkan" : "Draf unit tersimpan",
        message:
          action === "publish"
            ? `"${saved.title}" telah dipublikasikan di ${saved.publicPath} (status: ${VEHICLE_UNIT_STATUS_BADGE_LABELS[saved.unitStatus]}).`
            : `Perubahan draf "${saved.title}" berhasil disimpan (versi ${saved.version}).`,
      });
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (err.status === 409) {
          setBanner({
            tone: "warning",
            title: "Konflik versi (409)",
            message:
              "Unit kendaraan ini telah diperbarui oleh sesi lain. Muat ulang halaman agar tidak menimpa perubahan terbaru.",
          });
        } else {
          setBanner({
            tone: "destructive",
            title: `Gagal menyimpan (${err.status})`,
            message: err.message,
          });
        }
      } else {
        setBanner({
          tone: "destructive",
          title: "Gagal terhubung",
          message: "Terjadi gangguan jaringan saat menyimpan data kendaraan. Coba lagi.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6" data-testid="vehicle-showroom-manager">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <a
              href={`${basePath}/catalog`}
              className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
              Kembali ke Katalog
            </a>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Showroom Kendaraan (/kendaraan)
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola unit mobil dan motor, status ketersediaan (TERSEDIA / BOOKED / TERJUAL), serta
            tabel estimasi cicilan statis tanpa JavaScript di halaman publik.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          disabled={readOnly}
          onClick={() => {
            setFieldErrors({});
            setBanner(null);
            setDraft(buildEmptyDraft());
          }}
          data-testid="vehicle-new-unit-btn"
        >
          <PlusIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Unit Baru
        </Button>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {!permissions.isLocked && readOnly && (
        <Alert>
          <LockIcon className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Mode Hanya-Baca</AlertTitle>
          <AlertDescription>
            Peran akun Anda tidak memiliki izin menulis data kendaraan. Hubungi pemilik situs untuk
            perubahan akses.
          </AlertDescription>
        </Alert>
      )}

      {banner && (
        <Alert
          variant={banner.tone === "destructive" ? "destructive" : "default"}
          data-testid="vehicle-manager-banner"
        >
          {banner.tone === "success" ? (
            <CheckCircle2Icon className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ShieldAlertIcon className="h-4 w-4" aria-hidden="true" />
          )}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left column: Vehicle inventory list */}
        <Card className="min-w-0 lg:col-span-4">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CarFrontIcon className="h-4 w-4 text-primary" aria-hidden="true" />
              Daftar Unit ({vehicles.length})
            </CardTitle>
            <CardDescription>
              Pilih unit untuk mengedit spesifikasi, status, atau konfigurasi estimasi cicilan.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {vehicles.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                Belum ada unit kendaraan. Klik <strong>Unit Baru</strong> untuk menambahkan mobil
                atau motor pertama Anda.
              </p>
            ) : (
              vehicles.map((item) => {
                const isSelected = draft.id === item.id;
                const priceLabel = formatVehiclePriceLabel({
                  priceModel: item.priceMode,
                  priceIdr: item.price,
                  minPriceIdr: item.price,
                  maxPriceIdr: item.priceMax,
                  negotiable: item.negotiable,
                });
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setFieldErrors({});
                      setBanner(null);
                      setDraft(dtoToDraft(item));
                    }}
                    className={`flex min-h-[44px] w-full flex-col gap-1.5 rounded-md border p-3 text-left transition-colors ${
                      isSelected
                        ? "border-primary bg-muted/60"
                        : "border-border bg-card hover:bg-muted/30"
                    }`}
                    data-testid={`vehicle-list-item-${item.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <Badge variant={statusBadgeVariant(item.unitStatus)}>
                        {VEHICLE_UNIT_STATUS_BADGE_LABELS[item.unitStatus]}
                      </Badge>
                      <ContentStatusBadge status={item.status} />
                    </div>
                    <span className="text-sm font-semibold text-foreground">{item.title}</span>
                    <span className="text-xs font-medium tabular-nums text-primary">
                      {priceLabel}
                    </span>
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Right column: Full structured vehicle editor */}
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">
                {draft.id !== null ? "Edit Unit Kendaraan" : "Tambah Unit Kendaraan Baru"}
              </CardTitle>
              <CardDescription>
                Atribut mengikuti standar showroom mobil &amp; motor Indonesia. Jarak tempuh (km)
                dan kepemilikan hanya diperbolehkan untuk unit kondisi Bekas.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* Identity */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label htmlFor="vh-title" className="text-sm font-medium text-foreground">
                    Judul Unit (Tampil di Katalog &amp; SEO)
                  </label>
                  <Input
                    id="vh-title"
                    value={draft.title}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ title: e.target.value })}
                    placeholder="Contoh: Toyota Kijang Innova Zenix Q Hybrid 2024"
                    className="min-h-[44px]"
                  />
                  {fieldErrors.title && (
                    <p className="text-xs text-destructive">{fieldErrors.title}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label htmlFor="vh-summary" className="text-sm font-medium text-foreground">
                    Ringkasan Singkat Unit
                  </label>
                  <Input
                    id="vh-summary"
                    value={draft.summary}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ summary: e.target.value })}
                    placeholder="Contoh: Unit tangan pertama, servis rutin bengkel resmi, bebas tabrak & banjir."
                    className="min-h-[44px]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-category" className="text-sm font-medium text-foreground">
                    Kategori Kendaraan
                  </label>
                  <select
                    id="vh-category"
                    value={draft.vehicleCategory}
                    disabled={readOnly}
                    onChange={(e) => handleCategoryChange(e.target.value as VehicleCategory)}
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {VEHICLE_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-condition" className="text-sm font-medium text-foreground">
                    Kondisi Unit
                  </label>
                  <select
                    id="vh-condition"
                    value={draft.condition}
                    disabled={readOnly}
                    onChange={(e) => handleConditionChange(e.target.value as VehicleCondition)}
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_CONDITIONS.map((cond) => (
                      <option key={cond} value={cond}>
                        {VEHICLE_CONDITION_LABELS[cond]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-brand" className="text-sm font-medium text-foreground">
                    Merek
                  </label>
                  <Input
                    id="vh-brand"
                    value={draft.brand}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ brand: e.target.value })}
                    placeholder="Toyota / Honda / Yamaha"
                    className="min-h-[44px]"
                  />
                  {fieldErrors.brand && (
                    <p className="text-xs text-destructive">{fieldErrors.brand}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-model" className="text-sm font-medium text-foreground">
                    Model
                  </label>
                  <Input
                    id="vh-model"
                    value={draft.model}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ model: e.target.value })}
                    placeholder="Innova Zenix / NMAX Turbo"
                    className="min-h-[44px]"
                  />
                  {fieldErrors.model && (
                    <p className="text-xs text-destructive">{fieldErrors.model}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-variant" className="text-sm font-medium text-foreground">
                    Varian / Tipe (Opsional)
                  </label>
                  <Input
                    id="vh-variant"
                    value={draft.variant}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ variant: e.target.value })}
                    placeholder="Q Hybrid Modellista / Tech MAX"
                    className="min-h-[44px]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-year" className="text-sm font-medium text-foreground">
                    Tahun Pembuatan
                  </label>
                  <Input
                    id="vh-year"
                    inputMode="numeric"
                    value={draft.yearStr}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ yearStr: e.target.value })}
                    className="min-h-[44px] tabular-nums"
                  />
                  {fieldErrors.year && (
                    <p className="text-xs text-destructive">{fieldErrors.year}</p>
                  )}
                </div>
              </div>

              <Separator />

              {/* Technical Specs */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-body-type" className="text-sm font-medium text-foreground">
                    Tipe Bodi
                  </label>
                  <select
                    id="vh-body-type"
                    value={draft.bodyType}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ bodyType: e.target.value as VehicleBodyType })}
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {allowedBodyTypes.map((bt) => (
                      <option key={bt} value={bt}>
                        {VEHICLE_BODY_TYPE_LABELS[bt]}
                      </option>
                    ))}
                  </select>
                  {fieldErrors.bodyType && (
                    <p className="text-xs text-destructive">{fieldErrors.bodyType}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-transmission" className="text-sm font-medium text-foreground">
                    Transmisi
                  </label>
                  <select
                    id="vh-transmission"
                    value={draft.transmission}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateDraft({ transmission: e.target.value as VehicleTransmission })
                    }
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_TRANSMISSIONS.map((tr) => (
                      <option key={tr} value={tr}>
                        {VEHICLE_TRANSMISSION_LABELS[tr]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-fuel" className="text-sm font-medium text-foreground">
                    Bahan Bakar
                  </label>
                  <select
                    id="vh-fuel"
                    value={draft.fuel}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ fuel: e.target.value as VehicleFuel })}
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_FUELS.map((fl) => (
                      <option key={fl} value={fl}>
                        {VEHICLE_FUEL_LABELS[fl]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-color" className="text-sm font-medium text-foreground">
                    Warna
                  </label>
                  <Input
                    id="vh-color"
                    value={draft.color}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ color: e.target.value })}
                    placeholder="Putih Mutiara / Hitam Metalik"
                    className="min-h-[44px]"
                  />
                  {fieldErrors.color && (
                    <p className="text-xs text-destructive">{fieldErrors.color}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-mileage" className="text-sm font-medium text-foreground">
                    Jarak Tempuh (km){draft.condition === "used" ? " — Wajib (Bekas)" : " — Tidak berlaku (Baru)"}
                  </label>
                  <Input
                    id="vh-mileage"
                    inputMode="numeric"
                    value={draft.condition === "new" ? "" : draft.mileageKmStr}
                    disabled={readOnly || draft.condition === "new"}
                    onChange={(e) => updateDraft({ mileageKmStr: e.target.value })}
                    placeholder={draft.condition === "new" ? "Kosong untuk unit baru" : "Contoh: 18500"}
                    className="min-h-[44px] tabular-nums"
                  />
                  {fieldErrors.mileageKm && (
                    <p className="text-xs text-destructive">{fieldErrors.mileageKm}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-engine-cc" className="text-sm font-medium text-foreground">
                    Kapasitas Mesin (cc, Opsional untuk EV)
                  </label>
                  <Input
                    id="vh-engine-cc"
                    inputMode="numeric"
                    value={draft.engineCcStr}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ engineCcStr: e.target.value })}
                    placeholder="Contoh: 1496 atau 155"
                    className="min-h-[44px] tabular-nums"
                  />
                </div>

                {draft.vehicleCategory === "car" && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="vh-seats" className="text-sm font-medium text-foreground">
                      Kapasitas Kursi (Penumpang)
                    </label>
                    <Input
                      id="vh-seats"
                      inputMode="numeric"
                      value={draft.seatsStr}
                      disabled={readOnly}
                      onChange={(e) => updateDraft({ seatsStr: e.target.value })}
                      placeholder="Contoh: 7"
                      className="min-h-[44px] tabular-nums"
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-location" className="text-sm font-medium text-foreground">
                    Lokasi Unit / Showroom
                  </label>
                  <Input
                    id="vh-location"
                    value={draft.location}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ location: e.target.value })}
                    placeholder="Contoh: Jakarta Selatan"
                    className="min-h-[44px]"
                  />
                  {fieldErrors.location && (
                    <p className="text-xs text-destructive">{fieldErrors.location}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-plate" className="text-sm font-medium text-foreground">
                    Wilayah Pelat (Opsional)
                  </label>
                  <Input
                    id="vh-plate"
                    value={draft.plateRegion}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ plateRegion: e.target.value })}
                    placeholder="Contoh: B (Jakarta) / D (Bandung)"
                    className="min-h-[44px]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-stnk-date" className="text-sm font-medium text-foreground">
                    Masa Berlaku Pajak STNK (YYYY-MM-DD, Opsional)
                  </label>
                  <Input
                    id="vh-stnk-date"
                    type="date"
                    value={draft.stnkTaxExpiryDate}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ stnkTaxExpiryDate: e.target.value })}
                    className="min-h-[44px] tabular-nums"
                  />
                  {fieldErrors.stnkTaxExpiryDate && (
                    <p className="text-xs text-destructive">{fieldErrors.stnkTaxExpiryDate}</p>
                  )}
                </div>

                {draft.condition === "used" && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="vh-ownership" className="text-sm font-medium text-foreground">
                      Tangan Ke- (1–10, Opsional)
                    </label>
                    <Input
                      id="vh-ownership"
                      inputMode="numeric"
                      value={draft.ownershipCountStr}
                      disabled={readOnly}
                      onChange={(e) => updateDraft({ ownershipCountStr: e.target.value })}
                      placeholder="Contoh: 1"
                      className="min-h-[44px] tabular-nums"
                    />
                  </div>
                )}
              </div>

              <Separator />

              {/* Pricing & Availability Status */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-price-model" className="text-sm font-medium text-foreground">
                    Model Harga
                  </label>
                  <select
                    id="vh-price-model"
                    value={draft.priceModel}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ priceModel: e.target.value as VehiclePriceModel })}
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_PRICE_MODELS.map((pm) => (
                      <option key={pm} value={pm}>
                        {VEHICLE_PRICE_MODEL_LABELS[pm]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-unit-status" className="text-sm font-medium text-foreground">
                    Status Unit Showroom
                  </label>
                  <select
                    id="vh-unit-status"
                    value={draft.unitStatus}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateDraft({ unitStatus: e.target.value as VehicleShowroomUnitStatus })
                    }
                    className="min-h-[44px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {VEHICLE_SHOWROOM_UNIT_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {VEHICLE_UNIT_STATUS_BADGE_LABELS[st]}
                      </option>
                    ))}
                  </select>
                </div>

                {(draft.priceModel === "fixed" || draft.priceModel === "from") && (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="vh-price-idr" className="text-sm font-medium text-foreground">
                      Nominal Harga (Rp)
                    </label>
                    <Input
                      id="vh-price-idr"
                      inputMode="numeric"
                      value={draft.priceIdrStr}
                      disabled={readOnly}
                      onChange={(e) => updateDraft({ priceIdrStr: e.target.value })}
                      placeholder="Contoh: 285000000"
                      className="min-h-[44px] tabular-nums"
                    />
                    {fieldErrors.priceIdr && (
                      <p className="text-xs text-destructive">{fieldErrors.priceIdr}</p>
                    )}
                  </div>
                )}

                {draft.priceModel === "range" && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="vh-min-price" className="text-sm font-medium text-foreground">
                        Harga Minimum (Rp)
                      </label>
                      <Input
                        id="vh-min-price"
                        inputMode="numeric"
                        value={draft.minPriceIdrStr}
                        disabled={readOnly}
                        onChange={(e) => updateDraft({ minPriceIdrStr: e.target.value })}
                        placeholder="Contoh: 250000000"
                        className="min-h-[44px] tabular-nums"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="vh-max-price" className="text-sm font-medium text-foreground">
                        Harga Maksimum (Rp)
                      </label>
                      <Input
                        id="vh-max-price"
                        inputMode="numeric"
                        value={draft.maxPriceIdrStr}
                        disabled={readOnly}
                        onChange={(e) => updateDraft({ maxPriceIdrStr: e.target.value })}
                        placeholder="Contoh: 295000000"
                        className="min-h-[44px] tabular-nums"
                      />
                      {fieldErrors.maxPriceIdr && (
                        <p className="text-xs text-destructive">{fieldErrors.maxPriceIdr}</p>
                      )}
                    </div>
                  </>
                )}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="vh-wa-override" className="text-sm font-medium text-foreground">
                    Nomor WhatsApp Sales Khusus (Opsional)
                  </label>
                  <Input
                    id="vh-wa-override"
                    value={draft.salesWhatsappOverride}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ salesWhatsappOverride: e.target.value })}
                    placeholder="Contoh: 0812-3456-7890"
                    className="min-h-[44px] tabular-nums"
                  />
                  {fieldErrors.salesWhatsappOverride && (
                    <p className="text-xs text-destructive">{fieldErrors.salesWhatsappOverride}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label htmlFor="vh-otr-note" className="text-sm font-medium text-foreground">
                    Catatan Harga OTR / Kelengkapan Surat (Opsional)
                  </label>
                  <Input
                    id="vh-otr-note"
                    value={draft.otrPriceNote}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ otrPriceNote: e.target.value })}
                    placeholder="Contoh: Harga OTR Jakarta, BPKB & faktur lengkap siap balik nama."
                    className="min-h-[44px]"
                  />
                </div>

                <div className="flex items-center gap-2.5 pt-1">
                  <input
                    id="vh-negotiable"
                    type="checkbox"
                    checked={draft.negotiable}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ negotiable: e.target.checked })}
                    className="h-5 w-5 rounded border-input accent-primary"
                  />
                  <label htmlFor="vh-negotiable" className="text-sm text-foreground">
                    Tandai harga bisa nego (Nego)
                  </label>
                </div>

                <div className="flex items-center gap-2.5 pt-1">
                  <input
                    id="vh-hide-sold"
                    type="checkbox"
                    checked={draft.hideSoldInGrids}
                    disabled={readOnly}
                    onChange={(e) => updateDraft({ hideSoldInGrids: e.target.checked })}
                    className="h-5 w-5 rounded border-input accent-primary"
                  />
                  <label htmlFor="vh-hide-sold" className="text-sm text-foreground">
                    Sembunyikan dari grid jika berstatus TERJUAL (halaman detail tetap aktif &amp;
                    terindeks)
                  </label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Static Credit-Estimate Table Config & Server-Parity Preview */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CalculatorIcon className="h-4 w-4 text-primary" aria-hidden="true" />
                Tabel Estimasi Cicilan Statis (Server-Rendered, 0 JS)
              </CardTitle>
              <CardDescription>
                Maksimal {MAX_CREDIT_DP_OPTIONS} pilihan DP (%) dan {MAX_CREDIT_TENOR_OPTIONS}{" "}
                pilihan tenor (bulan) dengan satu suku bunga flat tahunan. Di halaman publik, tabel
                HANYA tampil untuk unit <strong>Terbit + TERSEDIA + Harga Pasti</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <input
                  id="vh-credit-enabled"
                  type="checkbox"
                  checked={draft.creditEnabled}
                  disabled={readOnly}
                  onChange={(e) => updateDraft({ creditEnabled: e.target.checked })}
                  className="h-5 w-5 rounded border-input accent-primary"
                />
                <label htmlFor="vh-credit-enabled" className="text-sm font-medium text-foreground">
                  Aktifkan tabel estimasi cicilan statis pada halaman detail unit
                </label>
              </div>

              {draft.creditEnabled && (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="vh-rate-bps" className="text-sm font-medium text-foreground">
                        Suku Bunga Flat (bps / tahun)
                      </label>
                      <Input
                        id="vh-rate-bps"
                        inputMode="numeric"
                        value={draft.flatAnnualRateBpsStr}
                        disabled={readOnly}
                        onChange={(e) => updateDraft({ flatAnnualRateBpsStr: e.target.value })}
                        placeholder="650 = 6,5%"
                        className="min-h-[44px] tabular-nums"
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {parsedRateBps !== null
                          ? `Setara ${formatFlatAnnualRateBpsLabel(parsedRateBps)} / tahun (0–3000 bps)`
                          : "Isi angka bulat 0–3000 bps (contoh: 650 = 6,5%)"}
                      </span>
                      {fieldErrors["creditEstimate.flatAnnualRateBps"] && (
                        <p className="text-xs text-destructive">
                          {fieldErrors["creditEstimate.flatAnnualRateBps"]}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="vh-dp-list" className="text-sm font-medium text-foreground">
                        Pilihan DP % (maks. 3, pisah koma)
                      </label>
                      <Input
                        id="vh-dp-list"
                        value={draft.dpPercentsCsv}
                        disabled={readOnly}
                        onChange={(e) => updateDraft({ dpPercentsCsv: e.target.value })}
                        placeholder="20, 30, 40"
                        className="min-h-[44px] tabular-nums"
                      />
                      {fieldErrors["creditEstimate.dpPercents"] && (
                        <p className="text-xs text-destructive">
                          {fieldErrors["creditEstimate.dpPercents"]}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="vh-tenor-list" className="text-sm font-medium text-foreground">
                        Pilihan Tenor Bulan (maks. 4)
                      </label>
                      <Input
                        id="vh-tenor-list"
                        value={draft.tenorMonthsCsv}
                        disabled={readOnly}
                        onChange={(e) => updateDraft({ tenorMonthsCsv: e.target.value })}
                        placeholder="12, 24, 36, 48"
                        className="min-h-[44px] tabular-nums"
                      />
                      {fieldErrors["creditEstimate.tenorMonths"] && (
                        <p className="text-xs text-destructive">
                          {fieldErrors["creditEstimate.tenorMonths"]}
                        </p>
                      )}
                    </div>
                  </div>

                  {!willRenderPublicCreditTable && (
                    <Alert data-testid="vehicle-credit-hidden-notice">
                      <InfoIcon className="h-4 w-4" aria-hidden="true" />
                      <AlertTitle>Tabel Estimasi Disembunyikan di Halaman Publik</AlertTitle>
                      <AlertDescription>
                        Tabel estimasi cicilan hanya tampil di halaman publik jika unit berstatus{" "}
                        <strong>TERSEDIA</strong> dan menggunakan model harga{" "}
                        <strong>Harga Pasti (fixed)</strong>. Saat ini unit berstatus{" "}
                        <strong>{VEHICLE_UNIT_STATUS_BADGE_LABELS[draft.unitStatus]}</strong>{" "}
                        dengan model harga{" "}
                        <strong>{VEHICLE_PRICE_MODEL_LABELS[draft.priceModel]}</strong>.
                      </AlertDescription>
                    </Alert>
                  )}

                  {liveCreditPreview && (
                    <div className="flex flex-col gap-2" data-testid="vehicle-credit-preview">
                      <p className="text-xs font-medium text-muted-foreground">
                        Pratinjau Perhitungan Integer (round_half_up) — Bunga{" "}
                        {liveCreditPreview.flatAnnualRateLabel}
                      </p>
                      <div className="w-full overflow-x-auto rounded-md border border-border">
                        <table className="w-full border-collapse text-left text-xs tabular-nums">
                          <thead>
                            <tr className="border-b border-border bg-muted/60">
                              <th className="px-3 py-2 font-semibold text-foreground">Uang Muka (DP)</th>
                              {liveCreditPreview.tenorMonths.map((t) => (
                                <th key={t} className="whitespace-nowrap px-3 py-2 font-semibold text-foreground">
                                  {t} Bln
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {liveCreditPreview.rows.map((row) => (
                              <tr key={row.dpPercent} className="border-b border-border last:border-0">
                                <td className="whitespace-nowrap px-3 py-2 font-medium text-foreground">
                                  {row.dpLabel}
                                </td>
                                {row.installments.map((cell) => (
                                  <td key={cell.tenorMonths} className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                    {cell.monthlyLabel}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {VEHICLE_CREDIT_DISCLAIMER}
                      </p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Action Bar */}
          <div className="flex flex-wrap items-center justify-end gap-3 rounded-lg border border-border bg-card p-4">
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={readOnly || submitting}
              onClick={() => submitAction("save_draft")}
              data-testid="vehicle-save-draft-btn"
            >
              <SaveIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Simpan Draf
            </Button>

            {canPublishVehicles && (
              <Button
                type="button"
                className="min-h-[44px]"
                disabled={readOnly || submitting}
                onClick={() => submitAction("publish")}
                data-testid="vehicle-publish-btn"
              >
                <GlobeIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Terbitkan ke Showroom
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
