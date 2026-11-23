import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  GTM_KILL_SWITCH_CATEGORY_LABELS_ID,
  GTM_KILL_SWITCH_REASON_CATEGORIES,
  type GtmKillSwitchReasonCategory,
} from "@punyasitus/core/analytics/gtm";
import type { ConsoleTenantGtmStatusDto } from "@punyasitus/db/analytics-settings/index";
import {
  AlertCircleIcon,
  BanIcon,
  CheckCircle2Icon,
  ShieldAlertIcon,
  TagIcon,
  XIcon,
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

export interface TenantGtmKillSwitchCardProps {
  readonly tenantId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly tenantVersion: number;
  readonly detailPath: string;
  readonly initialGtmStatus: ConsoleTenantGtmStatusDto | null;
  readonly onMutated: (message: string) => Promise<void>;
}

function createUuidKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `gtm-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatIsoWib(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  try {
    return `${new Date(parsed).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return iso;
  }
}

export function TenantGtmKillSwitchCard({
  tenantId,
  tenantHandle,
  tenantName,
  tenantVersion,
  detailPath,
  initialGtmStatus,
  onMutated,
}: TenantGtmKillSwitchCardProps) {
  const [gtmStatus, setGtmStatus] = React.useState<ConsoleTenantGtmStatusDto | null>(
    initialGtmStatus,
  );
  const [modalAction, setModalAction] = React.useState<"disable" | "lift" | null>(null);
  const [reasonCategory, setReasonCategory] = React.useState<GtmKillSwitchReasonCategory>("abuse");
  const [reason, setReason] = React.useState("");
  const [idempKey, setIdempKey] = React.useState(() => createUuidKey());
  const [submitting, setSubmitting] = React.useState(false);
  const [modalError, setModalError] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);

  React.useEffect(() => {
    setGtmStatus(initialGtmStatus);
  }, [initialGtmStatus]);

  async function refreshGtmStatus() {
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenantId)}/gtm`, {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        gtm?: ConsoleTenantGtmStatusDto;
      } | null;
      if (res.ok && data?.success && data.gtm) {
        setGtmStatus(data.gtm);
      }
    } catch {
      // non-fatal
    }
  }

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modalAction || submitting) return;

    setModalError(null);
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 10) {
      setModalError({
        code: "VALIDATION_ERROR",
        message: "Alasan operasional audit wajib diisi minimal 10 karakter (maksimal 500 karakter).",
      });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/console/tenants/${encodeURIComponent(tenantId)}/gtm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          action: modalAction,
          ...(modalAction === "disable" ? { reasonCategory } : {}),
          reason: trimmedReason,
          expectedVersion: tenantVersion,
          idempotencyKey: idempKey,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
        version?: number;
        killSwitch?: ConsoleTenantGtmStatusDto["killSwitch"];
      } | null;

      if (!res.ok || !data?.success) {
        setModalError({
          code: data?.code ?? `HTTP_${res.status}`,
          message: data?.message ?? "Gagal memproses kontrol GTM tenant.",
          verifyPath: data?.verifyPath,
        });
        return;
      }

      const doneAction = modalAction;
      setModalAction(null);
      setReason("");
      setIdempKey(createUuidKey());
      await refreshGtmStatus();
      await onMutated(
        doneAction === "disable"
          ? `Kill switch Google Tag Manager diaktifkan untuk "${tenantHandle}". Pemilik situs diberi notifikasi email; pelacak langsung tetap berjalan.`
          : `Pembatasan kill switch GTM untuk "${tenantHandle}" dicabut. GTM tetap nonaktif hingga pemilik situs mengaktifkannya kembali.`,
      );
    } catch {
      setModalError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mengirim perintah kill switch GTM. Coba lagi.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const isKilled = gtmStatus?.killSwitch.disabled === true;
  const isGtmActive = gtmStatus?.gtmEnabled === true && !isKilled;

  return (
    <Card data-testid="detail-gtm-kill-switch-card">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <TagIcon className="size-4 text-primary" aria-hidden="true" />
              Kontrol Google Tag Manager (Operator Kill Switch)
            </CardTitle>
            <CardDescription>
              Nonaktifkan GTM tenant secara instan dengan alasan audit (abuse, malware, atau
              performance). Pemilik situs diberi notifikasi email dan pelacak langsung (GA4/Meta/TikTok)
              tetap berjalan.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={isKilled ? "destructive" : isGtmActive ? "success" : "secondary"}
              data-testid="console-gtm-status-badge"
            >
              {isKilled
                ? "Dimatikan Operator (Kill Switch)"
                : isGtmActive
                  ? "GTM Aktif"
                  : "GTM Nonaktif"}
            </Badge>
            {isKilled ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setModalError(null);
                  setReason("");
                  setIdempKey(createUuidKey());
                  setModalAction("lift");
                }}
                className="min-h-11 w-full sm:w-auto md:min-h-8"
                data-testid="open-gtm-lift-modal-btn"
              >
                <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                Cabut Kill Switch GTM
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => {
                  setModalError(null);
                  setReason("");
                  setReasonCategory("abuse");
                  setIdempKey(createUuidKey());
                  setModalAction("disable");
                }}
                className="min-h-11 w-full sm:w-auto md:min-h-8"
                data-testid="open-gtm-disable-modal-btn"
              >
                <BanIcon className="size-3.5" aria-hidden="true" />
                Matikan GTM (Kill Switch)
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-4 text-sm">
        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">ID Kontainer GTM</dt>
            <dd className="font-mono font-semibold text-foreground" data-testid="console-gtm-container-id">
              {gtmStatus?.containerId ?? "Belum diatur"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Persetujuan Risiko Pemilik</dt>
            <dd className="text-foreground tabular-nums">
              {gtmStatus?.riskAck?.accepted
                ? `v${gtmStatus.riskAck.version} (${formatIsoWib(gtmStatus.riskAck.acceptedAt)})`
                : "Belum disetujui"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Pelacak Langsung Terkonfigurasi</dt>
            <dd className="text-foreground">
              {gtmStatus
                ? [
                    gtmStatus.directProvidersConfigured.ga4 ? "GA4" : null,
                    gtmStatus.directProvidersConfigured.meta ? "Meta" : null,
                    gtmStatus.directProvidersConfigured.tiktok ? "TikTok" : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || "Tidak ada"
                : "—"}
            </dd>
          </div>
        </dl>

        {isKilled && gtmStatus && (
          <Alert variant="destructive" data-testid="console-gtm-killed-alert">
            <ShieldAlertIcon className="size-4" aria-hidden="true" />
            <AlertTitle>
              Kill Switch GTM Aktif —{" "}
              {gtmStatus.killSwitch.reasonCategory
                ? GTM_KILL_SWITCH_CATEGORY_LABELS_ID[gtmStatus.killSwitch.reasonCategory]
                : "Operasional"}
            </AlertTitle>
            <AlertDescription>
              Alasan: {gtmStatus.killSwitch.reason ?? "Dicatat pada audit log platform."} · Sejak:{" "}
              {formatIsoWib(gtmStatus.killSwitch.disabledAt)}.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>

      {/* Audited GTM Kill Switch Modal (@base-ui/react/dialog) */}
      <Dialog.Root
        open={modalAction !== null}
        onOpenChange={(open) => {
          if (!open) setModalAction(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="gtm-kill-switch-modal"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold">
                  {modalAction === "disable"
                    ? "Matikan Google Tag Manager (Kill Switch)"
                    : "Cabut Pembatasan Kill Switch GTM"}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Tenant: <strong className="text-foreground">{tenantName}</strong> (@
                  {tenantHandle}) · Versi tenant: <span className="font-mono">v{tenantVersion}</span>
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup modal kill switch GTM"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
              {modalError && (
                <Alert variant="destructive" data-testid="gtm-kill-switch-modal-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Operasi ditolak ({modalError.code})</AlertTitle>
                  <AlertDescription className="space-y-1">
                    <p>{modalError.message}</p>
                    {modalError.verifyPath && (
                      <a
                        href={`${modalError.verifyPath}&next=${encodeURIComponent(detailPath)}`}
                        className="inline-block font-medium underline underline-offset-4"
                      >
                        Verifikasi ulang 2FA sekarang
                      </a>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {modalAction === "disable" && (
                <div className="space-y-1.5">
                  <label htmlFor="gtm-kill-category" className="block text-sm font-medium">
                    Kategori Alasan
                  </label>
                  <select
                    id="gtm-kill-category"
                    value={reasonCategory}
                    onChange={(e) =>
                      setReasonCategory(e.target.value as GtmKillSwitchReasonCategory)
                    }
                    disabled={submitting}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:h-9 md:text-sm"
                    data-testid="gtm-kill-category-select"
                  >
                    {GTM_KILL_SWITCH_REASON_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {GTM_KILL_SWITCH_CATEGORY_LABELS_ID[cat]}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    GTM akan segera dihentikan pada halaman publik tenant dan pemilik situs akan
                    menerima notifikasi email. Pelacak langsung (GA4/Meta/TikTok) tetap aktif.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="gtm-kill-reason" className="block text-sm font-medium">
                  Alasan Operasional Audit (10–500 karakter)
                </label>
                <Input
                  id="gtm-kill-reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={
                    modalAction === "disable"
                      ? "Contoh: Ditemukan skrip berbahaya pada kontainer GTM yang mengganggu situs publik"
                      : "Contoh: Pemilik situs telah membersihkan kontainer GTM dan diverifikasi tim operasional"
                  }
                  disabled={submitting}
                  required
                  data-testid="gtm-kill-reason-input"
                />
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={submitting}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  variant={modalAction === "disable" ? "destructive" : "default"}
                  disabled={submitting}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="gtm-kill-submit-btn"
                >
                  {submitting
                    ? "Memproses..."
                    : modalAction === "disable"
                      ? "Konfirmasi Matikan GTM"
                      : "Konfirmasi Cabut Kill Switch"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </Card>
  );
}
