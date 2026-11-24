import * as React from "react";
import {
  Ban,
  CheckCircle2,
  Clock,
  Download,
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ConsoleAffiliateDto,
  ConsoleAffiliatePayoutBatchDto,
  PlatformAffiliateComplianceState,
} from "../../api/console/affiliates/_shared";

export interface ConsoleAffiliatesPanelProps {
  readonly initialAffiliates: readonly ConsoleAffiliateDto[];
  readonly initialBatches: readonly ConsoleAffiliatePayoutBatchDto[];
  readonly initialCompliance: PlatformAffiliateComplianceState;
  readonly stepUpFresh: boolean;
  readonly isSuperadmin: boolean;
}

type StatusFilter = "all" | "pending" | "active" | "suspended" | "rejected";
type AffiliateActionKind = "approve" | "suspend" | "reject";

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

function statusBadgeVariant(
  status: ConsoleAffiliateDto["status"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "pending":
      return "secondary";
    case "suspended":
    case "rejected":
      return "destructive";
  }
}

function statusLabelId(status: ConsoleAffiliateDto["status"]): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "pending":
      return "Menunggu";
    case "suspended":
      return "Ditangguhkan";
    case "rejected":
      return "Ditolak";
  }
}

export function ConsoleAffiliatesPanel({
  initialAffiliates,
  initialBatches,
  initialCompliance,
  stepUpFresh,
  isSuperadmin,
}: ConsoleAffiliatesPanelProps) {
  const [affiliates, setAffiliates] =
    React.useState<readonly ConsoleAffiliateDto[]>(initialAffiliates);
  const [batches, setBatches] =
    React.useState<readonly ConsoleAffiliatePayoutBatchDto[]>(initialBatches);
  const [compliance, setCompliance] =
    React.useState<PlatformAffiliateComplianceState>(initialCompliance);

  // Filter & selection state
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [selectedAffiliateId, setSelectedAffiliateId] = React.useState<string>(
    initialAffiliates[0]?.id ?? "",
  );
  const [statusAction, setStatusAction] = React.useState<AffiliateActionKind>(
    initialAffiliates[0]?.status === "active" ? "suspend" : "approve",
  );
  const [customReferralCode, setCustomReferralCode] = React.useState("");
  const [statusReason, setStatusReason] = React.useState("");
  const [statusSubmitting, setStatusSubmitting] = React.useState(false);

  // Mark-paid batch form state
  const firstPendingBatch =
    initialBatches.find((b) => b.status === "pending_review") ?? initialBatches[0] ?? null;
  const [selectedBatchId, setSelectedBatchId] = React.useState<string>(
    firstPendingBatch?.id ?? "",
  );
  const [transferReference, setTransferReference] = React.useState("");
  const [markPaidReason, setMarkPaidReason] = React.useState("");
  const [markPaidSubmitting, setMarkPaidSubmitting] = React.useState(false);

  // REQ-095 compliance form state
  const [termsPublished, setTermsPublished] = React.useState(
    initialCompliance.affiliateTermsPublished,
  );
  const [taxReviewCompleted, setTaxReviewCompleted] = React.useState(
    initialCompliance.affiliateTaxReviewCompleted,
  );
  const [complianceReason, setComplianceReason] = React.useState("");
  const [complianceSubmitting, setComplianceSubmitting] = React.useState(false);

  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [successMsg, setSuccessMsg] = React.useState<string | null>(null);
  const [exportWarning, setExportWarning] = React.useState<string | null>(null);
  const [exportingScope, setExportingScope] = React.useState<"affiliates" | "batches" | null>(
    null,
  );

  const filteredAffiliates = React.useMemo(
    () =>
      statusFilter === "all"
        ? affiliates
        : affiliates.filter((a) => a.status === statusFilter),
    [affiliates, statusFilter],
  );

  const selectedAffiliate = affiliates.find((a) => a.id === selectedAffiliateId) ?? null;
  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;

  const summary = React.useMemo(() => {
    let pendingAffiliates = 0;
    let activeAffiliates = 0;
    for (const a of affiliates) {
      if (a.status === "pending") pendingAffiliates += 1;
      else if (a.status === "active") activeAffiliates += 1;
    }
    let pendingReviewBatches = 0;
    let pendingReviewTotalIdr = 0;
    let paidTotalIdr = 0;
    for (const b of batches) {
      if (b.status === "pending_review") {
        pendingReviewBatches += 1;
        pendingReviewTotalIdr += b.totalAmountIdr;
      } else if (b.status === "paid") {
        paidTotalIdr += b.totalAmountIdr;
      }
    }
    return {
      totalAffiliates: affiliates.length,
      pendingAffiliates,
      activeAffiliates,
      pendingReviewBatches,
      pendingReviewTotalIdr,
      paidTotalIdr,
    };
  }, [affiliates, batches]);

  function selectAffiliate(affiliate: ConsoleAffiliateDto) {
    setSelectedAffiliateId(affiliate.id);
    setStatusAction(affiliate.status === "active" ? "suspend" : "approve");
    setCustomReferralCode("");
    setStatusReason("");
    setErrorMsg(null);
    setSuccessMsg(null);
  }

  function selectBatch(batch: ConsoleAffiliatePayoutBatchDto) {
    setSelectedBatchId(batch.id);
    setTransferReference(batch.transferReference ?? "");
    setMarkPaidReason("");
    setErrorMsg(null);
    setSuccessMsg(null);
  }

  async function refreshDashboard() {
    const res = await fetch("/api/console/affiliates", {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const data = (await res.json().catch(() => null)) as {
      readonly success?: boolean;
      readonly affiliates?: readonly ConsoleAffiliateDto[];
      readonly batches?: readonly ConsoleAffiliatePayoutBatchDto[];
      readonly compliance?: PlatformAffiliateComplianceState;
    } | null;
    if (data?.success && data.affiliates && data.batches && data.compliance) {
      setAffiliates(data.affiliates);
      setBatches(data.batches);
      setCompliance(data.compliance);
    }
  }

  async function handleStatusSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedAffiliate) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setStatusSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        action: statusAction,
        reason: statusReason.trim(),
        expectedVersion: selectedAffiliate.version,
      };
      if (statusAction === "approve" && customReferralCode.trim()) {
        payload.referralCode = customReferralCode.trim();
      }
      const res = await fetch(
        `/api/console/affiliates/${encodeURIComponent(selectedAffiliate.id)}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly affiliate?: {
          readonly status: ConsoleAffiliateDto["status"];
          readonly referralCode: string | null;
        };
        readonly message?: string;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success) {
        setErrorMsg(
          data.message ?? data.error?.message ?? "Gagal memperbarui status akun afiliasi.",
        );
        return;
      }
      await refreshDashboard();
      setStatusReason("");
      setCustomReferralCode("");
      setSuccessMsg(
        `Status afiliasi ${selectedAffiliate.email} berhasil diubah menjadi ${data.affiliate?.status ?? statusAction}${data.affiliate?.referralCode ? ` (kode: ${data.affiliate.referralCode})` : ""}.`,
      );
    } catch {
      setErrorMsg("Koneksi gagal saat memperbarui status afiliasi.");
    } finally {
      setStatusSubmitting(false);
    }
  }

  async function handleMarkPaidSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatch) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setMarkPaidSubmitting(true);
    try {
      const res = await fetch(
        `/api/console/affiliates/batches/${encodeURIComponent(selectedBatch.id)}/mark-paid`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            transferReference: transferReference.trim(),
            reason: markPaidReason.trim(),
            expectedVersion: selectedBatch.version,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly paidEntryCount?: number;
        readonly message?: string;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success) {
        setErrorMsg(
          data.message ?? data.error?.message ?? "Gagal menandai batch payout sebagai dibayar.",
        );
        return;
      }
      await refreshDashboard();
      setTransferReference("");
      setMarkPaidReason("");
      setSuccessMsg(
        `Batch payout ${selectedBatch.payoutPeriodKey} (${formatIdr(selectedBatch.totalAmountIdr)}) berhasil ditandai dibayar (${data.paidEntryCount ?? selectedBatch.entryCount} entri).`,
      );
    } catch {
      setErrorMsg("Koneksi gagal saat mencatat transfer payout.");
    } finally {
      setMarkPaidSubmitting(false);
    }
  }

  async function handleComplianceSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    setComplianceSubmitting(true);
    try {
      const res = await fetch("/api/console/affiliates/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          affiliateTermsPublished: termsPublished,
          affiliateTaxReviewCompleted: taxReviewCompleted,
          reason: complianceReason.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly compliance?: PlatformAffiliateComplianceState;
        readonly message?: string;
        readonly error?: { readonly message?: string };
      };
      if (!res.ok || !data.success || !data.compliance) {
        setErrorMsg(
          data.message ?? data.error?.message ?? "Gagal memperbarui status kepatuhan REQ-095.",
        );
        return;
      }
      setCompliance(data.compliance);
      setComplianceReason("");
      setSuccessMsg("Status gerbang kepatuhan pajak & ketentuan afiliasi (REQ-095) diperbarui.");
    } catch {
      setErrorMsg("Koneksi gagal saat memperbarui status kepatuhan REQ-095.");
    } finally {
      setComplianceSubmitting(false);
    }
  }

  async function handleCsvExport(scope: "affiliates" | "batches") {
    setErrorMsg(null);
    setSuccessMsg(null);
    setExportWarning(null);
    setExportingScope(scope);
    try {
      const res = await fetch(`/api/console/affiliates?format=csv&export=${scope}`, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          readonly message?: string;
          readonly error?: { readonly message?: string };
        };
        setErrorMsg(
          data.message ??
            data.error?.message ??
            "Ekspor CSV ditolak. Pastikan 2FA step-up aktif dalam 10 menit terakhir.",
        );
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const filenameMatch = /filename="([^"]+)"/.exec(disposition);
      const fallbackName =
        scope === "batches"
          ? "punyasitus-affiliate-payout-batches.csv"
          : "punyasitus-affiliates.csv";
      const filename = filenameMatch?.[1] ?? fallbackName;

      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      const rowCount = res.headers.get("x-export-row-count") ?? "0";
      const maxRows = res.headers.get("x-export-max-rows") ?? "5000";
      const truncated = res.headers.get("x-export-truncated") === "true";
      const nextOffset = res.headers.get("x-export-next-offset");

      if (truncated) {
        setExportWarning(
          `Ekspor CSV terpotong pada batas ${rowCount}/${maxRows} baris. Gunakan parameter ?offset=${nextOffset ?? rowCount} untuk mengunduh sisa data agar tidak ada payout terlewat.`,
        );
      } else {
        setSuccessMsg(`Berhasil mengekspor ${rowCount} baris CSV (${filename}).`);
      }
    } catch {
      setErrorMsg("Koneksi gagal saat mengekspor data CSV afiliasi.");
    } finally {
      setExportingScope(null);
    }
  }

  const filterOptions: readonly { readonly id: StatusFilter; readonly label: string }[] = [
    { id: "all", label: "Semua" },
    { id: "pending", label: "Menunggu" },
    { id: "active", label: "Aktif" },
    { id: "suspended", label: "Ditangguhkan" },
    { id: "rejected", label: "Ditolak" },
  ];

  return (
    <div className="space-y-5" data-testid="console-affiliates-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="console-affiliates-stepup-warning">
          <Clock className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk mutasi &amp; ekspor CSV</AlertTitle>
          <AlertDescription>
            Anda dapat meninjau daftar afiliasi dan batch payout, tetapi ekspor CSV payout,
            persetujuan/penangguhan akun, serta penandaan transfer payout mewajibkan 2FA step-up
            dalam 10 menit terakhir.
          </AlertDescription>
        </Alert>
      )}

      {exportWarning && (
        <Alert variant="warning" data-testid="console-affiliates-export-truncated">
          <Clock className="size-4" aria-hidden="true" />
          <AlertTitle>Hasil ekspor CSV terpotong</AlertTitle>
          <AlertDescription>{exportWarning}</AlertDescription>
        </Alert>
      )}

      {errorMsg && (
        <Alert variant="destructive" data-testid="console-affiliates-error">
          <Ban className="size-4" aria-hidden="true" />
          <AlertTitle>Permintaan ditolak</AlertTitle>
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}

      {successMsg && (
        <Alert variant="info" data-testid="console-affiliates-success">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          <AlertTitle>Tercatat di log audit platform</AlertTitle>
          <AlertDescription>{successMsg}</AlertDescription>
        </Alert>
      )}

      {/* 4 Summary KPI Cards */}
      <section
        aria-label="Ringkasan program afiliasi platform"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Card size="sm" data-testid="console-affiliates-kpi-total">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">Total Mitra Afiliasi</CardDescription>
            <Users className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {summary.totalAffiliates}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {summary.activeAffiliates} aktif · {summary.pendingAffiliates} menunggu persetujuan
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="console-affiliates-kpi-pending-batches">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">
              Batch Menunggu Transfer
            </CardDescription>
            <Clock className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {summary.pendingReviewBatches}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              Total {formatIdr(summary.pendingReviewTotalIdr)}
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="console-affiliates-kpi-paid-total">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">Total Payout Dibayar</CardDescription>
            <Wallet className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {formatIdr(summary.paidTotalIdr)}
            </p>
            <p className="text-xs text-muted-foreground">
              Seluruh transfer manual teraudit dengan referensi bank
            </p>
          </CardContent>
        </Card>

        <Card size="sm" data-testid="console-affiliates-kpi-compliance">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardDescription className="text-xs font-medium">
              Gerbang Pajak &amp; Ketentuan
            </CardDescription>
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-bold text-foreground">
              {compliance.resolved ? "Terpenuhi" : "Tertahan"}
            </p>
            <p className="text-xs text-muted-foreground">
              {compliance.resolved
                ? "REQ-095 selesai — payout dapat ditandai dibayar"
                : "Selesaikan REQ-095 sebelum menandai batch dibayar"}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* CSV Export & REQ-095 Compliance Row */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card data-testid="console-affiliate-compliance-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              Gerbang Kepatuhan Pajak &amp; Ketentuan (REQ-095)
            </CardTitle>
            <CardDescription>
              Batch payout tidak dapat ditandai dibayar sebelum ketentuan program afiliasi
              diterbitkan, tinjauan pajak afiliasi selesai, dan mitra menyetujui ketentuan.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleComplianceSubmit} className="space-y-3">
              <label
                htmlFor="req095-terms-published"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground"
              >
                <input
                  id="req095-terms-published"
                  type="checkbox"
                  checked={termsPublished}
                  onChange={(e) => setTermsPublished(e.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span>Dokumen Ketentuan Program Afiliasi resmi diterbitkan</span>
              </label>

              <label
                htmlFor="req095-tax-review"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground"
              >
                <input
                  id="req095-tax-review"
                  type="checkbox"
                  checked={taxReviewCompleted}
                  onChange={(e) => setTaxReviewCompleted(e.target.checked)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span>Tinjauan pajak afiliasi (PPh 21/23) telah selesai diverifikasi</span>
              </label>

              <div className="space-y-1.5">
                <label
                  htmlFor="req095-compliance-reason"
                  className="block text-sm font-medium text-foreground"
                >
                  Alasan Audit Operator (min. 10 karakter)
                </label>
                <Input
                  id="req095-compliance-reason"
                  type="text"
                  value={complianceReason}
                  onChange={(e) => setComplianceReason(e.target.value)}
                  placeholder="Konfirmasi dokumen hukum afiliasi dan review PPh selesai"
                  required
                  minLength={10}
                  className="min-h-11 text-base md:min-h-9 md:text-sm"
                />
              </div>

              <Button
                type="submit"
                disabled={complianceSubmitting || !isSuperadmin}
                data-testid="console-compliance-submit"
                className="min-h-11 w-full sm:w-auto md:min-h-9"
              >
                {complianceSubmitting ? "Menyimpan..." : "Simpan Status Kepatuhan REQ-095"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Audited Affiliate Status Mutation Form */}
        <Card data-testid="console-affiliate-status-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="size-4 text-primary" aria-hidden="true" />
              Persetujuan &amp; Status Akun Afiliasi
            </CardTitle>
            <CardDescription>
              Setujui pendaftaran (menerbitkan kode referral unik), tangguhkan akun, atau tolak
              pengajuan pending. Wajib 2FA step-up dan alasan audit 10–500 karakter.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedAffiliate ? (
              <p className="text-sm text-muted-foreground">
                Pilih mitra afiliasi dari daftar di bawah untuk mengubah statusnya.
              </p>
            ) : (
              <form onSubmit={handleStatusSubmit} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                  <span className="truncate font-semibold text-foreground">
                    {selectedAffiliate.email}
                  </span>
                  <Badge variant={statusBadgeVariant(selectedAffiliate.status)} className="tabular-nums">
                    {statusLabelId(selectedAffiliate.status)} · v{selectedAffiliate.version}
                  </Badge>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="affiliate-status-action"
                      className="block text-sm font-medium text-foreground"
                    >
                      Tindakan Operator
                    </label>
                    <select
                      id="affiliate-status-action"
                      value={statusAction}
                      onChange={(e) => setStatusAction(e.target.value as AffiliateActionKind)}
                      className="min-h-11 w-full rounded-md border border-input bg-background px-2.5 text-base text-foreground md:min-h-9 md:text-sm"
                    >
                      <option value="approve">Setujui &amp; Aktifkan</option>
                      <option value="suspend">Tangguhkan Akun</option>
                      <option value="reject">Tolak Pendaftaran</option>
                    </select>
                  </div>

                  {statusAction === "approve" && (
                    <div className="space-y-1.5">
                      <label
                        htmlFor="affiliate-custom-code"
                        className="block text-sm font-medium text-foreground"
                      >
                        Kode Referral Kustom (Opsional)
                      </label>
                      <Input
                        id="affiliate-custom-code"
                        type="text"
                        value={customReferralCode}
                        onChange={(e) => setCustomReferralCode(e.target.value)}
                        placeholder="Otomatis jika dikosongkan"
                        className="min-h-11 font-mono text-base uppercase md:min-h-9 md:text-sm"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="affiliate-status-reason"
                    className="block text-sm font-medium text-foreground"
                  >
                    Alasan Audit Operator (min. 10 karakter)
                  </label>
                  <Input
                    id="affiliate-status-reason"
                    type="text"
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    placeholder="Verifikasi identitas dan rekening pencairan mitra selesai"
                    required
                    minLength={10}
                    className="min-h-11 text-base md:min-h-9 md:text-sm"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={statusSubmitting || !isSuperadmin}
                  data-testid="console-affiliate-status-submit"
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                >
                  {statusSubmitting ? "Memproses..." : "Terapkan Perubahan Status"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Affiliates Directory Table + CSV Export */}
      <Card data-testid="console-affiliates-table-card">
        <CardHeader className="flex flex-col gap-3 border-b border-border sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Daftar Mitra Afiliasi ({filteredAffiliates.length})</CardTitle>
            <CardDescription>
              Filter berdasarkan status, tinjau saldo buku besar, atau ekspor CSV aman (anti-injeksi
              formula spreadsheet).
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="console-export-affiliates-csv"
              disabled={exportingScope !== null}
              onClick={() => handleCsvExport("affiliates")}
            >
              <Download className="size-4" aria-hidden="true" />
              {exportingScope === "affiliates" ? "Mengekspor..." : "Ekspor CSV Afiliasi"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid="console-export-batches-csv"
              disabled={exportingScope !== null}
              onClick={() => handleCsvExport("batches")}
            >
              <Download className="size-4" aria-hidden="true" />
              {exportingScope === "batches" ? "Mengekspor..." : "Ekspor CSV Batch"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter status afiliasi">
            {filterOptions.map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="sm"
                variant={statusFilter === opt.id ? "default" : "outline"}
                onClick={() => setStatusFilter(opt.id)}
                className="min-h-11 md:min-h-8"
              >
                {opt.label}
              </Button>
            ))}
          </div>

          {filteredAffiliates.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Tidak ada mitra afiliasi pada filter status ini.
            </p>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mitra &amp; Kode</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Rekening Pencairan</TableHead>
                      <TableHead className="text-right">Funnel (Klik/Daftar/Bayar)</TableHead>
                      <TableHead className="text-right">Disetujui / Dibayar</TableHead>
                      <TableHead className="text-right">Aksi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAffiliates.map((a) => (
                      <TableRow key={a.id} data-testid={`console-affiliate-row-${a.id}`}>
                        <TableCell>
                          <p className="font-medium text-foreground">{a.email}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {a.referralCode ?? "Belum diterbitkan"} · v{a.version}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusBadgeVariant(a.status)}>
                            {statusLabelId(a.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <p className="font-mono text-foreground">
                            {a.payoutBankCode} · {a.payoutAccountMasked}
                          </p>
                          <p className="text-muted-foreground">{a.payoutAccountHolder}</p>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {a.visitsCount} / {a.referralsCount} / {a.payingTenantsCount}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          <p className="font-semibold text-primary">
                            {formatIdr(a.balances.approvedAvailableIdr)}
                          </p>
                          <p className="text-muted-foreground">
                            Dibayar: {formatIdr(a.balances.paidIdr)}
                          </p>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant={selectedAffiliateId === a.id ? "default" : "outline"}
                            onClick={() => selectAffiliate(a)}
                            className="min-h-9"
                          >
                            Kelola
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {filteredAffiliates.map((a) => (
                  <li key={a.id} className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{a.email}</span>
                      <Badge variant={statusBadgeVariant(a.status)}>
                        {statusLabelId(a.status)}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      Kode: {a.referralCode ?? "—"} · {a.payoutBankCode} {a.payoutAccountMasked}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Siap cair: {formatIdr(a.balances.approvedAvailableIdr)} · Dibayar:{" "}
                      {formatIdr(a.balances.paidIdr)}
                    </p>
                    <Button
                      type="button"
                      variant={selectedAffiliateId === a.id ? "default" : "outline"}
                      onClick={() => selectAffiliate(a)}
                      className="min-h-11 w-full"
                    >
                      Kelola Mitra Afiliasi
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* Payout Batches & Mark Paid Form */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="console-payout-batches-card">
          <CardHeader className="border-b border-border">
            <CardTitle>Batch Pencairan Komisi ({batches.length})</CardTitle>
            <CardDescription>
              Batch bi-bulanan (15 &amp; 30 WIB, min. Rp 100.000). Lakukan transfer bank manual di
              luar platform, lalu catat referensi transfer di formulir samping.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {batches.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                Belum ada batch pencairan afiliasi.
              </div>
            ) : (
              <>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Periode &amp; Mitra</TableHead>
                        <TableHead>Rekening</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Nominal</TableHead>
                        <TableHead className="text-right">Aksi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batches.map((b) => (
                        <TableRow key={b.id} data-testid={`console-batch-row-${b.id}`}>
                          <TableCell>
                            <p className="font-mono text-sm font-medium text-foreground tabular-nums">
                              {b.payoutPeriodKey}
                            </p>
                            <p className="text-xs text-muted-foreground">{b.affiliateEmail}</p>
                          </TableCell>
                          <TableCell className="text-xs">
                            <p className="font-mono text-foreground">
                              {b.payoutBankCode} · {b.payoutAccountMasked}
                            </p>
                            <p className="text-muted-foreground">{b.payoutAccountHolder}</p>
                          </TableCell>
                          <TableCell>
                            <Badge variant={b.status === "paid" ? "default" : "secondary"}>
                              {b.status === "paid"
                                ? "Dibayar"
                                : b.status === "pending_review"
                                  ? "Menunggu Transfer"
                                  : "Dibatalkan"}
                            </Badge>
                            {b.transferReference && (
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                Ref: {b.transferReference}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatIdr(b.totalAmountIdr)}
                            <p className="text-xs font-normal text-muted-foreground">
                              {b.entryCount} entri · v{b.version}
                            </p>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              variant={selectedBatchId === b.id ? "default" : "outline"}
                              onClick={() => selectBatch(b)}
                              className="min-h-9"
                            >
                              {b.status === "pending_review" ? "Catat Transfer" : "Detail"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ul className="divide-y divide-border md:hidden">
                  {batches.map((b) => (
                    <li key={b.id} className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold tabular-nums">
                          {b.payoutPeriodKey}
                        </span>
                        <Badge variant={b.status === "paid" ? "default" : "secondary"}>
                          {b.status === "paid" ? "Dibayar" : "Menunggu Transfer"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{b.affiliateEmail}</p>
                      <p className="text-sm font-semibold text-foreground tabular-nums">
                        {formatIdr(b.totalAmountIdr)} · {b.payoutBankCode} {b.payoutAccountMasked}
                      </p>
                      {b.transferReference && (
                        <p className="font-mono text-xs text-muted-foreground">
                          Ref: {b.transferReference} ({formatDateId(b.paidAt)})
                        </p>
                      )}
                      <Button
                        type="button"
                        variant={selectedBatchId === b.id ? "default" : "outline"}
                        onClick={() => selectBatch(b)}
                        className="min-h-11 w-full"
                      >
                        {b.status === "pending_review" ? "Catat Transfer Batch" : "Lihat Detail"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="console-mark-paid-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4 text-primary" aria-hidden="true" />
              Catat Pembayaran Batch
            </CardTitle>
            <CardDescription>
              Tandai batch sebagai dibayar setelah transfer bank selesai dilakukan.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selectedBatch ? (
              <p className="text-sm text-muted-foreground">
                Pilih batch pencairan dari daftar untuk mencatat referensi transfer.
              </p>
            ) : (
              <form onSubmit={handleMarkPaidSubmit} className="space-y-3">
                <div className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-foreground">
                      {selectedBatch.payoutPeriodKey}
                    </span>
                    <Badge variant="outline" className="tabular-nums">
                      v{selectedBatch.version}
                    </Badge>
                  </div>
                  <p className="text-foreground">{selectedBatch.affiliateEmail}</p>
                  <p className="text-sm font-bold text-primary tabular-nums">
                    {formatIdr(selectedBatch.totalAmountIdr)}
                  </p>
                  <p className="font-mono text-muted-foreground">
                    {selectedBatch.payoutBankCode} · {selectedBatch.payoutAccountMasked} (
                    {selectedBatch.payoutAccountHolder})
                  </p>
                </div>

                {selectedBatch.status === "paid" ? (
                  <Alert variant="info">
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    <AlertTitle>Batch sudah dibayar</AlertTitle>
                    <AlertDescription>
                      Referensi: <span className="font-mono">{selectedBatch.transferReference}</span>{" "}
                      ({formatDateId(selectedBatch.paidAt)})
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label
                        htmlFor="mark-paid-transfer-ref"
                        className="block text-sm font-medium text-foreground"
                      >
                        Referensi Transfer Bank
                      </label>
                      <Input
                        id="mark-paid-transfer-ref"
                        type="text"
                        value={transferReference}
                        onChange={(e) => setTransferReference(e.target.value)}
                        placeholder="Contoh: TRF-BCA-20261215-001"
                        required
                        minLength={3}
                        className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label
                        htmlFor="mark-paid-reason"
                        className="block text-sm font-medium text-foreground"
                      >
                        Alasan Audit Operator (min. 10 karakter)
                      </label>
                      <Input
                        id="mark-paid-reason"
                        type="text"
                        value={markPaidReason}
                        onChange={(e) => setMarkPaidReason(e.target.value)}
                        placeholder="Transfer bank manual periode 15 Desember telah terkonfirmasi"
                        required
                        minLength={10}
                        className="min-h-11 text-base md:min-h-9 md:text-sm"
                      />
                    </div>

                    <Button
                      type="submit"
                      disabled={markPaidSubmitting || !isSuperadmin}
                      data-testid="console-mark-paid-submit"
                      className="min-h-11 w-full md:min-h-9"
                    >
                      {markPaidSubmitting ? "Menyimpan..." : "Tandai Batch Dibayar"}
                    </Button>
                  </>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
