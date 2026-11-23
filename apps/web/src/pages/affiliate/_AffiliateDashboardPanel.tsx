import * as React from "react";
import {
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Link2,
  ShieldCheck,
  Users,
  Wallet,
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
import type { AffiliatePortalOverviewDto } from "../api/affiliate/_shared";

export interface AffiliateDashboardPanelProps {
  readonly overview: AffiliatePortalOverviewDto;
}

function formatIdr(amount: number): string {
  const abs = Math.abs(Math.trunc(amount));
  const formatted = new Intl.NumberFormat("id-ID").format(abs);
  return amount < 0 ? `-Rp ${formatted}` : `Rp ${formatted}`;
}

function formatDateId(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(d);
}

function affiliateStatusBadge(status: AffiliatePortalOverviewDto["affiliate"]["status"]): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (status) {
    case "active":
      return { label: "Aktif", variant: "default" };
    case "pending":
      return { label: "Menunggu Persetujuan", variant: "secondary" };
    case "suspended":
      return { label: "Ditangguhkan", variant: "destructive" };
    case "rejected":
      return { label: "Ditolak", variant: "destructive" };
  }
}

function commissionStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Hold 14 Hari";
    case "approved":
      return "Disetujui";
    case "batched":
      return "Dalam Batch";
    case "paid":
      return "Dibayar";
    case "reversed":
      return "Dibatalkan";
    default:
      return status;
  }
}

function entryKindLabel(kind: string): string {
  switch (kind) {
    case "first_payment":
      return "Pembayaran Pertama (60%)";
    case "renewal":
      return "Perpanjangan (20%)";
    case "reversal_offset":
      return "Penyesuaian / Offset Refund";
    default:
      return kind;
  }
}

function batchStatusMeta(status: string): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (status) {
    case "paid":
      return { label: "Sudah Dibayar", variant: "default" };
    case "pending_review":
      return { label: "Menunggu Transfer Admin", variant: "secondary" };
    case "canceled":
      return { label: "Dibatalkan", variant: "destructive" };
    default:
      return { label: status, variant: "outline" };
  }
}

function referralStageMeta(stage: string): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "outline";
} {
  switch (stage) {
    case "paying":
      return { label: "Berbayar", variant: "default" };
    case "trial":
      return { label: "Uji Coba", variant: "secondary" };
    default:
      return { label: "Tidak Aktif", variant: "outline" };
  }
}

export function AffiliateDashboardPanel({ overview }: AffiliateDashboardPanelProps) {
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);

  const { affiliate, funnel, balances, threshold, nextPayout, rates, compliance } = overview;
  const statusMeta = affiliateStatusBadge(affiliate.status);

  async function handleCopyLink() {
    if (!affiliate.referralLink) return;
    setCopyError(null);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(affiliate.referralLink);
      } else {
        const tempInput = document.createElement("input");
        tempInput.value = affiliate.referralLink;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError("Gagal menyalin otomatis. Silakan salin tautan secara manual.");
    }
  }

  return (
    <div className="space-y-5" data-testid="affiliate-dashboard-panel">
      {/* Header */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Ringkasan Afiliasi
            </h1>
            <Badge variant={statusMeta.variant} data-testid="affiliate-status-badge">
              {statusMeta.label}
            </Badge>
            {affiliate.referralCode && (
              <Badge variant="outline" className="font-mono text-xs" data-testid="affiliate-code-badge">
                Kode: {affiliate.referralCode}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Pantau kunjungan, tenant rujukan (tersamarkan demi privasi), saldo komisi{" "}
            <span className="tabular-nums">
              {rates.firstPaymentRatePercent}% / {rates.renewalRatePercent}%
            </span>
            , dan jadwal pencairan setiap tanggal 15 &amp; 30 WIB.
          </p>
        </div>
      </header>

      {/* Non-active status banner */}
      {affiliate.status === "pending" && (
        <Alert variant="warning" data-testid="affiliate-pending-banner">
          <Clock className="size-4" aria-hidden="true" />
          <AlertTitle>Pendaftaran sedang ditinjau operator</AlertTitle>
          <AlertDescription>
            Tautan referral unik Anda akan diterbitkan setelah pendaftaran disetujui oleh tim
            PunyaSitus. Rekening pencairan terdaftar: {affiliate.payoutBankCode}{" "}
            <span className="font-mono">{affiliate.payoutAccountMasked}</span>.
          </AlertDescription>
        </Alert>
      )}

      {affiliate.status === "suspended" && (
        <Alert variant="destructive" data-testid="affiliate-suspended-banner">
          <Ban className="size-4" aria-hidden="true" />
          <AlertTitle>Akun afiliasi sedang ditangguhkan</AlertTitle>
          <AlertDescription>
            Tautan referral dinonaktifkan sementara sehingga kunjungan baru tidak menghasilkan
            atribusi komisi. Hubungi tim support PunyaSitus untuk klarifikasi.
          </AlertDescription>
        </Alert>
      )}

      {affiliate.status === "rejected" && (
        <Alert variant="destructive" data-testid="affiliate-rejected-banner">
          <Ban className="size-4" aria-hidden="true" />
          <AlertTitle>Pendaftaran afiliasi belum dapat disetujui</AlertTitle>
          <AlertDescription>
            Pengajuan akun afiliasi Anda ditolak pada peninjauan sebelumnya. Hubungi tim support
            PunyaSitus jika ada pembaruan data.
          </AlertDescription>
        </Alert>
      )}

      {/* Active Referral Link Card */}
      {affiliate.status === "active" && affiliate.referralLink && (
        <Card id="tautan" data-testid="affiliate-referral-link-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="size-4 text-primary" aria-hidden="true" />
              Tautan Referral Anda
            </CardTitle>
            <CardDescription>
              Bagikan tautan ini. Pengunjung yang mendaftar dalam 30 hari akan otomatis terhubung
              ke akun afiliasi Anda (cookie first-party pada punyasitus.com).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="affiliate-referral-url" className="sr-only">
                Tautan referral afiliasi
              </label>
              <input
                id="affiliate-referral-url"
                type="text"
                readOnly
                value={affiliate.referralLink}
                data-testid="affiliate-referral-link-input"
                className="min-h-11 w-full rounded-md border border-input bg-muted/40 px-3 font-mono text-sm text-foreground md:min-h-9"
              />
              <Button
                type="button"
                onClick={handleCopyLink}
                data-testid="affiliate-copy-link-button"
                className="min-h-11 shrink-0 sm:w-auto md:min-h-9"
              >
                {copied ? (
                  <>
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    Tersalin
                  </>
                ) : (
                  <>
                    <Copy className="size-4" aria-hidden="true" />
                    Salin Tautan
                  </>
                )}
              </Button>
            </div>
            {copyError && (
              <p className="text-xs text-destructive" role="alert">
                {copyError}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 4 Primary KPI Cards */}
      <section
        aria-label="Ringkasan performa dan saldo afiliasi"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Card size="sm" data-testid="affiliate-kpi-visits">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">Kunjungan Referral</CardDescription>
            <Link2 className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {new Intl.NumberFormat("id-ID").format(funnel.visitsCount)}
            </p>
            <p className="text-xs text-muted-foreground">
              Penghitungan cookieless tanpa data pribadi pengunjung
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="affiliate-kpi-registrations">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">
              Pendaftaran &amp; Uji Coba
            </CardDescription>
            <Users className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {new Intl.NumberFormat("id-ID").format(funnel.registrationsCount)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {funnel.trialsCount} sedang masa uji coba aktif
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="affiliate-kpi-paying">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">Tenant Berbayar</CardDescription>
            <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {new Intl.NumberFormat("id-ID").format(funnel.payingTenantsCount)}
            </p>
            <p className="text-xs text-muted-foreground">
              Menghasilkan komisi 60% awal &amp; 20% perpanjangan
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="affiliate-kpi-available">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">Saldo Siap Cair</CardDescription>
            <Wallet className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {formatIdr(balances.netAvailableForNextPayoutIdr)}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              Jadwal berikutnya: {nextPayout.labelId}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Ledger Balance Breakdown & Threshold Progress */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="affiliate-ledger-balances-card">
          <CardHeader className="border-b border-border">
            <CardTitle>Rincian Saldo Komisi</CardTitle>
            <CardDescription>
              Komisi berstatus hold selama {rates.holdDays} hari sejak pembayaran terkonfirmasi,
              lalu otomatis menjadi disetujui dan dikelompokkan pada tanggal 15 &amp; 30 WIB.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Pending (Hold {rates.holdDays} Hari)</p>
              <p
                className="mt-1 text-lg font-semibold text-foreground tabular-nums"
                data-testid="affiliate-balance-pending"
              >
                {formatIdr(balances.pendingIdr)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Disetujui / Siap Cair</p>
              <p
                className="mt-1 text-lg font-semibold text-primary tabular-nums"
                data-testid="affiliate-balance-approved"
              >
                {formatIdr(balances.approvedAvailableIdr)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Dalam Batch Pencairan</p>
              <p
                className="mt-1 text-lg font-semibold text-foreground tabular-nums"
                data-testid="affiliate-balance-batched"
              >
                {formatIdr(balances.batchedIdr)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Total Sudah Dibayar</p>
              <p
                className="mt-1 text-lg font-semibold text-foreground tabular-nums"
                data-testid="affiliate-balance-paid"
              >
                {formatIdr(balances.paidIdr)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Offset Clawback / Refund</p>
              <p
                className="mt-1 text-lg font-semibold text-destructive tabular-nums"
                data-testid="affiliate-balance-offset"
              >
                {formatIdr(balances.unbatchedReversalOffsetIdr)}
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Komisi Dibatalkan (Pre-Payout)</p>
              <p
                className="mt-1 text-lg font-semibold text-muted-foreground tabular-nums"
                data-testid="affiliate-balance-reversed"
              >
                {formatIdr(balances.reversedIdr)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="affiliate-payout-schedule-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-4 text-primary" aria-hidden="true" />
              Ambang &amp; Jadwal Pencairan
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Progres minimal pencairan</span>
                <span className="font-semibold text-foreground tabular-nums">
                  {threshold.progressPercent}%
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Progres menuju batas minimal pencairan"
                aria-valuenow={threshold.progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${threshold.progressPercent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {threshold.eligibleForNextBatch
                  ? `Memenuhi batas minimal ${formatIdr(threshold.minimumPayoutIdr)} untuk batch berikutnya.`
                  : `Butuh ${formatIdr(threshold.remainingToMinimumIdr)} lagi untuk mencapai minimal ${formatIdr(threshold.minimumPayoutIdr)}.`}
              </p>
            </div>

            <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
              <p className="font-medium text-foreground">Jadwal Batch Berikutnya (WIB)</p>
              <p className="text-sm font-semibold text-primary tabular-nums">{nextPayout.labelId}</p>
              <p className="text-muted-foreground">
                {nextPayout.isToday
                  ? "Pembuatan batch otomatis berjalan hari ini (Asia/Jakarta)."
                  : `${nextPayout.daysUntil} hari lagi (setiap tgl 15 & 30 WIB).`}
              </p>
            </div>

            <div className="space-y-1 rounded-md border border-border p-3 text-xs">
              <p className="font-medium text-foreground">Rekening Pencairan Terdaftar</p>
              <p className="font-mono text-foreground">
                {affiliate.payoutBankCode} · {affiliate.payoutAccountMasked}
              </p>
              <p className="text-muted-foreground">a.n. {affiliate.payoutAccountHolder}</p>
            </div>

            {!compliance.payoutReady && (
              <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft p-2.5 text-xs text-warning">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Verifikasi ketentuan &amp; pajak afiliasi (REQ-095) sedang disiapkan sebelum
                  transfer bank diproses oleh operator.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Masked Referred Tenants (ZERO Tenant PII) */}
      <Card id="komisi" data-testid="affiliate-referrals-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Tenant Rujukan ({overview.referredTenants.length})</CardTitle>
          <CardDescription>
            Demi perlindungan privasi pelanggan (UU PDP), hanya handle situs yang disamarkan serta
            ringkasan komisi yang ditampilkan. Data pemilik, email, telepon, dan pesan masuk tidak
            pernah dibagikan.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {overview.referredTenants.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground" data-testid="affiliate-referrals-empty">
              Belum ada tenant rujukan yang tercatat. Bagikan tautan referral Anda untuk mulai
              menerima komisi.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Handle Tersamarkan</TableHead>
                      <TableHead>Tahap</TableHead>
                      <TableHead>Tanggal Atribusi</TableHead>
                      <TableHead className="text-right">Komisi Pertama</TableHead>
                      <TableHead className="text-right">Perpanjangan</TableHead>
                      <TableHead className="text-right">Total Komisi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.referredTenants.map((ref, idx) => {
                      const stageMeta = referralStageMeta(ref.stage);
                      return (
                        <TableRow
                          key={`${ref.maskedHandle}-${ref.attributedAt}-${idx}`}
                          data-testid={`affiliate-referral-row-${idx}`}
                        >
                          <TableCell className="font-mono text-sm font-medium text-foreground">
                            {ref.maskedHandle}
                          </TableCell>
                          <TableCell>
                            <Badge variant={stageMeta.variant}>{stageMeta.label}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            {formatDateId(ref.attributedAt)}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {formatIdr(ref.firstPaymentCommissionIdr)}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {formatIdr(ref.renewalCommissionIdr)} ({ref.renewalCount}x)
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatIdr(ref.totalCommissionIdr)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {overview.referredTenants.map((ref, idx) => {
                  const stageMeta = referralStageMeta(ref.stage);
                  return (
                    <li
                      key={`${ref.maskedHandle}-${ref.attributedAt}-${idx}`}
                      className="space-y-1.5 p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {ref.maskedHandle}
                        </span>
                        <Badge variant={stageMeta.variant}>{stageMeta.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Atribusi: {formatDateId(ref.attributedAt)} · Perpanjangan {ref.renewalCount}x
                      </p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        Total komisi: {formatIdr(ref.totalCommissionIdr)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* Commission Ledger History */}
      <Card data-testid="affiliate-commissions-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Riwayat Buku Besar Komisi ({overview.recentCommissions.length})</CardTitle>
          <CardDescription>
            Catatan komisi pembayaran pertama, perpanjangan, masa tunggu 14 hari, serta offset
            pembatalan.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {overview.recentCommissions.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              Belum ada entri komisi yang tercatat.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant</TableHead>
                      <TableHead>Jenis</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Konfirmasi / Hold s.d.</TableHead>
                      <TableHead className="text-right">Komisi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.recentCommissions.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-mono text-xs text-foreground">
                          {entry.maskedHandle}
                        </TableCell>
                        <TableCell className="text-xs text-foreground">
                          {entryKindLabel(entry.entryKind)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              entry.status === "paid" || entry.status === "approved"
                                ? "default"
                                : entry.status === "reversed"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {commissionStatusLabel(entry.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {formatDateId(entry.confirmedAt)} · Hold {formatDateId(entry.holdUntilAt)}
                        </TableCell>
                        <TableCell
                          className={`text-right font-semibold tabular-nums ${
                            entry.commissionIdr < 0 ? "text-destructive" : "text-foreground"
                          }`}
                        >
                          {formatIdr(entry.commissionIdr)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {overview.recentCommissions.map((entry) => (
                  <li key={entry.id} className="space-y-1 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {entry.maskedHandle}
                      </span>
                      <Badge variant="secondary">{commissionStatusLabel(entry.status)}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{entryKindLabel(entry.entryKind)}</p>
                    <div className="flex items-center justify-between text-xs tabular-nums">
                      <span className="text-muted-foreground">{formatDateId(entry.confirmedAt)}</span>
                      <span
                        className={`font-semibold ${
                          entry.commissionIdr < 0 ? "text-destructive" : "text-foreground"
                        }`}
                      >
                        {formatIdr(entry.commissionIdr)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* Payout Batch History */}
      <Card id="pencairan" data-testid="affiliate-payout-batches-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Riwayat Batch Pencairan ({overview.payoutBatches.length})</CardTitle>
          <CardDescription>
            Setiap batch disiapkan otomatis pada tanggal 15 &amp; 30 WIB, lalu ditransfer manual
            oleh operator beserta referensi transfer bank.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {overview.payoutBatches.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground" data-testid="affiliate-batches-empty">
              Belum ada batch pencairan. Batch otomatis dibuat saat saldo disetujui mencapai minimal{" "}
              {formatIdr(threshold.minimumPayoutIdr)} pada tanggal 15 atau 30 WIB.
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Periode</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Tujuan Rekening</TableHead>
                      <TableHead>Referensi Transfer</TableHead>
                      <TableHead className="text-right">Nominal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.payoutBatches.map((batch) => {
                      const bMeta = batchStatusMeta(batch.status);
                      return (
                        <TableRow key={batch.id} data-testid={`affiliate-batch-row-${batch.id}`}>
                          <TableCell className="font-mono text-sm tabular-nums">
                            {batch.payoutPeriodKey}
                          </TableCell>
                          <TableCell>
                            <Badge variant={bMeta.variant}>{bMeta.label}</Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {batch.payoutBankCode} · {batch.payoutAccountMasked}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {batch.transferReference ? (
                              <span>
                                {batch.transferReference}
                                {batch.paidAt ? ` (${formatDateId(batch.paidAt)})` : ""}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">Menunggu transfer</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatIdr(batch.totalAmountIdr)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {overview.payoutBatches.map((batch) => {
                  const bMeta = batchStatusMeta(batch.status);
                  return (
                    <li key={batch.id} className="space-y-1.5 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold tabular-nums">
                          {batch.payoutPeriodKey}
                        </span>
                        <Badge variant={bMeta.variant}>{bMeta.label}</Badge>
                      </div>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatIdr(batch.totalAmountIdr)} ({batch.entryCount} entri)
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {batch.payoutBankCode} · {batch.payoutAccountMasked}
                      </p>
                      <p className="font-mono text-xs text-foreground">
                        Ref: {batch.transferReference ?? "Menunggu transfer"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
