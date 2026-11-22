import * as React from "react";
import {
  AlertCircleIcon,
  FilterIcon,
  LockIcon,
  RefreshCwIcon,
  RotateCcwIcon,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface AuditExplorerItem {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly tenantId: string | null;
  readonly reason: string | null;
  readonly outcome: "success" | "denied" | "error";
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly createdAtIso: string;
}

export interface AuditCursor {
  readonly beforeCreatedAtMs: number;
  readonly beforeId: string;
}

export interface AuditExplorerProps {
  readonly initialItems: readonly AuditExplorerItem[];
  readonly initialHasMore: boolean;
  readonly initialNextCursor: AuditCursor | null;
}

function formatOutcomeBadge(outcome: AuditExplorerItem["outcome"]): {
  readonly label: string;
  readonly variant: "success" | "warning" | "destructive";
} {
  if (outcome === "success") return { label: "Berhasil", variant: "success" };
  if (outcome === "denied") return { label: "Ditolak", variant: "warning" };
  return { label: "Gagal", variant: "destructive" };
}

function formatTimeId(ms: number): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: "Asia/Jakarta",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function AuditExplorer({
  initialItems,
  initialHasMore,
  initialNextCursor,
}: AuditExplorerProps) {
  const [items, setItems] = React.useState<readonly AuditExplorerItem[]>(initialItems);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [nextCursor, setNextCursor] = React.useState<AuditCursor | null>(initialNextCursor);

  // Filters
  const [actionFilter, setActionFilter] = React.useState("");
  const [actorFilter, setActorFilter] = React.useState("");
  const [targetFilter, setTargetFilter] = React.useState("");
  const [outcomeFilter, setOutcomeFilter] = React.useState("");
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");

  const [loading, setLoading] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [hasActiveFilter, setHasActiveFilter] = React.useState(false);

  async function fetchAudit(options: {
    readonly append?: boolean;
    readonly cursor?: AuditCursor | null;
    readonly overrides?: {
      readonly action?: string;
      readonly actor?: string;
      readonly target?: string;
      readonly outcome?: string;
      readonly from?: string;
      readonly to?: string;
    };
  }) {
    const a = options.overrides ? (options.overrides.action ?? "") : actionFilter;
    const act = options.overrides ? (options.overrides.actor ?? "") : actorFilter;
    const tgt = options.overrides ? (options.overrides.target ?? "") : targetFilter;
    const out = options.overrides ? (options.overrides.outcome ?? "") : outcomeFilter;
    const fr = options.overrides ? (options.overrides.from ?? "") : fromDate;
    const to = options.overrides ? (options.overrides.to ?? "") : toDate;

    const params = new URLSearchParams();
    params.set("limit", "25");
    if (a.trim()) params.set("action", a.trim());
    if (act.trim()) params.set("actorUserId", act.trim());
    if (tgt.trim()) params.set("targetId", tgt.trim());
    if (out.trim()) params.set("outcome", out.trim());
    if (fr.trim()) params.set("from", `${fr.trim()}T00:00:00.000Z`);
    if (to.trim()) params.set("to", `${to.trim()}T23:59:59.999Z`);
    if (options.cursor) {
      params.set("beforeCreatedAtMs", String(options.cursor.beforeCreatedAtMs));
      params.set("beforeId", options.cursor.beforeId);
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/console/audit?${params.toString()}`, {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        items?: readonly AuditExplorerItem[];
        hasMore?: boolean;
        nextCursor?: AuditCursor | null;
        message?: string;
      };
      if (!res.ok || !data.success || !Array.isArray(data.items)) {
        setErrorMessage(data.message ?? "Gagal memuat log audit platform.");
        return;
      }

      setItems((prev) => (options.append ? [...prev, ...data.items!] : data.items!));
      setHasMore(Boolean(data.hasMore));
      setNextCursor(data.nextCursor ?? null);
      setHasActiveFilter(Boolean(a || act || tgt || out || fr || to));
    } catch {
      setErrorMessage("Koneksi terputus saat mengambil log audit. Silakan coba lagi.");
    } finally {
      setLoading(false);
    }
  }

  function handleFilterSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void fetchAudit({ append: false, cursor: null });
  }

  function handleResetFilters() {
    setActionFilter("");
    setActorFilter("");
    setTargetFilter("");
    setOutcomeFilter("");
    setFromDate("");
    setToDate("");
    void fetchAudit({
      append: false,
      cursor: null,
      overrides: { action: "", actor: "", target: "", outcome: "", from: "", to: "" },
    });
  }

  return (
    <div className="space-y-5" data-testid="console-audit-explorer">
      <Alert variant="info" data-testid="audit-immutable-notice">
        <LockIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Log Audit Permanen (Append-Only & Tersensor Otomatis)</AlertTitle>
        <AlertDescription>
          Seluruh entri audit bersifat hanya baca dan dilindungi pemicu basis data. Kata sandi,
          token, kunci API, cookie, email, nomor telepon, dan isi pesan pelanggan selalu disensor
          otomatis.
        </AlertDescription>
      </Alert>

      {errorMessage && (
        <Alert variant="destructive" data-testid="audit-error-alert" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat log audit</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Filter Form */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <FilterIcon className="size-4 text-primary" aria-hidden="true" />
            <span>Filter Log Audit</span>
          </CardTitle>
          <CardDescription>
            Saring berdasarkan aksi, ID aktor, target, hasil, atau rentang tanggal (UTC).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleFilterSubmit}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="audit-filter-form"
          >
            <div className="space-y-1">
              <label htmlFor="audit-filter-action" className="block text-xs font-medium text-foreground">
                Aksi
              </label>
              <Input
                id="audit-filter-action"
                placeholder="Contoh: platform_settings.update"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="audit-filter-actor" className="block text-xs font-medium text-foreground">
                ID Aktor
              </label>
              <Input
                id="audit-filter-actor"
                placeholder="ID pengguna aktor"
                value={actorFilter}
                onChange={(e) => setActorFilter(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="audit-filter-target" className="block text-xs font-medium text-foreground">
                ID Target
              </label>
              <Input
                id="audit-filter-target"
                placeholder="ID target atau kunci pengaturan"
                value={targetFilter}
                onChange={(e) => setTargetFilter(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="audit-filter-outcome" className="block text-xs font-medium text-foreground">
                Hasil
              </label>
              <select
                id="audit-filter-outcome"
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
              >
                <option value="">Semua hasil</option>
                <option value="success">Berhasil (success)</option>
                <option value="denied">Ditolak (denied)</option>
                <option value="error">Gagal (error)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="audit-filter-from" className="block text-xs font-medium text-foreground">
                Dari Tanggal
              </label>
              <Input
                id="audit-filter-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="audit-filter-to" className="block text-xs font-medium text-foreground">
                Sampai Tanggal
              </label>
              <Input
                id="audit-filter-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1 sm:col-span-2 lg:col-span-3">
              <Button
                type="submit"
                disabled={loading}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="audit-filter-submit"
              >
                <FilterIcon className="size-4" aria-hidden="true" />
                {loading ? "Menyaring..." : "Terapkan Filter"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={handleResetFilters}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="audit-filter-reset"
              >
                <RotateCcwIcon className="size-4" aria-hidden="true" />
                Reset Filter
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Riwayat Audit Platform</CardTitle>
              <CardDescription className="tabular-nums">
                Menampilkan {items.length} entri terbaru
              </CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void fetchAudit({ append: false, cursor: null })}
              className="min-h-11 md:min-h-8"
              data-testid="audit-refresh-button"
            >
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Muat Ulang
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 ? (
            <div className="space-y-3 py-6" data-testid="audit-empty-state">
              <p className="text-sm font-medium text-foreground">
                {hasActiveFilter
                  ? "Tidak ada catatan audit yang cocok dengan filter Anda."
                  : "Belum ada catatan audit platform yang tersimpan."}
              </p>
              {hasActiveFilter && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResetFilters}
                  className="min-h-11 md:min-h-9"
                >
                  Hapus semua filter
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile card view (< md) */}
              <div className="space-y-3 md:hidden" data-testid="audit-mobile-list">
                {items.map((item) => {
                  const badge = formatOutcomeBadge(item.outcome);
                  return (
                    <div
                      key={item.id}
                      className="space-y-2 rounded-lg border border-border bg-card p-3.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="break-all font-mono text-xs font-semibold text-foreground">
                          {item.action}
                        </code>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatTimeId(item.createdAt)} • Peran: {item.actorRole}
                      </p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        Target: {item.targetType} / {item.targetId}
                      </p>
                      {item.reason && (
                        <p className="break-words text-xs text-foreground">{item.reason}</p>
                      )}
                      {item.requestId && (
                        <p className="break-all font-mono text-[11px] text-muted-foreground">
                          Req: {item.requestId}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="audit-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Waktu (WIB)</TableHead>
                      <TableHead>Aksi</TableHead>
                      <TableHead>Aktor</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Alasan (Tersensor)</TableHead>
                      <TableHead>Hasil</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const badge = formatOutcomeBadge(item.outcome);
                      return (
                        <TableRow key={item.id} data-testid={`audit-row-${item.id}`}>
                          <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                            {formatTimeId(item.createdAt)}
                          </TableCell>
                          <TableCell>
                            <code className="font-mono text-xs font-medium text-foreground">
                              {item.action}
                            </code>
                            {item.requestId && (
                              <p className="font-mono text-[11px] text-muted-foreground">
                                {item.requestId}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <p className="font-medium text-foreground">{item.actorRole}</p>
                            <p className="font-mono text-muted-foreground">
                              {item.actorUserId ?? "sistem"}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs">
                            <p className="font-medium text-foreground">{item.targetType}</p>
                            <p className="max-w-[14rem] truncate font-mono text-muted-foreground">
                              {item.targetId}
                            </p>
                          </TableCell>
                          <TableCell className="max-w-xs break-words text-xs text-foreground">
                            {item.reason ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {hasMore && nextCursor && (
                <div className="pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading}
                    onClick={() => void fetchAudit({ append: true, cursor: nextCursor })}
                    className="min-h-11 w-full sm:w-auto md:min-h-9"
                    data-testid="audit-load-more"
                  >
                    {loading ? "Memuat halaman berikutnya..." : "Muat entri lebih lama"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
