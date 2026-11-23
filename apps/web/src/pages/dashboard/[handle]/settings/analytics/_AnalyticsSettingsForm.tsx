import * as React from "react";
import {
  ANALYTICS_PROVIDER_DESCRIPTORS,
  ANALYTICS_PROVIDER_EVENT_MAPPINGS,
  CANONICAL_SIGNAL_EVENTS,
  validateDirectAnalyticsInput,
  type DirectAnalyticsConfig,
} from "@punyasitus/core/analytics/providers";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  InfoIcon,
  LockIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GtmSetupSection, type GtmSettingsSnapshot } from "./_GtmSetupSection";
import {
  createDefaultGtmKillSwitchState,
  createDefaultVendorDeliveryModes,
} from "@punyasitus/core/analytics/gtm";

export interface AnalyticsSettingsSnapshot extends DirectAnalyticsConfig {
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface AnalyticsSettingsFormProps {
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly currentRole: string;
  readonly canEdit: boolean;
  readonly initialSettings: AnalyticsSettingsSnapshot;
  readonly initialGtmSettings?: GtmSettingsSnapshot;
  readonly initialLoadError?: string | null;
}

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly fields?: readonly {
      readonly field: string;
      readonly code: string;
      readonly message: string;
    }[];
  };
  readonly requestId?: string;
}

function formatDateTimeWib(iso: string | null): string {
  if (!iso) return "Belum pernah disimpan";
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

function getInlineHintStatus(
  field: "ga4MeasurementId" | "metaPixelId" | "tiktokPixelId",
  value: string,
): { readonly valid: boolean; readonly message: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const check = validateDirectAnalyticsInput({ [field]: trimmed });
  if (check.ok) {
    return { valid: true, message: "Format ID valid dan siap disimpan." };
  }
  const firstField = check.fields.find((f) => f.field === field) ?? check.fields[0];
  return {
    valid: false,
    message: firstField?.message ?? check.message,
  };
}

export function AnalyticsSettingsForm({
  handle,
  tenantName,
  tenantStatus,
  currentRole,
  canEdit,
  initialSettings,
  initialGtmSettings,
  initialLoadError = null,
}: AnalyticsSettingsFormProps) {
  const apiUrl = `/api/tenants/${encodeURIComponent(handle)}/analytics`;

  const [savedSnapshot, setSavedSnapshot] =
    React.useState<AnalyticsSettingsSnapshot>(initialSettings);
  const [gtmSnapshot, setGtmSnapshot] = React.useState<GtmSettingsSnapshot>(
    initialGtmSettings ?? {
      ga4MeasurementId: initialSettings.ga4MeasurementId,
      metaPixelId: initialSettings.metaPixelId,
      tiktokPixelId: initialSettings.tiktokPixelId,
      vendorModes: createDefaultVendorDeliveryModes(),
      gtmContainerId: null,
      gtmEnabled: false,
      gtmRiskAck: null,
      operatorKillSwitch: createDefaultGtmKillSwitchState(),
      version: initialSettings.version,
      updatedAt: initialSettings.updatedAt,
    },
  );
  const [ga4Input, setGa4Input] = React.useState(initialSettings.ga4MeasurementId ?? "");
  const [metaInput, setMetaInput] = React.useState(initialSettings.metaPixelId ?? "");
  const [tiktokInput, setTiktokInput] = React.useState(initialSettings.tiktokPixelId ?? "");

  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const [statusBanner, setStatusBanner] = React.useState<{
    readonly kind: "success" | "error" | "conflict";
    readonly title: string;
    readonly message: string;
    readonly requestId?: string;
  } | null>(
    initialLoadError
      ? {
          kind: "error",
          title: "Gagal memuat pengaturan awal",
          message: initialLoadError,
        }
      : null,
  );

  const isLocked = tenantStatus === "locked" || tenantStatus === "suspended";
  const isEditorReadOnly = !isLocked && currentRole === "editor";
  const isReadOnly = !canEdit || isLocked || isEditorReadOnly;

  const isDirty =
    (ga4Input.trim() || null) !== savedSnapshot.ga4MeasurementId ||
    (metaInput.trim() || null) !== savedSnapshot.metaPixelId ||
    (tiktokInput.trim() || null) !== savedSnapshot.tiktokPixelId;

  const ga4Hint = getInlineHintStatus("ga4MeasurementId", ga4Input);
  const metaHint = getInlineHintStatus("metaPixelId", metaInput);
  const tiktokHint = getInlineHintStatus("tiktokPixelId", tiktokInput);

  const activeProviderCount = [
    savedSnapshot.ga4MeasurementId,
    savedSnapshot.metaPixelId,
    savedSnapshot.tiktokPixelId,
  ].filter(Boolean).length;

  async function reloadLatestSettings() {
    setReloading(true);
    try {
      const res = await fetch(apiUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as
        | (AnalyticsSettingsSnapshot & ApiErrorPayload)
        | null;

      if (!res.ok || !data || typeof data.version !== "number") {
        setStatusBanner({
          kind: "error",
          title: "Gagal memuat ulang pengaturan",
          message:
            data?.error?.message ??
            "Tidak dapat mengambil versi terbaru dari server. Silakan coba lagi.",
          requestId: data?.requestId,
        });
        return;
      }

      const nextSnap: AnalyticsSettingsSnapshot = {
        ga4MeasurementId: data.ga4MeasurementId ?? null,
        metaPixelId: data.metaPixelId ?? null,
        tiktokPixelId: data.tiktokPixelId ?? null,
        version: data.version,
        updatedAt: data.updatedAt ?? null,
      };
      setSavedSnapshot(nextSnap);
      setGa4Input(nextSnap.ga4MeasurementId ?? "");
      setMetaInput(nextSnap.metaPixelId ?? "");
      setTiktokInput(nextSnap.tiktokPixelId ?? "");
      setFieldErrors({});
      setStatusBanner({
        kind: "success",
        title: "Versi terbaru dimuat",
        message: `Menampilkan pengaturan analitik terbaru (Versi #${nextSnap.version}).`,
      });
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Koneksi terputus",
        message: "Gagal menghubungi server untuk memuat versi terbaru. Silakan coba lagi.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function submitSave() {
    if (isReadOnly || saving) return;

    const payload = {
      ga4MeasurementId: ga4Input.trim() || null,
      metaPixelId: metaInput.trim() || null,
      tiktokPixelId: tiktokInput.trim() || null,
    };

    const clientCheck = validateDirectAnalyticsInput(payload);
    if (!clientCheck.ok) {
      const nextErrors: Record<string, string> = {};
      for (const item of clientCheck.fields) {
        nextErrors[item.field] = item.message;
      }
      setFieldErrors(nextErrors);
      setStatusBanner({
        kind: "error",
        title: "Periksa kembali ID pelacak",
        message: clientCheck.message,
      });
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setStatusBanner(null);

    try {
      const res = await fetch(apiUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          ...clientCheck.config,
          expectedVersion: savedSnapshot.version,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | (AnalyticsSettingsSnapshot & ApiErrorPayload)
        | null;

      if (res.ok && data && typeof data.version === "number") {
        const nextSnap: AnalyticsSettingsSnapshot = {
          ga4MeasurementId: data.ga4MeasurementId ?? null,
          metaPixelId: data.metaPixelId ?? null,
          tiktokPixelId: data.tiktokPixelId ?? null,
          version: data.version,
          updatedAt: data.updatedAt ?? null,
        };
        setSavedSnapshot(nextSnap);
        setGtmSnapshot((prev) => ({
          ...prev,
          ga4MeasurementId: nextSnap.ga4MeasurementId,
          metaPixelId: nextSnap.metaPixelId,
          tiktokPixelId: nextSnap.tiktokPixelId,
          version: nextSnap.version,
          updatedAt: nextSnap.updatedAt,
        }));
        setGa4Input(nextSnap.ga4MeasurementId ?? "");
        setMetaInput(nextSnap.metaPixelId ?? "");
        setTiktokInput(nextSnap.tiktokPixelId ?? "");
        setStatusBanner({
          kind: "success",
          title: "Pengaturan analitik tersimpan",
          message: `Konfigurasi GA4, Meta Pixel, dan TikTok Pixel untuk ${tenantName} diperbarui ke Versi #${nextSnap.version}.`,
        });
        return;
      }

      if (res.status === 409 || data?.error?.code === "STALE_VERSION") {
        setStatusBanner({
          kind: "conflict",
          title: "Perubahan bentrok dengan versi terbaru",
          message:
            data?.error?.message ??
            "Pengaturan analitik telah diubah di sesi lain. Muat ulang versi terbaru sebelum menyimpan kembali.",
          requestId: data?.requestId,
        });
        return;
      }

      if (res.status === 422 && data?.error?.fields) {
        const nextErrors: Record<string, string> = {};
        for (const item of data.error.fields) {
          nextErrors[item.field] = item.message;
        }
        setFieldErrors(nextErrors);
        setStatusBanner({
          kind: "error",
          title: "Format ID tidak valid",
          message:
            data.error.message ??
            "Beberapa ID pelacak tidak sesuai format yang diizinkan.",
          requestId: data.requestId,
        });
        return;
      }

      setStatusBanner({
        kind: "error",
        title:
          res.status === 403
            ? "Akses perubahan ditolak"
            : "Gagal menyimpan pengaturan analitik",
        message:
          data?.error?.message ??
          "Terjadi gangguan saat menyimpan pengaturan. Isian Anda tetap dipertahankan.",
        requestId: data?.requestId,
      });
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Koneksi ke server terputus",
        message:
          "Pengaturan belum tersimpan karena kendala jaringan. Isian Anda tetap aman — klik Coba lagi.",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleFormSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitSave();
  }

  return (
    <div className="space-y-6" data-testid="analytics-settings-page">
      {/* Header & Summary */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Analitik &amp; Piksel Langsung
            </h1>
            <Badge
              variant={activeProviderCount > 0 ? "success" : "secondary"}
              data-testid="analytics-active-count-badge"
            >
              {activeProviderCount > 0
                ? `${activeProviderCount} pelacak aktif`
                : "Belum ada pelacak aktif"}
            </Badge>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Hubungkan Google Analytics 4 (GA4), Meta Pixel, atau TikTok Pixel secara langsung ke
            situs publik <span className="font-medium text-foreground">{tenantName}</span>. Semua
            skrip hanya dimuat setelah pengunjung memberikan izin privasi.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <Badge variant="outline" data-testid="analytics-version-badge">
            Versi #{savedSnapshot.version}
          </Badge>
          <span>Diperbarui: {formatDateTimeWib(savedSnapshot.updatedAt)}</span>
        </div>
      </header>

      {/* Read-Only / Role / Lifecycle Notices */}
      {isLocked && (
        <Alert variant="warning" data-testid="analytics-locked-notice">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode baca-saja karena langganan terkunci</AlertTitle>
          <AlertDescription>
            Status situs saat ini terkunci (<code>SUBSCRIPTION_LOCKED</code>). Anda masih dapat
            melihat ID pelacak yang tersimpan, tetapi perubahan pengaturan dinonaktifkan sampai
            langganan diperpanjang.
          </AlertDescription>
        </Alert>
      )}

      {isEditorReadOnly && (
        <Alert variant="info" data-testid="analytics-editor-readonly-notice">
          <InfoIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Akses baca-saja untuk peran Editor</AlertTitle>
          <AlertDescription>
            Peran Anda (<strong>Editor</strong>) hanya dapat meninjau konfigurasi analitik. Hubungi
            Pemilik Situs atau Admin untuk menambahkan, mengubah, atau menonaktifkan ID pelacak.
          </AlertDescription>
        </Alert>
      )}

      {/* Mutation Status / Conflict Recovery / Retry Alerts */}
      {statusBanner && (
        <Alert
          variant={
            statusBanner.kind === "success"
              ? "success"
              : statusBanner.kind === "conflict"
                ? "warning"
                : "destructive"
          }
          data-testid={`analytics-status-${statusBanner.kind}`}
        >
          {statusBanner.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{statusBanner.title}</AlertTitle>
          <AlertDescription>
            <span>{statusBanner.message}</span>
            {statusBanner.requestId && (
              <span className="ml-1.5 font-mono text-xs">({statusBanner.requestId})</span>
            )}
          </AlertDescription>
          {statusBanner.kind === "conflict" && (
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={reloading}
                onClick={() => void reloadLatestSettings()}
                data-testid="analytics-reload-latest"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {reloading ? "Memuat versi terbaru..." : "Muat ulang versi terbaru"}
              </Button>
            </AlertAction>
          )}
          {statusBanner.kind === "error" && !isReadOnly && (
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={saving}
                onClick={() => void submitSave()}
                data-testid="analytics-retry-save"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                Coba lagi
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {/* Privacy & Consent Guarantee Banner */}
      <Alert variant="info" data-testid="analytics-consent-guarantee">
        <ShieldCheckIcon className="size-4" aria-hidden="true" />
        <AlertTitle>Jaminan Privasi Consent-First &amp; Bebas PII</AlertTitle>
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>
              <strong>Nol tag sebelum izin:</strong> Skrip GA4, Meta Pixel, dan TikTok Pixel tidak
              dimuat dan tidak melakukan permintaan jaringan sebelum pengunjung menyetujui kategori{" "}
              <em>Analitik</em> atau <em>Pemasaran</em> pada banner privasi situs.
            </li>
            <li>
              <strong>Sinyal prospek satu kali setelah tersimpan:</strong> Peristiwa konversi{" "}
              <code>lead_submitted</code> hanya dikirim sekali per prospek yang benar-benar
              tersimpan, tanpa mengirim nama, email, nomor WhatsApp, atau isi pesan pengunjung.
            </li>
            <li>
              <strong>CTA tetap berfungsi saat diblokir:</strong> Jika skrip pelacak gagal dimuat
              atau diblokir ad-blocker, tautan WhatsApp dan formulir kontak tetap berjalan normal.
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      {/* Main Direct Provider Form */}
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle>ID Pelacak Langsung (GA4, Meta Pixel, TikTok Pixel)</CardTitle>
          <CardDescription>
            Masukkan hanya ID pelacak resmi tanpa kode <code>&lt;script&gt;</code>. Kosongkan kolom
            bila ingin menonaktifkan pelacak tertentu.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleFormSubmit} noValidate data-testid="analytics-settings-form">
          <CardContent className="space-y-5 pt-4">
            {/* GA4 Field */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="ga4-measurement-id"
                  className="text-sm font-medium text-foreground"
                >
                  Google Analytics 4 — Measurement ID
                </label>
                <Badge variant="outline">Izin: Analitik</Badge>
              </div>
              <Input
                id="ga4-measurement-id"
                name="ga4MeasurementId"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={ANALYTICS_PROVIDER_DESCRIPTORS.ga4.exampleId}
                value={ga4Input}
                disabled={isReadOnly || saving}
                aria-invalid={Boolean(fieldErrors.ga4MeasurementId || (ga4Hint && !ga4Hint.valid))}
                aria-describedby="ga4-hint ga4-error"
                className="h-11 min-h-11 font-mono text-base md:h-11 md:text-sm"
                onChange={(e) => {
                  setGa4Input(e.target.value);
                  if (fieldErrors.ga4MeasurementId) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.ga4MeasurementId;
                      return next;
                    });
                  }
                }}
                data-testid="input-ga4-id"
              />
              <p id="ga4-hint" className="text-xs text-muted-foreground">
                {ANALYTICS_PROVIDER_DESCRIPTORS.ga4.formatHintId}
              </p>
              {(fieldErrors.ga4MeasurementId || (ga4Hint && !ga4Hint.valid)) && (
                <p
                  id="ga4-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                  data-testid="error-ga4-id"
                >
                  {fieldErrors.ga4MeasurementId ?? ga4Hint?.message}
                </p>
              )}
              {!fieldErrors.ga4MeasurementId && ga4Hint?.valid && (
                <p className="text-xs font-medium text-success" data-testid="valid-ga4-id">
                  {ga4Hint.message}
                </p>
              )}
            </div>

            <Separator />

            {/* Meta Pixel Field */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="meta-pixel-id" className="text-sm font-medium text-foreground">
                  Meta Pixel ID (Facebook / Instagram Ads)
                </label>
                <Badge variant="outline">Izin: Pemasaran</Badge>
              </div>
              <Input
                id="meta-pixel-id"
                name="metaPixelId"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                placeholder={ANALYTICS_PROVIDER_DESCRIPTORS.meta.exampleId}
                value={metaInput}
                disabled={isReadOnly || saving}
                aria-invalid={Boolean(fieldErrors.metaPixelId || (metaHint && !metaHint.valid))}
                aria-describedby="meta-hint meta-error"
                className="h-11 min-h-11 font-mono text-base md:h-11 md:text-sm"
                onChange={(e) => {
                  setMetaInput(e.target.value);
                  if (fieldErrors.metaPixelId) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.metaPixelId;
                      return next;
                    });
                  }
                }}
                data-testid="input-meta-id"
              />
              <p id="meta-hint" className="text-xs text-muted-foreground">
                {ANALYTICS_PROVIDER_DESCRIPTORS.meta.formatHintId}
              </p>
              {(fieldErrors.metaPixelId || (metaHint && !metaHint.valid)) && (
                <p
                  id="meta-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                  data-testid="error-meta-id"
                >
                  {fieldErrors.metaPixelId ?? metaHint?.message}
                </p>
              )}
              {!fieldErrors.metaPixelId && metaHint?.valid && (
                <p className="text-xs font-medium text-success" data-testid="valid-meta-id">
                  {metaHint.message}
                </p>
              )}
            </div>

            <Separator />

            {/* TikTok Pixel Field */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="tiktok-pixel-id" className="text-sm font-medium text-foreground">
                  TikTok Pixel ID
                </label>
                <Badge variant="outline">Izin: Pemasaran</Badge>
              </div>
              <Input
                id="tiktok-pixel-id"
                name="tiktokPixelId"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={ANALYTICS_PROVIDER_DESCRIPTORS.tiktok.exampleId}
                value={tiktokInput}
                disabled={isReadOnly || saving}
                aria-invalid={Boolean(
                  fieldErrors.tiktokPixelId || (tiktokHint && !tiktokHint.valid),
                )}
                aria-describedby="tiktok-hint tiktok-error"
                className="h-11 min-h-11 font-mono text-base md:h-11 md:text-sm"
                onChange={(e) => {
                  setTiktokInput(e.target.value);
                  if (fieldErrors.tiktokPixelId) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.tiktokPixelId;
                      return next;
                    });
                  }
                }}
                data-testid="input-tiktok-id"
              />
              <p id="tiktok-hint" className="text-xs text-muted-foreground">
                {ANALYTICS_PROVIDER_DESCRIPTORS.tiktok.formatHintId}
              </p>
              {(fieldErrors.tiktokPixelId || (tiktokHint && !tiktokHint.valid)) && (
                <p
                  id="tiktok-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                  data-testid="error-tiktok-id"
                >
                  {fieldErrors.tiktokPixelId ?? tiktokHint?.message}
                </p>
              )}
              {!fieldErrors.tiktokPixelId && tiktokHint?.valid && (
                <p className="text-xs font-medium text-success" data-testid="valid-tiktok-id">
                  {tiktokHint.message}
                </p>
              )}
            </div>

            {/* Explicit GTM Separation Callout */}
            <div
              className="rounded-md border border-border bg-muted/60 p-3.5 text-xs text-muted-foreground"
              data-testid="analytics-gtm-separation-note"
            >
              <p className="font-semibold text-foreground">
                Catatan Google Tag Manager (GTM)
              </p>
              <p className="mt-1 leading-relaxed">
                ID kontainer <code>GTM-*</code> dan cuplikan kode pihak ketiga tidak diizinkan pada
                formulir pelacak langsung ini. Pengaturan <strong>Google Tag Manager</strong>{" "}
                dikelola secara terpisah karena memerlukan persetujuan risiko khusus Pemilik Situs
                (owner-only) yang tercatat di log audit.
              </p>
            </div>
          </CardContent>

          <CardFooter className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {isReadOnly
                ? "Pengaturan ditampilkan dalam mode baca-saja."
                : isDirty
                  ? "Ada perubahan yang belum disimpan."
                  : "Semua perubahan sudah tersimpan."}
            </p>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                disabled={reloading || saving}
                onClick={() => void reloadLatestSettings()}
                data-testid="analytics-refresh-button"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {reloading ? "Memuat..." : "Muat ulang"}
              </Button>
              <Button
                type="submit"
                className="min-h-11 w-full sm:w-auto"
                disabled={isReadOnly || saving}
                data-testid="analytics-save-button"
              >
                {saving ? "Menyimpan..." : "Simpan pengaturan analitik"}
              </Button>
            </div>
          </CardFooter>
        </form>
      </Card>

      {/* Easy Google Tag Manager Setup, Template Download & Guide (TASK-076) */}
      <GtmSetupSection
        handle={handle}
        tenantName={tenantName}
        currentRole={currentRole}
        isLocked={isLocked}
        canEdit={canEdit}
        snapshot={gtmSnapshot}
        onSnapshotSynced={(nextGtm) => {
          setGtmSnapshot(nextGtm);
          setSavedSnapshot({
            ga4MeasurementId: nextGtm.ga4MeasurementId,
            metaPixelId: nextGtm.metaPixelId,
            tiktokPixelId: nextGtm.tiktokPixelId,
            version: nextGtm.version,
            updatedAt: nextGtm.updatedAt,
          });
          setGa4Input(nextGtm.ga4MeasurementId ?? "");
          setMetaInput(nextGtm.metaPixelId ?? "");
          setTiktokInput(nextGtm.tiktokPixelId ?? "");
        }}
      />

      {/* Provider Event-Mapping Reference Table */}
      <Card data-testid="analytics-event-mapping-card">
        <CardHeader className="border-b border-border">
          <CardTitle>Referensi Pemetaan Peristiwa (Event Mapping)</CardTitle>
          <CardDescription>
            Setiap interaksi penting di situs publik dipetakan otomatis ke peristiwa standar
            masing-masing penyedia tanpa meneruskan data pribadi pengunjung.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {/* Mobile stacked cards (< md) — guarantees zero horizontal overflow at 360px */}
          <div className="space-y-3 md:hidden" data-testid="analytics-mapping-mobile-list">
            {CANONICAL_SIGNAL_EVENTS.map((eventKey) => {
              const row = ANALYTICS_PROVIDER_EVENT_MAPPINGS[eventKey];
              return (
                <div
                  key={eventKey}
                  className="space-y-2 rounded-md border border-border bg-background p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{row.labelId}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                      {row.canonicalEvent}
                    </code>
                  </div>
                  <p className="text-muted-foreground">{row.triggerRuleId}</p>
                  <dl className="space-y-1.5 rounded bg-muted/40 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[11px] text-muted-foreground">GA4 (Analitik)</dt>
                      <dd className="font-mono font-medium text-foreground">
                        {row.providers.ga4.eventName}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[11px] text-muted-foreground">Meta Pixel (Pemasaran)</dt>
                      <dd className="font-mono font-medium text-foreground">
                        {row.providers.meta.eventName}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[11px] text-muted-foreground">TikTok Pixel (Pemasaran)</dt>
                      <dd className="font-mono font-medium text-foreground">
                        {row.providers.tiktok.eventName}
                      </dd>
                    </div>
                  </dl>
                  <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                    Privasi: {row.piiPolicyId}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Desktop compact data table (>= md) */}
          <div className="hidden md:block">
            <Table data-testid="analytics-mapping-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Peristiwa Kanonik</TableHead>
                  <TableHead>GA4 (Analitik)</TableHead>
                  <TableHead>Meta Pixel (Pemasaran)</TableHead>
                  <TableHead>TikTok Pixel (Pemasaran)</TableHead>
                  <TableHead>Aturan Pemicu &amp; Privasi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {CANONICAL_SIGNAL_EVENTS.map((eventKey) => {
                  const row = ANALYTICS_PROVIDER_EVENT_MAPPINGS[eventKey];
                  return (
                    <TableRow key={eventKey}>
                      <TableCell className="align-top">
                        <div className="font-medium text-foreground">{row.labelId}</div>
                        <code className="font-mono text-xs text-muted-foreground">
                          {row.canonicalEvent}
                        </code>
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs">
                        {row.providers.ga4.eventName}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs">
                        {row.providers.meta.eventName}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs">
                        {row.providers.tiktok.eventName}
                      </TableCell>
                      <TableCell className="max-w-sm whitespace-normal align-top text-xs text-muted-foreground">
                        <p className="text-foreground">{row.triggerRuleId}</p>
                        <p className="mt-0.5">{row.piiPolicyId}</p>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
