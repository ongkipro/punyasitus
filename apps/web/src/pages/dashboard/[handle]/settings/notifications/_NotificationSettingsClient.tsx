import { useCallback, useState } from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BellIcon,
  BellOffIcon,
  CalendarIcon,
  CheckCircle2Icon,
  MailIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export interface NotificationDeliveryHistoryItem {
  readonly reportMonth: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly updatedAt: number;
}

export interface NotificationSettingsClientProps {
  readonly handle: string;
  readonly workspaceName: string;
  readonly basePath: string;
  readonly initialMonthlyReportEnabled: boolean;
  readonly initialUpdatedAt: number | null;
  readonly recentDeliveries: readonly NotificationDeliveryHistoryItem[];
}

function formatUpdatedAtId(timestampMs: number | null): string | null {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestampMs));
  } catch {
    return null;
  }
}

function deliveryStatusMeta(status: string, errorCode: string | null): {
  readonly label: string;
  readonly variant: "success" | "secondary" | "warning" | "destructive";
  readonly detail: string;
} {
  if (status === "submitted") {
    return { label: "Terkirim", variant: "success", detail: "Email laporan dikirim ke pemilik situs." };
  }
  if (status === "skipped") {
    if (errorCode === "E_BELOW_ACTIVITY_THRESHOLD") {
      return {
        label: "Dilewati",
        variant: "secondary",
        detail: "Aktivitas bulan tersebut di bawah ambang minimum.",
      };
    }
    if (errorCode === "E_REPORT_OPTED_OUT") {
      return { label: "Nonaktif", variant: "secondary", detail: "Laporan bulanan dimatikan oleh pemilik." };
    }
    return { label: "Dilewati", variant: "secondary", detail: "Pengiriman dilewati oleh sistem." };
  }
  if (status === "unknown") {
    return {
      label: "Status Tidak Pasti",
      variant: "warning",
      detail: "Tidak dikirim ulang otomatis demi mencegah duplikasi email.",
    };
  }
  return {
    label: "Gagal",
    variant: "destructive",
    detail: "Gagal dikirim dan tidak dikirim ulang otomatis.",
  };
}

export function NotificationSettingsClient(props: NotificationSettingsClientProps) {
  const [enabled, setEnabled] = useState<boolean>(props.initialMonthlyReportEnabled);
  const [updatedAt, setUpdatedAt] = useState<number | null>(props.initialUpdatedAt);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly kind: "success" | "error";
    readonly message: string;
  } | null>(null);

  const apiUrl = `${props.basePath}/settings/notifications/api`;
  const updatedAtLabel = formatUpdatedAtId(updatedAt);

  const handleToggle = useCallback(async () => {
    if (saving) return;
    const nextValue = !enabled;
    setSaving(true);
    setFeedback(null);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          monthlyPerformanceReportEnabled: nextValue,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        readonly success?: boolean;
        readonly message?: string;
        readonly preferences?: {
          readonly monthlyPerformanceReportEnabled: boolean;
          readonly updatedAt: number | null;
        };
      } | null;

      if (!response.ok || !body?.success) {
        setFeedback({
          kind: "error",
          message:
            body?.message ??
            "Gagal menyimpan preferensi notifikasi. Silakan coba lagi beberapa saat lagi.",
        });
        return;
      }

      setEnabled(body.preferences?.monthlyPerformanceReportEnabled ?? nextValue);
      setUpdatedAt(body.preferences?.updatedAt ?? Date.now());
      setFeedback({
        kind: "success",
        message:
          body.message ??
          (nextValue
            ? "Email laporan performa bulanan diaktifkan."
            : "Email laporan performa bulanan dinonaktifkan."),
      });
    } catch {
      setFeedback({
        kind: "error",
        message: "Koneksi terganggu saat menyimpan preferensi. Silakan periksa jaringan Anda.",
      });
    } finally {
      setSaving(false);
    }
  }, [apiUrl, enabled, saving]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <a
            href={`${props.basePath}/settings`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            Kembali ke Pengaturan
          </a>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Notifikasi Email
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola pengiriman email laporan performa bulanan untuk{" "}
            <span className="font-medium text-foreground">{props.workspaceName}</span>.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          render={<a href={`${props.basePath}/insights`} />}
          nativeButton={false}
        >
          <BarChart3Icon className="size-4" aria-hidden="true" />
          Buka Ringkasan Insights
        </Button>
      </div>

      {feedback && (
        <Alert
          variant={feedback.kind === "success" ? "success" : "destructive"}
          role={feedback.kind === "error" ? "alert" : "status"}
          data-testid="notification-feedback"
        >
          {feedback.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>
            {feedback.kind === "success" ? "Preferensi tersimpan" : "Gagal menyimpan"}
          </AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-primary">
                {enabled ? (
                  <BellIcon className="size-5" aria-hidden="true" />
                ) : (
                  <BellOffIcon className="size-5" aria-hidden="true" />
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle id="monthly-report-toggle-label" className="text-base">
                    Laporan Performa Bulanan
                  </CardTitle>
                  <Badge
                    variant={enabled ? "success" : "secondary"}
                    data-testid="monthly-report-status-badge"
                  >
                    {enabled ? "Aktif" : "Nonaktif"}
                  </Badge>
                </div>
                <CardDescription>
                  Ringkasan performa website bulan sebelumnya dikirim otomatis pada tanggal 1 setiap bulan.
                </CardDescription>
              </div>
            </div>

            <div className="flex shrink-0 items-center pt-1">
              <button
                type="button"
                role="switch"
                id="monthly-report-switch"
                data-testid="monthly-report-toggle"
                aria-checked={enabled}
                aria-labelledby="monthly-report-toggle-label"
                aria-busy={saving}
                disabled={saving}
                onClick={handleToggle}
                className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                  enabled ? "bg-primary" : "bg-border"
                }`}
              >
                <span className="sr-only">
                  {enabled
                    ? "Matikan email laporan performa bulanan"
                    : "Aktifkan email laporan performa bulanan"}
                </span>
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block size-5 rounded-full bg-white shadow-xs transition-transform ${
                    enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
        </CardHeader>

        <Separator />

        <CardContent className="space-y-4 pt-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/70 p-3.5">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-foreground">
                <CalendarIcon className="size-3.5 text-primary" aria-hidden="true" />
                Jadwal &amp; Isi Ringkasan
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Dikirim setiap <strong>tanggal 1 (WIB)</strong> berisi kunjungan, pesan masuk, klik
                WhatsApp, penawaran terpopuler, rujukan asisten AI, perbandingan bulan sebelumnya,
                serta 1 saran peningkatan.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-background/70 p-3.5">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-foreground">
                <ShieldCheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                Privasi &amp; Ambang Minimum
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                <strong>Bebas data pribadi pengunjung</strong> (tanpa IP, nama, email, atau nomor
                telepon pengunjung). Situs beraktivitas rendah (&lt; 5 kunjungan dan 0 pesan/klik
                WhatsApp) tidak menerima email.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg border border-border/80 bg-secondary/50 px-3.5 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <MailIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span className="leading-relaxed">
                Dikirim hanya ke akun <strong className="text-foreground">Pemilik Situs (Owner)</strong> dari{" "}
                <code className="break-all rounded bg-card px-1 py-0.5 text-[11px] text-foreground">
                  noreply@notif.punyasitus.com
                </code>
              </span>
            </div>
            {updatedAtLabel && (
              <span className="shrink-0" data-testid="monthly-report-updated-at">
                Diperbarui {updatedAtLabel} WIB
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {props.recentDeliveries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Riwayat Pengiriman Terakhir</CardTitle>
            <CardDescription>
              Status pengiriman laporan bulanan terbaru tanpa menyimpan data pribadi penerima atau pengunjung.
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="divide-y divide-border p-0">
            {props.recentDeliveries.map((item) => {
              const meta = deliveryStatusMeta(item.status, item.errorCode);
              return (
                <div
                  key={item.reportMonth}
                  className="flex flex-col gap-1.5 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      Periode {item.reportMonth}
                    </div>
                    <p className="text-xs text-muted-foreground">{meta.detail}</p>
                  </div>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
