import * as React from "react";
import { resolveDashboardSupportModel } from "@punyasitus/core/support/index";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Clock,
  ExternalLink,
  MessageCircle,
  RefreshCwIcon,
  SaveIcon,
  ShieldAlertIcon,
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

export interface PlatformSettingsViewData {
  readonly salesWhatsapp: string;
  readonly supportEmail: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
  readonly supportHours: string | null;
  readonly supportResponseTarget: string | null;
  readonly monthlyPriceIdr: number;
  readonly yearlyPriceIdr: number;
  readonly configured: boolean;
  readonly version: number;
  readonly updatedBy: string | null;
  readonly updatedAt: number | null;
}

export interface SettingsFormProps {
  readonly initialSettings: PlatformSettingsViewData;
  readonly stepUpFresh: boolean;
}

function formatUpdatedAt(ms: number | null): string {
  if (!ms) return "Belum pernah disimpan";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function SettingsForm({ initialSettings, stepUpFresh }: SettingsFormProps) {
  const [version, setVersion] = React.useState(initialSettings.version);
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(initialSettings.updatedAt);

  const [salesWhatsapp, setSalesWhatsapp] = React.useState(initialSettings.salesWhatsapp);
  const [supportEmail, setSupportEmail] = React.useState(initialSettings.supportEmail);
  const [termsUrl, setTermsUrl] = React.useState(initialSettings.termsUrl);
  const [privacyUrl, setPrivacyUrl] = React.useState(initialSettings.privacyUrl);
  const [supportHours, setSupportHours] = React.useState(initialSettings.supportHours ?? "");
  const [supportResponseTarget, setSupportResponseTarget] = React.useState(
    initialSettings.supportResponseTarget ?? "",
  );
  const [monthlyPriceIdr, setMonthlyPriceIdr] = React.useState(
    String(initialSettings.monthlyPriceIdr),
  );
  const [yearlyPriceIdr, setYearlyPriceIdr] = React.useState(
    String(initialSettings.yearlyPriceIdr),
  );
  const [reason, setReason] = React.useState("");

  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const [errorBanner, setErrorBanner] = React.useState<{
    readonly code: string;
    readonly message: string;
    readonly verifyPath?: string;
  } | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  async function handleReloadLatest() {
    setReloading(true);
    setErrorBanner(null);
    try {
      const res = await fetch("/api/console/settings", {
        method: "GET",
        credentials: "same-origin",
      });
      const data = (await res.json()) as {
        success?: boolean;
        settings?: PlatformSettingsViewData;
        message?: string;
      };
      if (!res.ok || !data.success || !data.settings) {
        setErrorBanner({
          code: "LOAD_FAILED",
          message: data.message ?? "Gagal memuat versi terbaru pengaturan.",
        });
        return;
      }
      setSalesWhatsapp(data.settings.salesWhatsapp);
      setSupportEmail(data.settings.supportEmail);
      setTermsUrl(data.settings.termsUrl);
      setPrivacyUrl(data.settings.privacyUrl);
      setSupportHours(data.settings.supportHours ?? "");
      setSupportResponseTarget(data.settings.supportResponseTarget ?? "");
      setMonthlyPriceIdr(String(data.settings.monthlyPriceIdr));
      setYearlyPriceIdr(String(data.settings.yearlyPriceIdr));
      setVersion(data.settings.version);
      setUpdatedAt(data.settings.updatedAt);
      setFieldErrors({});
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat ulang pengaturan.",
      });
    } finally {
      setReloading(false);
    }
  }

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorBanner(null);
    setSuccessMessage(null);
    setFieldErrors({});

    const localErrors: Record<string, string> = {};
    if (!salesWhatsapp.trim()) {
      localErrors.salesWhatsapp = "Nomor WhatsApp penjualan wajib diisi (08 / 628 / +628).";
    }
    if (!supportEmail.trim()) {
      localErrors.supportEmail = "Email dukungan wajib diisi.";
    }
    if (!termsUrl.trim()) {
      localErrors.termsUrl = "URL Syarat & Ketentuan HTTPS wajib diisi.";
    }
    if (!privacyUrl.trim()) {
      localErrors.privacyUrl = "URL Kebijakan Privasi HTTPS wajib diisi.";
    }
    if (reason.trim().length < 10) {
      localErrors.reason = "Alasan perubahan audit wajib diisi minimal 10 karakter.";
    }
    if (supportHours.trim().length > 120) {
      localErrors.supportHours = "Jam layanan dukungan maksimal 120 karakter.";
    }
    if (supportResponseTarget.trim().length > 120) {
      localErrors.supportResponseTarget = "Target waktu respons maksimal 120 karakter.";
    }

    const parsedMonthly = Number(monthlyPriceIdr.trim());
    const parsedYearly = Number(yearlyPriceIdr.trim());
    if (!Number.isSafeInteger(parsedMonthly) || parsedMonthly < 10_000) {
      localErrors.monthlyPriceIdr = "Harga bulanan harus berupa bilangan bulat minimal Rp 10.000.";
    }
    if (!Number.isSafeInteger(parsedYearly) || parsedYearly < 10_000) {
      localErrors.yearlyPriceIdr = "Harga tahunan harus berupa bilangan bulat minimal Rp 10.000.";
    }

    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/console/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          salesWhatsapp: salesWhatsapp.trim(),
          supportEmail: supportEmail.trim(),
          termsUrl: termsUrl.trim(),
          privacyUrl: privacyUrl.trim(),
          supportHours: supportHours.trim() || null,
          supportResponseTarget: supportResponseTarget.trim() || null,
          monthlyPriceIdr: parsedMonthly,
          yearlyPriceIdr: parsedYearly,
          expectedVersion: version,
          reason: reason.trim(),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        verifyPath?: string;
        settings?: PlatformSettingsViewData;
        fields?: readonly { readonly field: string; readonly message: string }[];
      };

      if (!res.ok || !data.success || !data.settings) {
        if (Array.isArray(data.fields) && data.fields.length > 0) {
          const mapped: Record<string, string> = {};
          for (const f of data.fields) {
            mapped[f.field] = f.message;
          }
          setFieldErrors(mapped);
        }
        setErrorBanner({
          code: data.code ?? "UPDATE_FAILED",
          message: data.message ?? "Gagal menyimpan pengaturan platform.",
          verifyPath: data.verifyPath,
        });
        return;
      }

      setSalesWhatsapp(data.settings.salesWhatsapp);
      setSupportEmail(data.settings.supportEmail);
      setTermsUrl(data.settings.termsUrl);
      setPrivacyUrl(data.settings.privacyUrl);
      setSupportHours(data.settings.supportHours ?? "");
      setSupportResponseTarget(data.settings.supportResponseTarget ?? "");
      setMonthlyPriceIdr(String(data.settings.monthlyPriceIdr));
      setYearlyPriceIdr(String(data.settings.yearlyPriceIdr));
      setVersion(data.settings.version);
      setUpdatedAt(data.settings.updatedAt);
      setReason("");
      setSuccessMessage(
        `Pengaturan platform berhasil disimpan (versi ${data.settings.version}) dan tercatat di log audit.`,
      );
    } catch {
      setErrorBanner({
        code: "NETWORK_ERROR",
        message:
          "Koneksi terputus saat menyimpan pengaturan. Isian formulir Anda tetap dipertahankan.",
      });
    } finally {
      setPending(false);
    }
  }

  const supportPreview = React.useMemo(
    () =>
      resolveDashboardSupportModel({
        handle: "kopi-nusantara",
        screen: "settings",
        platformSettings: {
          salesWhatsapp: salesWhatsapp.trim(),
          supportEmail: supportEmail.trim(),
          supportHours: supportHours.trim() || null,
          supportResponseTarget: supportResponseTarget.trim() || null,
          configured: salesWhatsapp.trim().length > 0,
        },
      }),
    [salesWhatsapp, supportEmail, supportHours, supportResponseTarget],
  );

  return (
    <div className="space-y-5" data-testid="console-settings-panel">
      {!stepUpFresh && (
        <Alert variant="warning" data-testid="settings-reauth-warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Verifikasi ulang 2FA diperlukan untuk menyimpan perubahan</AlertTitle>
          <AlertDescription>
            Perubahan pengaturan publik platform memerlukan verifikasi 2FA dalam 10 menit terakhir.{" "}
            <a
              href="/auth/two-factor?mode=verify&next=%2Fconsole%2Fsettings"
              className="font-medium underline underline-offset-4"
            >
              Verifikasi ulang 2FA sekarang
            </a>
            .
          </AlertDescription>
        </Alert>
      )}

      {errorBanner && (
        <Alert variant="destructive" data-testid="settings-error-alert" aria-live="assertive">
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal menyimpan pengaturan ({errorBanner.code})</AlertTitle>
          <AlertDescription>
            <span>{errorBanner.message}</span>
            {errorBanner.verifyPath && (
              <>
                {" "}
                <a
                  href={`${errorBanner.verifyPath}&next=${encodeURIComponent("/console/settings")}`}
                  className="font-medium underline underline-offset-4"
                >
                  Verifikasi ulang 2FA
                </a>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {successMessage && (
        <Alert variant="success" data-testid="settings-success-alert" aria-live="polite">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Pengaturan tersimpan</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Pengaturan Publik & Kontak Platform</CardTitle>
              <CardDescription>
                Divalidasi ketat di server (E.164 Indonesia, email valid, HTTPS publik aman) dan
                disimpan secara atomik bersama catatan <code className="font-mono">platform_audit</code>.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="tabular-nums" data-testid="settings-version-badge">
                Versi {version}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <form
            onSubmit={handleSubmit}
            noValidate
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
            data-testid="platform-settings-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="settings-sales-whatsapp"
                className="block text-sm font-medium text-foreground"
              >
                WhatsApp Resmi &amp; Dukungan Platform (E.164 Indonesia)
              </label>
              <Input
                id="settings-sales-whatsapp"
                name="salesWhatsapp"
                type="tel"
                placeholder="6281234567890"
                value={salesWhatsapp}
                onChange={(e) => {
                  setSalesWhatsapp(e.target.value);
                  if (fieldErrors.salesWhatsapp) {
                    setFieldErrors((prev) => ({ ...prev, salesWhatsapp: "" }));
                  }
                }}
                aria-invalid={fieldErrors.salesWhatsapp ? "true" : undefined}
                aria-describedby={
                  fieldErrors.salesWhatsapp ? "err-salesWhatsapp" : "hint-salesWhatsapp"
                }
                disabled={pending}
                className="tabular-nums"
              />
              {fieldErrors.salesWhatsapp ? (
                <p id="err-salesWhatsapp" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.salesWhatsapp}
                </p>
              ) : (
                <p id="hint-salesWhatsapp" className="text-xs text-muted-foreground">
                  Dipakai tombol bantuan WhatsApp di dasbor pengguna &amp; CTA penjualan.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-support-email"
                className="block text-sm font-medium text-foreground"
              >
                Email Dukungan Platform
              </label>
              <Input
                id="settings-support-email"
                name="supportEmail"
                type="email"
                placeholder="support@punyasitus.com"
                value={supportEmail}
                onChange={(e) => {
                  setSupportEmail(e.target.value);
                  if (fieldErrors.supportEmail) {
                    setFieldErrors((prev) => ({ ...prev, supportEmail: "" }));
                  }
                }}
                aria-invalid={fieldErrors.supportEmail ? "true" : undefined}
                aria-describedby={fieldErrors.supportEmail ? "err-supportEmail" : undefined}
                disabled={pending}
              />
              {fieldErrors.supportEmail && (
                <p id="err-supportEmail" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.supportEmail}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-terms-url"
                className="block text-sm font-medium text-foreground"
              >
                URL Syarat & Ketentuan (HTTPS Publik)
              </label>
              <Input
                id="settings-terms-url"
                name="termsUrl"
                type="url"
                placeholder="https://punyasitus.com/syarat-ketentuan"
                value={termsUrl}
                onChange={(e) => {
                  setTermsUrl(e.target.value);
                  if (fieldErrors.termsUrl) {
                    setFieldErrors((prev) => ({ ...prev, termsUrl: "" }));
                  }
                }}
                aria-invalid={fieldErrors.termsUrl ? "true" : undefined}
                aria-describedby={fieldErrors.termsUrl ? "err-termsUrl" : undefined}
                disabled={pending}
              />
              {fieldErrors.termsUrl && (
                <p id="err-termsUrl" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.termsUrl}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-privacy-url"
                className="block text-sm font-medium text-foreground"
              >
                URL Kebijakan Privasi (HTTPS Publik)
              </label>
              <Input
                id="settings-privacy-url"
                name="privacyUrl"
                type="url"
                placeholder="https://punyasitus.com/kebijakan-privasi"
                value={privacyUrl}
                onChange={(e) => {
                  setPrivacyUrl(e.target.value);
                  if (fieldErrors.privacyUrl) {
                    setFieldErrors((prev) => ({ ...prev, privacyUrl: "" }));
                  }
                }}
                aria-invalid={fieldErrors.privacyUrl ? "true" : undefined}
                aria-describedby={fieldErrors.privacyUrl ? "err-privacyUrl" : undefined}
                disabled={pending}
              />
              {fieldErrors.privacyUrl && (
                <p id="err-privacyUrl" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.privacyUrl}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-support-hours"
                className="block text-sm font-medium text-foreground"
              >
                Jam Layanan Dukungan (Dipublikasikan di Dasbor)
              </label>
              <Input
                id="settings-support-hours"
                name="supportHours"
                type="text"
                maxLength={120}
                placeholder="Senin–Jumat 09:00–17:00 WIB, Sabtu 09:00–13:00 WIB"
                value={supportHours}
                onChange={(e) => {
                  setSupportHours(e.target.value);
                  if (fieldErrors.supportHours) {
                    setFieldErrors((prev) => ({ ...prev, supportHours: "" }));
                  }
                }}
                aria-invalid={fieldErrors.supportHours ? "true" : undefined}
                aria-describedby={
                  fieldErrors.supportHours ? "err-supportHours" : "hint-supportHours"
                }
                disabled={pending}
              />
              {fieldErrors.supportHours ? (
                <p id="err-supportHours" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.supportHours}
                </p>
              ) : (
                <p id="hint-supportHours" className="text-xs text-muted-foreground">
                  Ditampilkan di panel bantuan dasbor (maks. 120 karakter).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-response-target"
                className="block text-sm font-medium text-foreground"
              >
                Target Waktu Respons (Dipublikasikan di Dasbor)
              </label>
              <Input
                id="settings-response-target"
                name="supportResponseTarget"
                type="text"
                maxLength={120}
                placeholder="< 2 jam kerja"
                value={supportResponseTarget}
                onChange={(e) => {
                  setSupportResponseTarget(e.target.value);
                  if (fieldErrors.supportResponseTarget) {
                    setFieldErrors((prev) => ({ ...prev, supportResponseTarget: "" }));
                  }
                }}
                aria-invalid={fieldErrors.supportResponseTarget ? "true" : undefined}
                aria-describedby={
                  fieldErrors.supportResponseTarget
                    ? "err-supportResponseTarget"
                    : "hint-supportResponseTarget"
                }
                disabled={pending}
              />
              {fieldErrors.supportResponseTarget ? (
                <p
                  id="err-supportResponseTarget"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {fieldErrors.supportResponseTarget}
                </p>
              ) : (
                <p id="hint-supportResponseTarget" className="text-xs text-muted-foreground">
                  Estimasi balasan tim dukungan pada jam kerja (maks. 120 karakter).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-monthly-price"
                className="block text-sm font-medium text-foreground"
              >
                Harga Langganan Bulanan (IDR)
              </label>
              <Input
                id="settings-monthly-price"
                name="monthlyPriceIdr"
                type="number"
                inputMode="numeric"
                value={monthlyPriceIdr}
                onChange={(e) => setMonthlyPriceIdr(e.target.value)}
                aria-invalid={fieldErrors.monthlyPriceIdr ? "true" : undefined}
                disabled={pending}
                className="tabular-nums"
              />
              {fieldErrors.monthlyPriceIdr && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.monthlyPriceIdr}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="settings-yearly-price"
                className="block text-sm font-medium text-foreground"
              >
                Harga Langganan Tahunan (IDR)
              </label>
              <Input
                id="settings-yearly-price"
                name="yearlyPriceIdr"
                type="number"
                inputMode="numeric"
                value={yearlyPriceIdr}
                onChange={(e) => setYearlyPriceIdr(e.target.value)}
                aria-invalid={fieldErrors.yearlyPriceIdr ? "true" : undefined}
                disabled={pending}
                className="tabular-nums"
              />
              {fieldErrors.yearlyPriceIdr && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.yearlyPriceIdr}
                </p>
              )}
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <label
                htmlFor="settings-audit-reason"
                className="block text-sm font-medium text-foreground"
              >
                Alasan Perubahan Audit (Wajib, 10–500 karakter)
              </label>
              <Input
                id="settings-audit-reason"
                name="reason"
                type="text"
                placeholder="Contoh: Memperbarui nomor WhatsApp tim penjualan resmi dan tautan kebijakan privasi"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (fieldErrors.reason) {
                    setFieldErrors((prev) => ({ ...prev, reason: "" }));
                  }
                }}
                aria-invalid={fieldErrors.reason ? "true" : undefined}
                aria-describedby={fieldErrors.reason ? "err-reason" : undefined}
                disabled={pending}
              />
              {fieldErrors.reason && (
                <p id="err-reason" role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.reason}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 md:col-span-2">
              <Button
                type="submit"
                disabled={pending}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="settings-save-button"
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                {pending ? "Menyimpan & mencatat audit..." : "Simpan Pengaturan Platform"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={reloading}
                onClick={handleReloadLatest}
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="settings-reload-button"
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                {reloading ? "Memuat..." : "Muat Ulang Versi Terbaru"}
              </Button>
            </div>
          </form>
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          <span>Terakhir diperbarui: {formatUpdatedAt(updatedAt)}</span>
          <span>Batas keamanan: protokol http:, javascript:, dan host internal ditolak</span>
        </CardFooter>
      </Card>

      <Card data-testid="console-support-preview-card">
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">
                Pratinjau Panel Dukungan WhatsApp Dasbor
              </CardTitle>
              <CardDescription>
                Menampilkan nomor dukungan, jam layanan, target respons, dan pesan otomatis yang
                dilihat pengguna dasbor (hanya handle situs &amp; nama layar; situs agensi tetap
                mengutamakan kontak agensi terlebih dahulu).
              </CardDescription>
            </div>
            <Badge
              variant={supportPreview.platformChannel.whatsappUrl ? "success" : "warning"}
              data-testid="console-support-preview-status"
            >
              {supportPreview.platformChannel.whatsappUrl
                ? "WhatsApp Siap"
                : "Nomor Belum Valid"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3.5 text-sm">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <Clock className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>Jam Layanan &amp; Target Respons Terbit</span>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="console-support-preview-hours">
              <strong className="font-medium text-foreground">Jam layanan:</strong>{" "}
              {supportPreview.platformChannel.supportHours}
            </p>
            <p
              className="text-xs text-muted-foreground"
              data-testid="console-support-preview-target"
            >
              <strong className="font-medium text-foreground">Target respons:</strong>{" "}
              {supportPreview.platformChannel.responseTarget}
            </p>
            <p
              className="text-xs text-muted-foreground tabular-nums"
              data-testid="console-support-preview-number"
            >
              <strong className="font-medium text-foreground">Nomor WhatsApp:</strong>{" "}
              {supportPreview.platformChannel.whatsappDisplay ?? "Belum dikonfigurasi"}
            </p>
          </div>

          <div className="space-y-2.5 rounded-md border border-border bg-muted/40 p-3.5 text-sm">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <MessageCircle className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span>Contoh Pesan Otomatis (Tanpa Rahasia / PII)</span>
            </div>
            <p
              className="rounded border border-border bg-card px-2.5 py-2 font-mono text-xs text-foreground break-words"
              data-testid="console-support-preview-message"
            >
              {supportPreview.prefilledMessage}
            </p>
            {supportPreview.platformChannel.whatsappUrl && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 w-full justify-between sm:w-auto md:min-h-9"
                data-testid="console-support-preview-link"
                render={
                  <a
                    href={supportPreview.platformChannel.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                <span className="inline-flex items-center gap-1.5">
                  <MessageCircle className="size-3.5" aria-hidden="true" />
                  Uji Tautan wa.me
                </span>
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
