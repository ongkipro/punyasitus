import * as React from "react";
import {
  CONTACT_PREFERENCE_LABELS_ID,
  CUSTOM_THEME_MAX_BRIEF_LENGTH,
  CUSTOM_THEME_MAX_REFERENCE_URLS,
  CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL,
  type ContactPreference,
  type CustomThemeRequestStatus,
} from "@punyasitus/core/custom-themes/index";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  InfoIcon,
  MessageCircleIcon,
  PaletteIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
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
import type {
  TenantCustomThemeDailyQuotaDto,
  TenantCustomThemePackageDto,
  TenantCustomThemeRequestDto,
  TenantCustomThemeServiceStateDto,
} from "../../../pages/api/tenants/[tenantId]/custom-theme-requests/_shared.ts";

/**
 * Custom Theme Service Page (`shadcn/ui` `base-nova`, `@base-ui/react`, `render` prop composition)
 * for `/dashboard/[handle]/appearance/themes/custom` (REQ-063, PLAN §11.4, DESIGN.md).
 */

export interface CustomThemeServicePageProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly themesLibraryHref: string;
  readonly requestsApiUrl: string;
  readonly packagesApiUrl: string;
  readonly initialState: TenantCustomThemeServiceStateDto;
}

interface ApiFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

function generateSubmissionKey(): string {
  try {
    return `ctr-${crypto.randomUUID()}`;
  } catch {
    return `ctr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function formatDateTimeId(iso: string): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusBadgeVariant(
  status: CustomThemeRequestStatus,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "info" {
  switch (status) {
    case "new":
      return "info";
    case "contacted":
    case "quoted":
      return "warning";
    case "in_progress":
      return "secondary";
    case "delivered":
      return "success";
    case "declined":
    case "cancelled":
      return "destructive";
  }
}

export function CustomThemeServicePage({
  tenantHandle,
  workspaceName,
  themesLibraryHref,
  requestsApiUrl,
  packagesApiUrl,
  initialState,
}: CustomThemeServicePageProps) {
  const [packages, setPackages] = React.useState<readonly TenantCustomThemePackageDto[]>(
    initialState.packages,
  );
  const [requests, setRequests] = React.useState<readonly TenantCustomThemeRequestDto[]>(
    initialState.requests,
  );
  const [dailyQuota, setDailyQuota] = React.useState<TenantCustomThemeDailyQuotaDto>(
    initialState.dailyQuota,
  );
  const [contactWhatsappUrl, setContactWhatsappUrl] = React.useState<string | null>(
    initialState.contactWhatsappUrl,
  );

  // Form state (preserved on validation/network failure)
  const [selectedPackageId, setSelectedPackageId] = React.useState<string>("undecided");
  const [brandName, setBrandName] = React.useState<string>(workspaceName.slice(0, 100));
  const [brief, setBrief] = React.useState<string>("");
  const [referenceUrls, setReferenceUrls] = React.useState<string[]>([""]);
  const [budgetRange, setBudgetRange] = React.useState<string>("");
  const [contactPreference, setContactPreference] = React.useState<ContactPreference>("whatsapp");
  const [idempotencyKey, setIdempotencyKey] = React.useState<string>(() => generateSubmissionKey());

  const [isRefreshing, setIsRefreshing] = React.useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<readonly ApiFieldError[]>([]);
  const [submittedRequest, setSubmittedRequest] = React.useState<TenantCustomThemeRequestDto | null>(
    null,
  );

  const formSectionRef = React.useRef<HTMLElement | null>(null);

  const fieldErrorMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const fe of fieldErrors) {
      if (!map.has(fe.field)) {
        map.set(fe.field, fe.message);
      }
    }
    return map;
  }, [fieldErrors]);

  const handleSelectPackage = (pkgId: string) => {
    setSelectedPackageId(pkgId);
    setSubmittedRequest(null);
    formSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleAddReferenceUrl = () => {
    setReferenceUrls((prev) =>
      prev.length >= CUSTOM_THEME_MAX_REFERENCE_URLS ? prev : [...prev, ""],
    );
  };

  const handleRemoveReferenceUrl = (index: number) => {
    setReferenceUrls((prev) => {
      if (prev.length <= 1) return [""];
      return prev.filter((_, idx) => idx !== index);
    });
  };

  const handleChangeReferenceUrl = (index: number, value: string) => {
    setReferenceUrls((prev) => prev.map((item, idx) => (idx === index ? value : item)));
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const [pkgRes, reqRes] = await Promise.all([
        fetch(packagesApiUrl, { credentials: "same-origin" }),
        fetch(requestsApiUrl, { credentials: "same-origin" }),
      ]);
      if (pkgRes.ok) {
        const pkgJson = (await pkgRes.json()) as {
          packages?: TenantCustomThemePackageDto[];
          dailyQuota?: TenantCustomThemeDailyQuotaDto;
          contactWhatsappUrl?: string | null;
        };
        if (Array.isArray(pkgJson.packages)) setPackages(pkgJson.packages);
        if (pkgJson.dailyQuota) setDailyQuota(pkgJson.dailyQuota);
        if (pkgJson.contactWhatsappUrl !== undefined) {
          setContactWhatsappUrl(pkgJson.contactWhatsappUrl);
        }
      }
      if (reqRes.ok) {
        const reqJson = (await reqRes.json()) as {
          requests?: TenantCustomThemeRequestDto[];
          dailyQuota?: TenantCustomThemeDailyQuotaDto;
        };
        if (Array.isArray(reqJson.requests)) setRequests(reqJson.requests);
        if (reqJson.dailyQuota) setDailyQuota(reqJson.dailyQuota);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSubmit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setFieldErrors([]);
    setSubmittedRequest(null);

    const nonEmptyUrls = referenceUrls.map((u) => u.trim()).filter((u) => u.length > 0);
    const localErrors: ApiFieldError[] = [];

    if (!brandName.trim()) {
      localErrors.push({
        field: "brandName",
        code: "REQUIRED",
        message: "Nama brand atau usaha wajib diisi.",
      });
    }
    if (!brief.trim()) {
      localErrors.push({
        field: "brief",
        code: "REQUIRED",
        message: "Ringkasan kebutuhan desain (brief) wajib diisi.",
      });
    }
    if (nonEmptyUrls.length > CUSTOM_THEME_MAX_REFERENCE_URLS) {
      localErrors.push({
        field: "referenceUrls",
        code: "TOO_MANY_REFERENCE_URLS",
        message: `Maksimal ${CUSTOM_THEME_MAX_REFERENCE_URLS} tautan referensi per permintaan.`,
      });
    }

    for (let i = 0; i < referenceUrls.length; i += 1) {
      const trimmed = (referenceUrls[i] ?? "").trim();
      if (!trimmed) continue;
      if (!/^https:\/\//i.test(trimmed)) {
        localErrors.push({
          field: `referenceUrls[${i}]`,
          code: "INVALID_REFERENCE_URL",
          message: "Gunakan tautan HTTPS publik yang aman (diawali https://).",
        });
      }
    }

    if (localErrors.length > 0) {
      setFieldErrors(localErrors);
      setFormError(localErrors[0]?.message ?? "Periksa kembali isian formulir Anda.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(requestsApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          packageId: selectedPackageId === "undecided" ? null : selectedPackageId,
          brandName: brandName.trim(),
          brief: brief.trim(),
          referenceUrls: nonEmptyUrls,
          budgetRange: budgetRange.trim() || null,
          contactPreference,
          idempotencyKey,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        request?: TenantCustomThemeRequestDto;
        dailyQuota?: TenantCustomThemeDailyQuotaDto;
        error?: {
          code?: string;
          message?: string;
          fields?: ApiFieldError[];
        };
      } | null;

      if (!response.ok || !payload?.success || !payload.request) {
        setFormError(
          payload?.error?.message ??
            "Gagal mengirim permintaan tema kustom. Silakan periksa isian dan coba lagi.",
        );
        if (Array.isArray(payload?.error?.fields)) {
          setFieldErrors(payload.error.fields);
        }
        return;
      }

      const createdReq = payload.request;
      setSubmittedRequest(createdReq);
      setRequests((prev) => {
        const filtered = prev.filter((item) => item.id !== createdReq.id);
        return [createdReq, ...filtered];
      });
      if (payload.dailyQuota) {
        setDailyQuota(payload.dailyQuota);
      }

      // Reset brief & references and mint fresh idempotency key for the next distinct request
      setBrief("");
      setReferenceUrls([""]);
      setBudgetRange("");
      setIdempotencyKey(generateSubmissionKey());
    } catch {
      setFormError(
        "Koneksi terputus saat mengirim permintaan. Data formulir tetap tersimpan; Anda dapat mengirim ulang dengan aman tanpa duplikasi.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const quotaExhausted = dailyQuota.remaining <= 0;

  return (
    <div className="space-y-6" data-testid="custom-theme-service-page">
      {/* Top Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11 -ml-2 sm:min-h-9"
              render={<a href={themesLibraryHref} data-testid="link-back-theme-library" />}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              <span>Kembali ke Perpustakaan Tema</span>
            </Button>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Layanan Desain Tema Kustom
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Bangun tampilan website khusus sesuai identitas brand{" "}
            <strong className="font-medium text-foreground">{workspaceName}</strong> (
            <span className="font-mono text-xs">{tenantHandle}</span>) bersama tim desain PunyaSitus.
            Halaman ini adalah halaman layanan konsultasi, bukan aktivasi tema otomatis.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          onClick={handleRefresh}
          disabled={isRefreshing}
          data-testid="btn-refresh-custom-theme"
        >
          <RefreshCwIcon
            className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span>{isRefreshing ? "Memuat..." : "Muat Ulang"}</span>
        </Button>
      </div>

      {/* Service Card: Available Themes Summary + Transparent Commercial Policy */}
      <Card data-testid="custom-theme-service-card">
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <PaletteIcon className="size-5 text-primary" aria-hidden="true" />
              <CardTitle>Tema Tersedia &amp; Ketentuan Layanan Kustom</CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
              <Badge variant="outline" data-testid="badge-default-themes-count">
                {initialState.defaultThemes.length} Tema Bawaan
              </Badge>
              <Badge
                variant={initialState.grantedCustomThemes.length > 0 ? "success" : "secondary"}
                data-testid="badge-granted-themes-count"
              >
                {initialState.grantedCustomThemes.length} Tema Kustom Berizin
              </Badge>
            </div>
          </div>
          <CardDescription>
            Semua tema bawaan dan tema kustom yang sudah diberikan izin dapat dipratinjau serta
            diaktifkan langsung melalui Perpustakaan Tema tanpa kehilangan konten.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {initialState.grantedCustomThemes.length > 0 && (
            <div
              className="flex flex-col gap-2 rounded-md border border-success-border bg-success-soft p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              data-testid="granted-custom-themes-summary"
            >
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Tema kustom berizin siap diaktifkan untuk situs ini:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {initialState.grantedCustomThemes.map((theme) => (
                    <Badge key={theme.id} variant="success">
                      <PaletteIcon className="size-3" aria-hidden="true" />
                      <span>{theme.name}</span>
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                variant="default"
                className="min-h-11 shrink-0"
                render={<a href={themesLibraryHref} data-testid="link-activate-granted-theme" />}
              >
                <span>Buka Perpustakaan Tema</span>
              </Button>
            </div>
          )}

          <Alert variant="info" data-testid="custom-theme-pricing-policy">
            <InfoIcon aria-hidden="true" />
            <AlertTitle>Ketentuan Harga &amp; Pembayaran Layanan Tema Kustom</AlertTitle>
            <AlertDescription className="space-y-1">
              <p>
                Harga akhir ditentukan melalui penawaran resmi setelah konsultasi kebutuhan.
                Pekerjaan desain tema kustom dibayar terpisah di luar sistem langganan
                bulanan/tahunan (tidak ada checkout atau penagihan otomatis untuk jasa tema kustom).
              </p>
              <p>
                Langganan hosting &amp; CMS situs tetap berjalan normal setelah tema kustom selesai
                diserahkan dan diaktifkan.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Active Superadmin-Managed Packages Section */}
      <section aria-labelledby="packages-heading" className="space-y-4" data-testid="custom-theme-packages-section">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="packages-heading" className="text-lg font-semibold text-foreground">
              Pilihan Paket Desain Tema Kustom
            </h2>
            <p className="text-sm text-muted-foreground">
              Daftar paket dan estimasi biaya dikelola langsung oleh tim PunyaSitus.
            </p>
          </div>
          {contactWhatsappUrl && (
            <Button
              variant="outline"
              className="min-h-11 border-[#0B6B3A] text-[#0B6B3A] hover:bg-[#0B6B3A]/10"
              render={
                <a
                  href={contactWhatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="btn-wa-general-consultation"
                />
              }
            >
              <MessageCircleIcon className="size-4" aria-hidden="true" />
              <span>Konsultasi via WhatsApp</span>
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>

        {packages.length === 0 ? (
          <Card data-testid="custom-theme-packages-empty">
            <CardContent className="flex flex-col items-start gap-4 py-8 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1.5">
                <p className="text-base font-semibold text-foreground">
                  Konsultasi Langsung untuk Desain Tema Kustom
                </p>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Saat ini belum ada daftar paket standar yang dipublikasikan. Anda tetap dapat
                  mengirim brief kebutuhan tema kustom melalui formulir di bawah atau berkonsultasi
                  langsung dengan tim kami untuk mendapatkan penawaran sesuai ruang lingkup brand
                  Anda.
                </p>
                {initialState.supportEmail && (
                  <p className="text-xs text-muted-foreground">
                    Email dukungan:{" "}
                    <span className="font-medium text-foreground">{initialState.supportEmail}</span>
                  </p>
                )}
              </div>

              {contactWhatsappUrl && (
                <a
                  href={contactWhatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[#0B6B3A] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  data-testid="btn-wa-contact-only"
                >
                  <MessageCircleIcon className="size-4" aria-hidden="true" />
                  <span>Hubungi Tim via WhatsApp</span>
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </a>
              )}
            </CardContent>
          </Card>
        ) : (
          <div
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            data-testid="custom-theme-packages-grid"
          >
            {packages.map((pkg) => {
              const isSelected = selectedPackageId === pkg.id;
              return (
                <Card
                  key={pkg.id}
                  className={isSelected ? "border-primary ring-1 ring-primary/25" : undefined}
                  data-testid={`custom-theme-package-card-${pkg.slug}`}
                  data-sort-order={pkg.sortOrder}
                >
                  <CardHeader className="gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{pkg.name}</CardTitle>
                      {isSelected && <Badge variant="success">Dipilih</Badge>}
                    </div>
                    <p
                      className="text-lg font-semibold text-primary tabular-nums"
                      data-testid={`package-price-${pkg.slug}`}
                    >
                      {pkg.priceLabel}
                    </p>
                    <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      <span>Estimasi pengerjaan: {pkg.estimatedDuration}</span>
                    </p>
                    <CardDescription>{pkg.description}</CardDescription>
                  </CardHeader>

                  <CardContent className="flex-1 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Yang Termasuk
                    </p>
                    <ul className="space-y-1.5 text-sm text-foreground">
                      {pkg.inclusions.map((item, idx) => (
                        <li key={`${pkg.id}-inc-${idx}`} className="flex items-start gap-2">
                          <CheckCircle2Icon
                            className="mt-0.5 size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>

                  <CardFooter>
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      className="min-h-11 w-full"
                      onClick={() => handleSelectPackage(pkg.id)}
                      data-testid={`btn-select-package-${pkg.slug}`}
                    >
                      <span>{isSelected ? "Paket Dipilih di Formulir" : "Pilih Paket Ini"}</span>
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Separator />

      {/* Request Submission Form + Read-Only Request Status List */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Request Form */}
        <section
          ref={formSectionRef}
          aria-labelledby="request-form-heading"
          className="min-w-0 lg:col-span-7"
        >
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle id="request-form-heading">Kirim Permintaan Tema Kustom</CardTitle>
                <Badge
                  variant={quotaExhausted ? "warning" : "outline"}
                  className="tabular-nums"
                  data-testid="daily-quota-badge"
                >
                  {dailyQuota.used}/{dailyQuota.limit} permintaan hari ini
                </Badge>
              </div>
              <CardDescription>
                Ceritakan kebutuhan desain dan referensi website Anda. Tim kami akan meninjau brief
                dan mengirimkan penawaran resmi tanpa memungut pembayaran di halaman ini.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {submittedRequest && (
                <Alert variant="success" data-testid="request-submit-success">
                  <CheckCircle2Icon aria-hidden="true" />
                  <AlertTitle>
                    Permintaan {submittedRequest.requestCode} Berhasil Dikirim
                  </AlertTitle>
                  <AlertDescription className="space-y-2.5">
                    <p>
                      Brief Anda untuk paket <strong>{submittedRequest.packageName}</strong> telah
                      diterima oleh tim PunyaSitus dengan status{" "}
                      <strong>{submittedRequest.statusLabel}</strong>.
                    </p>
                    {submittedRequest.whatsappUrl && (
                      <div>
                        <a
                          href={submittedRequest.whatsappUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[#0B6B3A] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          data-testid="btn-wa-after-submit"
                        >
                          <MessageCircleIcon className="size-4" aria-hidden="true" />
                          <span>Lanjutkan Konsultasi via WhatsApp</span>
                          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                        </a>
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {formError && (
                <Alert variant="destructive" role="alert" data-testid="request-form-error">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertTitle>Permintaan Belum Dapat Dikirim</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              {quotaExhausted && (
                <Alert variant="warning" data-testid="daily-quota-warning">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertTitle>Batas Harian Tercapai ({dailyQuota.limit} Permintaan/Hari)</AlertTitle>
                  <AlertDescription>
                    Situs ini sudah mencapai batas maksimal {dailyQuota.limit} permintaan tema
                    kustom hari ini. Anda dapat melanjutkan diskusi lewat WhatsApp atau mengirim
                    permintaan baru besok.
                  </AlertDescription>
                </Alert>
              )}

              <form
                onSubmit={handleSubmit}
                className="space-y-4"
                noValidate
                data-testid="custom-theme-request-form"
              >
                {/* Package Selector */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="ctr-package"
                    className="block text-sm font-medium text-foreground"
                  >
                    Pilihan Paket
                  </label>
                  <select
                    id="ctr-package"
                    name="packageId"
                    value={selectedPackageId}
                    onChange={(e) => setSelectedPackageId(e.target.value)}
                    disabled={isSubmitting}
                    className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    data-testid="select-package"
                  >
                    <option value="undecided">{CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL}</option>
                    {packages.map((pkg) => (
                      <option key={pkg.id} value={pkg.id}>
                        {pkg.name} — {pkg.priceLabel}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Brand Name */}
                <div className="space-y-1.5">
                  <label htmlFor="ctr-brand" className="block text-sm font-medium text-foreground">
                    Nama Brand / Usaha <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="ctr-brand"
                    name="brandName"
                    type="text"
                    required
                    maxLength={100}
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    disabled={isSubmitting}
                    aria-invalid={fieldErrorMap.has("brandName") || undefined}
                    aria-describedby={
                      fieldErrorMap.has("brandName") ? "ctr-brand-error" : undefined
                    }
                    className="min-h-11 text-base sm:text-sm"
                    placeholder="Contoh: PT Nusantara Mandiri"
                    data-testid="input-brand-name"
                  />
                  {fieldErrorMap.has("brandName") && (
                    <p
                      id="ctr-brand-error"
                      className="text-xs font-medium text-destructive"
                      role="alert"
                    >
                      {fieldErrorMap.get("brandName")}
                    </p>
                  )}
                </div>

                {/* Brief */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="ctr-brief"
                      className="block text-sm font-medium text-foreground"
                    >
                      Ringkasan Kebutuhan Desain (Brief) <span className="text-destructive">*</span>
                    </label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {brief.length}/{CUSTOM_THEME_MAX_BRIEF_LENGTH}
                    </span>
                  </div>
                  <textarea
                    id="ctr-brief"
                    name="brief"
                    required
                    rows={5}
                    maxLength={CUSTOM_THEME_MAX_BRIEF_LENGTH}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    disabled={isSubmitting}
                    aria-invalid={fieldErrorMap.has("brief") || undefined}
                    aria-describedby={fieldErrorMap.has("brief") ? "ctr-brief-error" : undefined}
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    placeholder="Jelaskan karakter brand, gaya visual yang diinginkan, warna utama, halaman prioritas, serta target audiens Anda..."
                    data-testid="textarea-brief"
                  />
                  {fieldErrorMap.has("brief") && (
                    <p
                      id="ctr-brief-error"
                      className="text-xs font-medium text-destructive"
                      role="alert"
                    >
                      {fieldErrorMap.get("brief")}
                    </p>
                  )}
                </div>

                {/* Reference URLs (max 5, HTTPS-only, never fetched) */}
                <fieldset className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <legend className="text-sm font-medium text-foreground">
                      Tautan Referensi Desain (Opsional, maks. {CUSTOM_THEME_MAX_REFERENCE_URLS} URL
                      HTTPS)
                    </legend>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      onClick={handleAddReferenceUrl}
                      disabled={
                        isSubmitting || referenceUrls.length >= CUSTOM_THEME_MAX_REFERENCE_URLS
                      }
                      data-testid="btn-add-reference-url"
                    >
                      <PlusIcon className="size-3.5" aria-hidden="true" />
                      <span>Tambah URL</span>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gunakan tautan HTTPS publik (contoh: https://contoh-brand.co.id). Tautan hanya
                    disimpan sebagai referensi tim desain dan tidak pernah diakses otomatis oleh
                    server.
                  </p>

                  <div className="space-y-2">
                    {referenceUrls.map((urlVal, idx) => {
                      const errKey = `referenceUrls[${idx}]`;
                      const errMsg = fieldErrorMap.get(errKey);
                      return (
                        <div key={`ref-url-${idx}`} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Input
                              id={`ctr-ref-url-${idx}`}
                              type="url"
                              value={urlVal}
                              onChange={(e) => handleChangeReferenceUrl(idx, e.target.value)}
                              disabled={isSubmitting}
                              aria-label={`URL referensi ke-${idx + 1}`}
                              aria-invalid={Boolean(errMsg) || undefined}
                              className="min-h-11 flex-1 text-base sm:text-sm"
                              placeholder={`https://referensi-${idx + 1}.example.com`}
                              data-testid={`input-reference-url-${idx}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="min-h-11 min-w-11 shrink-0"
                              onClick={() => handleRemoveReferenceUrl(idx)}
                              disabled={isSubmitting}
                              aria-label={`Hapus URL referensi ke-${idx + 1}`}
                              data-testid={`btn-remove-reference-url-${idx}`}
                            >
                              <Trash2Icon className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                          {errMsg && (
                            <p
                              className="text-xs font-medium text-destructive"
                              role="alert"
                              data-testid={`error-reference-url-${idx}`}
                            >
                              {errMsg}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {fieldErrorMap.has("referenceUrls") && (
                    <p className="text-xs font-medium text-destructive" role="alert">
                      {fieldErrorMap.get("referenceUrls")}
                    </p>
                  )}
                </fieldset>

                {/* Optional Budget Range + Contact Preference */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="ctr-budget"
                      className="block text-sm font-medium text-foreground"
                    >
                      Kisaran Anggaran (Opsional)
                    </label>
                    <Input
                      id="ctr-budget"
                      name="budgetRange"
                      type="text"
                      maxLength={120}
                      value={budgetRange}
                      onChange={(e) => setBudgetRange(e.target.value)}
                      disabled={isSubmitting}
                      className="min-h-11 text-base sm:text-sm"
                      placeholder="Contoh: Rp 5 jt – Rp 10 jt"
                      data-testid="input-budget-range"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="ctr-contact-pref"
                      className="block text-sm font-medium text-foreground"
                    >
                      Preferensi Kontak
                    </label>
                    <select
                      id="ctr-contact-pref"
                      name="contactPreference"
                      value={contactPreference}
                      onChange={(e) => setContactPreference(e.target.value as ContactPreference)}
                      disabled={isSubmitting}
                      className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                      data-testid="select-contact-preference"
                    >
                      {(Object.keys(CONTACT_PREFERENCE_LABELS_ID) as ContactPreference[]).map(
                        (pref) => (
                          <option key={pref} value={pref}>
                            {CONTACT_PREFERENCE_LABELS_ID[pref]}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Mengirim formulir ini gratis dan tidak menimbulkan tagihan otomatis.
                  </p>
                  <Button
                    type="submit"
                    variant="default"
                    className="min-h-11 sm:w-auto"
                    disabled={isSubmitting || quotaExhausted}
                    data-testid="btn-submit-custom-theme-request"
                  >
                    <SendIcon className="size-4" aria-hidden="true" />
                    <span>{isSubmitting ? "Mengirim Permintaan..." : "Kirim Permintaan"}</span>
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </section>

        {/* Read-only Request Status History */}
        <section
          aria-labelledby="request-history-heading"
          className="min-w-0 space-y-4 lg:col-span-5"
          data-testid="custom-theme-requests-list"
        >
          <div>
            <h2 id="request-history-heading" className="text-lg font-semibold text-foreground">
              Riwayat &amp; Status Permintaan
            </h2>
            <p className="text-sm text-muted-foreground">
              Pantau perkembangan permintaan tema kustom untuk situs ini secara real-time.
            </p>
          </div>

          {requests.length === 0 ? (
            <Card data-testid="custom-theme-requests-empty">
              <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                <PaletteIcon className="size-7 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">
                  Belum ada permintaan tema kustom
                </p>
                <p className="text-xs text-muted-foreground">
                  Permintaan yang Anda kirim akan muncul di sini lengkap dengan kode referensi dan
                  status pengerjaan.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {requests.map((req) => (
                <Card
                  key={req.id}
                  data-testid={`request-card-${req.requestCode}`}
                  data-request-status={req.status}
                >
                  <CardHeader className="gap-1.5 pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {req.requestCode}
                      </span>
                      <Badge
                        variant={statusBadgeVariant(req.status)}
                        data-testid={`request-status-badge-${req.requestCode}`}
                      >
                        {req.statusLabel}
                      </Badge>
                    </div>
                    <CardTitle className="text-sm">{req.packageName}</CardTitle>
                    <CardDescription className="text-xs tabular-nums">
                      Brand: {req.brandName} · Dikirim {formatDateTimeId(req.createdAt)}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="space-y-2.5 text-xs">
                    <p className="line-clamp-3 text-foreground">{req.brief}</p>

                    {req.budgetRange && (
                      <p className="text-muted-foreground">
                        Kisaran anggaran:{" "}
                        <span className="font-medium text-foreground">{req.budgetRange}</span>
                      </p>
                    )}

                    {req.referenceUrls.length > 0 && (
                      <div className="space-y-1">
                        <p className="font-medium text-muted-foreground">Referensi:</p>
                        <ul className="space-y-0.5">
                          {req.referenceUrls.map((url, idx) => (
                            <li key={`${req.id}-ref-${idx}`} className="truncate">
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary underline-offset-2 hover:underline"
                              >
                                {url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {req.status === "delivered" && req.deliveredThemeId && (
                      <div
                        className="flex flex-col gap-2 rounded-md border border-success-border bg-success-soft p-2.5 text-xs"
                        data-testid={`request-delivered-banner-${req.requestCode}`}
                      >
                        <div className="flex items-center gap-1.5 font-medium text-foreground">
                          <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
                          <span>
                            Tema kustom <code>{req.deliveredThemeId}</code> telah diserahkan!
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="default"
                          className="min-h-11 w-full"
                          render={<a href={themesLibraryHref} />}
                        >
                          <span>Aktifkan di Perpustakaan Tema</span>
                        </Button>
                      </div>
                    )}
                  </CardContent>

                  {req.whatsappUrl && (
                    <CardFooter className="pt-0">
                      <a
                        href={req.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#0B6B3A] px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        data-testid={`btn-wa-request-${req.requestCode}`}
                      >
                        <MessageCircleIcon className="size-4" aria-hidden="true" />
                        <span>Diskusikan via WhatsApp</span>
                        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                      </a>
                    </CardFooter>
                  )}
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
