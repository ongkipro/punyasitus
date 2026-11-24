import { useState } from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BellIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Link2Icon,
  LockIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  UnlinkIcon,
  WebhookIcon,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

/**
 * `base-nova` (`@base-ui/react`) Admin Settings Island for `lead-notifier` (`REQ-101`, `TASK-101`).
 *
 * Visual & Accessibility Contract:
 * - Pure Base UI (`render` prop composition) with standard Lucide icons.
 * - Explicit `htmlFor` / `id` pairings on every form control.
 * - `>= 44px` (`min-h-11 md:min-h-9`) touch targets on mobile.
 * - Clean Bahasa Indonesia copy for 1-click Telegram connect/disconnect (zero manual `chat_id`)
 *   and SSRF-guarded HMAC-SHA256 HTTPS Webhook configuration + test-send.
 */

export interface LeadNotifierDeliveryItem {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly channel: "telegram" | "webhook" | string;
  readonly status: "delivered" | "failed" | "skipped" | "timed_out" | string;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly targetSummary: string | null;
  readonly createdAt: number;
}

export interface LeadNotifierSettingsIslandProps {
  readonly basePath: string;
  readonly apiBaseUrl: string;
  readonly initialTelegram: {
    readonly enabled: boolean;
    readonly linked: boolean;
    readonly maskedLabel: string | null;
    readonly linkedAt: number | null;
    readonly botUsername: string;
    readonly tokenTtlSeconds: number;
  };
  readonly initialWebhook: {
    readonly entitled: boolean;
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly targetUrl: string | null;
    readonly targetUrlSummary?: string | null;
    readonly secretMasked: string | null;
    readonly maxRetries: number;
    readonly secretRotatedAt: number | null;
  };
  readonly initialDeliveries?: readonly LeadNotifierDeliveryItem[];
  readonly permissions: {
    readonly roleLabel: string;
    readonly isLocked: boolean;
    readonly canManagePlugins: boolean;
  };
}

function formatWibShort(epochMs: number | null): string {
  if (!epochMs) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

function deliveryStatusBadgeVariant(
  status: string,
): "success" | "destructive" | "warning" | "outline" {
  if (status === "delivered") return "success";
  if (status === "timed_out") return "warning";
  if (status === "failed") return "destructive";
  return "outline";
}

function deliveryStatusLabel(status: string): string {
  if (status === "delivered") return "Terkirim";
  if (status === "timed_out") return "Timeout";
  if (status === "failed") return "Gagal";
  if (status === "skipped") return "Dilewati";
  return status;
}

export function LeadNotifierSettingsIsland({
  basePath,
  apiBaseUrl,
  initialTelegram,
  initialWebhook,
  initialDeliveries = [],
  permissions,
}: LeadNotifierSettingsIslandProps) {
  const [telegram, setTelegram] = useState(initialTelegram);
  const [pendingDeepLink, setPendingDeepLink] = useState<{
    readonly deepLink: string;
    readonly expiresAt: number;
    readonly expiresInSeconds: number;
  } | null>(null);
  const [tgBusy, setTgBusy] = useState(false);

  const [webhook, setWebhook] = useState(initialWebhook);
  const [webhookUrlInput, setWebhookUrlInput] = useState(
    initialWebhook.targetUrl ?? initialWebhook.targetUrlSummary ?? "",
  );
  const [webhookEnabledInput, setWebhookEnabledInput] = useState(initialWebhook.enabled);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [whSaving, setWhSaving] = useState(false);
  const [whTesting, setWhTesting] = useState(false);
  const [whRotating, setWhRotating] = useState(false);

  const [deliveries, setDeliveries] = useState<readonly LeadNotifierDeliveryItem[]>(initialDeliveries);
  const [notice, setNotice] = useState<{
    readonly variant: "success" | "destructive" | "info" | "warning";
    readonly title: string;
    readonly description: string;
  } | null>(null);

  const canEdit = permissions.canManagePlugins && !permissions.isLocked;
  const cleanApiBase = apiBaseUrl.replace(/\/+$/, "");

  async function handleGenerateTelegramLink() {
    if (!canEdit || tgBusy) return;
    setTgBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${cleanApiBase}/telegram/link-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly deepLink?: string;
        readonly expiresAt?: number;
        readonly expiresInSeconds?: number;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.deepLink) {
        setNotice({
          variant: "destructive",
          title: "Gagal membuat tautan Telegram",
          description:
            data.error?.message ?? "Tidak dapat membuat tautan 1-klik Telegram saat ini.",
        });
        return;
      }
      setPendingDeepLink({
        deepLink: data.deepLink,
        expiresAt: data.expiresAt ?? Date.now() + 900_000,
        expiresInSeconds: data.expiresInSeconds ?? 900,
      });
      setNotice({
        variant: "info",
        title: "Tautan 1-klik Telegram siap dibuka",
        description:
          "Klik tombol Buka Telegram di bawah lalu tekan Mulai (Start) di aplikasi Telegram. Tautan hanya berlaku 15 menit untuk satu kali pakai.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Periksa koneksi internet Anda dan coba buat tautan Telegram kembali.",
      });
    } finally {
      setTgBusy(false);
    }
  }

  async function handleUnlinkTelegram() {
    if (!canEdit || tgBusy) return;
    setTgBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`${cleanApiBase}/telegram/unlink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly ok?: boolean;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.ok) {
        setNotice({
          variant: "destructive",
          title: "Gagal memutuskan Telegram",
          description: data.error?.message ?? "Terjadi kendala saat memutuskan koneksi Telegram.",
        });
        return;
      }
      setTelegram((prev) => ({
        ...prev,
        linked: false,
        maskedLabel: null,
        linkedAt: null,
      }));
      setPendingDeepLink(null);
      setNotice({
        variant: "info",
        title: "Koneksi Telegram diputuskan",
        description:
          "Pengiriman notifikasi prospek ke Telegram langsung dihentikan. Anda dapat menghubungkan ulang kapan saja dalam 1 klik.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Gagal memutuskan koneksi Telegram. Coba lagi beberapa saat lagi.",
      });
    } finally {
      setTgBusy(false);
    }
  }

  async function handleSaveWebhook(event: { readonly preventDefault: () => void }) {
    event.preventDefault();
    if (!canEdit || !webhook.entitled || whSaving) return;
    setWhSaving(true);
    setNotice(null);
    setSecretOnce(null);
    try {
      const response = await fetch(`${cleanApiBase}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUrl: webhookUrlInput.trim(),
          enabled: webhookEnabledInput,
          maxRetries: webhook.maxRetries,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly webhook?: {
          readonly configured: boolean;
          readonly enabled: boolean;
          readonly targetUrl: string;
          readonly secretMasked: string;
          readonly maxRetries: number;
          readonly secretRotatedAt: number;
        };
        readonly secretOnce?: string;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.webhook) {
        setNotice({
          variant: "destructive",
          title: "URL webhook ditolak",
          description:
            data.error?.message ??
            "Pastikan URL menggunakan HTTPS publik yang valid (bukan IP privat/localhost).",
        });
        return;
      }
      setWebhook((prev) => ({
        ...prev,
        configured: data.webhook!.configured,
        enabled: data.webhook!.enabled,
        targetUrl: data.webhook!.targetUrl,
        secretMasked: data.webhook!.secretMasked,
        maxRetries: data.webhook!.maxRetries,
        secretRotatedAt: data.webhook!.secretRotatedAt,
      }));
      if (data.secretOnce) {
        setSecretOnce(data.secretOnce);
      }
      setNotice({
        variant: "success",
        title: "Pengaturan webhook tersimpan",
        description:
          "Webhook HTTPS bertanda tangan HMAC-SHA256 telah disimpan dan siap menerima prospek baru.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Masukan URL webhook Anda tetap dipertahankan. Silakan coba simpan kembali.",
      });
    } finally {
      setWhSaving(false);
    }
  }

  async function handleRotateSecret() {
    if (!canEdit || !webhook.entitled || !webhook.configured || whRotating) return;
    setWhRotating(true);
    setNotice(null);
    try {
      const response = await fetch(`${cleanApiBase}/webhook/rotate-secret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly secretOnce?: string;
        readonly secretMasked?: string;
        readonly secretRotatedAt?: number;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !data.secretMasked) {
        setNotice({
          variant: "destructive",
          title: "Gagal memutar rahasia webhook",
          description: data.error?.message ?? "Tidak dapat memperbarui rahasia penandatanganan.",
        });
        return;
      }
      setWebhook((prev) => ({
        ...prev,
        secretMasked: data.secretMasked!,
        secretRotatedAt: data.secretRotatedAt ?? Date.now(),
      }));
      if (data.secretOnce) {
        setSecretOnce(data.secretOnce);
      }
      setNotice({
        variant: "success",
        title: "Rahasia HMAC-SHA256 diperbarui",
        description:
          "Salin rahasia baru di bawah sekarang dan perbarui konfigurasi penerima CRM/Sheets Anda.",
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Gagal memutar rahasia webhook. Coba lagi beberapa saat lagi.",
      });
    } finally {
      setWhRotating(false);
    }
  }

  async function handleTestWebhook() {
    if (!canEdit || !webhook.entitled || whTesting) return;
    setWhTesting(true);
    setNotice(null);
    try {
      const response = await fetch(`${cleanApiBase}/webhook/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUrl: webhookUrlInput.trim() || webhook.targetUrl || "",
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        readonly ok?: boolean;
        readonly delivery?: {
          readonly deliveryId: string;
          readonly status: string;
          readonly httpStatus: number | null;
          readonly attempts: number;
          readonly errorCode: string | null;
          readonly targetSummary: string;
        };
        readonly error?: { readonly message?: string };
      };

      if (data.delivery) {
        const newEntry: LeadNotifierDeliveryItem = {
          deliveryId: data.delivery.deliveryId,
          eventName: "lead.test",
          channel: "webhook",
          status: data.delivery.status,
          httpStatus: data.delivery.httpStatus,
          attempts: data.delivery.attempts,
          errorCode: data.delivery.errorCode,
          targetSummary: data.delivery.targetSummary,
          createdAt: Date.now(),
        };
        setDeliveries((prev) => [newEntry, ...prev].slice(0, 20));
      }

      if (!response.ok || !data.ok) {
        setNotice({
          variant: "destructive",
          title: "Pengiriman uji webhook gagal",
          description:
            data.error?.message ??
            (data.delivery?.errorCode
              ? `Endpoint tujuan gagal merespons (${data.delivery.errorCode}). Pengisian formulir pengunjung tetap tidak akan terganggu.`
              : "Gagal mengirim payload uji ke URL webhook."),
        });
        return;
      }

      setNotice({
        variant: "success",
        title: "Webhook uji berhasil diterima",
        description: `Endpoint merespons HTTP ${data.delivery?.httpStatus ?? 200} dalam ${data.delivery?.attempts ?? 1} percobaan dengan tanda tangan HMAC-SHA256 valid.`,
      });
    } catch {
      setNotice({
        variant: "destructive",
        title: "Koneksi terputus",
        description: "Gagal menjalankan uji pengiriman webhook. Coba lagi beberapa saat lagi.",
      });
    } finally {
      setWhTesting(false);
    }
  }

  return (
    <section
      className="space-y-6"
      data-testid="lead-notifier-settings"
      aria-labelledby="lead-notifier-heading"
    >
      {/* Back navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 px-2 md:min-h-8"
          render={<a href={`${basePath}/plugins`} />}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke daftar Plugin
        </Button>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={telegram.linked ? "success" : "outline"} data-testid="telegram-status-badge">
            <BellIcon className="size-3" aria-hidden="true" />
            {telegram.linked ? "Telegram Terhubung" : "Telegram Belum Terhubung"}
          </Badge>
          <Badge variant={webhook.entitled ? "info" : "secondary"} data-testid="webhook-tier-badge">
            <WebhookIcon className="size-3" aria-hidden="true" />
            {webhook.entitled ? "Webhook Pro Aktif" : "Webhook Add-on Pro"}
          </Badge>
        </div>
      </div>

      {/* Header */}
      <div className="space-y-1">
        <h1
          id="lead-notifier-heading"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          Lead Notifier (Telegram & Webhook)
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Terima peringatan prospek baru secara instan di Telegram dengan tombol balas WhatsApp,
          atau teruskan payload bertanda tangan HMAC-SHA256 ke CRM dan Google Sheets tanpa pernah
          menghambat pengiriman formulir pengunjung.
        </p>
      </div>

      {/* Role / Lock Guardrails */}
      {permissions.isLocked ? (
        <Alert variant="warning" data-testid="lead-notifier-locked-alert">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Langganan terkunci (Mode hanya-baca)</AlertTitle>
          <AlertDescription>
            Perpanjang langganan untuk menghubungkan Telegram atau mengubah pengaturan webhook.
          </AlertDescription>
        </Alert>
      ) : !permissions.canManagePlugins ? (
        <Alert variant="info">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode lihat saja ({permissions.roleLabel})</AlertTitle>
          <AlertDescription>
            Hubungi Pemilik Situs atau Admin untuk mengelola notifikasi Telegram dan webhook.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Live status feedback */}
      {notice ? (
        <Alert variant={notice.variant} data-testid="lead-notifier-notice">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Card 1: 1-Click Telegram Bot Linking (public_free) */}
        <Card data-testid="telegram-connect-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <BellIcon className="size-4 text-primary" aria-hidden="true" />
                Notifikasi Telegram 1-Klik
              </CardTitle>
              <Badge variant="success">Gratis</Badge>
            </div>
            <CardDescription>
              Hubungkan chat Telegram Anda dalam satu klik tanpa perlu mencari atau mengetik{" "}
              <code className="font-mono text-xs">chat_id</code> manual. Setiap pesan prospek
              menyertakan tombol langsung balas ke WhatsApp.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex-1 space-y-4">
            {telegram.linked ? (
              <div
                className="space-y-2 rounded-md border border-success-border bg-success-soft p-3.5 text-sm"
                data-testid="telegram-connected-panel"
              >
                <div className="flex items-center gap-2 font-medium text-success">
                  <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span>Terhubung ke Telegram</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
                  <span className="text-muted-foreground">Akun / Chat Tersamarkan</span>
                  <span className="font-mono font-medium" data-testid="telegram-masked-label">
                    {telegram.maskedLabel ?? "Telegram #***"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground">
                  <span className="text-muted-foreground">Terhubung sejak</span>
                  <span>{formatWibShort(telegram.linkedAt)}</span>
                </div>
              </div>
            ) : (
              <div
                className="space-y-2 rounded-md border border-border bg-muted/40 p-3.5 text-sm"
                data-testid="telegram-disconnected-panel"
              >
                <p className="font-medium text-foreground">Belum ada chat Telegram yang terhubung</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Klik tombol <strong>Hubungkan Telegram</strong> untuk membuat tautan khusus satu
                  kali pakai yang berlaku selama <strong>15 menit</strong>, lalu tekan{" "}
                  <strong>Start</strong> pada bot{" "}
                  <span className="font-mono">@{telegram.botUsername}</span>.
                </p>
              </div>
            )}

            {pendingDeepLink ? (
              <div
                className="space-y-3 rounded-md border border-info-border bg-info-soft p-3.5"
                data-testid="telegram-deeplink-box"
              >
                <div className="flex items-start gap-2 text-xs text-info">
                  <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>
                    Tautan satu kali pakai berlaku <strong>15 menit</strong> (hingga{" "}
                    {formatWibShort(pendingDeepLink.expiresAt)}). Token hanya disimpan dalam bentuk
                    hash terenkripsi.
                  </span>
                </div>
                <Button
                  variant="default"
                  size="sm"
                  className="min-h-11 w-full md:min-h-9"
                  data-testid="telegram-open-deeplink-btn"
                  render={
                    <a
                      href={pendingDeepLink.deepLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  <ExternalLinkIcon className="size-4" aria-hidden="true" />
                  Buka Telegram (@{telegram.botUsername})
                </Button>
              </div>
            ) : null}
          </CardContent>

          <CardFooter className="flex flex-wrap items-center justify-between gap-2">
            {telegram.linked ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!canEdit || tgBusy}
                  onClick={() => void handleGenerateTelegramLink()}
                  data-testid="telegram-relink-btn"
                >
                  <Link2Icon className="size-4" aria-hidden="true" />
                  {tgBusy ? "Membuat tautan..." : "Ganti Chat Telegram"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!canEdit || tgBusy}
                  onClick={() => void handleUnlinkTelegram()}
                  data-testid="telegram-unlink-btn"
                >
                  <UnlinkIcon className="size-4" aria-hidden="true" />
                  {tgBusy ? "Memutuskan..." : "Putuskan Telegram"}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                disabled={!canEdit || tgBusy}
                onClick={() => void handleGenerateTelegramLink()}
                data-testid="telegram-connect-btn"
              >
                <Link2Icon className="size-4" aria-hidden="true" />
                {tgBusy ? "Menyiapkan tautan..." : "Hubungkan Telegram"}
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* Card 2: Signed SSRF-Guarded HTTPS Webhook (public_paid / grantable) */}
        <Card data-testid="webhook-config-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <WebhookIcon className="size-4 text-primary" aria-hidden="true" />
                Webhook HTTPS CRM / Google Sheets
              </CardTitle>
              <Badge variant={webhook.entitled ? "info" : "outline"}>
                {webhook.entitled ? "Aktif" : "Add-on Pro"}
              </Badge>
            </div>
            <CardDescription>
              Teruskan setiap prospek baru ke Google Sheets, CRM, Zapier, atau n8n dengan tanda
              tangan <code className="font-mono text-xs">X-PunyaSitus-Signature</code> (HMAC-SHA256)
              dan proteksi SSRF penuh.
            </CardDescription>
          </CardHeader>

          <form
            className="flex flex-1 flex-col justify-between gap-4"
            onSubmit={(e) => void handleSaveWebhook(e)}
          >
            <CardContent className="flex-1 space-y-4">
              {!webhook.entitled ? (
                <Alert variant="info" data-testid="webhook-entitlement-gate">
                  <LockIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Memerlukan lisensi Add-on Pro</AlertTitle>
                  <AlertDescription>
                    Notifikasi Telegram 1-klik sudah aktif gratis. Untuk mengirim data prospek ke
                    webhook HTTPS CRM/Sheets, aktifkan add-on berbayar atau minta pemberian akses
                    dari tim PunyaSitus.
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-1.5">
                <label
                  htmlFor="ln-webhook-url"
                  className="text-sm font-medium text-foreground"
                >
                  URL Tujuan Webhook (Wajib HTTPS)
                </label>
                <Input
                  id="ln-webhook-url"
                  name="targetUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://hooks.crm-anda.com/punyasitus/leads"
                  value={webhookUrlInput}
                  disabled={!canEdit || !webhook.entitled || whSaving}
                  onChange={(e) => setWebhookUrlInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Hanya domain HTTPS publik yang diizinkan. Alamat lokal/privat (localhost, 127.x,
                  10.x, 192.168.x, 169.254.x, IPv6 internal) otomatis diblokir.
                </p>
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
                <div className="space-y-0.5">
                  <label
                    htmlFor="ln-webhook-enabled"
                    className="text-sm font-medium text-foreground"
                  >
                    Aktifkan pengiriman otomatis prospek baru
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Mencoba ulang hingga {webhook.maxRetries} kali jika server tujuan 5xx/timeout.
                  </p>
                </div>
                <input
                  id="ln-webhook-enabled"
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={webhookEnabledInput}
                  disabled={!canEdit || !webhook.entitled || whSaving}
                  onChange={(e) => setWebhookEnabledInput(e.target.checked)}
                />
              </div>

              {webhook.secretMasked ? (
                <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <KeyRoundIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      Rahasia HMAC-SHA256
                    </span>
                    <span className="font-mono text-foreground" data-testid="webhook-secret-masked">
                      {webhook.secretMasked}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                    <span>Header verifikasi</span>
                    <span className="font-mono">X-PunyaSitus-Signature: t=&lt;ts&gt;,v1=&lt;hex&gt;</span>
                  </div>
                </div>
              ) : null}

              {secretOnce ? (
                <Alert variant="warning" data-testid="webhook-secret-once">
                  <ShieldCheckIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Simpan rahasia penandatanganan ini sekarang</AlertTitle>
                  <AlertDescription>
                    <span className="block">
                      Nilai penuh hanya ditampilkan satu kali demi keamanan:
                    </span>
                    <code className="mt-1 block break-all rounded bg-card px-2 py-1 font-mono text-xs text-foreground">
                      {secretOnce}
                    </code>
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>

            <CardFooter className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!canEdit || !webhook.entitled || whSaving}
                  data-testid="webhook-save-btn"
                >
                  {whSaving ? "Menyimpan..." : "Simpan Webhook"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!canEdit || !webhook.entitled || whTesting || !webhookUrlInput.trim()}
                  onClick={() => void handleTestWebhook()}
                  data-testid="webhook-test-btn"
                >
                  <SendIcon className="size-4" aria-hidden="true" />
                  {whTesting ? "Mengirim uji..." : "Kirim Uji Webhook"}
                </Button>
              </div>

              {webhook.configured ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 md:min-h-9"
                  disabled={!canEdit || !webhook.entitled || whRotating}
                  onClick={() => void handleRotateSecret()}
                  data-testid="webhook-rotate-btn"
                >
                  <RefreshCwIcon className="size-4" aria-hidden="true" />
                  {whRotating ? "Memutar..." : "Putar Rahasia"}
                </Button>
              ) : null}
            </CardFooter>
          </form>
        </Card>
      </div>

      {/* Card 3: Recent Delivery Log */}
      <Card data-testid="lead-notifier-deliveries-card">
        <CardHeader>
          <CardTitle className="text-sm">Riwayat Pengiriman Notifikasi Terbaru</CardTitle>
          <CardDescription>
            Kegagalan pengiriman notifikasi tidak pernah membatalkan penyimpanan data prospek di
            dashboard Anda.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Belum ada riwayat pengiriman notifikasi pada situs ini.
            </p>
          ) : (
            <div className="divide-y divide-border" data-testid="lead-notifier-deliveries-list">
              {deliveries.map((item) => (
                <div
                  key={item.deliveryId}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="uppercase">
                        {item.channel}
                      </Badge>
                      <Badge variant={deliveryStatusBadgeVariant(item.status)}>
                        {deliveryStatusLabel(item.status)}
                      </Badge>
                      <span className="font-mono text-muted-foreground">{item.eventName}</span>
                    </div>
                    <p className="truncate text-muted-foreground">
                      {item.targetSummary ?? "—"}
                      {item.httpStatus !== null ? ` · HTTP ${item.httpStatus}` : ""}
                      {item.errorCode ? ` · ${item.errorCode}` : ""}
                    </p>
                  </div>

                  <div className="text-right text-muted-foreground">
                    <div>{item.attempts}x coba</div>
                    <div>{formatWibShort(item.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Separator className="my-3" />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Namespace tabel terisolasi</span>
            <span className="font-mono text-foreground">plg_lead_notifier__*</span>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
