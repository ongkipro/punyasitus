import {
  AlertTriangleIcon,
  BanIcon,
  ClockIcon,
  LockIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { LifecycleStatus } from "./navigation";

export interface LifecycleBannerProps {
  status: LifecycleStatus;
  daysRemaining?: number;
  lockDeadlineLabel?: string;
  billingHref?: string;
  supportHref?: string;
  reason?: string;
}

export function LifecycleBanner({
  status,
  daysRemaining = 7,
  lockDeadlineLabel = "26 Nov 2026, 23:59 WIB (H+4)",
  billingHref = "#langganan",
  supportHref = "#bantuan",
  reason,
}: LifecycleBannerProps) {
  if (status === "active") return null;

  if (status === "trial") {
    return (
      <Alert variant="info" role="status" data-lifecycle-banner="trial">
        <ClockIcon className="size-4" aria-hidden="true" />
        <AlertTitle>
          Masa uji coba gratis tersisa{" "}
          <span className="tabular-nums">{daysRemaining} hari</span>
        </AlertTitle>
        <AlertDescription>
          Situs Anda tetap aktif dan dapat dipublikasikan selama masa uji coba.
          Aktifkan paket langganan sebelum periode berakhir agar domain dan
          konten tidak terkunci.
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={billingHref} />}
          >
            Pilih paket langganan
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (status === "grace") {
    return (
      <Alert variant="warning" role="status" data-lifecycle-banner="grace">
        <AlertTriangleIcon className="size-4" aria-hidden="true" />
        <AlertTitle>
          Masa tenggang langganan: situs dikunci otomatis pada{" "}
          <span className="tabular-nums">{lockDeadlineLabel}</span>
        </AlertTitle>
        <AlertDescription>
          Tagihan langganan belum terselesaikan (sisa masa tenggang{" "}
          <span className="tabular-nums">{daysRemaining} hari</span>). Situs
          publik masih dapat diakses sementara, namun perubahan konten akan
          dikunci otomatis saat batas waktu H+4 tercapai.
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={billingHref} />}
          >
            Bayar tagihan sekarang
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  if (status === "locked") {
    return (
      <Alert variant="destructive" role="alert" data-lifecycle-banner="locked">
        <LockIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Situs dalam mode terkunci (baca saja)</AlertTitle>
        <AlertDescription>
          Langganan telah berakhir sehingga publikasi dan penyuntingan konten
          dinonaktifkan sementara. Data situs Anda tetap aman dan akan aktif
          kembali setelah perpanjangan selesai.
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            className="min-h-11 md:min-h-8"
            render={<a href={billingHref} />}
          >
            Aktifkan kembali langganan
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  // Note: full standalone HTTP 503 Payment & Recovery shell is wired in TASK-059;
  // this in-shell banner serves as the TASK-032 design-system fixture.
  return (
    <Alert variant="destructive" role="alert" data-lifecycle-banner="suspended">
      <BanIcon className="size-4" aria-hidden="true" />
      <AlertTitle>Akses situs ditangguhkan oleh operator platform</AlertTitle>
      <AlertDescription>
        {reason ??
          "Situs ini ditangguhkan sementara karena pelanggaran kebijakan atau peninjauan keamanan. Pengunjung publik tidak dapat mengakses situs hingga peninjauan selesai."}
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8"
          render={<a href={supportHref} />}
        >
          Hubungi tim dukungan
        </Button>
      </AlertAction>
    </Alert>
  );
}
