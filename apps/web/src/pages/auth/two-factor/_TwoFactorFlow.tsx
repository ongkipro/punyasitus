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

export interface InitialTwoFactorStatus {
  readonly authenticated: boolean;
  readonly pendingChallenge: boolean;
  readonly enrolled: boolean;
  readonly isPlatformOperator: boolean;
  readonly sessionVerified: boolean;
  readonly verifiedAtMs: number | null;
  readonly userEmail: string | null;
}

export interface TwoFactorFlowProps {
  readonly initialStatus: InitialTwoFactorStatus;
  readonly initialMode: "enroll" | "verify";
  readonly nextPath: string;
}

interface EnrollmentPayload {
  readonly totpUri: string;
  readonly manualSecret: string;
  readonly qrSvg: string;
  readonly backupCodes: readonly string[];
}

const SIX_DIGIT_RE = /^\d{6}$/;

export function TwoFactorFlow({ initialStatus, initialMode, nextPath }: TwoFactorFlowProps) {
  const [status, setStatus] = React.useState<InitialTwoFactorStatus>(initialStatus);
  const [mode, setMode] = React.useState<"enroll" | "verify">(initialMode);

  // Enrollment state
  const [enrollPassword, setEnrollPassword] = React.useState("");
  const [enrollPasswordError, setEnrollPasswordError] = React.useState<string | null>(null);
  const [enrollPending, setEnrollPending] = React.useState(false);
  const [enrollmentData, setEnrollmentData] = React.useState<EnrollmentPayload | null>(null);
  const [copiedSecret, setCopiedSecret] = React.useState(false);
  const [copiedBackupCodes, setCopiedBackupCodes] = React.useState(false);

  // Verification / confirmation state
  const [verifyMethod, setVerifyMethod] = React.useState<"totp" | "backup_code">("totp");
  const [codeInput, setCodeInput] = React.useState("");
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [verifyPending, setVerifyPending] = React.useState(false);

  // Banner alerts
  const [formError, setFormError] = React.useState<string | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);

  const enrollPasswordRef = React.useRef<HTMLInputElement>(null);
  const codeInputRef = React.useRef<HTMLInputElement>(null);

  if (!status.authenticated && !status.pendingChallenge) {
    return (
      <Card className="w-full max-w-md shadow-none" data-testid="twofa-unauthenticated">
        <CardHeader className="gap-1.5 border-b border-border pb-4">
          <div className="flex items-center gap-2 text-primary">
            <ShieldAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Autentikasi Dua Faktor
            </span>
          </div>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Masuk terlebih dahulu
            </h1>
          </CardTitle>
          <CardDescription>
            Sesi aktif diperlukan untuk mendaftarkan atau memverifikasi autentikasi dua faktor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Sesi tidak ditemukan</AlertTitle>
            <AlertDescription>
              Silakan masuk ke akun PunyaSitus Anda sebelum melanjutkan verifikasi 2FA.
            </AlertDescription>
          </Alert>
          <Button
            render={<a href={`/auth/login?next=${encodeURIComponent("/auth/two-factor")}`} />}
            className="min-h-11 w-full md:min-h-10"
            data-testid="twofa-login-cta"
          >
            Masuk ke akun Anda
          </Button>
        </CardContent>
      </Card>
    );
  }

  async function handleStartEnroll(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!enrollPassword) {
      setEnrollPasswordError("Kata sandi saat ini wajib diisi untuk memulai pendaftaran 2FA.");
      enrollPasswordRef.current?.focus();
      return;
    }

    setEnrollPasswordError(null);
    setEnrollPending(true);
    try {
      const response = await fetch("/api/auth/two-factor/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: enrollPassword }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        totpUri?: string;
        manualSecret?: string;
        qrSvg?: string;
        backupCodes?: readonly string[];
        message?: string;
      };

      if (!response.ok || !data.success || !data.manualSecret || !data.qrSvg) {
        setFormError(
          data.message ?? "Gagal memulai pendaftaran 2FA. Periksa kembali kata sandi Anda.",
        );
        return;
      }

      setEnrollmentData({
        totpUri: data.totpUri ?? "",
        manualSecret: data.manualSecret,
        qrSvg: data.qrSvg,
        backupCodes: data.backupCodes ?? [],
      });
      setEnrollPassword("");
      setCodeInput("");
      setCodeError(null);
    } catch {
      setFormError("Koneksi terputus saat menyiapkan autentikasi dua faktor. Silakan coba lagi.");
    } finally {
      setEnrollPending(false);
    }
  }

  async function handleVerifySubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    const trimmed = codeInput.trim();
    const effectiveMethod: "totp" | "backup_code" =
      mode === "enroll" ? "totp" : verifyMethod;

    if (!trimmed) {
      setCodeError(
        effectiveMethod === "backup_code"
          ? "Masukkan salah satu kode cadangan Anda."
          : "Masukkan kode 6 digit dari aplikasi autentikator.",
      );
      codeInputRef.current?.focus();
      return;
    }

    if (effectiveMethod === "totp") {
      const digitsOnly = trimmed.replace(/\s+/g, "");
      if (!SIX_DIGIT_RE.test(digitsOnly)) {
        setCodeError("Kode autentikator harus terdiri dari tepat 6 digit angka.");
        codeInputRef.current?.focus();
        return;
      }
    }

    setCodeError(null);
    setVerifyPending(true);
    try {
      const response = await fetch("/api/auth/two-factor/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          code: effectiveMethod === "totp" ? trimmed.replace(/\s+/g, "") : trimmed,
          method: effectiveMethod,
        }),
      });
      const data = (await response.json()) as {
        success?: boolean;
        verifiedAtMs?: number;
        message?: string;
      };

      if (!response.ok || !data.success) {
        setFormError(
          data.message ??
            (effectiveMethod === "backup_code"
              ? "Kode cadangan tidak valid atau sudah pernah digunakan."
              : "Kode 6 digit tidak valid atau sudah kedaluwarsa."),
        );
        return;
      }

      // Clear sensitive one-time secrets from browser memory immediately after confirmation
      setEnrollmentData(null);
      setCodeInput("");
      setStatus((prev) => ({
        ...prev,
        authenticated: true,
        pendingChallenge: false,
        enrolled: true,
        sessionVerified: true,
        verifiedAtMs: data.verifiedAtMs ?? Date.now(),
      }));
      setMode("verify");
      setSuccessMessage(
        mode === "enroll"
          ? "Autentikasi dua faktor (2FA) berhasil diaktifkan dan sesi Anda telah diverifikasi."
          : "Verifikasi dua faktor berhasil. Sesi Anda kini terverifikasi untuk operasi sensitif selama 10 menit.",
      );
    } catch {
      setFormError("Koneksi terputus saat memverifikasi kode. Silakan coba lagi.");
    } finally {
      setVerifyPending(false);
    }
  }

  async function handleCopyText(text: string, kind: "secret" | "backup") {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === "secret") {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 2000);
      } else {
        setCopiedBackupCodes(true);
        setTimeout(() => setCopiedBackupCodes(false), 2000);
      }
    } catch {
      // Clipboard API may be unavailable in restricted contexts; value stays visible for manual copy.
    }
  }

  const showEnrollView = mode === "enroll" && !status.enrolled;

  return (
    <Card className="w-full max-w-lg shadow-none" data-testid="twofa-card">
      <CardHeader className="gap-1.5 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-primary">
            <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Autentikasi Dua Faktor (2FA)
            </span>
          </div>
          {status.isPlatformOperator && (
            <Badge variant="warning" data-testid="twofa-operator-badge">
              Wajib untuk Operator Platform
            </Badge>
          )}
        </div>
        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {showEnrollView
              ? "Aktifkan Autentikator 2FA"
              : "Verifikasi Autentikasi Dua Faktor"}
          </h1>
        </CardTitle>
        <CardDescription>
          {showEnrollView
            ? "Pindai kode QR atau masukkan kunci manual ke aplikasi autentikator (Google Authenticator, 1Password, atau Authy), lalu simpan kode cadangan sekali pakai."
            : "Masukkan kode 6 digit dari aplikasi autentikator Anda atau gunakan salah satu kode cadangan sekali pakai."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {formError && (
          <Alert variant="destructive" data-testid="twofa-form-error" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Verifikasi belum berhasil</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        {successMessage && (
          <Alert variant="success" data-testid="twofa-success-alert" aria-live="polite">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            <AlertTitle>Berhasil</AlertTitle>
            <AlertDescription>{successMessage}</AlertDescription>
          </Alert>
        )}

        {successMessage && (
          <div className="flex flex-wrap gap-2">
            <Button
              render={<a href={nextPath} />}
              className="min-h-11 w-full sm:w-auto md:min-h-10"
              data-testid="twofa-continue-link"
            >
              Lanjutkan
            </Button>
          </div>
        )}

        {showEnrollView && !enrollmentData && (
          <form
            onSubmit={handleStartEnroll}
            noValidate
            className="space-y-4"
            data-testid="twofa-enroll-start-form"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="twofa-enroll-password"
                className="block text-sm font-medium text-foreground"
              >
                Kata sandi akun saat ini
              </label>
              <Input
                ref={enrollPasswordRef}
                id="twofa-enroll-password"
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
                aria-describedby={enrollPasswordError ? "twofa-enroll-password-error" : undefined}
                disabled={enrollPending}
              />
              {enrollPasswordError && (
                <p
                  id="twofa-enroll-password-error"
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
              className="min-h-11 w-full md:min-h-10"
              data-testid="twofa-enroll-start-button"
            >
              <QrCodeIcon className="size-4" aria-hidden="true" />
              {enrollPending ? "Menyiapkan kode QR..." : "Buat kode QR & kode cadangan"}
            </Button>
          </form>
        )}

        {showEnrollView && enrollmentData && (
          <div className="space-y-5" data-testid="twofa-enroll-secret-panel">
            {/* Step 1: QR Code + Manual Secret Key */}
            <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-4">
              <div className="flex flex-col items-center gap-3">
                <div
                  className="inline-flex items-center justify-center rounded-md border border-border bg-white p-3"
                  data-testid="twofa-qr-container"
                  dangerouslySetInnerHTML={{ __html: enrollmentData.qrSvg }}
                />
                <p className="text-center text-xs text-muted-foreground">
                  Pindai kode QR di atas menggunakan aplikasi autentikator Anda.
                </p>
              </div>

              <div className="space-y-1.5 border-t border-border pt-3">
                <span className="block text-xs font-medium text-muted-foreground">
                  Atau masukkan kunci manual (Base32) secara manual:
                </span>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <code
                    className="block flex-1 break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground select-all"
                    data-testid="twofa-manual-secret"
                  >
                    {enrollmentData.manualSecret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleCopyText(enrollmentData.manualSecret, "secret")}
                    className="min-h-11 shrink-0 md:min-h-9"
                    data-testid="twofa-copy-secret-button"
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

            {/* Step 2: One-time Backup Codes */}
            <div className="space-y-3 rounded-lg border border-border bg-card p-4">
              <Alert variant="warning" data-testid="twofa-backup-once-warning">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Kode cadangan hanya ditampilkan satu kali</AlertTitle>
                <AlertDescription>
                  Simpan 10 kode cadangan di bawah ini di pengelola kata sandi atau tempat aman.
                  Setiap kode hanya dapat dipakai satu kali jika perangkat autentikator hilang.
                </AlertDescription>
              </Alert>

              <ul
                className="grid grid-cols-2 gap-2"
                data-testid="twofa-backup-codes"
                aria-label="Daftar kode cadangan sekali pakai"
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
                onClick={() =>
                  handleCopyText(enrollmentData.backupCodes.join("\n"), "backup")
                }
                className="min-h-11 w-full sm:w-auto md:min-h-9"
                data-testid="twofa-copy-backup-button"
              >
                {copiedBackupCodes ? (
                  <CheckIcon className="size-4" aria-hidden="true" />
                ) : (
                  <CopyIcon className="size-4" aria-hidden="true" />
                )}
                {copiedBackupCodes ? "Kode cadangan tersalin" : "Salin semua kode cadangan"}
              </Button>
            </div>

            {/* Step 3: Verify 6-digit TOTP code to finalize enrollment */}
            <form
              onSubmit={handleVerifySubmit}
              noValidate
              className="space-y-4 border-t border-border pt-4"
              data-testid="twofa-confirm-enroll-form"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="twofa-confirm-code"
                  className="block text-sm font-medium text-foreground"
                >
                  Kode verifikasi 6 digit dari aplikasi autentikator
                </label>
                <Input
                  ref={codeInputRef}
                  id="twofa-confirm-code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value);
                    if (codeError) setCodeError(null);
                  }}
                  aria-invalid={codeError ? "true" : undefined}
                  aria-describedby={codeError ? "twofa-code-error" : undefined}
                  disabled={verifyPending}
                  className="font-mono tracking-widest tabular-nums"
                />
                {codeError && (
                  <p
                    id="twofa-code-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {codeError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={verifyPending}
                className="min-h-11 w-full md:min-h-10"
                data-testid="twofa-confirm-enroll-button"
              >
                <ShieldCheckIcon className="size-4" aria-hidden="true" />
                {verifyPending ? "Memverifikasi kode..." : "Verifikasi & aktifkan 2FA"}
              </Button>
            </form>
          </div>
        )}

        {!showEnrollView && (
          <div className="space-y-4" data-testid="twofa-verify-panel">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Metode verifikasi 2FA">
              <Button
                type="button"
                variant={verifyMethod === "totp" ? "default" : "outline"}
                aria-pressed={verifyMethod === "totp"}
                onClick={() => {
                  setVerifyMethod("totp");
                  setCodeInput("");
                  setCodeError(null);
                  setFormError(null);
                }}
                className="min-h-11 md:min-h-9"
                data-testid="twofa-method-totp"
              >
                <QrCodeIcon className="size-4" aria-hidden="true" />
                Kode 6 digit
              </Button>
              <Button
                type="button"
                variant={verifyMethod === "backup_code" ? "default" : "outline"}
                aria-pressed={verifyMethod === "backup_code"}
                onClick={() => {
                  setVerifyMethod("backup_code");
                  setCodeInput("");
                  setCodeError(null);
                  setFormError(null);
                }}
                className="min-h-11 md:min-h-9"
                data-testid="twofa-method-backup"
              >
                <KeyRoundIcon className="size-4" aria-hidden="true" />
                Kode cadangan
              </Button>
            </div>

            <form
              onSubmit={handleVerifySubmit}
              noValidate
              className="space-y-4"
              data-testid="twofa-verify-form"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="twofa-verify-code"
                  className="block text-sm font-medium text-foreground"
                >
                  {verifyMethod === "backup_code"
                    ? "Kode cadangan sekali pakai"
                    : "Kode autentikator (6 digit)"}
                </label>
                <Input
                  ref={codeInputRef}
                  id="twofa-verify-code"
                  name="code"
                  type="text"
                  inputMode={verifyMethod === "backup_code" ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  maxLength={verifyMethod === "backup_code" ? 32 : 6}
                  placeholder={verifyMethod === "backup_code" ? "Contoh: Ab12C-De34F" : "000000"}
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value);
                    if (codeError) setCodeError(null);
                  }}
                  aria-invalid={codeError ? "true" : undefined}
                  aria-describedby={codeError ? "twofa-code-error" : undefined}
                  disabled={verifyPending}
                  className="font-mono tracking-wider tabular-nums"
                />
                {codeError && (
                  <p
                    id="twofa-code-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {codeError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={verifyPending}
                className="min-h-11 w-full md:min-h-10"
                data-testid="twofa-verify-submit"
              >
                <ShieldCheckIcon className="size-4" aria-hidden="true" />
                {verifyPending ? "Memeriksa kode..." : "Verifikasi sekarang"}
              </Button>
            </form>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
        <p>
          Kode autentikator dan kode cadangan tidak pernah dicatat di log audit sistem. Kehilangan
          perangkat operator harus melalui prosedur pemulihan teraudit.
        </p>
      </CardFooter>
    </Card>
  );
}
