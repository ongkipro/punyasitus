import * as React from "react";
import { AlertCircleIcon, UserPlusIcon } from "lucide-react";
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
import { GoogleMark, HoneypotField, TurnstileField } from "../_AuthShared";

export interface RegisterFormProps {
  readonly nextPath: string;
  readonly turnstileSiteKey?: string;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function RegisterForm({ nextPath, turnstileSiteKey = "" }: RegisterFormProps) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [honeypot, setHoneypot] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");

  const [nameError, setNameError] = React.useState<string | null>(null);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [googleSubmitting, setGoogleSubmitting] = React.useState(false);

  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const emailInputRef = React.useRef<HTMLInputElement>(null);
  const passwordInputRef = React.useRef<HTMLInputElement>(null);

  const isBusy = submitting || googleSubmitting;

  async function handleGoogleSignUp() {
    setFormError(null);
    setGoogleSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          provider: "google",
          callbackURL: nextPath,
        }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          setFormError(
            "Masuk dengan Google belum diaktifkan pada lingkungan ini. Silakan daftar menggunakan email dan kata sandi.",
          );
          return;
        }
        setFormError(
          "Tidak dapat memulai pendaftaran melalui Google saat ini. Silakan coba lagi atau gunakan email.",
        );
        return;
      }

      const data = (await response.json()) as { readonly url?: unknown };
      if (typeof data.url === "string" && data.url.trim().length > 0) {
        window.location.assign(data.url);
        return;
      }
      setFormError(
        "Respons autentikasi Google tidak lengkap. Silakan coba lagi atau gunakan email.",
      );
    } catch {
      setFormError(
        "Tidak dapat terhubung ke layanan autentikasi Google. Periksa koneksi internet Anda lalu coba lagi.",
      );
    } finally {
      setGoogleSubmitting(false);
    }
  }

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    let nextNameErr: string | null = null;
    let nextEmailErr: string | null = null;
    let nextPasswordErr: string | null = null;

    if (trimmedName.length < 2) {
      nextNameErr = "Nama lengkap minimal terdiri dari 2 karakter.";
    }

    if (!trimmedEmail) {
      nextEmailErr = "Alamat email wajib diisi.";
    } else if (!SIMPLE_EMAIL_RE.test(trimmedEmail)) {
      nextEmailErr = "Masukkan alamat email yang valid.";
    }

    if (!password) {
      nextPasswordErr = "Kata sandi wajib diisi.";
    } else if (password.length < 8) {
      nextPasswordErr = "Kata sandi minimal terdiri dari 8 karakter.";
    } else if (password.length > 128) {
      nextPasswordErr = "Kata sandi maksimal 128 karakter.";
    }

    setNameError(nextNameErr);
    setEmailError(nextEmailErr);
    setPasswordError(nextPasswordErr);

    if (nextNameErr) {
      nameInputRef.current?.focus();
      return;
    }
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
      const payload: Record<string, unknown> = {
        name: trimmedName,
        email: trimmedEmail,
        password,
      };
      if (turnstileToken) {
        payload["cf-turnstile-response"] = turnstileToken;
      }
      if (honeypot) {
        payload.hp_website = honeypot;
      }

      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 403) {
          setFormError(
            "Verifikasi keamanan Turnstile diperlukan atau sudah kedaluwarsa. Selesaikan verifikasi lalu coba lagi.",
          );
          return;
        }
        setFormError(
          "Pendaftaran tidak dapat diproses. Pastikan alamat email valid dan belum terdaftar, atau masuk melalui Google.",
        );
        return;
      }

      window.location.assign(nextPath);
    } catch {
      setFormError(
        "Tidak dapat terhubung ke layanan pendaftaran. Data yang Anda isi tetap tersimpan, silakan coba lagi.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md shadow-none">
      <CardHeader className="gap-1.5 border-b border-border pb-4">
        <div className="flex items-center gap-2 text-primary">
          <UserPlusIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-xs font-semibold tracking-wide uppercase">
            Mulai Bersama PunyaSitus
          </span>
        </div>
        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Buat akun PunyaSitus
          </h1>
        </CardTitle>
        <CardDescription>
          Gunakan Google untuk masuk lebih cepat, atau daftar menggunakan email dan kata sandi.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {formError && (
          <Alert variant="destructive" data-testid="register-form-error" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Pendaftaran gagal</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <Button
          type="button"
          variant="default"
          disabled={isBusy}
          onClick={handleGoogleSignUp}
          className="min-h-11 w-full gap-2.5 text-sm font-semibold focus-visible:outline-solid"
          data-testid="google-signup-button"
        >
          <GoogleMark />
          <span>{googleSubmitting ? "Mengarahkan ke Google..." : "Masuk dengan Google"}</span>
        </Button>

        <div className="relative flex items-center py-1" role="separator">
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
          <span className="px-3 text-xs font-medium text-muted-foreground">
            atau daftar dengan email
          </span>
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>

        <form
          method="post"
          onSubmit={handleSubmit}
          noValidate
          className="relative space-y-4"
          data-testid="register-form"
        >
          <HoneypotField id="register-hp-website" value={honeypot} onChange={setHoneypot} />

          <div className="space-y-1.5">
            <label
              htmlFor="register-name"
              className="block text-sm font-medium text-foreground"
            >
              Nama lengkap
            </label>
            <Input
              ref={nameInputRef}
              id="register-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              aria-invalid={nameError ? "true" : undefined}
              aria-describedby={nameError ? "register-name-error" : undefined}
              placeholder="Budi Santoso"
              disabled={isBusy}
            />
            {nameError && (
              <p
                id="register-name-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {nameError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-email"
              className="block text-sm font-medium text-foreground"
            >
              Alamat email
            </label>
            <Input
              ref={emailInputRef}
              id="register-email"
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
              aria-describedby={emailError ? "register-email-error" : undefined}
              placeholder="nama@bisnisanda.id"
              disabled={isBusy}
            />
            {emailError && (
              <p
                id="register-email-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-password"
              className="block text-sm font-medium text-foreground"
            >
              Kata sandi
            </label>
            <Input
              ref={passwordInputRef}
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              aria-invalid={passwordError ? "true" : undefined}
              aria-describedby={
                passwordError ? "register-password-error" : "register-password-hint"
              }
              disabled={isBusy}
            />
            <p id="register-password-hint" className="text-xs text-muted-foreground">
              Minimal 8 karakter. Gunakan kombinasi huruf, angka, dan simbol.
            </p>
            {passwordError && (
              <p
                id="register-password-error"
                role="alert"
                className="text-xs font-medium text-destructive"
              >
                {passwordError}
              </p>
            )}
          </div>

          <TurnstileField
            siteKey={turnstileSiteKey}
            action="auth_register"
            onTokenChange={setTurnstileToken}
          />

          <Button
            type="submit"
            variant="outline"
            disabled={isBusy}
            className="min-h-11 w-full focus-visible:outline-solid md:min-h-10"
            data-testid="register-submit"
          >
            <UserPlusIcon className="size-4" aria-hidden="true" />
            {submitting ? "Membuat akun..." : "Daftar dengan Email"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="flex flex-col items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1 text-sm text-foreground">
          <span>Sudah punya akun?</span>
          <a
            href="/auth/login"
            data-testid="register-to-login-link"
            className="inline-flex min-h-11 items-center px-1 font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
          >
            Masuk di sini
          </a>
        </div>
        <p>
          Pendaftaran dilindungi oleh cookie keamanan khusus host dan verifikasi anti-bot
          Cloudflare Turnstile.
        </p>
      </CardFooter>
    </Card>
  );
}
