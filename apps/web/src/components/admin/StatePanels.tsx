import { useState } from "react";
import {
  AlertCircleIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SearchXIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingStatePanel({ label = "Memuat data ringkasan..." }: { label?: string }) {
  return (
    <section aria-busy="true" aria-live="polite" data-state-panel="loading" className="space-y-4">
      <p className="sr-only">{label}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i} size="sm">
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3.5 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-b-0 last:pb-0"
            >
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

export function EmptyStatePanel({
  variant = "first-run",
  title,
  description,
  actionLabel,
  actionHref = "#buat-baru",
}: {
  variant?: "first-run" | "filtered";
  title?: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  const isFiltered = variant === "filtered";
  const resolvedTitle =
    title ??
    (isFiltered
      ? "Tidak ada data yang cocok dengan filter"
      : "Belum ada layanan atau penawaran yang ditambahkan");
  const resolvedDescription =
    description ??
    (isFiltered
      ? "Coba ubah kata kunci pencarian atau hapus filter status untuk menampilkan seluruh daftar."
      : "Tambahkan layanan pertama Anda agar pengunjung dapat melihat informasi harga dan menghubungi lewat WhatsApp.");
  const resolvedAction =
    actionLabel ?? (isFiltered ? "Reset filter" : "Tambah layanan pertama");

  return (
    <Card data-state-panel={isFiltered ? "empty-filtered" : "empty-first-run"}>
      <CardContent className="flex flex-col items-start gap-3 py-8 sm:py-10">
        <div className="flex items-center gap-2 text-muted-foreground">
          {isFiltered ? (
            <SearchXIcon className="size-5 shrink-0" aria-hidden="true" />
          ) : (
            <FolderOpenIcon className="size-5 shrink-0" aria-hidden="true" />
          )}
          <h2 className="text-base font-semibold text-foreground">{resolvedTitle}</h2>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">{resolvedDescription}</p>
        <div className="pt-1">
          <Button
            variant={isFiltered ? "outline" : "default"}
            className="min-h-11 md:min-h-9"
            render={<a href={actionHref} />}
          >
            {resolvedAction}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ErrorStatePanel({
  title = "Gagal menyimpan perubahan",
  description = "Koneksi ke server terputus sementara. Masukan Anda tetap tersimpan di formulir dan tidak hilang.",
  requestId = "req_01JFX9T2A8M4",
  preserveInputExample = true,
}: {
  title?: string;
  description?: string;
  requestId?: string;
  preserveInputExample?: boolean;
}) {
  const [draftTitle, setDraftTitle] = useState("Paket Audit SEO Lokal");
  const [retryCount, setRetryCount] = useState(0);

  return (
    <section data-state-panel="error" className="space-y-4">
      <Alert variant="destructive">
        <AlertCircleIcon className="size-4" aria-hidden="true" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <span>{description}</span>{" "}
          <span className="font-mono text-xs">({requestId})</span>
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 md:min-h-8"
            onClick={() => setRetryCount((n) => n + 1)}
            data-testid="retry-action"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            Coba lagi
            {retryCount > 0 ? ` (${retryCount})` : ""}
          </Button>
        </AlertAction>
      </Alert>

      {preserveInputExample && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold text-foreground">
              Formulir tetap mempertahankan isian Anda
            </h2>
            <p className="text-sm text-muted-foreground">
              Tekan tombol Coba lagi di atas tanpa mengetik ulang data yang sudah Anda isi.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="error-preserved-title"
                className="block text-sm font-medium text-foreground"
              >
                Judul penawaran
              </label>
              <Input
                id="error-preserved-title"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-invalid="false"
              />
            </div>
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
              {retryCount > 0
                ? `Percobaan ulang ke-${retryCount} dikirim dengan nilai "${draftTitle}".`
                : "Isian belum dikirim ulang."}
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export function PermissionDeniedPanel({
  requiredRole = "Pemilik Situs (Owner)",
  resourceName = "Pengaturan Langganan & Domain",
}: {
  requiredRole?: string;
  resourceName?: string;
}) {
  return (
    <Card data-state-panel="permission-denied">
      <CardContent className="flex flex-col items-start gap-3 py-8 sm:py-10">
        <div className="flex items-center gap-2 text-destructive">
          <ShieldAlertIcon className="size-5 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">
            Akses terbatas untuk halaman ini
          </h2>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          Peran akun Anda saat ini tidak memiliki izin untuk membuka{" "}
          <strong className="font-medium text-foreground">{resourceName}</strong>.
          Halaman ini memerlukan peran{" "}
          <strong className="font-medium text-foreground">{requiredRole}</strong>.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            render={<a href="#beranda" />}
          >
            Kembali ke Beranda
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function StaleConflictBanner({
  updatedBy = "Rina (Editor)",
  reloadHref = "#muat-ulang",
}: {
  updatedBy?: string;
  reloadHref?: string;
}) {
  return (
    <Alert variant="warning" data-state-panel="conflict-409">
      <AlertCircleIcon className="size-4" aria-hidden="true" />
      <AlertTitle>Perubahan bentrok dengan versi terbaru (409)</AlertTitle>
      <AlertDescription>
        Data ini baru saja diperbarui oleh {updatedBy}. Muat ulang versi terbaru
        sebelum menyimpan agar perubahan rekan Anda tidak tertimpa.
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8"
          render={<a href={reloadHref} />}
        >
          Muat ulang versi terbaru
        </Button>
      </AlertAction>
    </Alert>
  );
}
