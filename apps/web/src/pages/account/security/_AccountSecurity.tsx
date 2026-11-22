import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  QrCodeIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
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

export interface AccountSecurityInitialState {
  readonly authenticated: boolean;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly enrolled: boolean;
  readonly isPlatformOperator: boolean;
  readonly sessionVerified: boolean;
  readonly verifiedAtMs: number | null;
}

export interface AccountSecurityProps {
  readonly initialState: AccountSecurityInitialState;
}

interface EnrollmentPayload {
  readonly totpUri: string;
  readonly manualSecret: string;
  readonly qrSvg: string;
  readonly backupCodes: readonly string[];
}

const SIX_DIGIT_RE = /^\d{6}$/;

function formatVerifiedAt(ms: number | null): string {
  if (!ms) return "Belum diverifikasi pada sesi ini";
  try {
    return `${new Date(ms).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    })} WIB`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export function AccountSecurity({ initialState }: AccountSecurityProps) {
  const [state, setState] = React.useState<AccountSecurityInitialState>(initialState);

  // Optional / mandatory enrollment flow
  const [enrollPassword, setEnrollPassword] = React.useState("");
  const [enrollPasswordError, setEnrollPasswordError] = React.useState<string | null>(null);
  const [enrollPending, setEnrollPending] = React.useState(false);
  const [enrollmentData, setEnrollmentData] = React.useState<EnrollmentPayload | null>(null);
  const [confirmCode, setConfirmCode] = React.useState("");
  const [confirmCodeError, setConfirmCodeError] = React.useState<string | null>(null);
  const [confirmPending, setConfirmPending] = React.useState(false);
  const [copiedSecret, setCopiedSecret] = React.useState(false);
  const [copiedBackup, setCopiedBackup] = React.useState(false);

  // Tenant optional disable flow
  const [disablePassword, setDisablePassword] = React.useState("");
  const [disablePasswordError, setDisablePasswordError] = React.useState<string | null>(null);
  const [disablePending, setDisablePending] = React.useState(false);

  // Global status banner
  const [statusBanner, setStatusBanner] = React.useState<{
    readonly kind: "success" | "error";
    readonly title: string;
    readonly text: string;
  } | null>(null);

  if (!state.authenticated) {
    return (
      <div className="mx-auto max-w-2xl space-y-6" data-testid="security-unauthenticated">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Keamanan & Autentikasi Dua Faktor
          </h1>
          <p className="text-sm text-muted-foreground">
            Kelola autentikasi dua faktor (2FA) untuk melindungi akun PunyaSitus Anda.
          </p>
        </div>

        <Alert variant="warning">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Sesi belum aktif atau telah berakhir</AlertTitle>
          <AlertDescription>
            Masuk terlebih dahulu untuk melihat atau mengubah pengaturan keamanan 2FA akun Anda.
          </AlertDescription>
        </Alert>

        <Button
          render={<a href="/auth/login?next=/account/security&expired=1" />}
          className="min-h-11 md:min-h-10"
          data-testid="security-login-cta"
        >
          Masuk ke akun Anda
        </Button>
      </div>
    );
  }

  async function handleStartEnroll(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusBanner(null);

    if (!enrollPassword) {
      setEnrollPasswordError("Kata sandi saat ini wajib diisi untuk mengaktifkan 2FA.");
      return;
    }

    setEnrollPasswordError(null);
    setEnrollPending(true);
    try {
      const res = await fetch("/api/auth/two-factor/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: enrollPassword }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        totpUri?: string;
        manualSecret?: string;
        qrSvg?: string;
        backupCodes?: readonly string[];
        message?: string;
      };
      if (!res.ok || !data.success || !data.manualSecret || !data.qrSvg) {
        setStatusBanner({
          kind: "error",
          title: "Gagal menyiapkan 2FA",
          text: data.message ?? "Periksa kembali kata sandi Anda lalu coba lagi.",
        });
        return;
      }

      setEnrollmentData({
        totpUri: data.totpUri ?? "",
        manualSecret: data.manualSecret,
        qrSvg: data.qrSvg,
        backupCodes: data.backupCodes ?? [],
      });
      setEnrollPassword("");
      setConfirmCode("");
      setConfirmCodeError(null);
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Koneksi terputus",
        text: "Tidak dapat menghubungi layanan keamanan. Silakan coba lagi.",
      });
    } finally {
      setEnrollPending(false);
    }
  }

  async function handleConfirmEnroll(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusBanner(null);

    const digits = confirmCode.trim().replace(/\s+/g, "");
    if (!SIX_DIGIT_RE.test(digits)) {
      setConfirmCodeError("Masukkan kode 6 digit angka dari aplikasi autentikator Anda.");
      return;
    }

    setConfirmCodeError(null);
    setConfirmPending(true);
    try {
      const res = await fetch("/api/auth/two-factor/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: digits, method: "totp" }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        verifiedAtMs?: number;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setStatusBanner({
          kind: "error",
          title: "Kode belum sesuai",
          text: data.message ?? "Kode 6 digit tidak sesuai atau sudah kedaluwarsa.",
        });
        return;
      }

      setEnrollmentData(null);
      setConfirmCode("");
      setState((prev) => ({
        ...prev,
        enrolled: true,
        sessionVerified: true,
        verifiedAtMs: data.verifiedAtMs ?? Date.now(),
      }));
      setStatusBanner({
        kind: "success",
        title: "2FA berhasil diaktifkan",
        text: "Autentikasi dua faktor kini aktif pada akun Anda.",
      });
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Koneksi terputus",
        text: "Verifikasi gagal dikirim. Silakan coba lagi.",
      });
    } finally {
      setConfirmPending(false);
    }
  }

  async function handleDisableTwoFactor(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusBanner(null);

    if (!disablePassword) {
      setDisablePasswordError("Masukkan kata sandi saat ini untuk menonaktifkan 2FA.");
      return;
    }

    setDisablePasswordError(null);
    setDisablePending(true);
    try {
      const res = await fetch("/api/auth/two-factor/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: disablePassword }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        message?: string;
      };
      if (!res.ok || !data.success) {
        setStatusBanner({
          kind: "error",
          title: "Tidak dapat menonaktifkan 2FA",
          text: data.message ?? "Kata sandi tidak sesuai atau kebijakan akun melarang penonaktifan.",
        });
        return;
      }

      setDisablePassword("");
      setState((prev) => ({
        ...prev,
        enrolled: false,
        sessionVerified: false,
        verifiedAtMs: null,
      }));
      setStatusBanner({
        kind: "success",
        title: "2FA dinonaktifkan",
        text: "Autentikasi dua faktor opsional telah dinonaktifkan dari akun Anda.",
      });
    } catch {
      setStatusBanner({
        kind: "error",
        title: "Koneksi terputus",
        text: "Perubahan belum tersimpan. Silakan coba lagi.",
      });
    } finally {
      setDisablePending(false);
    }
  }

  async function handleCopy(text: string, kind: "secret" | "backup") {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === "secret") {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
      } else {
        setCopiedBackup(true);
        setTimeout(() => setCopiedBackup(false), 2000);
      }
    } catch {
      // Clipboard may be unavailable; text remains selectable
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="account-security-ready">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Keamanan & Autentikasi Dua Faktor (2FA)
          </h1>
          <p className="text-sm text-muted-foreground">
            Lindungi akun {state.userEmail ?? "Anda"} dengan kode sementara (TOTP) dari aplikasi
            autentikator dan kode cadangan sekali pakai.
          </p>
        </div>
        <Button
          render={<a href="/account" />}
          variant="outline"
          className="min-h-11 md:min-h-9"
          data-testid="security-back-account"
        >
          Kembali ke Akun Saya
        </Button>
      </div>

      {statusBanner && (
        <Alert
          variant={statusBanner.kind === "success" ? "success" : "destructive"}
          data-testid="security-status-alert"
          aria-live="polite"
        >
          {statusBanner.kind === "success" ? (
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircleIcon className="size-4" aria-hidden="true" />
          )}
          <AlertTitle>{statusBanner.title}</AlertTitle>
          <AlertDescription>{statusBanner.text}</AlertDescription>
        </Alert>
      )}

      {/* Status Overview Card */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" />
              <CardTitle>Status Autentikasi Dua Faktor</CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={state.enrolled ? "success" : "secondary"}
                data-testid="security-2fa-status-badge"
              >
                {state.enrolled ? "2FA Aktif" : "2FA Belum Aktif"}
              </Badge>
              <Badge variant={state.isPlatformOperator ? "warning" : "outline"}>
                {state.isPlatformOperator ? "Wajib (Operator Platform)" : "Opsional (Pemilik Situs)"}
              </Badge>
            </div>
          </div>
          <CardDescription>
            {state.isPlatformOperator
              ? "Operator platform wajib mengaktifkan 2FA untuk mengakses Console Operasional dan melakukan tindakan sensitif."
              : "Pemilik situs dapat mengaktifkan atau menonaktifkan 2FA kapan saja tanpa paksaan."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <dt className="text-xs text-muted-foreground">Status verifikasi sesi ini</dt>
              <dd className="mt-1 font-medium text-foreground" data-testid="security-session-2fa-state">
                {state.sessionVerified ? "Terverifikasi 2FA" : "Belum diverifikasi"}
              </dd>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <dt className="text-xs text-muted-foreground">Verifikasi terakhir</dt>
              <dd className="mt-1 font-medium text-foreground tabular-nums">
                {formatVerifiedAt(state.verifiedAtMs)}
              </dd>
            </div>
          </dl>

          {state.enrolled && (
            <div className="flex flex-wrap gap-2">
              <Button
                render={<a href="/auth/two-factor?mode=verify&next=/account/security" />}
                variant="outline"
                className="min-h-11 md:min-h-9"
                data-testid="security-stepup-link"
              >
                <KeyRoundIcon className="size-4" aria-hidden="true" />
                Verifikasi ulang 2FA (step-up 10 menit)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Enable 2FA Card (when not enrolled) */}
      {!state.enrolled && (
        <Card data-testid="security-enable-card">
          <CardHeader className="border-b border-border pb-4">
            <div className="flex items-center gap-2 text-primary">
              <QrCodeIcon className="size-4 shrink-0" aria-hidden="true" />
              <CardTitle>Aktifkan Autentikasi Dua Faktor</CardTitle>
            </div>
            <CardDescription>
              Konfirmasi kata sandi Anda untuk membuat kode QR, kunci manual, dan 10 kode cadangan
              sekali pakai.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!enrollmentData ? (
              <form
                onSubmit={handleStartEnroll}
                noValidate
                className="space-y-4"
                data-testid="security-enroll-form"
              >
                <div className="space-y-1.5">
                  <label
                    htmlFor="security-enroll-password"
                    className="block text-sm font-medium text-foreground"
                  >
                    Kata sandi saat ini
                  </label>
                  <Input
                    id="security-enroll-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={enrollPassword}
                    onChange={(e) => {
                      setEnrollPassword(e.target.value);
                      if (enrollPasswordError) setEnrollPasswordError(null);
                    }}
                    aria-invalid={enrollPasswordError ? "true" : undefined}
                    aria-describedby={
                      enrollPasswordError ? "security-enroll-password-error" : undefined
                    }
                    disabled={enrollPending}
                  />
                  {enrollPasswordError && (
                    <p
                      id="security-enroll-password-error"
                      role="alert"
                      className="text-xs font-medium text-destructive"
                    >
                      {enrollPasswordError}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  disabled={enrollPending}
                  className="min-h-11 md:min-h-9"
                  data-testid="security-enroll-submit"
                >
                  <QrCodeIcon className="size-4" aria-hidden="true" />
                  {enrollPending ? "Menyiapkan 2FA..." : "Aktifkan 2FA"}
                </Button>
              </form>
            ) : (
              <div className="space-y-5" data-testid="security-enroll-secrets">
                <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-4">
                  <div className="flex flex-col items-center gap-3">
                    <div
                      className="inline-flex items-center justify-center rounded-md border border-border bg-white p-3"
                      data-testid="security-qr-container"
                      dangerouslySetInnerHTML={{ __html: enrollmentData.qrSvg }}
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      Pindai kode QR ini di aplikasi autentikator Anda.
                    </p>
                  </div>

                  <div className="space-y-1.5 border-t border-border pt-3">
                    <span className="block text-xs font-medium text-muted-foreground">
                      Kunci manual (Base32):
                    </span>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <code
                        className="block flex-1 break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground select-all"
                        data-testid="security-manual-secret"
                      >
                        {enrollmentData.manualSecret}
                      </code>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleCopy(enrollmentData.manualSecret, "secret")}
                        className="min-h-11 shrink-0 md:min-h-9"
                      >
                        {copiedSecret ? (
                          <CheckIcon className="size-4" aria-hidden="true" />
                        ) : (
                          <CopyIcon className="size-4" aria-hidden="true" />
                        )}
                        {copiedSecret ? "Tersalin" : "Salin kunci"}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                  <Alert variant="warning">
                    <ShieldAlertIcon className="size-4" aria-hidden="true" />
                    <AlertTitle>Simpan kode cadangan sekarang (ditampilkan satu kali)</AlertTitle>
                    <AlertDescription>
                      Setiap kode cadangan hanya dapat digunakan satu kali untuk pemulihan darurat.
                    </AlertDescription>
                  </Alert>

                  <ul
                    className="grid grid-cols-2 gap-2"
                    data-testid="security-backup-codes"
                  >
                    {enrollmentData.backupCodes.map((code) => (
                      <li
                        key={code}
                        className="rounded border border-border bg-muted/50 px-2.5 py-1.5 text-center font-mono text-xs font-medium text-foreground tabular-nums"
                      >
                        {code}
                      </li>
                    ))}
                  </ul>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleCopy(enrollmentData.backupCodes.join("\n"), "backup")}
                    className="min-h-11 w-full sm:w-auto md:min-h-9"
                  >
                    {copiedBackup ? (
                      <CheckIcon className="size-4" aria-hidden="true" />
                    ) : (
                      <CopyIcon className="size-4" aria-hidden="true" />
                    )}
                    {copiedBackup ? "Kode cadangan tersalin" : "Salin semua kode cadangan"}
                  </Button>
                </div>

                <form
                  onSubmit={handleConfirmEnroll}
                  noValidate
                  className="space-y-4 border-t border-border pt-4"
                  data-testid="security-confirm-form"
                >
                  <div className="space-y-1.5">
                    <label
                      htmlFor="security-confirm-code"
                      className="block text-sm font-medium text-foreground"
                    >
                      Masukkan kode 6 digit dari autentikator untuk mengonfirmasi
                    </label>
                    <Input
                      id="security-confirm-code"
                      name="code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      placeholder="000000"
                      value={confirmCode}
                      onChange={(e) => {
                        setConfirmCode(e.target.value);
                        if (confirmCodeError) setConfirmCodeError(null);
                      }}
                      aria-invalid={confirmCodeError ? "true" : undefined}
                      aria-describedby={confirmCodeError ? "security-confirm-error" : undefined}
                      disabled={confirmPending}
                      className="font-mono tracking-widest tabular-nums"
                    />
                    {confirmCodeError && (
                      <p
                        id="security-confirm-error"
                        role="alert"
                        className="text-xs font-medium text-destructive"
                      >
                        {confirmCodeError}
                      </p>
                    )}
                  </div>

                  <Button
                    type="submit"
                    disabled={confirmPending}
                    className="min-h-11 md:min-h-9"
                    data-testid="security-confirm-submit"
                  >
                    {confirmPending ? "Mengonfirmasi..." : "Konfirmasi & aktifkan 2FA"}
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Disable Optional 2FA Card (Tenant Users ONLY) */}
      {state.enrolled && !state.isPlatformOperator && (
        <Card data-testid="security-disable-card">
          <CardHeader className="border-b border-border pb-4">
            <div className="flex items-center gap-2 text-destructive">
              <ShieldOffIcon className="size-4 shrink-0" aria-hidden="true" />
              <CardTitle>Nonaktifkan Autentikasi Dua Faktor</CardTitle>
            </div>
            <CardDescription>
              Karena 2FA bersifat opsional bagi pemilik situs, Anda dapat menonaktifkannya kapan
              saja dengan mengonfirmasi kata sandi saat ini.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={handleDisableTwoFactor}
              noValidate
              className="space-y-4"
              data-testid="security-disable-form"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="security-disable-password"
                  className="block text-sm font-medium text-foreground"
                >
                  Kata sandi saat ini
                </label>
                <Input
                  id="security-disable-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={disablePassword}
                  onChange={(e) => {
                    setDisablePassword(e.target.value);
                    if (disablePasswordError) setDisablePasswordError(null);
                  }}
                  aria-invalid={disablePasswordError ? "true" : undefined}
                  aria-describedby={
                    disablePasswordError ? "security-disable-password-error" : undefined
                  }
                  disabled={disablePending}
                />
                {disablePasswordError && (
                  <p
                    id="security-disable-password-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {disablePasswordError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                variant="destructive"
                disabled={disablePending}
                className="min-h-11 md:min-h-9"
                data-testid="security-disable-submit"
              >
                <ShieldOffIcon className="size-4" aria-hidden="true" />
                {disablePending ? "Menonaktifkan..." : "Nonaktifkan 2FA"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Mandatory Operator Notice (when enrolled & active operator) */}
      {state.enrolled && state.isPlatformOperator && (
        <Alert variant="warning" data-testid="security-operator-mandatory-notice">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>2FA Wajib Aktif untuk Operator Platform</AlertTitle>
          <AlertDescription>
            Operator platform tidak dapat menonaktifkan 2FA secara mandiri. Jika perangkat
            autentikator dan semua kode cadangan hilang, jalankan prosedur pemulihan teraudit
            melalui skrip bootstrap operator (`docs/operations/platform-access.md`).
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
