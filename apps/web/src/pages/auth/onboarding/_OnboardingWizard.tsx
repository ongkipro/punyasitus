import * as React from "react";
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CalendarCheckIcon,
  CheckCircle2Icon,
  ClockIcon,
  CreditCardIcon,
  GlobeIcon,
  MailWarningIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  ONBOARDING_VERTICAL_OPTIONS,
  suggestHandleFromBusinessName,
  validateOnboardingHandleFormat,
  type OnboardingVertical,
} from "@punyasitus/core/onboarding/index";
import type {
  OwnerOnboardingStatus,
  PendingOnboardingRecovery,
} from "@punyasitus/db/provisioning/self-service";
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
import { cn } from "@/lib/utils";

export interface OnboardingWizardProps {
  readonly initialStatus: OwnerOnboardingStatus | null;
  readonly saasZone: string;
}

interface HandleCheckState {
  readonly status: "idle" | "checking" | "available" | "unavailable";
  readonly normalizedHandle: string;
  readonly primaryHost: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

interface ProvisionSuccessState {
  readonly handle: string;
  readonly name: string;
  readonly primaryHost: string;
  readonly grantedTrial: boolean;
  readonly awaitingFirstPayment: boolean;
  readonly trialEndsAt: number | null;
  readonly nextPath: string;
}

function createClientIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `onb-${Date.now()}-${Math.random().toString(16).slice(2, 14)}`;
}

function formatIndonesianDateTime(epochMs: number | null): string | null {
  if (!epochMs || !Number.isFinite(epochMs)) return null;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString();
  }
}

export function OnboardingWizard({ initialStatus, saasZone }: OnboardingWizardProps) {
  const [ownerStatus, setOwnerStatus] = React.useState<OwnerOnboardingStatus | null>(initialStatus);
  const [name, setName] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [handleTouched, setHandleTouched] = React.useState(false);
  const [vertical, setVertical] = React.useState<OnboardingVertical>("compro");

  const [nameError, setNameError] = React.useState<string | null>(null);
  const [handleError, setHandleError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [handleCheck, setHandleCheck] = React.useState<HandleCheckState>({
    status: "idle",
    normalizedHandle: "",
    primaryHost: null,
    code: null,
    message: null,
  });

  const [idempotencyKey, setIdempotencyKey] = React.useState<string>(() =>
    createClientIdempotencyKey(),
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [resumingTenantId, setResumingTenantId] = React.useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = React.useState<{
    readonly tenantId: string;
    readonly handle: string;
    readonly name: string;
    readonly idempotencyKey: string;
  } | null>(() => {
    const pending = initialStatus?.pendingRecoveries[0];
    if (!pending) return null;
    return {
      tenantId: pending.tenantId,
      handle: pending.handle,
      name: pending.name,
      idempotencyKey: pending.idempotencyKey,
    };
  });
  const [successResult, setSuccessResult] = React.useState<ProvisionSuccessState | null>(null);

  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const handleInputRef = React.useRef<HTMLInputElement>(null);
  const checkSeqRef = React.useRef(0);

  // Live debounced handle validation & availability check
  React.useEffect(() => {
    const trimmed = handle.trim();
    if (!trimmed) {
      setHandleCheck({
        status: "idle",
        normalizedHandle: "",
        primaryHost: null,
        code: null,
        message: null,
      });
      return;
    }

    const localValidation = validateOnboardingHandleFormat(trimmed, saasZone);
    if (!localValidation.ok) {
      setHandleError(localValidation.message);
      setHandleCheck({
        status: "unavailable",
        normalizedHandle: localValidation.normalizedHandle,
        primaryHost: null,
        code: localValidation.code,
        message: localValidation.message,
      });
      return;
    }

    setHandleError(null);
    const seq = checkSeqRef.current + 1;
    checkSeqRef.current = seq;
    setHandleCheck({
      status: "checking",
      normalizedHandle: localValidation.normalizedHandle,
      primaryHost: localValidation.primaryHost,
      code: null,
      message: "Memeriksa ketersediaan alamat...",
    });

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/onboarding/check-handle?handle=${encodeURIComponent(localValidation.normalizedHandle)}`,
          { credentials: "same-origin" },
        );
        const data = (await res.json().catch(() => ({}))) as {
          readonly available?: boolean;
          readonly normalizedHandle?: string;
          readonly primaryHost?: string | null;
          readonly code?: string;
          readonly message?: string;
        };
        if (checkSeqRef.current !== seq) return;

        if (res.ok && data.available) {
          setHandleError(null);
          setHandleCheck({
            status: "available",
            normalizedHandle: data.normalizedHandle ?? localValidation.normalizedHandle,
            primaryHost: data.primaryHost ?? localValidation.primaryHost,
            code: "AVAILABLE",
            message: data.message ?? `Tersedia: https://${localValidation.primaryHost}`,
          });
        } else {
          const msg =
            data.message ??
            `Alamat "${localValidation.primaryHost}" tidak tersedia. Pilih nama lain.`;
          setHandleError(msg);
          setHandleCheck({
            status: "unavailable",
            normalizedHandle: data.normalizedHandle ?? localValidation.normalizedHandle,
            primaryHost: data.primaryHost ?? localValidation.primaryHost,
            code: data.code ?? "HANDLE_TAKEN",
            message: msg,
          });
        }
      } catch {
        if (checkSeqRef.current !== seq) return;
        setHandleCheck({
          status: "idle",
          normalizedHandle: localValidation.normalizedHandle,
          primaryHost: localValidation.primaryHost,
          code: null,
          message: null,
        });
      }
    }, 220);

    return () => window.clearTimeout(timer);
  }, [handle, saasZone]);

  function handleNameChange(nextName: string) {
    setName(nextName);
    if (nameError) setNameError(null);
    if (!handleTouched) {
      const suggested = suggestHandleFromBusinessName(nextName);
      if (suggested) {
        setHandle(suggested);
      }
    }
    setIdempotencyKey(createClientIdempotencyKey());
  }

  function handleHandleChange(nextHandle: string) {
    setHandleTouched(true);
    setHandle(nextHandle);
    setIdempotencyKey(createClientIdempotencyKey());
  }

  function handleVerticalChange(nextVertical: OnboardingVertical) {
    setVertical(nextVertical);
    setIdempotencyKey(createClientIdempotencyKey());
  }

  async function refreshStatus() {
    try {
      const res = await fetch("/api/onboarding/status", { credentials: "same-origin" });
      if (!res.ok) return;
      const data = (await res.json()) as OwnerOnboardingStatus & { readonly success?: boolean };
      if (data.success && data.user) {
        setOwnerStatus(data);
        const firstPending: PendingOnboardingRecovery | undefined = data.pendingRecoveries[0];
        if (firstPending) {
          setRecoveryNotice({
            tenantId: firstPending.tenantId,
            handle: firstPending.handle,
            name: firstPending.name,
            idempotencyKey: firstPending.idempotencyKey,
          });
        } else {
          setRecoveryNotice(null);
        }
      }
    } catch {
      // Ignore silent refresh failures
    }
  }

  async function handleResumeRecovery() {
    if (!recoveryNotice) return;
    setFormError(null);
    setResumingTenantId(recoveryNotice.tenantId);

    try {
      const res = await fetch("/api/onboarding/provision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": recoveryNotice.idempotencyKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "resume_recovery",
          resumeTenantId: recoveryNotice.tenantId,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly message?: string;
        readonly awaitingFirstPayment?: boolean;
        readonly nextPath?: string;
        readonly tenant?: {
          readonly handle: string;
          readonly name: string;
          readonly primaryHost: string;
          readonly trialEndsAt: number | null;
        };
      };

      if (!res.ok || !data.success || !data.tenant) {
        setFormError(
          data.message ??
            "Penyimpanan situs masih belum dapat disiapkan. Data Anda tetap aman — silakan coba beberapa saat lagi.",
        );
        return;
      }

      setRecoveryNotice(null);
      setSuccessResult({
        handle: data.tenant.handle,
        name: data.tenant.name,
        primaryHost: data.tenant.primaryHost,
        grantedTrial: data.tenant.trialEndsAt !== null && !data.awaitingFirstPayment,
        awaitingFirstPayment: Boolean(data.awaitingFirstPayment),
        trialEndsAt: data.tenant.trialEndsAt,
        nextPath: data.nextPath ?? `/dashboard/${data.tenant.handle}`,
      });
      await refreshStatus();
    } catch {
      setFormError("Koneksi terputus saat melanjutkan penyiapan situs. Silakan coba lagi.");
    } finally {
      setResumingTenantId(null);
    }
  }

  async function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const trimmedName = name.trim();
    const localHandle = validateOnboardingHandleFormat(handle, saasZone);

    let hasErr = false;
    if (trimmedName.length < 2 || trimmedName.length > 160) {
      setNameError("Nama bisnis/website harus terdiri dari 2 hingga 160 karakter.");
      nameInputRef.current?.focus();
      hasErr = true;
    } else {
      setNameError(null);
    }

    if (!localHandle.ok) {
      setHandleError(localHandle.message);
      if (!hasErr) handleInputRef.current?.focus();
      hasErr = true;
    } else if (handleCheck.status === "unavailable") {
      setHandleError(
        handleCheck.message ?? `Alamat "${localHandle.primaryHost}" tidak tersedia.`,
      );
      if (!hasErr) handleInputRef.current?.focus();
      hasErr = true;
    }

    if (hasErr || !localHandle.ok) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/provision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          handle: localHandle.normalizedHandle,
          name: trimmedName,
          vertical,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        readonly success?: boolean;
        readonly code?: string;
        readonly message?: string;
        readonly field?: string;
        readonly grantedTrial?: boolean;
        readonly awaitingFirstPayment?: boolean;
        readonly recoveryRequired?: boolean;
        readonly idempotencyKey?: string;
        readonly nextPath?: string;
        readonly tenant?: {
          readonly id: string;
          readonly handle: string;
          readonly name: string;
          readonly primaryHost: string;
          readonly trialEndsAt: number | null;
        };
      };

      if (res.status === 202 && data.recoveryRequired && data.tenant) {
        setRecoveryNotice({
          tenantId: data.tenant.id,
          handle: data.tenant.handle,
          name: data.tenant.name,
          idempotencyKey: data.idempotencyKey ?? idempotencyKey,
        });
        return;
      }

      if (!res.ok || !data.success || !data.tenant) {
        if (
          data.code === "HANDLE_TAKEN" ||
          data.code === "INVALID_HANDLE" ||
          data.code === "RESERVED_HANDLE" ||
          data.field === "handle"
        ) {
          setHandleError(data.message ?? "Alamat situs tidak dapat digunakan.");
          handleInputRef.current?.focus();
          return;
        }
        if (data.code === "TRIAL_ALREADY_CONSUMED") {
          await refreshStatus();
        }
        setFormError(data.message ?? "Pembuatan situs tidak dapat diproses saat ini.");
        return;
      }

      setSuccessResult({
        handle: data.tenant.handle,
        name: data.tenant.name,
        primaryHost: data.tenant.primaryHost,
        grantedTrial: Boolean(data.grantedTrial),
        awaitingFirstPayment: Boolean(data.awaitingFirstPayment),
        trialEndsAt: data.tenant.trialEndsAt,
        nextPath: data.nextPath ?? `/dashboard/${data.tenant.handle}`,
      });
      await refreshStatus();
    } catch {
      setFormError(
        "Koneksi terputus saat menyiapkan website. Jangan khawatir — klik tombol kirim lagi untuk melanjutkan dengan aman tanpa duplikasi.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // 1. Unauthenticated prompt
  if (!ownerStatus) {
    return (
      <Card className="w-full max-w-lg shadow-none" data-testid="onboarding-unauthenticated">
        <CardHeader className="gap-1.5 border-b border-border pb-4">
          <div className="flex items-center gap-2 text-primary">
            <GlobeIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-wide uppercase">
              Pembuatan Website PunyaSitus
            </span>
          </div>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Masuk untuk membuat website Anda
            </h1>
          </CardTitle>
          <CardDescription>
            Setiap website terhubung ke akun pemilik yang terverifikasi agar uji coba gratis 7 hari
            dan kepemilikan domain Anda aman.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            render={<a href="/auth/register?next=%2Fauth%2Fonboarding" />}
            nativeButton={false}
            className="min-h-11 w-full text-sm font-semibold"
          >
            Daftar Akun Baru
          </Button>
          <Button
            render={<a href="/auth/login?next=%2Fauth%2Fonboarding" />}
            nativeButton={false}
            variant="outline"
            className="min-h-11 w-full text-sm font-semibold"
          >
            Masuk ke Akun yang Sudah Ada
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 2. Unverified email gate
  if (!ownerStatus.emailVerified) {
    return (
      <Card className="w-full max-w-lg shadow-none" data-testid="onboarding-unverified-gate">
        <CardHeader className="gap-1.5 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-warning">
              <MailWarningIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="text-xs font-semibold tracking-wide uppercase">
                Verifikasi Diperlukan
              </span>
            </div>
            <Badge variant="warning">Email Belum Terverifikasi</Badge>
          </div>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Verifikasi email sebelum membuat website
            </h1>
          </CardTitle>
          <CardDescription>
            Alamat email <strong className="text-foreground">{ownerStatus.user.email}</strong>{" "}
            belum terverifikasi. Konfirmasi email Anda terlebih dahulu untuk mengaktifkan uji coba
            gratis 7 hari.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            <AlertTitle>Pembuatan situs terkunci sementara</AlertTitle>
            <AlertDescription>
              Buka tautan verifikasi yang kami kirim ke kotak masuk Anda, atau minta tautan baru di
              halaman verifikasi email.
            </AlertDescription>
          </Alert>
          <Button
            render={<a href="/auth/verify-email" />}
            nativeButton={false}
            className="min-h-11 w-full gap-2 text-sm font-semibold"
            data-testid="goto-verify-email-btn"
          >
            <span>Buka Halaman Verifikasi Email</span>
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 3. Provisioned success card
  if (successResult) {
    const expiryLabel = formatIndonesianDateTime(successResult.trialEndsAt);
    return (
      <Card className="w-full max-w-xl shadow-none" data-testid="onboarding-success">
        <CardHeader className="gap-2 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="text-xs font-semibold tracking-wide uppercase">
                Website Siap Digunakan
              </span>
            </div>
            {successResult.grantedTrial ? (
              <Badge variant="success" data-testid="onboarding-result-badge">
                Uji Coba Gratis 7 Hari
              </Badge>
            ) : (
              <Badge variant="warning" data-testid="onboarding-result-badge">
                Menunggu Pembayaran Pertama
              </Badge>
            )}
          </div>
          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {successResult.name} berhasil dibuat
            </h1>
          </CardTitle>
          <CardDescription>
            Subdomain situs Anda:{" "}
            <span className="font-mono font-semibold text-foreground">
              {successResult.primaryHost}
            </span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {successResult.grantedTrial ? (
            <Alert variant="success">
              <CalendarCheckIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Uji coba gratis 7 hari (168 jam) aktif</AlertTitle>
              <AlertDescription>
                Situs Anda aktif di <strong>{successResult.primaryHost}</strong>
                {expiryLabel ? ` hingga ${expiryLabel} WIB` : " selama 7 hari penuh"}. Selama masa
                uji coba, situs memakai pengaturan tidak terindeks (noindex) dan domain kustom dapat
                dihubungkan setelah pembayaran pertama.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="warning">
              <CreditCardIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Situs tambahan — aktif setelah pembayaran</AlertTitle>
              <AlertDescription>
                Situs tambahan ini terpisah sepenuhnya dari situs Anda sebelumnya dan mulai dalam
                status menunggu pembayaran pertama (tanpa masa uji coba gratis baru). Selesaikan
                pembayaran QRIS atau Virtual Account untuk mengaktifkannya.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Button
              render={<a href={successResult.nextPath} />}
              nativeButton={false}
              className="min-h-11 flex-1 gap-2 text-sm font-semibold"
              data-testid="onboarding-open-dashboard"
            >
              <span>
                {successResult.awaitingFirstPayment
                  ? "Lanjut ke Pembayaran Situs"
                  : "Buka Dashboard Website"}
              </span>
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 text-sm font-medium"
              onClick={() => {
                setSuccessResult(null);
                setName("");
                setHandle("");
                setHandleTouched(false);
                setIdempotencyKey(createClientIdempotencyKey());
              }}
              data-testid="onboarding-create-another"
            >
              Buat Situs Lain
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const trialEligible = ownerStatus.trialEligible;

  return (
    <div className="w-full max-w-2xl space-y-5">
      {/* Partial-provisioning recovery banner */}
      {recoveryNotice && (
        <Alert
          variant="warning"
          data-testid="partial-provisioning-recovery"
          aria-live="assertive"
        >
          <ClockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Penyiapan penyimpanan situs sempat terhenti</AlertTitle>
          <AlertDescription>
            Situs <strong>{recoveryNotice.name}</strong> (
            <span className="font-mono">
              {recoveryNotice.handle}.{saasZone}
            </span>
            ) sudah tercatat di akun Anda, tetapi inisialisasi penyimpanan dasarnya belum selesai.
            Klik tombol di bawah untuk melanjutkannya tanpa membuat situs ganda atau mengubah sisa
            masa aktif.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="default"
              disabled={resumingTenantId !== null}
              onClick={handleResumeRecovery}
              className="min-h-11 gap-2 text-sm font-semibold"
              data-testid="resume-provisioning-btn"
            >
              <RefreshCwIcon
                className={resumingTenantId ? "size-4 animate-spin" : "size-4"}
                aria-hidden="true"
              />
              <span>
                {resumingTenantId
                  ? "Melanjutkan penyiapan..."
                  : "Lanjutkan Penyiapan Situs"}
              </span>
            </Button>
          </AlertAction>
        </Alert>
      )}

      <Card className="w-full shadow-none" data-testid="onboarding-card">
        <CardHeader className="gap-2 border-b border-border pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="text-xs font-semibold tracking-wide uppercase">
                Identitas Terverifikasi
              </span>
            </div>
            {trialEligible ? (
              <Badge variant="success" data-testid="trial-eligibility-badge">
                Uji coba gratis 7 hari
              </Badge>
            ) : (
              <Badge variant="warning" data-testid="trial-eligibility-badge">
                Situs tambahan — aktif setelah pembayaran
              </Badge>
            )}
          </div>

          <CardTitle>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {trialEligible ? "Buat website pertama Anda" : "Buat website tambahan"}
            </h1>
          </CardTitle>
          <CardDescription>
            {trialEligible
              ? `Pilih nama bisnis, alamat .${saasZone}, dan jenis tema bawaan. Situs langsung aktif selama 7 hari (168 jam) tanpa kartu kredit.`
              : "Jatah 1× uji coba gratis 7 hari untuk akun Anda telah terpakai. Situs tambahan tetap memiliki ruang kerja terpisah dan langsung aktif setelah pembayaran pertama."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* Explicit 1st-site trial vs 2nd-site payment-only disclosure */}
          {trialEligible ? (
            <Alert variant="success" data-testid="trial-disclosure-banner">
              <CalendarCheckIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Uji coba gratis 7 hari penuh (168 jam)</AlertTitle>
              <AlertDescription>
                Berlaku satu kali per pemilik terverifikasi di subdomain{" "}
                <span className="font-mono font-medium">.{saasZone}</span> (100 MB penyimpanan,
                status tidak terindeks selama uji coba). Anda bisa upgrade ke paket bulanan atau
                tahunan kapan saja.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="warning" data-testid="payment-only-disclosure-banner">
              <CreditCardIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Situs tambahan — aktif setelah pembayaran</AlertTitle>
              <AlertDescription>
                Sesuai kebijakan satu uji coba per akun terverifikasi, situs baru ini tidak
                mendapatkan masa uji coba gratis baru dan dimulai dalam status menunggu pembayaran
                pertama (Rp 179.000/bulan atau Rp 1.790.000/tahun, belum termasuk PPN).
              </AlertDescription>
            </Alert>
          )}

          {formError && (
            <Alert variant="destructive" data-testid="onboarding-form-error" aria-live="assertive">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Tidak dapat membuat website</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <form
            onSubmit={handleSubmit}
            noValidate
            className="space-y-5"
            data-testid="onboarding-form"
          >
            {/* 1. Business / Website Name */}
            <div className="space-y-1.5">
              <label
                htmlFor="onboarding-name"
                className="block text-sm font-medium text-foreground"
              >
                Nama bisnis atau website
              </label>
              <Input
                ref={nameInputRef}
                id="onboarding-name"
                name="name"
                type="text"
                autoComplete="organization"
                required
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                aria-invalid={nameError ? "true" : undefined}
                aria-describedby={nameError ? "onboarding-name-error" : "onboarding-name-hint"}
                placeholder="Contoh: Kopi Nusantara Jakarta"
                disabled={submitting}
                className="focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              <p id="onboarding-name-hint" className="text-xs text-muted-foreground">
                Nama ini dapat diubah kembali kapan saja dari pengaturan situs.
              </p>
              {nameError && (
                <p
                  id="onboarding-name-error"
                  role="alert"
                  className="text-xs font-medium text-destructive"
                >
                  {nameError}
                </p>
              )}
            </div>

            {/* 2. Handle input with fixed .situsku.click domain suffix */}
            <div className="space-y-1.5">
              <label
                htmlFor="onboarding-handle"
                className="block text-sm font-medium text-foreground"
              >
                Alamat situs sementara
              </label>
              <div
                className={cn(
                  "flex min-h-11 w-full items-stretch overflow-hidden rounded-md border bg-card transition-colors focus-within:ring-2 focus-within:ring-ring/30 md:min-h-10",
                  handleError
                    ? "border-destructive focus-within:border-destructive"
                    : "border-input focus-within:border-ring",
                )}
              >
                <input
                  ref={handleInputRef}
                  id="onboarding-handle"
                  name="handle"
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={handle}
                  onChange={(e) => handleHandleChange(e.target.value)}
                  aria-invalid={handleError ? "true" : undefined}
                  aria-describedby={
                    handleError ? "onboarding-handle-error" : "onboarding-handle-status"
                  }
                  placeholder="kopi-nusantara"
                  disabled={submitting}
                  className="min-h-11 min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:min-h-10"
                />
                <span
                  data-testid="fixed-domain-suffix"
                  className="inline-flex shrink-0 items-center border-l border-border bg-secondary px-3 font-mono text-xs font-medium text-muted-foreground select-none sm:text-sm"
                >
                  .{saasZone}
                </span>
              </div>

              <div id="onboarding-handle-status" aria-live="polite" className="min-h-5">
                {handleError ? (
                  <p
                    id="onboarding-handle-error"
                    role="alert"
                    data-testid="onboarding-handle-error"
                    className="text-xs font-medium text-destructive"
                  >
                    {handleError}
                  </p>
                ) : handleCheck.status === "checking" ? (
                  <p className="text-xs text-muted-foreground">{handleCheck.message}</p>
                ) : handleCheck.status === "available" && handleCheck.primaryHost ? (
                  <p
                    data-testid="handle-available-preview"
                    className="flex items-center gap-1.5 text-xs font-medium text-success"
                  >
                    <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      Tersedia:{" "}
                      <span className="font-mono">https://{handleCheck.primaryHost}</span>
                    </span>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    3–40 karakter huruf kecil, angka, atau tanda hubung. Alamat ini bersifat tetap;
                    domain sendiri dapat ditambahkan setelah aktif berbayar.
                  </p>
                )}
              </div>
            </div>

            {/* 3. Business Vertical / Starter Theme */}
            <fieldset className="space-y-2.5" disabled={submitting}>
              <legend className="text-sm font-medium text-foreground">
                Pilih jenis bisnis & tema awal
              </legend>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {ONBOARDING_VERTICAL_OPTIONS.map((option) => {
                  const selected = vertical === option.id;
                  return (
                    <label
                      key={option.id}
                      data-testid={`vertical-option-${option.id}`}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                        selected
                          ? "border-primary bg-success-soft/60 text-foreground"
                          : "border-border bg-card text-foreground hover:bg-secondary/50",
                      )}
                    >
                      <input
                        type="radio"
                        name="vertical"
                        value={option.id}
                        checked={selected}
                        onChange={() => handleVerticalChange(option.id)}
                        className="sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
                          selected ? "border-primary bg-primary" : "border-input bg-card",
                        )}
                      >
                        {selected && <span className="size-1.5 rounded-full bg-primary-foreground" />}
                      </span>
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-semibold leading-snug">
                          {option.label}
                        </span>
                        <span className="block text-xs leading-relaxed text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <Button
              type="submit"
              variant="default"
              disabled={submitting}
              className="min-h-11 w-full gap-2 text-sm font-semibold focus-visible:outline-solid"
              data-testid="onboarding-submit"
            >
              <span>
                {submitting
                  ? "Menyiapkan website Anda..."
                  : trialEligible
                    ? "Buat Website & Mulai Uji Coba 7 Hari"
                    : "Buat Situs Tambahan (Lanjut ke Pembayaran)"}
              </span>
              <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
          </form>

          {/* Compact list of already owned sites when creating 2nd+ site */}
          {ownerStatus.ownedSites.length > 0 && (
            <div
              className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3.5"
              data-testid="owned-sites-summary"
            >
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Situs yang sudah Anda miliki ({ownerStatus.ownedSites.length})
              </p>
              <ul className="space-y-1.5">
                {ownerStatus.ownedSites.map((site) => (
                  <li
                    key={site.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-foreground">{site.name}</span>{" "}
                      <span className="font-mono text-xs text-muted-foreground">
                        ({site.primaryHost})
                      </span>
                    </div>
                    <a
                      href={
                        site.awaitingFirstPayment
                          ? `/dashboard/${encodeURIComponent(site.handle)}/billing`
                          : `/dashboard/${encodeURIComponent(site.handle)}`
                      }
                      className="inline-flex min-h-11 items-center text-xs font-semibold text-primary underline-offset-4 hover:underline md:min-h-0"
                    >
                      {site.awaitingFirstPayment ? "Selesaikan Pembayaran" : "Buka Dashboard"}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <span>Akun terverifikasi: {ownerStatus.user.email}</span>
          <a
            href="/account"
            className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
          >
            Pengaturan Akun
          </a>
        </CardFooter>
      </Card>
    </div>
  );
}
