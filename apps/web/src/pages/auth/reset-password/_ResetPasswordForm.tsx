import * as React from "react";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  MailIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { HoneypotField, TurnstileField } from "../_AuthShared";

export interface ResetPasswordFormProps {
  readonly token: string | null;
  readonly tokenExpiredOrInvalid?: boolean;
  readonly turnstileSiteKey?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function ResetPasswordForm({
  token,
  tokenExpiredOrInvalid = false,
  turnstileSiteKey = "",
}: ResetPasswordFormProps) {
  const hasToken = Boolean(token && token.trim().length > 0 && !tokenExpiredOrInvalid);

  // Request reset link state
  const [email, setEmail] = React.useState("");
  const [honeypot, setHoneypot] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [requestSubmitted, setRequestSubmitted] = React.useState(false);
  const [requestPending, setRequestPending] = React.useState(false);

  // Set new password state
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [resetError, setResetError] = React.useState<string | null>(null);
  const [expiredState, setExpiredState] = React.useState(tokenExpiredOrInvalid);
  const [resetSuccess, setResetSuccess] = React.useState(false);
  const [resetPending, setResetPending] = React.useState(false);

  const emailRef = React.useRef<HTMLInputElement>(null);
  const newPassRef = React.useRef<HTMLInputElement>(null);
  const confirmPassRef = React.useRef<HTMLInputElement>(null);

  async function handleRequestReset(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError(null);
    setRequestSubmitted(false);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError("Alamat email wajib diisi.");
      emailRef.current?.focus();
      return;
    }
    if (!SIMPLE_EMAIL_RE.test(trimmedEmail)) {
      setEmailError("Masukkan alamat email yang valid.");
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);

    setRequestPending(true);
    try {
      const payload: Record<string, unknown> = {
        email: trimmedEmail,
        redirectTo: `${window.location.origin}/auth/reset-password`,
      };
      if (turnstileToken) {
        payload["cf-turnstile-response"] = turnstileToken;
      }
      if (honeypot) {
        payload.hp_website = honeypot;
      }

      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      if (!response.ok && response.status === 403) {
        setRequestError(
          "Verifikasi keamanan Turnstile diperlukan atau sudah kedaluwarsa. Selesaikan verifikasi lalu coba lagi.",
        );
        return;
      }

      if (!response.ok && response.status >= 500) {
        setRequestError(
          "Layanan email sedang mengalami gangguan. Alamat email Anda tetap tersimpan, silakan coba lagi.",
        );
        return;
      }

      // Non-enumerating confirmation (PLAN §4 & §17.4)
      setRequestSubmitted(true);
    } catch {
      setRequestError(
        "Tidak dapat mengirim permintaan saat ini. Periksa koneksi internet Anda lalu coba lagi.",
      );
    } finally {
      setRequestPending(false);
    }
  }

  async function handleSetNewPassword(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setResetError(null);

    let nextPassErr: string | null = null;
    let nextConfirmErr: string | null = null;

    if (newPassword.length < 8) {
      nextPassErr = "Kata sandi baru minimal terdiri dari 8 karakter.";
    } else if (newPassword.length > 128) {
      nextPassErr = "Kata sandi baru maksimal 128 karakter.";
    }

    if (!confirmPassword) {
      nextConfirmErr = "Konfirmasi kata sandi wajib diisi.";
    } else if (confirmPassword !== newPassword) {
      nextConfirmErr = "Konfirmasi kata sandi tidak cocok dengan kata sandi baru.";
    }

    setPasswordError(nextPassErr);
    setConfirmError(nextConfirmErr);

    if (nextPassErr) {
      newPassRef.current?.focus();
      return;
    }
    if (nextConfirmErr) {
      confirmPassRef.current?.focus();
      return;
    }

    setResetPending(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          token: token ?? "",
          newPassword,
        }),
      });

      if (!response.ok) {
        if (response.status === 400 || response.status === 401 || response.status === 404) {
          setExpiredState(true);
          setResetError(
            "Tautan reset kata sandi tidak valid atau telah kedaluwarsa. Silakan minta tautan baru.",
          );
          return;
        }
        setResetError("Gagal menyimpan kata sandi baru. Silakan coba lagi.");
        return;
      }

      setResetSuccess(true);
    } catch {
      setResetError("Koneksi terputus saat menyimpan kata sandi. Silakan coba lagi.");
    } finally {
      setResetPending(false);
    }
  }

  return (
    <Card className="w-full max-w-md shadow-none">
      <CardHeader className="gap-1.5 border-b border-border pb-4">
        <div className="flex items-center gap-2 text-primary">
          <KeyRoundIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold tracking-wide uppercase">
            Pemulihan Kata Sandi
          </span>
        </div>
        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {hasToken && !expiredState ? "Atur kata sandi baru" : "Reset kata sandi"}
          </h1>
        </CardTitle>
        <CardDescription>
          {hasToken && !expiredState
            ? "Masukkan kata sandi baru untuk akun PunyaSitus Anda. Semua sesi lama akan dicabut otomatis."
            : "Masukkan email terdaftar Anda untuk menerima tautan reset satu kali pakai."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {expiredState && (
          <Alert variant="destructive" data-testid="reset-expired-alert" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Tautan tidak valid atau kedaluwarsa</AlertTitle>
            <AlertDescription>
              Tautan reset kata sandi hanya berlaku satu kali dan memiliki batas waktu. Minta tautan
              reset baru melalui formulir di bawah ini.
            </AlertDescription>
          </Alert>
        )}

        {hasToken && !expiredState ? (
          resetSuccess ? (
            <div className="space-y-4">
              <Alert variant="success" data-testid="reset-complete-alert">
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
                <AlertTitle>Kata sandi berhasil diperbarui</AlertTitle>
                <AlertDescription>
                  Kata sandi baru Anda sudah aktif dan semua sesi lama telah diakhiri.
                </AlertDescription>
              </Alert>
              <Button
                render={<a href="/auth/login?reset=success" />}
                className="min-h-11 w-full md:min-h-10"
              >
                Lanjut ke halaman masuk
              </Button>
            </div>
          ) : (
            <form
              method="post"
              onSubmit={handleSetNewPassword}
              noValidate
              className="space-y-4"
              data-testid="reset-new-password-form"
            >
              {resetError && (
                <Alert variant="destructive" aria-live="assertive">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Tidak dapat memperbarui kata sandi</AlertTitle>
                  <AlertDescription>{resetError}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="reset-new-password"
                  className="block text-sm font-medium text-foreground"
                >
                  Kata sandi baru
                </label>
                <Input
                  ref={newPassRef}
                  id="reset-new-password"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    if (passwordError) setPasswordError(null);
                  }}
                  aria-invalid={passwordError ? "true" : undefined}
                  aria-describedby={
                    passwordError ? "reset-new-password-error" : "reset-new-password-hint"
                  }
                  disabled={resetPending}
                />
                <p id="reset-new-password-hint" className="text-xs text-muted-foreground">
                  Minimal 8 karakter. Gunakan kombinasi huruf, angka, dan simbol.
                </p>
                {passwordError && (
                  <p
                    id="reset-new-password-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {passwordError}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="reset-confirm-password"
                  className="block text-sm font-medium text-foreground"
                >
                  Konfirmasi kata sandi baru
                </label>
                <Input
                  ref={confirmPassRef}
                  id="reset-confirm-password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    if (confirmError) setConfirmError(null);
                  }}
                  aria-invalid={confirmError ? "true" : undefined}
                  aria-describedby={confirmError ? "reset-confirm-password-error" : undefined}
                  disabled={resetPending}
                />
                {confirmError && (
                  <p
                    id="reset-confirm-password-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {confirmError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={resetPending}
                className="min-h-11 w-full md:min-h-10"
                data-testid="reset-save-submit"
              >
                {resetPending ? "Menyimpan kata sandi..." : "Simpan kata sandi baru"}
              </Button>
            </form>
          )
        ) : (
          <div className="space-y-4">
            {requestSubmitted && (
              <Alert variant="success" data-testid="reset-requested-alert">
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
                <AlertTitle>Permintaan reset diproses</AlertTitle>
                <AlertDescription>
                  Jika email tersebut terdaftar di PunyaSitus, kami telah mengirimkan tautan reset
                  kata sandi satu kali pakai yang berlaku selama 30 menit.
                </AlertDescription>
              </Alert>
            )}

            {requestError && (
              <Alert variant="destructive" aria-live="assertive">
                <AlertCircleIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Gagal mengirim permintaan</AlertTitle>
                <AlertDescription>{requestError}</AlertDescription>
              </Alert>
            )}

            <form
              method="post"
              onSubmit={handleRequestReset}
              noValidate
              className="relative space-y-4"
              data-testid="reset-request-form"
            >
              <HoneypotField id="reset-hp-website" value={honeypot} onChange={setHoneypot} />

              <div className="space-y-1.5">
                <label
                  htmlFor="reset-email"
                  className="block text-sm font-medium text-foreground"
                >
                  Alamat email akun
                </label>
                <Input
                  ref={emailRef}
                  id="reset-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  aria-invalid={emailError ? "true" : undefined}
                  aria-describedby={emailError ? "reset-email-error" : undefined}
                  placeholder="nama@bisnisanda.id"
                  disabled={requestPending}
                />
                {emailError && (
                  <p
                    id="reset-email-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {emailError}
                  </p>
                )}
              </div>

              <TurnstileField
                siteKey={turnstileSiteKey}
                action="auth_reset_password"
                onTokenChange={setTurnstileToken}
              />

              <Button
                type="submit"
                disabled={requestPending}
                className="min-h-11 w-full focus-visible:outline-solid md:min-h-10"
                data-testid="reset-request-submit"
              >
                <MailIcon className="size-4" aria-hidden="true" />
                {requestPending ? "Mengirim tautan..." : "Kirim tautan reset"}
              </Button>
            </form>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          render={<a href="/auth/login" />}
          className="min-h-11 px-2 md:min-h-8"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          Kembali ke halaman masuk
        </Button>
      </CardFooter>
    </Card>
  );
}
