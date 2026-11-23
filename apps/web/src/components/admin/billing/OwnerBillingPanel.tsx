import * as React from "react";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowLeftIcon,
  Building2Icon,
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CreditCardIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type { BillingPlanInterval } from "@punyasitus/core/billing/index";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  OWNER_NON_PKP_DISCLOSURE,
  OWNER_NO_REFUND_DISCLOSURE,
  buildBillingIdempotencyScopeKey,
  clearAllTenantBillingIdempotencyKeys,
  clearIdempotencyKey,
  computeCheckoutBreakdown,
  filterOwnerAllowedChannels,
  formatCountdownRemaining,
  formatIdr,
  formatWibDate,
  formatWibDateTime,
  getAttemptStateBadgeMeta,
  getObligationStateBadgeMeta,
  getOrCreateIdempotencyKey,
  getSafeAutoLarisRedirectHref,
  getTenantStatusIndonesianLabel,
  inspectPaymentReturnQueryParams,
  renderQrisSvgSafely,
  resolveOwnerBillingVisualState,
  type OwnerBillingAttemptDto,
  type OwnerBillingChannelDto,
  type OwnerBillingObligationDto,
  type OwnerBillingOverviewDto,
} from "./helpers";

export interface OwnerBillingPanelProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly primaryHost: string;
  readonly initialOverview: OwnerBillingOverviewDto;
  readonly initialNowMs: number;
  readonly isPaymentOnlyShell: boolean;
  readonly initialReturnClaim?: boolean;
  /** Optional verified leads CSV export URL (rendered only when route is wired & provided). */
  readonly leadsExportUrl?: string | null;
}

interface BillingApiErrorShape {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
  readonly code?: string;
  readonly message?: string;
}

/**
 * Owner-only Subscription Billing & Payment Recovery View
 * (TASK-057; REQ-058, PLAN §16–17, DESIGN §9–11).
 *
 * Hard invariants:
 * - Pre-creation mandatory disclosures (no-refund policy + non-PKP "belum termasuk PPN")
 *   are ALWAYS visibly rendered BEFORE any payment attempt is created.
 * - Renders strictly validated QRIS & Bank Virtual Account channels only.
 * - Reuses existing active pending instruction (QRIS SVG + readable/copyable alternative,
 *   VA copyable number + expiry countdown, or approved AutoLaris redirect) without creating duplicates.
 * - Refresh, back-button, and rapid double-clicks reuse deterministic per-obligation
 *   `Idempotency-Key` (sessionStorage) + synchronous `inFlightRef` lock so a second charge
 *   can never be created.
 * - Query params like `?status=paid&paid=1&return=success` NEVER activate service or fake "Aktif".
 * - Covers all 6 states clearly (`pending`, `creation_unknown`, `expired`, `paid`, `review`, `provider_outage`)
 *   with `aria-live="polite"` / `role="alert"` announcements.
 * - Base UI (`@base-ui/react`) primitives only (`base-nova` preset).
 */
export function OwnerBillingPanel({
  tenantId,
  handle,
  tenantName,
  primaryHost,
  initialOverview,
  initialNowMs,
  isPaymentOnlyShell,
  initialReturnClaim = false,
  leadsExportUrl = null,
}: OwnerBillingPanelProps) {
  const [overview, setOverview] = React.useState<OwnerBillingOverviewDto>(initialOverview);
  const [nowMs, setNowMs] = React.useState<number>(initialNowMs);
  const [selectedPlan, setSelectedPlan] = React.useState<BillingPlanInterval>(
    initialOverview.activeObligation?.plan ?? "monthly",
  );

  const allowedChannels = React.useMemo(
    () => filterOwnerAllowedChannels(overview.channels),
    [overview.channels],
  );

  const [selectedChannelCode, setSelectedChannelCode] = React.useState<string>(() => {
    const firstAllowed = filterOwnerAllowedChannels(initialOverview.channels)[0];
    return initialOverview.activeAttempt?.channelCode ?? firstAllowed?.code ?? "";
  });

  const [providerOutage, setProviderOutage] = React.useState<boolean>(
    Boolean(initialOverview.providerOutage),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = React.useState<string>("");
  const [actionError, setActionError] = React.useState<{
    readonly code: string;
    readonly message: string;
  } | null>(null);
  const [hasReturnClaim, setHasReturnClaim] = React.useState<boolean>(initialReturnClaim);

  // Synchronous double-click / double-submit lock (prevents race before React re-render)
  const inFlightRef = React.useRef<boolean>(false);

  // Sync selected channel if channels arrive after reload/retry
  React.useEffect(() => {
    if (!selectedChannelCode && allowedChannels[0]) {
      setSelectedChannelCode(allowedChannels[0].code);
    } else if (
      selectedChannelCode &&
      allowedChannels.length > 0 &&
      !allowedChannels.some((ch) => ch.code === selectedChannelCode)
    ) {
      setSelectedChannelCode(allowedChannels[0]?.code ?? "");
    }
  }, [allowedChannels, selectedChannelCode]);

  // Detect browser payment-return query params (`?status=paid&paid=1&return=success`):
  // NEVER activate service; show non-activation notice & verify authoritative status from server!
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const inspected = inspectPaymentReturnQueryParams(window.location.search);
    if (inspected.hasPaymentReturnClaim) {
      setHasReturnClaim(true);
      setStatusAnnouncement(
        "Kembali dari halaman pembayaran. Status layanan hanya diperbarui setelah konfirmasi resmi dari server.",
      );
      void refreshOverviewFromServer(false);
    }
  }, []);

  // Tick expiry countdown every second only while an active pending attempt has an expiry timestamp
  const activeAttemptExpiresAt = overview.activeAttempt?.expiresAt ?? null;
  const activeAttemptState = overview.activeAttempt?.state ?? null;
  React.useEffect(() => {
    if (activeAttemptState !== "pending" || !activeAttemptExpiresAt) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeAttemptState, activeAttemptExpiresAt]);

  const selectedChannel: OwnerBillingChannelDto | null = React.useMemo(
    () => allowedChannels.find((ch) => ch.code === selectedChannelCode) ?? allowedChannels[0] ?? null,
    [allowedChannels, selectedChannelCode],
  );

  const breakdown = React.useMemo(
    () =>
      computeCheckoutBreakdown({
        plan: selectedPlan,
        pricingPlans: overview.pricingPlans,
        selectedChannel,
        tenantStatus: overview.tenantStatus,
        paidThroughIso: overview.paidThrough,
        trialEndsAtIso: overview.trialEndsAt,
        nowMs,
      }),
    [
      selectedPlan,
      overview.pricingPlans,
      selectedChannel,
      overview.tenantStatus,
      overview.paidThrough,
      overview.trialEndsAt,
      nowMs,
    ],
  );

  const visualState = React.useMemo(
    () =>
      resolveOwnerBillingVisualState({
        tenantStatus: overview.tenantStatus,
        operatorHold: overview.operatorHold,
        paidThroughIso: overview.paidThrough,
        nowMs,
        activeObligation: overview.activeObligation,
        activeAttempt: overview.activeAttempt,
        obligations: overview.obligations,
        providerOutage,
        channelsCount: allowedChannels.length,
      }),
    [
      overview.tenantStatus,
      overview.operatorHold,
      overview.paidThrough,
      nowMs,
      overview.activeObligation,
      overview.activeAttempt,
      overview.obligations,
      providerOutage,
      allowedChannels.length,
    ],
  );

  // Never keep stale sessionStorage idempotency keys after settlement or after an obligation closes
  const latestObligationState = overview.obligations[0]?.state ?? null;
  React.useEffect(() => {
    if (
      visualState === "paid" ||
      (overview.activeObligation === null &&
        (latestObligationState === "paid" ||
          latestObligationState === "expired" ||
          latestObligationState === "cancelled"))
    ) {
      clearAllTenantBillingIdempotencyKeys(tenantId);
    }
  }, [tenantId, visualState, overview.activeObligation, latestObligationState]);

  const hasBlockingUnresolvedAttempt =
    overview.activeAttempt !== null &&
    (overview.activeAttempt.state === "pending" ||
      overview.activeAttempt.state === "creating" ||
      overview.activeAttempt.state === "creation_unknown" ||
      overview.activeAttempt.state === "review");

  const canCreateNewAttempt =
    !hasBlockingUnresolvedAttempt &&
    overview.activeObligation?.state !== "review" &&
    selectedChannel !== null;

  const activeQrisRender = React.useMemo(() => {
    if (!overview.activeAttempt?.qrisPayload) return null;
    return renderQrisSvgSafely(overview.activeAttempt.qrisPayload);
  }, [overview.activeAttempt?.qrisPayload]);

  const activeCountdown = React.useMemo(
    () => formatCountdownRemaining(overview.activeAttempt?.expiresAt ?? null, nowMs),
    [overview.activeAttempt?.expiresAt, nowMs],
  );

  async function refreshOverviewFromServer(announce = true) {
    setRefreshing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/billing`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status >= 500) {
          setProviderOutage(true);
          setStatusAnnouncement(
            "Penyedia pembayaran atau server tagihan sedang mengalami gangguan sementara. Coba muat ulang beberapa saat lagi.",
          );
          return;
        }
        const errBody = (await res.json().catch(() => ({}))) as BillingApiErrorShape;
        setActionError({
          code: errBody.error?.code ?? errBody.code ?? `HTTP_${res.status}`,
          message:
            errBody.error?.message ??
            errBody.message ??
            "Gagal memuat pembaruan status tagihan dari server.",
        });
        return;
      }

      const data = (await res.json()) as Partial<OwnerBillingOverviewDto>;
      const nextChannels = Array.isArray(data.channels) ? data.channels : overview.channels;
      const nextOutage =
        data.providerOutage === true ||
        (Array.isArray(data.channels) &&
          data.channels.length === 0 &&
          !data.activeAttempt &&
          overview.channels.length === 0);

      setOverview((prev) => ({
        ...prev,
        tenantStatus: data.tenantStatus ?? prev.tenantStatus,
        operatorHold: data.operatorHold ?? prev.operatorHold,
        operatorHoldReason:
          data.operatorHoldReason !== undefined
            ? data.operatorHoldReason
            : prev.operatorHoldReason,
        trialEndsAt: data.trialEndsAt !== undefined ? data.trialEndsAt : prev.trialEndsAt,
        paidThrough: data.paidThrough !== undefined ? data.paidThrough : prev.paidThrough,
        graceEndsAt: data.graceEndsAt !== undefined ? data.graceEndsAt : prev.graceEndsAt,
        lockedEndsAt: data.lockedEndsAt !== undefined ? data.lockedEndsAt : prev.lockedEndsAt,
        deletionDueAt: data.deletionDueAt !== undefined ? data.deletionDueAt : prev.deletionDueAt,
        activeObligation:
          data.activeObligation !== undefined ? data.activeObligation : prev.activeObligation,
        activeAttempt: data.activeAttempt !== undefined ? data.activeAttempt : prev.activeAttempt,
        obligations: Array.isArray(data.obligations) ? data.obligations : prev.obligations,
        pricingPlans: Array.isArray(data.pricingPlans) ? data.pricingPlans : prev.pricingPlans,
        channels: nextChannels,
        taxNotice: data.taxNotice ?? prev.taxNotice,
        noRefundNotice: data.noRefundNotice ?? prev.noRefundNotice,
        providerOutage: nextOutage,
      }));
      setProviderOutage(nextOutage);
      setNowMs(Date.now());
      if (announce) {
        setStatusAnnouncement("Status tagihan terbaru berhasil dimuat dari server.");
      }
    } catch {
      setProviderOutage(true);
      setStatusAnnouncement(
        "Koneksi terputus saat memeriksa status tagihan. Tidak ada tagihan baru yang dibuat.",
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCreatePaymentInstruction(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current || submitting || !canCreateNewAttempt || !selectedChannel) {
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    setActionError(null);

    const scopeKey = buildBillingIdempotencyScopeKey({
      tenantId,
      obligationId: overview.activeObligation?.obligationId ?? null,
      latestObligationId: overview.obligations[0]?.obligationId ?? null,
      paidThroughIso: overview.paidThrough,
      plan: selectedPlan,
      channelCode: selectedChannel.code,
    });

    // If previous attempt on this obligation authoritatively closed (expired/failed), rotate key safely
    if (
      overview.activeAttempt &&
      (overview.activeAttempt.state === "expired" || overview.activeAttempt.state === "failed")
    ) {
      clearIdempotencyKey(scopeKey);
    }

    const idempotencyKey = getOrCreateIdempotencyKey(scopeKey);

    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(tenantId)}/billing/obligations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            plan: selectedPlan,
            channelKind: selectedChannel.kind,
            channelCode: selectedChannel.code,
          }),
        },
      );

      const payload = (await res.json().catch(() => ({}))) as {
        readonly obligation?: OwnerBillingObligationDto;
        readonly attempt?: OwnerBillingAttemptDto;
        readonly replayed?: boolean;
      } & BillingApiErrorShape;

      if (!res.ok) {
        if (res.status >= 500) {
          setProviderOutage(true);
          setActionError({
            code: payload.error?.code ?? "PROVIDER_UNAVAILABLE",
            message:
              payload.error?.message ??
              "Penyedia pembayaran sedang mengalami gangguan sementara. Silakan muat ulang status sebelum mencoba kembali agar tidak terjadi tagihan ganda.",
          });
          setStatusAnnouncement(
            "Gangguan sementara penyedia pembayaran. Memeriksa status tagihan dari server.",
          );
          await refreshOverviewFromServer(false);
          return;
        }

        if (res.status === 409) {
          const conflictCode = payload.error?.code ?? payload.code ?? "CONFLICT";
          if (
            conflictCode === "IDEMPOTENCY_KEY_EXHAUSTED" ||
            conflictCode === "IDEMPOTENCY_CONFLICT"
          ) {
            // Clear stale/exhausted key so the owner's next click mints a clean fresh UUID
            clearIdempotencyKey(scopeKey);
            setActionError({
              code: conflictCode,
              message:
                "Kunci idempoten sebelumnya sudah ditutup dan telah diperbarui otomatis. Silakan klik tombol buat instruksi sekali lagi.",
            });
            await refreshOverviewFromServer(false);
            return;
          }
          // Existing active/reconciling attempt on server — refresh to show authoritative instruction!
          setActionError({
            code: conflictCode,
            message:
              payload.error?.message ??
              "Instruksi pembayaran untuk tagihan ini sudah ada atau sedang direkonsiliasi.",
          });
          await refreshOverviewFromServer(false);
          return;
        }

        setActionError({
          code: payload.error?.code ?? `HTTP_${res.status}`,
          message:
            payload.error?.message ?? "Gagal membuat instruksi pembayaran. Periksa pilihan Anda.",
        });
        return;
      }

      if (payload.obligation && payload.attempt) {
        const createdObligation = payload.obligation;
        const createdAttempt = payload.attempt;
        if (createdAttempt.state === "paid" || createdObligation.state === "paid") {
          clearAllTenantBillingIdempotencyKeys(tenantId);
        }
        setProviderOutage(false);
        setOverview((prev) => {
          const withoutDup = prev.obligations.filter(
            (o) => o.obligationId !== createdObligation.obligationId,
          );
          return {
            ...prev,
            activeObligation: createdObligation,
            activeAttempt: createdAttempt,
            obligations: [createdObligation, ...withoutDup],
          };
        });
        setNowMs(Date.now());
        setStatusAnnouncement(
          payload.replayed
            ? "Instruksi pembayaran aktif sebelumnya ditampilkan kembali tanpa membuat tagihan ganda."
            : `Instruksi pembayaran ${createdAttempt.channelCode} berhasil dibuat. Selesaikan pembayaran sebelum batas waktu.`,
        );
      } else {
        await refreshOverviewFromServer(true);
      }
    } catch {
      setProviderOutage(true);
      setActionError({
        code: "NETWORK_ERROR",
        message:
          "Koneksi terputus saat menghubungi server pembayaran. Jangan membuat tagihan ganda — periksa status dari server terlebih dahulu.",
      });
      setStatusAnnouncement(
        "Koneksi terputus saat membuat instruksi pembayaran. Periksa status dari server.",
      );
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleCopyText(field: string, value: string, label: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
      setCopiedField(field);
      setStatusAnnouncement(`${label} berhasil disalin ke papan klip.`);
      window.setTimeout(() => {
        setCopiedField((cur) => (cur === field ? null : cur));
      }, 2500);
    } catch {
      setStatusAnnouncement(`Gagal menyalin ${label} otomatis. Salin secara manual dari kotak teks.`);
    }
  }

  const statusLabel = getTenantStatusIndonesianLabel(overview.tenantStatus, overview.operatorHold);
  const monthlyPlan = overview.pricingPlans.find((p) => p.plan === "monthly");
  const yearlyPlan = overview.pricingPlans.find((p) => p.plan === "yearly");
  const qrisChannels = allowedChannels.filter((ch) => ch.kind === "QRIS");
  const vaChannels = allowedChannels.filter((ch) => ch.kind === "VA");

  return (
    <div
      className="space-y-6"
      data-testid="owner-billing-panel"
      data-visual-state={visualState}
      data-tenant-status={overview.tenantStatus}
      data-operator-hold={overview.operatorHold ? "true" : "false"}
      data-payment-only-shell={isPaymentOnlyShell ? "true" : "false"}
    >
      {/* Screen-reader live announcement region (WCAG 2.2 AA) */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="billing-live-announcer"
      >
        {statusAnnouncement}
      </div>

      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                overview.operatorHold ||
                overview.tenantStatus === "locked" ||
                overview.tenantStatus === "suspended"
                  ? "destructive"
                  : overview.tenantStatus === "active"
                    ? "success"
                    : overview.tenantStatus === "grace"
                      ? "warning"
                      : "info"
              }
              data-testid="billing-tenant-status-badge"
            >
              {statusLabel}
            </Badge>
            <span className="truncate font-mono text-xs text-muted-foreground">{primaryHost}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Tagihan &amp; Pemulihan Langganan
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola perpanjangan langganan khusus Pemilik Situs untuk{" "}
            <strong className="text-foreground">{tenantName}</strong>. Pembayaran bersifat atas
            inisiatif pemilik — tidak ada debit otomatis.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="outline"
            disabled={refreshing}
            onClick={() => refreshOverviewFromServer(true)}
            className="min-h-11 w-full sm:w-auto md:min-h-9"
            data-testid="billing-refresh-status-btn"
          >
            <RefreshCwIcon
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>{refreshing ? "Memeriksa..." : "Periksa Status Server"}</span>
          </Button>
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
        </div>
      </div>

      {/* Payment-Return Non-Activation Notice (when browser returned with ?status=paid etc.) */}
      {hasReturnClaim && (
        <Alert
          variant="info"
          role="status"
          aria-live="polite"
          data-testid="billing-return-non-activation-notice"
        >
          <InfoIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Kembali dari halaman pembayaran — verifikasi hanya dari server</AlertTitle>
          <AlertDescription>
            Parameter URL seperti <code className="font-mono">status=paid</code> tidak pernah
            mengaktifkan layanan secara otomatis. Status langganan saat ini di server:{" "}
            <strong className="text-foreground">{statusLabel}</strong>. Gunakan tombol{" "}
            <strong>Periksa Status Server</strong> untuk memuat konfirmasi resmi dari rekonsiliasi
            Advice.
          </AlertDescription>
        </Alert>
      )}

      {/* Operator Hold Notice (if applicable) */}
      {overview.operatorHold && (
        <Alert variant="destructive" role="alert" data-testid="billing-operator-hold-alert">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Situs dalam penahanan manual oleh operator platform</AlertTitle>
          <AlertDescription>
            {overview.operatorHoldReason
              ? `Alasan penahanan: ${overview.operatorHoldReason}. `
              : ""}
            Menyelesaikan pembayaran langganan tetap mencatat masa aktif Anda, tetapi penahanan
            operator tidak otomatis dicabut oleh pembayaran dan memerlukan peninjauan tim platform.
          </AlertDescription>
        </Alert>
      )}

      {/* Explicit State Announcements for All 6 Lifecycle/Payment States */}
      {visualState === "paid" && overview.tenantStatus === "active" && !overview.operatorHold && (
        <Alert variant="success" role="status" aria-live="polite" data-testid="billing-state-paid">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Pembayaran Terverifikasi — Langganan Aktif</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Server telah memverifikasi penyelesaian pembayaran Anda.
              {overview.paidThrough
                ? ` Masa aktif layanan berlaku hingga ${formatWibDateTime(overview.paidThrough)}.`
                : ""}
              {overview.operatorHold
                ? " Catatan: penahanan manual operator masih aktif dan perlu peninjauan dukungan."
                : ""}
            </p>
            {!overview.operatorHold && (
              <div className="pt-1">
                <Button
                  size="default"
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  render={<a href={`/dashboard/${encodeURIComponent(handle)}`} />}
                  data-testid="billing-paid-return-dashboard-cta"
                >
                  <CheckCircle2Icon className="size-4" aria-hidden="true" />
                  <span>Kembali ke Beranda Situs</span>
                </Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {visualState === "creation_unknown" && (
        <Alert
          variant="warning"
          role="alert"
          aria-live="polite"
          data-testid="billing-state-creation-unknown"
        >
          <ClockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Rekonsiliasi pembayaran sedang berjalan</AlertTitle>
          <AlertDescription>
            Permintaan instruksi pembayaran sebelumnya tidak menerima konfirmasi final sebelum batas
            waktu. Untuk mencegah tagihan ganda, pembuatan pembayaran baru dikunci sementara hingga
            server menyelesaikan rekonsiliasi.
            {overview.activeAttempt?.reffId ? (
              <span className="mt-1 block font-mono text-xs">
                Referensi tersimpan: {overview.activeAttempt.reffId}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {visualState === "review" && (
        <Alert
          variant="destructive"
          role="alert"
          aria-live="polite"
          data-testid="billing-state-review"
        >
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Transaksi memerlukan verifikasi operator platform</AlertTitle>
          <AlertDescription>
            Tagihan aktif ditandai untuk peninjauan anomali oleh operator platform. Pembuatan
            instruksi baru dinonaktifkan sementara untuk mencegah pembayaran ganda. Hubungi dukungan
            dengan menyertakan nomor referensi tagihan di bawah.
          </AlertDescription>
        </Alert>
      )}

      {visualState === "expired" && (
        <Alert
          variant="warning"
          role="status"
          aria-live="polite"
          data-testid="billing-state-expired"
        >
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Instruksi pembayaran sebelumnya kedaluwarsa</AlertTitle>
          <AlertDescription>
            Instruksi pembayaran terakhir telah melewati batas waktu tanpa penyelesaian. Anda aman
            memilih saluran QRIS atau Virtual Account di bawah untuk membuat instruksi pembayaran
            baru.
          </AlertDescription>
        </Alert>
      )}

      {visualState === "provider_outage" && (
        <Alert
          variant="warning"
          role="alert"
          aria-live="polite"
          data-testid="billing-state-provider-outage"
        >
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Penyedia pembayaran sementara tidak dapat dijangkau</AlertTitle>
          <AlertDescription className="space-y-2.5">
            <p>
              Daftar saluran QRIS dan Virtual Account dari penyedia pembayaran sedang tidak tersedia
              sementara. Tidak ada tagihan baru yang dibuat. Silakan coba muat ulang beberapa saat
              lagi.
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={() => refreshOverviewFromServer(true)}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="billing-outage-retry-btn"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                <span>Coba Muat Ulang Saluran</span>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive" role="alert" data-testid="billing-action-error-alert">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Permintaan tidak dapat diselesaikan ({actionError.code})</AlertTitle>
          <AlertDescription>{actionError.message}</AlertDescription>
        </Alert>
      )}

      {/* MANDATORY PRE-CREATION DISCLOSURES — ALWAYS VISIBLE BEFORE CREATING ANY ATTEMPT */}
      <Card data-testid="billing-mandatory-disclosures">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <InfoIcon className="size-4 text-primary" aria-hidden="true" />
            <span>Ketentuan Pembayaran &amp; Pajak (Wajib Dibaca Sebelum Membayar)</span>
          </CardTitle>
          <CardDescription>
            Berlaku untuk seluruh transaksi langganan platform PunyaSitus.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 pt-4 md:grid-cols-2">
          <div
            className="rounded-lg border border-warning-border bg-warning-soft/70 p-3.5 text-sm"
            data-testid="billing-no-refund-disclosure"
          >
            <p className="font-semibold text-warning">Kebijakan Tanpa Pengembalian Dana</p>
            <p className="mt-1 text-foreground/90">{OWNER_NO_REFUND_DISCLOSURE}</p>
          </div>
          <div
            className="rounded-lg border border-border bg-muted/40 p-3.5 text-sm"
            data-testid="billing-non-pkp-disclosure"
          >
            <p className="font-semibold text-foreground">Status Pajak (Non-PKP)</p>
            <p className="mt-1 text-muted-foreground">
              {overview.taxNotice || OWNER_NON_PKP_DISCLOSURE}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Lifecycle Deadlines & Leads Export Recovery Strip (for locked/suspended owners) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Aktif Hingga</CardDescription>
            <CardTitle className="text-base tabular-nums" data-testid="billing-paid-through-value">
              {formatWibDateTime(overview.paidThrough)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {overview.trialEndsAt && !overview.paidThrough
              ? `Batas uji coba: ${formatWibDateTime(overview.trialEndsAt)}`
              : "Periode kalender berdasar server"}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Batas Masa Tenggang (H+4)</CardDescription>
            <CardTitle className="text-base tabular-nums">
              {formatWibDateTime(overview.graceEndsAt)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            CMS beralih ke mode baca saja setelah H+4
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Batas Penangguhan (H+8)</CardDescription>
            <CardTitle className="text-base tabular-nums">
              {formatWibDateTime(overview.lockedEndsAt)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Situs publik tetap live hingga H+7 untuk menjaga SEO
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Batas Retensi Data</CardDescription>
            <CardTitle className="text-base tabular-nums">
              {formatWibDateTime(overview.deletionDueAt)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {isPaymentOnlyShell && leadsExportUrl ? (
              <a
                href={leadsExportUrl}
                className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4"
                data-testid="billing-leads-export-link"
              >
                <DownloadIcon className="size-3.5" aria-hidden="true" />
                <span>Ekspor Prospek (CSV)</span>
              </a>
            ) : (
              "Data konten, prospek, dan draf tetap tersimpan aman hingga batas retensi"
            )}
          </CardContent>
        </Card>
      </div>

      {/* ACTIVE PENDING INSTRUCTION REUSE PANEL (QRIS SVG + readable alt / VA copy / approved redirect) */}
      {overview.activeAttempt &&
        (overview.activeAttempt.state === "pending" ||
          overview.activeAttempt.state === "creating") && (
          <Card
            className="border-primary/40"
            data-testid="billing-active-instruction-card"
            data-channel-kind={overview.activeAttempt.channelKind}
          >
            <CardHeader className="border-b border-border pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                  {overview.activeAttempt.channelKind === "QRIS" ? (
                    <QrCodeIcon className="size-5 text-primary" aria-hidden="true" />
                  ) : (
                    <Building2Icon className="size-5 text-primary" aria-hidden="true" />
                  )}
                  <span>
                    Instruksi Pembayaran Aktif ({overview.activeAttempt.channelCode})
                  </span>
                </CardTitle>
                <Badge variant={getAttemptStateBadgeMeta(overview.activeAttempt.state).variant}>
                  {getAttemptStateBadgeMeta(overview.activeAttempt.state).label}
                </Badge>
              </div>
              <CardDescription>
                Instruksi ini sedang aktif dan digunakan ulang otomatis agar tidak terjadi tagihan
                ganda. Selesaikan pembayaran sesuai nominal tepat di bawah.
              </CardDescription>
            </CardHeader>

            <CardContent className="grid grid-cols-1 gap-6 pt-5 lg:grid-cols-12">
              {/* Left: QRIS SVG + Readable Alt OR Virtual Account Copy Box */}
              <div className="space-y-4 lg:col-span-7">
                {overview.activeAttempt.channelKind === "QRIS" &&
                  overview.activeAttempt.qrisPayload && (
                    <div
                      className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
                      data-testid="billing-qris-instruction"
                    >
                      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                        {activeQrisRender?.svg ? (
                          <div
                            className="shrink-0 overflow-hidden rounded-lg border border-border bg-white p-2.5"
                            data-testid="billing-qris-svg-container"
                            dangerouslySetInnerHTML={{ __html: activeQrisRender.svg }}
                          />
                        ) : (
                          <div className="flex size-56 shrink-0 items-center justify-center rounded-lg border border-border bg-card p-4 text-center text-xs text-muted-foreground">
                            Kode QR terlalu panjang untuk dirender langsung; gunakan kode QRIS
                            salin di samping.
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-2 text-sm">
                          <p className="font-semibold text-foreground">
                            Pindai kode QRIS dari aplikasi mobile banking atau e-wallet Anda
                          </p>
                          <p className="text-muted-foreground">
                            Pastikan nama merchant dan nominal akhir cocok sebelum mengonfirmasi
                            pembayaran. Jangan mengedit nominal pembayaran.
                          </p>
                          <dl
                            className="space-y-1 rounded-md border border-border bg-card p-3 text-xs"
                            data-testid="billing-qris-readable-alternative"
                          >
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Metode</dt>
                              <dd className="font-medium text-foreground">
                                QRIS ({overview.activeAttempt.channelCode})
                              </dd>
                            </div>
                            {activeQrisRender?.summary.merchantName && (
                              <div className="flex justify-between gap-2">
                                <dt className="text-muted-foreground">Merchant</dt>
                                <dd className="font-medium text-foreground">
                                  {activeQrisRender.summary.merchantName}
                                </dd>
                              </div>
                            )}
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Total Tepat</dt>
                              <dd className="font-semibold text-foreground tabular-nums">
                                {formatIdr(overview.activeAttempt.totalPayableIdr)}
                              </dd>
                            </div>
                            {activeQrisRender?.summary.crc && (
                              <div className="flex justify-between gap-2">
                                <dt className="text-muted-foreground">Checksum EMVCo</dt>
                                <dd className="font-mono text-foreground">
                                  {activeQrisRender.summary.crc}
                                </dd>
                              </div>
                            )}
                          </dl>
                        </div>
                      </div>

                      <div className="space-y-2 border-t border-border pt-3">
                        <label
                          htmlFor="qris-payload-copy-text"
                          className="block text-xs font-medium text-muted-foreground"
                        >
                          Alternatif teks / kode QRIS mentah (salin tanpa mengubah isi):
                        </label>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            id="qris-payload-copy-text"
                            type="text"
                            readOnly
                            value={overview.activeAttempt.qrisPayload}
                            className="h-11 min-w-0 flex-1 rounded-md border border-input bg-card px-3 font-mono text-xs text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9"
                            data-testid="billing-qris-payload-input"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              handleCopyText(
                                "qris",
                                overview.activeAttempt?.qrisPayload ?? "",
                                "Kode QRIS",
                              )
                            }
                            className="min-h-11 w-full sm:w-auto md:min-h-9"
                            data-testid="billing-copy-qris-btn"
                          >
                            {copiedField === "qris" ? (
                              <CheckIcon className="size-4 text-success" aria-hidden="true" />
                            ) : (
                              <CopyIcon className="size-4" aria-hidden="true" />
                            )}
                            <span>{copiedField === "qris" ? "Tersalin" : "Salin Kode QRIS"}</span>
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                {overview.activeAttempt.channelKind === "VA" && overview.activeAttempt.vaNumber && (
                  <div
                    className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
                    data-testid="billing-va-instruction"
                  >
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Nomor Virtual Account{" "}
                        {overview.activeAttempt.bankName
                          ? `— ${overview.activeAttempt.bankName}`
                          : overview.activeAttempt.channelCode}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p
                          className="break-all font-mono text-xl font-semibold tracking-wider text-foreground tabular-nums"
                          data-testid="billing-va-number-display"
                        >
                          {overview.activeAttempt.vaNumber}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            handleCopyText(
                              "va",
                              overview.activeAttempt?.vaNumber ?? "",
                              "Nomor Virtual Account",
                            )
                          }
                          className="min-h-11 w-full sm:w-auto md:min-h-9"
                          data-testid="billing-copy-va-btn"
                        >
                          {copiedField === "va" ? (
                            <CheckIcon className="size-4 text-success" aria-hidden="true" />
                          ) : (
                            <CopyIcon className="size-4" aria-hidden="true" />
                          )}
                          <span>{copiedField === "va" ? "Tersalin" : "Salin Nomor VA"}</span>
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Transfer melalui ATM, mobile banking, atau internet banking ke nomor Virtual
                      Account di atas dengan nominal tepat{" "}
                      <strong className="text-foreground tabular-nums">
                        {formatIdr(overview.activeAttempt.totalPayableIdr)}
                      </strong>
                      .
                    </p>
                  </div>
                )}

                {(() => {
                  const safeRedirectHref = getSafeAutoLarisRedirectHref(
                    overview.activeAttempt.paymentRedirectUrl,
                  );
                  if (!safeRedirectHref) return null;
                  return (
                    <div
                      className="rounded-lg border border-border bg-card p-3.5"
                      data-testid="billing-approved-redirect-box"
                    >
                      <p className="text-xs text-muted-foreground">
                        Halaman instruksi resmi AutoLaris tersedia jika Anda ingin membuka panduan
                        bank pada tab baru:
                      </p>
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          className="min-h-11 w-full sm:w-auto md:min-h-9"
                          render={
                            <a
                              href={safeRedirectHref}
                              target="_blank"
                              rel="noopener noreferrer"
                            />
                          }
                          data-testid="billing-approved-redirect-link"
                        >
                          <ExternalLinkIcon className="size-4" aria-hidden="true" />
                          <span>Buka Halaman Resmi AutoLaris</span>
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Right: Authoritative Server Cost Breakdown & Expiry Countdown */}
              <div className="space-y-4 lg:col-span-5">
                <div className="rounded-lg border border-border bg-card p-4 text-sm">
                  <p className="font-semibold text-foreground">Rincian Tagihan Aktif</p>
                  <dl className="mt-3 space-y-2 border-t border-border pt-3">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Referensi</dt>
                      <dd className="font-mono text-xs text-foreground">
                        {overview.activeAttempt.reffId}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Paket</dt>
                      <dd className="font-medium text-foreground">
                        {overview.activeAttempt.plan === "yearly" ? "Tahunan (12 bulan)" : "Bulanan (1 bulan)"}
                      </dd>
                    </div>
                    {overview.activeObligation?.periodStartAt &&
                      overview.activeObligation?.periodEndAt && (
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Periode Layanan</dt>
                          <dd className="text-right font-medium text-foreground tabular-nums">
                            {formatWibDate(overview.activeObligation.periodStartAt)} –{" "}
                            {formatWibDate(overview.activeObligation.periodEndAt)}
                          </dd>
                        </div>
                      )}
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Harga Pokok</dt>
                      <dd className="tabular-nums text-foreground">
                        {formatIdr(overview.activeAttempt.baseAmountIdr)}
                      </dd>
                    </div>
                    {overview.activeAttempt.discountAmountIdr > 0 && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Diskon</dt>
                        <dd className="tabular-nums text-success">
                          −{formatIdr(overview.activeAttempt.discountAmountIdr)}
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Biaya Saluran ({overview.activeAttempt.channelCode})</dt>
                      <dd className="tabular-nums text-foreground">
                        {formatIdr(overview.activeAttempt.channelFeeIdr)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-border pt-2 text-base font-semibold">
                      <dt className="text-foreground">Total Dibayar</dt>
                      <dd className="tabular-nums text-primary" data-testid="billing-active-total">
                        {formatIdr(overview.activeAttempt.totalPayableIdr)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-2.5 text-xs text-muted-foreground">
                    {overview.activeAttempt.taxNotice || OWNER_NON_PKP_DISCLOSURE}
                  </p>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Batas Waktu Pembayaran</span>
                    <span className="font-medium text-foreground tabular-nums">
                      {formatWibDateTime(overview.activeAttempt.expiresAt)}
                    </span>
                  </div>
                  {activeCountdown && (
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Sisa Waktu</span>
                      <span
                        className="font-mono font-semibold text-foreground tabular-nums"
                        data-testid="billing-expiry-countdown"
                      >
                        {activeCountdown}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs text-muted-foreground">
              <span>
                Status diperbarui otomatis setelah verifikasi Advice dari penyedia pembayaran.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={() => refreshOverviewFromServer(true)}
                className="min-h-11 w-full sm:w-auto md:min-h-8"
              >
                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                <span>Segarkan Status Pembayaran</span>
              </Button>
            </CardFooter>
          </Card>
        )}

      {/* PLAN & CHANNEL CHECKOUT CREATION FORM (only when no blocking unresolved attempt exists) */}
      {!hasBlockingUnresolvedAttempt && overview.activeObligation?.state !== "review" && (
        <form
          onSubmit={handleCreatePaymentInstruction}
          className="grid grid-cols-1 gap-6 lg:grid-cols-12"
          data-testid="billing-checkout-form"
        >
          {/* Left Column: Plan & Channel Selection */}
          <div className="space-y-5 lg:col-span-7">
            {/* Step 1: Plan Selector */}
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-base">1. Pilih Paket Langganan</CardTitle>
                <CardDescription>
                  Satu harga mencakup seluruh jenis penawaran (Layanan, Produk, Paket Tur,
                  Kendaraan), 5 anggota tim, dan 1 GB penyimpanan media.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSelectedPlan("monthly")}
                  disabled={submitting || Boolean(overview.activeObligation)}
                  aria-pressed={selectedPlan === "monthly"}
                  data-testid="billing-plan-monthly"
                  className={`flex min-h-11 flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    selectedPlan === "monthly"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border bg-card hover:bg-muted/50"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">Paket Bulanan</span>
                    <Badge variant={selectedPlan === "monthly" ? "default" : "outline"}>
                      1 Bulan
                    </Badge>
                  </div>
                  <p className="text-lg font-semibold text-foreground tabular-nums">
                    {formatIdr(monthlyPlan?.baseAmountIdr ?? 179_000)}
                    <span className="text-xs font-normal text-muted-foreground"> / bulan</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Perpanjangan fleksibel per bulan kalender.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedPlan("yearly")}
                  disabled={submitting || Boolean(overview.activeObligation)}
                  aria-pressed={selectedPlan === "yearly"}
                  data-testid="billing-plan-yearly"
                  className={`flex min-h-11 flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    selectedPlan === "yearly"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border bg-card hover:bg-muted/50"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">Paket Tahunan</span>
                    <Badge variant="success" data-testid="billing-yearly-savings-badge">
                      Hemat {formatIdr(breakdown.yearlySavingsIdr)}
                    </Badge>
                  </div>
                  <p className="text-lg font-semibold text-foreground tabular-nums">
                    {formatIdr(yearlyPlan?.baseAmountIdr ?? 1_790_000)}
                    <span className="text-xs font-normal text-muted-foreground"> / tahun</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    12 bulan kalender penuh — hemat 2 bulan.
                  </p>
                </button>
              </CardContent>
            </Card>

            {/* Step 2: Owner-Only QRIS & Bank Virtual Account Channels */}
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-base">
                  2. Pilih Metode Pembayaran (QRIS &amp; Virtual Account Bank)
                </CardTitle>
                <CardDescription>
                  Hanya saluran QRIS dan Virtual Account bank resmi yang diaktifkan. Biaya saluran
                  ditanggung pembayar dan ditampilkan terpisah.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-4">
                {allowedChannels.length === 0 ? (
                  <div
                    className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
                    data-testid="billing-channels-empty"
                  >
                    <p className="font-medium text-foreground">
                      Daftar saluran pembayaran belum tersedia saat ini.
                    </p>
                    <p className="mt-1">
                      Klik tombol <strong>Periksa Status Server</strong> untuk memuat ulang saluran
                      QRIS dan Virtual Account dari penyedia pembayaran.
                    </p>
                  </div>
                ) : (
                  <>
                    {qrisChannels.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          QRIS (Semua Bank &amp; E-Wallet)
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {qrisChannels.map((ch) => {
                            const active = selectedChannel?.code === ch.code;
                            return (
                              <button
                                key={ch.code}
                                type="button"
                                disabled={submitting}
                                aria-pressed={active}
                                onClick={() => setSelectedChannelCode(ch.code)}
                                data-testid={`billing-channel-${ch.code}`}
                                className={`flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                                  active
                                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                                    : "border-border bg-card hover:bg-muted/50"
                                }`}
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {ch.label}
                                  </p>
                                  <p className="text-xs text-muted-foreground">Kode: {ch.code}</p>
                                </div>
                                <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                                  +{formatIdr(ch.estimatedFeeIdr)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {vaChannels.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Virtual Account Bank
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {vaChannels.map((ch) => {
                            const active = selectedChannel?.code === ch.code;
                            return (
                              <button
                                key={ch.code}
                                type="button"
                                disabled={submitting}
                                aria-pressed={active}
                                onClick={() => setSelectedChannelCode(ch.code)}
                                data-testid={`billing-channel-${ch.code}`}
                                className={`flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                                  active
                                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                                    : "border-border bg-card hover:bg-muted/50"
                                }`}
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {ch.label}
                                  </p>
                                  <p className="text-xs text-muted-foreground">VA • {ch.code}</p>
                                </div>
                                <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                                  +{formatIdr(ch.estimatedFeeIdr)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right Column: Exact Pre-Creation Order Summary */}
          <div className="lg:col-span-5">
            <Card className="lg:sticky lg:top-20" data-testid="billing-checkout-summary-card">
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CreditCardIcon className="size-4 text-primary" aria-hidden="true" />
                  <span>Ringkasan Biaya &amp; Periode</span>
                </CardTitle>
                <CardDescription>
                  Nominal akhir ditetapkan oleh server sebelum instruksi dibuat.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4 text-sm">
                <dl className="space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">Paket</dt>
                    <dd className="text-right font-medium text-foreground">
                      {breakdown.planLabel}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-muted-foreground">Periode Layanan</dt>
                    <dd
                      className="text-right font-medium text-foreground tabular-nums"
                      data-testid="billing-summary-period"
                    >
                      {breakdown.periodRangeWibLabel}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
                    <dt className="text-muted-foreground">Harga Pokok</dt>
                    <dd
                      className="font-medium text-foreground tabular-nums"
                      data-testid="billing-summary-base-price"
                    >
                      {formatIdr(breakdown.baseAmountIdr)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">
                      Biaya Saluran ({selectedChannel?.label ?? "Belum dipilih"})
                    </dt>
                    <dd
                      className="font-medium text-foreground tabular-nums"
                      data-testid="billing-summary-channel-fee"
                    >
                      {formatIdr(breakdown.channelFeeIdr)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5 text-base font-semibold">
                    <dt className="text-foreground">Estimasi Total Bayar</dt>
                    <dd
                      className="text-primary tabular-nums"
                      data-testid="billing-summary-total"
                    >
                      {formatIdr(breakdown.totalPayableIdr)}
                    </dd>
                  </div>
                </dl>

                <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  {OWNER_NON_PKP_DISCLOSURE}
                </p>

                <Button
                  type="submit"
                  size="lg"
                  disabled={!canCreateNewAttempt || submitting}
                  className="min-h-11 w-full"
                  data-testid="billing-create-instruction-submit"
                >
                  <CreditCardIcon className="size-4" aria-hidden="true" />
                  <span>
                    {submitting
                      ? "Membuat instruksi pembayaran..."
                      : selectedChannel
                        ? `Buat Instruksi ${selectedChannel.kind === "QRIS" ? "QRIS" : selectedChannel.label}`
                        : "Saluran Pembayaran Tidak Tersedia"}
                  </span>
                </Button>
              </CardContent>
            </Card>
          </div>
        </form>
      )}

      {/* OBLIGATIONS HISTORY (Desktop Table + Mobile Card Stack for 0px Overflow at 360px) */}
      <Card data-testid="billing-obligations-history">
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-base">Riwayat Tagihan Langganan</CardTitle>
          <CardDescription>
            Catatan kewajiban langganan yang terverifikasi oleh server untuk situs ini.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {overview.obligations.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground" data-testid="billing-history-empty">
              Belum ada riwayat tagihan untuk situs ini.
            </p>
          ) : (
            <>
              {/* Mobile card stack (< md) */}
              <div className="space-y-3 md:hidden" data-testid="billing-history-mobile-list">
                {overview.obligations.map((obl) => {
                  const badge = getObligationStateBadgeMeta(obl.state);
                  return (
                    <div
                      key={obl.obligationId}
                      className="space-y-2 rounded-lg border border-border bg-card p-3.5 text-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground">
                            {obl.plan === "yearly" ? "Paket Tahunan" : "Paket Bulanan"}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {obl.obligationId}
                          </p>
                        </div>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Periode</span>
                        <span className="font-medium text-foreground tabular-nums">
                          {formatWibDate(obl.periodStartAt)} – {formatWibDate(obl.periodEndAt)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Pokok Tagihan</span>
                        <span className="font-semibold text-foreground tabular-nums">
                          {formatIdr(obl.netAmountIdr)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Dibuat: {formatWibDateTime(obl.createdAt)}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Desktop table (>= md) */}
              <div className="hidden md:block">
                <Table data-testid="billing-history-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID Tagihan</TableHead>
                      <TableHead>Paket</TableHead>
                      <TableHead>Periode Layanan (WIB)</TableHead>
                      <TableHead className="text-right">Nominal Pokok</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Dibuat</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.obligations.map((obl) => {
                      const badge = getObligationStateBadgeMeta(obl.state);
                      return (
                        <TableRow key={obl.obligationId}>
                          <TableCell className="font-mono text-xs">{obl.obligationId}</TableCell>
                          <TableCell className="font-medium">
                            {obl.plan === "yearly" ? "Tahunan (12 bln)" : "Bulanan (1 bln)"}
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            {formatWibDate(obl.periodStartAt)} – {formatWibDate(obl.periodEndAt)}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatIdr(obl.netAmountIdr)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            {formatWibDateTime(obl.createdAt)}
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
    </div>
  );
}
