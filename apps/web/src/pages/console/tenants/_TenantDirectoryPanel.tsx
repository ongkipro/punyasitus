import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  Building2Icon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ConsoleTenantDirectoryItem,
  ConsoleTenantDirectoryPage,
} from "@punyasitus/db/platform";

export interface TenantDirectoryPanelProps {
  readonly initialDirectory: ConsoleTenantDirectoryPage;
  readonly initialSearch: string;
  readonly initialStatus: string;
  readonly initialVertical: string;
  readonly saasZone: string;
  readonly stepUpFresh: boolean;
  readonly operatorEmail: string;
}

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "Semua Status" },
  { value: "active", label: "Aktif" },
  { value: "trial", label: "Uji Coba" },
  { value: "grace", label: "Masa Tenggang" },
  { value: "locked", label: "Terkunci" },
  { value: "suspended", label: "Ditangguhkan" },
  { value: "recovery", label: "Pemulihan" },
  { value: "purging", label: "Penghapusan" },
  { value: "purged", label: "Terhapus" },
] as const;

const VERTICAL_OPTIONS = [
  { value: "all", label: "Semua Vertikal" },
  { value: "compro", label: "Company Profile (compro)" },
  { value: "sales", label: "Jasa & Personal Brand (sales)" },
  { value: "travel", label: "Travel & Umrah (travel)" },
  { value: "catalog", label: "Katalog Produk (catalog)" },
  { value: "resto", label: "Resto & Gerai Offline (resto)" },
  { value: "dealer", label: "Showroom Kendaraan (dealer)" },
] as const;

const PROVISION_VERTICAL_OPTIONS = VERTICAL_OPTIONS.filter((v) => v.value !== "all");

function createUuidKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `prov-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function statusBadgeProps(
  effectiveStatus: string,
  operatorHold: boolean,
): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "destructive" | "success" | "warning";
} {
  if (operatorHold) {
    return { label: "Ditangguhkan (Hold)", variant: "destructive" };
  }
  switch (effectiveStatus) {
    case "active":
      return { label: "Aktif", variant: "success" };
    case "trial":
      return { label: "Uji Coba", variant: "secondary" };
    case "grace":
      return { label: "Masa Tenggang", variant: "warning" };
    case "locked":
      return { label: "Terkunci", variant: "destructive" };
    case "suspended":
      return { label: "Ditangguhkan", variant: "destructive" };
    case "recovery":
      return { label: "Pemulihan", variant: "warning" };
    case "purging":
      return { label: "Penghapusan", variant: "destructive" };
    case "purged":
      return { label: "Terhapus", variant: "outline" };
    default:
      return { label: effectiveStatus, variant: "outline" };
  }
}

function ownerStatusLabel(status: ConsoleTenantDirectoryItem["ownerStatus"]): string {
  switch (status) {
    case "active_member":
      return "Pemilik aktif";
    case "pending_invitation":
      return "Undangan tertunda";
    case "unassigned":
      return "Belum ada pemilik";
  }
}

export function TenantDirectoryPanel({
  initialDirectory,
  initialSearch,
  initialStatus,
  initialVertical,
  saasZone,
  stepUpFresh,
  operatorEmail,
}: TenantDirectoryPanelProps) {
  const [directory, setDirectory] = React.useState<ConsoleTenantDirectoryPage>(initialDirectory);
  const [searchInput, setSearchInput] = React.useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = React.useState(initialSearch);
  const [statusFilter, setStatusFilter] = React.useState(initialStatus);
  const [verticalFilter, setVerticalFilter] = React.useState(initialVertical);
  const [page, setPage] = React.useState(initialDirectory.page);
  const [loading, setLoading] = React.useState(false);

  const [listError, setListError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [bannerSuccess, setBannerSuccess] = React.useState<{
    readonly message: string;
    readonly createdHandle?: string;
  } | null>(null);

  // Provision Modal state
  const [provisionOpen, setProvisionOpen] = React.useState(false);
  const [provName, setProvName] = React.useState("");
  const [provHandle, setProvHandle] = React.useState("");
  const [provOwnerEmail, setProvOwnerEmail] = React.useState("");
  const [provVertical, setProvVertical] =
    React.useState<ConsoleTenantDirectoryItem["vertical"]>("compro");
  const [provInitialStatus, setProvInitialStatus] = React.useState<"trial" | "active">("trial");
  const [provReason, setProvReason] = React.useState("");
  const [provIdempKey, setProvIdempKey] = React.useState(() => createUuidKey());
  const [provFieldError, setProvFieldError] = React.useState<string | null>(null);
  const [provServerError, setProvServerError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [provSubmitting, setProvSubmitting] = React.useState(false);

  const hasActiveFilters =
    appliedSearch.trim().length > 0 || statusFilter !== "all" || verticalFilter !== "all";

  const totalAllTenants = React.useMemo(
    () => Object.values(directory.statusCounts).reduce((acc, n) => acc + n, 0),
    [directory.statusCounts],
  );

  async function fetchDirectory(params: {
    readonly search: string;
    readonly status: string;
    readonly vertical: string;
    readonly page: number;
  }) {
    setLoading(true);
    setListError(null);

    const qs = new URLSearchParams();
    if (params.search.trim()) qs.set("search", params.search.trim());
    if (params.status && params.status !== "all") qs.set("status", params.status);
    if (params.vertical && params.vertical !== "all") qs.set("vertical", params.vertical);
    qs.set("page", String(params.page));
    qs.set("limit", String(directory.limit));

    try {
      const res = await fetch(`/api/console/tenants?${qs.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as Partial<ConsoleTenantDirectoryPage> & {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
      };

      if (!res.ok || !data.success || !Array.isArray(data.items)) {
        setListError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal memuat direktori tenant dari PLATFORM_DB.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setDirectory({
        items: data.items,
        page: data.page ?? params.page,
        limit: data.limit ?? directory.limit,
        totalCount: data.totalCount ?? data.items.length,
        totalPages: data.totalPages ?? 1,
        hasMore: Boolean(data.hasMore),
        statusCounts: data.statusCounts ?? directory.statusCounts,
      });
      setPage(data.page ?? params.page);
    } catch {
      setListError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat direktori tenant. Silakan coba lagi.",
      });
    } finally {
      setLoading(false);
    }
  }

  function handleFilterSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedSearch(searchInput.trim());
    void fetchDirectory({
      search: searchInput.trim(),
      status: statusFilter,
      vertical: verticalFilter,
      page: 1,
    });
  }

  function handleResetFilters() {
    setSearchInput("");
    setAppliedSearch("");
    setStatusFilter("all");
    setVerticalFilter("all");
    void fetchDirectory({
      search: "",
      status: "all",
      vertical: "all",
      page: 1,
    });
  }

  async function handleProvisionSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setProvFieldError(null);
    setProvServerError(null);

    const trimmedName = provName.trim();
    const trimmedHandle = provHandle.trim().toLowerCase();
    const trimmedEmail = provOwnerEmail.trim().toLowerCase();
    const trimmedReason = provReason.trim();
    const trimmedIdemp = provIdempKey.trim();

    if (trimmedName.length < 2) {
      setProvFieldError("Nama bisnis / situs wajib diisi minimal 2 karakter.");
      return;
    }
    if (trimmedHandle.length < 3 || trimmedHandle.length > 40) {
      setProvFieldError("Handle situs wajib 3 hingga 40 karakter (huruf kecil, angka, tanda hubung).");
      return;
    }
    if (!trimmedEmail.includes("@")) {
      setProvFieldError("Email pemilik situs wajib berformat valid.");
      return;
    }
    if (trimmedReason.length < 10) {
      setProvFieldError("Alasan operasional audit wajib diisi minimal 10 karakter (tanpa rahasia/PII).");
      return;
    }
    if (trimmedIdemp.length < 8) {
      setProvFieldError("Kunci idempotensi wajib minimal 8 karakter.");
      return;
    }

    setProvSubmitting(true);
    try {
      const res = await fetch("/api/console/tenants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": trimmedIdemp,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          name: trimmedName,
          handle: trimmedHandle,
          ownerEmail: trimmedEmail,
          vertical: provVertical,
          initialStatus: provInitialStatus,
          reason: trimmedReason,
          idempotencyKey: trimmedIdemp,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        replayed?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
        tenant?: { readonly handle: string; readonly name: string; readonly primaryHost: string };
      };

      if (!res.ok || !data.success || !data.tenant) {
        setProvServerError({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Provisioning tenant gagal diproses.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      const created = data.tenant;
      setProvisionOpen(false);
      setBannerSuccess({
        message: data.replayed
          ? `Replay idempoten: tenant "${created.name}" (${created.primaryHost}) dikembalikan tanpa duplikasi.`
          : `Tenant "${created.name}" (${created.primaryHost}) berhasil dibuat secara atomik dan dicatat pada audit log.`,
        createdHandle: created.handle,
      });

      if (!data.replayed) {
        setProvName("");
        setProvHandle("");
        setProvOwnerEmail("");
        setProvReason("");
        setProvIdempKey(createUuidKey());
      }

      await fetchDirectory({
        search: appliedSearch,
        status: statusFilter,
        vertical: verticalFilter,
        page: 1,
      });
    } catch {
      setProvServerError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat provisioning tenant. Isian Anda tetap dipertahankan.",
      });
    } finally {
      setProvSubmitting(false);
    }
  }

  const normalizedHandlePreview = provHandle.trim().toLowerCase() || "nama-bisnis";

  return (
    <div className="space-y-5" data-testid="console-tenants-directory-panel">
      {/* Header Row */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Direktori Tenant &amp; Operasi Terbatas
          </h1>
          <p className="text-sm text-muted-foreground">
            Telusuri metadata control-plane <code className="font-mono">PLATFORM_DB</code>, lakukan
            provisioning atomik, atau buka detail tenant untuk transisi status &amp; izin tema
            kustom. Operator aktif: <span className="font-mono text-foreground">{operatorEmail}</span>.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() =>
              void fetchDirectory({
                search: appliedSearch,
                status: statusFilter,
                vertical: verticalFilter,
                page,
              })
            }
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            data-testid="tenants-refresh-btn"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            Muat Ulang
          </Button>
          <Button
            type="button"
            onClick={() => {
              setProvFieldError(null);
              setProvServerError(null);
              setProvisionOpen(true);
            }}
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            data-testid="open-provision-modal-btn"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Provision Tenant Baru
          </Button>
        </div>
      </header>

      {!stepUpFresh && (
        <Alert variant="warning" data-testid="tenants-reauth-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk mutasi</AlertTitle>
          <AlertDescription>
            Membaca direktori tenant tersedia, namun provisioning, transisi status, dan izin tema
            memerlukan verifikasi 2FA dalam 10 menit terakhir.{" "}
            <a
              href="/auth/two-factor?mode=verify&next=%2Fconsole%2Ftenants"
              className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {listError && (
        <Alert variant="destructive" data-testid="tenants-list-error" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat direktori tenant ({listError.code})</AlertTitle>
          <AlertDescription>
            <span>{listError.message}</span>{" "}
            {listError.verifyPath ? (
              <a
                href={`${listError.verifyPath}&next=${encodeURIComponent("/console/tenants")}`}
                className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
              >
                Buka verifikasi 2FA
              </a>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void fetchDirectory({
                    search: appliedSearch,
                    status: statusFilter,
                    vertical: verticalFilter,
                    page,
                  })
                }
                className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
              >
                Coba lagi
              </button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {bannerSuccess && (
        <Alert variant="success" role="status" data-testid="tenants-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Operasi tenant berhasil</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{bannerSuccess.message}</span>
            {bannerSuccess.createdHandle && (
              <a
                href={`/console/tenants/${encodeURIComponent(bannerSuccess.createdHandle)}`}
                className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 md:min-h-0"
                data-testid="provision-success-detail-link"
              >
                Buka detail tenant &rarr;
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* KPI Strip */}
      <section
        aria-label="Ringkasan status tenant"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <Card size="sm">
          <CardHeader>
            <CardDescription>Total Tenant</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="kpi-total-tenants">
              {totalAllTenants}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Aktif</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="kpi-active-tenants">
              {directory.statusCounts.active ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Uji Coba (Trial)</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="kpi-trial-tenants">
              {directory.statusCounts.trial ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Ditangguhkan / Pemulihan</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="kpi-suspended-tenants">
              {(directory.statusCounts.suspended ?? 0) + (directory.statusCounts.recovery ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
      </section>

      {/* Search & Filters */}
      <Card>
        <CardContent className="pt-4">
          <form
            onSubmit={handleFilterSubmit}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-end"
            data-testid="tenants-filter-form"
          >
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
              <label
                htmlFor="tenants-search-input"
                className="block text-xs font-medium text-foreground"
              >
                Cari nama bisnis, handle, ID, atau hostname
              </label>
              <div className="relative">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="tenants-search-input"
                  name="search"
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Contoh: nusantara, toko-kopi, atau 01J..."
                  className="pl-9"
                  data-testid="tenants-search-input"
                />
              </div>
            </div>

            <div className="space-y-1.5 lg:col-span-3">
              <label
                htmlFor="tenants-status-filter"
                className="block text-xs font-medium text-foreground"
              >
                Status Layanan
              </label>
              <select
                id="tenants-status-filter"
                name="status"
                value={statusFilter}
                onChange={(e) => {
                  const next = e.target.value;
                  setStatusFilter(next);
                  void fetchDirectory({
                    search: searchInput.trim(),
                    status: next,
                    vertical: verticalFilter,
                    page: 1,
                  });
                }}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                data-testid="tenants-status-filter"
              >
                {STATUS_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5 lg:col-span-2">
              <label
                htmlFor="tenants-vertical-filter"
                className="block text-xs font-medium text-foreground"
              >
                Vertikal
              </label>
              <select
                id="tenants-vertical-filter"
                name="vertical"
                value={verticalFilter}
                onChange={(e) => {
                  const next = e.target.value;
                  setVerticalFilter(next);
                  void fetchDirectory({
                    search: searchInput.trim(),
                    status: statusFilter,
                    vertical: next,
                    page: 1,
                  });
                }}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                data-testid="tenants-vertical-filter"
              >
                {VERTICAL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row lg:col-span-3">
              <Button
                type="submit"
                disabled={loading}
                className="min-h-11 flex-1 md:min-h-9"
                data-testid="tenants-search-submit"
              >
                Terapkan
              </Button>
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResetFilters}
                  className="min-h-11 flex-1 md:min-h-9"
                  data-testid="tenants-reset-filters-btn"
                >
                  Reset
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Tenant Directory Table & Mobile Cards */}
      <Card data-testid="tenants-directory-card">
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Daftar Tenant Terdaftar</CardTitle>
              <CardDescription>
                Menampilkan metadata control plane saja — tanpa akses ke halaman, artikel, katalog,
                atau pesan pengunjung tenant.
              </CardDescription>
            </div>
            <Badge variant="outline" className="tabular-nums" data-testid="tenants-total-badge">
              {directory.totalCount} hasil
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 p-4" data-testid="tenants-loading-skeleton">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : directory.items.length === 0 ? (
            <div className="space-y-3 p-6 text-center" data-testid="tenants-empty-state">
              <Building2Icon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {hasActiveFilters
                    ? "Tidak ada tenant yang cocok dengan filter"
                    : "Belum ada tenant terdaftar"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {hasActiveFilters
                    ? "Ubah kata kunci pencarian atau reset filter untuk melihat seluruh tenant."
                    : "Buat tenant pertama secara atomik menggunakan tombol Provision Tenant Baru."}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {hasActiveFilters ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleResetFilters}
                    className="min-h-11 md:min-h-9"
                    data-testid="tenants-empty-reset-btn"
                  >
                    Reset Filter
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => setProvisionOpen(true)}
                    className="min-h-11 md:min-h-9"
                  >
                    Provision Tenant Baru
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="tenants-desktop-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bisnis &amp; Handle</TableHead>
                      <TableHead>Host Primer</TableHead>
                      <TableHead>Pemilik</TableHead>
                      <TableHead>Status Layanan</TableHead>
                      <TableHead className="hidden lg:table-cell">Tema Kustom</TableHead>
                      <TableHead className="text-right">Versi &amp; Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {directory.items.map((item) => {
                      const badge = statusBadgeProps(item.effectiveStatus, item.operatorHold);
                      return (
                        <TableRow
                          key={item.id}
                          data-testid={`tenant-row-${item.handle}`}
                          data-tenant-handle={item.handle}
                        >
                          <TableCell>
                            <div className="space-y-0.5">
                              <a
                                href={`/console/tenants/${encodeURIComponent(item.handle)}`}
                                className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                {item.name}
                              </a>
                              <p className="font-mono text-xs text-muted-foreground">
                                @{item.handle} · {item.vertical}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <p className="font-mono text-xs text-foreground">{item.primaryHost}</p>
                            {item.customDomainsCount > 0 && (
                              <p className="text-xs text-muted-foreground tabular-nums">
                                +{item.customDomainsCount} domain kustom
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground">{item.ownerEmail ?? "—"}</p>
                            <p className="text-xs text-muted-foreground">
                              {ownerStatusLabel(item.ownerStatus)}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </TableCell>
                          <TableCell className="hidden tabular-nums text-xs text-muted-foreground lg:table-cell">
                            {item.grantedCustomThemesCount} tema
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center justify-end gap-2">
                              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                v{item.version}
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                render={
                                  <a
                                    href={`/console/tenants/${encodeURIComponent(item.handle)}`}
                                    data-testid={`tenant-detail-link-${item.handle}`}
                                  />
                                }
                              >
                                <span>Kelola</span>
                                <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card stack (< md) — guarantees zero horizontal overflow at 360px */}
              <ul className="divide-y divide-border md:hidden" data-testid="tenants-mobile-list">
                {directory.items.map((item) => {
                  const badge = statusBadgeProps(item.effectiveStatus, item.operatorHold);
                  return (
                    <li
                      key={item.id}
                      className="space-y-2.5 px-4 py-3.5"
                      data-testid={`tenant-card-${item.handle}`}
                      data-tenant-handle={item.handle}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">{item.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {item.primaryHost}
                          </p>
                        </div>
                        <Badge variant={badge.variant} className="shrink-0">
                          {badge.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                        <span>@{item.handle}</span>
                        <span>Vertikal: {item.vertical}</span>
                        <span>Tema kustom: {item.grantedCustomThemesCount}</span>
                        <span>v{item.version}</span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        Pemilik: {item.ownerEmail ?? "—"} ({ownerStatusLabel(item.ownerStatus)})
                      </p>
                      <Button
                        variant="outline"
                        className="min-h-11 w-full justify-between"
                        render={
                          <a
                            href={`/console/tenants/${encodeURIComponent(item.handle)}`}
                            data-testid={`tenant-mobile-detail-link-${item.handle}`}
                          />
                        }
                      >
                        <span>Buka Detail &amp; Operasi Tenant</span>
                        <ArrowRightIcon className="size-4" aria-hidden="true" />
                      </Button>
                    </li>
                  );
                })}
              </ul>

              {/* Pagination Footer */}
              <div
                className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid="tenants-pagination"
              >
                <p className="text-xs text-muted-foreground tabular-nums">
                  Halaman {directory.page} dari {directory.totalPages} · Total {directory.totalCount}{" "}
                  tenant
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || directory.page <= 1}
                    onClick={() =>
                      void fetchDirectory({
                        search: appliedSearch,
                        status: statusFilter,
                        vertical: verticalFilter,
                        page: Math.max(1, directory.page - 1),
                      })
                    }
                    className="min-h-11 flex-1 sm:flex-none md:min-h-8"
                    data-testid="tenants-prev-page-btn"
                  >
                    <ChevronLeftIcon className="size-4" aria-hidden="true" />
                    Sebelumnya
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || !directory.hasMore}
                    onClick={() =>
                      void fetchDirectory({
                        search: appliedSearch,
                        status: statusFilter,
                        vertical: verticalFilter,
                        page: directory.page + 1,
                      })
                    }
                    className="min-h-11 flex-1 sm:flex-none md:min-h-8"
                    data-testid="tenants-next-page-btn"
                  >
                    Berikutnya
                    <ChevronRightIcon className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Accessible Base UI Provision Tenant Modal (Escape + focus return, zero Radix) */}
      <Dialog.Root open={provisionOpen} onOpenChange={setProvisionOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="provision-tenant-modal"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold text-foreground">
                  Provision Tenant Baru
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Membuat organisasi, tenant, subdomain primer{" "}
                  <code className="font-mono">.{saasZone}</code>, penetapan pemilik, dan catatan
                  audit secara atomik.
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup modal provisioning"
                    data-testid="provision-modal-close-btn"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              onSubmit={handleProvisionSubmit}
              noValidate
              className="mt-4 space-y-3.5"
              data-testid="provision-tenant-form"
            >
              {provFieldError && (
                <Alert variant="destructive" data-testid="provision-field-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Periksa isian formulir</AlertTitle>
                  <AlertDescription>{provFieldError}</AlertDescription>
                </Alert>
              )}

              {provServerError && (
                <Alert variant="destructive" data-testid="provision-server-error">
                  <ShieldAlertIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Provisioning ditolak ({provServerError.code})</AlertTitle>
                  <AlertDescription>
                    <span>{provServerError.message}</span>
                    {provServerError.verifyPath && (
                      <>
                        {" "}
                        <a
                          href={`${provServerError.verifyPath}&next=${encodeURIComponent("/console/tenants")}`}
                          className="font-medium underline underline-offset-4"
                        >
                          Verifikasi ulang 2FA
                        </a>
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label htmlFor="modal-prov-name" className="block text-sm font-medium">
                  Nama Bisnis / Situs
                </label>
                <Input
                  id="modal-prov-name"
                  name="name"
                  type="text"
                  value={provName}
                  onChange={(e) => setProvName(e.target.value)}
                  placeholder="Contoh: PT Karya Mandiri"
                  disabled={provSubmitting}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="modal-prov-handle" className="block text-sm font-medium">
                  Handle Situs (permanen)
                </label>
                <Input
                  id="modal-prov-handle"
                  name="handle"
                  type="text"
                  value={provHandle}
                  onChange={(e) => setProvHandle(e.target.value)}
                  placeholder="karya-mandiri"
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={provSubmitting}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Alamat primer:{" "}
                  <span className="font-mono text-foreground">
                    https://{normalizedHandlePreview}.{saasZone}
                  </span>
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="modal-prov-email" className="block text-sm font-medium">
                  Email Pemilik Situs
                </label>
                <Input
                  id="modal-prov-email"
                  name="ownerEmail"
                  type="email"
                  value={provOwnerEmail}
                  onChange={(e) => setProvOwnerEmail(e.target.value)}
                  placeholder="pemilik@bisnis.id"
                  disabled={provSubmitting}
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="modal-prov-vertical" className="block text-sm font-medium">
                    Vertikal / Tema Awal
                  </label>
                  <select
                    id="modal-prov-vertical"
                    name="vertical"
                    value={provVertical}
                    onChange={(e) =>
                      setProvVertical(e.target.value as ConsoleTenantDirectoryItem["vertical"])
                    }
                    disabled={provSubmitting}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    {PROVISION_VERTICAL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="modal-prov-status" className="block text-sm font-medium">
                    Status Awal Layanan
                  </label>
                  <select
                    id="modal-prov-status"
                    name="initialStatus"
                    value={provInitialStatus}
                    onChange={(e) =>
                      setProvInitialStatus(e.target.value === "active" ? "active" : "trial")
                    }
                    disabled={provSubmitting}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                  >
                    <option value="trial">Uji Coba 7 Hari (trial)</option>
                    <option value="active">Aktif Terverifikasi (active)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="modal-prov-reason" className="block text-sm font-medium">
                  Alasan Operasional Audit (10–500 karakter)
                </label>
                <Input
                  id="modal-prov-reason"
                  name="reason"
                  type="text"
                  value={provReason}
                  onChange={(e) => setProvReason(e.target.value)}
                  placeholder="Contoh: Onboarding klien korporasi sesuai tiket #OPS-204"
                  disabled={provSubmitting}
                  required
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="modal-prov-idemp"
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    Kunci Idempotensi (Idempotency-Key)
                  </label>
                  <button
                    type="button"
                    onClick={() => setProvIdempKey(createUuidKey())}
                    className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
                  >
                    Buat kunci baru
                  </button>
                </div>
                <Input
                  id="modal-prov-idemp"
                  name="idempotencyKey"
                  type="text"
                  value={provIdempKey}
                  onChange={(e) => setProvIdempKey(e.target.value)}
                  className="font-mono text-xs"
                  disabled={provSubmitting}
                />
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={provSubmitting}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  disabled={provSubmitting}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="provision-submit-btn"
                >
                  {provSubmitting ? "Memproses provisioning..." : "Buat Tenant Secara Atomik"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
