import { useCallback, useMemo, useState } from "react";
import type { OutletWeekdayKey } from "@punyasitus/core/schema-generator";
import {
  buildOutletDirectionsUrl,
  DEFAULT_OUTLET_TIMEZONE,
  formatOutletFullAddress,
  MAX_OUTLET_HOLIDAY_ENTRIES,
  MAX_OUTLETS_PER_TENANT,
  OUTLET_TIMEZONE_LABELS_ID,
  OUTLET_TIMEZONES,
  OUTLET_WEEKDAY_LABELS_ID,
  OUTLET_WEEKDAYS,
  slugifyOutletName,
  type OutletHolidayHoursEntry,
  type OutletListAdminDto,
  type OutletRecord,
  type OutletStatus,
  type OutletWeeklyHoursEntry,
} from "@punyasitus/db/outlets/index";
import {
  Building2Icon,
  CalendarIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  MapPinIcon,
  MessageCircleIcon,
  NavigationIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  fieldErrorsToMap,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
  useDirtyNavigationGuard,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export interface OutletsManagerClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly canManageOutlets: boolean;
  readonly initialData: OutletListAdminDto;
}

interface WeeklyRowState {
  readonly day: OutletWeekdayKey;
  readonly open: string;
  readonly close: string;
  readonly closed: boolean;
}

interface HolidayRowState {
  readonly key: string;
  readonly date: string;
  readonly label: string;
  readonly open: string;
  readonly close: string;
  readonly closed: boolean;
}

interface OutletFormState {
  readonly name: string;
  readonly slug: string;
  readonly slugManuallyEdited: boolean;
  readonly address: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly whatsappE164: string;
  readonly mapsUrl: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly timezone: string;
  readonly sortOrder: string;
  readonly status: OutletStatus;
  readonly active: boolean;
  readonly isPrimary: boolean;
  readonly weeklyHours: readonly WeeklyRowState[];
  readonly holidayHours: readonly HolidayRowState[];
}

function defaultWeeklyRows(): WeeklyRowState[] {
  return OUTLET_WEEKDAYS.map((day) => ({
    day,
    open: day === "sunday" ? "09:00" : "08:00",
    close: day === "sunday" ? "18:00" : "21:00",
    closed: day === "sunday",
  }));
}

function createEmptyForm(): OutletFormState {
  return {
    name: "",
    slug: "",
    slugManuallyEdited: false,
    address: "",
    city: "",
    province: "",
    postalCode: "",
    phone: "",
    whatsappE164: "",
    mapsUrl: "",
    latitude: "",
    longitude: "",
    timezone: DEFAULT_OUTLET_TIMEZONE,
    sortOrder: "0",
    status: "published",
    active: true,
    isPrimary: false,
    weeklyHours: defaultWeeklyRows(),
    holidayHours: [],
  };
}

function outletToFormState(outlet: OutletRecord): OutletFormState {
  const weeklyMap = new Map(outlet.weeklyHours.map((w) => [w.day, w]));
  const weeklyHours: WeeklyRowState[] = OUTLET_WEEKDAYS.map((day) => {
    const found = weeklyMap.get(day);
    if (!found) {
      return { day, open: "08:00", close: "21:00", closed: true };
    }
    return {
      day,
      open: found.open ?? "08:00",
      close: found.close ?? "21:00",
      closed: found.closed,
    };
  });

  const holidayHours: HolidayRowState[] = outlet.holidayHours.map((h, i) => ({
    key: `${h.date}-${i}`,
    date: h.date,
    label: h.label,
    open: h.open ?? "09:00",
    close: h.close ?? "17:00",
    closed: h.closed,
  }));

  return {
    name: outlet.name,
    slug: outlet.slug,
    slugManuallyEdited: true,
    address: outlet.address,
    city: outlet.city ?? "",
    province: outlet.province ?? "",
    postalCode: outlet.postalCode ?? "",
    phone: outlet.phone ?? "",
    whatsappE164: outlet.whatsappE164 ?? "",
    mapsUrl: outlet.mapsUrl ?? "",
    latitude: outlet.latitude !== null ? String(outlet.latitude) : "",
    longitude: outlet.longitude !== null ? String(outlet.longitude) : "",
    timezone: outlet.timezone || DEFAULT_OUTLET_TIMEZONE,
    sortOrder: String(outlet.sortOrder ?? 0),
    status: outlet.status,
    active: outlet.active,
    isPrimary: outlet.isPrimary,
    weeklyHours,
    holidayHours,
  };
}

function parseCoordinateField(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return "invalid";
  return num;
}

export function OutletsManagerClient({
  handle,
  basePath,
  permissions,
  canManageOutlets,
  initialData,
}: OutletsManagerClientProps) {
  const [outlets, setOutlets] = useState<OutletRecord[]>(() => [...initialData.items]);
  const [editorMode, setEditorMode] = useState<"closed" | "create" | "edit">("closed");
  const [editingOutlet, setEditingOutlet] = useState<OutletRecord | null>(null);
  const [form, setForm] = useState<OutletFormState>(createEmptyForm);
  const [isDirty, setIsDirty] = useState(false);

  const [isReloading, setIsReloading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyOutletId, setBusyOutletId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OutletRecord | null>(null);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  useDirtyNavigationGuard(isDirty);

  const apiBase = useMemo(
    () => `/api/tenants/${encodeURIComponent(handle)}/outlets`,
    [handle],
  );

  const isLimitReached = outlets.length >= MAX_OUTLETS_PER_TENANT;
  const remainingSlots = Math.max(0, MAX_OUTLETS_PER_TENANT - outlets.length);
  const isEditorReadOnly = !canManageOutlets && !permissions.isLocked;

  const directionsPreviewUrl = useMemo(() => {
    const lat = parseCoordinateField(form.latitude);
    const lng = parseCoordinateField(form.longitude);
    return buildOutletDirectionsUrl({
      mapsUrl: form.mapsUrl.trim() || null,
      latitude: typeof lat === "number" ? lat : null,
      longitude: typeof lng === "number" ? lng : null,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      province: form.province.trim() || null,
      postalCode: form.postalCode.trim() || null,
    });
  }, [form.address, form.city, form.latitude, form.longitude, form.mapsUrl, form.postalCode, form.province]);

  const reloadOutlets = useCallback(async () => {
    setIsReloading(true);
    try {
      const latest = await cmsFetchJson<OutletListAdminDto>(apiBase);
      setOutlets([...latest.items]);
      setStaleMessage(null);
      setBannerError(null);
      setFieldErrors({});
      if (editingOutlet) {
        const refreshed = latest.items.find((o) => o.id === editingOutlet.id) ?? null;
        if (refreshed) {
          setEditingOutlet(refreshed);
          setForm(outletToFormState(refreshed));
          setIsDirty(false);
        } else {
          setEditorMode("closed");
          setEditingOutlet(null);
          setIsDirty(false);
        }
      }
    } catch (err) {
      setBannerError(
        err instanceof Error ? err.message : "Gagal memuat ulang daftar gerai.",
      );
    } finally {
      setIsReloading(false);
    }
  }, [apiBase, editingOutlet]);

  const openCreateForm = useCallback(() => {
    if (!canManageOutlets || isLimitReached) return;
    setEditingOutlet(null);
    setForm({
      ...createEmptyForm(),
      sortOrder: String(outlets.length),
      isPrimary: outlets.length === 0,
    });
    setEditorMode("create");
    setFieldErrors({});
    setBannerError(null);
    setBannerSuccess(null);
    setStaleMessage(null);
    setIsDirty(false);
  }, [canManageOutlets, isLimitReached, outlets.length]);

  const openEditForm = useCallback(
    (outlet: OutletRecord) => {
      if (!canManageOutlets) return;
      setEditingOutlet(outlet);
      setForm(outletToFormState(outlet));
      setEditorMode("edit");
      setFieldErrors({});
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);
      setIsDirty(false);
    },
    [canManageOutlets],
  );

  const closeEditor = useCallback(() => {
    setEditorMode("closed");
    setEditingOutlet(null);
    setFieldErrors({});
    setStaleMessage(null);
    setIsDirty(false);
  }, []);

  const updateForm = useCallback((patch: Partial<OutletFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setIsDirty(true);
  }, []);

  const updateWeeklyRow = useCallback(
    (day: OutletWeekdayKey, patch: Partial<WeeklyRowState>) => {
      setForm((prev) => ({
        ...prev,
        weeklyHours: prev.weeklyHours.map((row) =>
          row.day === day ? { ...row, ...patch } : row,
        ),
      }));
      setIsDirty(true);
    },
    [],
  );

  const applyMondayToWeekdays = useCallback(() => {
    setForm((prev) => {
      const monday = prev.weeklyHours.find((r) => r.day === "monday");
      if (!monday) return prev;
      const weekdays = new Set<OutletWeekdayKey>([
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
      ]);
      return {
        ...prev,
        weeklyHours: prev.weeklyHours.map((row) =>
          weekdays.has(row.day)
            ? { ...row, open: monday.open, close: monday.close, closed: monday.closed }
            : row,
        ),
      };
    });
    setIsDirty(true);
  }, []);

  const addHolidayRow = useCallback(() => {
    setForm((prev) => {
      if (prev.holidayHours.length >= MAX_OUTLET_HOLIDAY_ENTRIES) return prev;
      return {
        ...prev,
        holidayHours: [
          ...prev.holidayHours,
          {
            key: `holiday-${Date.now()}-${prev.holidayHours.length}`,
            date: "",
            label: "",
            open: "09:00",
            close: "17:00",
            closed: true,
          },
        ],
      };
    });
    setIsDirty(true);
  }, []);

  const updateHolidayRow = useCallback((key: string, patch: Partial<HolidayRowState>) => {
    setForm((prev) => ({
      ...prev,
      holidayHours: prev.holidayHours.map((row) =>
        row.key === key ? { ...row, ...patch } : row,
      ),
    }));
    setIsDirty(true);
  }, []);

  const removeHolidayRow = useCallback((key: string) => {
    setForm((prev) => ({
      ...prev,
      holidayHours: prev.holidayHours.filter((row) => row.key !== key),
    }));
    setIsDirty(true);
  }, []);

  const handleSubmit = useCallback(
    async (event: { preventDefault(): void }) => {
      event.preventDefault();
      if (!canManageOutlets) return;

      const localErrors: Record<string, string> = {};
      if (!form.name.trim()) {
        localErrors.name = "Nama gerai wajib diisi.";
      }
      if (!form.address.trim()) {
        localErrors.address = "Alamat gerai wajib diisi.";
      }
      const parsedLat = parseCoordinateField(form.latitude);
      const parsedLng = parseCoordinateField(form.longitude);
      if (parsedLat === "invalid" || (typeof parsedLat === "number" && (parsedLat < -90 || parsedLat > 90))) {
        localErrors.latitude = "Latitude harus berupa angka valid antara -90 hingga 90.";
      }
      if (parsedLng === "invalid" || (typeof parsedLng === "number" && (parsedLng < -180 || parsedLng > 180))) {
        localErrors.longitude = "Longitude harus berupa angka valid antara -180 hingga 180.";
      }
      if ((parsedLat !== null && parsedLng === null) || (parsedLat === null && parsedLng !== null)) {
        localErrors.latitude = localErrors.latitude ?? "Isi latitude dan longitude bersamaan.";
        localErrors.longitude = localErrors.longitude ?? "Isi latitude dan longitude bersamaan.";
      }

      const sortOrderNum = Number(form.sortOrder.trim() || "0");
      if (!Number.isInteger(sortOrderNum) || sortOrderNum < 0 || sortOrderNum > 100) {
        localErrors.sortOrder = "Urutan tampil harus bilangan bulat antara 0 hingga 100.";
      }

      if (Object.keys(localErrors).length > 0) {
        setFieldErrors(localErrors);
        setBannerError("Periksa kembali kolom yang masih belum valid.");
        return;
      }

      const weeklyPayload: OutletWeeklyHoursEntry[] = form.weeklyHours.map((row) => ({
        day: row.day,
        open: row.closed ? null : row.open.trim(),
        close: row.closed ? null : row.close.trim(),
        closed: row.closed,
      }));

      const holidayPayload: OutletHolidayHoursEntry[] = form.holidayHours.map((row) => ({
        date: row.date.trim(),
        label: row.label.trim(),
        open: row.closed ? null : row.open.trim(),
        close: row.closed ? null : row.close.trim(),
        closed: row.closed,
      }));

      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        slug: form.slug.trim() || slugifyOutletName(form.name),
        address: form.address.trim(),
        city: form.city.trim() || null,
        province: form.province.trim() || null,
        postalCode: form.postalCode.trim() || null,
        phone: form.phone.trim() || null,
        whatsappE164: form.whatsappE164.trim() || null,
        mapsUrl: form.mapsUrl.trim() || null,
        latitude: typeof parsedLat === "number" ? parsedLat : null,
        longitude: typeof parsedLng === "number" ? parsedLng : null,
        weeklyHours: weeklyPayload,
        holidayHours: holidayPayload,
        timezone: form.timezone || DEFAULT_OUTLET_TIMEZONE,
        sortOrder: sortOrderNum,
        status: form.status,
        active: form.active,
        isPrimary: form.isPrimary,
      };

      setIsSubmitting(true);
      setFieldErrors({});
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);

      try {
        if (editorMode === "create") {
          const created = await cmsFetchJson<OutletRecord>(apiBase, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          setOutlets((prev) => [...prev, created].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id - b.id));
          setBannerSuccess(`Gerai "${created.name}" berhasil ditambahkan.`);
          setEditorMode("closed");
          setEditingOutlet(null);
          setIsDirty(false);
        } else if (editorMode === "edit" && editingOutlet) {
          const updated = await cmsFetchJson<OutletRecord>(
            `${apiBase}/${editingOutlet.id}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                ...payload,
                expectedVersion: editingOutlet.version,
              }),
            },
          );
          setOutlets((prev) =>
            prev
              .map((o) =>
                o.id === updated.id
                  ? updated
                  : updated.isPrimary && o.isPrimary
                    ? { ...o, isPrimary: false }
                    : o,
              )
              .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id - b.id),
          );
          setBannerSuccess(`Gerai "${updated.name}" berhasil diperbarui.`);
          setEditorMode("closed");
          setEditingOutlet(null);
          setIsDirty(false);
        }
      } catch (err) {
        if (err instanceof CmsApiError) {
          if (err.status === 409) {
            setStaleMessage(err.message);
          } else {
            const mapped = fieldErrorsToMap(err.fields);
            if (Object.keys(mapped).length > 0) setFieldErrors(mapped);
            setBannerError(err.message);
          }
        } else {
          setBannerError("Gagal menyimpan data gerai. Silakan coba lagi.");
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [apiBase, canManageOutlets, editingOutlet, editorMode, form],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || !canManageOutlets) return;
    setBusyOutletId(deleteTarget.id);
    setBannerError(null);
    setBannerSuccess(null);
    setStaleMessage(null);
    try {
      await cmsFetchJson(`${apiBase}/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: deleteTarget.version }),
      });
      setOutlets((prev) => prev.filter((o) => o.id !== deleteTarget.id));
      if (editingOutlet?.id === deleteTarget.id) {
        setEditorMode("closed");
        setEditingOutlet(null);
        setIsDirty(false);
      }
      setBannerSuccess(`Gerai "${deleteTarget.name}" telah dihapus.`);
      setDeleteTarget(null);
    } catch (err) {
      if (err instanceof CmsApiError && err.status === 409) {
        setStaleMessage(err.message);
      } else {
        setBannerError(err instanceof Error ? err.message : "Gagal menghapus gerai.");
      }
      setDeleteTarget(null);
    } finally {
      setBusyOutletId(null);
    }
  }, [apiBase, canManageOutlets, deleteTarget, editingOutlet]);

  return (
    <div className="space-y-6 pb-8" data-testid="outlets-manager-root">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Direktori Gerai &amp; Peta
            </h1>
            <Badge variant="outline" data-testid="outlets-slot-counter">
              {outlets.length} / {MAX_OUTLETS_PER_TENANT} gerai
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Kelola jadwal operasional mingguan, jadwal hari libur, koordinat peta, dan tautan
            petunjuk arah untuk setiap gerai offline Anda.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void reloadOutlets()}
            disabled={isReloading}
            data-testid="outlets-reload-btn"
          >
            <RefreshCwIcon className={isReloading ? "size-4 animate-spin" : "size-4"} />
            Muat ulang
          </Button>
          {canManageOutlets && (
            <Button
              type="button"
              className="min-h-11"
              onClick={openCreateForm}
              disabled={isLimitReached}
              data-testid="outlets-add-btn"
            >
              <PlusIcon className="size-4" />
              Tambah Gerai
            </Button>
          )}
        </div>
      </div>

      {/* Lifecycle & RBAC Banners */}
      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {isEditorReadOnly && (
        <Alert variant="info" data-testid="outlets-readonly-banner">
          <ShieldAlertIcon className="size-4" />
          <AlertTitle>Mode Baca Saja</AlertTitle>
          <AlertDescription>
            Peran {permissions.roleLabel} hanya dapat melihat daftar gerai. Hubungi Pemilik Situs
            atau Admin untuk menambah, mengubah, atau menghapus gerai.
          </AlertDescription>
        </Alert>
      )}

      {staleMessage && (
        <StaleWriteRecoveryBanner
          message={staleMessage}
          onReloadLatest={() => void reloadOutlets()}
          reloading={isReloading}
        />
      )}

      {bannerError && (
        <Alert variant="destructive" data-testid="outlets-error-banner">
          <ShieldAlertIcon className="size-4" />
          <AlertTitle>Terjadi kendala</AlertTitle>
          <AlertDescription>{bannerError}</AlertDescription>
        </Alert>
      )}

      {bannerSuccess && (
        <Alert variant="success" data-testid="outlets-success-banner">
          <CheckCircle2Icon className="size-4" />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{bannerSuccess}</AlertDescription>
        </Alert>
      )}

      {isLimitReached && canManageOutlets && (
        <Alert variant="warning" data-testid="outlets-limit-banner">
          <Building2Icon className="size-4" />
          <AlertTitle>Batas maksimal gerai tercapai</AlertTitle>
          <AlertDescription>
            Situs ini telah mencapai batas {MAX_OUTLETS_PER_TENANT} gerai aktif/draf. Hapus salah
            satu gerai untuk menambahkan lokasi baru.
          </AlertDescription>
        </Alert>
      )}

      {/* Editor Form */}
      {editorMode !== "closed" && canManageOutlets && (
        <Card data-testid="outlet-editor-card">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>
                {editorMode === "create"
                  ? "Tambah Gerai Baru"
                  : `Edit Gerai: ${editingOutlet?.name ?? ""}`}
              </CardTitle>
              <CardDescription>
                Fakta lokasi yang dipublikasikan akan tampil di direktori gerai dan data terstruktur
                LocalBusiness situs Anda.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              onClick={closeEditor}
              aria-label="Tutup formulir gerai"
              data-testid="outlet-editor-close-btn"
            >
              <XIcon className="size-4" />
            </Button>
          </CardHeader>

          <CardContent>
            <form
              onSubmit={(e) => void handleSubmit(e)}
              className="space-y-6"
              data-testid="outlet-editor-form"
              noValidate
            >
              {/* Basic Identity */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="outlet-name" className="text-sm font-medium text-foreground">
                    Nama Gerai <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="outlet-name"
                    name="name"
                    value={form.name}
                    onChange={(e) => {
                      const nextName = e.target.value;
                      updateForm({
                        name: nextName,
                        ...(!form.slugManuallyEdited
                          ? { slug: slugifyOutletName(nextName) }
                          : {}),
                      });
                    }}
                    placeholder="Contoh: Gerai Jakarta Kemang"
                    aria-invalid={Boolean(fieldErrors.name)}
                    className="min-h-11"
                    data-testid="outlet-input-name"
                  />
                  <InlineFieldError message={fieldErrors.name} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-slug" className="text-sm font-medium text-foreground">
                    Slug Gerai
                  </label>
                  <Input
                    id="outlet-slug"
                    name="slug"
                    value={form.slug}
                    onChange={(e) =>
                      updateForm({ slug: e.target.value.toLowerCase(), slugManuallyEdited: true })
                    }
                    placeholder="gerai-jakarta-kemang"
                    aria-invalid={Boolean(fieldErrors.slug)}
                    className="min-h-11 font-mono text-sm"
                    data-testid="outlet-input-slug"
                  />
                  <InlineFieldError message={fieldErrors.slug} />
                </div>
              </div>

              {/* Address */}
              <div className="space-y-1.5">
                <label htmlFor="outlet-address" className="text-sm font-medium text-foreground">
                  Alamat Lengkap <span className="text-destructive">*</span>
                </label>
                <Input
                  id="outlet-address"
                  name="address"
                  value={form.address}
                  onChange={(e) => updateForm({ address: e.target.value })}
                  placeholder="Jl. Kemang Raya No. 12, Bangka, Mampang Prapatan"
                  aria-invalid={Boolean(fieldErrors.address)}
                  className="min-h-11"
                  data-testid="outlet-input-address"
                />
                <InlineFieldError message={fieldErrors.address} />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label htmlFor="outlet-city" className="text-sm font-medium text-foreground">
                    Kota / Kabupaten
                  </label>
                  <Input
                    id="outlet-city"
                    value={form.city}
                    onChange={(e) => updateForm({ city: e.target.value })}
                    placeholder="Jakarta Selatan"
                    className="min-h-11"
                    data-testid="outlet-input-city"
                  />
                  <InlineFieldError message={fieldErrors.city} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-province" className="text-sm font-medium text-foreground">
                    Provinsi
                  </label>
                  <Input
                    id="outlet-province"
                    value={form.province}
                    onChange={(e) => updateForm({ province: e.target.value })}
                    placeholder="DKI Jakarta"
                    className="min-h-11"
                    data-testid="outlet-input-province"
                  />
                  <InlineFieldError message={fieldErrors.province} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-postal" className="text-sm font-medium text-foreground">
                    Kode Pos
                  </label>
                  <Input
                    id="outlet-postal"
                    value={form.postalCode}
                    onChange={(e) => updateForm({ postalCode: e.target.value })}
                    placeholder="12730"
                    className="min-h-11"
                    data-testid="outlet-input-postalCode"
                  />
                  <InlineFieldError message={fieldErrors.postalCode} />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="outlet-phone" className="text-sm font-medium text-foreground">
                    Telepon Gerai (E.164 / lokal)
                  </label>
                  <Input
                    id="outlet-phone"
                    value={form.phone}
                    onChange={(e) => updateForm({ phone: e.target.value })}
                    placeholder="+62217191234 atau 021-7191234"
                    aria-invalid={Boolean(fieldErrors.phone)}
                    className="min-h-11"
                    data-testid="outlet-input-phone"
                  />
                  <InlineFieldError message={fieldErrors.phone} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-whatsapp" className="text-sm font-medium text-foreground">
                    WhatsApp Gerai (E.164)
                  </label>
                  <Input
                    id="outlet-whatsapp"
                    value={form.whatsappE164}
                    onChange={(e) => updateForm({ whatsappE164: e.target.value })}
                    placeholder="+6281234567890 atau 081234567890"
                    aria-invalid={Boolean(fieldErrors.whatsappE164)}
                    className="min-h-11"
                    data-testid="outlet-input-whatsapp"
                  />
                  <InlineFieldError message={fieldErrors.whatsappE164} />
                </div>
              </div>

              <Separator />

              {/* Coordinates & Directions */}
              <div className="space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    Koordinat Peta &amp; Petunjuk Arah
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Peta interaktif pada situs publik hanya akan dimuat setelah pengunjung memberi
                    izin privasi Peta. Tautan petunjuk arah selalu tersedia tanpa JavaScript.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <label htmlFor="outlet-lat" className="text-sm font-medium text-foreground">
                      Latitude (-90 s.d. 90)
                    </label>
                    <Input
                      id="outlet-lat"
                      type="number"
                      step="any"
                      value={form.latitude}
                      onChange={(e) => updateForm({ latitude: e.target.value })}
                      placeholder="-6.2607"
                      aria-invalid={Boolean(fieldErrors.latitude)}
                      className="min-h-11"
                      data-testid="outlet-input-latitude"
                    />
                    <InlineFieldError message={fieldErrors.latitude} />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="outlet-lng" className="text-sm font-medium text-foreground">
                      Longitude (-180 s.d. 180)
                    </label>
                    <Input
                      id="outlet-lng"
                      type="number"
                      step="any"
                      value={form.longitude}
                      onChange={(e) => updateForm({ longitude: e.target.value })}
                      placeholder="106.8133"
                      aria-invalid={Boolean(fieldErrors.longitude)}
                      className="min-h-11"
                      data-testid="outlet-input-longitude"
                    />
                    <InlineFieldError message={fieldErrors.longitude} />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="outlet-tz" className="text-sm font-medium text-foreground">
                      Zona Waktu
                    </label>
                    <select
                      id="outlet-tz"
                      value={form.timezone}
                      onChange={(e) => updateForm({ timezone: e.target.value })}
                      className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      data-testid="outlet-select-timezone"
                    >
                      {OUTLET_TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {OUTLET_TIMEZONE_LABELS_ID[tz] ?? tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-mapsUrl" className="text-sm font-medium text-foreground">
                    Tautan Google Maps Khusus (Opsional)
                  </label>
                  <Input
                    id="outlet-mapsUrl"
                    value={form.mapsUrl}
                    onChange={(e) => updateForm({ mapsUrl: e.target.value })}
                    placeholder="https://www.google.com/maps/dir/?api=1&destination=-6.2607,106.8133"
                    aria-invalid={Boolean(fieldErrors.mapsUrl)}
                    className="min-h-11"
                    data-testid="outlet-input-mapsUrl"
                  />
                  <InlineFieldError message={fieldErrors.mapsUrl} />
                </div>

                {directionsPreviewUrl && (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs"
                    data-testid="outlet-directions-preview"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-medium text-foreground">Pratinjau Tautan Petunjuk Arah</p>
                      <p className="truncate font-mono text-muted-foreground">
                        {directionsPreviewUrl}
                      </p>
                    </div>
                    <a
                      href={directionsPreviewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-card px-3 font-medium text-primary hover:underline"
                    >
                      <NavigationIcon className="size-3.5" />
                      Uji Tautan
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  </div>
                )}
              </div>

              <Separator />

              {/* Weekly Operating Hours Editor */}
              <div className="space-y-3" data-testid="outlet-weekly-hours-editor">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      Jam Operasional Mingguan
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Atur jam buka dan tutup dari Senin hingga Minggu.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={applyMondayToWeekdays}
                    data-testid="outlet-copy-monday-btn"
                  >
                    Samakan Senin–Jumat
                  </Button>
                </div>

                <div className="space-y-2">
                  {form.weeklyHours.map((row) => (
                    <div
                      key={row.day}
                      className="grid grid-cols-1 items-center gap-2 rounded-md border border-border p-3 sm:grid-cols-[7rem_auto_1fr_1fr]"
                      data-testid={`weekly-row-${row.day}`}
                    >
                      <span className="text-sm font-medium text-foreground">
                        {OUTLET_WEEKDAY_LABELS_ID[row.day]}
                      </span>

                      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={row.closed}
                          onChange={(e) => updateWeeklyRow(row.day, { closed: e.target.checked })}
                          className="size-4 accent-primary"
                          data-testid={`weekly-closed-${row.day}`}
                        />
                        Tutup
                      </label>

                      <div className="flex items-center gap-2">
                        <label
                          htmlFor={`open-${row.day}`}
                          className="text-xs text-muted-foreground"
                        >
                          Buka
                        </label>
                        <Input
                          id={`open-${row.day}`}
                          type="time"
                          value={row.open}
                          disabled={row.closed}
                          onChange={(e) => updateWeeklyRow(row.day, { open: e.target.value })}
                          className="min-h-11"
                          data-testid={`weekly-open-${row.day}`}
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <label
                          htmlFor={`close-${row.day}`}
                          className="text-xs text-muted-foreground"
                        >
                          Tutup
                        </label>
                        <Input
                          id={`close-${row.day}`}
                          type="time"
                          value={row.close}
                          disabled={row.closed}
                          onChange={(e) => updateWeeklyRow(row.day, { close: e.target.value })}
                          className="min-h-11"
                          data-testid={`weekly-close-${row.day}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <InlineFieldError message={fieldErrors.weeklyHours} />
              </div>

              <Separator />

              {/* Holiday Hours Editor */}
              <div className="space-y-3" data-testid="outlet-holiday-hours-editor">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      Jadwal Khusus &amp; Hari Libur
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Tambahkan tanggal libur nasional atau jam buka khusus (maksimal{" "}
                      {MAX_OUTLET_HOLIDAY_ENTRIES} tanggal).
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    onClick={addHolidayRow}
                    disabled={form.holidayHours.length >= MAX_OUTLET_HOLIDAY_ENTRIES}
                    data-testid="outlet-add-holiday-btn"
                  >
                    <PlusIcon className="size-4" />
                    Tambah Hari Libur
                  </Button>
                </div>

                {form.holidayHours.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                    Belum ada jadwal hari libur khusus.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {form.holidayHours.map((row, idx) => (
                      <div
                        key={row.key}
                        className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 md:grid-cols-[10rem_1fr_auto_8rem_8rem_auto]"
                        data-testid={`holiday-row-${idx}`}
                      >
                        <Input
                          type="date"
                          value={row.date}
                          onChange={(e) => updateHolidayRow(row.key, { date: e.target.value })}
                          aria-label={`Tanggal hari libur ${idx + 1}`}
                          className="min-h-11"
                          data-testid={`holiday-date-${idx}`}
                        />
                        <Input
                          type="text"
                          value={row.label}
                          onChange={(e) => updateHolidayRow(row.key, { label: e.target.value })}
                          placeholder="Contoh: Hari Natal / Lebaran"
                          aria-label={`Keterangan hari libur ${idx + 1}`}
                          className="min-h-11"
                          data-testid={`holiday-label-${idx}`}
                        />
                        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={row.closed}
                            onChange={(e) => updateHolidayRow(row.key, { closed: e.target.checked })}
                            className="size-4 accent-primary"
                            data-testid={`holiday-closed-${idx}`}
                          />
                          Tutup
                        </label>
                        <Input
                          type="time"
                          value={row.open}
                          disabled={row.closed}
                          onChange={(e) => updateHolidayRow(row.key, { open: e.target.value })}
                          aria-label={`Jam buka libur ${idx + 1}`}
                          className="min-h-11"
                          data-testid={`holiday-open-${idx}`}
                        />
                        <Input
                          type="time"
                          value={row.close}
                          disabled={row.closed}
                          onChange={(e) => updateHolidayRow(row.key, { close: e.target.value })}
                          aria-label={`Jam tutup libur ${idx + 1}`}
                          className="min-h-11"
                          data-testid={`holiday-close-${idx}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 text-destructive"
                          onClick={() => removeHolidayRow(row.key)}
                          aria-label={`Hapus hari libur ${idx + 1}`}
                          data-testid={`holiday-remove-${idx}`}
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <InlineFieldError message={fieldErrors.holidayHours} />
              </div>

              <Separator />

              {/* Publication, Active & Order */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label htmlFor="outlet-status" className="text-sm font-medium text-foreground">
                    Status Publikasi
                  </label>
                  <select
                    id="outlet-status"
                    value={form.status}
                    onChange={(e) =>
                      updateForm({
                        status: e.target.value === "draft" ? "draft" : "published",
                      })
                    }
                    className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    data-testid="outlet-select-status"
                  >
                    <option value="published">Terbit (Tampil di Situs Publik)</option>
                    <option value="draft">Draf (Tersembunyi)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="outlet-sortOrder" className="text-sm font-medium text-foreground">
                    Urutan Tampil (0–100)
                  </label>
                  <Input
                    id="outlet-sortOrder"
                    type="number"
                    min={0}
                    max={100}
                    value={form.sortOrder}
                    onChange={(e) => updateForm({ sortOrder: e.target.value })}
                    className="min-h-11"
                    data-testid="outlet-input-sortOrder"
                  />
                  <InlineFieldError message={fieldErrors.sortOrder} />
                </div>

                <div className="flex flex-col justify-center gap-2 pt-2">
                  <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={form.active}
                      onChange={(e) => updateForm({ active: e.target.checked })}
                      className="size-4 accent-primary"
                      data-testid="outlet-checkbox-active"
                    />
                    Gerai aktif beroperasi
                  </label>
                  <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={form.isPrimary}
                      onChange={(e) => updateForm({ isPrimary: e.target.checked })}
                      className="size-4 accent-primary"
                      data-testid="outlet-checkbox-primary"
                    />
                    Tandai sebagai Gerai Utama
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={closeEditor}
                  disabled={isSubmitting}
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={isSubmitting}
                  data-testid="outlet-save-btn"
                >
                  <SaveIcon className="size-4" />
                  {isSubmitting
                    ? "Menyimpan..."
                    : editorMode === "create"
                      ? "Simpan Gerai"
                      : "Simpan Perubahan"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Outlets List / Empty State */}
      {isReloading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="outlets-loading-state">
          <div className="h-44 animate-pulse rounded-lg border border-border bg-muted/50" />
          <div className="h-44 animate-pulse rounded-lg border border-border bg-muted/50" />
        </div>
      ) : outlets.length === 0 ? (
        <Card data-testid="outlets-empty-state">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <MapPinIcon className="size-10 text-muted-foreground" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">Belum ada gerai terdaftar</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Tambahkan hingga {MAX_OUTLETS_PER_TENANT} gerai lengkap dengan jadwal mingguan, hari
                libur, dan koordinat untuk membantu pelanggan menemukan lokasi Anda.
              </p>
            </div>
            {canManageOutlets && (
              <Button
                type="button"
                className="min-h-11"
                onClick={openCreateForm}
                data-testid="outlets-empty-add-btn"
              >
                <PlusIcon className="size-4" />
                Tambah Gerai Pertama
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 lg:grid-cols-2"
          data-testid="outlets-list"
        >
          {outlets.map((outlet) => {
            const fullAddress = formatOutletFullAddress(outlet);
            const isBusy = busyOutletId === outlet.id;
            return (
              <Card
                key={outlet.id}
                className="flex flex-col justify-between"
                data-testid={`outlet-admin-card-${outlet.id}`}
              >
                <CardHeader className="space-y-2 pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {outlet.isPrimary && (
                          <Badge variant="default" className="gap-1">
                            <StarIcon className="size-3" />
                            Utama
                          </Badge>
                        )}
                        <Badge variant={outlet.status === "published" ? "success" : "secondary"}>
                          {outlet.status === "published" ? "Terbit" : "Draf"}
                        </Badge>
                        {!outlet.active && <Badge variant="warning">Nonaktif</Badge>}
                      </div>
                      <CardTitle className="text-lg">{outlet.name}</CardTitle>
                      <p className="font-mono text-xs text-muted-foreground">/{outlet.slug}</p>
                    </div>

                    {canManageOutlets && (
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11"
                          onClick={() => openEditForm(outlet)}
                          disabled={isBusy}
                          data-testid={`outlet-edit-btn-${outlet.id}`}
                        >
                          <PencilIcon className="size-4" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="min-h-11"
                          onClick={() => setDeleteTarget(outlet)}
                          disabled={isBusy}
                          data-testid={`outlet-delete-btn-${outlet.id}`}
                        >
                          <Trash2Icon className="size-4" />
                          Hapus
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-start gap-2 text-muted-foreground">
                    <MapPinIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="break-words">{fullAddress}</span>
                  </div>

                  {outlet.weekdayHoursText && (
                    <div className="flex items-start gap-2 text-muted-foreground">
                      <ClockIcon className="mt-0.5 size-4 shrink-0" />
                      <span className="break-words">{outlet.weekdayHoursText}</span>
                    </div>
                  )}

                  {outlet.holidayHours.length > 0 && (
                    <div className="flex items-start gap-2 text-muted-foreground">
                      <CalendarIcon className="mt-0.5 size-4 shrink-0" />
                      <span className="break-words">
                        {outlet.holidayHours.length} jadwal hari libur:{" "}
                        {outlet.holidayHoursText}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {outlet.phone && (
                      <span className="inline-flex items-center gap-1">
                        <PhoneIcon className="size-3.5" />
                        {outlet.phone}
                      </span>
                    )}
                    {outlet.whatsappE164 && (
                      <span className="inline-flex items-center gap-1">
                        <MessageCircleIcon className="size-3.5" />
                        WA: {outlet.whatsappE164}
                      </span>
                    )}
                    {outlet.latitude !== null && outlet.longitude !== null && (
                      <span className="font-mono">
                        {outlet.latitude}, {outlet.longitude}
                      </span>
                    )}
                  </div>

                  {outlet.directionsUrl && (
                    <div className="pt-1">
                      <a
                        href={outlet.directionsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                        data-testid={`outlet-admin-directions-${outlet.id}`}
                      >
                        <NavigationIcon className="size-4" />
                        Buka Petunjuk Arah Google Maps
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Sisa slot gerai: {remainingSlots} dari {MAX_OUTLETS_PER_TENANT}.
      </p>

      {/* Delete Confirmation Dialog */}
      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Hapus Gerai?"
        description={
          deleteTarget
            ? `Gerai "${deleteTarget.name}" akan dihapus permanen dari direktori situs. Riwayat pesan masuk yang terkait tetap tersimpan aman.`
            : ""
        }
        confirmLabel="Ya, Hapus Gerai"
        cancelLabel="Batal"
        busy={busyOutletId !== null}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  );
}
