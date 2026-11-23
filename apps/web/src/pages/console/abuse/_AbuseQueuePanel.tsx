import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  EyeOffIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XCircleIcon,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type AbuseCategory =
  | "phishing"
  | "scam"
  | "malware"
  | "impersonation"
  | "illegal_content"
  | "spam"
  | "other";

export type AbuseReportStatus = "open" | "investigating" | "resolved" | "dismissed";
export type AbuseFilterStatus = "all" | AbuseReportStatus;
export type AbuseModerationAction = "dismiss" | "unpublish" | "suspend";

export interface AbuseReportItemDto {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly tenantOperatorHold: boolean;
  readonly reportedHost: string;
  readonly reportedPath: string;
  readonly category: AbuseCategory;
  readonly details: string;
  readonly hasReporterContact: boolean;
  readonly reporterContactMasked: string | null;
  readonly status: AbuseReportStatus;
  readonly resolutionNotes: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly latestAction: AbuseModerationAction | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AbuseStatusCountsDto {
  readonly all: number;
  readonly open: number;
  readonly investigating: number;
  readonly resolved: number;
  readonly dismissed: number;
}

export interface AbuseQueuePanelProps {
  readonly initialItems: readonly AbuseReportItemDto[];
  readonly initialCounts: AbuseStatusCountsDto;
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
  readonly stepUpFresh: boolean;
}

const STATUS_LABELS: Readonly<Record<AbuseReportStatus, string>> = {
  open: "Terbuka",
  investigating: "Ditinjau",
  resolved: "Selesai",
  dismissed: "Ditolak",
};

const STATUS_VARIANTS: Readonly<
  Record<AbuseReportStatus, "destructive" | "warning" | "success" | "outline">
> = {
  open: "destructive",
  investigating: "warning",
  resolved: "success",
  dismissed: "outline",
};

const CATEGORY_LABELS: Readonly<Record<AbuseCategory, string>> = {
  phishing: "Phishing",
  scam: "Penipuan",
  malware: "Malware",
  impersonation: "Peniruan",
  illegal_content: "Konten Ilegal",
  spam: "Spam",
  other: "Lainnya",
};

const ACTION_LABELS: Readonly<Record<AbuseModerationAction, string>> = {
  dismiss: "Tolak Laporan",
  unpublish: "Nonaktifkan Konten",
  suspend: "Tangguhkan Situs",
};

const FILTER_TABS: readonly { readonly id: AbuseFilterStatus; readonly label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "open", label: "Terbuka" },
  { id: "resolved", label: "Selesai" },
  { id: "dismissed", label: "Ditolak" },
];

function formatDateTimeWib(isoString: string): string {
  try {
    const dt = new Date(isoString);
    if (Number.isNaN(dt.getTime())) return isoString;
    return `${dt.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })} WIB`;
  } catch {
    return isoString;
  }
}

export function AbuseQueuePanel({
  initialItems,
  initialCounts,
  initialNextCursor,
  initialHasMore,
  stepUpFresh,
}: AbuseQueuePanelProps) {
  const [items, setItems] = React.useState<readonly AbuseReportItemDto[]>(initialItems);
  const [counts, setCounts] = React.useState<AbuseStatusCountsDto>(initialCounts);
  const [statusFilter, setStatusFilter] = React.useState<AbuseFilterStatus>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [activeSearch, setActiveSearch] = React.useState("");
  const [nextCursor, setNextCursor] = React.useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<AbuseReportItemDto | null>(null);
  const [chosenAction, setChosenAction] = React.useState<AbuseModerationAction>("dismiss");
  const [reasonInput, setReasonInput] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [drawerError, setDrawerError] = React.useState<{
    readonly code: string;
    readonly message: string;
  } | null>(null);

  const fetchQueue = React.useCallback(
    async (opts: {
      readonly status: AbuseFilterStatus;
      readonly search: string;
      readonly cursor?: string | null;
      readonly append?: boolean;
    }) => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (opts.status !== "all") params.set("status", opts.status);
        if (opts.search.trim()) params.set("search", opts.search.trim());
        if (opts.cursor) params.set("cursor", opts.cursor);
        params.set("limit", "20");

        const res = await fetch(`/api/console/abuse?${params.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = (await res.json().catch(() => null)) as {
          items?: AbuseReportItemDto[];
          counts?: AbuseStatusCountsDto;
          page?: { hasMore?: boolean; nextCursor?: string | null };
          error?: { message?: string };
        } | null;

        if (!res.ok || !data) {
          setLoadError(data?.error?.message ?? "Gagal memuat antrean laporan penyalahgunaan.");
          return;
        }

        const fetched = Array.isArray(data.items) ? data.items : [];
        setItems((prev) => (opts.append ? [...prev, ...fetched] : fetched));
        if (data.counts) setCounts(data.counts);
        setHasMore(Boolean(data.page?.hasMore));
        setNextCursor(data.page?.nextCursor ?? null);
      } catch {
        setLoadError("Tidak dapat terhubung ke server console. Silakan coba lagi.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  function openReportDrawer(item: AbuseReportItemDto) {
    setSelected(item);
    setChosenAction("dismiss");
    setReasonInput("");
    setDrawerError(null);
  }

  async function handleStatusFilter(nextStatus: AbuseFilterStatus) {
    setStatusFilter(nextStatus);
    await fetchQueue({ status: nextStatus, search: activeSearch });
  }

  async function handleSearchSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    setActiveSearch(trimmed);
    await fetchQueue({ status: statusFilter, search: trimmed });
  }

  async function handleModerateSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || submitting) return;

    const trimmedReason = reasonInput.trim();
    if (trimmedReason.length < 10) {
      setDrawerError({
        code: "VALIDATION_ERROR",
        message: "Alasan moderasi wajib diisi minimal 10 karakter untuk catatan audit.",
      });
      return;
    }

    setSubmitting(true);
    setDrawerError(null);

    try {
      const idempotencyKey = `mod-${selected.id}-${selected.version}-${chosenAction}`;
      const res = await fetch(`/api/console/abuse/${encodeURIComponent(selected.id)}/moderate`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          action: chosenAction,
          reason: trimmedReason,
          expectedVersion: selected.version,
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        report?: AbuseReportItemDto;
        notificationSent?: boolean;
        error?: { code?: string; message?: string };
      } | null;

      if (!res.ok || !data?.report) {
        setDrawerError({
          code: data?.error?.code ?? "MODERATION_FAILED",
          message:
            data?.error?.message ?? "Gagal memproses tindakan moderasi. Silakan coba lagi.",
        });
        return;
      }

      const updated = data.report;
      setSelected(updated);
      setBannerMessage(
        `Laporan ${updated.id} selesai diproses (${ACTION_LABELS[chosenAction]}).${
          data.notificationSent ? " Pemberitahuan telah dikirim ke pemilik situs." : ""
        }`,
      );
      await fetchQueue({ status: statusFilter, search: activeSearch });
    } catch {
      setDrawerError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mengirim tindakan moderasi.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const isSelectedActionable =
    selected !== null && (selected.status === "open" || selected.status === "investigating");

  return (
    <div className="space-y-5" data-testid="abuse-queue-panel">
      {/* KPI Summary Row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Laporan Terbuka</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="abuse-count-open">
              {counts.open}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Laporan</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="abuse-count-all">
              {counts.all}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tindakan Selesai</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="abuse-count-resolved">
              {counts.resolved}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Laporan Ditolak</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="abuse-count-dismissed">
              {counts.dismissed}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {bannerMessage && (
        <Alert variant="success" data-testid="abuse-moderation-success">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Tindakan moderasi tersimpan</AlertTitle>
          <AlertDescription>{bannerMessage}</AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive" data-testid="abuse-queue-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat antrean</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {/* Filters & Search */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filter status laporan"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {FILTER_TABS.map((tab) => {
            const active = statusFilter === tab.id;
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`abuse-filter-${tab.id}`}
                onClick={() => handleStatusFilter(tab.id)}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-8 ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-sm px-1.5 py-0.5 text-xs tabular-nums ${
                    active
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:w-72">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Cari host, handle, atau path..."
              aria-label="Cari laporan penyalahgunaan"
              className="pl-9"
              data-testid="abuse-search-input"
            />
          </div>
          <Button type="submit" variant="outline" className="min-h-11 shrink-0 md:min-h-9">
            Cari
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 shrink-0 md:min-h-9 md:min-w-9"
            aria-label="Muat ulang antrean laporan"
            disabled={loading}
            onClick={() => fetchQueue({ status: statusFilter, search: activeSearch })}
          >
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </form>
      </div>

      {/* Queue List */}
      {items.length === 0 ? (
        <Card data-testid="abuse-queue-empty">
          <CardContent className="flex flex-col items-start gap-2 py-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ShieldCheckIcon className="size-5 shrink-0" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Tidak ada laporan penyalahgunaan pada filter ini
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Semua laporan masuk dari formulir publik tenant akan muncul secara berurutan di sini.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="abuse-queue-table-card">
          <CardContent className="p-0">
            {/* Desktop Table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Situs &amp; Jalur</TableHead>
                    <TableHead>Kategori</TableHead>
                    <TableHead>Uraian</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Masuk</TableHead>
                    <TableHead className="text-right">Tindakan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} data-testid={`abuse-row-${item.id}`}>
                      <TableCell className="align-top">
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">{item.tenantName}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {item.reportedHost}
                            {item.reportedPath}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Status situs:{" "}
                            <span className="font-mono font-medium">{item.tenantStatus}</span>
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant="outline">{CATEGORY_LABELS[item.category]}</Badge>
                      </TableCell>
                      <TableCell className="max-w-xs align-top">
                        <p className="line-clamp-2 text-sm text-foreground">{item.details}</p>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={STATUS_VARIANTS[item.status]}
                          data-testid={`abuse-status-badge-${item.id}`}
                        >
                          {STATUS_LABELS[item.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeWib(item.createdAt)}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <Button
                          variant="default"
                          size="sm"
                          data-testid={`abuse-open-btn-${item.id}`}
                          onClick={() => openReportDrawer(item)}
                        >
                          Tinjau
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Stacked Cards (360px safe) */}
            <ul className="divide-y divide-border md:hidden">
              {items.map((item) => (
                <li
                  key={item.id}
                  data-testid={`abuse-card-${item.id}`}
                  className="space-y-2.5 px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{item.tenantName}</p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {item.reportedHost}
                        {item.reportedPath}
                      </p>
                    </div>
                    <Badge variant={STATUS_VARIANTS[item.status]}>
                      {STATUS_LABELS[item.status]}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{CATEGORY_LABELS[item.category]}</Badge>
                    <span className="tabular-nums">{formatDateTimeWib(item.createdAt)}</span>
                  </div>
                  <p className="line-clamp-3 text-sm text-foreground">{item.details}</p>
                  <Button
                    variant="default"
                    className="min-h-11 w-full"
                    data-testid={`abuse-mobile-open-${item.id}`}
                    onClick={() => openReportDrawer(item)}
                  >
                    Tinjau &amp; Moderasi
                  </Button>
                </li>
              ))}
            </ul>

            {hasMore && nextCursor && (
              <div className="border-t border-border p-4 text-center">
                <Button
                  variant="outline"
                  className="min-h-11 md:min-h-9"
                  disabled={loading}
                  onClick={() =>
                    fetchQueue({
                      status: statusFilter,
                      search: activeSearch,
                      cursor: nextCursor,
                      append: true,
                    })
                  }
                >
                  {loading ? "Memuat..." : "Muat laporan lebih lama"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Moderation Detail & Action Sheet */}
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-[min(30rem,95vw)] overflow-y-auto"
          data-testid="abuse-moderation-sheet"
        >
          {selected && (
            <>
              <SheetHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle>Laporan Moderasi</SheetTitle>
                  <Badge variant={STATUS_VARIANTS[selected.status]}>
                    {STATUS_LABELS[selected.status]}
                  </Badge>
                </div>
                <SheetDescription className="break-all font-mono text-xs">
                  {selected.id} · v{selected.version}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 py-2">
                <dl className="grid grid-cols-1 gap-2.5 rounded-lg border border-border bg-muted/30 p-3.5 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Situs Terlapor</dt>
                    <dd className="font-semibold text-foreground">
                      {selected.tenantName}{" "}
                      <span className="font-mono text-xs font-normal text-muted-foreground">
                        ({selected.tenantHandle})
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">URL / Jalur Dilaporkan</dt>
                    <dd className="break-all font-mono text-xs text-foreground">
                      https://{selected.reportedHost}
                      {selected.reportedPath}
                    </dd>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <dt className="text-xs text-muted-foreground">Kategori</dt>
                      <dd className="font-medium text-foreground">
                        {CATEGORY_LABELS[selected.category]}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Status Situs</dt>
                      <dd className="font-mono text-xs text-foreground">{selected.tenantStatus}</dd>
                    </div>
                  </div>
                  {selected.reporterContactMasked && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Kontak Pelapor (Tersamarkan)</dt>
                      <dd className="font-mono text-xs text-foreground">
                        {selected.reporterContactMasked}
                      </dd>
                    </div>
                  )}
                </dl>

                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Uraian Laporan
                  </h3>
                  <div className="rounded-lg border border-border bg-card p-3.5 text-sm whitespace-pre-wrap text-foreground">
                    {selected.details}
                  </div>
                </div>

                {selected.resolutionNotes && (
                  <Alert variant="success">
                    <ShieldCheckIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>
                      Keputusan Moderasi{" "}
                      {selected.latestAction ? `(${ACTION_LABELS[selected.latestAction]})` : ""}
                    </AlertTitle>
                    <AlertDescription>{selected.resolutionNotes}</AlertDescription>
                  </Alert>
                )}

                {drawerError && (
                  <Alert variant="destructive" data-testid="abuse-drawer-error">
                    <AlertCircleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Gagal memproses moderasi</AlertTitle>
                    <AlertDescription>{drawerError.message}</AlertDescription>
                  </Alert>
                )}

                {isSelectedActionable && (
                  <form
                    id="abuse-moderate-form"
                    onSubmit={handleModerateSubmit}
                    className="space-y-4 border-t border-border pt-4"
                  >
                    {!stepUpFresh && (
                      <Alert variant="warning">
                        <ShieldAlertIcon className="size-4" aria-hidden="true" />
                        <AlertTitle>Verifikasi ulang 2FA diperlukan</AlertTitle>
                        <AlertDescription>
                          Sesi 2FA step-up Anda melebihi 10 menit. Selesaikan verifikasi 2FA sebelum
                          mengeksekusi tindakan moderasi.
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="space-y-2">
                      <span className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Pilih Tindakan Moderasi
                      </span>
                      <div className="grid grid-cols-1 gap-2">
                        {(
                          [
                            {
                              id: "dismiss",
                              label: "Tolak Laporan",
                              desc: "Tutup laporan tanpa mengubah visibilitas situs.",
                              icon: XCircleIcon,
                            },
                            {
                              id: "unpublish",
                              label: "Nonaktifkan Konten (Unpublish)",
                              desc: "Kembalikan halaman/artikel/penawaran terkait ke draf & kirim notifikasi pemilik.",
                              icon: EyeOffIcon,
                            },
                            {
                              id: "suspend",
                              label: "Tangguhkan Situs (Suspend)",
                              desc: "Alihkan situs publik ke halaman 503 suspended, aktifkan operator hold & kirim email pemilik.",
                              icon: ShieldAlertIcon,
                            },
                          ] as const
                        ).map((opt) => {
                          const Icon = opt.icon;
                          const active = chosenAction === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              data-testid={`abuse-action-${opt.id}`}
                              onClick={() => setChosenAction(opt.id)}
                              className={`flex min-h-11 items-start gap-2.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                                active
                                  ? "border-primary bg-primary/5"
                                  : "border-border bg-card hover:bg-muted/50"
                              }`}
                            >
                              <Icon
                                className={`mt-0.5 size-4 shrink-0 ${
                                  opt.id === "suspend"
                                    ? "text-destructive"
                                    : active
                                      ? "text-primary"
                                      : "text-muted-foreground"
                                }`}
                                aria-hidden="true"
                              />
                              <span className="min-w-0 space-y-0.5">
                                <span className="block text-sm font-semibold text-foreground">
                                  {opt.label}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {opt.desc}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="moderation-reason"
                        className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                      >
                        Alasan Audit Wajib (10–500 karakter)
                      </label>
                      <textarea
                        id="moderation-reason"
                        rows={3}
                        required
                        minLength={10}
                        maxLength={500}
                        value={reasonInput}
                        onChange={(e) => setReasonInput(e.target.value)}
                        placeholder="Tuliskan dasar pemeriksaan dan keputusan moderasi tanpa menyertakan PII atau token..."
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        data-testid="abuse-reason-input"
                      />
                    </div>
                  </form>
                )}
              </div>

              {isSelectedActionable && (
                <SheetFooter>
                  <Button
                    type="submit"
                    form="abuse-moderate-form"
                    variant={chosenAction === "suspend" ? "destructive" : "default"}
                    className="min-h-11 w-full md:min-h-9"
                    disabled={submitting}
                    data-testid="abuse-moderate-submit"
                  >
                    {submitting ? "Memproses..." : `Konfirmasi: ${ACTION_LABELS[chosenAction]}`}
                  </Button>
                </SheetFooter>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
