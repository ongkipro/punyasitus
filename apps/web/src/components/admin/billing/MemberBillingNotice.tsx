import { ArrowLeftIcon, LogOutIcon, ShieldAlertIcon } from "lucide-react";
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
import type { TenantStatus } from "@punyasitus/core/schemas";
import { getTenantStatusIndonesianLabel } from "./helpers";

export interface MemberBillingNoticeProps {
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly agencyManaged: boolean;
  readonly roleLabel: string;
  readonly isPaymentOnlyShell: boolean;
}

/**
 * Non-owner member billing isolation notice (REQ-058, PLAN §16.3, §17.2; TASK-057).
 *
 * Hard invariants:
 * - Renders ONLY the clear "Hubungi pemilik situs" (or "Hubungi admin agensi") guidance.
 * - ZERO payment channel selectors, ZERO plan checkout buttons, ZERO payment creation forms.
 * - Uses Base UI `<Button render={<a ... />} />` primitives only (base-nova preset).
 */
export function MemberBillingNotice({
  handle,
  tenantName,
  tenantStatus,
  operatorHold,
  agencyManaged,
  roleLabel,
  isPaymentOnlyShell,
}: MemberBillingNoticeProps) {
  const statusLabel = getTenantStatusIndonesianLabel(tenantStatus, operatorHold);
  const titleText = agencyManaged ? "Hubungi admin agensi" : "Hubungi pemilik situs";
  const detailText = agencyManaged
    ? `Tagihan langganan situs ${tenantName} dikelola penuh oleh agensi pengelola Anda. Anggota tim klien (${roleLabel}) tidak memiliki akses pembuatan pembayaran atau pemilihan metode pembayaran.`
    : `Hanya Pemilik Situs (Owner) yang dapat melihat rincian penagihan, memilih saluran QRIS/Virtual Account, atau membuat pembayaran perpanjangan untuk ${tenantName}. Hubungi pemilik situs Anda untuk memproses perpanjangan layanan.`;

  return (
    <div
      className="space-y-5"
      data-testid="member-billing-notice-view"
      data-agency-managed={agencyManaged ? "true" : "false"}
    >
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={tenantStatus === "active" ? "success" : "warning"}>{statusLabel}</Badge>
          <Badge variant="outline">Peran: {roleLabel}</Badge>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Tagihan &amp; Perpanjangan Langganan
        </h1>
        <p className="text-sm text-muted-foreground">
          Akses pembayaran dibatasi khusus untuk pembayar resmi situs{" "}
          <strong className="text-foreground">{tenantName}</strong>.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlertIcon className="size-4 text-warning" aria-hidden="true" />
            <span>{titleText}</span>
          </CardTitle>
          <CardDescription>
            {agencyManaged
              ? "Pengelolaan langganan berada pada portal agensi."
              : "Pembuatan tagihan dan pembayaran khusus Pemilik Situs (Owner)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <Alert
            variant="warning"
            role="status"
            aria-live="polite"
            data-testid="billing-member-contact-owner-alert"
          >
            <ShieldAlertIcon className="size-4" aria-hidden="true" />
            <AlertTitle>{titleText}</AlertTitle>
            <AlertDescription>{detailText}</AlertDescription>
          </Alert>

          <p className="text-sm text-muted-foreground">
            {isPaymentOnlyShell
              ? "Situs sedang dalam mode pembatasan layanan. Konten dan draf tetap tersimpan dengan aman hingga pembayaran terverifikasi oleh server."
              : "Anda tetap dapat melihat status layanan atau kembali ke area kerja sesuai izin peran tim Anda."}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            {!isPaymentOnlyShell && (
              <Button
                variant="outline"
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                render={<a href={`/dashboard/${encodeURIComponent(handle)}`} />}
              >
                <ArrowLeftIcon className="size-4" aria-hidden="true" />
                <span>Kembali ke Beranda</span>
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-11 w-full sm:w-auto md:min-h-9"
              render={<a href={`/dashboard/${encodeURIComponent(handle)}/service-status`} />}
            >
              <span>Lihat Status Layanan</span>
            </Button>
          </div>
          <Button
            variant="ghost"
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            render={<a href="/auth/login?signOut=1" />}
          >
            <LogOutIcon className="size-4" aria-hidden="true" />
            <span>Keluar</span>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
