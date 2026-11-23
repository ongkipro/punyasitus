import {
  AlertTriangleIcon,
  ClockIcon,
  CreditCardIcon,
  DownloadIcon,
  LockIcon,
  LogOutIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ServiceAccessContext } from "./types";

export interface ServiceAccessBannerProps {
  readonly access: ServiceAccessContext;
}

/**
 * Bahasa Indonesia service-access banners for `trial`, `grace`, and `locked` states
 * (DESIGN.md §9, PLAN §17.1; REQ-060; Base UI primitives only).
 */
export function ServiceAccessBanner({ access }: ServiceAccessBannerProps) {
  const {
    status,
    isPayer,
    agencyManaged = false,
    canExportLeadsCsv = isPayer,
    daysRemaining,
    trialEndsAtLabel,
    graceEndsAtLabel,
    lockedEndsAtLabel,
    deletionDueAtLabel,
    billingHref = "#langganan",
    leadsExportHref = "#ekspor-prospek",
    signOutHref = "/auth/login?signOut=1",
  } = access;

  if (status === "active" || status === "suspended") {
    return null;
  }

  if (status === "trial") {
    const remainingText =
      typeof daysRemaining === "number" ? `${daysRemaining} hari` : "7 hari";

    return (
      <Alert
        variant="info"
        role="status"
        data-service-access-banner="trial"
        data-lifecycle-banner="trial"
      >
        <ClockIcon className="size-4" aria-hidden="true" />
        <AlertTitle>
          Masa uji coba gratis tersisa{" "}
          <span className="tabular-nums">{remainingText}</span>
          {trialEndsAtLabel ? (
            <span className="font-normal"> (berakhir {trialEndsAtLabel})</span>
          ) : null}
        </AlertTitle>
        <AlertDescription>
          Situs uji coba aktif di subdomain platform dengan{" "}
          <code className="rounded bg-background/60 px-1 py-0.5 text-xs">noindex</code>{" "}
          dan kuota media 100 MB (domain kustom aktif setelah berlangganan). Jika
          masa uji coba berakhir tanpa pembayaran, situs akan otomatis masuk mode
          perbaikan (503) tanpa menghapus data.
        </AlertDescription>
        <AlertAction>
          {isPayer ? (
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              render={<a href={billingHref} />}
            >
              <CreditCardIcon className="size-3.5" aria-hidden="true" />
              <span>Aktifkan paket langganan</span>
            </Button>
          ) : (
            <p
              data-testid="banner-member-contact-notice"
              className="text-xs font-medium text-current"
            >
              {agencyManaged
                ? "Hubungi admin agensi untuk mengaktifkan paket langganan."
                : "Hubungi pemilik situs untuk mengaktifkan paket langganan."}
            </p>
          )}
        </AlertAction>
      </Alert>
    );
  }

  if (status === "grace") {
    const remainingText =
      typeof daysRemaining === "number" ? `${daysRemaining} hari` : "3 hari";

    return (
      <Alert
        variant="warning"
        role="status"
        data-service-access-banner="grace"
        data-lifecycle-banner="grace"
      >
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        <AlertTitle>
          Masa tenggang langganan (H+1 hingga H+3) — sisa{" "}
          <span className="tabular-nums">{remainingText}</span>
        </AlertTitle>
        <AlertDescription>
          Situs publik masih aktif dan terindeks, dan CMS masih dapat disunting.
          Selesaikan pembayaran perpanjangan sebelum{" "}
          <strong className="tabular-nums">
            {graceEndsAtLabel ?? "batas H+4"}
          </strong>{" "}
          agar penyuntingan konten tidak terkunci otomatis.
        </AlertDescription>
        <AlertAction>
          {isPayer ? (
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              render={<a href={billingHref} />}
            >
              <CreditCardIcon className="size-3.5" aria-hidden="true" />
              <span>Bayar perpanjangan sekarang</span>
            </Button>
          ) : (
            <p
              data-testid="banner-member-contact-notice"
              className="text-xs font-medium text-current"
            >
              {agencyManaged
                ? "Hubungi admin agensi untuk menyelesaikan pembayaran perpanjangan."
                : "Hubungi pemilik situs untuk menyelesaikan pembayaran perpanjangan."}
            </p>
          )}
        </AlertAction>
      </Alert>
    );
  }

  // status === "locked" (H+4..H+7)
  return (
    <Alert
      variant="destructive"
      role="alert"
      data-service-access-banner="locked"
      data-lifecycle-banner="locked"
    >
      <LockIcon className="size-4" aria-hidden="true" />
      <AlertTitle>
        Mode baca saja (Terkunci H+4–H+7) — situs publik masih aktif &amp; terindeks
      </AlertTitle>
      <AlertDescription>
        Semua perubahan dan publikasi konten CMS dinonaktifkan sementara untuk
        melindungi situs Anda. Situs publik tetap dapat diakses pengunjung
        hingga{" "}
        <strong className="tabular-nums">
          {lockedEndsAtLabel ?? "batas penangguhan H+8"}
        </strong>
        . Anda tetap dapat membaca konten, mengekspor prospek CSV, melakukan
        pembayaran perpanjangan, atau keluar dari akun.
        {deletionDueAtLabel ? (
          <span
            data-testid="locked-deletion-due-date"
            className="mt-1 block text-xs font-medium tabular-nums"
          >
            Jadwal penghapusan data permanen (H+45 jika belum dibayar): {deletionDueAtLabel}
          </span>
        ) : null}
      </AlertDescription>
      <AlertAction>
        {isPayer ? (
          <>
            <Button
              size="sm"
              className="min-h-11 md:min-h-8"
              render={<a href={billingHref} />}
            >
              <CreditCardIcon className="size-3.5" aria-hidden="true" />
              <span>Perpanjang langganan</span>
            </Button>
            {canExportLeadsCsv && (
              <Button
                size="sm"
                variant="outline"
                data-testid="locked-leads-export-btn"
                className="min-h-11 md:min-h-8"
                render={<a href={leadsExportHref} download />}
              >
                <DownloadIcon className="size-3.5" aria-hidden="true" />
                <span>Ekspor Prospek (CSV)</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 md:min-h-8"
              render={<a href={signOutHref} />}
            >
              <LogOutIcon className="size-3.5" aria-hidden="true" />
              <span>Keluar</span>
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span
              data-testid="banner-member-contact-notice"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-current"
            >
              <ShieldAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {agencyManaged
                ? "Hubungi admin agensi untuk memperpanjang langganan."
                : "Hubungi pemilik situs untuk memperpanjang langganan."}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-8"
              render={<a href={signOutHref} />}
            >
              <LogOutIcon className="size-3.5" aria-hidden="true" />
              <span>Keluar</span>
            </Button>
          </div>
        )}
      </AlertAction>
    </Alert>
  );
}
