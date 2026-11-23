import * as React from "react";
import {
  CONTACT_PREFERENCE_LABELS_ID,
  CUSTOM_THEME_MAX_BRIEF_LENGTH,
  CUSTOM_THEME_MAX_REFERENCE_URLS,
  CUSTOM_THEME_UNDECIDED_PACKAGE_LABEL,
  type ContactPreference,
  type CustomThemeRequestStatus,
  type StaffAccessState,
} from "@punyasitus/core/custom-themes/index";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClockIcon,
  ExternalLinkIcon,
  InfoIcon,
  MessageCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCheckIcon,
  UserXIcon,
  UsersIcon,
  WrenchIcon,
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
  TenantSetupDailyQuotaDto,
  TenantSetupPackageDto,
  TenantSetupRequestDto,
  TenantSetupSeatsDto,
  TenantSetupServiceStateDto,
} from "../../../pages/api/tenants/[tenantId]/service-requests/_shared.ts";

/**
 * Terima Beres Setup Service Page (`shadcn/ui` `base-nova`, `@base-ui/react`, `render` prop)
 * for `/dashboard/[handle]/setup-service` (REQ-070, PLAN §11.4 & §18.2, DESIGN.md, TASK-069).
 * Payment stays outside the system (quote-based consultation only).
 */

export interface SetupServicePageProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly settingsHref: string;
  readonly membersHref: string;
  readonly requestsApiUrl: string;
  readonly initialState: TenantSetupServiceStateDto;
}

interface ApiFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

function generateSetupSubmissionKey(): string {
  try {
    return `tbr-${crypto.randomUUID()}`;
  } catch {
    return `tbr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

function staffStateBadgeVariant(
  state: StaffAccessState,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "info" {
  switch (state) {
    case "awaiting_owner_approval":
      return "info";
    case "waiting_seat":
      return "warning";
    case "active":
      return "success";
    case "revoked":
      return "secondary";
    case "none":
      return "outline";
  }
}

export function SetupServicePage({
  tenantHandle,
  workspaceName,
  settingsHref,
  membersHref,
  requestsApiUrl,
  initialState,
}: SetupServicePageProps) {
  const [packages, setPackages] = React.useState<readonly TenantSetupPackageDto[]>(
    initialState.packages,
  );
  const [requests, setRequests] = React.useState<readonly TenantSetupRequestDto[]>(
    initialState.requests,
  );
  const [seats, setSeats] = React.useState<TenantSetupSeatsDto>(initialState.seats);
  const [dailyQuota, setDailyQuota] = React.useState<TenantSetupDailyQuotaDto>(
    initialState.dailyQuota,
  );
  const [contactWhatsappUrl, setContactWhatsappUrl] = React.useState<string | null>(
    initialState.contactWhatsappUrl,
  );
  const canApproveStaff = initialState.canApproveStaff;

  // Form state (preserved on validation/network failure)
  const [selectedPackageId, setSelectedPackageId] = React.useState<string>("undecided");
  const [brandName, setBrandName] = React.useState<string>(workspaceName.slice(0, 100));
  const [brief, setBrief] = React.useState<string>("");
  const [referenceUrls, setReferenceUrls] = React.useState<string[]>([""]);
  const [budgetRange, setBudgetRange] = React.useState<string>("");
  const [contactPreference, setContactPreference] = React.useState<ContactPreference>("whatsapp");
  const [idempotencyKey, setIdempotencyKey] = React.useState<string>(() =>
    generateSetupSubmissionKey(),
  );

  const [isRefreshing, setIsRefreshing] = React.useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<readonly ApiFieldError[]>([]);
  const [submittedRequest, setSubmittedRequest] = React.useState<TenantSetupRequestDto | null>(null);

  // Staff approval action state
  const [busyStaffRequestId, setBusyStaffRequestId] = React.useState<string | null>(null);
  const [staffNotice, setStaffNotice] = React.useState<{
    readonly variant: "success" | "warning" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

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
      const res = await fetch(requestsApiUrl, { credentials: "same-origin" });
      if (res.ok) {
        const json = (await res.json()) as {
          packages?: TenantSetupPackageDto[];
          requests?: TenantSetupRequestDto[];
          seats?: TenantSetupSeatsDto;
          dailyQuota?: TenantSetupDailyQuotaDto;
          contactWhatsappUrl?: string | null;
        };
        if (Array.isArray(json.packages)) setPackages(json.packages);
        if (Array.isArray(json.requests)) setRequests(json.requests);
        if (json.seats) setSeats(json.seats);
        if (json.dailyQuota) setDailyQuota(json.dailyQuota);
        if (json.contactWhatsappUrl !== undefined) {
          setContactWhatsappUrl(json.contactWhatsappUrl);
        }
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
        message: "Ringkasan kebutuhan setup website (brief) wajib diisi.",
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
          budgetRange: budgetRange.trim() ? budgetRange.trim() : null,
          contactPreference,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        request?: TenantSetupRequestDto;
        dailyQuota?: TenantSetupDailyQuotaDto;
        error?: {
          code?: string;
          message?: string;
          fields?: ApiFieldError[];
        };
      } | null;

      if (!response.ok || !payload?.success || !payload.request) {
        setFieldErrors(payload?.error?.fields ?? []);
        setFormError(
          payload?.error?.message ??
            "Gagal mengirim permintaan Layanan Terima Beres. Data Anda tetap aman, silakan coba lagi.",
        );
        return;
      }

      const createdReq = payload.request;
      setSubmittedRequest(createdReq);
      setRequests((prev) => {
        const exists = prev.some((r) => r.id === createdReq.id);
        return exists
          ? prev.map((r) => (r.id === createdReq.id ? createdReq : r))
          : [createdReq, ...prev];
      });
      if (payload.dailyQuota) {
        setDailyQuota(payload.dailyQuota);
      }

      setBrief("");
      setReferenceUrls([""]);
      setBudgetRange("");
      setIdempotencyKey(generateSetupSubmissionKey());
    } catch {
      setFormError("Koneksi terputus saat mengirim permintaan. Data Anda tidak hilang, coba lagi.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStaffAccessAction = async (
    req: TenantSetupRequestDto,
    action: "approve" | "revoke",
  ) => {
    setStaffNotice(null);
    setBusyStaffRequestId(req.id);
    try {
      const response = await fetch(
        `${requestsApiUrl}/${encodeURIComponent(req.id)}/staff-access`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            expectedVersion: req.version,
          }),
        },
      );

      const payload = (await response.json().catch(() => null)) as {
        success?: boolean;
        joined?: boolean;
        waitingForSeat?: boolean;
        waitReason?: string | null;
        removed?: boolean;
        request?: TenantSetupRequestDto;
        seats?: TenantSetupSeatsDto;
        error?: { message?: string };
      } | null;

      if (!response.ok || !payload?.success || !payload.request) {
        setStaffNotice({
          variant: "destructive",
          title:
            action === "approve"
              ? "Gagal Menyetujui Akses Tim Setup"
              : "Gagal Mencabut Akses Tim Setup",
          message:
            payload?.error?.message ??
            "Terjadi kendala saat memperbarui akses Tim Setup. Muat ulang dan coba lagi.",
        });
        return;
      }

      const updated = payload.request;
      setRequests((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      if (payload.seats) {
        setSeats(payload.seats);
      }

      if (action === "approve") {
        if (payload.waitingForSeat) {
          setStaffNotice({
            variant: "warning",
            title: "Menunggu Kursi Anggota Kosong (5/5 Terpakai)",
            message:
              payload.waitReason ??
              "Semua kursi anggota situs sedang terpakai. Bebaskan 1 kursi di Pengaturan > Anggota lalu setujui kembali.",
          });
        } else {
          setStaffNotice({
            variant: "success",
            title: "Akses Tim Setup Aktif sebagai Editor",
            message: `${updated.staffAccess.staffName ?? updated.staffAccess.staffEmail ?? "Tim Setup"} telah bergabung ke situs ini sebagai Editor dengan pencatatan audit penuh dan akan dicabut otomatis saat layanan selesai.`,
          });
        }
      } else {
        setStaffNotice({
          variant: "success",
          title: "Akses Tim Setup Dicabut",
          message:
            "Keanggotaan sementara Tim Setup telah dihapus dan kursi anggota kembali tersedia.",
        });
      }
    } catch {
      setStaffNotice({
        variant: "destructive",
        title: "Koneksi Terputus",
        message: "Gagal menghubungi server untuk memperbarui akses Tim Setup.",
      });
    } finally {
      setBusyStaffRequestId(null);
    }
  };

  return (
    <div className="space-y-6" data-testid="setup-service-page">
      {/* Header & Navigation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              render={<a href={settingsHref} data-testid="link-back-settings" />}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              <span>Kembali ke Pengaturan</span>
            </Button>
            <Badge variant="outline" className="gap-1">
              <WrenchIcon className="size-3.5" aria-hidden="true" />
              <span>Layanan Terima Beres</span>
            </Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Layanan Terima Beres (Setup Website)
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Ingin website usaha Anda langsung rapi dan siap pakai tanpa repot mengisi konten satu
            per satu? Tim PunyaSitus membantu penyiapan halaman, profil bisnis, katalog, dan
            pengaturan dasar website Anda.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0 sm:min-h-9"
          onClick={handleRefresh}
          disabled={isRefreshing}
          data-testid="btn-refresh-setup-service"
        >
          <RefreshCwIcon
            className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span>{isRefreshing ? "Memuat..." : "Muat Ulang"}</span>
        </Button>
      </div>

      {/* Transparency, Billing & Non-Impersonation Policy Alert */}
      <Alert variant="info" data-testid="setup-service-policy-notice">
        <InfoIcon aria-hidden="true" />
        <AlertTitle>Ketentuan Penawaran, Pembayaran &amp; Akses Tim Setup</AlertTitle>
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs sm:text-sm">
            <li>
              Harga akhir ditetapkan melalui penawaran resmi setelah konsultasi kebutuhan. Biaya
              jasa Terima Beres dibayar terpisah di luar sistem dan tidak ada checkout di halaman
              ini.
            </li>
            <li>
              Langganan bulanan atau tahunan website PunyaSitus tetap berjalan terpisah seperti
              biasa setelah proses setup selesai.
            </li>
            <li>
              <strong>Tanpa penyamaran akun:</strong> saat pengerjaan dimulai, Pemilik Situs
              menyetujui secara eksplisit akun Tim Setup bernama sebagai anggota sementara berperan{" "}
              <strong>Editor</strong> (menggunakan 1 dari 5 kursi anggota, tercatat di log audit,
              dan dicabut otomatis saat layanan selesai, ditolak, atau dibatalkan).
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      {/* Seat Availability Summary Bar */}
      <Card data-testid="setup-seats-summary-card">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <UsersIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">
                Ketersediaan Kursi Anggota Situs:{" "}
                <span className="tabular-nums font-semibold" data-testid="setup-seats-ratio">
                  {seats.seatsUsed}/{seats.seatsLimit} terpakai
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {seats.seatsRemaining > 0
                  ? `Tersedia ${seats.seatsRemaining} kursi kosong untuk penugasan Editor sementara Tim Setup setelah Anda menyetujuinya.`
                  : "Semua 5 kursi anggota sedang penuh (anggota aktif + undangan tertunda). Bebaskan minimal 1 kursi sebelum menyetujui akses Tim Setup."}
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
            render={<a href={membersHref} data-testid="link-manage-members" />}
          >
            <span>Kelola Anggota</span>
          </Button>
        </CardContent>
      </Card>

      {staffNotice && (
        <Alert
          variant={staffNotice.variant}
          role={staffNotice.variant === "destructive" ? "alert" : "status"}
          data-testid="setup-staff-action-notice"
        >
          {staffNotice.variant === "success" ? (
            <CheckCircle2Icon aria-hidden="true" />
          ) : (
            <AlertCircleIcon aria-hidden="true" />
          )}
          <AlertTitle>{staffNotice.title}</AlertTitle>
          <AlertDescription>{staffNotice.message}</AlertDescription>
        </Alert>
      )}

      {/* Active Superadmin-Managed Setup Packages */}
      <section aria-labelledby="setup-packages-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2
              id="setup-packages-heading"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Pilihan Paket Layanan Terima Beres
            </h2>
            <p className="text-xs text-muted-foreground">
              Daftar paket dan kisaran harga dikelola langsung oleh tim PunyaSitus.
            </p>
          </div>
        </div>

        {packages.length === 0 ? (
          <Card data-testid="setup-packages-empty">
            <CardHeader>
              <CardTitle className="text-base">
                Konsultasi Langsung dengan Tim Setup PunyaSitus
              </CardTitle>
              <CardDescription>
                Belum ada paket Terima Beres standar yang ditampilkan saat ini. Anda tetap dapat
                mengirim formulir kebutuhan di bawah atau berkonsultasi langsung melalui WhatsApp
                untuk mendapatkan penawaran yang sesuai.
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex flex-wrap gap-2">
              {contactWhatsappUrl ? (
                <Button
                  className="min-h-11"
                  render={
                    <a
                      href={contactWhatsappUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="btn-setup-wa-contact-only"
                    />
                  }
                >
                  <MessageCircleIcon className="size-4" aria-hidden="true" />
                  <span>Konsultasi via WhatsApp</span>
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Kirim permintaan melalui formulir di bawah agar tim kami segera menghubungi Anda.
                </p>
              )}
            </CardFooter>
          </Card>
        ) : (
          <div
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            data-testid="setup-packages-grid"
          >
            {packages.map((pkg) => {
              const isSelected = selectedPackageId === pkg.id;
              return (
                <Card
                  key={pkg.id}
                  data-testid={`setup-package-card-${pkg.slug}`}
                  className={`flex flex-col justify-between transition-colors ${
                    isSelected ? "border-primary ring-1 ring-primary" : ""
                  }`}
                >
                  <CardHeader className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant="outline" className="gap-1">
                        <ClockIcon className="size-3" aria-hidden="true" />
                        <span>{pkg.estimatedDuration}</span>
                      </Badge>
                      {isSelected && <Badge variant="success">Dipilih</Badge>}
                    </div>
                    <CardTitle className="text-lg">{pkg.name}</CardTitle>
                    <p
                      className="text-base font-semibold text-primary tabular-nums"
                      data-testid={`setup-package-price-${pkg.slug}`}
                    >
                      {pkg.priceLabel}
                    </p>
                    <CardDescription>{pkg.description}</CardDescription>
                  </CardHeader>

                  <CardContent className="flex-1 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Yang termasuk:</p>
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

                  <CardFooter className="pt-2">
                    <Button
                      type="button"
                      variant={isSelected ? "default" : "outline"}
                      className="min-h-11 w-full"
                      onClick={() => handleSelectPackage(pkg.id)}
                      data-testid={`btn-select-setup-package-${pkg.slug}`}
                    >
                      <span>{isSelected ? "Paket Dipilih" : "Pilih Paket Ini"}</span>
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <Separator />

      {/* Main Content Split: Request Form + Status & Staff Approval List */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Request Form */}
        <section
          ref={formSectionRef}
          aria-labelledby="setup-request-form-heading"
          className="min-w-0 lg:col-span-7"
        >
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle id="setup-request-form-heading">
                  Kirim Permintaan Layanan Terima Beres
                </CardTitle>
                <Badge
                  variant={dailyQuota.remaining === 0 ? "warning" : "outline"}
                  className="tabular-nums"
                  data-testid="setup-daily-quota-badge"
                >
                  Kuota hari ini: {dailyQuota.used}/{dailyQuota.limit}
                </Badge>
              </div>
              <CardDescription>
                Sampaikan gambaran usaha dan materi website yang ingin disiapkan. Batas maksimal{" "}
                {dailyQuota.limit} permintaan per hari untuk situs{" "}
                <strong className="font-mono text-foreground">{tenantHandle}</strong>.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {submittedRequest && (
                <Alert variant="success" role="status" data-testid="setup-request-submit-success">
                  <CheckCircle2Icon aria-hidden="true" />
                  <AlertTitle>
                    Permintaan Terkirim ({submittedRequest.requestCode})
                  </AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>
                      Permintaan Layanan Terima Beres Anda telah diterima. Tim kami akan meninjau
                      brief Anda dan menindaklanjuti sesuai preferensi kontak yang dipilih.
                    </p>
                    {submittedRequest.whatsappUrl && (
                      <Button
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        render={
                          <a
                            href={submittedRequest.whatsappUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="btn-setup-wa-after-submit"
                          />
                        }
                      >
                        <MessageCircleIcon className="size-4" aria-hidden="true" />
                        <span>Lanjutkan via WhatsApp</span>
                        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {formError && (
                <Alert variant="destructive" role="alert" data-testid="setup-request-form-error">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertTitle>Permintaan Belum Dapat Dikirim</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              <form
                onSubmit={handleSubmit}
                noValidate
                className="space-y-4"
                data-testid="setup-service-request-form"
              >
                {/* Package Selector */}
                <div className="space-y-1.5">
                  <label
                    htmlFor="setup-package-select"
                    className="block text-sm font-medium text-foreground"
                  >
                    Pilihan Paket
                  </label>
                  <select
                    id="setup-package-select"
                    value={selectedPackageId}
                    onChange={(e) => setSelectedPackageId(e.target.value)}
                    className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    data-testid="select-setup-package"
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
                  <label
                    htmlFor="setup-brand-name"
                    className="block text-sm font-medium text-foreground"
                  >
                    Nama Brand / Usaha <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="setup-brand-name"
                    name="brandName"
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    maxLength={100}
                    required
                    aria-invalid={fieldErrorMap.has("brandName")}
                    className="min-h-11 text-base sm:text-sm"
                    placeholder="Contoh: Klinik Gigi Senyum Sehat"
                    data-testid="input-setup-brand-name"
                  />
                  {fieldErrorMap.get("brandName") && (
                    <p className="text-xs text-destructive" role="alert">
                      {fieldErrorMap.get("brandName")}
                    </p>
                  )}
                </div>

                {/* Brief */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="setup-brief"
                      className="block text-sm font-medium text-foreground"
                    >
                      Ringkasan Kebutuhan Setup (Brief) <span className="text-destructive">*</span>
                    </label>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {brief.length}/{CUSTOM_THEME_MAX_BRIEF_LENGTH}
                    </span>
                  </div>
                  <textarea
                    id="setup-brief"
                    name="brief"
                    rows={5}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    maxLength={CUSTOM_THEME_MAX_BRIEF_LENGTH}
                    required
                    aria-invalid={fieldErrorMap.has("brief")}
                    className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                    placeholder="Ceritakan jenis usaha, halaman yang ingin diisi (Beranda, Layanan, Kontak), kesiapan foto/teks, serta target waktu peluncuran."
                    data-testid="textarea-setup-brief"
                  />
                  {fieldErrorMap.get("brief") && (
                    <p className="text-xs text-destructive" role="alert">
                      {fieldErrorMap.get("brief")}
                    </p>
                  )}
                </div>

                {/* Reference URLs (up to 5, HTTPS-only, never fetched) */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="block text-sm font-medium text-foreground">
                      Tautan Referensi / Materi Publik (Opsional, maks.{" "}
                      {CUSTOM_THEME_MAX_REFERENCE_URLS})
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      onClick={handleAddReferenceUrl}
                      disabled={referenceUrls.length >= CUSTOM_THEME_MAX_REFERENCE_URLS}
                      data-testid="btn-setup-add-reference-url"
                    >
                      <PlusIcon className="size-3.5" aria-hidden="true" />
                      <span>Tambah Tautan</span>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gunakan alamat HTTPS publik (mis. profil Instagram/website referensi). Tautan
                    disimpan sebagai catatan dan tidak pernah diakses otomatis oleh server.
                  </p>
                  <div className="space-y-2">
                    {referenceUrls.map((urlValue, idx) => {
                      const errKey = `referenceUrls[${idx}]`;
                      const errMsg = fieldErrorMap.get(errKey);
                      return (
                        <div key={`setup-ref-url-${idx}`} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Input
                              type="url"
                              value={urlValue}
                              onChange={(e) => handleChangeReferenceUrl(idx, e.target.value)}
                              aria-label={`URL referensi ke-${idx + 1}`}
                              aria-invalid={Boolean(errMsg)}
                              placeholder="https://contoh-referensi.com"
                              className="min-h-11 flex-1 text-base sm:text-sm"
                              data-testid={`input-setup-reference-url-${idx}`}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-9"
                              onClick={() => handleRemoveReferenceUrl(idx)}
                              aria-label={`Hapus tautan referensi ke-${idx + 1}`}
                            >
                              <Trash2Icon className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                          {errMsg && (
                            <p className="text-xs text-destructive" role="alert">
                              {errMsg}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Budget Range & Contact Preference */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="setup-budget-range"
                      className="block text-sm font-medium text-foreground"
                    >
                      Kisaran Anggaran (Opsional)
                    </label>
                    <Input
                      id="setup-budget-range"
                      name="budgetRange"
                      value={budgetRange}
                      onChange={(e) => setBudgetRange(e.target.value)}
                      maxLength={120}
                      placeholder="Contoh: Rp 1 jt – Rp 2,5 jt"
                      className="min-h-11 text-base sm:text-sm"
                      data-testid="input-setup-budget-range"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="setup-contact-pref"
                      className="block text-sm font-medium text-foreground"
                    >
                      Preferensi Kontak
                    </label>
                    <select
                      id="setup-contact-pref"
                      value={contactPreference}
                      onChange={(e) => setContactPreference(e.target.value as ContactPreference)}
                      className="flex min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                      data-testid="select-setup-contact-preference"
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

                <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    type="submit"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={isSubmitting || dailyQuota.remaining === 0}
                    data-testid="btn-submit-setup-request"
                  >
                    <SendIcon className="size-4" aria-hidden="true" />
                    <span>{isSubmitting ? "Mengirim..." : "Kirim Permintaan Terima Beres"}</span>
                  </Button>

                  {contactWhatsappUrl && (
                    <Button
                      variant="outline"
                      className="min-h-11 w-full sm:w-auto"
                      render={
                        <a
                          href={contactWhatsappUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="btn-setup-wa-general"
                        />
                      }
                    >
                      <MessageCircleIcon className="size-4" aria-hidden="true" />
                      <span>Tanya Tim via WhatsApp</span>
                      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </section>

        {/* Status History & Staff Delivery Access Approval Column */}
        <section aria-labelledby="setup-requests-list-heading" className="min-w-0 lg:col-span-5">
          <Card>
            <CardHeader>
              <CardTitle id="setup-requests-list-heading">Riwayat &amp; Status Permintaan</CardTitle>
              <CardDescription>
                Pantau progres permintaan Terima Beres dan kelola persetujuan akses Editor
                sementara Tim Setup untuk situs ini.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3" data-testid="setup-requests-list">
              {requests.length === 0 ? (
                <div
                  className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
                  data-testid="setup-requests-empty"
                >
                  Belum ada permintaan Layanan Terima Beres untuk situs ini.
                </div>
              ) : (
                requests.map((req) => {
                  const isTerminal =
                    req.status === "delivered" ||
                    req.status === "declined" ||
                    req.status === "cancelled";
                  const showStaffPanel = req.staffAccess.state !== "none";
                  const canClickApprove =
                    canApproveStaff &&
                    !isTerminal &&
                    (req.staffAccess.state === "awaiting_owner_approval" ||
                      req.staffAccess.state === "waiting_seat");
                  const canClickRevoke =
                    canApproveStaff &&
                    (req.staffAccess.state === "active" ||
                      req.staffAccess.state === "awaiting_owner_approval" ||
                      req.staffAccess.state === "waiting_seat");
                  const isBusy = busyStaffRequestId === req.id;

                  return (
                    <article
                      key={req.id}
                      data-testid={`setup-request-card-${req.requestCode}`}
                      data-status={req.status}
                      data-staff-state={req.staffAccess.state}
                      className="space-y-3 rounded-lg border border-border bg-card p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {req.requestCode}
                        </span>
                        <Badge variant={statusBadgeVariant(req.status)}>{req.statusLabel}</Badge>
                      </div>

                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">{req.packageName}</p>
                        <p className="text-xs text-muted-foreground">
                          Brand: {req.brandName} · {formatDateTimeId(req.createdAt)}
                        </p>
                      </div>

                      <p className="line-clamp-3 text-xs text-muted-foreground">{req.brief}</p>

                      {/* Staff Delivery Access Approval Panel */}
                      {showStaffPanel && (
                        <div
                          className="space-y-2.5 rounded-md border border-border bg-muted/40 p-3"
                          data-testid={`staff-access-panel-${req.requestCode}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-foreground">
                              Akses Tim Setup (Editor Sementara)
                            </span>
                            <Badge
                              variant={staffStateBadgeVariant(req.staffAccess.state)}
                              data-testid={`staff-access-badge-${req.requestCode}`}
                            >
                              {req.staffAccess.stateLabel}
                            </Badge>
                          </div>

                          {(req.staffAccess.staffName || req.staffAccess.staffEmail) && (
                            <p className="text-xs text-foreground">
                              Akun ditugaskan:{" "}
                              <strong>{req.staffAccess.staffName ?? "Tim Setup"}</strong>
                              {req.staffAccess.staffEmail ? ` (${req.staffAccess.staffEmail})` : ""}
                            </p>
                          )}

                          {req.staffAccess.state === "waiting_seat" && (
                            <Alert
                              variant="warning"
                              data-testid={`staff-waiting-seat-alert-${req.requestCode}`}
                            >
                              <AlertCircleIcon aria-hidden="true" />
                              <AlertTitle>Menunggu Kursi Anggota Kosong</AlertTitle>
                              <AlertDescription className="space-y-2 text-xs">
                                <p>
                                  {req.staffAccess.waitReason ??
                                    "Semua 5 kursi anggota sedang terpakai. Hapus anggota atau batalkan undangan tertunda di Pengaturan > Anggota lalu coba setujui lagi."}
                                </p>
                                <a
                                  href={membersHref}
                                  className="inline-flex font-medium text-primary underline underline-offset-2"
                                >
                                  Buka Pengaturan &gt; Anggota
                                </a>
                              </AlertDescription>
                            </Alert>
                          )}

                          {req.staffAccess.state === "active" && (
                            <p className="text-xs text-muted-foreground">
                              Tim Setup sedang bekerja dengan peran <strong>Editor</strong> (1 kursi
                              anggota). Akses akan dicabut otomatis begitu status menjadi
                              Diserahkan, Ditolak, atau Dibatalkan.
                            </p>
                          )}

                          {req.staffAccess.state === "revoked" && (
                            <p className="text-xs text-muted-foreground">
                              Keanggotaan sementara Tim Setup sudah dicabut dan tidak lagi memiliki
                              akses ke situs ini.
                            </p>
                          )}

                          {!canApproveStaff &&
                            (req.staffAccess.state === "awaiting_owner_approval" ||
                              req.staffAccess.state === "waiting_seat") && (
                              <p
                                className="text-xs text-muted-foreground"
                                data-testid={`staff-owner-only-note-${req.requestCode}`}
                              >
                                Persetujuan akses anggota Tim Setup hanya dapat dilakukan oleh{" "}
                                <strong>Pemilik Situs (Owner)</strong>.
                              </p>
                            )}

                          {(canClickApprove || canClickRevoke) && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {canClickApprove && (
                                <Button
                                  type="button"
                                  size="sm"
                                  className="min-h-11 sm:min-h-9"
                                  disabled={isBusy}
                                  onClick={() => handleStaffAccessAction(req, "approve")}
                                  data-testid={`btn-approve-staff-${req.requestCode}`}
                                >
                                  <UserCheckIcon className="size-3.5" aria-hidden="true" />
                                  <span>
                                    {isBusy
                                      ? "Memproses..."
                                      : req.staffAccess.state === "waiting_seat"
                                        ? "Coba Setujui Lagi"
                                        : "Setujui Akses Tim Setup"}
                                  </span>
                                </Button>
                              )}
                              {canClickRevoke && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-11 sm:min-h-9"
                                  disabled={isBusy}
                                  onClick={() => handleStaffAccessAction(req, "revoke")}
                                  data-testid={`btn-revoke-staff-${req.requestCode}`}
                                >
                                  <UserXIcon className="size-3.5" aria-hidden="true" />
                                  <span>Cabut Akses</span>
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {req.status === "delivered" && (
                        <div
                          className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs text-foreground"
                          data-testid={`setup-request-delivered-banner-${req.requestCode}`}
                        >
                          <ShieldCheckIcon
                            className="mt-0.5 size-4 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                          <span>
                            Setup website selesai diserahkan dan akses sementara Tim Setup telah
                            dicabut.
                          </span>
                        </div>
                      )}

                      {req.whatsappUrl && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-11 w-full sm:min-h-9"
                          render={
                            <a
                              href={req.whatsappUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              data-testid={`btn-setup-wa-req-${req.requestCode}`}
                            />
                          }
                        >
                          <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                          <span>Hubungi via WhatsApp</span>
                          <ExternalLinkIcon className="size-3" aria-hidden="true" />
                        </Button>
                      )}
                    </article>
                  );
                })
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
