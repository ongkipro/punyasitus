import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FilterIcon,
  InfoIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
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
import {
  CONSOLE_REFUND_KIND_OPTIONS,
  buildSafeConsoleAuthHref,
  formatIdr,
  formatWibDateTime,
  getAttemptStateBadgeMeta,
  getObligationStateBadgeMeta,
  getTenantStatusIndonesianLabel,
  isConsoleObligationRefundEligible,
  validateConsoleAuditReason,
  type ConsoleBillingObligationDto,
  type ConsoleBillingRefundDto,
  type ConsoleRefundKind,
  type ConsoleSettlementPolicyDto,
} from "@/components/admin/billing/helpers";

export interface ConsoleBillingPanelProps {
  readonly initialObligations: readonly ConsoleBillingObligationDto[];
  readonly initialRefunds: readonly ConsoleBillingRefundDto[];
  readonly settlementPolicy: ConsoleSettlementPolicyDto;
  readonly stepUpFresh: boolean;
}

/**
 * Scoped Console Operator Billing Reconciliation & Manual Refund Panel
 * (`console.punyasitus.com/billing`, REQ-057, REQ-058; PLAN §16.3, §16.4; TASK-057).
 *
 * Hard invariants:
 * - Strictly redacted metadata ONLY — never displays raw QRIS payloads, VA numbers,
 *   payment redirect URLs, API keys, or visitor PII.
 * - Exposes ONLY two audited operator mutations:
 *   1. Audited Advice Recheck (`POST /api/console/billing/recheck`)
 *   2. Audited Duplicate / Mistaken / Post-Purge Refund Recording (`POST /api/console/billing/refund`)
 * - ZERO arbitrary "Mark Paid" toggle or manual entitlement bypass anywhere!
 * - Base UI (`@base-ui/react`) primitives only (`base-nova` preset).
 */
export function ConsoleBillingPanel({
  initialObligations,
  initialRefunds,
  settlementPolicy,
  stepUpFresh,
}: ConsoleBillingPanelProps) {
  const [obligations, setObligations] =
    React.useState<readonly ConsoleBillingObligationDto[]>(initialObligations);
  const [refunds, setRefunds] = React.useState<readonly ConsoleBillingRefundDto[]>(initialRefunds);
  const [policy, setPolicy] = React.useState<ConsoleSettlementPolicyDto>(settlementPolicy);

  // Filters
  const [tenantIdFilter, setTenantIdFilter] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState("all");
  const [reviewOnly, setReviewOnly] = React.useState(false);
  const [loadingList, setLoadingList] = React.useState(false);

  // Active audited Advice Recheck form state
  const [recheckTarget, setRecheckTarget] = React.useState<{
    readonly obligationId: string;
    readonly attemptId: string | null;
    readonly tenantId: string;
    readonly tenantHandle: string;
  } | null>(null);
  const [recheckReason, setRecheckReason] = React.useState("");
  const [recheckPending, setRecheckPending] = React.useState(false);
  const [recheckFieldError, setRecheckFieldError] = React.useState<string | null>(null);

  // Active audited Refund Recording form state
  const [refundTarget, setRefundTarget] = React.useState<{
    readonly obligationId: string;
    readonly paymentAttemptId: string | null;
    readonly tenantId: string;
    readonly tenantHandle: string;
    readonly defaultAmountIdr: number;
  } | null>(null);
  const [refundKind, setRefundKind] = React.useState<ConsoleRefundKind>("duplicate_payment");
  const [refundAmountText, setRefundAmountText] = React.useState("");
  const [refundExternalRef, setRefundExternalRef] = React.useState("");
  const [refundReason, setRefundReason] = React.useState("");
  const [refundConfirmedPolicy, setRefundConfirmedPolicy] = React.useState(false);
  const [refundPending, setRefundPending] = React.useState(false);
  const [refundFieldError, setRefundFieldError] = React.useState<string | null>(null);

  // Global notifications
  const [errorBanner, setErrorBanner] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const reviewCount = React.useMemo(
    () =>
      obligations.filter(
        (o) =>
          o.reviewRequired ||
          o.latestAttempt?.state === "review" ||
          o.latestAttempt?.state === "creation_unknown",
      ).length,
    [obligations],
  );
  const pendingCount = React.useMemo(
    () => obligations.filter((o) => o.latestAttempt?.state === "pending").length,
    [obligations],
  );
  const paidCount = React.useMemo(
    () => obligations.filter((o) => o.state === "paid").length,
    [obligations],
  );

  async function refreshBillingList(overrides?: {
    readonly tenantId?: string;
    readonly state?: string;
    readonly reviewOnly?: boolean;
  }) {
    setLoadingList(true);
    setErrorBanner(null);

    const qs = new URLSearchParams();
    const tid = (overrides?.tenantId ?? tenantIdFilter).trim();
    const st = overrides?.state ?? stateFilter;
    const rev = overrides?.reviewOnly ?? reviewOnly;

    if (tid) qs.set("tenantId", tid);
    if (st && st !== "all") qs.set("state", st);
    if (rev) qs.set("reviewOnly", "true");
    qs.set("limit", "30");

    try {
      const res = await fetch(`/api/console/billing?${qs.toString()}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly obligations?: readonly ConsoleBillingObligationDto[];
        readonly refunds?: readonly ConsoleBillingRefundDto[];
        readonly settlementPolicy?: ConsoleSettlementPolicyDto;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal memuat daftar billing console.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setObligations(Array.isArray(data.obligations) ? data.obligations : []);
      setRefunds(Array.isArray(data.refunds) ? data.refunds : []);
      if (data.settlementPolicy) {
        setPolicy(data.settlementPolicy);
      }
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat data billing console.",
      });
    } finally {
      setLoadingList(false);
    }
  }

  async function handleFilterSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await refreshBillingList();
  }

  async function handleRecheckSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recheckTarget || recheckPending) return;
    setErrorBanner(null);
    setSuccessMessage(null);
    setRecheckFieldError(null);

    const check = validateConsoleAuditReason(recheckReason);
    if (!check.ok) {
      setRecheckFieldError(check.error);
      return;
    }

    setRecheckPending(true);
    try {
      const res = await fetch("/api/console/billing/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          ...(recheckTarget.attemptId
            ? { attemptId: recheckTarget.attemptId }
            : { obligationId: recheckTarget.obligationId }),
          tenantId: recheckTarget.tenantId,
          reason: check.trimmed,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly recheck?: {
          readonly outcome: string;
          readonly reasonCode: string;
          readonly grantApplied: boolean;
          readonly operatorHoldPreserved: boolean;
        };
        readonly auditId?: string;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal menjalankan Advice recheck teraudit.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      const outcomeText = data.recheck?.outcome ?? "checked";
      const reasonCode = data.recheck?.reasonCode ?? "OK";
      setRecheckTarget(null);
      setRecheckReason("");
      await refreshBillingList();
      setSuccessMessage(
        `Advice recheck teraudit selesai (${outcomeText} / ${reasonCode}). ID Audit: ${data.auditId ?? "tercatat"}.`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menjalankan Advice recheck.",
      });
    } finally {
      setRecheckPending(false);
    }
  }

  async function handleRefundSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!refundTarget || refundPending) return;
    setErrorBanner(null);
    setSuccessMessage(null);
    setRefundFieldError(null);

    if (!refundConfirmedPolicy) {
      setRefundFieldError(
        "Centang konfirmasi bahwa pengembalian ini adalah pembayaran ganda, salah bayar, atau terlambat pasca-penghapusan.",
      );
      return;
    }

    const parsedAmount = Number.parseInt(refundAmountText.replace(/[^\d]/g, ""), 10);
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      setRefundFieldError("Nominal pengembalian dana harus berupa bilangan bulat IDR positif.");
      return;
    }

    const reasonCheck = validateConsoleAuditReason(refundReason);
    if (!reasonCheck.ok) {
      setRefundFieldError(reasonCheck.error);
      return;
    }

    setRefundPending(true);
    try {
      const res = await fetch("/api/console/billing/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          obligationId: refundTarget.obligationId,
          ...(refundTarget.paymentAttemptId
            ? { paymentAttemptId: refundTarget.paymentAttemptId }
            : {}),
          tenantId: refundTarget.tenantId,
          refundKind,
          amountIdr: parsedAmount,
          ...(refundExternalRef.trim() ? { externalReference: refundExternalRef.trim() } : {}),
          reason: reasonCheck.trimmed,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly refund?: ConsoleBillingRefundDto;
        readonly auditId?: string;
        readonly code?: string;
        readonly message?: string;
        readonly verifyPath?: string;
      };

      if (!res.ok || !data.success) {
        setErrorBanner({
          code: data.code ?? `HTTP_${res.status}`,
          message: data.message ?? "Gagal mencatat pengembalian dana teraudit.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setRefundTarget(null);
      setRefundReason("");
      setRefundExternalRef("");
      setRefundConfirmedPolicy(false);
      await refreshBillingList();
      setSuccessMessage(
        `Pengembalian dana manual (${formatIdr(parsedAmount)}) tercatat atomik dengan ID ${data.refund?.id ?? "baru"} dan ID Audit ${data.auditId ?? "tercatat"}. Pembalikan komisi afiliasi terkait (jika ada) dijadwalkan mengikuti catatan refund ini.`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mencatat pengembalian dana.",
      });
    } finally {
      setRefundPending(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="console-billing-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="console-billing-stepup-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk mutasi billing</AlertTitle>
          <AlertDescription>
            Menjalankan Advice recheck atau mencatat pengembalian dana manual memerlukan verifikasi
            2FA dalam 10 menit terakhir.{" "}
            <a
              href="/auth/two-factor?mode=verify&next=%2Fconsole%2Fbilling"
              className="font-medium underline underline-offset-4"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {/* Honest Settlement Policy & Zero-Manual-Paid Invariant Notice */}
      <Alert variant="info" role="status" data-testid="console-billing-policy-alert">
        <InfoIcon className="size-4" aria-hidden="true" />
        <AlertTitle>
          Kebijakan Penyelesaian: {policy.profile} ({policy.realProviderMappingStatus})
        </AlertTitle>
        <AlertDescription>
          Tampilan ini hanya menampilkan metadata tersensor (tanpa payload QRIS mentah, nomor VA,
          atau PII pelanggan). Operator hanya dapat menjalankan{" "}
          <strong>Advice Recheck teraudit</strong> atau{" "}
          <strong>pencatatan refund ganda/salah bayar teraudit</strong> — tidak tersedia tombol
          ubah status lunas sembarangan.
        </AlertDescription>
      </Alert>

      {errorBanner && (
        <Alert
          variant="destructive"
          role="alert"
          aria-live="assertive"
          data-testid="console-billing-error-alert"
        >
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Tindakan tidak dapat diproses ({errorBanner.code})</AlertTitle>
          <AlertDescription>
            <span>{errorBanner.message}</span>
            {(() => {
              const safeVerifyHref = buildSafeConsoleAuthHref(
                errorBanner.verifyPath,
                "/console/billing",
              );
              if (!safeVerifyHref) return null;
              return (
                <>
                  {" "}
                  <a
                    href={safeVerifyHref}
                    className="font-medium underline underline-offset-4"
                  >
                    Buka verifikasi 2FA
                  </a>
                </>
              );
            })()}
          </AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert
          variant="success"
          role="status"
          aria-live="polite"
          data-testid="console-billing-success-alert"
        >
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Tindakan teraudit berhasil dicatat</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Antrean Tinjauan / Rekonsiliasi</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="console-billing-review-count">
              {reviewCount}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Status <code className="font-mono">review</code> &amp;{" "}
            <code className="font-mono">creation_unknown</code>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Menunggu Pembayaran</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{pendingCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Instruksi QRIS / VA aktif
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Tagihan Lunas Terverifikasi</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{paidCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Hanya melalui konfirmasi Advice terverifikasi
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Catatan Refund Manual</CardDescription>
            <CardTitle className="text-2xl tabular-nums" data-testid="console-billing-refund-count">
              {refunds.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Khusus pembayaran ganda / salah bayar / pasca-hapus
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FilterIcon className="size-4 text-primary" aria-hidden="true" />
            <span>Filter Antrean Billing Tersensor</span>
          </CardTitle>
          <CardDescription>
            Saring tagihan menurut tenant ID, status kewajiban, atau antrean anomali.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <form
            onSubmit={handleFilterSubmit}
            className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end"
            data-testid="console-billing-filter-form"
          >
            <div className="space-y-1.5 md:col-span-4">
              <label
                htmlFor="console-billing-tenant-filter"
                className="block text-xs font-medium text-foreground"
              >
                ID Tenant (opsional)
              </label>
              <Input
                id="console-billing-tenant-filter"
                type="text"
                placeholder="Contoh: ten_01J..."
                value={tenantIdFilter}
                onChange={(e) => setTenantIdFilter(e.target.value)}
              />
            </div>

            <div className="space-y-1.5 md:col-span-3">
              <label
                htmlFor="console-billing-state-filter"
                className="block text-xs font-medium text-foreground"
              >
                Status Tagihan
              </label>
              <select
                id="console-billing-state-filter"
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
              >
                <option value="all">Semua status</option>
                <option value="open">Terbuka (open)</option>
                <option value="review">Perlu Tinjauan (review)</option>
                <option value="paid">Lunas (paid)</option>
                <option value="expired">Kedaluwarsa (expired)</option>
                <option value="cancelled">Dibatalkan (cancelled)</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-foreground md:min-h-9">
                <input
                  type="checkbox"
                  checked={reviewOnly}
                  onChange={(e) => setReviewOnly(e.target.checked)}
                  className="size-4 accent-primary"
                  data-testid="console-billing-review-only-checkbox"
                />
                <span>Hanya tinjauan/anomali</span>
              </label>
            </div>

            <div className="flex gap-2 md:col-span-2">
              <Button
                type="submit"
                disabled={loadingList}
                className="min-h-11 w-full md:min-h-9"
                data-testid="console-billing-filter-submit"
              >
                <RefreshCwIcon
                  className={`size-4 ${loadingList ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                <span>{loadingList ? "Memuat..." : "Terapkan"}</span>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Active Audited Advice Recheck Panel */}
      {recheckTarget && (
        <Card className="border-primary/50" data-testid="console-billing-recheck-card">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
              <span>Jalankan Advice Recheck Teraudit — {recheckTarget.tenantHandle}</span>
            </CardTitle>
            <CardDescription>
              Memeriksa status transaksi melalui <code className="font-mono">POST /api/h2h/advice</code>{" "}
              dengan <code className="font-mono">transaction_id</code> tersimpan. Tidak pernah
              mengubah status menjadi lunas tanpa bukti settlement resmi.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleRecheckSubmit} noValidate className="space-y-4">
              <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                <p className="font-mono text-foreground">
                  Obligation: {recheckTarget.obligationId}
                  {recheckTarget.attemptId ? ` • Attempt: ${recheckTarget.attemptId}` : ""}
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="console-recheck-reason"
                  className="block text-sm font-medium text-foreground"
                >
                  Alasan Audit Wajib (10–500 karakter, tanpa PII/rahasia)
                </label>
                <Input
                  id="console-recheck-reason"
                  type="text"
                  placeholder="Contoh: Tiket dukungan #412 meminta verifikasi ulang status pembayaran QRIS"
                  value={recheckReason}
                  onChange={(e) => {
                    setRecheckReason(e.target.value);
                    if (recheckFieldError) setRecheckFieldError(null);
                  }}
                  disabled={recheckPending}
                  aria-invalid={recheckFieldError ? "true" : undefined}
                  data-testid="console-recheck-reason-input"
                />
                {recheckFieldError && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {recheckFieldError}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="submit"
                  disabled={recheckPending}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="console-recheck-confirm-btn"
                >
                  <RefreshCwIcon className="size-4" aria-hidden="true" />
                  <span>
                    {recheckPending ? "Memeriksa Advice..." : "Konfirmasi Advice Recheck"}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={recheckPending}
                  onClick={() => {
                    setRecheckTarget(null);
                    setRecheckReason("");
                    setRecheckFieldError(null);
                  }}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                >
                  Batal
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Active Audited Duplicate / Mistaken Refund Recording Panel */}
      {refundTarget && (
        <Card className="border-warning-border" data-testid="console-billing-refund-card">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <RotateCcwIcon className="size-4 text-warning" aria-hidden="true" />
              <span>Catat Pengembalian Dana Manual Teraudit — {refundTarget.tenantHandle}</span>
            </CardTitle>
            <CardDescription>
              Khusus pembayaran ganda, salah bayar, atau pembayaran terlambat pasca-penghapusan
              (DEC-035 C6). Mencatat refund akan memicu penyesuaian/pembalikan komisi afiliasi
              terkait (jika ada) dan dicatat atomik ke <code className="font-mono">platform_audit</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <form onSubmit={handleRefundSubmit} noValidate className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="console-refund-kind"
                    className="block text-sm font-medium text-foreground"
                  >
                    Kategori Pengembalian Dana
                  </label>
                  <select
                    id="console-refund-kind"
                    value={refundKind}
                    onChange={(e) => setRefundKind(e.target.value as ConsoleRefundKind)}
                    disabled={refundPending}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                    data-testid="console-refund-kind-select"
                  >
                    {CONSOLE_REFUND_KIND_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="console-refund-amount"
                    className="block text-sm font-medium text-foreground"
                  >
                    Nominal Pengembalian (IDR bulat)
                  </label>
                  <Input
                    id="console-refund-amount"
                    type="text"
                    inputMode="numeric"
                    value={refundAmountText}
                    onChange={(e) => {
                      setRefundAmountText(e.target.value);
                      if (refundFieldError) setRefundFieldError(null);
                    }}
                    disabled={refundPending}
                    data-testid="console-refund-amount-input"
                  />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <label
                    htmlFor="console-refund-extref"
                    className="block text-sm font-medium text-foreground"
                  >
                    Referensi Transfer Manual Bank (opsional, tanpa data kartu/PII sensitif)
                  </label>
                  <Input
                    id="console-refund-extref"
                    type="text"
                    placeholder="Contoh: BTF-20261123-0042"
                    value={refundExternalRef}
                    onChange={(e) => setRefundExternalRef(e.target.value)}
                    disabled={refundPending}
                    data-testid="console-refund-extref-input"
                  />
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <label
                    htmlFor="console-refund-reason"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan Audit Wajib (10–500 karakter, jelaskan verifikasi pembayaran ganda/salah bayar)
                  </label>
                  <Input
                    id="console-refund-reason"
                    type="text"
                    placeholder="Contoh: Verifikasi mutasi pembayaran ganda QRIS pada periode November 2026"
                    value={refundReason}
                    onChange={(e) => {
                      setRefundReason(e.target.value);
                      if (refundFieldError) setRefundFieldError(null);
                    }}
                    disabled={refundPending}
                    aria-invalid={refundFieldError ? "true" : undefined}
                    data-testid="console-refund-reason-input"
                  />
                </div>
              </div>

              <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-warning-border bg-warning-soft/50 p-3 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={refundConfirmedPolicy}
                  onChange={(e) => {
                    setRefundConfirmedPolicy(e.target.checked);
                    if (refundFieldError) setRefundFieldError(null);
                  }}
                  disabled={refundPending}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  data-testid="console-refund-confirm-checkbox"
                />
                <span>
                  Saya mengonfirmasi kasus ini adalah pembayaran ganda, salah bayar, atau terlambat
                  pasca-penghapusan (bukan berubah pikiran) dan memahami bahwa catatan refund ini
                  akan memicu pembalikan komisi afiliasi terkait bila berlaku.
                </span>
              </label>

              {refundFieldError && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {refundFieldError}
                </p>
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={refundPending}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="console-refund-submit-btn"
                >
                  <RotateCcwIcon className="size-4" aria-hidden="true" />
                  <span>
                    {refundPending ? "Mencatat refund & audit..." : "Simpan Catatan Refund Teraudit"}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={refundPending}
                  onClick={() => {
                    setRefundTarget(null);
                    setRefundReason("");
                    setRefundExternalRef("");
                    setRefundConfirmedPolicy(false);
                    setRefundFieldError(null);
                  }}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                >
                  Batal
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Redacted Obligations & Attempts Table */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-base">Daftar Tagihan &amp; Rekonsiliasi (Metadata Tersensor)</CardTitle>
          <CardDescription>
            Menampilkan referensi transaksi, status percobaan, jumlah polling Advice, dan jumlah
            entitlement grant tanpa payload QRIS/VA mentah.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {obligations.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground" data-testid="console-billing-empty">
              Tidak ada data tagihan yang cocok dengan filter saat ini.
            </p>
          ) : (
            <>
              {/* Mobile card stack (< md) for zero horizontal overflow at 360px */}
              <div className="space-y-3 md:hidden" data-testid="console-billing-mobile-list">
                {obligations.map((item) => {
                  const oblBadge = getObligationStateBadgeMeta(item.state);
                  const att = item.latestAttempt;
                  const attBadge = att ? getAttemptStateBadgeMeta(att.state) : null;
                  return (
                    <div
                      key={item.obligationId}
                      className="space-y-2.5 rounded-lg border border-border bg-card p-3.5 text-sm"
                      data-testid={`console-billing-card-${item.obligationId}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">{item.tenantHandle}</p>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {item.obligationId}
                          </p>
                        </div>
                        <Badge variant={oblBadge.variant}>{oblBadge.label}</Badge>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="outline">
                          {getTenantStatusIndonesianLabel(item.tenantStatus, item.operatorHold)}
                        </Badge>
                        {attBadge && <Badge variant={attBadge.variant}>{attBadge.label}</Badge>}
                      </div>

                      <dl className="space-y-1 text-xs">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Total / Pokok</dt>
                          <dd className="font-semibold tabular-nums text-foreground">
                            {formatIdr(att?.totalPayableIdr ?? item.netAmountIdr)}
                          </dd>
                        </div>
                        {att && (
                          <>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Saluran &amp; Reff</dt>
                              <dd className="font-mono text-foreground">
                                {att.channelCode} • {att.reffId}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Trx ID / Poll</dt>
                              <dd className="font-mono tabular-nums text-foreground">
                                {att.providerTransactionId ?? "—"} ({att.pollCount}/{att.maxPolls})
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>

                      <div className="flex flex-col gap-2 pt-1">
                        {att && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setRefundTarget(null);
                              setRecheckTarget({
                                obligationId: item.obligationId,
                                attemptId: att.attemptId,
                                tenantId: item.tenantId,
                                tenantHandle: item.tenantHandle,
                              });
                              setRecheckReason("");
                              setRecheckFieldError(null);
                            }}
                            className="min-h-11 w-full"
                          >
                            <RefreshCwIcon className="size-4" aria-hidden="true" />
                            <span>Advice Recheck</span>
                          </Button>
                        )}
                        {isConsoleObligationRefundEligible(item) && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setRecheckTarget(null);
                              setRefundTarget({
                                obligationId: item.obligationId,
                                paymentAttemptId: att?.attemptId ?? null,
                                tenantId: item.tenantId,
                                tenantHandle: item.tenantHandle,
                                defaultAmountIdr: att?.totalPayableIdr ?? item.netAmountIdr,
                              });
                              setRefundAmountText(String(att?.totalPayableIdr ?? item.netAmountIdr));
                              setRefundKind("duplicate_payment");
                              setRefundReason("");
                              setRefundExternalRef("");
                              setRefundConfirmedPolicy(false);
                              setRefundFieldError(null);
                            }}
                            className="min-h-11 w-full"
                          >
                            <RotateCcwIcon className="size-4" aria-hidden="true" />
                            <span>Catat Refund</span>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="console-billing-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tenant &amp; Tagihan</TableHead>
                      <TableHead>Paket &amp; Nominal</TableHead>
                      <TableHead>Referensi &amp; Saluran</TableHead>
                      <TableHead>Status &amp; Advice Poll</TableHead>
                      <TableHead className="text-right">Tindakan Teraudit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {obligations.map((item) => {
                      const oblBadge = getObligationStateBadgeMeta(item.state);
                      const att = item.latestAttempt;
                      const attBadge = att ? getAttemptStateBadgeMeta(att.state) : null;
                      return (
                        <TableRow
                          key={item.obligationId}
                          data-testid={`console-billing-row-${item.obligationId}`}
                        >
                          <TableCell>
                            <div className="space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-foreground">
                                  {item.tenantHandle}
                                </span>
                                <Badge variant={item.operatorHold ? "destructive" : "outline"}>
                                  {getTenantStatusIndonesianLabel(
                                    item.tenantStatus,
                                    item.operatorHold,
                                  )}
                                </Badge>
                              </div>
                              <p className="font-mono text-xs text-muted-foreground">
                                {item.obligationId}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-0.5 text-xs">
                              <p className="font-semibold tabular-nums text-foreground">
                                {formatIdr(att?.totalPayableIdr ?? item.netAmountIdr)}
                              </p>
                              <p className="text-muted-foreground tabular-nums">
                                {item.plan === "yearly" ? "Tahunan" : "Bulanan"} • Grant:{" "}
                                {item.grantCount}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            {att ? (
                              <div className="space-y-0.5 font-mono text-xs">
                                <p className="text-foreground">
                                  {att.channelCode} • {att.reffId}
                                </p>
                                <p className="text-muted-foreground">
                                  Trx: {att.providerTransactionId ?? "—"}
                                </p>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">Belum ada attempt</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex flex-wrap gap-1.5">
                                <Badge variant={oblBadge.variant}>{oblBadge.label}</Badge>
                                {attBadge && (
                                  <Badge variant={attBadge.variant}>{attBadge.label}</Badge>
                                )}
                              </div>
                              {att && (
                                <p className="text-xs text-muted-foreground tabular-nums">
                                  Poll: {att.pollCount}/{att.maxPolls}
                                  {att.safeFailureCode ? ` • ${att.safeFailureCode}` : ""}
                                </p>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              {att && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setRefundTarget(null);
                                    setRecheckTarget({
                                      obligationId: item.obligationId,
                                      attemptId: att.attemptId,
                                      tenantId: item.tenantId,
                                      tenantHandle: item.tenantHandle,
                                    });
                                    setRecheckReason("");
                                    setRecheckFieldError(null);
                                  }}
                                  data-testid={`console-recheck-trigger-${item.obligationId}`}
                                >
                                  <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                                  <span>Advice Recheck</span>
                                </Button>
                              )}
                              {isConsoleObligationRefundEligible(item) && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setRecheckTarget(null);
                                    setRefundTarget({
                                      obligationId: item.obligationId,
                                      paymentAttemptId: att?.attemptId ?? null,
                                      tenantId: item.tenantId,
                                      tenantHandle: item.tenantHandle,
                                      defaultAmountIdr: att?.totalPayableIdr ?? item.netAmountIdr,
                                    });
                                    setRefundAmountText(
                                      String(att?.totalPayableIdr ?? item.netAmountIdr),
                                    );
                                    setRefundKind("duplicate_payment");
                                    setRefundReason("");
                                    setRefundExternalRef("");
                                    setRefundConfirmedPolicy(false);
                                    setRefundFieldError(null);
                                  }}
                                  data-testid={`console-refund-trigger-${item.obligationId}`}
                                >
                                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                                  <span>Catat Refund</span>
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Audited Refund History */}
      <Card data-testid="console-billing-refunds-card">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-base">Riwayat Pengembalian Dana Manual Teraudit</CardTitle>
          <CardDescription>
            Catatan append-only pengembalian dana untuk pembayaran ganda, salah bayar, atau
            pasca-penghapusan.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {refunds.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground" data-testid="console-refunds-empty">
              Belum ada pengembalian dana manual yang tercatat.
            </p>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {refunds.map((r) => (
                  <div
                    key={r.id}
                    className="space-y-1.5 rounded-lg border border-border bg-card p-3.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-foreground">{r.id}</span>
                      <Badge variant="outline">{r.refundKind}</Badge>
                    </div>
                    <p className="font-semibold text-foreground tabular-nums">
                      {formatIdr(r.amountIdr)}
                    </p>
                    <p className="text-muted-foreground">{r.reason}</p>
                    <p className="text-muted-foreground tabular-nums">
                      Dicatat: {formatWibDateTime(r.createdAt)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="hidden md:block">
                <Table data-testid="console-refunds-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID Refund</TableHead>
                      <TableHead>ID Tagihan</TableHead>
                      <TableHead>Kategori</TableHead>
                      <TableHead className="text-right">Nominal</TableHead>
                      <TableHead>Referensi &amp; Alasan Audit</TableHead>
                      <TableHead>Waktu (WIB)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {refunds.map((r) => (
                      <TableRow key={r.id} data-testid={`console-refund-row-${r.id}`}>
                        <TableCell className="font-mono text-xs">{r.id}</TableCell>
                        <TableCell className="font-mono text-xs">{r.obligationId}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{r.refundKind}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-semibold whitespace-nowrap tabular-nums">
                          {formatIdr(r.amountIdr)}
                        </TableCell>
                        <TableCell className="max-w-md text-xs">
                          {r.externalReference && (
                            <span className="mr-1.5 font-mono text-foreground">
                              [{r.externalReference}]
                            </span>
                          )}
                          <span className="text-muted-foreground">{r.reason}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {formatWibDateTime(r.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
