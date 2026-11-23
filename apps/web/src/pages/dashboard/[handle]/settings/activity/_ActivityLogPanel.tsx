import * as React from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowLeftIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface ActivityLogEntryDto {
  readonly id: number;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
}

export interface ActivityLogPanelProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly initialItems: readonly ActivityLogEntryDto[];
  readonly initialTotalCount: number;
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
  readonly initialLoadError: string | null;
}

const RESOURCE_FILTERS = [
  { id: "all", label: "Semua" },
  { id: "lead", label: "Pesan Masuk" },
  { id: "page", label: "Halaman" },
  { id: "post", label: "Artikel" },
  { id: "offering", label: "Penawaran" },
  { id: "moderation", label: "Moderasi" },
] as const;

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: "Pemilik Situs",
  admin: "Admin",
  editor: "Editor",
  agency_admin: "Admin Agensi",
  platform_operator: "Operator Platform",
  system: "Sistem",
};

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

export function ActivityLogPanel({
  tenantId,
  handle,
  tenantName,
  initialItems,
  initialTotalCount,
  initialNextCursor,
  initialHasMore,
  initialLoadError,
}: ActivityLogPanelProps) {
  const apiUrl = `/api/tenants/${encodeURIComponent(tenantId)}/activity`;

  const [items, setItems] = React.useState<readonly ActivityLogEntryDto[]>(initialItems);
  const [totalCount, setTotalCount] = React.useState(initialTotalCount);
  const [resourceFilter, setResourceFilter] = React.useState<string>("all");
  const [nextCursor, setNextCursor] = React.useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(initialLoadError);

  const fetchActivity = React.useCallback(
    async (opts: {
      readonly resourceType: string;
      readonly cursor?: string | null;
      readonly append?: boolean;
    }) => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (opts.resourceType !== "all") params.set("resourceType", opts.resourceType);
        if (opts.cursor) params.set("cursor", opts.cursor);
        params.set("limit", "20");

        const res = await fetch(`${apiUrl}?${params.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = (await res.json().catch(() => null)) as {
          items?: ActivityLogEntryDto[];
          totalCount?: number;
          page?: { hasMore?: boolean; nextCursor?: string | null };
          error?: { message?: string };
        } | null;

        if (!res.ok || !data) {
          setLoadError(data?.error?.message ?? "Gagal memuat log aktivitas situs.");
          return;
        }

        const fetched = Array.isArray(data.items) ? data.items : [];
        setItems((prev) => (opts.append ? [...prev, ...fetched] : fetched));
        if (typeof data.totalCount === "number") setTotalCount(data.totalCount);
        setHasMore(Boolean(data.page?.hasMore));
        setNextCursor(data.page?.nextCursor ?? null);
      } catch {
        setLoadError("Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.");
      } finally {
        setLoading(false);
      }
    },
    [apiUrl],
  );

  async function handleFilterSelect(nextFilter: string) {
    setResourceFilter(nextFilter);
    await fetchActivity({ resourceType: nextFilter });
  }

  return (
    <div className="space-y-6" data-testid="tenant-activity-log-page" data-handle={handle}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Log Aktivitas Situs
          </h1>
          <p className="text-sm text-muted-foreground">
            Riwayat perubahan, penghapusan pesan masuk, dan tindakan moderasi untuk{" "}
            <span className="font-medium text-foreground">{tenantName}</span>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            render={<a href={`/dashboard/${encodeURIComponent(handle)}/leads`} />}
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            <span>Pesan Masuk</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
            aria-label="Muat ulang log aktivitas"
            disabled={loading}
            onClick={() => fetchActivity({ resourceType: resourceFilter })}
          >
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <Alert variant="default" data-testid="activity-readonly-notice">
        <ShieldCheckIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Log hanya baca &amp; bebas PII mentah</AlertTitle>
        <AlertDescription>
          Catatan aktivitas ini tidak dapat diubah dan hanya menyimpan ringkasan tindakan tanpa
          menyimpan data pribadi pengunjung yang telah dihapus. Disimpan hingga 90 hari sesuai
          kebijakan retensi.
        </AlertDescription>
      </Alert>

      {loadError && (
        <Alert variant="destructive" data-testid="activity-load-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat log aktivitas</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{loadError}</span>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => fetchActivity({ resourceType: resourceFilter })}
            >
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Filter Tabs */}
      <div
        role="tablist"
        aria-label="Filter jenis aktivitas"
        className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
      >
        {RESOURCE_FILTERS.map((tab) => {
          const selected = resourceFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`activity-filter-${tab.id}`}
              onClick={() => handleFilterSelect(tab.id)}
              className={`inline-flex min-h-11 items-center rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-8 ${
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground hover:bg-muted"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Activity List */}
      {items.length === 0 ? (
        <Card data-testid="activity-empty-state">
          <CardContent className="flex flex-col items-start gap-2 py-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ActivityIcon className="size-5 shrink-0" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Belum ada catatan aktivitas
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Setiap pembaruan status, penghapusan pesan masuk, atau perubahan pengaturan akan
              tercatat otomatis di sini.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="activity-table-card">
          <CardHeader className="border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <CardTitle>Riwayat Aktivitas</CardTitle>
                <CardDescription>
                  Menampilkan{" "}
                  <span className="font-medium text-foreground tabular-nums">{items.length}</span>{" "}
                  dari{" "}
                  <span className="font-medium text-foreground tabular-nums">{totalCount}</span>{" "}
                  catatan aktivitas situs ini.
                </CardDescription>
              </div>
              <Badge variant="outline" className="tabular-nums">
                Hanya Baca
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {/* Desktop Table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Aktor</TableHead>
                    <TableHead>Aksi</TableHead>
                    <TableHead>Ringkasan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <TableRow key={entry.id} data-testid={`activity-row-${entry.id}`}>
                      <TableCell className="align-top text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatDateTimeWib(entry.createdAt)}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant="outline">
                          {ROLE_LABELS[entry.actorRole] ?? entry.actorRole}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {entry.action}
                        </code>
                      </TableCell>
                      <TableCell className="align-top">
                        <p className="text-sm text-foreground">{entry.summary}</p>
                        {entry.resourceId && (
                          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {entry.resourceType} #{entry.resourceId}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Stacked Cards (360px safe) */}
            <ul className="divide-y divide-border md:hidden">
              {items.map((entry) => (
                <li
                  key={entry.id}
                  data-testid={`activity-card-${entry.id}`}
                  className="space-y-2 px-4 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="outline">
                      {ROLE_LABELS[entry.actorRole] ?? entry.actorRole}
                    </Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatDateTimeWib(entry.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-foreground">{entry.summary}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {entry.action}
                    </code>
                    {entry.resourceId && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.resourceType} #{entry.resourceId}
                      </span>
                    )}
                  </div>
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
                    fetchActivity({
                      resourceType: resourceFilter,
                      cursor: nextCursor,
                      append: true,
                    })
                  }
                >
                  {loading ? "Memuat..." : "Muat aktivitas lebih lama"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
