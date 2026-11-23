import * as React from "react";
import {
  CUSTOM_THEME_REQUEST_STATUSES,
  CUSTOM_THEME_STATUS_LABELS_ID,
  type CustomThemeRequestStatus,
} from "@punyasitus/core/custom-themes/index";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LayersIcon,
  PackagePlusIcon,
  PaletteIcon,
  PencilIcon,
  PowerIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type {
  ConsoleCustomThemePackageDto,
  ConsoleCustomThemeRequestDto,
} from "../../../pages/api/console/custom-themes/_shared.ts";

/**
 * Superadmin Console Panel (`console.punyasitus.com/custom-themes`)
 * built on `shadcn/ui` `base-nova` (`@base-ui/react`, `render` prop composition).
 *
 * Manages:
 * 1. Service packages (`create`, `edit`, `reorder` with keyboard Naik/Turun, `deactivate`/`activate`)
 *    with optimistic `version`, mandatory 10–500 char audit `reason`, and recent 2FA step-up.
 * 2. Tenant custom theme requests queue with status filters, tenant search, audited transitions,
 *    and mandatory active `tenant_theme_entitlements` grant linkage for `delivered`.
 *
 * (REQ-063, REQ-051, PLAN §11.4 & §13, TASK-061).
 */

export interface ConsoleCustomThemesPanelProps {
  readonly initialPackages: readonly ConsoleCustomThemePackageDto[];
  readonly initialRequests: readonly ConsoleCustomThemeRequestDto[];
  readonly stepUpFresh: boolean;
}

type ConsoleTab = "packages" | "requests";

function formatDateTimeId(iso: string): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusBadgeVariant(
  status: CustomThemeRequestStatus,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "info" {
  switch (status) {
    case "new":
      return "info";
    case "contacted":
    case "quoted":
      return "warning";
    case "in_progress":
      return "secondary";
    case "delivered":
      return "success";
    case "declined":
    case "cancelled":
      return "destructive";
  }
}

export function ConsoleCustomThemesPanel({
  initialPackages,
  initialRequests,
  stepUpFresh,
}: ConsoleCustomThemesPanelProps) {
  const [activeTab, setActiveTab] = React.useState<ConsoleTab>("packages");
  const [packages, setPackages] = React.useState<readonly ConsoleCustomThemePackageDto[]>(
    initialPackages,
  );
  const [requests, setRequests] = React.useState<readonly ConsoleCustomThemeRequestDto[]>(
    initialRequests,
  );

  const [isRefreshing, setIsRefreshing] = React.useState<boolean>(false);
  const [notice, setNotice] = React.useState<{
    readonly variant: "success" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  // Create package form state
  const [createSlug, setCreateSlug] = React.useState<string>("");
  const [createName, setCreateName] = React.useState<string>("");
  const [createDescription, setCreateDescription] = React.useState<string>("");
  const [createInclusionsText, setCreateInclusionsText] = React.useState<string>("");
  const [createPriceText, setCreatePriceText] = React.useState<string>("");
  const [createDuration, setCreateDuration] = React.useState<string>("10–14 hari kerja");
  const [createSortOrder, setCreateSortOrder] = React.useState<string>("10");
  const [createActive, setCreateActive] = React.useState<boolean>(true);
  const [createReason, setCreateReason] = React.useState<string>("");
  const [isCreatingPkg, setIsCreatingPkg] = React.useState<boolean>(false);

  // Edit package inline state
  const [editingPkg, setEditingPkg] = React.useState<ConsoleCustomThemePackageDto | null>(null);
  const [editName, setEditName] = React.useState<string>("");
  const [editDescription, setEditDescription] = React.useState<string>("");
  const [editInclusionsText, setEditInclusionsText] = React.useState<string>("");
  const [editPriceText, setEditPriceText] = React.useState<string>("");
  const [editDuration, setEditDuration] = React.useState<string>("");
  const [editSortOrder, setEditSortOrder] = React.useState<string>("0");
  const [editReason, setEditReason] = React.useState<string>("");
  const [isSavingPkg, setIsSavingPkg] = React.useState<boolean>(false);

  // Request filter & transition state
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [tenantSearch, setTenantSearch] = React.useState<string>("");
  const [activeTransitionReqId, setActiveTransitionReqId] = React.useState<string | null>(null);
  const [nextStatus, setNextStatus] = React.useState<CustomThemeRequestStatus>("contacted");
  const [transitionReason, setTransitionReason] = React.useState<string>("");
  const [operatorNotes, setOperatorNotes] = React.useState<string>("");
  const [deliveredThemeId, setDeliveredThemeId] = React.useState<string>("");
  const [isTransitioning, setIsTransitioning] = React.useState<boolean>(false);

  const refreshAll = async () => {
    setIsRefreshing(true);
    try {
      const [pkgRes, reqRes] = await Promise.all([
        fetch("/api/console/custom-themes/packages", { credentials: "same-origin" }),
        fetch("/api/console/custom-themes/requests", { credentials: "same-origin" }),
      ]);
      if (pkgRes.ok) {
        const data = (await pkgRes.json()) as { packages?: ConsoleCustomThemePackageDto[] };
        if (Array.isArray(data.packages)) setPackages(data.packages);
      }
      if (reqRes.ok) {
        const data = (await reqRes.json()) as { requests?: ConsoleCustomThemeRequestDto[] };
        if (Array.isArray(data.requests)) setRequests(data.requests);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreatePackage = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setNotice(null);
    setIsCreatingPkg(true);
    try {
      const inclusions = createInclusionsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const parsedPrice = createPriceText.trim()
        ? Number.parseInt(createPriceText.replace(/[^\d]/g, ""), 10)
        : null;
      const parsedSort = Number.parseInt(createSortOrder, 10);

      const res = await fetch("/api/console/custom-themes/packages", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceKind: "custom_theme",
          slug: createSlug.trim().toLowerCase(),
          name: createName.trim(),
          description: createDescription.trim(),
          inclusions,
          startingPriceIdr: Number.isFinite(parsedPrice ?? NaN) ? parsedPrice : null,
          estimatedDuration: createDuration.trim(),
          sortOrder: Number.isFinite(parsedSort) ? parsedSort : 0,
          active: createActive,
          reason: createReason.trim(),
        }),
      });

      const payload = (await res.json().catch(() => null)) as {
        success?: boolean;
        package?: ConsoleCustomThemePackageDto;
        auditId?: string;
        error?: { message?: string };
      } | null;

      if (!res.ok || !payload?.success || !payload.package) {
        setNotice({
          variant: "destructive",
          title: "Gagal Membuat Paket",
          message: payload?.error?.message ?? "Periksa kembali data paket dan status 2FA step-up.",
        });
        return;
      }

      const created = payload.package;
      setPackages((prev) =>
        [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug)),
      );
      setCreateSlug("");
      setCreateName("");
      setCreateDescription("");
      setCreateInclusionsText("");
      setCreatePriceText("");
      setCreateReason("");
      setNotice({
        variant: "success",
        title: `Paket "${created.name}" Dibuat`,
        message: `Tersimpan dengan audit ID ${payload.auditId ?? "-"}.`,
      });
    } finally {
      setIsCreatingPkg(false);
    }
  };

  const startEditPackage = (pkg: ConsoleCustomThemePackageDto) => {
    setEditingPkg(pkg);
    setEditName(pkg.name);
    setEditDescription(pkg.description);
    setEditInclusionsText(pkg.inclusions.join("\n"));
    setEditPriceText(pkg.startingPriceIdr !== null ? String(pkg.startingPriceIdr) : "");
    setEditDuration(pkg.estimatedDuration);
    setEditSortOrder(String(pkg.sortOrder));
    setEditReason("");
    setNotice(null);
  };

  const handleSaveEditPackage = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingPkg) return;
    setNotice(null);
    setIsSavingPkg(true);
    try {
      const inclusions = editInclusionsText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const parsedPrice = editPriceText.trim()
        ? Number.parseInt(editPriceText.replace(/[^\d]/g, ""), 10)
        : null;
      const parsedSort = Number.parseInt(editSortOrder, 10);

      const res = await fetch(
        `/api/console/custom-themes/packages/${encodeURIComponent(editingPkg.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: editingPkg.version,
            name: editName.trim(),
            description: editDescription.trim(),
            inclusions,
            startingPriceIdr: Number.isFinite(parsedPrice ?? NaN) ? parsedPrice : null,
            estimatedDuration: editDuration.trim(),
            sortOrder: Number.isFinite(parsedSort) ? parsedSort : editingPkg.sortOrder,
            reason: editReason.trim(),
          }),
        },
      );

      const payload = (await res.json().catch(() => null)) as {
        success?: boolean;
        package?: ConsoleCustomThemePackageDto;
        auditId?: string;
        error?: { message?: string };
      } | null;

      if (!res.ok || !payload?.success || !payload.package) {
        setNotice({
          variant: "destructive",
          title: "Gagal Memperbarui Paket",
          message: payload?.error?.message ?? "Perubahan paket ditolak.",
        });
        return;
      }

      const updated = payload.package;
      setPackages((prev) =>
        prev
          .map((item) => (item.id === updated.id ? updated : item))
          .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug)),
      );
      setEditingPkg(null);
      setNotice({
        variant: "success",
        title: `Paket "${updated.name}" Diperbarui (v${updated.version})`,
        message: `Tercatat pada log audit ${payload.auditId ?? "-"}.`,
      });
    } finally {
      setIsSavingPkg(false);
    }
  };

  const handleQuickPatchPackage = async (
    pkg: ConsoleCustomThemePackageDto,
    patch: { readonly active?: boolean; readonly sortOrder?: number },
    reason: string,
  ) => {
    setNotice(null);
    setIsSavingPkg(true);
    try {
      const res = await fetch(
        `/api/console/custom-themes/packages/${encodeURIComponent(pkg.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: pkg.version,
            ...patch,
            reason,
          }),
        },
      );
      const payload = (await res.json().catch(() => null)) as {
        success?: boolean;
        package?: ConsoleCustomThemePackageDto;
        auditId?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok || !payload?.success || !payload.package) {
        setNotice({
          variant: "destructive",
          title: "Aksi Paket Gagal",
          message: payload?.error?.message ?? "Tidak dapat mengubah status paket.",
        });
        return;
      }
      const updated = payload.package;
      setPackages((prev) =>
        prev
          .map((item) => (item.id === updated.id ? updated : item))
          .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug)),
      );
      setNotice({
        variant: "success",
        title: `Paket "${updated.name}" Diperbarui`,
        message: `Status sekarang: ${updated.active ? "Aktif" : "Nonaktif"} (urutan ${updated.sortOrder}, audit ${payload.auditId ?? "-"}).`,
      });
    } finally {
      setIsSavingPkg(false);
    }
  };

  const openTransitionEditor = (req: ConsoleCustomThemeRequestDto) => {
    setActiveTransitionReqId(req.id);
    setNextStatus(req.allowedNextStatuses[0] ?? "contacted");
    setTransitionReason("");
    setOperatorNotes(req.operatorNotes ?? "");
    setDeliveredThemeId(req.tenantCustomThemeGrants[0]?.themeId ?? "");
    setNotice(null);
  };

  const handleTransitionRequest = async (
    e: React.SyntheticEvent<HTMLFormElement>,
    req: ConsoleCustomThemeRequestDto,
  ) => {
    e.preventDefault();
    setNotice(null);
    setIsTransitioning(true);
    try {
      const res = await fetch(
        `/api/console/custom-themes/requests/${encodeURIComponent(req.id)}`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: req.version,
            status: nextStatus,
            reason: transitionReason.trim(),
            operatorNotes: operatorNotes.trim() || null,
            ...(nextStatus === "delivered"
              ? { deliveredThemeId: deliveredThemeId.trim() || null }
              : {}),
          }),
        },
      );
      const payload = (await res.json().catch(() => null)) as {
        success?: boolean;
        request?: ConsoleCustomThemeRequestDto;
        auditId?: string;
        error?: { message?: string };
      } | null;

      if (!res.ok || !payload?.success || !payload.request) {
        setNotice({
          variant: "destructive",
          title: "Transisi Status Ditolak",
          message: payload?.error?.message ?? "Gagal mengubah status permintaan.",
        });
        return;
      }

      const updated = payload.request;
      setRequests((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setActiveTransitionReqId(null);
      setNotice({
        variant: "success",
        title: `Permintaan ${updated.requestCode} -> ${updated.statusLabel}`,
        message: `Perubahan tersimpan secara atomik (audit ${payload.auditId ?? "-"}).`,
      });
    } finally {
      setIsTransitioning(false);
    }
  };

  const filteredRequests = React.useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    return requests.filter((req) => {
      if (statusFilter !== "all" && req.status !== statusFilter) return false;
      if (!q) return true;
      return (
        req.tenantHandle.toLowerCase().includes(q) ||
        req.requestCode.toLowerCase().includes(q) ||
        req.brandName.toLowerCase().includes(q) ||
        req.tenantId.toLowerCase().includes(q)
      );
    });
  }, [requests, statusFilter, tenantSearch]);

  return (
    <div className="space-y-5" data-testid="console-custom-themes-panel">
      {/* Top Toolbar & Tab Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex max-w-full flex-wrap gap-1 rounded-md border border-border bg-muted p-1"
          role="tablist"
          aria-label="Kelola paket dan permintaan tema kustom"
        >
          <Button
            type="button"
            size="sm"
            variant={activeTab === "packages" ? "default" : "ghost"}
            className="min-h-11 sm:min-h-9"
            aria-pressed={activeTab === "packages"}
            onClick={() => setActiveTab("packages")}
            data-testid="tab-console-packages"
          >
            <LayersIcon className="size-4 shrink-0" aria-hidden="true" />
            <span>Paket ({packages.length})</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeTab === "requests" ? "default" : "ghost"}
            className="min-h-11 sm:min-h-9"
            aria-pressed={activeTab === "requests"}
            onClick={() => setActiveTab("requests")}
            data-testid="tab-console-requests"
          >
            <PaletteIcon className="size-4 shrink-0" aria-hidden="true" />
            <span>Permintaan ({requests.length})</span>
          </Button>
        </div>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={refreshAll}
          disabled={isRefreshing}
          data-testid="btn-console-refresh"
        >
          <RefreshCwIcon
            className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span>{isRefreshing ? "Memuat..." : "Muat Ulang Data"}</span>
        </Button>
      </div>

      {!stepUpFresh && (
        <Alert variant="warning" data-testid="console-stepup-warning">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Verifikasi 2FA Step-Up Diperlukan untuk Mutasi</AlertTitle>
          <AlertDescription>
            Anda dapat meninjau paket dan permintaan, tetapi membuat/mengubah paket atau status
            permintaan memerlukan verifikasi TOTP ulang dalam 10 menit terakhir.
          </AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert
          variant={notice.variant}
          role={notice.variant === "destructive" ? "alert" : "status"}
          data-testid="console-custom-themes-notice"
        >
          {notice.variant === "success" ? (
            <CheckCircle2Icon aria-hidden="true" />
          ) : (
            <AlertCircleIcon aria-hidden="true" />
          )}
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}

      {/* TAB 1: Packages Management */}
      {activeTab === "packages" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Create Package Card */}
          <Card className="min-w-0 lg:col-span-5" data-testid="console-create-package-card">
            <CardHeader>
              <div className="flex items-center gap-2">
                <PackagePlusIcon className="size-5 text-primary" aria-hidden="true" />
                <CardTitle>Tambah Paket Baru</CardTitle>
              </div>
              <CardDescription>
                Harga mulai dalam IDR bersifat opsional (kosongkan untuk label{" "}
                <em>Harga berdasarkan penawaran</em>).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={handleCreatePackage}
                className="space-y-3"
                data-testid="console-create-package-form"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="pkg-slug" className="block text-xs font-medium text-foreground">
                      Slug Unik *
                    </label>
                    <Input
                      id="pkg-slug"
                      value={createSlug}
                      onChange={(e) => setCreateSlug(e.target.value)}
                      placeholder="brand-starter"
                      required
                      className="min-h-11 text-base sm:text-sm"
                      data-testid="input-pkg-slug"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="pkg-sort" className="block text-xs font-medium text-foreground">
                      Urutan Tampil *
                    </label>
                    <Input
                      id="pkg-sort"
                      type="number"
                      min={0}
                      max={10000}
                      value={createSortOrder}
                      onChange={(e) => setCreateSortOrder(e.target.value)}
                      required
                      className="min-h-11 text-base tabular-nums sm:text-sm"
                      data-testid="input-pkg-sort"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="pkg-name" className="block text-xs font-medium text-foreground">
                    Nama Paket *
                  </label>
                  <Input
                    id="pkg-name"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Tema Kustom Brand Korporat"
                    required
                    className="min-h-11 text-base sm:text-sm"
                    data-testid="input-pkg-name"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="pkg-desc" className="block text-xs font-medium text-foreground">
                    Deskripsi Paket *
                  </label>
                  <textarea
                    id="pkg-desc"
                    rows={3}
                    value={createDescription}
                    onChange={(e) => setCreateDescription(e.target.value)}
                    required
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    placeholder="Jelaskan profil klien dan keunggulan paket desain ini..."
                    data-testid="input-pkg-description"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="pkg-inc" className="block text-xs font-medium text-foreground">
                    Cakupan Paket (1 item per baris) *
                  </label>
                  <textarea
                    id="pkg-inc"
                    rows={3}
                    value={createInclusionsText}
                    onChange={(e) => setCreateInclusionsText(e.target.value)}
                    required
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    placeholder={"Desain beranda & 5 halaman inti\n2 putaran revisi\nOptimasi Core Web Vitals"}
                    data-testid="input-pkg-inclusions"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor="pkg-price"
                      className="block text-xs font-medium text-foreground"
                    >
                      Harga Mulai IDR (Kosong = Penawaran)
                    </label>
                    <Input
                      id="pkg-price"
                      type="text"
                      inputMode="numeric"
                      value={createPriceText}
                      onChange={(e) => setCreatePriceText(e.target.value)}
                      placeholder="3500000"
                      className="min-h-11 text-base tabular-nums sm:text-sm"
                      data-testid="input-pkg-price"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="pkg-duration"
                      className="block text-xs font-medium text-foreground"
                    >
                      Estimasi Durasi *
                    </label>
                    <Input
                      id="pkg-duration"
                      value={createDuration}
                      onChange={(e) => setCreateDuration(e.target.value)}
                      required
                      className="min-h-11 text-base sm:text-sm"
                      data-testid="input-pkg-duration"
                    />
                  </div>
                </div>

                <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={createActive}
                    onChange={(e) => setCreateActive(e.target.checked)}
                    className="size-4 accent-primary"
                    data-testid="checkbox-pkg-active"
                  />
                  <span>Langsung tampilkan paket sebagai aktif di dashboard tenant</span>
                </label>

                <div className="space-y-1">
                  <label htmlFor="pkg-reason" className="block text-xs font-medium text-foreground">
                    Alasan Audit (10–500 karakter) *
                  </label>
                  <Input
                    id="pkg-reason"
                    value={createReason}
                    onChange={(e) => setCreateReason(e.target.value)}
                    required
                    minLength={10}
                    maxLength={500}
                    placeholder="Penambahan katalog paket tema kustom Q4"
                    className="min-h-11 text-base sm:text-sm"
                    data-testid="input-pkg-reason"
                  />
                </div>

                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  disabled={isCreatingPkg}
                  data-testid="btn-create-package"
                >
                  <span>{isCreatingPkg ? "Menyimpan..." : "Simpan Paket Baru"}</span>
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing Packages List */}
          <div className="min-w-0 space-y-4 lg:col-span-7" data-testid="console-packages-list">
            {editingPkg && (
              <Card className="border-primary" data-testid="console-edit-package-card">
                <CardHeader>
                  <CardTitle className="text-base">
                    Ubah Paket: {editingPkg.name} (v{editingPkg.version})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSaveEditPackage} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          htmlFor="edit-pkg-name"
                          className="block text-xs font-medium text-foreground"
                        >
                          Nama Paket
                        </label>
                        <Input
                          id="edit-pkg-name"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          required
                          className="min-h-11 text-base sm:text-sm"
                          data-testid="input-edit-pkg-name"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor="edit-pkg-sort"
                          className="block text-xs font-medium text-foreground"
                        >
                          Urutan Tampil
                        </label>
                        <Input
                          id="edit-pkg-sort"
                          type="number"
                          min={0}
                          max={10000}
                          value={editSortOrder}
                          onChange={(e) => setEditSortOrder(e.target.value)}
                          required
                          className="min-h-11 text-base tabular-nums sm:text-sm"
                          data-testid="input-edit-pkg-sort"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="edit-pkg-desc"
                        className="block text-xs font-medium text-foreground"
                      >
                        Deskripsi
                      </label>
                      <textarea
                        id="edit-pkg-desc"
                        rows={2}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        required
                        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground sm:text-sm"
                      />
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="edit-pkg-inc"
                        className="block text-xs font-medium text-foreground"
                      >
                        Cakupan (1 per baris)
                      </label>
                      <textarea
                        id="edit-pkg-inc"
                        rows={3}
                        value={editInclusionsText}
                        onChange={(e) => setEditInclusionsText(e.target.value)}
                        required
                        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground sm:text-sm"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label
                          htmlFor="edit-pkg-price"
                          className="block text-xs font-medium text-foreground"
                        >
                          Harga Mulai IDR (Kosong = Penawaran)
                        </label>
                        <Input
                          id="edit-pkg-price"
                          value={editPriceText}
                          onChange={(e) => setEditPriceText(e.target.value)}
                          className="min-h-11 text-base tabular-nums sm:text-sm"
                          data-testid="input-edit-pkg-price"
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor="edit-pkg-duration"
                          className="block text-xs font-medium text-foreground"
                        >
                          Estimasi Durasi
                        </label>
                        <Input
                          id="edit-pkg-duration"
                          value={editDuration}
                          onChange={(e) => setEditDuration(e.target.value)}
                          required
                          className="min-h-11 text-base sm:text-sm"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="edit-pkg-reason"
                        className="block text-xs font-medium text-foreground"
                      >
                        Alasan Perubahan (10–500 karakter) *
                      </label>
                      <Input
                        id="edit-pkg-reason"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        required
                        minLength={10}
                        maxLength={500}
                        placeholder="Penyesuaian harga mulai dan ruang lingkup paket"
                        className="min-h-11 text-base sm:text-sm"
                        data-testid="input-edit-pkg-reason"
                      />
                    </div>

                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setEditingPkg(null)}
                      >
                        Batal
                      </Button>
                      <Button
                        type="submit"
                        className="min-h-11"
                        disabled={isSavingPkg}
                        data-testid="btn-save-edit-package"
                      >
                        <span>{isSavingPkg ? "Menyimpan..." : "Simpan Perubahan"}</span>
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {packages.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Belum ada paket tema kustom terdaftar. Tambahkan paket melalui formulir di
                  samping; jika kosong, halaman tenant otomatis menampilkan mode konsultasi saja.
                </CardContent>
              </Card>
            ) : (
              packages.map((pkg, index) => (
                <Card key={pkg.id} data-testid={`console-package-row-${pkg.slug}`}>
                  <CardHeader className="gap-1.5 pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="tabular-nums">
                          Urutan #{pkg.sortOrder}
                        </Badge>
                        <Badge variant={pkg.active ? "success" : "secondary"}>
                          {pkg.active ? "Aktif" : "Nonaktif"}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">
                          {pkg.slug} · v{pkg.version}
                        </span>
                      </div>
                      <span className="text-sm font-semibold text-primary tabular-nums">
                        {pkg.priceLabel}
                      </span>
                    </div>
                    <CardTitle className="text-base">{pkg.name}</CardTitle>
                    <CardDescription>
                      {pkg.description} · Estimasi: {pkg.estimatedDuration}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-foreground">
                      {pkg.inclusions.map((inc, idx) => (
                        <li key={`${pkg.id}-cinc-${idx}`}>{inc}</li>
                      ))}
                    </ul>
                  </CardContent>
                  <CardFooter className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      onClick={() => startEditPackage(pkg)}
                      data-testid={`btn-edit-pkg-${pkg.slug}`}
                    >
                      <PencilIcon className="size-3.5" aria-hidden="true" />
                      <span>Ubah</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      disabled={isSavingPkg || index === 0}
                      onClick={() =>
                        handleQuickPatchPackage(
                          pkg,
                          { sortOrder: Math.max(0, pkg.sortOrder - 1) },
                          `Memindahkan urutan paket ${pkg.slug} ke atas`,
                        )
                      }
                      aria-label={`Naikkan urutan ${pkg.name}`}
                    >
                      <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                      <span>Naik</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      disabled={isSavingPkg}
                      onClick={() =>
                        handleQuickPatchPackage(
                          pkg,
                          { sortOrder: pkg.sortOrder + 1 },
                          `Memindahkan urutan paket ${pkg.slug} ke bawah`,
                        )
                      }
                      aria-label={`Turunkan urutan ${pkg.name}`}
                    >
                      <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                      <span>Turun</span>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={pkg.active ? "destructive" : "default"}
                      className="min-h-11 sm:min-h-9"
                      disabled={isSavingPkg}
                      onClick={() =>
                        handleQuickPatchPackage(
                          pkg,
                          { active: !pkg.active },
                          pkg.active
                            ? `Menonaktifkan paket ${pkg.slug} tanpa menghapus riwayat permintaan`
                            : `Mengaktifkan kembali paket ${pkg.slug} pada layanan tenant`,
                        )
                      }
                      data-testid={`btn-toggle-pkg-${pkg.slug}`}
                    >
                      <PowerIcon className="size-3.5" aria-hidden="true" />
                      <span>{pkg.active ? "Nonaktifkan" : "Aktifkan"}</span>
                    </Button>
                  </CardFooter>
                </Card>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Requests Queue */}
      {activeTab === "requests" && (
        <div className="space-y-4" data-testid="console-requests-section">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="console-status-filter" className="sr-only">
                Filter status permintaan
              </label>
              <select
                id="console-status-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground sm:min-h-9"
                data-testid="select-console-status-filter"
              >
                <option value="all">Semua Status</option>
                {CUSTOM_THEME_REQUEST_STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {CUSTOM_THEME_STATUS_LABELS_ID[st]}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative w-full sm:w-72">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={tenantSearch}
                onChange={(e) => setTenantSearch(e.target.value)}
                placeholder="Cari handle, kode, atau brand..."
                aria-label="Cari permintaan tema kustom"
                className="min-h-11 pl-9 text-base sm:min-h-9 sm:text-sm"
                data-testid="input-console-request-search"
              />
            </div>
          </div>

          {filteredRequests.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Tidak ada permintaan tema kustom yang cocok dengan filter saat ini.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredRequests.map((req) => {
                const isEditingThis = activeTransitionReqId === req.id;
                const canTransition = req.allowedNextStatuses.length > 0;
                return (
                  <Card
                    key={req.id}
                    data-testid={`console-request-card-${req.requestCode}`}
                    data-status={req.status}
                  >
                    <CardHeader className="gap-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-foreground">
                            {req.requestCode}
                          </span>
                          <Badge variant={statusBadgeVariant(req.status)}>{req.statusLabel}</Badge>
                          <Badge variant="outline" className="font-mono text-xs">
                            {req.tenantHandle}
                          </Badge>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            v{req.version} · {formatDateTimeId(req.createdAt)}
                          </span>
                        </div>
                        {canTransition && !isEditingThis && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-11 sm:min-h-9"
                            onClick={() => openTransitionEditor(req)}
                            data-testid={`btn-open-transition-${req.requestCode}`}
                          >
                            <span>Ubah Status</span>
                          </Button>
                        )}
                      </div>
                      <CardTitle className="text-base">
                        {req.brandName} — {req.packageName}
                      </CardTitle>
                      <CardDescription>
                        Preferensi kontak: {req.contactPreference}
                        {req.budgetRange ? ` · Anggaran: ${req.budgetRange}` : ""}
                      </CardDescription>
                    </CardHeader>

                    <CardContent className="space-y-3 text-sm">
                      <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground">
                        {req.brief}
                      </p>

                      {req.referenceUrls.length > 0 && (
                        <div className="space-y-1 text-xs">
                          <p className="font-medium text-muted-foreground">
                            Referensi URL (HTTPS tervalidasi, tidak diambil otomatis oleh server):
                          </p>
                          <ul className="space-y-1">
                            {req.referenceUrls.map((url, idx) => (
                              <li key={`${req.id}-u-${idx}`} className="flex items-center gap-1.5">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="truncate text-primary underline-offset-2 hover:underline"
                                >
                                  {url}
                                </a>
                                <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Izin tema kustom aktif tenant:</span>
                        {req.tenantCustomThemeGrants.length === 0 ? (
                          <Badge variant="outline">Belum ada izin tema kustom</Badge>
                        ) : (
                          req.tenantCustomThemeGrants.map((g) => (
                            <Badge key={g.grantId} variant="success">
                              <ShieldCheckIcon className="size-3" aria-hidden="true" />
                              <span>
                                {g.name} ({g.themeId})
                              </span>
                            </Badge>
                          ))
                        )}
                      </div>

                      {req.deliveredThemeId && (
                        <p className="text-xs font-medium text-primary">
                          Tema diserahkan: <code>{req.deliveredThemeId}</code>
                        </p>
                      )}

                      {req.statusReason && (
                        <p className="text-xs text-muted-foreground">
                          Alasan status terakhir: <span className="text-foreground">{req.statusReason}</span>
                        </p>
                      )}

                      {isEditingThis && (
                        <>
                          <Separator />
                          <form
                            onSubmit={(e) => handleTransitionRequest(e, req)}
                            className="space-y-3 rounded-md border border-primary/40 bg-muted/30 p-3"
                            data-testid={`form-transition-${req.requestCode}`}
                          >
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div className="space-y-1">
                                <label
                                  htmlFor={`next-status-${req.id}`}
                                  className="block text-xs font-medium text-foreground"
                                >
                                  Status Baru *
                                </label>
                                <select
                                  id={`next-status-${req.id}`}
                                  value={nextStatus}
                                  onChange={(e) =>
                                    setNextStatus(e.target.value as CustomThemeRequestStatus)
                                  }
                                  className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground"
                                  data-testid={`select-next-status-${req.requestCode}`}
                                >
                                  {req.allowedNextStatuses.map((st) => (
                                    <option key={st} value={st}>
                                      {CUSTOM_THEME_STATUS_LABELS_ID[st]} ({st})
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {nextStatus === "delivered" && (
                                <div className="space-y-1">
                                  <label
                                    htmlFor={`delivered-theme-${req.id}`}
                                    className="block text-xs font-medium text-foreground"
                                  >
                                    Tautkan Tema Kustom Berizin *
                                  </label>
                                  {req.tenantCustomThemeGrants.length > 0 ? (
                                    <select
                                      id={`delivered-theme-${req.id}`}
                                      value={deliveredThemeId}
                                      onChange={(e) => setDeliveredThemeId(e.target.value)}
                                      required
                                      className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground"
                                      data-testid={`select-delivered-theme-${req.requestCode}`}
                                    >
                                      {req.tenantCustomThemeGrants.map((g) => (
                                        <option key={g.grantId} value={g.themeId}>
                                          {g.name} ({g.themeId})
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <Input
                                      id={`delivered-theme-${req.id}`}
                                      value={deliveredThemeId}
                                      onChange={(e) => setDeliveredThemeId(e.target.value)}
                                      placeholder="Belum ada izin tema kustom aktif"
                                      className="min-h-11 text-sm"
                                      data-testid={`input-delivered-theme-${req.requestCode}`}
                                    />
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="space-y-1">
                              <label
                                htmlFor={`reason-${req.id}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Alasan Audit (10–500 karakter) *
                              </label>
                              <Input
                                id={`reason-${req.id}`}
                                value={transitionReason}
                                onChange={(e) => setTransitionReason(e.target.value)}
                                required
                                minLength={10}
                                maxLength={500}
                                placeholder="Contoh: Penawaran disetujui dan tema kustom telah diberikan izin"
                                className="min-h-11 text-base sm:text-sm"
                                data-testid={`input-transition-reason-${req.requestCode}`}
                              />
                            </div>

                            <div className="space-y-1">
                              <label
                                htmlFor={`notes-${req.id}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Catatan Internal Operator (Opsional)
                              </label>
                              <Input
                                id={`notes-${req.id}`}
                                value={operatorNotes}
                                onChange={(e) => setOperatorNotes(e.target.value)}
                                maxLength={1000}
                                placeholder="Catatan tindak lanjut tim internal (tanpa rahasia/PII)"
                                className="min-h-11 text-base sm:text-sm"
                              />
                            </div>

                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                className="min-h-11"
                                onClick={() => setActiveTransitionReqId(null)}
                              >
                                Batal
                              </Button>
                              <Button
                                type="submit"
                                className="min-h-11"
                                disabled={isTransitioning}
                                data-testid={`btn-confirm-transition-${req.requestCode}`}
                              >
                                <span>{isTransitioning ? "Menyimpan..." : "Simpan Status"}</span>
                              </Button>
                            </div>
                          </form>
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
