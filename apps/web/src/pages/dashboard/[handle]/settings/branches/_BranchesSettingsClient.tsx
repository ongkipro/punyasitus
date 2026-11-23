import { useCallback, useMemo, useState } from "react";
import {
  BRANCH_TIMEZONE_LABELS_ID,
  buildBranchStaticMapsHref,
  DEFAULT_BRANCH_TIMEZONE,
  formatBranchFullAddress,
  formatBranchPhoneDisplay,
  formatBranchTimezoneLabel,
  INDONESIAN_BRANCH_TIMEZONES,
  MAX_BRANCHES_PER_TENANT,
  resolveBranchMapsLabel,
  sortBranchesCanonically,
  type BranchRecord,
} from "@punyasitus/core/branches/index";
import type { BranchListAdminDto } from "@punyasitus/db/branches/index";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  Building2Icon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  InfoIcon,
  MapPinIcon,
  MessageCircleIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
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

export interface BranchesSettingsClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly canManageBranches: boolean;
  readonly initialData: BranchListAdminDto;
}

interface BranchFormState {
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly province: string;
  readonly postalCode: string;
  readonly phone: string;
  readonly whatsappNumber: string;
  readonly mapsUrl: string;
  readonly latitude: string;
  readonly longitude: string;
  readonly weekdayHours: string;
  readonly holidayHours: string;
  readonly timezone: string;
  readonly isPrimary: boolean;
  readonly active: boolean;
}

const EMPTY_FORM: BranchFormState = {
  name: "",
  address: "",
  city: "",
  province: "",
  postalCode: "",
  phone: "",
  whatsappNumber: "",
  mapsUrl: "",
  latitude: "",
  longitude: "",
  weekdayHours: "",
  holidayHours: "",
  timezone: DEFAULT_BRANCH_TIMEZONE,
  isPrimary: false,
  active: true,
};

function branchToFormState(branch: BranchRecord): BranchFormState {
  return {
    name: branch.name,
    address: branch.address,
    city: branch.city ?? "",
    province: branch.province ?? "",
    postalCode: branch.postalCode ?? "",
    phone: branch.phone ?? "",
    whatsappNumber: branch.whatsappE164 ?? branch.whatsappNumber ?? "",
    mapsUrl: branch.mapsUrl ?? "",
    latitude: branch.latitude !== null ? String(branch.latitude) : "",
    longitude: branch.longitude !== null ? String(branch.longitude) : "",
    weekdayHours: branch.weekdayHours ?? "",
    holidayHours: branch.holidayHours ?? "",
    timezone: branch.timezone || DEFAULT_BRANCH_TIMEZONE,
    isPrimary: branch.isPrimary,
    active: branch.active,
  };
}

export function BranchesSettingsClient({
  handle,
  basePath,
  permissions,
  canManageBranches,
  initialData,
}: BranchesSettingsClientProps) {
  const [branches, setBranches] = useState<BranchRecord[]>(() =>
    sortBranchesCanonically(initialData.items),
  );
  const [editorMode, setEditorMode] = useState<"closed" | "create" | "edit">("closed");
  const [editingBranch, setEditingBranch] = useState<BranchRecord | null>(null);
  const [form, setForm] = useState<BranchFormState>(EMPTY_FORM);
  const [isDirty, setIsDirty] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyBranchId, setBusyBranchId] = useState<number | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BranchRecord | null>(null);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  useDirtyNavigationGuard(isDirty);

  const apiBase = useMemo(
    () => `/api/tenants/${encodeURIComponent(handle)}/branches`,
    [handle],
  );

  const isLimitReached = branches.length >= MAX_BRANCHES_PER_TENANT;
  const remainingSlots = Math.max(0, MAX_BRANCHES_PER_TENANT - branches.length);
  const isEditorReadOnly = !canManageBranches && !permissions.isLocked;

  const reloadBranches = useCallback(async () => {
    try {
      const latest = await cmsFetchJson<BranchListAdminDto>(apiBase);
      setBranches(sortBranchesCanonically(latest.items));
      setStaleMessage(null);
      setBannerError(null);
      setFieldErrors({});
      if (editingBranch) {
        const refreshed = latest.items.find((b) => b.id === editingBranch.id) ?? null;
        if (refreshed) {
          setEditingBranch(refreshed);
          setForm(branchToFormState(refreshed));
          setIsDirty(false);
        } else {
          setEditorMode("closed");
          setEditingBranch(null);
          setIsDirty(false);
        }
      }
    } catch (err) {
      setBannerError(
        err instanceof Error ? err.message : "Gagal memuat ulang daftar cabang.",
      );
    }
  }, [apiBase, editingBranch]);

  const openCreateForm = useCallback(() => {
    if (!canManageBranches || isLimitReached) return;
    setEditingBranch(null);
    setForm({
      ...EMPTY_FORM,
      isPrimary: branches.length === 0,
    });
    setFieldErrors({});
    setBannerError(null);
    setBannerSuccess(null);
    setStaleMessage(null);
    setEditorMode("create");
    setIsDirty(false);
  }, [branches.length, canManageBranches, isLimitReached]);

  const openEditForm = useCallback(
    (branch: BranchRecord) => {
      if (!canManageBranches) return;
      setEditingBranch(branch);
      setForm(branchToFormState(branch));
      setFieldErrors({});
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);
      setEditorMode("edit");
      setIsDirty(false);
    },
    [canManageBranches],
  );

  const closeEditor = useCallback(() => {
    setEditorMode("closed");
    setEditingBranch(null);
    setFieldErrors({});
    setStaleMessage(null);
    setIsDirty(false);
  }, []);

  const updateField = useCallback(
    <K extends keyof BranchFormState>(key: K, value: BranchFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setIsDirty(true);
      setFieldErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const handleSubmitForm = useCallback(
    async (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canManageBranches || isSubmitting) return;

      setFieldErrors({});
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);

      // Client-side coordinate number parsing before sending strict JSON payload
      const latTrimmed = form.latitude.trim();
      const lngTrimmed = form.longitude.trim();
      const localErrors: Record<string, string> = {};

      if (!form.name.trim()) {
        localErrors.name = "Nama cabang wajib diisi.";
      }
      if (!form.address.trim()) {
        localErrors.address = "Alamat cabang wajib diisi.";
      }

      let parsedLat: number | null = null;
      let parsedLng: number | null = null;
      if (latTrimmed || lngTrimmed) {
        if (!latTrimmed) {
          localErrors.latitude = "Latitude wajib diisi jika longitude diisi.";
        } else {
          const n = Number(latTrimmed);
          if (!Number.isFinite(n) || n < -90 || n > 90) {
            localErrors.latitude = "Latitude harus berupa angka antara -90 hingga 90.";
          } else {
            parsedLat = n;
          }
        }
        if (!lngTrimmed) {
          localErrors.longitude = "Longitude wajib diisi jika latitude diisi.";
        } else {
          const n = Number(lngTrimmed);
          if (!Number.isFinite(n) || n < -180 || n > 180) {
            localErrors.longitude = "Longitude harus berupa angka antara -180 hingga 180.";
          } else {
            parsedLng = n;
          }
        }
      }

      if (Object.keys(localErrors).length > 0) {
        setFieldErrors(localErrors);
        setBannerError("Periksa kembali kolom formulir yang masih perlu diperbaiki.");
        return;
      }

      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        address: form.address.trim(),
        city: form.city.trim() || null,
        province: form.province.trim() || null,
        postalCode: form.postalCode.trim() || null,
        phone: form.phone.trim() || null,
        whatsappNumber: form.whatsappNumber.trim() || null,
        mapsUrl: form.mapsUrl.trim() || null,
        latitude: parsedLat,
        longitude: parsedLng,
        weekdayHours: form.weekdayHours.trim() || null,
        holidayHours: form.holidayHours.trim() || null,
        timezone: form.timezone || DEFAULT_BRANCH_TIMEZONE,
        isPrimary: form.isPrimary,
        active: form.active,
      };

      setIsSubmitting(true);
      try {
        if (editorMode === "create") {
          const created = await cmsFetchJson<BranchRecord>(apiBase, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          setBranches((prev) => {
            const nextList = created.isPrimary
              ? prev.map((b) => ({ ...b, isPrimary: false }))
              : [...prev];
            return sortBranchesCanonically([...nextList, created]);
          });
          setBannerSuccess(`Cabang "${created.name}" berhasil ditambahkan.`);
          setEditorMode("closed");
          setEditingBranch(null);
          setIsDirty(false);
        } else if (editorMode === "edit" && editingBranch) {
          const updated = await cmsFetchJson<BranchRecord>(`${apiBase}/${editingBranch.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              ...payload,
              expectedVersion: editingBranch.version,
            }),
          });
          setBranches((prev) =>
            sortBranchesCanonically(
              prev.map((b) => {
                if (b.id === updated.id) return updated;
                if (updated.isPrimary && b.isPrimary) {
                  return { ...b, isPrimary: false, version: b.version + 1 };
                }
                return b;
              }),
            ),
          );
          setBannerSuccess(`Perubahan cabang "${updated.name}" berhasil disimpan.`);
          setEditorMode("closed");
          setEditingBranch(null);
          setIsDirty(false);
        }
      } catch (err) {
        if (err instanceof CmsApiError) {
          if (err.isStaleVersion) {
            setStaleMessage(err.message);
          } else {
            const mapped = fieldErrorsToMap(err.fields);
            if (mapped.whatsappE164 && !mapped.whatsappNumber) {
              mapped.whatsappNumber = mapped.whatsappE164;
            }
            setFieldErrors(mapped);
            setBannerError(err.message);
          }
        } else {
          setBannerError("Terjadi kesalahan saat menyimpan data cabang.");
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [apiBase, canManageBranches, editingBranch, editorMode, form, isSubmitting],
  );

  const handleSetPrimary = useCallback(
    async (branch: BranchRecord) => {
      if (!canManageBranches || branch.isPrimary || busyBranchId !== null) return;
      setBusyBranchId(branch.id);
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);
      try {
        const updated = await cmsFetchJson<BranchRecord>(`${apiBase}/${branch.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            isPrimary: true,
            expectedVersion: branch.version,
          }),
        });
        setBranches((prev) =>
          sortBranchesCanonically(
            prev.map((b) => {
              if (b.id === updated.id) return updated;
              if (b.isPrimary) return { ...b, isPrimary: false, version: b.version + 1 };
              return b;
            }),
          ),
        );
        setBannerSuccess(`"${updated.name}" ditetapkan sebagai cabang utama.`);
      } catch (err) {
        if (err instanceof CmsApiError && err.isStaleVersion) {
          setStaleMessage(err.message);
        } else {
          setBannerError(
            err instanceof Error ? err.message : "Gagal menetapkan cabang utama.",
          );
        }
      } finally {
        setBusyBranchId(null);
      }
    },
    [apiBase, busyBranchId, canManageBranches],
  );

  const handleMoveBranch = useCallback(
    async (index: number, direction: -1 | 1) => {
      if (!canManageBranches || isReordering) return;
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= branches.length) return;

      const reordered = [...branches];
      const [moved] = reordered.splice(index, 1);
      if (!moved) return;
      reordered.splice(targetIndex, 0, moved);

      setIsReordering(true);
      setBannerError(null);
      setBannerSuccess(null);
      setStaleMessage(null);
      try {
        const updated = await cmsFetchJson<BranchListAdminDto>(`${apiBase}/reorder`, {
          method: "POST",
          body: JSON.stringify({
            branchIds: reordered.map((b) => b.id),
          }),
        });
        setBranches(sortBranchesCanonically(updated.items));
        setBannerSuccess("Urutan cabang berhasil diperbarui.");
      } catch (err) {
        setBannerError(
          err instanceof Error ? err.message : "Gagal mengubah urutan cabang.",
        );
      } finally {
        setIsReordering(false);
      }
    },
    [apiBase, branches, canManageBranches, isReordering],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!canManageBranches || !deleteTarget) return;
    setBusyBranchId(deleteTarget.id);
    setBannerError(null);
    setBannerSuccess(null);
    setStaleMessage(null);
    try {
      await cmsFetchJson<{ readonly deleted: true; readonly id: number }>(
        `${apiBase}/${deleteTarget.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ expectedVersion: deleteTarget.version }),
        },
      );
      setBranches((prev) => prev.filter((b) => b.id !== deleteTarget.id));
      if (editingBranch?.id === deleteTarget.id) {
        setEditorMode("closed");
        setEditingBranch(null);
        setIsDirty(false);
      }
      setBannerSuccess(`Cabang "${deleteTarget.name}" telah dihapus.`);
      setDeleteTarget(null);
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setStaleMessage(err.message);
        setDeleteTarget(null);
      } else {
        setBannerError(
          err instanceof Error ? err.message : "Gagal menghapus cabang.",
        );
      }
    } finally {
      setBusyBranchId(null);
    }
  }, [apiBase, canManageBranches, deleteTarget, editingBranch]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 pb-10" data-testid="branches-settings-root">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <a
            href={`${basePath}/settings`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            Kembali ke Pengaturan
          </a>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Lokasi &amp; Cabang
            </h1>
            <Badge
              variant={isLimitReached ? "secondary" : "outline"}
              data-testid="branches-quota-badge"
            >
              {branches.length} / {MAX_BRANCHES_PER_TENANT} Cabang
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Kelola hingga {MAX_BRANCHES_PER_TENANT} lokasi cabang di luar kantor pusat. Setiap
            cabang aktif otomatis tampil di kartu lokasi publik dan data terstruktur Schema.org{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">@graph</code>.
          </p>
        </div>

        {canManageBranches && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={openCreateForm}
              disabled={isLimitReached || editorMode === "create"}
              data-testid="add-branch-button"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              Tambah Cabang
            </Button>
          </div>
        )}
      </div>

      {/* Lifecycle / Role / Status Banners */}
      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {isEditorReadOnly && (
        <Alert data-testid="branches-editor-readonly-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode Baca Saja (Editor)</AlertTitle>
          <AlertDescription>
            Anda dapat melihat seluruh daftar cabang situs ini, tetapi hanya Pemilik Situs atau
            Admin yang dapat menambah, mengubah, mengurutkan, atau menghapus cabang.
          </AlertDescription>
        </Alert>
      )}

      {staleMessage && (
        <StaleWriteRecoveryBanner
          message={staleMessage}
          onReloadLatest={() => {
            void reloadBranches();
          }}
        />
      )}

      {isLimitReached && canManageBranches && (
        <Alert data-testid="branches-limit-banner">
          <InfoIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Batas Maksimal {MAX_BRANCHES_PER_TENANT} Cabang Tercapai</AlertTitle>
          <AlertDescription>
            Setiap situs mendukung hingga {MAX_BRANCHES_PER_TENANT} cabang di luar kantor pusat.
            Hapus salah satu cabang terlebih dahulu jika ingin menambah lokasi baru.
          </AlertDescription>
        </Alert>
      )}

      {bannerError && (
        <Alert variant="destructive" role="alert" data-testid="branches-error-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal Memproses Perubahan</AlertTitle>
          <AlertDescription>{bannerError}</AlertDescription>
        </Alert>
      )}

      {bannerSuccess && (
        <Alert role="status" data-testid="branches-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{bannerSuccess}</AlertDescription>
        </Alert>
      )}

      {/* Create / Edit Branch Form */}
      {canManageBranches && editorMode !== "closed" && (
        <Card data-testid="branch-editor-card">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <CardTitle>
                {editorMode === "create"
                  ? "Tambah Cabang Baru"
                  : `Edit Cabang: ${editingBranch?.name ?? ""}`}
              </CardTitle>
              <CardDescription>
                Isi data faktual cabang yang tampil di halaman publik. Biarkan kosong kolom yang
                tidak berlaku — sistem tidak pernah membuat jam operasional atau koordinat palsu.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={closeEditor}
              aria-label="Tutup formulir cabang"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmitForm} className="space-y-5" noValidate>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <label htmlFor="branch-name" className="text-sm font-medium text-foreground">
                    Nama Cabang <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="branch-name"
                    name="name"
                    value={form.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    placeholder="Contoh: Cabang Surabaya Darmo"
                    maxLength={120}
                    required
                    aria-invalid={Boolean(fieldErrors.name)}
                    data-testid="branch-input-name"
                  />
                  <InlineFieldError message={fieldErrors.name} />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <label htmlFor="branch-address" className="text-sm font-medium text-foreground">
                    Alamat Lengkap <span className="text-destructive">*</span>
                  </label>
                  <textarea
                    id="branch-address"
                    name="address"
                    rows={2}
                    value={form.address}
                    onChange={(e) => updateField("address", e.target.value)}
                    placeholder="Contoh: Jl. Raya Darmo No. 45, Wonokromo"
                    maxLength={500}
                    required
                    aria-invalid={Boolean(fieldErrors.address)}
                    data-testid="branch-input-address"
                    className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                  />
                  <InlineFieldError message={fieldErrors.address} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-city" className="text-sm font-medium text-foreground">
                    Kota / Kabupaten
                  </label>
                  <Input
                    id="branch-city"
                    name="city"
                    value={form.city}
                    onChange={(e) => updateField("city", e.target.value)}
                    placeholder="Surabaya"
                    maxLength={120}
                    aria-invalid={Boolean(fieldErrors.city)}
                    data-testid="branch-input-city"
                  />
                  <InlineFieldError message={fieldErrors.city} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-province" className="text-sm font-medium text-foreground">
                    Provinsi
                  </label>
                  <Input
                    id="branch-province"
                    name="province"
                    value={form.province}
                    onChange={(e) => updateField("province", e.target.value)}
                    placeholder="Jawa Timur"
                    maxLength={120}
                    aria-invalid={Boolean(fieldErrors.province)}
                    data-testid="branch-input-province"
                  />
                  <InlineFieldError message={fieldErrors.province} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-postal" className="text-sm font-medium text-foreground">
                    Kode Pos
                  </label>
                  <Input
                    id="branch-postal"
                    name="postalCode"
                    value={form.postalCode}
                    onChange={(e) => updateField("postalCode", e.target.value)}
                    placeholder="60241"
                    maxLength={20}
                    aria-invalid={Boolean(fieldErrors.postalCode)}
                    data-testid="branch-input-postal"
                  />
                  <InlineFieldError message={fieldErrors.postalCode} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-timezone" className="text-sm font-medium text-foreground">
                    Zona Waktu
                  </label>
                  <select
                    id="branch-timezone"
                    name="timezone"
                    value={form.timezone}
                    onChange={(e) => updateField("timezone", e.target.value)}
                    aria-invalid={Boolean(fieldErrors.timezone)}
                    data-testid="branch-input-timezone"
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {INDONESIAN_BRANCH_TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {BRANCH_TIMEZONE_LABELS_ID[tz] ?? tz}
                      </option>
                    ))}
                  </select>
                  <InlineFieldError message={fieldErrors.timezone} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-phone" className="text-sm font-medium text-foreground">
                    Nomor Telepon Cabang
                  </label>
                  <Input
                    id="branch-phone"
                    name="phone"
                    type="tel"
                    value={form.phone}
                    onChange={(e) => updateField("phone", e.target.value)}
                    placeholder="031-5551234 atau +62315551234"
                    maxLength={32}
                    aria-invalid={Boolean(fieldErrors.phone)}
                    data-testid="branch-input-phone"
                  />
                  <InlineFieldError message={fieldErrors.phone} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-whatsapp" className="text-sm font-medium text-foreground">
                    Nomor WhatsApp Cabang
                  </label>
                  <Input
                    id="branch-whatsapp"
                    name="whatsappNumber"
                    type="tel"
                    value={form.whatsappNumber}
                    onChange={(e) => updateField("whatsappNumber", e.target.value)}
                    placeholder="0812-3456-7890"
                    maxLength={32}
                    aria-invalid={Boolean(fieldErrors.whatsappNumber)}
                    data-testid="branch-input-whatsapp"
                  />
                  <p className="text-xs text-muted-foreground">
                    Otomatis dinormalisasi ke format E.164 (628...). Tombol WhatsApp melayang tetap
                    menggunakan nomor utama bisnis.
                  </p>
                  <InlineFieldError message={fieldErrors.whatsappNumber} />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <label htmlFor="branch-maps-url" className="text-sm font-medium text-foreground">
                    Tautan Google Maps (HTTPS)
                  </label>
                  <Input
                    id="branch-maps-url"
                    name="mapsUrl"
                    type="url"
                    value={form.mapsUrl}
                    onChange={(e) => updateField("mapsUrl", e.target.value)}
                    placeholder="https://maps.google.com/?q=-7.2819,112.7381"
                    maxLength={2048}
                    aria-invalid={Boolean(fieldErrors.mapsUrl)}
                    data-testid="branch-input-maps-url"
                  />
                  <p className="text-xs text-muted-foreground">
                    Ditampilkan sebagai tautan peta statis tanpa iframe pihak ketiga sebelum izin
                    pengunjung.
                  </p>
                  <InlineFieldError message={fieldErrors.mapsUrl} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-latitude" className="text-sm font-medium text-foreground">
                    Koordinat Latitude (Opsional)
                  </label>
                  <Input
                    id="branch-latitude"
                    name="latitude"
                    inputMode="decimal"
                    value={form.latitude}
                    onChange={(e) => updateField("latitude", e.target.value)}
                    placeholder="-7.2819"
                    aria-invalid={Boolean(fieldErrors.latitude)}
                    data-testid="branch-input-latitude"
                  />
                  <InlineFieldError message={fieldErrors.latitude} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-longitude" className="text-sm font-medium text-foreground">
                    Koordinat Longitude (Opsional)
                  </label>
                  <Input
                    id="branch-longitude"
                    name="longitude"
                    inputMode="decimal"
                    value={form.longitude}
                    onChange={(e) => updateField("longitude", e.target.value)}
                    placeholder="112.7381"
                    aria-invalid={Boolean(fieldErrors.longitude)}
                    data-testid="branch-input-longitude"
                  />
                  <InlineFieldError message={fieldErrors.longitude} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-weekday-hours" className="text-sm font-medium text-foreground">
                    Jam Operasional Hari Kerja
                  </label>
                  <Input
                    id="branch-weekday-hours"
                    name="weekdayHours"
                    value={form.weekdayHours}
                    onChange={(e) => updateField("weekdayHours", e.target.value)}
                    placeholder="Senin–Jumat 08.30–17.00 WIB"
                    maxLength={160}
                    aria-invalid={Boolean(fieldErrors.weekdayHours)}
                    data-testid="branch-input-weekday-hours"
                  />
                  <InlineFieldError message={fieldErrors.weekdayHours} />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="branch-holiday-hours" className="text-sm font-medium text-foreground">
                    Jam Operasional Akhir Pekan / Libur
                  </label>
                  <Input
                    id="branch-holiday-hours"
                    name="holidayHours"
                    value={form.holidayHours}
                    onChange={(e) => updateField("holidayHours", e.target.value)}
                    placeholder="Sabtu 09.00–14.00 WIB, Minggu Tutup"
                    maxLength={160}
                    aria-invalid={Boolean(fieldErrors.holidayHours)}
                    data-testid="branch-input-holiday-hours"
                  />
                  <InlineFieldError message={fieldErrors.holidayHours} />
                </div>
              </div>

              <Separator />

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
                <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={form.isPrimary}
                    onChange={(e) => updateField("isPrimary", e.target.checked)}
                    className="size-4 rounded border-input accent-primary"
                    data-testid="branch-input-primary"
                  />
                  Tandai sebagai Cabang Utama
                </label>

                <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => updateField("active", e.target.checked)}
                    className="size-4 rounded border-input accent-primary"
                    data-testid="branch-input-active"
                  />
                  Tampilkan di situs publik (Aktif)
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeEditor}
                  disabled={isSubmitting}
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  data-testid="branch-submit-button"
                >
                  <SaveIcon className="size-4" aria-hidden="true" />
                  {isSubmitting
                    ? "Menyimpan..."
                    : editorMode === "create"
                      ? "Simpan Cabang Baru"
                      : "Simpan Perubahan"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Branch List */}
      <div className="space-y-4" data-testid="branches-list">
        {branches.length === 0 ? (
          <Card data-testid="branches-empty-card">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Building2Icon className="size-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-foreground">
                  Belum ada lokasi cabang
                </h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  Tambahkan hingga {MAX_BRANCHES_PER_TENANT} cabang di luar kantor pusat agar
                  pengunjung dapat melihat alamat, jam operasional, tautan peta statis, dan nomor
                  WhatsApp masing-masing outlet.
                </p>
              </div>
              {canManageBranches && (
                <Button type="button" onClick={openCreateForm} className="mt-1">
                  <PlusIcon className="size-4" aria-hidden="true" />
                  Tambah Cabang Pertama
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          branches.map((branch, index) => {
            const fullAddress = formatBranchFullAddress(branch);
            const phoneDisplay = formatBranchPhoneDisplay(branch.phone);
            const waDisplay = formatBranchPhoneDisplay(branch.whatsappE164 ?? branch.whatsappNumber);
            const mapsHref = buildBranchStaticMapsHref(branch);
            const isBusy = busyBranchId === branch.id || isReordering;

            return (
              <Card
                key={branch.id}
                className={branch.isPrimary ? "border-primary/60" : undefined}
                data-testid={`admin-branch-card-${branch.id}`}
              >
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base break-words">{branch.name}</CardTitle>
                      {branch.isPrimary && (
                        <Badge variant="default" data-testid={`branch-primary-badge-${branch.id}`}>
                          <StarIcon className="mr-1 size-3" aria-hidden="true" />
                          Cabang Utama
                        </Badge>
                      )}
                      <Badge variant={branch.active ? "secondary" : "outline"}>
                        {branch.active ? "Aktif" : "Nonaktif"}
                      </Badge>
                      <Badge variant="outline">{formatBranchTimezoneLabel(branch.timezone)}</Badge>
                    </div>
                    <CardDescription className="flex items-start gap-1.5 break-words">
                      <MapPinIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>{fullAddress}</span>
                    </CardDescription>
                  </div>

                  {canManageBranches && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={isBusy || index === 0}
                        onClick={() => {
                          void handleMoveBranch(index, -1);
                        }}
                        aria-label={`Pindahkan ${branch.name} ke atas`}
                        data-testid={`branch-move-up-${branch.id}`}
                      >
                        <ArrowUpIcon className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={isBusy || index === branches.length - 1}
                        onClick={() => {
                          void handleMoveBranch(index, 1);
                        }}
                        aria-label={`Pindahkan ${branch.name} ke bawah`}
                        data-testid={`branch-move-down-${branch.id}`}
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </Button>
                      {!branch.isPrimary && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => {
                            void handleSetPrimary(branch);
                          }}
                          data-testid={`branch-set-primary-${branch.id}`}
                        >
                          <StarIcon className="size-3.5" aria-hidden="true" />
                          Jadikan Utama
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => openEditForm(branch)}
                        data-testid={`branch-edit-${branch.id}`}
                      >
                        <PencilIcon className="size-3.5" aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => setDeleteTarget(branch)}
                        data-testid={`branch-delete-${branch.id}`}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden="true" />
                        Hapus
                      </Button>
                    </div>
                  )}
                </CardHeader>

                <CardContent className="grid grid-cols-1 gap-3 border-t pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <ClockIcon className="size-3.5" aria-hidden="true" />
                      Jam Operasional
                    </p>
                    <p className="break-words text-foreground">
                      {branch.weekdayHours || "Hari kerja belum diisi"}
                    </p>
                    {branch.holidayHours && (
                      <p className="break-words text-xs text-muted-foreground">
                        Libur: {branch.holidayHours}
                      </p>
                    )}
                  </div>

                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <PhoneIcon className="size-3.5" aria-hidden="true" />
                      Kontak Cabang
                    </p>
                    <p className="break-words text-foreground">
                      Telepon: {phoneDisplay ?? "—"}
                    </p>
                    <p className="flex items-center gap-1 break-words text-xs text-muted-foreground">
                      <MessageCircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      WhatsApp: {waDisplay ?? "—"}
                    </p>
                  </div>

                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <MapPinIcon className="size-3.5" aria-hidden="true" />
                      Peta &amp; Koordinat
                    </p>
                    {mapsHref ? (
                      <a
                        href={mapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 break-all text-primary underline-offset-4 hover:underline"
                      >
                        {resolveBranchMapsLabel(mapsHref)}
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <p className="text-muted-foreground">Tautan peta belum diisi</p>
                    )}
                    {branch.latitude !== null && branch.longitude !== null && (
                      <p className="font-mono text-xs text-muted-foreground">
                        {branch.latitude}, {branch.longitude}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Schema.org & Privacy Parity Note */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <InfoIcon className="size-4 text-primary" aria-hidden="true" />
            Sinkronisasi Data Terstruktur &amp; Privasi Peta
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs text-muted-foreground">
          <p>
            • Sisa kuota cabang: <strong className="text-foreground">{remainingSlots}</strong> dari{" "}
            {MAX_BRANCHES_PER_TENANT} lokasi cabang.
          </p>
          <p>
            • Semua cabang berstatus <strong>Aktif</strong> terhubung langsung ke entitas induk
            pada satu Schema.org <code>@graph</code> dengan nilai alamat, telepon, dan jam
            operasional yang identik dengan kartu publik — tanpa rating atau ulasan buatan.
          </p>
          <p>
            • Halaman publik hanya menampilkan tautan Google Maps statis tanpa memuat skrip atau
            iframe pihak ketiga sebelum persetujuan pengunjung.
          </p>
        </CardContent>
      </Card>

      {/* Base UI Destructive Confirmation Dialog */}
      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Hapus lokasi cabang?"
        description={
          deleteTarget
            ? `Cabang "${deleteTarget.name}" akan dihapus permanen dari situs publik dan Schema.org. Data prospek (leads) lama tetap aman tersimpan.`
            : ""
        }
        confirmLabel="Ya, Hapus Cabang"
        busy={deleteTarget !== null && busyBranchId === deleteTarget.id}
        onConfirm={() => {
          void handleConfirmDelete();
        }}
      />
    </div>
  );
}
