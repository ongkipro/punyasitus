import { useMemo, useState } from "react";
import type { CatalogPriceMode } from "@punyasitus/core/catalog/index";
import {
  buildSpecialistWhatsAppHref,
  formatServicePriceLabel,
  MAX_SERVICE_PRICING_TIERS,
  MAX_SERVICE_PROCESS_STEPS,
  MAX_SERVICE_TIER_DELIVERABLES,
  normalizeServiceDisplayModel,
  resolveServiceHeadlinePricing,
  SERVICE_INQUIRY_BADGE_LABEL,
  SERVICE_PRICING_MODE_LABELS,
  ServiceValidationError,
  validateServiceConsultationAttributes,
  type ServiceConsultationAttributes,
  type ServiceDeliveryMode,
  type ServicePricingMode,
  type ServicePricingTier,
  type ServiceProcessStep,
  type ServiceSpecialistCta,
} from "@punyasitus/core/catalog/service";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BriefcaseIcon,
  CheckCircle2Icon,
  GlobeIcon,
  LayersIcon,
  ListOrderedIcon,
  LockIcon,
  MessageCircleIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UserCheckIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ContentStatusBadge,
  LockedTenantBanner,
} from "@/components/admin/editor";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export interface ServiceCatalogItemDto {
  readonly id: number;
  readonly slug: string;
  readonly publicPath: string;
  readonly title: string;
  readonly summary: string;
  readonly priceMode: CatalogPriceMode;
  readonly price: number | null;
  readonly priceMax: number | null;
  readonly status: "draft" | "published" | "trashed";
  readonly version: number;
  readonly attributes: Record<string, unknown>;
}

export interface ServiceCatalogManagerClientProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly canWriteServices: boolean;
  readonly canPublishServices: boolean;
  readonly initialServices: readonly ServiceCatalogItemDto[];
  readonly fallbackTenantWhatsApp?: string | null;
}

interface EditableTierRow {
  readonly name: string;
  readonly pricingMode: ServicePricingMode;
  readonly priceIdrStr: string;
  readonly billingUnit: string;
  readonly turnaroundLabel: string;
  readonly summary: string;
  readonly highlighted: boolean;
  readonly deliverables: readonly string[];
  readonly newDeliverableDraft: string;
}

interface EditableStepRow {
  readonly title: string;
  readonly summary: string;
  readonly estimatedDuration: string;
}

interface EditorDraftState {
  readonly id: number | null;
  readonly version: number;
  readonly status: "draft" | "published" | "trashed";
  readonly title: string;
  readonly summary: string;
  readonly pricingMode: ServicePricingMode;
  readonly basePriceIdrStr: string;
  readonly serviceArea: string;
  readonly turnaround: string;
  readonly serviceMode: ServiceDeliveryMode | "";
  readonly warranty: string;
  readonly pricingTiers: readonly EditableTierRow[];
  readonly processSteps: readonly EditableStepRow[];
  readonly specialistEnabled: boolean;
  readonly specialistName: string;
  readonly specialistRole: string;
  readonly specialistWhatsapp: string;
  readonly specialistCtaLabel: string;
  readonly specialistPrefilledMessage: string;
}

function buildEmptyDraft(): EditorDraftState {
  return {
    id: null,
    version: 1,
    status: "draft",
    title: "",
    summary: "",
    pricingMode: "from",
    basePriceIdrStr: "2500000",
    serviceArea: "",
    turnaround: "",
    serviceMode: "hybrid",
    warranty: "",
    pricingTiers: [
      {
        name: "Paket Dasar",
        pricingMode: "from",
        priceIdrStr: "2500000",
        billingUnit: "per proyek",
        turnaroundLabel: "7 hari kerja",
        summary: "Pendampingan inti untuk kebutuhan bisnis skala awal.",
        highlighted: false,
        deliverables: ["Sesi konsultasi awal 60 menit", "Laporan rekomendasi tertulis"],
        newDeliverableDraft: "",
      },
    ],
    processSteps: [
      {
        title: "Konsultasi & Pemetaan Kebutuhan",
        summary: "Diskusi ruang lingkup, target hasil, serta jadwal pengerjaan bersama spesialis.",
        estimatedDuration: "1–2 hari kerja",
      },
      {
        title: "Penyusunan Proposal & Rencana Kerja",
        summary: "Pengiriman rincian biaya transparan, tahapan kerja, dan daftar deliverables.",
        estimatedDuration: "2 hari kerja",
      },
    ],
    specialistEnabled: false,
    specialistName: "",
    specialistRole: "",
    specialistWhatsapp: "",
    specialistCtaLabel: "",
    specialistPrefilledMessage: "",
  };
}

function dtoToDraft(item: ServiceCatalogItemDto): EditorDraftState {
  const model = normalizeServiceDisplayModel(item.attributes, {
    priceMode: item.priceMode,
    price: item.price,
  });

  return {
    id: item.id,
    version: item.version,
    status: item.status,
    title: item.title,
    summary: item.summary,
    pricingMode: model.pricingMode,
    basePriceIdrStr:
      model.pricingMode !== "inquiry" && model.headlinePriceIdr !== null
        ? String(model.headlinePriceIdr)
        : "",
    serviceArea: model.serviceArea ?? "",
    turnaround: model.turnaround ?? "",
    serviceMode: model.serviceMode ?? "",
    warranty: model.warranty ?? "",
    pricingTiers: model.pricingTiers.map((tier) => ({
      name: tier.name,
      pricingMode: tier.pricingMode,
      priceIdrStr:
        tier.pricingMode !== "inquiry" && typeof tier.priceIdr === "number"
          ? String(tier.priceIdr)
          : "",
      billingUnit: tier.billingUnit ?? "",
      turnaroundLabel: tier.turnaroundLabel ?? "",
      summary: tier.summary ?? "",
      highlighted: tier.highlighted === true,
      deliverables: tier.deliverables ? [...tier.deliverables] : [],
      newDeliverableDraft: "",
    })),
    processSteps:
      model.processSteps.length > 0
        ? model.processSteps.map((step) => ({
            title: step.title,
            summary: step.summary,
            estimatedDuration: step.estimatedDuration ?? "",
          }))
        : [
            {
              title: "Konsultasi Awal",
              summary: "Pemetaan kebutuhan klien dan ruang lingkup layanan.",
              estimatedDuration: "1 hari kerja",
            },
          ],
    specialistEnabled: Boolean(model.specialistCta),
    specialistName: model.specialistCta?.specialistName ?? "",
    specialistRole: model.specialistCta?.specialistRole ?? "",
    specialistWhatsapp: model.specialistCta?.whatsappNumber ?? "",
    specialistCtaLabel: model.specialistCta?.ctaLabel ?? "",
    specialistPrefilledMessage: model.specialistCta?.prefilledMessage ?? "",
  };
}

function parsePositiveInt(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const num = Number(digits);
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

export function ServiceCatalogManagerClient({
  handle,
  basePath,
  permissions,
  canWriteServices,
  canPublishServices,
  initialServices,
  fallbackTenantWhatsApp = null,
}: ServiceCatalogManagerClientProps) {
  const [services, setServices] = useState<readonly ServiceCatalogItemDto[]>(initialServices);
  const [draft, setDraft] = useState<EditorDraftState>(() =>
    initialServices[0] ? dtoToDraft(initialServices[0]) : buildEmptyDraft(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{
    readonly tone: "success" | "warning" | "destructive";
    readonly title: string;
    readonly message: string;
  } | null>(null);

  const readOnly = !canWriteServices || permissions.isLocked;

  const previewHeadline = useMemo(() => {
    const tiers: ServicePricingTier[] = draft.pricingTiers
      .filter((t) => t.name.trim().length > 0)
      .map((t) => {
        const mode: ServicePricingMode =
          draft.pricingMode === "inquiry" ? "inquiry" : t.pricingMode;
        const parsed = mode === "inquiry" ? null : parsePositiveInt(t.priceIdrStr);
        return {
          name: t.name.trim(),
          pricingMode: mode,
          ...(parsed !== null ? { priceIdr: parsed } : {}),
        };
      });
    const basePriceIdr =
      draft.pricingMode === "inquiry" ? null : parsePositiveInt(draft.basePriceIdrStr);
    return resolveServiceHeadlinePricing({
      pricingMode: draft.pricingMode,
      basePriceIdr,
      pricingTiers: tiers,
    });
  }, [draft.pricingMode, draft.basePriceIdrStr, draft.pricingTiers]);

  const previewWaHref = useMemo(() => {
    if (draft.specialistEnabled && draft.specialistWhatsapp.trim()) {
      return buildSpecialistWhatsAppHref({
        specialistCta: {
          specialistName: draft.specialistName.trim() || "Spesialis",
          specialistRole: draft.specialistRole.trim() || "Konsultan",
          whatsappNumber: draft.specialistWhatsapp.trim(),
          prefilledMessage: draft.specialistPrefilledMessage.trim() || undefined,
        },
        serviceTitle: draft.title.trim() || "Layanan Profesional",
      });
    }
    return buildSpecialistWhatsAppHref({
      fallbackPhone: fallbackTenantWhatsApp,
      serviceTitle: draft.title.trim() || "Layanan Profesional",
    });
  }, [
    draft.specialistEnabled,
    draft.specialistName,
    draft.specialistRole,
    draft.specialistWhatsapp,
    draft.specialistPrefilledMessage,
    draft.title,
    fallbackTenantWhatsApp,
  ]);

  function updateDraft<K extends keyof EditorDraftState>(key: K, value: EditorDraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setBanner(null);
  }

  function handlePricingModeChange(nextMode: ServicePricingMode) {
    setDraft((prev) => ({
      ...prev,
      pricingMode: nextMode,
      ...(nextMode === "inquiry" ? { basePriceIdrStr: "" } : {}),
      pricingTiers: prev.pricingTiers.map((tier) =>
        nextMode === "inquiry"
          ? { ...tier, pricingMode: "inquiry", priceIdrStr: "" }
          : tier,
      ),
    }));
    setFieldErrors({});
    setBanner(null);
  }

  function selectService(item: ServiceCatalogItemDto) {
    setDraft(dtoToDraft(item));
    setFieldErrors({});
    setBanner(null);
  }

  function startNewService() {
    setDraft(buildEmptyDraft());
    setFieldErrors({});
    setBanner(null);
  }

  function addPricingTier() {
    if (readOnly || draft.pricingTiers.length >= MAX_SERVICE_PRICING_TIERS) return;
    const defaultTierMode: ServicePricingMode =
      draft.pricingMode === "inquiry" ? "inquiry" : draft.pricingMode;
    updateDraft("pricingTiers", [
      ...draft.pricingTiers,
      {
        name: "",
        pricingMode: defaultTierMode,
        priceIdrStr: "",
        billingUnit: "",
        turnaroundLabel: "",
        summary: "",
        highlighted: false,
        deliverables: [],
        newDeliverableDraft: "",
      },
    ]);
  }

  function updateTier(idx: number, patch: Partial<EditableTierRow>) {
    updateDraft(
      "pricingTiers",
      draft.pricingTiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  }

  function removeTier(idx: number) {
    updateDraft(
      "pricingTiers",
      draft.pricingTiers.filter((_, i) => i !== idx),
    );
  }

  function addTierDeliverable(tierIdx: number) {
    const tier = draft.pricingTiers[tierIdx];
    if (!tier || readOnly) return;
    const trimmed = tier.newDeliverableDraft.trim();
    if (!trimmed || tier.deliverables.length >= MAX_SERVICE_TIER_DELIVERABLES) return;
    updateTier(tierIdx, {
      deliverables: [...tier.deliverables, trimmed],
      newDeliverableDraft: "",
    });
  }

  function removeTierDeliverable(tierIdx: number, delivIdx: number) {
    const tier = draft.pricingTiers[tierIdx];
    if (!tier || readOnly) return;
    updateTier(tierIdx, {
      deliverables: tier.deliverables.filter((_, i) => i !== delivIdx),
    });
  }

  function addProcessStep() {
    if (readOnly || draft.processSteps.length >= MAX_SERVICE_PROCESS_STEPS) return;
    updateDraft("processSteps", [
      ...draft.processSteps,
      { title: "", summary: "", estimatedDuration: "" },
    ]);
  }

  function updateStep(idx: number, patch: Partial<EditableStepRow>) {
    updateDraft(
      "processSteps",
      draft.processSteps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  }

  function moveStep(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= draft.processSteps.length) return;
    const next = [...draft.processSteps];
    const current = next[idx];
    const swap = next[target];
    if (!current || !swap) return;
    next[idx] = swap;
    next[target] = current;
    updateDraft("processSteps", next);
  }

  function removeStep(idx: number) {
    if (draft.processSteps.length <= 1) return;
    updateDraft(
      "processSteps",
      draft.processSteps.filter((_, i) => i !== idx),
    );
  }

  function buildValidatedPayload(): ServiceConsultationAttributes {
    const pricingTiers: ServicePricingTier[] = draft.pricingTiers.map((tier) => {
      const effectiveMode: ServicePricingMode =
        draft.pricingMode === "inquiry" ? "inquiry" : tier.pricingMode;
      const parsedPrice =
        effectiveMode === "inquiry" ? null : parsePositiveInt(tier.priceIdrStr);
      const deliverables = tier.deliverables.map((d) => d.trim()).filter(Boolean);
      return {
        name: tier.name.trim(),
        pricingMode: effectiveMode,
        ...(effectiveMode !== "inquiry" && parsedPrice !== null ? { priceIdr: parsedPrice } : {}),
        ...(tier.billingUnit.trim() ? { billingUnit: tier.billingUnit.trim() } : {}),
        ...(tier.turnaroundLabel.trim() ? { turnaroundLabel: tier.turnaroundLabel.trim() } : {}),
        ...(tier.summary.trim() ? { summary: tier.summary.trim() } : {}),
        ...(deliverables.length > 0 ? { deliverables } : {}),
        ...(tier.highlighted ? { highlighted: true } : {}),
      };
    });

    const processSteps: ServiceProcessStep[] = draft.processSteps.map((step, idx) => ({
      stepNumber: idx + 1,
      title: step.title.trim(),
      summary: step.summary.trim(),
      ...(step.estimatedDuration.trim()
        ? { estimatedDuration: step.estimatedDuration.trim() }
        : {}),
    }));

    let specialistCta: ServiceSpecialistCta | undefined;
    if (draft.specialistEnabled) {
      specialistCta = {
        specialistName: draft.specialistName.trim(),
        specialistRole: draft.specialistRole.trim(),
        whatsappNumber: draft.specialistWhatsapp.trim(),
        ...(draft.specialistCtaLabel.trim()
          ? { ctaLabel: draft.specialistCtaLabel.trim() }
          : {}),
        ...(draft.specialistPrefilledMessage.trim()
          ? { prefilledMessage: draft.specialistPrefilledMessage.trim() }
          : {}),
      };
    }

    const basePriceIdr =
      draft.pricingMode === "inquiry" ? null : parsePositiveInt(draft.basePriceIdrStr);

    const raw: Record<string, unknown> = {
      pricingMode: draft.pricingMode,
      ...(basePriceIdr !== null ? { basePriceIdr } : {}),
      pricingTiers,
      processSteps,
      ...(specialistCta ? { specialistCta } : {}),
      ...(draft.serviceArea.trim() ? { serviceArea: draft.serviceArea.trim() } : {}),
      ...(draft.turnaround.trim() ? { turnaround: draft.turnaround.trim() } : {}),
      ...(draft.serviceMode ? { serviceMode: draft.serviceMode } : {}),
      ...(draft.warranty.trim() ? { warranty: draft.warranty.trim() } : {}),
    };

    return validateServiceConsultationAttributes(raw);
  }

  async function submitToServicesApi(action: "save_draft" | "publish") {
    if (readOnly) return;
    if (action === "publish" && !canPublishServices) return;

    setFieldErrors({});
    setBanner(null);

    if (!draft.title.trim()) {
      setFieldErrors({ title: "Judul layanan profesional wajib diisi." });
      setBanner({
        tone: "destructive",
        title: "Judul layanan belum diisi",
        message: "Lengkapi nama layanan sebelum menyimpan atau memublikasikan.",
      });
      return;
    }

    let validated: ServiceConsultationAttributes;
    try {
      validated = buildValidatedPayload();
    } catch (err) {
      if (err instanceof ServiceValidationError) {
        const mapped: Record<string, string> = {};
        for (const f of err.fields) {
          mapped[f.field] = f.message;
        }
        setFieldErrors(mapped);
        setBanner({
          tone: "destructive",
          title: "Periksa isian layanan profesional",
          message: err.message,
        });
        return;
      }
      throw err;
    }

    const headline = resolveServiceHeadlinePricing(validated);
    if (validated.pricingMode !== "inquiry" && headline.priceIdr === null) {
      setFieldErrors({
        basePriceIdr:
          "Isi harga dasar (Rp) atau tambahkan minimal satu paket dengan nominal harga Rupiah.",
      });
      setBanner({
        tone: "destructive",
        title: "Nominal harga belum lengkap",
        message:
          "Untuk mode 'Mulai dari' atau 'Harga Tetap', masukkan harga dasar atau nominal paket Rupiah.",
      });
      return;
    }

    setSubmitting(true);
    try {
      const saved = await cmsFetchJson<ServiceCatalogItemDto>(
        `/dashboard/${encodeURIComponent(handle)}/catalog/services/api`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            ...(draft.id !== null ? { id: draft.id, expectedVersion: draft.version } : {}),
            title: draft.title.trim(),
            summary: draft.summary.trim() || null,
            service: validated,
          }),
        },
      );

      setServices((prev) => {
        const exists = prev.some((s) => s.id === saved.id);
        return exists ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev];
      });
      setDraft(dtoToDraft(saved));
      setBanner({
        tone: "success",
        title: action === "publish" ? "Layanan berhasil dipublikasikan" : "Draf layanan tersimpan",
        message:
          action === "publish"
            ? `Layanan "${saved.title}" kini tampil di halaman publik ${saved.publicPath}.`
            : `Perubahan draf "${saved.title}" tersimpan (versi ${saved.version}).`,
      });
    } catch (err) {
      if (err instanceof CmsApiError) {
        setBanner({
          tone: "destructive",
          title: err.status === 409 ? "Konflik versi (OCC)" : "Gagal menyimpan layanan",
          message: err.message,
        });
      } else {
        setBanner({
          tone: "destructive",
          title: "Terjadi kendala jaringan",
          message: "Tidak dapat menghubungi server. Silakan coba kembali.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-12"
      data-testid="services-manager-root"
    >
      {/* Top Action Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`${basePath}/catalog`}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
              Katalog
            </a>
            <span className="text-muted-foreground">/</span>
            <Badge variant="outline" className="gap-1">
              <BriefcaseIcon className="size-3.5" />
              Layanan Profesional
            </Badge>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Harga Paket &amp; Alur Konsultasi Layanan
          </h1>
          <p className="text-sm text-muted-foreground">
            Atur paket harga transparan (Mulai dari, Harga Tetap, atau Penawaran Khusus), tahapan{" "}
            <strong className="font-medium text-foreground">Cara Kerja</strong>, dan satu tombol
            konsultasi WhatsApp spesialis tanpa keranjang belanja.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={startNewService}
            disabled={readOnly || submitting}
            data-testid="service-new-btn"
          >
            <PlusIcon className="size-4" />
            Layanan Baru
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => submitToServicesApi("save_draft")}
            disabled={readOnly || submitting}
            data-testid="service-save-draft-btn"
          >
            <SaveIcon className="size-4" />
            {submitting ? "Menyimpan..." : "Simpan Draf"}
          </Button>
          <Button
            type="button"
            onClick={() => submitToServicesApi("publish")}
            disabled={readOnly || !canPublishServices || submitting}
            data-testid="service-publish-btn"
          >
            <GlobeIcon className="size-4" />
            Publikasikan
          </Button>
        </div>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/billing`} />}

      {!permissions.isLocked && readOnly && (
        <Alert>
          <LockIcon className="size-4" />
          <AlertTitle>Mode Hanya-Baca</AlertTitle>
          <AlertDescription>
            Peran akun Anda hanya memiliki akses membaca katalog layanan profesional.
          </AlertDescription>
        </Alert>
      )}

      {banner && (
        <Alert
          variant={banner.tone === "destructive" ? "destructive" : "default"}
          data-testid="service-status-banner"
        >
          <CheckCircle2Icon className="size-4" />
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {/* Existing Services Selector Strip */}
      {services.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Daftar Layanan ({services.length})</CardTitle>
            <CardDescription>
              Pilih layanan untuk mengubah paket harga, tahapan Cara Kerja, atau WhatsApp spesialis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2" data-testid="service-item-pills">
              {services.map((item) => {
                const isSelected = draft.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectService(item)}
                    data-testid={`service-item-pill-${item.id}`}
                    className={`inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5 font-semibold text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">{item.title}</span>
                    <ContentStatusBadge status={item.status} />
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Editor Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          {/* 1. Identitas & Mode Harga Utama */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Informasi Utama &amp; Mode Harga</CardTitle>
                  <CardDescription>
                    Pilih model transparansi biaya. Mode penawaran khusus tidak akan menampilkan
                    harga numerik maupun skema Offer.
                  </CardDescription>
                </div>
                <ContentStatusBadge status={draft.status} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="service-title" className="text-sm font-medium text-foreground">
                  Nama Layanan Profesional <span className="text-destructive">*</span>
                </label>
                <Input
                  id="service-title"
                  value={draft.title}
                  onChange={(e) => updateDraft("title", e.target.value)}
                  disabled={readOnly}
                  placeholder="Contoh: Jasa Audit & Pendampingan Pajak Perusahaan"
                  data-testid="service-title-input"
                />
                {fieldErrors.title && (
                  <p className="text-xs text-destructive">{fieldErrors.title}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="service-summary" className="text-sm font-medium text-foreground">
                  Ringkasan Singkat Layanan
                </label>
                <textarea
                  id="service-summary"
                  rows={3}
                  value={draft.summary}
                  onChange={(e) => updateDraft("summary", e.target.value)}
                  disabled={readOnly}
                  placeholder="Jelaskan hasil utama yang diterima klien serta segmen bisnis yang cocok."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                />
              </div>

              <Separator />

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">
                  Mode Harga Layanan <span className="text-destructive">*</span>
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(["from", "fixed", "inquiry"] as const).map((mode) => {
                    const active = draft.pricingMode === mode;
                    const inputId = `service-pricing-mode-${mode}`;
                    return (
                      <label
                        key={mode}
                        htmlFor={inputId}
                        data-testid={`pricing-mode-option-${mode}`}
                        className={`flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors ${
                          active
                            ? "border-primary bg-primary/5 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-muted/50"
                        } ${readOnly ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <input
                          id={inputId}
                          type="radio"
                          name="service-pricing-mode"
                          value={mode}
                          checked={active}
                          disabled={readOnly}
                          onChange={() => handlePricingModeChange(mode)}
                          className="mt-1 size-4 accent-primary"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-foreground">
                            {SERVICE_PRICING_MODE_LABELS[mode]}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {mode === "from"
                              ? 'Tampil "Mulai dari Rp..."'
                              : mode === "fixed"
                                ? 'Tampil nominal tetap "Rp..."'
                                : "Tanpa harga numerik"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {draft.pricingMode !== "inquiry" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="service-base-price"
                      className="text-sm font-medium text-foreground"
                    >
                      {draft.pricingMode === "from"
                        ? "Harga Mulai Dari (IDR)"
                        : "Harga Tetap Layanan (IDR)"}
                    </label>
                    <Input
                      id="service-base-price"
                      inputMode="numeric"
                      value={draft.basePriceIdrStr}
                      onChange={(e) => updateDraft("basePriceIdrStr", e.target.value)}
                      disabled={readOnly}
                      placeholder="Contoh: 2500000"
                      data-testid="service-base-price-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      Opsional jika sudah mengisi nominal harga pada daftar paket di bawah.
                    </p>
                    {fieldErrors.basePriceIdr && (
                      <p className="text-xs text-destructive">{fieldErrors.basePriceIdr}</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="service-delivery-mode"
                      className="text-sm font-medium text-foreground"
                    >
                      Mode Pelaksanaan
                    </label>
                    <select
                      id="service-delivery-mode"
                      value={draft.serviceMode}
                      onChange={(e) =>
                        updateDraft("serviceMode", e.target.value as ServiceDeliveryMode | "")
                      }
                      disabled={readOnly}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    >
                      <option value="">Tidak ditentukan</option>
                      <option value="hybrid">Hybrid (Daring &amp; Lokasi)</option>
                      <option value="remote">Jarak Jauh (Online)</option>
                      <option value="onsite">Di Lokasi Klien</option>
                      <option value="in_store">Di Kantor / Gerai</option>
                    </select>
                  </div>
                </div>
              ) : (
                <Alert data-testid="service-inquiry-mode-notice">
                  <BriefcaseIcon className="size-4" />
                  <AlertTitle>{SERVICE_INQUIRY_BADGE_LABEL}</AlertTitle>
                  <AlertDescription>
                    Halaman publik hanya menampilkan label konsultasi/penawaran khusus tanpa angka
                    harga Rupiah dan tanpa properti Offer di JSON-LD.
                  </AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="service-area" className="text-sm font-medium text-foreground">
                    Area Layanan
                  </label>
                  <Input
                    id="service-area"
                    value={draft.serviceArea}
                    onChange={(e) => updateDraft("serviceArea", e.target.value)}
                    disabled={readOnly}
                    placeholder="Contoh: Jabodetabek & Seluruh Indonesia"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="service-turnaround"
                    className="text-sm font-medium text-foreground"
                  >
                    Estimasi Pengerjaan
                  </label>
                  <Input
                    id="service-turnaround"
                    value={draft.turnaround}
                    onChange={(e) => updateDraft("turnaround", e.target.value)}
                    disabled={readOnly}
                    placeholder="Contoh: 7–14 hari kerja"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Paket Harga Transparan (0..6 Tiers) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <LayersIcon className="size-4 text-primary" />
                    Paket Harga Transparan ({draft.pricingTiers.length}/{MAX_SERVICE_PRICING_TIERS})
                  </CardTitle>
                  <CardDescription>
                    Opsional (maks. 6 paket, maks. 8 deliverables per paket). Tanpa tombol keranjang
                    atau checkout.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addPricingTier}
                  disabled={readOnly || draft.pricingTiers.length >= MAX_SERVICE_PRICING_TIERS}
                  data-testid="service-add-tier-btn"
                >
                  <PlusIcon className="size-4" />
                  Tambah Paket
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.pricingTiers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  Belum ada rincian paket harga. Anda dapat menambahkan paket Starter, Pro, atau
                  Enterprise, atau membiarkannya kosong untuk menampilkan harga utama saja.
                </div>
              ) : (
                draft.pricingTiers.map((tier, tierIdx) => {
                  const isInquiryLocked =
                    draft.pricingMode === "inquiry" || tier.pricingMode === "inquiry";
                  const tierLabelPreview = formatServicePriceLabel(
                    draft.pricingMode === "inquiry" ? "inquiry" : tier.pricingMode,
                    parsePositiveInt(tier.priceIdrStr),
                  );
                  return (
                    <div
                      key={tierIdx}
                      className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                      data-testid={`service-tier-editor-${tierIdx}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">Paket #{tierIdx + 1}</Badge>
                          <span className="text-xs font-medium tabular-nums text-muted-foreground">
                            Pratinjau: {tierLabelPreview}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeTier(tierIdx)}
                          disabled={readOnly}
                          aria-label={`Hapus paket ${tierIdx + 1}`}
                        >
                          <Trash2Icon className="size-4 text-destructive" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label
                            htmlFor={`tier-name-${tierIdx}`}
                            className="text-xs font-medium text-foreground"
                          >
                            Nama Paket <span className="text-destructive">*</span>
                          </label>
                          <Input
                            id={`tier-name-${tierIdx}`}
                            value={tier.name}
                            onChange={(e) => updateTier(tierIdx, { name: e.target.value })}
                            disabled={readOnly}
                            placeholder="Contoh: Paket Pendampingan UMKM"
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor={`tier-mode-${tierIdx}`}
                            className="text-xs font-medium text-foreground"
                          >
                            Mode Harga Paket
                          </label>
                          <select
                            id={`tier-mode-${tierIdx}`}
                            value={draft.pricingMode === "inquiry" ? "inquiry" : tier.pricingMode}
                            onChange={(e) => {
                              const nextTierMode = e.target.value as ServicePricingMode;
                              updateTier(tierIdx, {
                                pricingMode: nextTierMode,
                                ...(nextTierMode === "inquiry" ? { priceIdrStr: "" } : {}),
                              });
                            }}
                            disabled={readOnly || draft.pricingMode === "inquiry"}
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-60"
                          >
                            <option value="from">Mulai dari (Rp...)</option>
                            <option value="fixed">Harga Tetap (Rp...)</option>
                            <option value="inquiry">Konsultasi / Penawaran Khusus</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="space-y-1">
                          <label
                            htmlFor={`tier-price-${tierIdx}`}
                            className="text-xs font-medium text-foreground"
                          >
                            Nominal Harga (IDR)
                          </label>
                          <Input
                            id={`tier-price-${tierIdx}`}
                            inputMode="numeric"
                            value={isInquiryLocked ? "" : tier.priceIdrStr}
                            onChange={(e) => updateTier(tierIdx, { priceIdrStr: e.target.value })}
                            disabled={readOnly || isInquiryLocked}
                            placeholder={isInquiryLocked ? "Tanpa harga numerik" : "2500000"}
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor={`tier-unit-${tierIdx}`}
                            className="text-xs font-medium text-foreground"
                          >
                            Satuan Tagihan
                          </label>
                          <Input
                            id={`tier-unit-${tierIdx}`}
                            value={tier.billingUnit}
                            onChange={(e) => updateTier(tierIdx, { billingUnit: e.target.value })}
                            disabled={readOnly}
                            placeholder="per proyek / per sesi"
                          />
                        </div>

                        <div className="space-y-1">
                          <label
                            htmlFor={`tier-turnaround-${tierIdx}`}
                            className="text-xs font-medium text-foreground"
                          >
                            Estimasi Waktu
                          </label>
                          <Input
                            id={`tier-turnaround-${tierIdx}`}
                            value={tier.turnaroundLabel}
                            onChange={(e) =>
                              updateTier(tierIdx, { turnaroundLabel: e.target.value })
                            }
                            disabled={readOnly}
                            placeholder="7 hari kerja"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label
                          htmlFor={`tier-summary-${tierIdx}`}
                          className="text-xs font-medium text-foreground"
                        >
                          Deskripsi Singkat Paket
                        </label>
                        <Input
                          id={`tier-summary-${tierIdx}`}
                          value={tier.summary}
                          onChange={(e) => updateTier(tierIdx, { summary: e.target.value })}
                          disabled={readOnly}
                          placeholder="Cocok untuk perusahaan yang membutuhkan audit tahunan."
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          id={`tier-highlighted-${tierIdx}`}
                          type="checkbox"
                          checked={tier.highlighted}
                          disabled={readOnly}
                          onChange={(e) =>
                            updateTier(tierIdx, { highlighted: e.target.checked })
                          }
                          className="size-4 accent-primary"
                        />
                        <label
                          htmlFor={`tier-highlighted-${tierIdx}`}
                          className="text-xs font-medium text-foreground"
                        >
                          Sorot sebagai paket paling direkomendasikan
                        </label>
                      </div>

                      {/* Tier Deliverables (<= 8) */}
                      <div className="space-y-2 rounded-md border border-border/80 bg-background p-3">
                        <div className="flex items-center justify-between text-xs font-medium text-foreground">
                          <span>
                            Rincian Deliverables ({tier.deliverables.length}/
                            {MAX_SERVICE_TIER_DELIVERABLES})
                          </span>
                        </div>
                        {tier.deliverables.length > 0 && (
                          <ul className="space-y-1.5">
                            {tier.deliverables.map((deliv, delivIdx) => (
                              <li
                                key={delivIdx}
                                className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2.5 py-1.5 text-xs text-foreground"
                              >
                                <span className="min-w-0 break-words">{deliv}</span>
                                <button
                                  type="button"
                                  onClick={() => removeTierDeliverable(tierIdx, delivIdx)}
                                  disabled={readOnly}
                                  className="shrink-0 text-muted-foreground hover:text-destructive"
                                  aria-label={`Hapus deliverable ${delivIdx + 1}`}
                                >
                                  <Trash2Icon className="size-3.5" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <label
                            htmlFor={`tier-new-deliv-${tierIdx}`}
                            className="sr-only"
                          >
                            Tambah rincian deliverable paket {tierIdx + 1}
                          </label>
                          <Input
                            id={`tier-new-deliv-${tierIdx}`}
                            value={tier.newDeliverableDraft}
                            onChange={(e) =>
                              updateTier(tierIdx, { newDeliverableDraft: e.target.value })
                            }
                            disabled={
                              readOnly ||
                              tier.deliverables.length >= MAX_SERVICE_TIER_DELIVERABLES
                            }
                            placeholder="Contoh: Laporan audit lengkap & sesi presentasi direksi"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => addTierDeliverable(tierIdx)}
                            disabled={
                              readOnly ||
                              !tier.newDeliverableDraft.trim() ||
                              tier.deliverables.length >= MAX_SERVICE_TIER_DELIVERABLES
                            }
                            className="shrink-0"
                          >
                            <PlusIcon className="size-3.5" />
                            Tambah
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* 3. Tahapan "Cara Kerja" (1..10 Steps) */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ListOrderedIcon className="size-4 text-primary" />
                    Tahapan &ldquo;Cara Kerja&rdquo; ({draft.processSteps.length}/
                    {MAX_SERVICE_PROCESS_STEPS})
                  </CardTitle>
                  <CardDescription>
                    Minimal 1 dan maksimal 10 langkah proses konsultasi berurutan untuk membantu
                    klien memahami alur kerja.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addProcessStep}
                  disabled={readOnly || draft.processSteps.length >= MAX_SERVICE_PROCESS_STEPS}
                  data-testid="service-add-step-btn"
                >
                  <PlusIcon className="size-4" />
                  Tambah Langkah
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.processSteps.map((step, stepIdx) => (
                <div
                  key={stepIdx}
                  className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                  data-testid={`service-step-editor-${stepIdx}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="outline" className="tabular-nums">
                      Langkah {stepIdx + 1}
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => moveStep(stepIdx, -1)}
                        disabled={readOnly || stepIdx === 0}
                        aria-label={`Naikkan langkah ${stepIdx + 1}`}
                      >
                        <ArrowUpIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => moveStep(stepIdx, 1)}
                        disabled={readOnly || stepIdx === draft.processSteps.length - 1}
                        aria-label={`Turunkan langkah ${stepIdx + 1}`}
                      >
                        <ArrowDownIcon className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeStep(stepIdx)}
                        disabled={readOnly || draft.processSteps.length <= 1}
                        aria-label={`Hapus langkah ${stepIdx + 1}`}
                      >
                        <Trash2Icon className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label
                        htmlFor={`step-title-${stepIdx}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Judul Tahap <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id={`step-title-${stepIdx}`}
                        value={step.title}
                        onChange={(e) => updateStep(stepIdx, { title: e.target.value })}
                        disabled={readOnly}
                        placeholder="Contoh: Konsultasi & Pemetaan Dokumen"
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor={`step-duration-${stepIdx}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Estimasi Durasi (Opsional)
                      </label>
                      <Input
                        id={`step-duration-${stepIdx}`}
                        value={step.estimatedDuration}
                        onChange={(e) =>
                          updateStep(stepIdx, { estimatedDuration: e.target.value })
                        }
                        disabled={readOnly}
                        placeholder="Contoh: 1–2 hari kerja"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor={`step-summary-${stepIdx}`}
                      className="text-xs font-medium text-foreground"
                    >
                      Ringkasan Proses <span className="text-destructive">*</span>
                    </label>
                    <textarea
                      id={`step-summary-${stepIdx}`}
                      rows={2}
                      value={step.summary}
                      onChange={(e) => updateStep(stepIdx, { summary: e.target.value })}
                      disabled={readOnly}
                      placeholder="Jelaskan aktivitas dan hasil dari tahap ini."
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 4. Satu Override WhatsApp Spesialis */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheckIcon className="size-4 text-primary" />
                Konsultasi WhatsApp Spesialis (Opsional — Maks. 1 Override)
              </CardTitle>
              <CardDescription>
                Arahkan tombol konsultasi layanan ini langsung ke nomor WhatsApp konsultan/spesialis
                terkait. Jika dinonaktifkan, tombol otomatis memakai WhatsApp utama bisnis.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2.5">
                <input
                  id="service-specialist-enabled"
                  type="checkbox"
                  checked={draft.specialistEnabled}
                  disabled={readOnly}
                  onChange={(e) => updateDraft("specialistEnabled", e.target.checked)}
                  className="size-4 accent-primary"
                  data-testid="service-specialist-toggle"
                />
                <label
                  htmlFor="service-specialist-enabled"
                  className="text-sm font-medium text-foreground"
                >
                  Aktifkan nomor WhatsApp khusus spesialis untuk layanan ini
                </label>
              </div>

              {draft.specialistEnabled && (
                <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label
                        htmlFor="specialist-name"
                        className="text-xs font-medium text-foreground"
                      >
                        Nama Spesialis <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id="specialist-name"
                        value={draft.specialistName}
                        onChange={(e) => updateDraft("specialistName", e.target.value)}
                        disabled={readOnly}
                        placeholder="Contoh: Rina Kartika, BKP"
                        data-testid="specialist-name-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor="specialist-role"
                        className="text-xs font-medium text-foreground"
                      >
                        Peran / Jabatan <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id="specialist-role"
                        value={draft.specialistRole}
                        onChange={(e) => updateDraft("specialistRole", e.target.value)}
                        disabled={readOnly}
                        placeholder="Contoh: Konsultan Pajak Senior"
                        data-testid="specialist-role-input"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label
                        htmlFor="specialist-whatsapp"
                        className="text-xs font-medium text-foreground"
                      >
                        Nomor WhatsApp Indonesia <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id="specialist-whatsapp"
                        value={draft.specialistWhatsapp}
                        onChange={(e) => updateDraft("specialistWhatsapp", e.target.value)}
                        disabled={readOnly}
                        placeholder="Contoh: 0812-3456-7890 atau +6281234567890"
                        data-testid="specialist-wa-input"
                      />
                      {fieldErrors["specialistCta.whatsappNumber"] && (
                        <p className="text-xs text-destructive">
                          {fieldErrors["specialistCta.whatsappNumber"]}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label
                        htmlFor="specialist-cta-label"
                        className="text-xs font-medium text-foreground"
                      >
                        Label Tombol CTA (Opsional)
                      </label>
                      <Input
                        id="specialist-cta-label"
                        value={draft.specialistCtaLabel}
                        onChange={(e) => updateDraft("specialistCtaLabel", e.target.value)}
                        disabled={readOnly}
                        placeholder="Contoh: Konsultasi Langsung via WhatsApp"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="specialist-prefilled"
                      className="text-xs font-medium text-foreground"
                    >
                      Pesan Pembuka WhatsApp (Opsional)
                    </label>
                    <Input
                      id="specialist-prefilled"
                      value={draft.specialistPrefilledMessage}
                      onChange={(e) => updateDraft("specialistPrefilledMessage", e.target.value)}
                      disabled={readOnly}
                      placeholder="Halo Bu Rina, saya ingin menjadwalkan konsultasi audit pajak."
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Sticky Summary Preview */}
        <div className="min-w-0 lg:col-span-4">
          <Card className="lg:sticky lg:top-6" data-testid="service-live-summary-card">
            <CardHeader>
              <CardTitle className="text-base">Ringkasan Publik</CardTitle>
              <CardDescription>
                Pratinjau fakta yang tampil di halaman publik <code>/layanan/[slug]</code> &amp;
                JSON-LD <code>Service</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="space-y-1 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs font-medium text-muted-foreground">Tampilan Harga Utama</p>
                <p
                  className="text-lg font-bold tabular-nums text-foreground"
                  data-testid="service-preview-headline-price"
                >
                  {previewHeadline.formattedLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  Mode: {SERVICE_PRICING_MODE_LABELS[draft.pricingMode]}
                </p>
              </div>

              <dl className="space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Jumlah Paket Harga</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {draft.pricingTiers.length} paket
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Tahapan Cara Kerja</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {draft.processSteps.length} langkah
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Skema JSON-LD</dt>
                  <dd className="font-semibold text-foreground">
                    {draft.pricingMode === "inquiry"
                      ? "Service (tanpa Offer)"
                      : draft.pricingMode === "fixed"
                        ? "Service + Offer (IDR)"
                        : "Service + AggregateOffer"}
                  </dd>
                </div>
              </dl>

              <Separator />

              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MessageCircleIcon className="size-3.5 text-primary" />
                  Tujuan Tombol Konsultasi WA
                </p>
                {draft.specialistEnabled ? (
                  <div className="rounded-md border border-border bg-background p-2.5 text-xs">
                    <p className="font-semibold text-foreground">
                      {draft.specialistName.trim() || "Nama spesialis belum diisi"}
                    </p>
                    <p className="text-muted-foreground">
                      {draft.specialistRole.trim() || "Jabatan spesialis"}
                    </p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {previewWaHref ?? "Masukkan nomor WA Indonesia yang valid"}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Menggunakan nomor WhatsApp utama bisnis (default).
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
