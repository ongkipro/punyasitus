import {
  BanIcon,
  CreditCardIcon,
  DownloadIcon,
  LifeBuoyIcon,
  LogOutIcon,
  ShieldAlertIcon,
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
import type { ServiceAccessContext } from "./types";

export interface SuspendedRecoveryShellProps {
  readonly workspaceName: string;
  readonly workspaceSubtitle?: string;
  readonly userDisplayName?: string;
  readonly userRoleLabel?: string;
  readonly access: ServiceAccessContext;
}

/**
 * Standalone Payment & Recovery Shell for `suspended` tenants (DESIGN.md §9, PLAN §17.1; REQ-060).
 *
 * Hard invariants:
 * - Replaces the full CMS sidebar/editor so zero locked CMS flash occurs.
 * - Owner / agency payer sees renewal payment CTA, leads CSV export, retention deadline, and sign-out.
 * - Non-owner member sees an explicit "Hubungi pemilik situs" (or agency admin) notice + sign-out ONLY.
 * - Manual operator hold clearly states that payment alone will NOT lift the hold.
 * - Uses Base UI `<Button render={<a ... />} />` primitives only.
 */
export function SuspendedRecoveryShell({
  workspaceName,
  workspaceSubtitle,
  userDisplayName = "Pengguna",
  userRoleLabel,
  access,
}: SuspendedRecoveryShellProps) {
  const {
    operatorHold = false,
    operatorHoldReason,
    suspensionReason,
    agencyManaged = false,
    isPayer,
    canExportLeadsCsv = isPayer,
    deletionDueAtLabel,
    retentionPaused = operatorHold,
    billingHref = "#langganan",
    leadsExportHref = "#ekspor-prospek",
    signOutHref = "/auth/login?signOut=1",
    supportHref = "#bantuan",
  } = access;

  const isTrialExpired = suspensionReason === "trial_expired";
  const resolvedRoleLabel =
    userRoleLabel ?? (isPayer ? (agencyManaged ? "Admin Agensi" : "Pemilik Situs") : "Anggota Tim");

  const heading = operatorHold
    ? "Akses situs ditahan oleh operator platform"
    : isTrialExpired
      ? "Masa uji coba gratis 7 hari telah berakhir"
      : "Langganan berakhir — Situs dalam perbaikan (503)";

  const description = operatorHold
    ? "Situs Anda sedang berada dalam penahanan manual oleh tim operasional platform. Pengunjung publik melihat halaman pemeliharaan (HTTP 503)."
    : isTrialExpired
      ? "Periode uji coba 7 hari berakhir tanpa pembayaran aktif. Situs publik menampilkan halaman pemeliharaan (HTTP 503, noindex). Semua data konten Anda tetap tersimpan dengan aman."
      : "Masa langganan telah melewati batas H+8. Situs publik menampilkan halaman pemeliharaan (HTTP 503, noindex). Data situs dan draf Anda tidak dihapus dan akan kembali aktif segera setelah pembayaran terverifikasi.";

  return (
    <div
      data-service-access-shell="suspended"
      data-operator-hold={operatorHold ? "true" : "false"}
      data-payer={isPayer ? "true" : "false"}
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      <a
        href="#konten-pemulihan"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Lewati ke konten utama
      </a>

      <header
        data-slot="recovery-topbar"
        className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-2 md:px-6"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
          >
            PS
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight text-foreground">
              {workspaceName}
            </p>
            {workspaceSubtitle ? (
              <p className="truncate text-xs text-muted-foreground">{workspaceSubtitle}</p>
            ) : null}
          </div>
          <Badge variant="destructive" className="shrink-0">
            {operatorHold ? "Penahanan Operator" : "Ditangguhkan"}
          </Badge>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {userDisplayName} ({resolvedRoleLabel})
          </span>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={signOutHref} />}
          >
            <LogOutIcon className="size-3.5" aria-hidden="true" />
            <span>Keluar</span>
          </Button>
        </div>
      </header>

      <main
        id="konten-pemulihan"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-8 focus:outline-none md:px-6"
      >
        <Card>
          <CardHeader>
            <div className="mb-1 flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full border border-destructive-border bg-destructive-soft text-destructive"
              >
                <BanIcon className="size-4" />
              </span>
              <Badge variant="outline">Mode Pemulihan &amp; Pembayaran</Badge>
            </div>
            <CardTitle className="text-lg md:text-xl">{heading}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {operatorHold ? (
              <div className="space-y-3">
                <Alert variant="destructive" role="alert" data-testid="operator-hold-notice">
                  <ShieldAlertIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Penahanan operator tidak dicabut oleh pembayaran</AlertTitle>
                  <AlertDescription>
                    {operatorHoldReason
                      ? `Alasan penahanan: ${operatorHoldReason}. `
                      : ""}
                    Menyelesaikan pembayaran langganan tetap mencatat masa aktif Anda,
                    namun akses situs publik dan CMS hanya dibuka kembali setelah
                    peninjauan operator selesai.
                  </AlertDescription>
                </Alert>
                {retentionPaused && (
                  <div
                    data-testid="deletion-clock-paused"
                    className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground"
                  >
                    <p className="font-medium text-foreground">
                      Jadwal penghapusan otomatis dijeda
                    </p>
                    <p className="mt-1">
                      Penghitung waktu penghapusan data dihentikan sementara selama penahanan
                      operator aktif. Jika penahanan dilepas pada status belum dibayar, sisa
                      waktu penyimpanan akan diberikan minimal 14 hari.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div
                data-testid="retention-summary"
                className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
              >
                <p className="font-medium text-foreground">Status retensi &amp; jadwal penghapusan data</p>
                <p className="mt-1 text-muted-foreground">
                  Konten, media, dan draf Anda tetap disimpan selama masa penangguhan.
                  Pembayaran sebelum batas waktu akan memulihkan seluruh data yang masih
                  tersimpan tanpa menerbitkan draf secara otomatis.
                </p>
                {deletionDueAtLabel ? (
                  <div
                    data-testid="deletion-due-date"
                    className="mt-3 rounded-md border border-destructive-border bg-destructive-soft/60 px-3 py-2 text-xs text-foreground"
                  >
                    <span className="font-semibold">
                      Jadwal penghapusan permanen ({isTrialExpired ? "Trial + 30 hari" : "H+45"}):
                    </span>{" "}
                    <span className="font-semibold tabular-nums">{deletionDueAtLabel}</span>
                    <p className="mt-0.5 text-muted-foreground">
                      Setelah tanggal ini, konten, media, pesan masuk, dan domain kustom dihapus
                      permanen; catatan tagihan &amp; kwitansi tetap disimpan sesuai aturan audit.
                    </p>
                  </div>
                ) : null}
              </div>
            )}

            {isPayer ? (
              <div
                data-testid="owner-recovery-actions"
                className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap"
              >
                <Button
                  size="default"
                  className="min-h-11 w-full sm:w-auto"
                  render={<a href={billingHref} />}
                >
                  <CreditCardIcon className="size-4" aria-hidden="true" />
                  <span>
                    {operatorHold
                      ? "Lihat Tagihan & Riwayat"
                      : "Bayar & Aktifkan Kembali Langganan"}
                  </span>
                </Button>

                {canExportLeadsCsv && (
                  <Button
                    variant="outline"
                    size="default"
                    data-testid="recovery-leads-export-btn"
                    className="min-h-11 w-full sm:w-auto"
                    render={<a href={leadsExportHref} download />}
                  >
                    <DownloadIcon className="size-4" aria-hidden="true" />
                    <span>Ekspor Prospek (CSV)</span>
                  </Button>
                )}

                {operatorHold && (
                  <Button
                    variant="secondary"
                    size="default"
                    className="min-h-11 w-full sm:w-auto"
                    render={<a href={supportHref} />}
                  >
                    <LifeBuoyIcon className="size-4" aria-hidden="true" />
                    <span>Hubungi Tim Dukungan</span>
                  </Button>
                )}
              </div>
            ) : (
              <Alert
                variant="warning"
                role="status"
                data-testid="member-contact-owner-notice"
              >
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>
                  {agencyManaged ? "Hubungi admin agensi" : "Hubungi pemilik situs"}
                </AlertTitle>
                <AlertDescription>
                  {agencyManaged
                    ? "Hanya admin agensi pengelola yang dapat menyelesaikan pembayaran perpanjangan atau mengekspor prospek CSV. Silakan hubungi admin agensi Anda untuk memulihkan akses."
                    : "Hanya pemilik situs yang dapat melakukan pembayaran perpanjangan langganan atau mengekspor prospek CSV. Silakan hubungi pemilik situs untuk mengaktifkan kembali akses."}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>

          <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Akses CMS terkunci selama penangguhan.</span>
            <a
              href={signOutHref}
              className="inline-flex min-h-11 items-center gap-1.5 font-medium text-foreground underline underline-offset-4 hover:opacity-80 md:min-h-8"
            >
              <LogOutIcon className="size-3.5" aria-hidden="true" />
              <span>Keluar dari akun</span>
            </a>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
