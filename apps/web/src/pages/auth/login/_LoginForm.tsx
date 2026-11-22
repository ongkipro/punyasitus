import * as React from "react";
import { AlertCircleIcon, CheckCircle2Icon, LockIcon, LogInIcon } from "lucide-react";
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

export interface LoginFormProps {
  readonly nextPath: string;
  readonly sessionExpired?: boolean;
  readonly passwordResetSuccess?: boolean;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function LoginForm({
  nextPath,
  sessionExpired = false,
  passwordResetSuccess = false,
}: LoginFormProps) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const emailInputRef = React.useRef<HTMLInputElement>(null);
  const passwordInputRef = React.useRef<HTMLInputElement>(null);

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const trimmedEmail = email.trim();
    let nextEmailErr: string | null = null;
    let nextPasswordErr: string | null = null;

    if (!trimmedEmail) {
      nextEmailErr = "Alamat email wajib diisi.";
    } else if (!SIMPLE_EMAIL_RE.test(trimmedEmail)) {
      nextEmailErr = "Masukkan alamat email yang valid.";
    }

    if (!password) {
      nextPasswordErr = "Kata sandi wajib diisi.";
    } else if (password.length < 8) {
      nextPasswordErr = "Kata sandi minimal terdiri dari 8 karakter.";
    }

    setEmailError(nextEmailErr);
    setPasswordError(nextPasswordErr);

    if (nextEmailErr) {
      emailInputRef.current?.focus();
      return;
    }
    if (nextPasswordErr) {
      passwordInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          email: trimmedEmail,
          password,
        }),
      });

      if (!response.ok) {
        // Non-enumerating error message (PLAN §4 & §17.4): never disclose whether account exists.
        setFormError("Email atau kata sandi tidak sesuai. Periksa kembali data Anda.");
        return;
      }

      window.location.assign(nextPath);
    } catch {
      setFormError(
        "Tidak dapat terhubung ke layanan autentikasi. Data email Anda tetap tersimpan, silakan coba lagi.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md shadow-none">
      <CardHeader className="gap-1.5 border-b border-border pb-4">
        <div className="flex items-center gap-2 text-primary">
          <LockIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold tracking-wide uppercase">
            Akses Dasbor PunyaSitus
          </span>
        </div>
        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Masuk ke akun Anda
          </h1>
        </CardTitle>
        <CardDescription>
          Kelola situs web, halaman, pesan masuk, dan pengaturan akun Anda.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {sessionExpired && (
          <Alert variant="warning" data-testid="session-expired-alert">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Sesi berakhir</AlertTitle>
            <AlertDescription>
              Sesi Anda telah berakhir demi keamanan akun. Silakan masuk kembali untuk melanjutkan.
            </AlertDescription>
          </Alert>
        )}

        {passwordResetSuccess && (
          <Alert variant="success" data-testid="reset-success-alert">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            <AlertTitle>Kata sandi diperbarui</AlertTitle>
            <AlertDescription>
              Kata sandi baru Anda sudah aktif. Silakan masuk menggunakan kata sandi baru.
            </AlertDescription>
          </Alert>
        )}

        {formError && (
          <Alert variant="destructive" data-testid="login-form-error" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Gagal masuk</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-4" data-testid="login-form">
          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-foreground"
            >
              Alamat email
            </label>
            <Input
              ref={emailInputRef}
              id="login-email"
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
              aria-describedby={emailError ? "login-email-error" : undefined}
              placeholder="nama@bisnisanda.id"
              disabled={submitting}
            />
            {emailError && (
              <p
                id="login-email-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="login-password"
                className="block text-sm font-medium text-foreground"
              >
                Kata sandi
              </label>
              <a
                href="/auth/reset-password"
                className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
              >
                Lupa kata sandi?
              </a>
            </div>
            <Input
              ref={passwordInputRef}
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              aria-invalid={passwordError ? "true" : undefined}
              aria-describedby={passwordError ? "login-password-error" : undefined}
              disabled={submitting}
            />
            {passwordError && (
              <p
                id="login-password-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {passwordError}
              </p>
            )}
          </div>

          <Button
            type="submit"
            disabled={submitting}
            className="min-h-11 w-full md:min-h-10"
            data-testid="login-submit"
          >
            <LogInIcon className="size-4" aria-hidden="true" />
            {submitting ? "Memeriksa kredensial..." : "Masuk"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
        <p>
          Halaman ini hanya tersedia di domain platform resmi PunyaSitus dengan cookie keamanan
          khusus host.
        </p>
      </CardFooter>
    </Card>
  );
}
