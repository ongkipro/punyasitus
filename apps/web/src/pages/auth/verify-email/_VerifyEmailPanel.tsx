import * as React from "react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ClockIcon,
  MailCheckIcon,
  RefreshCwIcon,
  WifiOffIcon,
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
import { HoneypotField, TurnstileField } from "../_AuthShared";

export interface VerifyEmailPanelProps {
  readonly initialToken: string;
  readonly initialStatusHint: string;
  readonly initialEmail: string;
  readonly initialAlreadyVerified: boolean;
  readonly isAuthenticated: boolean;
  readonly turnstileSiteKey?: string;
}

type VerifyState =
  | "awaiting"
  | "verifying"
  | "verified"
  | "already_verified"
  | "expired"
  | "invalid"
  | "email_outage";

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function resolveInitialState(props: VerifyEmailPanelProps): VerifyState {
  if (props.initialAlreadyVerified) return "already_verified";
  if (props.initialToken) return "verifying";
  if (props.initialStatusHint === "expired") return "expired";
  if (props.initialStatusHint === "email_outage") return "email_outage";
  return "awaiting";
}

export function VerifyEmailPanel(props: VerifyEmailPanelProps) {
  const [state, setState] = React.useState<VerifyState>(() => resolveInitialState(props));
  const [statusMessage, setStatusMessage] = React.useState<string | null>(() => {
    if (props.initialStatusHint === "expired") {
      return "Tautan verifikasi email Anda sudah kedaluwarsa. Minta tautan baru di bawah untuk melanjutkan pendaftaran situs.";
    }
    if (props.initialStatusHint === "email_outage") {
      return "Layanan pengiriman email sedang mengalami gangguan sementara. Akun Anda tetap tersimpan aman — coba kirim ulang beberapa saat lagi atau masuk dengan Google.";
    }
    return null;
  });

  const [email, setEmail] = React.useState(props.initialEmail);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [honeypot, setHoneypot] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [resending, setResending] = React.useState(false);
  const [resendSuccess, setResendSuccess] = React.useState<string | null>(null);
  const [resendError, setResendError] = React.useState<string | null>(null);
  const [emailOutageBanner, setEmailOutageBanner] = React.useState(
    props.initialStatusHint === "email_outage",
  );

  const attemptedTokenRef = React.useRef<string>("");

  React.useEffect(() => {
    if (!props.initialToken || props.initialAlreadyVerified) return;
    if (attemptedTokenRef.current === props.initialToken) return;
    attemptedTokenRef.current = props.initialToken;

    let cancelled = false;
    async function redeem() {
      setState("verifying");
      setStatusMessage(null);
      try {
        const res = await fetch("/api/onboarding/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token: props.initialToken }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          readonly status?: string;
          readonly code?: string;
          readonly message?: string;
        };

        if (cancelled) return;

        if (res.ok) {
          setState(data.status === "already_verified" ? "already_verified" : "verified");
          setStatusMessage(
            data.message ??
              "Alamat email Anda berhasil diverifikasi. Anda kini dapat membuat website.",
          );
          return;
        }

        if (res.status === 410 || data.code === "VERIFICATION_TOKEN_EXPIRED") {
          setState("expired");
          setStatusMessage(
            data.message ??
              "Tautan verifikasi email sudah kedaluwarsa. Kirim ulang tautan baru di bawah.",
          );
          return;
        }

        setState("invalid");
        setStatusMessage(
          data.message ??
            "Tautan verifikasi tidak valid atau sudah tidak berlaku. Minta tautan baru di bawah.",
        );
      } catch {
        if (cancelled) return;
        setState("invalid");
        setStatusMessage(
          "Tidak dapat menghubungi server verifikasi saat ini. Periksa koneksi Anda lalu muat ulang halaman.",
        );
      }
    }

    void redeem();
    return () => {
      cancelled = true;
    };
  }, [props.initialToken, props.initialAlreadyVerified]);

  async function handleResend(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setResendSuccess(null);
    setResendError(null);
    setEmailError(null);

    const trimmedEmail = email.trim();
    if (!props.isAuthenticated) {
      if (!trimmedEmail) {
        setEmailError("Masukkan alamat email akun Anda.");
        return;
      }
      if (!SIMPLE_EMAIL_RE.test(trimmedEmail)) {
        setEmailError("Masukkan alamat email yang valid.");
        return;
      }
    }

    setResending(true);
    try {
      const payload: Record<string, unknown> = {};
      if (!props.isAuthenticated && trimmedEmail) {
        payload.email = trimmedEmail;
      }
      if (turnstileToken) {
        payload["cf-turnstile-response"] = turnstileToken;
      }
      if (honeypot) {
        payload.hp_website = honeypot;
      }

      const res = await fetch("/api/onboarding/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => ({}))) as {
        readonly status?: string;
        readonly code?: string;
        readonly emailOutage?: boolean;
        readonly message?: string;
      };

      if (res.ok) {
        setEmailOutageBanner(false);
        if (data.status === "already_verified") {
          setState("already_verified");
          setStatusMessage(data.message ?? "Alamat email akun Anda sudah terverifikasi.");
          return;
        }
        setResendSuccess(
          data.message ??
            "Tautan verifikasi baru telah dikirim ke kotak masuk email Anda. Periksa juga folder Spam/Promosi.",
        );
        return;
      }

      if (res.status === 503 || data.code === "EMAIL_DELIVERY_FAILED" || data.emailOutage) {
        setEmailOutageBanner(true);
        setResendError(
          data.message ??
            "Layanan pengiriman email sedang mengalami gangguan sementara. Akun Anda tetap aman — coba lagi beberapa menit lagi.",
        );
        return;
      }

      setResendError(
        data.message ?? "Tidak dapat mengirim ulang tautan verifikasi saat ini. Coba lagi nanti.",
      );
    } catch {
      setEmailOutageBanner(true);
      setResendError(
        "Koneksi ke layanan verifikasi terputus. Periksa jaringan Anda lalu coba kirim ulang.",
      );
    } finally {
      setResending(false);
    }
  }

  const isDone = state === "verified" || state === "already_verified";

  return (
    <Card className="w-full max-w-lg shadow-none" data-testid="verify-email-card">
      <CardHeader className="gap-1.5 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-primary">
            <MailCheckIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Verifikasi Email Akun
            </span>
          </div>
          {isDone ? (
            <Badge variant="success" data-testid="verify-status-badge">
              Email Terverifikasi
            </Badge>
          ) : state === "expired" ? (
            <Badge variant="warning" data-testid="verify-status-badge">
              Tautan Kedaluwarsa
            </Badge>
          ) : emailOutageBanner ? (
            <Badge variant="destructive" data-testid="verify-status-badge">
              Gangguan Layanan Email
            </Badge>
          ) : (
            <Badge variant="info" data-testid="verify-status-badge">
              Menunggu Verifikasi
            </Badge>
          )}
        </div>

        <CardTitle>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {isDone
              ? "Email Anda sudah terverifikasi"
              : state === "verifying"
                ? "Memverifikasi tautan email..."
                : state === "expired"
                  ? "Tautan verifikasi kedaluwarsa"
                  : "Konfirmasi alamat email Anda"}
          </h1>
        </CardTitle>
        <CardDescription>
          {isDone
            ? "Identitas akun Anda telah dikonfirmasi. Lanjutkan untuk membuat website dengan subdomain .situsku.click."
            : "Kami mewajibkan verifikasi email sebelum membuat website pertama agar uji coba gratis 7 hari tetap aman dan terlindungi."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {state === "verifying" && (
          <Alert variant="info" data-testid="verify-loading-alert" aria-live="polite">
            <RefreshCwIcon className="size-4 animate-spin" aria-hidden="true" />
            <AlertTitle>Memeriksa tautan verifikasi</AlertTitle>
            <AlertDescription>
              Mohon tunggu sebentar, kami sedang mengonfirmasi token verifikasi sekali pakai Anda.
            </AlertDescription>
          </Alert>
        )}

        {isDone && (
          <Alert variant="success" data-testid="verify-success-alert" aria-live="polite">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            <AlertTitle>
              {state === "already_verified"
                ? "Akun sudah terverifikasi"
                : "Verifikasi email berhasil"}
            </AlertTitle>
            <AlertDescription>
              {statusMessage ??
                "Alamat email Anda telah dikonfirmasi. Anda dapat langsung melanjutkan pembuatan website."}
            </AlertDescription>
          </Alert>
        )}

        {state === "expired" && (
          <Alert variant="warning" data-testid="verify-expired-alert" aria-live="assertive">
            <ClockIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Tautan verifikasi sudah kedaluwarsa</AlertTitle>
            <AlertDescription>
              {statusMessage ??
                "Demi keamanan, tautan verifikasi hanya berlaku 30 menit dan satu kali pakai. Kirim ulang tautan baru melalui formulir di bawah."}
            </AlertDescription>
          </Alert>
        )}

        {state === "invalid" && (
          <Alert variant="destructive" data-testid="verify-invalid-alert" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Tautan verifikasi tidak valid</AlertTitle>
            <AlertDescription>
              {statusMessage ??
                "Tautan verifikasi rusak atau sudah tidak berlaku. Minta tautan verifikasi baru di bawah."}
            </AlertDescription>
          </Alert>
        )}

        {emailOutageBanner && (
          <Alert variant="destructive" data-testid="verify-email-outage-banner" aria-live="assertive">
            <WifiOffIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Pengiriman email sedang terganggu sementara</AlertTitle>
            <AlertDescription>
              Layanan email transaksional sedang mengalami gangguan sementara. Data akun Anda tetap
              tersimpan aman. Anda dapat mencoba kirim ulang beberapa saat lagi, atau masuk memakai
              akun Google yang terverifikasi.
            </AlertDescription>
          </Alert>
        )}

        {resendSuccess && (
          <Alert variant="success" data-testid="resend-success-alert" aria-live="polite">
            <CheckCircle2Icon className="size-4" aria-hidden="true" />
            <AlertTitle>Permintaan pengiriman diterima</AlertTitle>
            <AlertDescription>{resendSuccess}</AlertDescription>
          </Alert>
        )}

        {resendError && !emailOutageBanner && (
          <Alert variant="destructive" data-testid="resend-error-alert" aria-live="assertive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Pengiriman ulang tertunda</AlertTitle>
            <AlertDescription>{resendError}</AlertDescription>
          </Alert>
        )}

        {isDone ? (
          <div className="pt-1">
            <Button
              render={<a href="/auth/onboarding" />}
              nativeButton={false}
              className="min-h-11 w-full gap-2 text-sm font-semibold"
              data-testid="verify-continue-onboarding"
            >
              <span>Lanjut Buat Website</span>
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <form
            onSubmit={handleResend}
            noValidate
            className="relative space-y-4"
            data-testid="resend-verification-form"
          >
            <HoneypotField id="verify-hp-website" value={honeypot} onChange={setHoneypot} />

            {!props.isAuthenticated ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="verify-resend-email"
                  className="block text-sm font-medium text-foreground"
                >
                  Alamat email akun
                </label>
                <Input
                  id="verify-resend-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  aria-invalid={emailError ? "true" : undefined}
                  aria-describedby={emailError ? "verify-resend-email-error" : undefined}
                  placeholder="nama@bisnisanda.id"
                  disabled={resending}
                />
                {emailError && (
                  <p
                    id="verify-resend-email-error"
                    role="alert"
                    className="text-xs font-medium text-destructive"
                  >
                    {emailError}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border bg-secondary/60 px-3 py-2.5 text-sm text-foreground">
                <span className="text-muted-foreground">Email terdaftar: </span>
                <span className="font-medium break-all">{props.initialEmail}</span>
              </div>
            )}

            <TurnstileField
              siteKey={props.turnstileSiteKey}
              action="auth_verify_resend"
              onTokenChange={setTurnstileToken}
            />

            <Button
              type="submit"
              variant="default"
              disabled={resending || state === "verifying"}
              className="min-h-11 w-full gap-2 text-sm font-semibold focus-visible:outline-solid"
              data-testid="resend-verification-btn"
            >
              <RefreshCwIcon
                className={resending ? "size-4 animate-spin" : "size-4"}
                aria-hidden="true"
              />
              <span>
                {resending ? "Mengirim tautan verifikasi..." : "Kirim Ulang Tautan Verifikasi"}
              </span>
            </Button>
          </form>
        )}
      </CardContent>

      <CardFooter className="flex flex-col items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <a
            href="/auth/login?next=%2Fauth%2Fonboarding"
            className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
          >
            Masuk dengan Google / Akun Lain
          </a>
          {isDone && (
            <a
              href="/account"
              className="inline-flex min-h-11 items-center font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-0"
            >
              Buka Pengaturan Akun
            </a>
          )}
        </div>
        <p>
          Tautan verifikasi bersifat sekali pakai, berlaku 30 menit, dan dibatasi maksimal 3 kali
          pengiriman per jam demi keamanan akun Anda.
        </p>
      </CardFooter>
    </Card>
  );
}
