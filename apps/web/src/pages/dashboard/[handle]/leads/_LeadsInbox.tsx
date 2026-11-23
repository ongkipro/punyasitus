import * as React from "react";
import {
  ActivityIcon,
  AlertCircleIcon,
  BellIcon,
  BellOffIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  InboxIcon,
  LockIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
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

export type LeadStatus = "new" | "contacted" | "closed";
export type LeadFilterStatus = "all" | LeadStatus;

export interface LeadInboxItemDto {
  readonly id: number;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly message: string;
  readonly status: LeadStatus;
  readonly preferredDate: string | null;
  readonly preferredTime: string | null;
  readonly branchId: number | null;
  readonly sourceCategory: string;
  readonly pagePath: string | null;
  readonly internalNotes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly whatsappFollowUpUrl: string | null;
}

export interface LeadStatusCountsDto {
  readonly all: number;
  readonly new: number;
  readonly contacted: number;
  readonly closed: number;
}

export interface LeadsInboxProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly lifecycleStatus: string;
  readonly canUpdate: boolean;
  readonly canDelete?: boolean;
  readonly canExportCsv: boolean;
  readonly initialItems: readonly LeadInboxItemDto[];
  readonly initialCounts: LeadStatusCountsDto;
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
  readonly initialEmailNotificationsEnabled: boolean;
  readonly initialLoadError: string | null;
}

const STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: "Baru",
  contacted: "Dihubungi",
  closed: "Selesai",
};

const STATUS_BADGE_VARIANT: Readonly<Record<LeadStatus, "info" | "warning" | "success">> = {
  new: "info",
  contacted: "warning",
  closed: "success",
};

const FILTER_TABS: readonly { readonly id: LeadFilterStatus; readonly label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "new", label: "Baru" },
  { id: "contacted", label: "Dihubungi" },
  { id: "closed", label: "Selesai" },
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

function getAllowedNextStatuses(current: LeadStatus): readonly LeadStatus[] {
  if (current === "new") return ["new", "contacted", "closed"];
  if (current === "contacted") return ["contacted", "closed"];
  return ["closed"];
}

export function LeadsInbox({
  tenantId,
  handle,
  tenantName,
  lifecycleStatus,
  canUpdate,
  canDelete = false,
  canExportCsv,
  initialItems,
  initialCounts,
  initialNextCursor,
  initialHasMore,
  initialEmailNotificationsEnabled,
  initialLoadError,
}: LeadsInboxProps) {
  const apiBase = `/api/tenants/${encodeURIComponent(tenantId)}/leads`;
  const exportCsvHref = `${apiBase}/export.csv`;

  const [items, setItems] = React.useState<readonly LeadInboxItemDto[]>(initialItems);
  const [counts, setCounts] = React.useState<LeadStatusCountsDto>(initialCounts);
  const [statusFilter, setStatusFilter] = React.useState<LeadFilterStatus>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [activeSearch, setActiveSearch] = React.useState("");
  const [nextCursor, setNextCursor] = React.useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = React.useState(initialHasMore);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(initialLoadError);

  // Email notification toggle state
  const [emailNotifEnabled, setEmailNotifEnabled] = React.useState(initialEmailNotificationsEnabled);
  const [savingNotif, setSavingNotif] = React.useState(false);
  const [notifFeedback, setNotifFeedback] = React.useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  } | null>(null);

  // Selected lead detail drawer state
  const [selectedLead, setSelectedLead] = React.useState<LeadInboxItemDto | null>(null);
  const [draftStatus, setDraftStatus] = React.useState<LeadStatus>("new");
  const [draftNotes, setDraftNotes] = React.useState("");
  const [savingLead, setSavingLead] = React.useState(false);
  const [drawerError, setDrawerError] = React.useState<{
    readonly code: string;
    readonly message: string;
  } | null>(null);
  const [drawerSuccess, setDrawerSuccess] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deletingLead, setDeletingLead] = React.useState(false);
  const [deletedBanner, setDeletedBanner] = React.useState<string | null>(null);

  const isLocked = lifecycleStatus === "locked";
  const isSuspended = lifecycleStatus === "suspended";

  const fetchLeads = React.useCallback(
    async (opts: {
      readonly status: LeadFilterStatus;
      readonly search: string;
      readonly cursor?: string | null;
      readonly append?: boolean;
    }) => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams();
        if (opts.status !== "all") params.set("status", opts.status);
        if (opts.search.trim()) params.set("q", opts.search.trim());
        if (opts.cursor) params.set("cursor", opts.cursor);
        params.set("limit", "20");

        const res = await fetch(`${apiBase}?${params.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = (await res.json().catch(() => null)) as {
          items?: LeadInboxItemDto[];
          counts?: LeadStatusCountsDto;
          notifications?: { emailEnabled?: boolean };
          page?: { hasMore?: boolean; nextCursor?: string | null };
          error?: { message?: string };
        } | null;

        if (!res.ok || !data) {
          setLoadError(
            data?.error?.message ?? "Gagal memuat daftar pesan masuk. Silakan coba lagi.",
          );
          return;
        }

        const fetchedItems = Array.isArray(data.items) ? data.items : [];
        setItems((prev) => (opts.append ? [...prev, ...fetchedItems] : fetchedItems));
        if (data.counts) setCounts(data.counts);
        if (typeof data.notifications?.emailEnabled === "boolean") {
          setEmailNotifEnabled(data.notifications.emailEnabled);
        }
        setHasMore(Boolean(data.page?.hasMore));
        setNextCursor(data.page?.nextCursor ?? null);
      } catch {
        setLoadError("Tidak dapat terhubung ke server. Periksa koneksi lalu muat ulang.");
      } finally {
        setLoading(false);
      }
    },
    [apiBase],
  );

  function openLeadDetail(lead: LeadInboxItemDto) {
    setSelectedLead(lead);
    setDraftStatus(lead.status);
    setDraftNotes(lead.internalNotes ?? "");
    setDrawerError(null);
    setDrawerSuccess(null);
    setConfirmingDelete(false);
  }

  async function handleDeleteSelectedLead() {
    if (!selectedLead || !canDelete || deletingLead) return;
    setDeletingLead(true);
    setDrawerError(null);
    setDrawerSuccess(null);

    try {
      const target = selectedLead;
      const res = await fetch(`${apiBase}/${target.id}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ expectedVersion: target.version }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        setDrawerError({
          code: data?.error?.code ?? "DELETE_FAILED",
          message:
            data?.error?.message ?? "Gagal menghapus pesan masuk secara permanen. Silakan coba lagi.",
        });
        return;
      }

      setItems((prev) => prev.filter((it) => it.id !== target.id));
      setCounts((prev) => ({
        ...prev,
        all: Math.max(0, prev.all - 1),
        [target.status]: Math.max(0, prev[target.status] - 1),
      }));
      setSelectedLead(null);
      setConfirmingDelete(false);
      setDeletedBanner(
        `Pesan #${target.id} telah dihapus secara permanen beserta data jawabannya dan dicatat di log aktivitas.`,
      );
    } catch {
      setDrawerError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menghapus pesan masuk. Silakan coba lagi.",
      });
    } finally {
      setDeletingLead(false);
    }
  }

  async function handleFilterChange(nextFilter: LeadFilterStatus) {
    setStatusFilter(nextFilter);
    await fetchLeads({ status: nextFilter, search: activeSearch });
  }

  async function handleSearchSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = searchInput.trim();
    setActiveSearch(trimmed);
    await fetchLeads({ status: statusFilter, search: trimmed });
  }

  async function handleToggleEmailNotification() {
    if (!canUpdate || savingNotif) return;
    setSavingNotif(true);
    setNotifFeedback(null);
    const nextValue = !emailNotifEnabled;
    try {
      const res = await fetch(`${apiBase}/notifications`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ emailEnabled: nextValue }),
      });
      const data = (await res.json().catch(() => null)) as {
        emailEnabled?: boolean;
        error?: { message?: string };
      } | null;

      if (!res.ok || typeof data?.emailEnabled !== "boolean") {
        setNotifFeedback({
          kind: "error",
          message:
            data?.error?.message ?? "Gagal menyimpan pengaturan notifikasi email.",
        });
        return;
      }

      setEmailNotifEnabled(data.emailEnabled);
      setNotifFeedback({
        kind: "success",
        message: data.emailEnabled
          ? "Notifikasi email pesan masuk diaktifkan (tanpa menyertakan data pribadi pengunjung)."
          : "Notifikasi email pesan masuk dimatikan. Pesan baru tetap tersimpan di kotak masuk ini.",
      });
    } catch {
      setNotifFeedback({
        kind: "error",
        message: "Gagal menghubungi server untuk mengubah pengaturan notifikasi.",
      });
    } finally {
      setSavingNotif(false);
    }
  }

  async function handleUpdateLead(nextStatus: LeadStatus, nextNotes: string) {
    if (!selectedLead || !canUpdate || savingLead) return;
    setSavingLead(true);
    setDrawerError(null);
    setDrawerSuccess(null);

    try {
      const res = await fetch(`${apiBase}/${selectedLead.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          status: nextStatus,
          internalNotes: nextNotes.trim().length > 0 ? nextNotes.trim() : null,
          version: selectedLead.version,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (LeadInboxItemDto & { error?: undefined })
        | { error?: { code?: string; message?: string } }
        | null;

      if (!res.ok || !data || !("id" in data)) {
        const errCode =
          data && "error" in data && data.error?.code ? data.error.code : "UPDATE_FAILED";
        const errMsg =
          data && "error" in data && data.error?.message
            ? data.error.message
            : "Gagal memperbarui status pesan masuk.";
        setDrawerError({ code: errCode, message: errMsg });
        return;
      }

      const updated = data as LeadInboxItemDto;
      const previousStatus = selectedLead.status;

      setSelectedLead(updated);
      setDraftStatus(updated.status);
      setDraftNotes(updated.internalNotes ?? "");
      setDrawerSuccess(`Status pesan #${updated.id} diperbarui menjadi "${STATUS_LABELS[updated.status]}".`);

      // Sync list & status counters immediately
      setItems((prev) => {
        const mapped = prev.map((item) => (item.id === updated.id ? updated : item));
        if (statusFilter !== "all" && updated.status !== statusFilter) {
          return mapped.filter((item) => item.id !== updated.id);
        }
        return mapped;
      });
      if (previousStatus !== updated.status) {
        setCounts((prev) => ({
          ...prev,
          [previousStatus]: Math.max(0, prev[previousStatus] - 1),
          [updated.status]: prev[updated.status] + 1,
        }));
      }
    } catch {
      setDrawerError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menyimpan perubahan. Silakan coba lagi.",
      });
    } finally {
      setSavingLead(false);
    }
  }

  async function handleReloadSelectedLead() {
    if (!selectedLead) return;
    setDrawerError(null);
    try {
      const res = await fetch(`${apiBase}/${selectedLead.id}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => null)) as LeadInboxItemDto | null;
      if (res.ok && data && typeof data.id === "number") {
        setSelectedLead(data);
        setDraftStatus(data.status);
        setDraftNotes(data.internalNotes ?? "");
        setItems((prev) => prev.map((it) => (it.id === data.id ? data : it)));
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6" data-testid="leads-inbox-page" data-handle={handle}>
      {/* Page Header & Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Pesan Masuk
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola pertanyaan pengunjung situs{" "}
            <span className="font-medium text-foreground">{tenantName}</span> dan tindak lanjuti
            langsung via WhatsApp.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={emailNotifEnabled}
            disabled={!canUpdate || savingNotif}
            onClick={handleToggleEmailNotification}
            data-testid="leads-email-notif-toggle"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9"
          >
            {emailNotifEnabled ? (
              <BellIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <BellOffIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span>
              Notifikasi Email: {emailNotifEnabled ? "Aktif" : "Nonaktif"}
            </span>
          </button>

          {canExportCsv && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              data-testid="leads-export-csv-btn"
              render={<a href={exportCsvHref} download={`leads-${handle}.csv`} />}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              <span>Unduh CSV</span>
            </Button>
          )}

          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            data-testid="leads-activity-log-link"
            render={<a href={`/dashboard/${encodeURIComponent(handle)}/settings/activity`} />}
          >
            <ActivityIcon className="size-4" aria-hidden="true" />
            <span>Log Aktivitas</span>
          </Button>
        </div>
      </div>

      {isSuspended ? (
        <Card data-testid="leads-suspended-panel">
          <CardContent className="space-y-4 py-8">
            <Alert variant="destructive">
              <LockIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Situs sedang dinonaktifkan sementara</AlertTitle>
              <AlertDescription>
                Daftar pesan masuk tidak dapat ditampilkan saat situs berstatus ditangguhkan
                (suspended). Pemilik situs tetap dapat mengunduh seluruh data prospek dalam format
                CSV untuk cadangan atau pemulihan.
              </AlertDescription>
            </Alert>
            {canExportCsv && (
              <div>
                <Button
                  variant="default"
                  className="min-h-11 md:min-h-9"
                  data-testid="leads-suspended-export-csv-btn"
                  render={<a href={exportCsvHref} download={`leads-${handle}.csv`} />}
                >
                  <DownloadIcon className="size-4" aria-hidden="true" />
                  <span>Unduh Data Prospek (CSV)</span>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {isLocked && (
            <Alert variant="warning" data-testid="leads-locked-banner">
              <LockIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Mode baca saja aktif</AlertTitle>
              <AlertDescription>
                Langganan situs sedang terkunci. Anda tetap dapat membaca pesan masuk dan mengunduh CSV,
                tetapi perubahan status dan catatan dinonaktifkan sementara.
              </AlertDescription>
            </Alert>
          )}

      {deletedBanner && (
        <Alert variant="success" data-testid="lead-deleted-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Pesan masuk dihapus permanen</AlertTitle>
          <AlertDescription>{deletedBanner}</AlertDescription>
        </Alert>
      )}

      {notifFeedback && (
        <Alert
          variant={notifFeedback.kind === "success" ? "success" : "destructive"}
          data-testid="leads-notif-feedback"
        >
          {notifFeedback.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>
            {notifFeedback.kind === "success"
              ? "Pengaturan notifikasi diperbarui"
              : "Gagal memperbarui notifikasi"}
          </AlertTitle>
          <AlertDescription>{notifFeedback.message}</AlertDescription>
        </Alert>
      )}

      {loadError && (
        <Alert variant="destructive" data-state-panel="error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat pesan masuk</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{loadError}</span>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => fetchLeads({ status: statusFilter, search: activeSearch })}
            >
              Coba lagi
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Filter status pesan masuk"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {FILTER_TABS.map((tab) => {
            const selected = statusFilter === tab.id;
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`leads-filter-${tab.id}`}
                onClick={() => handleFilterChange(tab.id)}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-8 ${
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-muted"
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`rounded-sm px-1.5 py-0.5 text-xs tabular-nums ${
                    selected
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
              placeholder="Cari nama, WhatsApp, atau pesan..."
              aria-label="Cari pesan masuk"
              className="pl-9"
              data-testid="leads-search-input"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            className="min-h-11 shrink-0 md:min-h-9"
            disabled={loading}
          >
            Cari
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 shrink-0 md:min-h-9 md:min-w-9"
            aria-label="Muat ulang daftar pesan masuk"
            disabled={loading}
            onClick={() => fetchLeads({ status: statusFilter, search: activeSearch })}
          >
            <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </form>
      </div>

      {/* Empty State vs List */}
      {items.length === 0 ? (
        <Card data-state-panel="empty-leads">
          <CardContent className="flex flex-col items-start gap-3 py-10">
            <div className="flex items-center gap-2 text-muted-foreground">
              <InboxIcon className="size-5 shrink-0" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {activeSearch || statusFilter !== "all"
                  ? "Tidak ada pesan yang cocok dengan filter"
                  : "Belum ada pesan masuk"}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {activeSearch || statusFilter !== "all"
                ? "Ubah kata kunci pencarian atau pilih tab status lain untuk melihat pesan pengunjung."
                : "Setiap pengunjung yang mengisi formulir kontak di situs publik Anda akan tampil di sini lengkap dengan tombol balas cepat WhatsApp."}
            </p>
            {(activeSearch || statusFilter !== "all") && (
              <Button
                variant="outline"
                className="min-h-11 md:min-h-9"
                onClick={() => {
                  setSearchInput("");
                  setActiveSearch("");
                  setStatusFilter("all");
                  void fetchLeads({ status: "all", search: "" });
                }}
              >
                Tampilkan semua pesan
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="leads-list-card">
          <CardHeader className="border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <CardTitle>Daftar Pesan Pengunjung</CardTitle>
                <CardDescription>
                  Menampilkan <span className="font-medium text-foreground tabular-nums">{items.length}</span>{" "}
                  pesan. Notifikasi email tidak pernah menyertakan data pribadi pengunjung.
                </CardDescription>
              </div>
              <Badge variant="outline" className="tabular-nums">
                {counts.new} belum ditindaklanjuti
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {/* Desktop Table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pengunjung</TableHead>
                    <TableHead>Pesan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Waktu Masuk</TableHead>
                    <TableHead className="text-right">Tindakan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((lead) => (
                    <TableRow key={lead.id} data-testid={`lead-row-${lead.id}`}>
                      <TableCell className="align-top">
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">{lead.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">{lead.phone}</p>
                          {lead.email && (
                            <p className="text-xs text-muted-foreground">{lead.email}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs align-top">
                        <p className="line-clamp-2 text-sm text-foreground">{lead.message}</p>
                        {lead.pagePath && (
                          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                            Halaman: {lead.pagePath}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant={STATUS_BADGE_VARIANT[lead.status]}
                          data-testid={`lead-status-badge-${lead.id}`}
                        >
                          {STATUS_LABELS[lead.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                        {formatDateTimeWib(lead.createdAt)}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="inline-flex items-center justify-end gap-2">
                          {lead.whatsappFollowUpUrl && (
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`lead-wa-link-${lead.id}`}
                              render={
                                <a
                                  href={lead.whatsappFollowUpUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                />
                              }
                            >
                              <MessageCircleIcon className="size-3.5 text-primary" aria-hidden="true" />
                              <span>WhatsApp</span>
                            </Button>
                          )}
                          <Button
                            variant="default"
                            size="sm"
                            data-testid={`lead-open-detail-${lead.id}`}
                            onClick={() => openLeadDetail(lead)}
                          >
                            Detail
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Stacked Cards (360px safe, >= 44px tap targets) */}
            <ul className="divide-y divide-border md:hidden">
              {items.map((lead) => (
                <li
                  key={lead.id}
                  data-testid={`lead-card-${lead.id}`}
                  className="space-y-3 px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{lead.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{lead.phone}</p>
                    </div>
                    <Badge
                      variant={STATUS_BADGE_VARIANT[lead.status]}
                      data-testid={`lead-mobile-status-${lead.id}`}
                    >
                      {STATUS_LABELS[lead.status]}
                    </Badge>
                  </div>
                  <p className="line-clamp-3 text-sm text-foreground">{lead.message}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {formatDateTimeWib(lead.createdAt)}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {lead.whatsappFollowUpUrl && (
                      <Button
                        variant="outline"
                        className="min-h-11 flex-1"
                        data-testid={`lead-mobile-wa-${lead.id}`}
                        render={
                          <a
                            href={lead.whatsappFollowUpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          />
                        }
                      >
                        <MessageCircleIcon className="size-4 text-primary" aria-hidden="true" />
                        <span>WhatsApp</span>
                      </Button>
                    )}
                    <Button
                      variant="default"
                      className="min-h-11 flex-1"
                      data-testid={`lead-mobile-detail-${lead.id}`}
                      onClick={() => openLeadDetail(lead)}
                    >
                      Lihat Detail
                    </Button>
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
                    fetchLeads({
                      status: statusFilter,
                      search: activeSearch,
                      cursor: nextCursor,
                      append: true,
                    })
                  }
                >
                  {loading ? "Memuat..." : "Muat pesan lebih lama"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
        </>
      )}

      {/* Lead Detail Drawer (Base UI Sheet) */}
      <Sheet
        open={selectedLead !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedLead(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-[min(28rem,94vw)] overflow-y-auto"
          data-testid="lead-detail-sheet"
        >
          {selectedLead && (
            <>
              <SheetHeader>
                <div className="flex items-center gap-2">
                  <SheetTitle>Pesan #{selectedLead.id}</SheetTitle>
                  <Badge variant={STATUS_BADGE_VARIANT[selectedLead.status]}>
                    {STATUS_LABELS[selectedLead.status]}
                  </Badge>
                </div>
                <SheetDescription>
                  Diterima pada {formatDateTimeWib(selectedLead.createdAt)} · Versi{" "}
                  <span className="tabular-nums">{selectedLead.version}</span>
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4 py-2">
                {drawerSuccess && (
                  <Alert variant="success" data-testid="lead-detail-success">
                    <CheckCircle2Icon className="size-4" aria-hidden="true" />
                    <AlertTitle>Perubahan tersimpan</AlertTitle>
                    <AlertDescription>{drawerSuccess}</AlertDescription>
                  </Alert>
                )}

                {drawerError && (
                  <Alert variant="destructive" data-testid="lead-detail-error">
                    <AlertCircleIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>
                      {drawerError.code === "STALE_VERSION"
                        ? "Data telah diperbarui pengguna lain"
                        : "Gagal menyimpan perubahan"}
                    </AlertTitle>
                    <AlertDescription className="space-y-2">
                      <p>{drawerError.message}</p>
                      {drawerError.code === "STALE_VERSION" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-11 md:min-h-8"
                          onClick={handleReloadSelectedLead}
                        >
                          Muat ulang data terbaru
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Visitor Details */}
                <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted/30 p-3.5 text-sm">
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">Nama Pengunjung</dt>
                    <dd className="font-semibold text-foreground">{selectedLead.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-muted-foreground">Nomor WhatsApp</dt>
                    <dd className="font-mono text-foreground">{selectedLead.phone}</dd>
                  </div>
                  {selectedLead.email && (
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Email</dt>
                      <dd className="break-all text-foreground">{selectedLead.email}</dd>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Sumber</dt>
                      <dd className="text-foreground">{selectedLead.sourceCategory}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-muted-foreground">Halaman Asal</dt>
                      <dd className="truncate font-mono text-xs text-foreground">
                        {selectedLead.pagePath ?? "/"}
                      </dd>
                    </div>
                  </div>
                </dl>

                {/* Message Body */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Isi Pesan
                  </h3>
                  <div className="rounded-lg border border-border bg-card p-3.5 text-sm whitespace-pre-wrap text-foreground">
                    {selectedLead.message}
                  </div>
                </div>

                {/* 1-Click WhatsApp Follow-Up */}
                {selectedLead.whatsappFollowUpUrl && (
                  <Button
                    variant="default"
                    className="min-h-11 w-full bg-[#0b6b3a] text-white hover:bg-[#095930]"
                    data-testid="lead-detail-wa-btn"
                    render={
                      <a
                        href={selectedLead.whatsappFollowUpUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    <MessageCircleIcon className="size-4" aria-hidden="true" />
                    <span>Tindak Lanjuti via WhatsApp</span>
                    <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                )}

                {/* Status Transition Controls */}
                <div className="space-y-2">
                  <span className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Status Tindak Lanjut
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {(["new", "contacted", "closed"] as const).map((statusOption) => {
                      const allowed = getAllowedNextStatuses(selectedLead.status).includes(
                        statusOption,
                      );
                      const active = draftStatus === statusOption;
                      return (
                        <Button
                          key={statusOption}
                          type="button"
                          variant={active ? "default" : "outline"}
                          className="min-h-11 flex-1 md:min-h-9"
                          disabled={!canUpdate || !allowed || savingLead}
                          data-testid={`lead-status-btn-${statusOption}`}
                          onClick={() => setDraftStatus(statusOption)}
                        >
                          {STATUS_LABELS[statusOption]}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                {/* Internal Notes */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="lead-internal-notes"
                    className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    Catatan Internal Tim
                  </label>
                  <textarea
                    id="lead-internal-notes"
                    rows={3}
                    maxLength={2000}
                    disabled={!canUpdate || savingLead}
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Tambahkan ringkasan hasil tindak lanjut (hanya terlihat oleh tim Anda)..."
                    className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60"
                    data-testid="lead-notes-input"
                  />
                </div>

                {/* Permanent Single-Lead Deletion (Owner / Admin; REQ-094) */}
                {canDelete && (
                  <div className="space-y-2.5 rounded-lg border border-destructive-border bg-destructive-soft/40 p-3.5">
                    <div className="space-y-0.5">
                      <h3 className="text-xs font-semibold tracking-wide text-destructive uppercase">
                        Hapus Permanen Pesan Masuk
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Menghapus pesan #{selectedLead.id} beserta data kontak, jawaban formulir,
                        dan catatan persetujuannya secara permanen. Tindakan ini dicatat di Log
                        Aktivitas tanpa menyimpan data pribadi yang dihapus.
                      </p>
                    </div>
                    {!confirmingDelete ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="min-h-11 w-full md:min-h-9"
                        disabled={savingLead || deletingLead}
                        data-testid="lead-delete-request-btn"
                        onClick={() => setConfirmingDelete(true)}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                        <span>Hapus Permanen Pesan #{selectedLead.id}</span>
                      </Button>
                    ) : (
                      <div
                        className="space-y-2 rounded-md border border-destructive-border bg-card p-3"
                        data-testid="lead-delete-confirm-panel"
                      >
                        <p className="text-xs font-medium text-foreground">
                          Konfirmasi penghapusan permanen pesan #{selectedLead.id}? Data tidak dapat
                          dipulihkan setelah dihapus.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 flex-1 md:min-h-9"
                            disabled={deletingLead}
                            data-testid="lead-delete-cancel-btn"
                            onClick={() => setConfirmingDelete(false)}
                          >
                            Batal
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="min-h-11 flex-1 md:min-h-9"
                            disabled={deletingLead}
                            data-testid="lead-delete-confirm-btn"
                            onClick={handleDeleteSelectedLead}
                          >
                            {deletingLead ? "Menghapus..." : "Ya, Hapus Permanen"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <SheetFooter>
                <Button
                  type="button"
                  className="min-h-11 w-full md:min-h-9"
                  disabled={!canUpdate || savingLead}
                  data-testid="lead-save-btn"
                  onClick={() => handleUpdateLead(draftStatus, draftNotes)}
                >
                  {savingLead ? "Menyimpan..." : "Simpan Status & Catatan"}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
