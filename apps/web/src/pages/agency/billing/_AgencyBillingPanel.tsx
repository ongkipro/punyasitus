import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ReceiptTextIcon,
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
import type {
  AgencyClientDto,
  AgencyReceiptDto,
  AgencySummaryDto,
} from "../../api/agency/_shared";

export interface AgencyBillingPricingDto {
  readonly baseMonthlyIdr: number;
  readonly baseYearlyIdr: number;
  readonly effectiveDiscountPercent: number;
  readonly discountedMonthlyIdr: number;
  readonly discountedYearlyIdr: number;
  readonly yearlySavingsIdr: number;
}

export interface AgencyBillingPanelProps {
  readonly agency: AgencySummaryDto;
  readonly pricing: AgencyBillingPricingDto;
  readonly clients: readonly AgencyClientDto[];
  readonly receipts: readonly AgencyReceiptDto[];
  readonly preselectedTenantId?: string;
}

function formatIdr(amount: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "trial":
      return "Uji Coba";
    case "grace":
      return "Masa Tenggang";
    case "locked":
      return "Terkunci";
    case "suspended":
      return "Ditangguhkan";
    default:
      return status;
  }
}

export function AgencyBillingPanel({
  agency,
  pricing,
  clients,
  receipts,
  preselectedTenantId = "",
}: AgencyBillingPanelProps) {
  const [selectedTenantId, setSelectedTenantId] = React.useState(
    preselectedTenantId || clients[0]?.tenantId || "",
  );
  const [plan, setPlan] = React.useState<"monthly" | "yearly">("monthly");
  const [channelCode, setChannelCode] = React.useState("QRIS");
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [checkoutInfo, setCheckoutInfo] = React.useState<{
    readonly attemptId: string;
    readonly totalPayableIdr: number;
    readonly channelKind: string;
    readonly vaNumber: string | null;
    readonly qrisPayload: string | null;
  } | null>(null);

  async function handleCheckout(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setCheckoutInfo(null);
    if (!selectedTenantId) {
      setErrorMsg("Pilih situs klien terlebih dahulu.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/agency/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        credentials: "same-origin",
        body: JSON.stringify({
          agencyId: agency.id,
          tenantId: selectedTenantId,
          plan,
          channelCode,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly attempt?: {
          readonly attemptId: string;
          readonly totalPayableIdr: number;
          readonly channelKind: string;
          readonly vaNumber: string | null;
          readonly qrisPayload: string | null;
        };
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success || !data.attempt) {
        setErrorMsg(data.error?.message ?? "Gagal membuat instruksi pembayaran agensi.");
        return;
      }
      setCheckoutInfo(data.attempt);
    } catch {
      setErrorMsg("Koneksi gagal saat membuat tagihan agensi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="agency-billing-panel">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card data-testid="agency-pricing-monthly">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Paket Bulanan Agensi</CardTitle>
              <Badge variant="secondary" className="tabular-nums">
                Diskon {pricing.effectiveDiscountPercent}%
              </Badge>
            </div>
            <CardDescription>Harga dihitung di server sesuai tier agensi aktif.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {formatIdr(pricing.discountedMonthlyIdr)}
              <span className="text-sm font-normal text-muted-foreground"> / bulan</span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              Tarif dasar: {formatIdr(pricing.baseMonthlyIdr)} · Belum termasuk PPN (non-PKP)
            </p>
          </CardContent>
        </Card>

        <Card data-testid="agency-pricing-yearly">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Paket Tahunan Agensi</CardTitle>
              <Badge variant="default" className="tabular-nums">
                Hemat {formatIdr(pricing.yearlySavingsIdr)}
              </Badge>
            </div>
            <CardDescription>Perpanjangan 12 bulan dengan diskon agensi diterapkan otomatis.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {formatIdr(pricing.discountedYearlyIdr)}
              <span className="text-sm font-normal text-muted-foreground"> / tahun</span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              Tarif dasar: {formatIdr(pricing.baseYearlyIdr)} · Belum termasuk PPN (non-PKP)
            </p>
          </CardContent>
        </Card>
      </div>

      {errorMsg && (
        <Alert variant="destructive" data-testid="agency-billing-error">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Pembayaran belum dapat diproses</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {checkoutInfo && (
        <Alert variant="info" data-testid="agency-checkout-instruction">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Instruksi Pembayaran Siap</AlertTitle>
          <AlertDescription>
            Total tagihan{" "}
            <strong className="tabular-nums">{formatIdr(checkoutInfo.totalPayableIdr)}</strong>{" "}
            melalui {checkoutInfo.channelKind}.{" "}
            {checkoutInfo.vaNumber ? `Nomor VA: ${checkoutInfo.vaNumber}. ` : ""}
            Aktivasi langganan terjadi otomatis setelah konfirmasi server AutoLaris Advice.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Bayar / Perpanjang Langganan Klien</CardTitle>
          <CardDescription>
            Pembayaran diterbitkan atas nama agensi ({agency.billingName} — {agency.billingEmail}).
            Tidak ada pengembalian dana untuk pembatalan sepihak; pembayaran ganda dikembalikan
            manual melalui verifikasi admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Buat situs klien terlebih dahulu di halaman Daftar Klien sebelum melakukan checkout.
            </p>
          ) : (
            <form onSubmit={handleCheckout} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor="billing-client-select" className="block text-sm font-medium text-foreground">
                  Pilih Situs Klien
                </label>
                <select
                  id="billing-client-select"
                  value={selectedTenantId}
                  onChange={(e) => setSelectedTenantId(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
                >
                  {clients.map((c) => (
                    <option key={c.tenantId} value={c.tenantId}>
                      {c.name} ({c.handle}) — {statusLabel(c.effectiveStatus)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="billing-plan-select" className="block text-sm font-medium text-foreground">
                  Periode Paket
                </label>
                <select
                  id="billing-plan-select"
                  value={plan}
                  onChange={(e) => setPlan(e.target.value === "yearly" ? "yearly" : "monthly")}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
                >
                  <option value="monthly">
                    Bulanan ({formatIdr(pricing.discountedMonthlyIdr)})
                  </option>
                  <option value="yearly">
                    Tahunan ({formatIdr(pricing.discountedYearlyIdr)})
                  </option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="billing-channel-select" className="block text-sm font-medium text-foreground">
                  Metode Pembayaran
                </label>
                <select
                  id="billing-channel-select"
                  value={channelCode}
                  onChange={(e) => setChannelCode(e.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
                >
                  <option value="QRIS">QRIS</option>
                  <option value="VA_BCA">Virtual Account BCA</option>
                  <option value="VA_BRI">Virtual Account BRI</option>
                  <option value="VA_BNI">Virtual Account BNI</option>
                  <option value="VA_MANDIRI">Virtual Account Mandiri</option>
                </select>
              </div>

              <div className="md:col-span-3">
                <Button
                  type="submit"
                  disabled={submitting}
                  data-testid="agency-billing-checkout-submit"
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                >
                  <ReceiptTextIcon className="size-4" aria-hidden="true" />
                  {submitting ? "Membuat instruksi..." : "Buat Instruksi Pembayaran"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card data-testid="agency-receipts-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Riwayat Kuitansi PDF Agensi ({receipts.length})</CardTitle>
          <CardDescription>
            Kuitansi bernomor urut (`PS-YYYY-NNNNNN`) ditujukan kepada agensi dan dikirim ke{" "}
            {agency.billingEmail}. Anggota klien tidak memiliki akses ke dokumen ini.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {receipts.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground" data-testid="agency-receipts-empty">
              Belum ada kuitansi pembayaran terbit untuk agensi ini.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nomor Kuitansi</TableHead>
                      <TableHead>Paket</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Kanal</TableHead>
                      <TableHead className="text-right">Unduh</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs font-medium text-foreground">
                          {r.receiptNumber}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.planCode}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatIdr(r.totalAmountIdr)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.paymentChannel}</TableCell>
                        <TableCell className="text-right">
                          <a
                            href={r.pdfDownloadUrl}
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted"
                          >
                            <DownloadIcon className="size-3.5" aria-hidden="true" />
                            Unduh PDF
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {receipts.map((r) => (
                  <li key={r.id} className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium text-foreground">
                        {r.receiptNumber}
                      </span>
                      <span className="text-sm font-semibold tabular-nums">
                        {formatIdr(r.totalAmountIdr)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {r.planCode} · {r.paymentChannel}
                    </p>
                    <a
                      href={r.pdfDownloadUrl}
                      className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted"
                    >
                      <DownloadIcon className="size-3.5" aria-hidden="true" />
                      Unduh PDF Kuitansi
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
