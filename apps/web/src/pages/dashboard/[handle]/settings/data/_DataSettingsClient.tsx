import { useCallback, useMemo, useState, type SyntheticEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  ClockIcon,
  DownloadIcon,
  FileArchiveIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export interface DataSettingsExportItem {
  readonly id: string;
  readonly requestDay: string;
  readonly status: "queued" | "processing" | "ready" | "failed" | "expired" | "deleted";
  readonly archiveBytes: number | null;
  readonly archiveSha256: string | null;
  readonly manifest: {
    readonly counts?: {
      readonly pages: number;
      readonly posts: number;
      readonly offerings: number;
      readonly leads: number;
      readonly mediaIncluded: number;
      readonly mediaSkipped: number;
    };
    readonly truncated?: {
      readonly pages: boolean;
      readonly posts: boolean;
      readonly offerings: boolean;
      readonly leads: boolean;
      readonly media: boolean;
      readonly any: boolean;
    };
  } | null;
  readonly downloadUrl: string | null;
  readonly downloadExpiresAt: string | null;
  readonly downloadExpiresAtLabel: string | null;
  readonly downloadCount: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly createdAtLabel: string | null;
  readonly completedAtLabel: string | null;
}

export interface DataSettingsDeletionRequestDto {
  readonly id: string;
  readonly status: "scheduled" | "canceled" | "purging" | "purged";
  readonly confirmationMethod: string;
  readonly reason: string | null;
  readonly deletionRequestedAt: string;
  readonly deletionRequestedAtLabel: string | null;
  readonly deletionDueAt: string;
  readonly deletionDueAtLabel: string | null;
  readonly previousStatus: string;
  readonly canceledAt: string | null;
  readonly canceledAtLabel: string | null;
}

export interface DataSettingsDeletionState {
  readonly tenantId: string;
  readonly handle: string;
  readonly siteStatus: string;
  readonly operatorHold: boolean;
  readonly operatorHoldReason: string | null;
  readonly undoWindowDays: number;
  readonly canRequestDeletion: boolean;
  readonly canCancelDeletion: boolean;
  readonly remainingUndoMs: number;
  readonly remainingUndoDays: number;
  readonly activeRequest: DataSettingsDeletionRequestDto | null;
  readonly latestRequest: DataSettingsDeletionRequestDto | null;
}

export interface DataSettingsAuthCapabilities {
  readonly hasPasswordAccount: boolean;
  readonly twoFactorEnabled: boolean;
  readonly recentTwoFactorVerified: boolean;
}

export interface DataSettingsClientProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly workspaceName: string;
  readonly basePath: string;
  readonly todayKey: string;
  readonly initialExports: readonly DataSettingsExportItem[];
  readonly initialHasExportToday: boolean;
  readonly initialDeletion: DataSettingsDeletionState;
  readonly authCapabilities: DataSettingsAuthCapabilities;
}

function formatBytesId(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function exportStatusBadge(status: DataSettingsExportItem["status"]): {
  readonly label: string;
  readonly variant: "success" | "info" | "warning" | "destructive" | "secondary";
} {
  switch (status) {
    case "ready":
      return { label: "Siap Diunduh", variant: "success" };
    case "queued":
      return { label: "Dalam Antrean", variant: "info" };
    case "processing":
      return { label: "Sedang Diproses", variant: "info" };
    case "failed":
      return { label: "Gagal", variant: "destructive" };
    case "expired":
    case "deleted":
      return { label: "Kedaluwarsa", variant: "secondary" };
  }
}

export function DataSettingsClient(props: DataSettingsClientProps) {
  const [exportsList, setExportsList] = useState<readonly DataSettingsExportItem[]>(
    props.initialExports,
  );
  const [hasExportToday, setHasExportToday] = useState<boolean>(props.initialHasExportToday);
  const [exportBusy, setExportBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{
    readonly kind: "success" | "error" | "info";
    readonly message: string;
  } | null>(null);

  const [deletion, setDeletion] = useState<DataSettingsDeletionState>(props.initialDeletion);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmHandle, setConfirmHandle] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [deletionReason, setDeletionReason] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [deletionFeedback, setDeletionFeedback] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  } | null>(null);

  const expectedHandle = props.handle.trim().toLowerCase();
  const handleMatches = useMemo(
    () => confirmHandle.trim().toLowerCase() === expectedHandle,
    [confirmHandle, expectedHandle],
  );

  const exportsApiUrl = `/api/tenants/${encodeURIComponent(props.tenantId)}/exports`;
  const deletionApiUrl = `/api/tenants/${encodeURIComponent(props.tenantId)}/deletion`;
  const deletionCancelApiUrl = `/api/tenants/${encodeURIComponent(props.tenantId)}/deletion/cancel`;

  const refreshExports = useCallback(async () => {
    setRefreshBusy(true);
    try {
      const res = await fetch(exportsApiUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const json = (await res.json().catch(() => null)) as {
        items?: DataSettingsExportItem[];
        hasExportToday?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setExportFeedback({
          kind: "error",
          message: json?.error?.message ?? "Gagal memuat ulang daftar arsip ekspor.",
        });
        return;
      }
      if (Array.isArray(json?.items)) {
        setExportsList(json.items);
      }
      if (typeof json?.hasExportToday === "boolean") {
        setHasExportToday(json.hasExportToday);
      }
    } catch {
      setExportFeedback({
        kind: "error",
        message: "Koneksi terputus saat memuat daftar arsip ekspor.",
      });
    } finally {
      setRefreshBusy(false);
    }
  }, [exportsApiUrl]);

  const handleRequestExport = useCallback(async () => {
    setExportBusy(true);
    setExportFeedback(null);
    try {
      const res = await fetch(exportsApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => null)) as {
        export?: DataSettingsExportItem;
        error?: { code?: string; message?: string };
      } | null;

      if (!res.ok) {
        if (res.status === 429) {
          setHasExportToday(true);
        }
        setExportFeedback({
          kind: "error",
          message: json?.error?.message ?? "Gagal memulai pembuatan arsip situs.",
        });
        return;
      }

      if (json?.export) {
        setExportsList((prev) => [json.export!, ...prev.filter((i) => i.id !== json.export!.id)]);
        setHasExportToday(true);
        setExportFeedback({
          kind: json.export.status === "ready" ? "success" : "info",
          message:
            json.export.status === "ready"
              ? "Arsip situs (.zip) berhasil dibuat dan siap diunduh selama 24 jam."
              : "Permintaan arsip situs masuk antrean. Muat ulang sebentar lagi untuk mengunduh berkas ZIP.",
        });
      }
    } catch {
      setExportFeedback({
        kind: "error",
        message: "Gagal menghubungi server untuk membuat arsip ekspor.",
      });
    } finally {
      setExportBusy(false);
    }
  }, [exportsApiUrl]);

  const handleScheduleDeletion = useCallback(
    async (e: SyntheticEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!handleMatches) return;
      setDeleteBusy(true);
      setDeletionFeedback(null);

      try {
        const payload: Record<string, unknown> = {
          confirmHandle: confirmHandle.trim(),
        };
        if (currentPassword.length > 0) {
          payload.currentPassword = currentPassword;
        }
        if (deletionReason.trim().length > 0) {
          payload.reason = deletionReason.trim();
        }

        const res = await fetch(deletionApiUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
        const json = (await res.json().catch(() => null)) as {
          deletion?: DataSettingsDeletionState;
          error?: { code?: string; message?: string };
        } | null;

        if (!res.ok) {
          setDeletionFeedback({
            kind: "error",
            message: json?.error?.message ?? "Gagal menjadwalkan penghapusan situs.",
          });
          return;
        }

        if (json?.deletion) {
          setDeletion(json.deletion);
        }
        setDeleteDialogOpen(false);
        setConfirmHandle("");
        setCurrentPassword("");
        setDeletionReason("");
        setDeletionFeedback({
          kind: "success",
          message:
            "Situs telah dinonaktifkan dan dijadwalkan untuk dihapus permanen setelah masa pembatalan 7 hari.",
        });
      } catch {
        setDeletionFeedback({
          kind: "error",
          message: "Koneksi terputus saat memproses permintaan penghapusan situs.",
        });
      } finally {
        setDeleteBusy(false);
      }
    },
    [confirmHandle, currentPassword, deletionApiUrl, deletionReason, handleMatches],
  );

  const handleCancelDeletion = useCallback(async () => {
    setCancelBusy(true);
    setDeletionFeedback(null);
    try {
      const res = await fetch(deletionCancelApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => null)) as {
        deletion?: DataSettingsDeletionState;
        restoredStatus?: string;
        error?: { message?: string };
      } | null;

      if (!res.ok) {
        setDeletionFeedback({
          kind: "error",
          message: json?.error?.message ?? "Gagal membatalkan jadwal penghapusan situs.",
        });
        return;
      }

      if (json?.deletion) {
        setDeletion(json.deletion);
      }
      setDeletionFeedback({
        kind: "success",
        message: "Penghapusan dibatalkan. Situs Anda telah aktif kembali tanpa kehilangan data.",
      });
    } catch {
      setDeletionFeedback({
        kind: "error",
        message: "Koneksi terputus saat membatalkan jadwal penghapusan.",
      });
    } finally {
      setCancelBusy(false);
    }
  }, [deletionCancelApiUrl]);

  const activeDeletion = deletion.activeRequest;

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-10"
      data-testid="settings-data-workspace"
    >
      {/* Page Header */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              Data Situs &amp; Penghapusan
            </h1>
            <Badge variant="outline">Khusus Pemilik Situs</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Unduh salinan arsip penuh situs <strong>{props.workspaceName}</strong> (
            <span className="font-mono text-xs">{props.handle}</span>) atau jadwalkan penghapusan
            mandiri dengan masa pembatalan 7 hari.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            render={<a href={`${props.basePath}/settings`} />}
          >
            Kembali ke Pengaturan
          </Button>
        </div>
      </div>

      {/* Prominent Undo Banner when deletion is currently scheduled */}
      {activeDeletion && activeDeletion.status === "scheduled" ? (
        <Alert variant="destructive" data-testid="deletion-scheduled-banner">
          <ShieldAlertIcon />
          <AlertTitle>Penghapusan Situs Dijadwalkan — Situs Saat Ini Offline</AlertTitle>
          <AlertDescription className="min-w-0 space-y-3">
            <p className="break-words">
              Pengunjung saat ini melihat halaman perbaikan netral. Data Anda masih aman dan dapat
              dipulihkan sepenuhnya hingga{" "}
              <strong data-testid="deletion-undo-deadline">
                {activeDeletion.deletionDueAtLabel ?? activeDeletion.deletionDueAt}
              </strong>{" "}
              ({deletion.remainingUndoDays} hari tersisa). Setelah batas waktu berakhir, situs akan
              dihapus permanen secara otomatis sementara catatan penagihan dan audit tetap disimpan
              sesuai ketentuan retensi.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="default"
                size="lg"
                className="h-auto min-h-11 max-w-full whitespace-normal py-2.5 text-center"
                disabled={cancelBusy || !deletion.canCancelDeletion}
                onClick={handleCancelDeletion}
                data-testid="cancel-deletion-btn"
              >
                <RotateCcwIcon />
                {cancelBusy ? "Memulihkan situs..." : "Batalkan Penghapusan & Aktifkan Situs"}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Section 1: Full-Website Export Archive */}
      <Card data-testid="site-export-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <FileArchiveIcon className="size-4 text-primary" />
                Ekspor Arsip Situs Penuh (.zip)
              </CardTitle>
              <CardDescription>
                Satu berkas ZIP berisi halaman (<code>pages.json</code>), artikel blog (
                <code>posts.json</code>), penawaran (<code>offerings.json</code>), pesan masuk (
                <code>leads.csv</code>), dan berkas media (<code>media/</code>).
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                disabled={refreshBusy}
                onClick={refreshExports}
                data-testid="refresh-exports-btn"
              >
                <RefreshCwIcon className={refreshBusy ? "animate-spin" : undefined} />
                Muat Ulang
              </Button>
              <Button
                type="button"
                variant="default"
                className="min-h-11 sm:min-h-9"
                disabled={exportBusy || hasExportToday}
                onClick={handleRequestExport}
                data-testid="request-export-btn"
              >
                <ArchiveIcon />
                {exportBusy
                  ? "Menyiapkan Arsip..."
                  : hasExportToday
                    ? "Batas Harian Tercapai (1/hari)"
                    : "Buat Arsip Situs (.zip)"}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground sm:grid-cols-3">
            <div className="flex items-start gap-2">
              <ClockIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
              <span>
                <strong className="text-foreground">Batas Harian:</strong> Maksimal 1 arsip per
                situs per hari (WIB).
              </span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
              <span>
                <strong className="text-foreground">Tautan Aman 24 Jam:</strong> Hanya dapat diunduh
                oleh akun Pemilik Situs ini dan kedaluwarsa otomatis setelah 24 jam.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
              <span>
                <strong className="text-foreground">Bebas Kredensial:</strong> Kata sandi, token
                sesi, dan data rahasia tidak pernah disertakan.
              </span>
            </div>
          </div>

          {exportFeedback ? (
            <Alert
              variant={
                exportFeedback.kind === "error"
                  ? "destructive"
                  : exportFeedback.kind === "success"
                    ? "success"
                    : "info"
              }
              data-testid="export-feedback-alert"
            >
              {exportFeedback.kind === "error" ? <AlertCircleIcon /> : <CheckCircle2Icon />}
              <AlertDescription>{exportFeedback.message}</AlertDescription>
            </Alert>
          ) : null}

          {exportsList.length === 0 ? (
            <div
              className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
              data-testid="exports-empty-state"
            >
              Belum ada arsip ekspor yang dibuat untuk situs ini. Klik{" "}
              <strong className="text-foreground">Buat Arsip Situs (.zip)</strong> untuk memulai.
            </div>
          ) : (
            <div className="space-y-2.5" data-testid="exports-list">
              {exportsList.map((item) => {
                const badge = exportStatusBadge(item.status);
                const counts = item.manifest?.counts;
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5 sm:flex-row sm:items-center sm:justify-between"
                    data-testid={`export-row-${item.id}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {item.manifest?.truncated?.any ? (
                          <Badge variant="warning" data-testid={`export-truncated-${item.id}`}>
                            Sebagian Terpotong
                          </Badge>
                        ) : null}
                        <span className="break-all font-mono text-xs text-muted-foreground">{item.id}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.createdAtLabel ?? item.requestDay}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>Ukuran: {formatBytesId(item.archiveBytes)}</span>
                        {counts ? (
                          <span>
                            {counts.pages} halaman · {counts.posts} artikel · {counts.offerings}{" "}
                            penawaran · {counts.leads} prospek · {counts.mediaIncluded} media
                          </span>
                        ) : null}
                        {item.downloadExpiresAtLabel ? (
                          <span>Berlaku hingga: {item.downloadExpiresAtLabel}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {item.status === "ready" && item.downloadUrl ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-11 w-full sm:min-h-9 sm:w-auto"
                          render={<a href={item.downloadUrl} download />}
                          data-testid={`download-export-${item.id}`}
                        >
                          <DownloadIcon />
                          Unduh ZIP
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {item.status === "queued" || item.status === "processing"
                            ? "Menunggu proses..."
                            : item.status === "failed"
                              ? `Gagal (${item.errorCode ?? "ERR"})`
                              : "Tautan berakhir"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Section 2: Self-Service Website Deletion with 7-Day Undo Window */}
      <Card className="border-destructive-border" data-testid="site-deletion-card">
        <CardHeader className="border-b border-destructive-border/60 bg-destructive-soft/30">
          <CardTitle className="flex items-center gap-2 text-destructive">
            <Trash2Icon className="size-4" />
            Hapus Situs (Zona Berbahaya)
          </CardTitle>
          <CardDescription>
            Menjadwalkan penghapusan situs ini menonaktifkan akses publik secara langsung dan
            memberi Anda waktu <strong>7 hari</strong> untuk membatalkan sebelum data dihapus
            permanen.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {deletionFeedback ? (
            <Alert
              variant={deletionFeedback.kind === "error" ? "destructive" : "success"}
              data-testid="deletion-feedback-alert"
            >
              {deletionFeedback.kind === "error" ? <AlertCircleIcon /> : <CheckCircle2Icon />}
              <AlertDescription>{deletionFeedback.message}</AlertDescription>
            </Alert>
          ) : null}

          {deletion.operatorHold ? (
            <Alert variant="warning" data-testid="operator-hold-deletion-notice">
              <AlertTriangleIcon />
              <AlertTitle>Penghapusan Mandiri Dijeda Sementara</AlertTitle>
              <AlertDescription>
                Situs ini sedang dalam peninjauan operator (
                {deletion.operatorHoldReason ?? "penahanan kepatuhan"}). Penghapusan mandiri tidak
                tersedia hingga peninjauan selesai.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Yang terjadi saat Anda menghapus situs:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Situs publik langsung berhenti tayang dengan halaman netral (HTTP 503,{" "}
                <code>noindex</code>).
              </li>
              <li>
                Anda memiliki <strong>7 hari penuh</strong> untuk membatalkan penghapusan dan
                mengaktifkan kembali situs tanpa kehilangan konten.
              </li>
              <li>
                Setelah 7 hari, seluruh halaman, artikel, penawaran, media R2, pesan masuk, dan
                domain dihapus permanen melalui alur offboarding standar.
              </li>
              <li>
                Catatan penagihan, bukti pembayaran/kwitansi pajak, dan log audit tetap disimpan
                sesuai ketentuan retensi hukum (<code>DEC-022</code>).
              </li>
            </ul>
          </div>

          {activeDeletion && activeDeletion.status === "scheduled" ? (
            <div className="rounded-md border border-destructive-border bg-destructive-soft/40 p-3.5 text-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-destructive">
                    Penghapusan aktif terjadwal pada{" "}
                    {activeDeletion.deletionDueAtLabel ?? activeDeletion.deletionDueAt}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Diminta pada:{" "}
                    {activeDeletion.deletionRequestedAtLabel ?? activeDeletion.deletionRequestedAt}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                  disabled={cancelBusy || !deletion.canCancelDeletion}
                  onClick={handleCancelDeletion}
                  data-testid="cancel-deletion-secondary-btn"
                >
                  <RotateCcwIcon />
                  {cancelBusy ? "Membatalkan..." : "Batalkan Penghapusan"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Disarankan untuk mengunduh arsip situs (.zip) terlebih dahulu sebelum menghapus.
              </p>

              <Dialog.Root open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <Dialog.Trigger
                  render={
                    <Button
                      type="button"
                      variant="destructive"
                      className="min-h-11 sm:min-h-9"
                      disabled={!deletion.canRequestDeletion}
                      data-testid="open-delete-dialog-btn"
                    />
                  }
                >
                  <Trash2Icon />
                  Hapus Situs Ini
                </Dialog.Trigger>

                <Dialog.Portal>
                  <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]" />
                  <Dialog.Popup
                    className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-xl"
                    data-testid="delete-confirmation-dialog"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Dialog.Title className="text-base font-semibold text-foreground">
                          Konfirmasi Penghapusan Situs
                        </Dialog.Title>
                        <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                          Situs akan langsung offline dan dihapus permanen setelah 7 hari jika tidak
                          dibatalkan.
                        </Dialog.Description>
                      </div>
                      <Dialog.Close
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Tutup dialog konfirmasi"
                          />
                        }
                      >
                        <XIcon />
                      </Dialog.Close>
                    </div>

                    <form onSubmit={handleScheduleDeletion} className="mt-4 space-y-4">
                      {deletionFeedback?.kind === "error" ? (
                        <Alert variant="destructive">
                          <AlertCircleIcon />
                          <AlertDescription>{deletionFeedback.message}</AlertDescription>
                        </Alert>
                      ) : null}

                      <div className="space-y-1.5">
                        <label
                          htmlFor="confirm-handle-input"
                          className="block text-sm font-medium text-foreground"
                        >
                          Ketik <code className="rounded bg-muted px-1.5 py-0.5">{props.handle}</code>{" "}
                          untuk konfirmasi
                        </label>
                        <Input
                          id="confirm-handle-input"
                          type="text"
                          autoComplete="off"
                          placeholder={props.handle}
                          value={confirmHandle}
                          onChange={(e) => setConfirmHandle(e.target.value)}
                          required
                          data-testid="confirm-handle-input"
                        />
                      </div>

                      {props.authCapabilities.twoFactorEnabled ? (
                        props.authCapabilities.recentTwoFactorVerified ? (
                          <Alert variant="success" data-testid="recent-2fa-verified-badge">
                            <ShieldCheckIcon />
                            <AlertDescription>
                              Verifikasi 2FA sesi Anda masih berlaku (dalam 10 menit terakhir).
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <Alert variant="warning" data-testid="require-2fa-stepup-notice">
                            <AlertTriangleIcon />
                            <AlertDescription className="space-y-2">
                              <p>
                                Akun Anda mengaktifkan 2FA. Selesaikan verifikasi 2FA terbaru (dalam
                                10 menit) sebelum menjadwalkan penghapusan situs.
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                render={<a href={`/auth/two-factor?mode=verify&next=${encodeURIComponent(`${props.basePath}/settings/data`)}`} />}
                              >
                                Verifikasi 2FA Sekarang
                              </Button>
                            </AlertDescription>
                          </Alert>
                        )
                      ) : props.authCapabilities.hasPasswordAccount ? (
                        <div className="space-y-1.5">
                          <label
                            htmlFor="deletion-password-input"
                            className="block text-sm font-medium text-foreground"
                          >
                            Kata Sandi Saat Ini
                          </label>
                          <Input
                            id="deletion-password-input"
                            type="password"
                            autoComplete="current-password"
                            placeholder="Masukkan kata sandi akun Anda"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            required
                            data-testid="deletion-password-input"
                          />
                        </div>
                      ) : null}

                      <div className="space-y-1.5">
                        <label
                          htmlFor="deletion-reason-input"
                          className="block text-sm font-medium text-foreground"
                        >
                          Alasan penghapusan (opsional)
                        </label>
                        <Input
                          id="deletion-reason-input"
                          type="text"
                          maxLength={500}
                          placeholder="Contoh: Pindah ke situs baru atau bisnis ditutup"
                          value={deletionReason}
                          onChange={(e) => setDeletionReason(e.target.value)}
                          data-testid="deletion-reason-input"
                        />
                      </div>

                      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                        <Dialog.Close
                          render={
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 sm:min-h-9"
                            />
                          }
                        >
                          Batal
                        </Dialog.Close>
                        <Button
                          type="submit"
                          variant="destructive"
                          className="min-h-11 sm:min-h-9"
                          disabled={!handleMatches || deleteBusy}
                          data-testid="confirm-schedule-deletion-btn"
                        >
                          <Trash2Icon />
                          {deleteBusy ? "Memproses..." : "Jadwalkan Penghapusan Situs"}
                        </Button>
                      </div>
                    </form>
                  </Dialog.Popup>
                </Dialog.Portal>
              </Dialog.Root>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
