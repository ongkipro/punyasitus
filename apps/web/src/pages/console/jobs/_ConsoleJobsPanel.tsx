import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  BanIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LayersIcon,
  LockIcon,
  RefreshCwIcon,
  RotateCcwIcon,
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
import type { ConsoleJobQueueItem, ConsoleJobQueuePage } from "@punyasitus/db/platform";

export interface ConsoleJobsPanelProps {
  readonly initialQueue: ConsoleJobQueuePage;
  readonly initialStatus: string;
  readonly initialTopic: string;
  readonly initialSearch: string;
  readonly initialTenantId: string;
  readonly stepUpFresh: boolean;
}

const JOB_STATUS_FILTERS = [
  { value: "exceptions", label: "Kendala (Gagal / DLQ / Lease Kedaluwarsa)" },
  { value: "all", label: "Semua Status" },
  { value: "failed", label: "Gagal (Failed)" },
  { value: "dead_letter", label: "Dead-Letter" },
  { value: "running", label: "Berjalan (Running)" },
  { value: "queued", label: "Antrean (Queued)" },
  { value: "completed", label: "Selesai (Completed)" },
] as const;

function createIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatEpoch(ms: number | null): string {
  if (!ms) return "—";
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

function jobStatusBadge(item: ConsoleJobQueueItem): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline" | "destructive" | "success" | "warning";
} {
  if (item.status === "running" && item.leaseState === "expired") {
    return { label: "Lease Kedaluwarsa", variant: "warning" };
  }
  switch (item.status) {
    case "completed":
      return { label: "Selesai", variant: "success" };
    case "queued":
      return { label: "Di Antrean", variant: "secondary" };
    case "running":
      return { label: "Berjalan (Aktif)", variant: "default" };
    case "failed":
      return { label: "Gagal", variant: "destructive" };
    case "dead_letter":
      return { label: "Dead-Letter", variant: "destructive" };
  }
}

export function ConsoleJobsPanel({
  initialQueue,
  initialStatus,
  initialTopic,
  initialSearch,
  initialTenantId,
  stepUpFresh,
}: ConsoleJobsPanelProps) {
  const [queue, setQueue] = React.useState<ConsoleJobQueuePage>(initialQueue);
  const [statusFilter, setStatusFilter] = React.useState(initialStatus);
  const [topicFilter, setTopicFilter] = React.useState(initialTopic);
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

  // Action Dialog (retry or cancel)
  const [actionTarget, setActionTarget] = React.useState<{
    readonly mode: "retry" | "cancel";
    readonly job: ConsoleJobQueueItem;
  } | null>(null);
  const [actionReason, setActionReason] = React.useState("");
  const [actionSubmitting, setActionSubmitting] = React.useState(false);
  const [actionError, setActionError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const actionIdempRef = React.useRef<string | null>(null);

  const fetchQueue = React.useCallback(
    async (opts: {
      readonly status: string;
      readonly topic: string;
      readonly search: string;
      readonly page: number;
    }) => {
      setLoading(true);
      setListError(null);
      try {
        const params = new URLSearchParams();
        params.set("status", opts.status || "exceptions");
        if (opts.topic && opts.topic !== "all") params.set("topic", opts.topic);
        if (opts.search.trim()) params.set("search", opts.search.trim());
        if (tenantIdFilter) params.set("tenantId", tenantIdFilter);
        params.set("page", String(opts.page));
        params.set("limit", String(initialQueue.limit));

        const res = await fetch(`/api/console/jobs?${params.toString()}`, {
          credentials: "same-origin",
        });
        const data = (await res.json().catch(() => null)) as
          | (ConsoleJobQueuePage & { readonly success: true })
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
              "Gagal memuat antrean pemulihan job.",
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
    void fetchQueue({
      status: statusFilter,
      topic: topicFilter,
      search: searchInput.trim(),
      page: 1,
    });
  }

  function handleResetFilters() {
    setSearchInput("");
    setAppliedSearch("");
    setStatusFilter("all");
    setTopicFilter("all");
    void fetchQueue({ status: "all", topic: "all", search: "", page: 1 });
  }

  function openActionDialog(mode: "retry" | "cancel", job: ConsoleJobQueueItem) {
    setActionTarget({ mode, job });
    setActionReason("");
    setActionError(null);
    actionIdempRef.current = createIdempotencyKey(`job-${mode}`);
  }

  async function submitAction(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!actionTarget) return;

    const trimmedReason = actionReason.trim();
    if (trimmedReason.length < 10) {
      setActionError({
        code: "VALIDATION_ERROR",
        message: "Alasan operasional wajib diisi minimal 10 karakter.",
      });
      return;
    }

    setActionSubmitting(true);
    setActionError(null);
    setBannerSuccess(null);

    const idempotencyKey =
      actionIdempRef.current ?? createIdempotencyKey(`job-${actionTarget.mode}`);
    actionIdempRef.current = idempotencyKey;

    const endpoint =
      actionTarget.mode === "retry" ? "/api/console/jobs/retry" : "/api/console/jobs/cancel";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          jobIdempotencyKey: actionTarget.job.idempotencyKey,
          tenantId: actionTarget.job.tenantId,
          expectedUpdatedAt: actionTarget.job.updatedAt,
          reason: trimmedReason,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        readonly success?: boolean;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
        readonly replayed?: boolean;
      } | null;

      if (!res.ok || !data?.success) {
        setActionError({
          code: data?.code ?? `HTTP_${res.status}`,
          message: data?.message ?? "Gagal memproses pemulihan job.",
          verifyPath: data?.verifyPath,
        });
        return;
      }

      setBannerSuccess(
        actionTarget.mode === "retry"
          ? `Job ${actionTarget.job.idempotencyKey} berhasil dijadwalkan ulang dengan payload asli yang tervalidasi dan tercatat di audit log.`
          : `Job ${actionTarget.job.idempotencyKey} dipindahkan ke dead-letter (OPERATOR_CANCELED) dan tercatat di audit log.`,
      );
      setActionTarget(null);
      await fetchQueue({
        status: statusFilter,
        topic: topicFilter,
        search: appliedSearch,
        page,
      });
    } catch {
      setActionError({
        code: "NETWORK_ERROR",
        message: "Gagal menghubungi server saat memproses tindakan job.",
      });
    } finally {
      setActionSubmitting(false);
    }
  }

  const hasFilters =
    statusFilter !== "exceptions" ||
    topicFilter !== "all" ||
    appliedSearch.length > 0 ||
    tenantIdFilter.length > 0;

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Antrean Pemulihan Job Latar Belakang
          </h1>
          <p className="text-sm text-muted-foreground">
            Tinjau status tersensor, percobaan, lease, dan kode kegagalan aman dari{" "}
            <code className="font-mono">job_ledger</code>. Hanya job gagal, dead-letter, atau lease
            kedaluwarsa yang dapat dijalankan ulang — tanpa penyuntingan payload bebas dan tidak pernah
            mengambil alih lease aktif.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void fetchQueue({
              status: statusFilter,
              topic: topicFilter,
              search: appliedSearch,
              page,
            })
          }
          disabled={loading}
          className="min-h-11 md:min-h-9"
          data-testid="jobs-refresh-btn"
        >
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          <span>Muat Ulang</span>
        </Button>
      </header>

      {/* Summary Metric Cards */}
      <section
        aria-label="Ringkasan status antrean job"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Perlu Pemulihan</p>
          <p
            className="mt-1 text-2xl font-semibold tabular-nums text-destructive"
            data-testid="jobs-count-exceptions"
          >
            {queue.counts.exceptions}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Gagal: {queue.counts.failed} • DLQ: {queue.counts.deadLetter}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Lease Kedaluwarsa</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {queue.counts.expiredLeaseRunning}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Lease Aktif (Dilindungi): {queue.counts.activeLeaseRunning}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Di Antrean (Queued)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {queue.counts.queued}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Menunggu worker</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Selesai (Completed)</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {queue.counts.completed}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            Total tercatat: {queue.counts.total}
          </p>
        </div>
      </section>

      {/* Banners */}
      {bannerSuccess ? (
        <Alert variant="success" data-testid="jobs-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Pemulihan Job Tercatat</AlertTitle>
          <AlertDescription>{bannerSuccess}</AlertDescription>
        </Alert>
      ) : null}

      {listError ? (
        <Alert variant="destructive" data-testid="jobs-error-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal Memuat Antrean Job ({listError.code})</AlertTitle>
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
        <Alert variant="warning" data-testid="jobs-stepup-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Step-Up 2FA Diperlukan untuk Mutasi</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Menjalankan ulang atau membatalkan job memerlukan verifikasi 2FA dalam 10 menit
              terakhir.
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
          <CardTitle className="text-base">Filter Antrean Job</CardTitle>
          <CardDescription>
            Semua payload disensor otomatis dari token, kata sandi, cookie, email, nomor telepon, dan
            isi pesan pelanggan.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                placeholder="Cari kunci job, topik, kode error, atau handle tenant..."
                aria-label="Cari job latar belakang"
                className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
                data-testid="jobs-search-input"
              />
            </div>

            <select
              aria-label="Filter status job"
              value={statusFilter}
              onChange={(e) => {
                const next = e.target.value;
                setStatusFilter(next);
                void fetchQueue({
                  status: next,
                  topic: topicFilter,
                  search: appliedSearch,
                  page: 1,
                });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
              data-testid="jobs-status-filter"
            >
              {JOB_STATUS_FILTERS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter topik job"
              value={topicFilter}
              onChange={(e) => {
                const next = e.target.value;
                setTopicFilter(next);
                void fetchQueue({
                  status: statusFilter,
                  topic: next,
                  search: appliedSearch,
                  page: 1,
                });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
              data-testid="jobs-topic-filter"
            >
              <option value="all">Semua Topik</option>
              {queue.topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <Button type="submit" className="min-h-11 md:min-h-9" data-testid="jobs-search-btn">
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
              <CardTitle className="text-base">Daftar Job ({queue.totalCount})</CardTitle>
              <CardDescription>
                Halaman {queue.page} dari {queue.totalPages} • Hanya metadata tersensor (tidak ada
                editor payload).
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
                Tampilkan Semua Status
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
              <LayersIcon className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-foreground">
                Tidak ada job pada filter saat ini.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={handleResetFilters}
                className="mt-3 min-h-11 md:min-h-9"
              >
                Tampilkan Semua Status
              </Button>
            </div>
          ) : (
            <>
              {/* Mobile Cards (< 768px) */}
              <div className="space-y-3 md:hidden" data-testid="jobs-mobile-list">
                {queue.items.map((item) => {
                  const st = jobStatusBadge(item);
                  return (
                    <article
                      key={item.idempotencyKey}
                      data-testid={`job-card-${item.idempotencyKey}`}
                      className="space-y-3 rounded-lg border border-border bg-card p-4"
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="break-all font-mono text-xs font-semibold text-foreground">
                            {item.topic}
                          </span>
                          <Badge variant={st.variant}>{st.label}</Badge>
                        </div>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {item.idempotencyKey}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Lingkup:{" "}
                          {item.tenantHandle
                            ? `${item.tenantName ?? item.tenantHandle} (${item.tenantHandle})`
                            : item.tenantId ?? "Platform Global"}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground tabular-nums">
                        <span>Percobaan: {item.attempts}</span>
                        <span>•</span>
                        <span>Diperbarui: {formatEpoch(item.updatedAt)}</span>
                      </div>

                      {item.lastErrorCode ? (
                        <div className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 font-mono text-xs text-destructive">
                          {item.lastErrorCode}
                        </div>
                      ) : null}

                      {item.redactedPayloadSummary ? (
                        <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
                          {JSON.stringify(item.redactedPayloadSummary)}
                        </pre>
                      ) : null}

                      {!item.retryEligible && item.retryIneligibleReason ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          <span>{item.retryIneligibleReason}</span>
                        </p>
                      ) : null}

                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          disabled={!item.retryEligible}
                          onClick={() => openActionDialog("retry", item)}
                          className="min-h-11 w-full justify-center"
                          data-testid={`mobile-retry-${item.idempotencyKey}`}
                        >
                          <RotateCcwIcon className="size-4" aria-hidden="true" />
                          <span>Jalankan Ulang Job</span>
                        </Button>
                        {item.cancelEligible ? (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => openActionDialog("cancel", item)}
                            className="min-h-11 w-full justify-center"
                            data-testid={`mobile-cancel-${item.idempotencyKey}`}
                          >
                            <BanIcon className="size-4" aria-hidden="true" />
                            <span>Batalkan ke Dead-Letter</span>
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Desktop / Tablet Table (>= 768px) */}
              <div className="hidden overflow-x-auto md:block" data-testid="jobs-desktop-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Topik &amp; Kunci Job</TableHead>
                      <TableHead>Lingkup Tenant</TableHead>
                      <TableHead>Status &amp; Lease</TableHead>
                      <TableHead>Kode Error &amp; Ringkasan Tersensor</TableHead>
                      <TableHead className="text-right">Aksi Pemulihan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.items.map((item) => {
                      const st = jobStatusBadge(item);
                      return (
                        <TableRow
                          key={item.idempotencyKey}
                          data-testid={`job-row-${item.idempotencyKey}`}
                        >
                          <TableCell className="max-w-xs align-top">
                            <div className="space-y-1">
                              <p className="font-mono text-xs font-semibold text-foreground">
                                {item.topic}
                              </p>
                              <p className="break-all font-mono text-xs text-muted-foreground">
                                {item.idempotencyKey}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            {item.tenantHandle ? (
                              <div>
                                <a
                                  href={`/console/tenants/${item.tenantHandle}`}
                                  className="font-medium text-primary hover:underline"
                                >
                                  {item.tenantName ?? item.tenantHandle}
                                </a>
                                <p className="font-mono text-muted-foreground">
                                  {item.tenantHandle}
                                </p>
                              </div>
                            ) : (
                              <span className="text-muted-foreground">
                                {item.tenantId ?? "Platform Global"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            <div className="space-y-1">
                              <Badge variant={st.variant}>{st.label}</Badge>
                              <p className="text-muted-foreground tabular-nums">
                                Percobaan: {item.attempts}
                              </p>
                              {item.leaseUntil ? (
                                <p className="text-muted-foreground tabular-nums">
                                  Lease: {formatEpoch(item.leaseUntil)}
                                </p>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="max-w-xs align-top text-xs">
                            {item.lastErrorCode ? (
                              <p className="font-mono font-semibold text-destructive">
                                {item.lastErrorCode}
                              </p>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {item.redactedPayloadSummary ? (
                              <pre
                                className="mt-1 max-w-xs overflow-x-auto rounded border border-border bg-muted/50 px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground"
                                data-testid={`job-summary-${item.idempotencyKey}`}
                              >
                                {JSON.stringify(item.redactedPayloadSummary)}
                              </pre>
                            ) : null}
                            {!item.retryEligible && item.retryIneligibleReason ? (
                              <p className="mt-1 text-muted-foreground">
                                {item.retryIneligibleReason}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="align-top text-right">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={!item.retryEligible}
                                onClick={() => openActionDialog("retry", item)}
                                data-testid={`retry-btn-${item.idempotencyKey}`}
                              >
                                <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                                <span>Jalankan Ulang</span>
                              </Button>
                              {item.cancelEligible ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openActionDialog("cancel", item)}
                                  data-testid={`cancel-btn-${item.idempotencyKey}`}
                                >
                                  <BanIcon className="size-3.5" aria-hidden="true" />
                                  <span>Batalkan</span>
                                </Button>
                              ) : null}
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
                Halaman {queue.page} dari {queue.totalPages} ({queue.totalCount} job)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={queue.page <= 1 || loading}
                  onClick={() =>
                    void fetchQueue({
                      status: statusFilter,
                      topic: topicFilter,
                      search: appliedSearch,
                      page: queue.page - 1,
                    })
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
                    void fetchQueue({
                      status: statusFilter,
                      topic: topicFilter,
                      search: appliedSearch,
                      page: queue.page + 1,
                    })
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

      {/* Base UI Dialog: Retry / Cancel Job */}
      <Dialog.Root
        open={Boolean(actionTarget)}
        onOpenChange={(open) => {
          if (!open && !actionSubmitting) setActionTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[1px]" />
          <Dialog.Popup
            data-testid="job-action-dialog"
            className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg focus:outline-none"
          >
            {actionTarget ? (
              <form onSubmit={submitAction} className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Dialog.Title className="text-lg font-semibold text-foreground">
                      {actionTarget.mode === "retry"
                        ? "Jalankan Ulang Job Gagal"
                        : "Batalkan Job ke Dead-Letter"}
                    </Dialog.Title>
                    <Dialog.Description className="break-all text-xs text-muted-foreground">
                      Topik: <code className="font-mono">{actionTarget.job.topic}</code> • Kunci:{" "}
                      <code className="font-mono">{actionTarget.job.idempotencyKey}</code>
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
                  <AlertTitle>Lingkup &amp; Keamanan Terikat</AlertTitle>
                  <AlertDescription>
                    Lingkup tenant:{" "}
                    <strong>
                      {actionTarget.job.tenantHandle ?? actionTarget.job.tenantId ?? "Platform Global"}
                    </strong>
                    .{" "}
                    {actionTarget.mode === "retry"
                      ? "Payload asli yang tervalidasi digunakan ulang tanpa perubahan dan tidak akan mencabut penangguhan tenant."
                      : "Job akan dipindahkan ke dead-letter (OPERATOR_CANCELED) secara atomik dengan catatan audit."}
                  </AlertDescription>
                </Alert>

                {actionError ? (
                  <Alert variant="destructive" data-testid="job-dialog-error">
                    <AlertTitle>{actionError.code}</AlertTitle>
                    <AlertDescription>{actionError.message}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-1.5">
                  <label
                    htmlFor="job-action-reason"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan Operasional (Wajib, 10–500 karakter)
                  </label>
                  <textarea
                    id="job-action-reason"
                    required
                    minLength={10}
                    maxLength={500}
                    rows={3}
                    value={actionReason}
                    onChange={(e) => setActionReason(e.target.value)}
                    placeholder="Contoh: Gangguan penyedia sementara telah pulih; menjadwalkan ulang job gagal."
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:text-sm"
                    data-testid="job-action-reason-input"
                  />
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {actionReason.trim().length} / 500 karakter (jangan sertakan rahasia/PII).
                  </p>
                </div>

                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={actionSubmitting}
                    onClick={() => setActionTarget(null)}
                    className="min-h-11 md:min-h-9"
                  >
                    Batal
                  </Button>
                  <Button
                    type="submit"
                    variant={actionTarget.mode === "cancel" ? "destructive" : "default"}
                    disabled={actionSubmitting}
                    className="min-h-11 md:min-h-9"
                    data-testid="job-action-submit-btn"
                  >
                    {actionSubmitting
                      ? "Memproses..."
                      : actionTarget.mode === "retry"
                        ? "Konfirmasi Jalankan Ulang"
                        : "Konfirmasi Batalkan Job"}
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
