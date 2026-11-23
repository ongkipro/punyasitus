import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircleIcon,
  ArrowLeftRightIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  LockIcon,
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
  ConsoleDomainQueueItem,
  ConsoleDomainQueuePage,
} from "@punyasitus/db/platform";

export interface ConsoleDomainsPanelProps {
  readonly initialQueue: ConsoleDomainQueuePage;
  readonly initialStatus: string;
  readonly initialSearch: string;
  readonly initialTenantId: string;
  readonly saasZone: string;
  readonly stepUpFresh: boolean;
}

const DOMAIN_STATUS_FILTERS = [
  { value: "all", label: "Semua Domain" },
  { value: "exceptions", label: "Kendala & Tertahan" },
  { value: "failed", label: "Gagal (Failed)" },
  { value: "moved", label: "Dipindahkan (Moved)" },
  { value: "deleting", label: "Sedang Dihapus" },
  { value: "pending", label: "Menunggu Verifikasi" },
  { value: "active", label: "Aktif" },
] as const;

function createIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatEpoch(ms: number | null): string {
  if (!ms) return "Belum diperiksa";
  try {
    const formatted = new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
    return `${formatted} WIB`;
  } catch {
    return new Date(ms).toISOString();
  }
}

function domainStatusBadge(status: ConsoleDomainQueueItem["status"]): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "destructive" | "success" | "warning";
} {
  switch (status) {
    case "active":
      return { label: "Aktif", variant: "success" };
    case "pending":
      return { label: "Menunggu", variant: "warning" };
    case "failed":
      return { label: "Gagal", variant: "destructive" };
    case "moved":
      return { label: "Moved", variant: "destructive" };
    case "deleting":
      return { label: "Menghapus", variant: "secondary" };
  }
}

function subStateBadge(state: "active" | "pending" | "error", prefix: string): {
  readonly label: string;
  readonly variant: "success" | "warning" | "destructive";
} {
  if (state === "active") return { label: `${prefix}: Aktif`, variant: "success" };
  if (state === "error") return { label: `${prefix}: Gagal`, variant: "destructive" };
  return { label: `${prefix}: Pending`, variant: "warning" };
}

export function ConsoleDomainsPanel({
  initialQueue,
  initialStatus,
  initialSearch,
  initialTenantId,
  saasZone,
  stepUpFresh,
}: ConsoleDomainsPanelProps) {
  const [queue, setQueue] = React.useState<ConsoleDomainQueuePage>(initialQueue);
  const [statusFilter, setStatusFilter] = React.useState(initialStatus);
  const [searchInput, setSearchInput] = React.useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = React.useState(initialSearch);
  const [tenantIdFilter] = React.useState(initialTenantId);
  const [page, setPage] = React.useState(initialQueue.page);
  const [loading, setLoading] = React.useState(false);

  const [listError, setListError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [bannerSuccess, setBannerSuccess] = React.useState<string | null>(null);
  const [bannerPending, setBannerPending] = React.useState<string | null>(null);

  // Recheck Dialog state
  const [recheckTarget, setRecheckTarget] = React.useState<ConsoleDomainQueueItem | null>(null);
  const [recheckReason, setRecheckReason] = React.useState("");
  const [recheckSubmitting, setRecheckSubmitting] = React.useState(false);
  const [recheckError, setRecheckError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const recheckIdempRef = React.useRef<string | null>(null);

  // Domain Change Dialog state (REQ-065 remove locked + connect new)
  const [changeTarget, setChangeTarget] = React.useState<ConsoleDomainQueueItem | null>(null);
  const [changeConfirmHost, setChangeConfirmHost] = React.useState("");
  const [changeConfirmLocked, setChangeConfirmLocked] = React.useState(false);
  const [changeRemoveSet, setChangeRemoveSet] = React.useState(true);
  const [changeNewHost, setChangeNewHost] = React.useState("");
  const [changeMode, setChangeMode] = React.useState<
    "new_domain" | "zero_downtime_migration" | "cloudflare_o2o"
  >("new_domain");
  const [changeConfirmApex, setChangeConfirmApex] = React.useState(false);
  const [changeReason, setChangeReason] = React.useState("");
  const [changeSubmitting, setChangeSubmitting] = React.useState(false);
  const [changeError, setChangeError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const changeIdempRef = React.useRef<string | null>(null);

  const fetchQueue = React.useCallback(
    async (opts: {
      readonly status: string;
      readonly search: string;
      readonly page: number;
    }) => {
      setLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams();
        if (opts.status && opts.status !== "all") params.set("status", opts.status);
        if (opts.search.trim()) params.set("search", opts.search.trim());
        if (tenantIdFilter) params.set("tenantId", tenantIdFilter);
        params.set("page", String(opts.page));
        params.set("limit", String(initialQueue.limit));

        const res = await fetch(`/api/console/domains?${params.toString()}`, {
          credentials: "same-origin",
        });
        const data = (await res.json().catch(() => null)) as
          | (ConsoleDomainQueuePage & { readonly success: true })
          | {
              readonly success: false;
              readonly code?: string;
              readonly message?: string;
              readonly verifyPath?: string;
            }
          | null;

        if (!res.ok || !data || !("success" in data) || !data.success) {
          setListError({
            code: data && "code" in data && data.code ? data.code : `HTTP_${res.status}`,
            message:
              (data && "message" in data && data.message) ||
              "Gagal memuat antrean pemulihan domain.",
            verifyPath: data && "verifyPath" in data ? data.verifyPath : undefined,
          });
          return;
        }
        setQueue(data);
        setPage(data.page);
      } catch {
        setListError({
          code: "NETWORK_ERROR",
          message: "Gagal menghubungi server console. Periksa koneksi lalu coba lagi.",
        });
      } finally {
        setLoading(false);
      }
    },
    [initialQueue.limit, tenantIdFilter],
  );

  function handleSearchSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setAppliedSearch(searchInput.trim());
    void fetchQueue({ status: statusFilter, search: searchInput.trim(), page: 1 });
  }

  function handleResetFilters() {
    setSearchInput("");
    setAppliedSearch("");
    setStatusFilter("all");
    void fetchQueue({ status: "all", search: "", page: 1 });
  }

  function openRecheckDialog(item: ConsoleDomainQueueItem) {
    setRecheckTarget(item);
    setRecheckReason("");
    setRecheckError(null);
    recheckIdempRef.current = createIdempotencyKey("dom-recheck");
  }

  function openChangeDialog(item: ConsoleDomainQueueItem) {
    setChangeTarget(item);
    setChangeConfirmHost("");
    setChangeConfirmLocked(false);
    setChangeRemoveSet(true);
    setChangeNewHost("");
    setChangeMode("new_domain");
    setChangeConfirmApex(false);
    setChangeReason("");
    setChangeError(null);
    changeIdempRef.current = createIdempotencyKey("dom-change");
  }

  async function submitRecheck(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!recheckTarget) return;
    const trimmedReason = recheckReason.trim();
    if (trimmedReason.length < 10) {
      setRecheckError({
        code: "VALIDATION_ERROR",
        message: "Alasan operasional wajib diisi minimal 10 karakter.",
      });
      return;
    }

    setRecheckSubmitting(true);
    setRecheckError(null);
    setBannerSuccess(null);
    setBannerPending(null);

    const idempotencyKey = recheckIdempRef.current ?? createIdempotencyKey("dom-recheck");
    recheckIdempRef.current = idempotencyKey;

    try {
      const res = await fetch("/api/console/domains/recheck", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          tenantId: recheckTarget.tenantId,
          hostname: recheckTarget.hostname,
          expectedVersion: recheckTarget.version,
          reason: trimmedReason,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        readonly success?: boolean;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
        readonly reconciliationPending?: boolean;
        readonly domain?: ConsoleDomainQueueItem;
      } | null;

      if (res.status === 503 && data?.reconciliationPending) {
        setBannerPending(
          data.message ??
            `Pemeriksaan ${recheckTarget.hostname} tertunda karena gangguan penyedia. Status tetap pending dan aman diulang.`,
        );
        setRecheckTarget(null);
        await fetchQueue({ status: statusFilter, search: appliedSearch, page });
        return;
      }

      if (!res.ok || !data?.success) {
        setRecheckError({
          code: data?.code ?? `HTTP_${res.status}`,
          message: data?.message ?? "Gagal melakukan pemeriksaan ulang domain.",
          verifyPath: data?.verifyPath,
        });
        return;
      }

      setBannerSuccess(
        `Domain ${recheckTarget.hostname} berhasil diperiksa ulang (status: ${data.domain?.status ?? recheckTarget.status}) dan tercatat di audit log.`,
      );
      setRecheckTarget(null);
      await fetchQueue({ status: statusFilter, search: appliedSearch, page });
    } catch {
      setRecheckError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat memeriksa ulang domain.",
      });
    } finally {
      setRecheckSubmitting(false);
    }
  }

  async function submitDomainChange(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changeTarget) return;

    const trimmedReason = changeReason.trim();
    if (trimmedReason.length < 10) {
      setChangeError({
        code: "VALIDATION_ERROR",
        message: "Alasan operasional wajib diisi minimal 10 karakter.",
      });
      return;
    }
    if (changeConfirmHost.trim().toLowerCase() !== changeTarget.hostname) {
      setChangeError({
        code: "DOMAIN_CHANGE_CONFIRMATION_REQUIRED",
        message: `Ketik persis "${changeTarget.hostname}" untuk mengonfirmasi penghapusan.`,
      });
      return;
    }
    if (!changeConfirmLocked) {
      setChangeError({
        code: "DOMAIN_CHANGE_CONFIRMATION_REQUIRED",
        message: "Centang kotak konfirmasi penghapusan domain terkunci sebelum melanjutkan.",
      });
      return;
    }

    setChangeSubmitting(true);
    setChangeError(null);
    setBannerSuccess(null);
    setBannerPending(null);

    const idempotencyKey = changeIdempRef.current ?? createIdempotencyKey("dom-change");
    changeIdempRef.current = idempotencyKey;

    const cleanNewHost = changeNewHost.trim().toLowerCase();
    const payload: Record<string, unknown> = {
      tenantId: changeTarget.tenantId,
      hostname: changeTarget.hostname,
      confirmHostname: changeConfirmHost.trim(),
      confirmRemoveLocked: true,
      removeDomainSet: changeRemoveSet,
      expectedVersion: changeTarget.version,
      reason: trimmedReason,
    };
    if (cleanNewHost) {
      payload.newHostname = cleanNewHost;
      payload.connectMode = changeMode;
      if (changeConfirmApex) {
        payload.confirmApexFlattening = true;
      }
    }

    try {
      const res = await fetch("/api/console/domains/change", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as {
        readonly success?: boolean;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
        readonly cleanupPending?: boolean;
        readonly reconciliationPending?: boolean;
        readonly removedHostnames?: readonly string[];
        readonly newDomain?: ConsoleDomainQueueItem | null;
      } | null;

      if (res.status === 503 && (data?.cleanupPending || data?.reconciliationPending)) {
        setBannerPending(
          data.message ??
            "Permintaan perubahan domain mengalami timeout penyedia. Status tetap tertunda (pending/deleting) tanpa melewati verifikasi.",
        );
        setChangeTarget(null);
        await fetchQueue({ status: statusFilter, search: appliedSearch, page });
        return;
      }

      if (!res.ok || !data?.success) {
        setChangeError({
          code: data?.code ?? `HTTP_${res.status}`,
          message: data?.message ?? "Gagal memproses perubahan domain terkunci.",
          verifyPath: data?.verifyPath,
        });
        return;
      }

      const removedLabel = (data.removedHostnames ?? [changeTarget.hostname]).join(", ");
      const connectedLabel = data.newDomain
        ? ` dan menghubungkan ${data.newDomain.hostname} (status: pending verifikasi)`
        : "";
      setBannerSuccess(
        `Berhasil melepas domain terkunci (${removedLabel})${connectedLabel} untuk tenant ${changeTarget.tenantHandle}. Subdomain ${changeTarget.tenantHandle}.${saasZone} tetap aman sebagai fallback.`,
      );
      setChangeTarget(null);
      await fetchQueue({ status: statusFilter, search: appliedSearch, page });
    } catch {
      setChangeError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat memproses perubahan domain.",
      });
    } finally {
      setChangeSubmitting(false);
    }
  }

  const hasFilters = statusFilter !== "all" || appliedSearch.length > 0 || tenantIdFilter.length > 0;

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Antrean Pemulihan Domain &amp; SSL
          </h1>
          <p className="text-sm text-muted-foreground">
            Pantau kendala verifikasi domain/TLS lintas tenant, lakukan pemeriksaan ulang terbatas,
            atau ganti domain terkunci atas permintaan resmi dengan alasan audit. Tidak pernah melewati
            verifikasi DNS/TLS atau mencabut penangguhan layanan.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void fetchQueue({ status: statusFilter, search: appliedSearch, page })}
          disabled={loading}
          className="min-h-11 md:min-h-9"
          data-testid="domains-refresh-btn"
        >
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          <span>Muat Ulang</span>
        </Button>
      </header>

      {/* Summary Metric Cards */}
      <section
        aria-label="Ringkasan status domain kustom"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Kendala / Tertahan</p>
          <p
            className="mt-1 text-2xl font-semibold tabular-nums text-destructive"
            data-testid="domains-count-exceptions"
          >
            {queue.counts.exceptions}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Gagal: {queue.counts.failed} • Moved: {queue.counts.moved}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Menunggu Verifikasi</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {queue.counts.pending}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Menghapus: {queue.counts.deleting}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Domain Aktif</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {queue.counts.active}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Terkunci (REQ-065): {queue.counts.locked}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Total Custom Hostname</p>
          <p
            className="mt-1 text-2xl font-semibold tabular-nums text-foreground"
            data-testid="domains-count-total"
          >
            {queue.counts.total}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fallback: *.{saasZone}
          </p>
        </div>
      </section>

      {/* Alerts */}
      {bannerSuccess ? (
        <Alert variant="success" data-testid="domains-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Tindakan Berhasil &amp; Tercatat di Audit</AlertTitle>
          <AlertDescription>{bannerSuccess}</AlertDescription>
        </Alert>
      ) : null}

      {bannerPending ? (
        <Alert variant="warning" data-testid="domains-pending-banner">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Tertunda di Penyedia (Status Tetap Pending)</AlertTitle>
          <AlertDescription>{bannerPending}</AlertDescription>
        </Alert>
      ) : null}

      {listError ? (
        <Alert variant="destructive" data-testid="domains-error-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal Memuat Antrean Domain ({listError.code})</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{listError.message}</p>
            {listError.verifyPath ? (
              <a
                href={listError.verifyPath}
                className="inline-flex min-h-11 items-center rounded-md border border-destructive-border bg-card px-3 text-xs font-medium text-destructive underline md:min-h-8"
              >
                Verifikasi ulang 2FA sekarang
              </a>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {!stepUpFresh ? (
        <Alert variant="warning" data-testid="domains-stepup-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Step-Up 2FA Diperlukan untuk Mutasi</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Pemeriksaan ulang dan penggantian domain terkunci memerlukan verifikasi 2FA dalam 10
              menit terakhir.
            </span>
            <a
              href="/auth/two-factor?mode=verify"
              className="inline-flex min-h-11 items-center rounded-md border border-warning-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted md:min-h-8"
            >
              Verifikasi 2FA
            </a>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Filter & Search Bar */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filter Antrean Domain</CardTitle>
          <CardDescription>
            Diurutkan berdasarkan kendala terlebih dahulu (Gagal, Moved, Menghapus, Pending Tertahan).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 md:flex-row">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Cari hostname, handle, nama bisnis, atau tenant ID..."
                aria-label="Cari domain atau tenant"
                className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
                data-testid="domains-search-input"
              />
            </div>

            <select
              aria-label="Filter status domain"
              value={statusFilter}
              onChange={(e) => {
                const next = e.target.value;
                setStatusFilter(next);
                void fetchQueue({ status: next, search: appliedSearch, page: 1 });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
              data-testid="domains-status-filter"
            >
              {DOMAIN_STATUS_FILTERS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <Button type="submit" className="min-h-11 md:min-h-9" data-testid="domains-search-btn">
              Terapkan Filter
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Queue List */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Daftar Custom Domain ({queue.totalCount})</CardTitle>
              <CardDescription>
                Halaman {queue.page} dari {queue.totalPages} • Menampilkan metadata control-plane saja.
              </CardDescription>
            </div>
            {hasFilters ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                className="min-h-11 md:min-h-8"
              >
                Reset Filter
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : queue.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <GlobeIcon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">
                {hasFilters
                  ? "Tidak ada custom domain yang cocok dengan filter."
                  : "Belum ada custom domain yang terdaftar di platform."}
              </p>
              {hasFilters ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResetFilters}
                  className="mt-3 min-h-11 md:min-h-9"
                >
                  Tampilkan Semua Domain
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              {/* Mobile Card Stack (360px - 767px) */}
              <div className="space-y-3 md:hidden" data-testid="domains-mobile-list">
                {queue.items.map((item) => {
                  const st = domainStatusBadge(item.status);
                  const own = subStateBadge(item.ownershipStatus, "Kepemilikan");
                  const tls = subStateBadge(item.tlsStatus, "TLS");
                  return (
                    <article
                      key={`${item.tenantId}:${item.hostname}`}
                      data-testid={`domain-card-${item.hostname}`}
                      className="space-y-3 rounded-lg border border-border bg-card p-4"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="break-all font-mono text-sm font-semibold text-foreground">
                            {item.hostname}
                          </span>
                          <Badge variant={st.variant}>{st.label}</Badge>
                          {item.lockedAfterActivation ? (
                            <Badge variant="outline">
                              <LockIcon className="mr-1 size-3" aria-hidden="true" />
                              Terkunci
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Tenant:{" "}
                          <a
                            href={`/console/tenants/${item.tenantHandle}`}
                            className="inline-flex min-h-11 items-center font-medium text-primary underline"
                          >
                            {item.tenantName} ({item.tenantHandle})
                          </a>
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={own.variant}>{own.label}</Badge>
                        <Badge variant={tls.variant}>{tls.label}</Badge>
                        <Badge variant="secondary">Tenant: {item.tenantEffectiveStatus}</Badge>
                      </div>

                      {item.failureCode || item.exceptionReason ? (
                        <div className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-xs text-destructive">
                          {item.failureCode ? (
                            <p className="font-mono font-semibold">{item.failureCode}</p>
                          ) : null}
                          {item.exceptionReason ? <p>{item.exceptionReason}</p> : null}
                        </div>
                      ) : null}

                      <p className="text-xs text-muted-foreground tabular-nums">
                        Pemeriksaan terakhir: {formatEpoch(item.lastCheckedAt)} • v{item.version}
                      </p>

                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!item.canRecheck}
                          onClick={() => openRecheckDialog(item)}
                          className="min-h-11 w-full justify-center"
                          data-testid={`mobile-recheck-${item.hostname}`}
                        >
                          <RefreshCwIcon className="size-4" aria-hidden="true" />
                          <span>Periksa Ulang</span>
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={!item.canOperatorChange}
                          onClick={() => openChangeDialog(item)}
                          className="min-h-11 w-full justify-center"
                          data-testid={`mobile-change-${item.hostname}`}
                        >
                          <ArrowLeftRightIcon className="size-4" aria-hidden="true" />
                          <span>Ganti Domain Terkunci</span>
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Desktop / Tablet Table (>= 768px) */}
              <div className="hidden overflow-x-auto md:block" data-testid="domains-desktop-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hostname &amp; Tenant</TableHead>
                      <TableHead>Status &amp; TLS</TableHead>
                      <TableHead>Kendala / Kode Aman</TableHead>
                      <TableHead>Terakhir Diperiksa</TableHead>
                      <TableHead className="text-right">Aksi Pemulihan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.items.map((item) => {
                      const st = domainStatusBadge(item.status);
                      const own = subStateBadge(item.ownershipStatus, "DNS/Host");
                      const tls = subStateBadge(item.tlsStatus, "TLS");
                      return (
                        <TableRow
                          key={`${item.tenantId}:${item.hostname}`}
                          data-testid={`domain-row-${item.hostname}`}
                        >
                          <TableCell className="align-top">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono text-sm font-semibold text-foreground">
                                  {item.hostname}
                                </span>
                                {item.isPrimary ? <Badge variant="secondary">Utama</Badge> : null}
                                {item.lockedAfterActivation ? (
                                  <Badge variant="outline">
                                    <LockIcon className="mr-1 size-3" aria-hidden="true" />
                                    Terkunci
                                  </Badge>
                                ) : null}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                <a
                                  href={`/console/tenants/${item.tenantHandle}`}
                                  className="font-medium text-primary hover:underline"
                                >
                                  {item.tenantName}
                                </a>{" "}
                                (<span className="font-mono">{item.tenantHandle}</span>) •{" "}
                                <span className="capitalize">{item.tenantEffectiveStatus}</span>
                                {item.tenantOperatorHold ? " (Hold)" : ""}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap gap-1.5">
                              <Badge variant={st.variant}>{st.label}</Badge>
                              <Badge variant={own.variant}>{own.label}</Badge>
                              <Badge variant={tls.variant}>{tls.label}</Badge>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-xs align-top text-xs">
                            {item.failureCode ? (
                              <p className="font-mono font-semibold text-destructive">
                                {item.failureCode}
                              </p>
                            ) : null}
                            {item.exceptionReason ? (
                              <p className="text-muted-foreground">{item.exceptionReason}</p>
                            ) : (
                              <span className="text-muted-foreground">Tidak ada kendala</span>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                            <div>{formatEpoch(item.lastCheckedAt)}</div>
                            <div className="font-mono">v{item.version}</div>
                          </TableCell>
                          <TableCell className="align-top text-right">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!item.canRecheck}
                                onClick={() => openRecheckDialog(item)}
                                data-testid={`recheck-btn-${item.hostname}`}
                              >
                                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                                <span>Periksa Ulang</span>
                              </Button>
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={!item.canOperatorChange}
                                onClick={() => openChangeDialog(item)}
                                data-testid={`change-btn-${item.hostname}`}
                              >
                                <ArrowLeftRightIcon className="size-3.5" aria-hidden="true" />
                                <span>Ganti Domain</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {/* Pagination */}
          {queue.totalPages > 1 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground tabular-nums">
                Halaman {queue.page} dari {queue.totalPages} ({queue.totalCount} domain)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={queue.page <= 1 || loading}
                  onClick={() =>
                    void fetchQueue({ status: statusFilter, search: appliedSearch, page: queue.page - 1 })
                  }
                  className="min-h-11 md:min-h-8"
                >
                  <ChevronLeftIcon className="size-4" aria-hidden="true" />
                  <span>Sebelumnya</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!queue.hasMore || loading}
                  onClick={() =>
                    void fetchQueue({ status: statusFilter, search: appliedSearch, page: queue.page + 1 })
                  }
                  className="min-h-11 md:min-h-8"
                >
                  <span>Berikutnya</span>
                  <ChevronRightIcon className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Base UI Dialog: Operator Domain Recheck */}
      <Dialog.Root
        open={Boolean(recheckTarget)}
        onOpenChange={(open) => {
          if (!open && !recheckSubmitting) setRecheckTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[1px]" />
          <Dialog.Popup
            data-testid="domain-recheck-dialog"
            className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg focus:outline-none"
          >
            {recheckTarget ? (
              <form onSubmit={submitRecheck} className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Dialog.Title className="text-lg font-semibold text-foreground">
                      Periksa Ulang Domain
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-muted-foreground">
                      Tenant: <strong>{recheckTarget.tenantName}</strong> ({recheckTarget.tenantHandle}) •
                      Hostname: <code className="font-mono">{recheckTarget.hostname}</code>
                    </Dialog.Description>
                  </div>
                  <Dialog.Close
                    aria-label="Tutup dialog"
                    className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Dialog.Close>
                </div>

                <Alert>
                  <AlertTitle>Batasan Keamanan</AlertTitle>
                  <AlertDescription>
                    Pemeriksaan ulang menyinkronkan status Cloudflare &amp; DNS secara terbatas. Tidak
                    pernah memaksa status aktif atau mencabut penangguhan tenant.
                  </AlertDescription>
                </Alert>

                {recheckError ? (
                  <Alert variant="destructive" data-testid="recheck-dialog-error">
                    <AlertTitle>{recheckError.code}</AlertTitle>
                    <AlertDescription>{recheckError.message}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-1.5">
                  <label
                    htmlFor="recheck-reason-input"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan Operasional (Wajib, 10–500 karakter)
                  </label>
                  <textarea
                    id="recheck-reason-input"
                    required
                    minLength={10}
                    maxLength={500}
                    rows={3}
                    value={recheckReason}
                    onChange={(e) => setRecheckReason(e.target.value)}
                    placeholder="Contoh: Tiket dukungan #4821 — pemilik sudah memperbarui CNAME DNS."
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                    data-testid="recheck-reason-input"
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {recheckReason.trim().length} / 500 karakter (jangan sertakan token/PII).
                  </p>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recheckSubmitting}
                    onClick={() => setRecheckTarget(null)}
                    className="min-h-11 md:min-h-9"
                  >
                    Batal
                  </Button>
                  <Button
                    type="submit"
                    disabled={recheckSubmitting}
                    className="min-h-11 md:min-h-9"
                    data-testid="recheck-submit-btn"
                  >
                    {recheckSubmitting ? "Memeriksa..." : "Konfirmasi Periksa Ulang"}
                  </Button>
                </div>
              </form>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Base UI Dialog: Operator Domain Change (REQ-065 Remove Locked & Connect New) */}
      <Dialog.Root
        open={Boolean(changeTarget)}
        onOpenChange={(open) => {
          if (!open && !changeSubmitting) setChangeTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[1px]" />
          <Dialog.Popup
            data-testid="domain-change-dialog"
            className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(94vw,36rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg focus:outline-none"
          >
            {changeTarget ? (
              <form onSubmit={submitDomainChange} className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Dialog.Title className="text-lg font-semibold text-foreground">
                      Ganti / Lepas Domain Terkunci (REQ-065)
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-muted-foreground">
                      Tenant: <strong>{changeTarget.tenantName}</strong> ({changeTarget.tenantHandle}) •
                      Status Tenant: <strong>{changeTarget.tenantEffectiveStatus}</strong>
                    </Dialog.Description>
                  </div>
                  <Dialog.Close
                    aria-label="Tutup dialog"
                    className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Dialog.Close>
                </div>

                <Alert variant="warning">
                  <ShieldAlertIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Tindakan Istimewa Operator (Wajib Step-Up 2FA &amp; Audit)</AlertTitle>
                  <AlertDescription>
                    Domain lama <code className="font-mono">{changeTarget.hostname}</code> akan
                    dilepas dan subdomain <code className="font-mono">{changeTarget.tenantHandle}.{saasZone}</code>{" "}
                    otomatis dipulihkan sebagai fallback utama. Domain pengganti selalu dimulai dengan
                    status <strong>pending</strong> (verifikasi tidak pernah dilewati).
                  </AlertDescription>
                </Alert>

                {changeError ? (
                  <Alert variant="destructive" data-testid="change-dialog-error">
                    <AlertTitle>{changeError.code}</AlertTitle>
                    <AlertDescription>{changeError.message}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-1.5">
                  <label
                    htmlFor="change-confirm-hostname"
                    className="block text-sm font-medium text-foreground"
                  >
                    Ketik ulang hostname yang dilepas:{" "}
                    <code className="font-mono font-semibold">{changeTarget.hostname}</code>
                  </label>
                  <Input
                    id="change-confirm-hostname"
                    required
                    value={changeConfirmHost}
                    onChange={(e) => setChangeConfirmHost(e.target.value)}
                    placeholder={changeTarget.hostname}
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                    data-testid="change-confirm-hostname-input"
                  />
                </div>

                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border border-border p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={changeRemoveSet}
                    onChange={(e) => setChangeRemoveSet(e.target.checked)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span>
                    Lepas seluruh pasangan custom hostname (termasuk versi <code className="font-mono">www</code>/apex) milik tenant ini.
                  </span>
                </label>

                <div className="space-y-1.5">
                  <label
                    htmlFor="change-new-hostname"
                    className="block text-sm font-medium text-foreground"
                  >
                    Hostname Baru Pengganti (Opsional)
                  </label>
                  <Input
                    id="change-new-hostname"
                    value={changeNewHost}
                    onChange={(e) => setChangeNewHost(e.target.value)}
                    placeholder="Contoh: www.domainbaru.id (kosongkan jika hanya melepas)"
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                    data-testid="change-new-hostname-input"
                  />
                </div>

                {changeNewHost.trim().length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label htmlFor="change-connect-mode" className="block text-xs font-medium text-foreground">
                        Mode Koneksi
                      </label>
                      <select
                        id="change-connect-mode"
                        value={changeMode}
                        onChange={(e) =>
                          setChangeMode(
                            e.target.value as
                              | "new_domain"
                              | "zero_downtime_migration"
                              | "cloudflare_o2o",
                          )
                        }
                        className="min-h-11 w-full rounded-md border border-input bg-card px-3 text-base md:min-h-9 md:text-sm"
                      >
                        <option value="new_domain">Domain Baru (HTTP DCV)</option>
                        <option value="zero_downtime_migration">Pindahan Nol Downtime (TXT DCV)</option>
                        <option value="cloudflare_o2o">Cloudflare O2O (HTTP DCV)</option>
                      </select>
                    </div>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs">
                      <input
                        type="checkbox"
                        checked={changeConfirmApex}
                        onChange={(e) => setChangeConfirmApex(e.target.checked)}
                        className="size-4 accent-primary"
                      />
                      <span>DNS mendukung CNAME flattening (khusus apex domain)</span>
                    </label>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <label
                    htmlFor="change-reason-input"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan Operasional (Wajib, 10–500 karakter)
                  </label>
                  <textarea
                    id="change-reason-input"
                    required
                    minLength={10}
                    maxLength={500}
                    rows={3}
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    placeholder="Contoh: Permintaan resmi pemilik bisnis melalui tiket #5092 untuk rebranding domain."
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                    data-testid="change-reason-input"
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {changeReason.trim().length} / 500 karakter
                  </p>
                </div>

                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border border-destructive-border bg-destructive-soft p-3 text-xs text-destructive">
                  <input
                    type="checkbox"
                    checked={changeConfirmLocked}
                    onChange={(e) => setChangeConfirmLocked(e.target.checked)}
                    className="mt-0.5 size-4 accent-destructive"
                    data-testid="change-confirm-checkbox"
                  />
                  <span className="font-medium">
                    Saya mengonfirmasi pelepasan domain terkunci ini telah diverifikasi sesuai permintaan
                    resmi pemilik website dan akan dicatat permanen di log audit.
                  </span>
                </label>

                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={changeSubmitting}
                    onClick={() => setChangeTarget(null)}
                    className="min-h-11 md:min-h-9"
                  >
                    Batal
                  </Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={changeSubmitting}
                    className="min-h-11 md:min-h-9"
                    data-testid="change-submit-btn"
                  >
                    {changeSubmitting ? "Memproses..." : "Konfirmasi Ganti Domain"}
                  </Button>
                </div>
              </form>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
