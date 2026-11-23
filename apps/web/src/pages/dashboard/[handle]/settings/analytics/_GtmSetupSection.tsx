import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  GTM_DATALAYER_CONTRACT_VERSION,
  GTM_DATALAYER_EVENT_DOCS,
  GTM_KILL_SWITCH_CATEGORY_LABELS_ID,
  GTM_RISK_ACK_STATEMENTS_ID,
  GTM_RISK_ACK_VERSION,
  isValidGtmContainerId,
  validateGtmSettingsInput,
  type AnalyticsVendorMode,
  type GtmKillSwitchReasonCategory,
  type GtmRiskAcknowledgementRecord,
  type VendorDeliveryModes,
} from "@punyasitus/core/analytics/gtm";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  CheckSquareIcon,
  DownloadIcon,
  ExternalLinkIcon,
  InfoIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TagIcon,
  XIcon,
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

export interface TenantVisibleOperatorKillSwitchSnapshot {
  readonly active?: boolean;
  readonly disabled: boolean;
  readonly category?: GtmKillSwitchReasonCategory | null;
  readonly reasonCategory: GtmKillSwitchReasonCategory | null;
  readonly reason: string | null;
  readonly disabledAt: string | null;
  readonly liftedAt: string | null;
}

export interface GtmSettingsSnapshot {
  readonly ga4MeasurementId: string | null;
  readonly metaPixelId: string | null;
  readonly tiktokPixelId: string | null;
  readonly vendorModes: VendorDeliveryModes;
  readonly gtmContainerId: string | null;
  readonly gtmEnabled: boolean;
  readonly gtmRiskAck: GtmRiskAcknowledgementRecord | null;
  readonly operatorKillSwitch: TenantVisibleOperatorKillSwitchSnapshot;
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface GtmSetupSectionProps {
  readonly handle: string;
  readonly tenantName: string;
  readonly currentRole: string;
  readonly isLocked: boolean;
  readonly canEdit: boolean;
  readonly snapshot: GtmSettingsSnapshot;
  readonly onSnapshotSynced: (next: GtmSettingsSnapshot) => void;
}

interface GtmApiErrorBody {
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

const VENDOR_ROWS: readonly {
  readonly key: "ga4" | "meta" | "tiktok";
  readonly label: string;
  readonly directIdKey: "ga4MeasurementId" | "metaPixelId" | "tiktokPixelId";
  readonly consentLabel: string;
}[] = [
  {
    key: "ga4",
    label: "Google Analytics 4 (GA4)",
    directIdKey: "ga4MeasurementId",
    consentLabel: "Izin: Analitik",
  },
  {
    key: "meta",
    label: "Meta Pixel (Facebook / Instagram)",
    directIdKey: "metaPixelId",
    consentLabel: "Izin: Pemasaran",
  },
  {
    key: "tiktok",
    label: "TikTok Pixel",
    directIdKey: "tiktokPixelId",
    consentLabel: "Izin: Pemasaran",
  },
];

const GUIDE_STEPS_ID: readonly {
  readonly step: number;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    step: 1,
    title: "Buat kontainer Web di Google Tag Manager",
    body: "Buka tagmanager.google.com menggunakan akun Google bisnis Anda, lalu buat kontainer baru dengan platform target Web. PunyaSitus tidak pernah meminta kata sandi atau akses akun Google Anda.",
  },
  {
    step: 2,
    title: "Unduh & impor template JSON PunyaSitus (Merge ke workspace baru)",
    body: "Unduh file template JSON di bawah, lalu di GTM buka Admin > Import Container. Pilih New Workspace dan opsi Merge (jangan menimpa workspace produksi yang sudah ada).",
  },
  {
    step: 3,
    title: "Isi ID GA4, Meta Pixel, atau TikTok Pixel di menu Variables",
    body: "Ubah nilai variabel konstanta PS - GA4 Measurement ID, PS - Meta Pixel ID, atau PS - TikTok Pixel ID khusus untuk vendor yang Anda pilih pada mode Melalui GTM. Hapus atau jeda tag vendor yang tetap memakai mode Langsung agar tidak terjadi penghitungan ganda.",
  },
  {
    step: 4,
    title: "Uji di Preview / Tag Assistant sebelum publikasi",
    body: "Klik Preview di GTM dan sambungkan ke situs publik Anda. Pastikan sebelum izin diberikan tidak ada tag yang aktif, lalu setelah klik Terima semua, peristiwa ps_page_view, ps_wa_click, ps_external_click, dan ps_lead_submitted muncul tanpa data pribadi.",
  },
  {
    step: 5,
    title: "Terbitkan (Publish) kontainer GTM Anda",
    body: "Klik Submit > Publish pada workspace GTM Anda setelah semua tag lulus pengujian Tag Assistant.",
  },
  {
    step: 6,
    title: "Tempel ID GTM-XXXXXXX dan aktifkan (khusus Pemilik Situs)",
    body: "Masukkan ID kontainer GTM di bawah, atur mode vendor (Langsung vs Melalui GTM), simpan konfigurasi, lalu Pemilik Situs menyetujui pernyataan risiko untuk mengaktifkan GTM.",
  },
];

const VERIFY_CHECKLIST_ITEMS: readonly { readonly id: string; readonly label: string }[] = [
  {
    id: "chk-import-merge",
    label: "Template JSON sudah diimpor via Admin > Import Container > Merge ke workspace baru.",
  },
  {
    id: "chk-no-double-count",
    label: "Setiap vendor (GA4, Meta, TikTok) hanya aktif di satu tempat: Langsung ATAU Melalui GTM.",
  },
  {
    id: "chk-consent-before-load",
    label: "Pada mode penyamaran (incognito) sebelum klik izin, skrip gtm.js tidak dimuat.",
  },
  {
    id: "chk-tag-assistant",
    label: "Tag Assistant menampilkan Consent Mode v2 (default denied -> update granted) & peristiwa ps_*.",
  },
  {
    id: "chk-cta-ok",
    label: "Tombol WhatsApp, tautan eksternal, dan formulir kontak tetap berfungsi lancar.",
  },
];

function formatDateTimeWib(iso: string | null): string {
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

export function GtmSetupSection({
  handle,
  tenantName,
  currentRole,
  isLocked,
  canEdit,
  snapshot,
  onSnapshotSynced,
}: GtmSetupSectionProps) {
  const gtmApiUrl = `/api/tenants/${encodeURIComponent(handle)}/analytics/gtm`;
  const templateDownloadUrl = `/api/tenants/${encodeURIComponent(handle)}/analytics/gtm/template`;

  const [containerInput, setContainerInput] = React.useState(snapshot.gtmContainerId ?? "");
  const [vendorModes, setVendorModes] = React.useState<VendorDeliveryModes>(snapshot.vendorModes);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const [riskDialogOpen, setRiskDialogOpen] = React.useState(false);
  const [riskChecked, setRiskChecked] = React.useState(false);
  const [riskDialogError, setRiskDialogError] = React.useState<string | null>(null);

  const [checkedGuideItems, setCheckedGuideItems] = React.useState<Record<string, boolean>>({});

  const [banner, setBanner] = React.useState<{
    readonly kind: "success" | "error" | "conflict";
    readonly title: string;
    readonly message: string;
    readonly requestId?: string;
  } | null>(null);

  React.useEffect(() => {
    setContainerInput(snapshot.gtmContainerId ?? "");
    setVendorModes(snapshot.vendorModes);
  }, [snapshot.gtmContainerId, snapshot.vendorModes]);

  const isOwner = currentRole === "owner";
  const isAdmin = currentRole === "admin";
  const isEditor = currentRole === "editor";
  const isReadOnly = !canEdit || isLocked || isEditor;
  const isKilledByOperator = snapshot.operatorKillSwitch.disabled === true;

  const trimmedContainer = containerInput.trim();
  const inlineContainerCheck = React.useMemo(() => {
    if (!trimmedContainer) return null;
    const check = validateGtmSettingsInput({ gtmContainerId: trimmedContainer });
    if (check.ok) {
      return { valid: true, message: "Format ID kontainer GTM valid." };
    }
    return {
      valid: false,
      message: check.fields[0]?.message ?? check.message,
    };
  }, [trimmedContainer]);

  async function reloadGtmFromServer() {
    setReloading(true);
    try {
      const res = await fetch(gtmApiUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => null)) as
        | (GtmSettingsSnapshot & GtmApiErrorBody)
        | null;
      if (!res.ok || !data || typeof data.version !== "number") {
        setBanner({
          kind: "error",
          title: "Gagal memuat ulang pengaturan GTM",
          message: data?.error?.message ?? "Tidak dapat mengambil konfigurasi GTM terbaru.",
          requestId: data?.requestId,
        });
        return;
      }
      onSnapshotSynced({
        ga4MeasurementId: data.ga4MeasurementId ?? null,
        metaPixelId: data.metaPixelId ?? null,
        tiktokPixelId: data.tiktokPixelId ?? null,
        vendorModes: data.vendorModes,
        gtmContainerId: data.gtmContainerId ?? null,
        gtmEnabled: Boolean(data.gtmEnabled),
        gtmRiskAck: data.gtmRiskAck ?? null,
        operatorKillSwitch: data.operatorKillSwitch,
        version: data.version,
        updatedAt: data.updatedAt ?? null,
      });
      setFieldErrors({});
      setBanner({
        kind: "success",
        title: "Pengaturan GTM diperbarui",
        message: `Menampilkan versi terbaru dari server (Versi #${data.version}).`,
      });
    } catch {
      setBanner({
        kind: "error",
        title: "Koneksi terputus",
        message: "Gagal menghubungi server saat memuat ulang pengaturan GTM.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function patchGtm(payload: Record<string, unknown>, successTitle: string, successMsg: string) {
    setSaving(true);
    setFieldErrors({});
    setBanner(null);
    setRiskDialogError(null);

    try {
      const res = await fetch(gtmApiUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          ...payload,
          expectedVersion: snapshot.version,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (GtmSettingsSnapshot & GtmApiErrorBody)
        | null;

      if (res.ok && data && typeof data.version === "number") {
        onSnapshotSynced({
          ga4MeasurementId: data.ga4MeasurementId ?? null,
          metaPixelId: data.metaPixelId ?? null,
          tiktokPixelId: data.tiktokPixelId ?? null,
          vendorModes: data.vendorModes,
          gtmContainerId: data.gtmContainerId ?? null,
          gtmEnabled: Boolean(data.gtmEnabled),
          gtmRiskAck: data.gtmRiskAck ?? null,
          operatorKillSwitch: data.operatorKillSwitch,
          version: data.version,
          updatedAt: data.updatedAt ?? null,
        });
        setRiskDialogOpen(false);
        setRiskChecked(false);
        setBanner({
          kind: "success",
          title: successTitle,
          message: `${successMsg} (Versi #${data.version}).`,
        });
        return true;
      }

      if (res.status === 409 || data?.error?.code === "STALE_VERSION") {
        setBanner({
          kind: "conflict",
          title: "Perubahan bentrok dengan versi terbaru",
          message:
            data?.error?.message ??
            "Pengaturan telah diubah di sesi lain. Muat ulang versi terbaru lalu simpan ulang.",
          requestId: data?.requestId,
        });
        return false;
      }

      if (data?.error?.fields && data.error.fields.length > 0) {
        const nextErrs: Record<string, string> = {};
        for (const f of data.error.fields) {
          nextErrs[f.field] = f.message;
        }
        setFieldErrors(nextErrs);
      }

      const msg =
        data?.error?.message ??
        "Gagal menyimpan pengaturan Google Tag Manager. Periksa kembali isian Anda.";
      if (riskDialogOpen) {
        setRiskDialogError(msg);
      } else {
        setBanner({
          kind: "error",
          title: res.status === 403 ? "Tindakan tidak diizinkan" : "Gagal menyimpan pengaturan GTM",
          message: msg,
          requestId: data?.requestId,
        });
      }
      return false;
    } catch {
      const netMsg = "Koneksi ke server terputus. Isian Anda tetap aman — silakan coba lagi.";
      if (riskDialogOpen) {
        setRiskDialogError(netMsg);
      } else {
        setBanner({
          kind: "error",
          title: "Koneksi terputus",
          message: netMsg,
        });
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveConfig(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isReadOnly || saving) return;

    const containerVal = containerInput.trim() || null;
    const validation = validateGtmSettingsInput({
      gtmContainerId: containerVal,
      vendorModes,
    });
    if (!validation.ok) {
      const nextErrs: Record<string, string> = {};
      for (const f of validation.fields) {
        nextErrs[f.field] = f.message;
      }
      setFieldErrors(nextErrs);
      setBanner({
        kind: "error",
        title: "Format pengaturan GTM tidak valid",
        message: validation.message,
      });
      return;
    }

    // Automatically clear direct IDs for vendors explicitly switched to "Melalui GTM"
    // so a vendor is never active both directly and via GTM (anti-double-count).
    const payload: Record<string, unknown> = {
      gtmContainerId: containerVal,
      vendorModes,
    };
    if (vendorModes.ga4 === "gtm" && snapshot.ga4MeasurementId !== null) {
      payload.ga4MeasurementId = null;
    }
    if (vendorModes.meta === "gtm" && snapshot.metaPixelId !== null) {
      payload.metaPixelId = null;
    }
    if (vendorModes.tiktok === "gtm" && snapshot.tiktokPixelId !== null) {
      payload.tiktokPixelId = null;
    }

    await patchGtm(
      payload,
      "Konfigurasi GTM & mode vendor tersimpan",
      `Pengaturan mode pelacakan dan ID kontainer GTM untuk ${tenantName} berhasil diperbarui`,
    );
  }

  async function handleConfirmEnableGtm(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isOwner || isReadOnly || saving) return;
    if (!riskChecked) {
      setRiskDialogError(
        "Centang kotak persetujuan risiko di atas sebelum mengaktifkan Google Tag Manager.",
      );
      return;
    }

    const containerVal = containerInput.trim();
    if (!isValidGtmContainerId(containerVal)) {
      setRiskDialogError(
        "Masukkan ID kontainer GTM yang valid (contoh: GTM-ABC1234) terlebih dahulu.",
      );
      return;
    }

    const payload: Record<string, unknown> = {
      gtmContainerId: containerVal,
      vendorModes,
      gtmEnabled: true,
      riskAcknowledgement: {
        accepted: true,
        version: GTM_RISK_ACK_VERSION,
      },
    };
    if (vendorModes.ga4 === "gtm" && snapshot.ga4MeasurementId !== null) {
      payload.ga4MeasurementId = null;
    }
    if (vendorModes.meta === "gtm" && snapshot.metaPixelId !== null) {
      payload.metaPixelId = null;
    }
    if (vendorModes.tiktok === "gtm" && snapshot.tiktokPixelId !== null) {
      payload.tiktokPixelId = null;
    }

    await patchGtm(
      payload,
      "Google Tag Manager aktif",
      `Kontainer ${containerVal} aktif dengan persetujuan risiko pemilik tercatat di log audit`,
    );
  }

  async function handleDisableGtm() {
    if (isReadOnly || saving) return;
    await patchGtm(
      { gtmEnabled: false },
      "Google Tag Manager dinonaktifkan",
      "Skrip GTM tidak lagi dimuat pada situs publik; pelacak langsung tetap berjalan normal",
    );
  }

  return (
    <section className="space-y-6" data-testid="gtm-setup-section">
      {/* Operator Kill Switch Warning Banner */}
      {isKilledByOperator && (
        <Alert variant="destructive" data-testid="gtm-operator-kill-switch-banner">
          <BanIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Google Tag Manager dinonaktifkan oleh operator platform</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>
              Kategori:{" "}
              <strong>
                {snapshot.operatorKillSwitch.reasonCategory
                  ? GTM_KILL_SWITCH_CATEGORY_LABELS_ID[snapshot.operatorKillSwitch.reasonCategory]
                  : "Kebijakan Operasional"}
              </strong>{" "}
              · Diperbarui: {formatDateTimeWib(snapshot.operatorKillSwitch.disabledAt)}
            </p>
            {snapshot.operatorKillSwitch.reason && (
              <p>Alasan: {snapshot.operatorKillSwitch.reason}</p>
            )}
            <p>
              Pelacak langsung (GA4, Meta Pixel, TikTok Pixel) pada mode <strong>Langsung</strong>{" "}
              tetap berjalan normal. Hubungi tim dukungan PunyaSitus setelah kontainer GTM Anda
              dibersihkan.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Mutation Status Banner */}
      {banner && (
        <Alert
          variant={
            banner.kind === "success"
              ? "success"
              : banner.kind === "conflict"
                ? "warning"
                : "destructive"
          }
          data-testid={`gtm-status-${banner.kind}`}
        >
          {banner.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>
            <span>{banner.message}</span>
            {banner.requestId && (
              <span className="ml-1.5 font-mono text-xs">({banner.requestId})</span>
            )}
          </AlertDescription>
          {banner.kind === "conflict" && (
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={reloading}
                onClick={() => void reloadGtmFromServer()}
                data-testid="gtm-reload-latest"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {reloading ? "Memuat..." : "Muat ulang versi terbaru"}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {/* Main GTM & Per-Vendor Delivery Card */}
      <Card data-testid="gtm-config-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="flex flex-wrap items-center gap-2">
                <TagIcon className="size-4 text-primary" aria-hidden="true" />
                Google Tag Manager (GTM) &amp; Mode Pengiriman Vendor
              </CardTitle>
              <CardDescription>
                Pilih metode pengiriman tiap vendor: <strong>Langsung</strong> atau{" "}
                <strong>Melalui GTM</strong>. Setiap vendor hanya boleh aktif di satu jalur agar
                tidak terjadi penghitungan ganda (double counting).
              </CardDescription>
            </div>
            <Badge
              variant={
                isKilledByOperator
                  ? "destructive"
                  : snapshot.gtmEnabled
                    ? "success"
                    : "secondary"
              }
              data-testid="gtm-active-status-badge"
            >
              {isKilledByOperator
                ? "GTM Dimatikan Operator"
                : snapshot.gtmEnabled
                  ? `GTM Aktif (${snapshot.gtmContainerId})`
                  : "GTM Nonaktif"}
            </Badge>
          </div>
        </CardHeader>

        <form onSubmit={handleSaveConfig} noValidate data-testid="gtm-config-form">
          <CardContent className="space-y-5 pt-4">
            {/* Double-count & Scope Guarantee Note */}
            <Alert variant="warning" data-testid="gtm-double-count-warning">
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Cegah penghitungan ganda &amp; pahami batas tanggung jawab</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>
                  Memilih <strong>Melalui GTM</strong> untuk suatu vendor akan menonaktifkan ID
                  pelacak langsung vendor tersebut saat disimpan sehingga peristiwa tidak dikirim dua
                  kali.
                </p>
                <p>
                  Jaminan PunyaSitus hanya mencakup skrip bawaan &amp; <code>dataLayer</code>{" "}
                  <code>ps_*</code> bebas PII. Tag pihak ketiga yang Anda tambahkan di dalam GTM
                  berada di luar jaminan platform dan menjadi tanggung jawab pemilik situs.
                </p>
              </AlertDescription>
            </Alert>

            {/* Per-Vendor Mode Selector */}
            <div className="space-y-3" data-testid="gtm-vendor-mode-selector">
              <h2 className="text-sm font-semibold text-foreground">
                Pilih Jalur Pengiriman per Vendor
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {VENDOR_ROWS.map((vendor) => {
                  const activeMode = vendorModes[vendor.key];
                  const hasDirectId = Boolean(snapshot[vendor.directIdKey]);
                  return (
                    <div
                      key={vendor.key}
                      className="space-y-2.5 rounded-md border border-border bg-background p-3.5"
                      data-testid={`vendor-mode-card-${vendor.key}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <span className="text-sm font-medium text-foreground">{vendor.label}</span>
                        <Badge variant="outline" className="text-[11px]">
                          {vendor.consentLabel}
                        </Badge>
                      </div>
                      <div
                        role="radiogroup"
                        aria-label={`Mode pengiriman ${vendor.label}`}
                        className="grid grid-cols-2 gap-2"
                      >
                        {(["direct", "gtm"] as const).map((mode: AnalyticsVendorMode) => {
                          const selected = activeMode === mode;
                          return (
                            <Button
                              key={mode}
                              type="button"
                              variant={selected ? "default" : "outline"}
                              disabled={isReadOnly || saving}
                              aria-pressed={selected}
                              className="min-h-11 w-full text-xs"
                              onClick={() =>
                                setVendorModes((prev) => ({ ...prev, [vendor.key]: mode }))
                              }
                              data-testid={`vendor-mode-${vendor.key}-${mode}`}
                            >
                              {mode === "direct" ? "Langsung" : "Melalui GTM"}
                            </Button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {activeMode === "gtm"
                          ? hasDirectId
                            ? "ID langsung akan dibersihkan saat disimpan agar tidak terhitung ganda."
                            : "Dikelola lewat kontainer GTM Anda."
                          : hasDirectId
                            ? "ID pelacak langsung aktif."
                            : "Masukkan ID pada formulir Pelacak Langsung di atas."}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* GTM Container ID Field */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="gtm-container-id" className="text-sm font-medium text-foreground">
                  Google Tag Manager — Container ID
                </label>
                <Badge variant="outline">Dimuat setelah Izin: Analitik</Badge>
              </div>
              <Input
                id="gtm-container-id"
                name="gtmContainerId"
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="GTM-ABC1234"
                value={containerInput}
                disabled={isReadOnly || saving || (isAdmin && snapshot.gtmEnabled)}
                aria-invalid={Boolean(
                  fieldErrors.gtmContainerId ||
                    (inlineContainerCheck && !inlineContainerCheck.valid),
                )}
                aria-describedby="gtm-id-hint gtm-id-error"
                className="h-11 min-h-11 font-mono text-base md:h-11 md:text-sm"
                onChange={(e) => {
                  setContainerInput(e.target.value);
                  if (fieldErrors.gtmContainerId) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.gtmContainerId;
                      return next;
                    });
                  }
                }}
                data-testid="input-gtm-container-id"
              />
              <p id="gtm-id-hint" className="text-xs text-muted-foreground">
                Format: <code>GTM-</code> diikuti 6–12 huruf kapital atau angka (contoh:{" "}
                <code>GTM-ABC1234</code>). Hanya satu kontainer per website; kode HTML/JS mentah
                ditolak.
              </p>
              {(fieldErrors.gtmContainerId ||
                (inlineContainerCheck && !inlineContainerCheck.valid)) && (
                <p
                  id="gtm-id-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                  data-testid="error-gtm-container-id"
                >
                  {fieldErrors.gtmContainerId ?? inlineContainerCheck?.message}
                </p>
              )}
              {!fieldErrors.gtmContainerId && inlineContainerCheck?.valid && (
                <p className="text-xs font-medium text-success" data-testid="valid-gtm-container-id">
                  {inlineContainerCheck.message}
                </p>
              )}
            </div>

            {/* Owner-Only Activation Box */}
            <div
              className="space-y-3 rounded-md border border-border bg-muted/40 p-4"
              data-testid="gtm-activation-panel"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    Status Aktivasi Google Tag Manager
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.gtmEnabled
                      ? `Aktif untuk ${snapshot.gtmContainerId}. Persetujuan risiko v${snapshot.gtmRiskAck?.version ?? GTM_RISK_ACK_VERSION} dicatat pada ${formatDateTimeWib(snapshot.gtmRiskAck?.acceptedAt ?? null)}.`
                      : "GTM belum aktif. Halaman publik tetap menggunakan kebijakan keamanan CSP ketat tanpa memuat GTM."}
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  {snapshot.gtmEnabled ? (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isReadOnly || saving}
                      className="min-h-11 w-full sm:w-auto"
                      onClick={() => void handleDisableGtm()}
                      data-testid="gtm-disable-button"
                    >
                      Nonaktifkan GTM
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="default"
                      disabled={
                        isReadOnly ||
                        saving ||
                        !isOwner ||
                        isKilledByOperator ||
                        !isValidGtmContainerId(trimmedContainer)
                      }
                      className="min-h-11 w-full sm:w-auto"
                      onClick={() => {
                        setRiskDialogError(null);
                        setRiskChecked(false);
                        setRiskDialogOpen(true);
                      }}
                      data-testid="gtm-open-enable-dialog-button"
                    >
                      <ShieldAlertIcon className="size-4" aria-hidden="true" />
                      Aktifkan GTM (Khusus Pemilik)
                    </Button>
                  )}
                </div>
              </div>

              {isAdmin && !snapshot.gtmEnabled && (
                <Alert variant="info" data-testid="gtm-admin-owner-only-notice">
                  <InfoIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Admin dapat mengisi ID, tetapi aktivasi khusus Pemilik Situs</AlertTitle>
                  <AlertDescription>
                    Anda dapat menyimpan ID kontainer <code>GTM-*</code> dan mode vendor sekarang.
                    Minta <strong>Pemilik Situs (Owner)</strong> untuk masuk dan menyetujui
                    pernyataan risiko keamanan guna mengaktifkan GTM.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>

          <CardFooter className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Menyimpan ID &amp; mode vendor tidak otomatis mengaktifkan GTM sebelum Pemilik Situs
              menyetujui pernyataan risiko.
            </p>
            <Button
              type="submit"
              variant="outline"
              disabled={isReadOnly || saving}
              className="min-h-11 w-full sm:w-auto"
              data-testid="gtm-save-draft-button"
            >
              {saving ? "Menyimpan..." : "Simpan ID & Mode Vendor"}
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* Container Template Download + Indonesian Guide + Test Checklist */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-7" data-testid="gtm-guide-card">
          <CardHeader className="border-b border-border">
            <CardTitle>Panduan Pemasangan GTM Langkah demi Langkah</CardTitle>
            <CardDescription>
              Template siap impor tanpa perlu meminta akses akun Google Anda. Setiap tag tambahan
              memengaruhi kecepatan muat situs publik.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Template Kontainer GTM Siap Impor (v1)
                </p>
                <p className="text-xs text-muted-foreground">
                  Berisi 4 pemicu <code>ps_*</code>, 10 variabel dataLayer bebas PII, serta tag GA4,
                  Meta Pixel &amp; TikTok Pixel dengan Consent Mode v2. Rekomendasi:{" "}
                  <strong>Merge ke workspace baru</strong>.
                </p>
              </div>
              <Button
                render={
                  <a
                    href={templateDownloadUrl}
                    download="punyasitus-gtm-container-template-v1.json"
                    data-testid="gtm-download-template-link"
                  />
                }
                variant="default"
                className="min-h-11 w-full shrink-0 sm:w-auto"
              >
                <DownloadIcon className="size-4" aria-hidden="true" />
                Unduh Template JSON
              </Button>
            </div>

            <ol className="space-y-3" data-testid="gtm-guide-steps">
              {GUIDE_STEPS_ID.map((item) => (
                <li
                  key={item.step}
                  className="flex items-start gap-3 rounded-md border border-border bg-background p-3"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary tabular-nums">
                    {item.step}
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <a
                href="https://support.google.com/tagmanager/answer/6106997"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 font-medium text-primary underline underline-offset-4"
              >
                Dokumentasi resmi Import Container Google
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
              <span>· PunyaSitus tidak pernah meminta login Google Anda.</span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-5" data-testid="gtm-test-checklist-card">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center gap-2">
              <CheckSquareIcon className="size-4 text-primary" aria-hidden="true" />
              Daftar Periksa “Tes Pemasangan”
            </CardTitle>
            <CardDescription>
              Gunakan daftar ini bersama Google Tag Assistant sebelum menerbitkan kontainer Anda.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            <div className="space-y-2">
              {VERIFY_CHECKLIST_ITEMS.map((item) => {
                const checked = Boolean(checkedGuideItems[item.id]);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() =>
                      setCheckedGuideItems((prev) => ({
                        ...prev,
                        [item.id]: !prev[item.id],
                      }))
                    }
                    className="flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background p-2.5 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    data-testid={`gtm-checklist-${item.id}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-card text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span className={checked ? "text-muted-foreground line-through" : "text-foreground"}>
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <Alert variant="info">
              <ShieldCheckIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Catatan Performa &amp; CSP</AlertTitle>
              <AlertDescription>
                GTM tidak masuk anggaran JS inti PunyaSitus, tetapi setiap tag yang Anda pasang di
                GTM menambah beban browser pengunjung. GTM hanya dimuat di halaman publik setelah
                izin Analitik, dan tidak pernah dimuat di dashboard admin, pratinjau, atau halaman
                pemeliharaan.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>

      {/* Standard `ps_*` dataLayer Contract Reference */}
      <Card data-testid="gtm-datalayer-contract-card">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Kontrak Standar dataLayer PunyaSitus (ps_*)</CardTitle>
              <CardDescription>
                Dikirim otomatis oleh situs publik setelah izin Analitik aktif, tanpa data pribadi
                pengunjung maupun query string URL.
              </CardDescription>
            </div>
            <Badge variant="outline" className="font-mono">
              Skema v{GTM_DATALAYER_CONTRACT_VERSION}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {/* Mobile stacked cards (< md) — guarantees zero horizontal overflow at 360px */}
          <div className="space-y-3 md:hidden" data-testid="gtm-datalayer-mobile-list">
            {GTM_DATALAYER_EVENT_DOCS.map((row) => (
              <div
                key={row.event}
                className="space-y-2 rounded-md border border-border bg-background p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{row.labelId}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                    {row.event}
                  </code>
                </div>
                <p className="text-muted-foreground">{row.triggerRuleId}</p>
                <div className="flex flex-wrap gap-1">
                  {row.fields.map((field) => (
                    <code
                      key={field}
                      className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {field}
                    </code>
                  ))}
                </div>
                <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                  Privasi: {row.piiPolicyId}
                </p>
              </div>
            ))}
          </div>

          {/* Desktop compact table (>= md) */}
          <div className="hidden md:block">
            <Table data-testid="gtm-datalayer-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Peristiwa dataLayer</TableHead>
                  <TableHead>Field Standar (Bebas PII)</TableHead>
                  <TableHead>Aturan Pemicu &amp; Privasi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {GTM_DATALAYER_EVENT_DOCS.map((row) => (
                  <TableRow key={row.event}>
                    <TableCell className="align-top">
                      <div className="font-medium text-foreground">{row.labelId}</div>
                      <code className="font-mono text-xs text-muted-foreground">{row.event}</code>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap gap-1">
                        {row.fields.map((field) => (
                          <code
                            key={field}
                            className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
                          >
                            {field}
                          </code>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-sm whitespace-normal align-top text-xs text-muted-foreground">
                      <p className="text-foreground">{row.triggerRuleId}</p>
                      <p className="mt-0.5">{row.piiPolicyId}</p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Owner-Only Audited Risk Acknowledgement Dialog (@base-ui/react/dialog) */}
      <Dialog.Root open={riskDialogOpen} onOpenChange={setRiskDialogOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-[55] bg-foreground/45 transition-opacity duration-150" />
          <Dialog.Popup
            data-testid="gtm-risk-ack-dialog"
            className="fixed top-1/2 left-1/2 z-[60] max-h-[90dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-card p-5 text-foreground shadow-lg outline-none"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
              <div className="space-y-1">
                <Dialog.Title className="text-lg font-semibold">
                  Persetujuan Risiko Aktivasi Google Tag Manager
                </Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">
                  Kontainer <code className="font-mono text-foreground">{trimmedContainer}</code> ·
                  Pernyataan Risiko Versi {GTM_RISK_ACK_VERSION} (Khusus Pemilik Situs, dicatat pada
                  log audit).
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="min-h-11 min-w-11 shrink-0 md:min-h-8 md:min-w-8"
                    aria-label="Tutup dialog persetujuan risiko GTM"
                    data-testid="gtm-risk-dialog-close"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form onSubmit={handleConfirmEnableGtm} className="mt-4 space-y-4">
              {riskDialogError && (
                <Alert variant="destructive" data-testid="gtm-risk-dialog-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Tidak dapat mengaktifkan GTM</AlertTitle>
                  <AlertDescription>{riskDialogError}</AlertDescription>
                </Alert>
              )}

              <ul className="space-y-2.5 text-xs">
                {GTM_RISK_ACK_STATEMENTS_ID.map((stmt) => (
                  <li
                    key={stmt.id}
                    className="rounded-md border border-border bg-muted/40 p-3 space-y-1"
                  >
                    <p className="font-semibold text-foreground">{stmt.title}</p>
                    <p className="leading-relaxed text-muted-foreground">{stmt.description}</p>
                  </li>
                ))}
              </ul>

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-warning-border bg-warning-soft p-3 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={riskChecked}
                  onChange={(e) => setRiskChecked(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  data-testid="gtm-risk-ack-checkbox"
                />
                <span>
                  Saya sebagai <strong>Pemilik Situs</strong> memahami seluruh risiko di atas dan
                  bertanggung jawab penuh atas setiap tag yang diterbitkan pada kontainer{" "}
                  <code className="font-mono">{trimmedContainer}</code>.
                </span>
              </label>

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
                <Dialog.Close
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      disabled={saving}
                      className="min-h-11 w-full sm:w-auto md:min-h-9"
                    />
                  }
                >
                  Batal
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="default"
                  disabled={saving || !riskChecked}
                  className="min-h-11 w-full sm:w-auto md:min-h-9"
                  data-testid="gtm-risk-ack-confirm-button"
                >
                  {saving ? "Mengaktifkan GTM..." : "Setujui Risiko & Aktifkan GTM"}
                </Button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
