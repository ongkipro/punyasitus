import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FileEditIcon,
  InfoIcon,
  PenLineIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SkipForwardIcon,
} from "lucide-react";
import {
  AI_WRITING_QUOTA_LIMIT,
  type AiWritingQuotaStatus,
} from "@punyasitus/core/ai-writing/index";
import {
  ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS,
  resolveDefaultBlueprintForVertical,
  type OnboardingAiDraftApiResponse,
  type OnboardingAiDraftTextFields,
  type OnboardingBlueprintDraft,
} from "@punyasitus/core/onboarding/ai-draft/index";
import type { OnboardingVertical } from "@punyasitus/core/onboarding/index";
import {
  B2B_BLUEPRINT_CATALOG,
  B2B_VERTICAL_BLUEPRINTS,
  type B2BBlueprintId,
} from "@punyasitus/core/presets/blueprints";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export interface OnboardingAiDraftStepProps {
  readonly tenantId: string;
  readonly businessName: string;
  readonly vertical: OnboardingVertical;
  readonly initialShortDescription?: string;
  readonly initialQuota?: AiWritingQuotaStatus | null;
  readonly initialState?: "ready" | "generated" | "skipped" | "fallback";
  readonly initialDraft?: OnboardingAiDraftTextFields | null;
  readonly initialFallbackMessage?: string | null;
  readonly initialFallbackReason?: string | null;
  readonly onDraftComplete?: (result: OnboardingAiDraftApiResponse) => void;
  readonly onSkip?: () => void;
}

type StepPhase = "ready" | "loading" | "generated" | "skipped" | "fallback";

const EMPTY_FACT_ITEMS = [
  { key: "price", label: "Harga / Tarif", value: "Kosong (isi sendiri di Dashboard)" },
  { key: "licence", label: "Nomor Izin / Lisensi", value: "Kosong (NIB / PPIU / SIP tidak dikarang)" },
  { key: "reviews", label: "Ulasan / Testimoni", value: "Kosong & Nonaktif" },
  { key: "phone", label: "Telepon / WhatsApp", value: "Kosong (lengkapi di Pengaturan)" },
  { key: "address", label: "Alamat Jalan", value: "Kosong (lengkapi di Profil Bisnis)" },
] as const;

export function OnboardingAiDraftStep({
  tenantId,
  businessName,
  vertical,
  initialShortDescription = "",
  initialQuota = null,
  initialState = "ready",
  initialDraft = null,
  initialFallbackMessage = null,
  initialFallbackReason = null,
  onDraftComplete,
  onSkip,
}: OnboardingAiDraftStepProps) {
  const [blueprintId, setBlueprintId] = React.useState<B2BBlueprintId>(() =>
    resolveDefaultBlueprintForVertical(vertical),
  );
  const [shortDescription, setShortDescription] = React.useState(initialShortDescription);
  const [phase, setPhase] = React.useState<StepPhase>(initialState);
  const [quota, setQuota] = React.useState<AiWritingQuotaStatus | null>(initialQuota);
  const [generatedDraft, setGeneratedDraft] = React.useState<OnboardingAiDraftTextFields | null>(
    initialDraft,
  );
  const [hadGeneratedOnce, setHadGeneratedOnce] = React.useState<boolean>(
    initialState === "generated",
  );
  const [persistedAsDraft, setPersistedAsDraft] = React.useState<boolean | null>(null);
  const [draftBlueprint, setDraftBlueprint] = React.useState<OnboardingBlueprintDraft | null>(null);
  const [piiError, setPiiError] = React.useState<string | null>(null);
  const [fallbackNotice, setFallbackNotice] = React.useState<{
    readonly reason: string;
    readonly message: string;
  } | null>(
    initialFallbackMessage
      ? {
          reason: initialFallbackReason ?? "AI_PROVIDER_ERROR",
          message: initialFallbackMessage,
        }
      : null,
  );

  const selectedBlueprint = B2B_VERTICAL_BLUEPRINTS[blueprintId];

  async function submitAction(action: "generate" | "skip") {
    setPiiError(null);
    setFallbackNotice(null);
    setPhase("loading");

    try {
      const res = await fetch("/api/onboarding/ai-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({
          tenantId,
          action,
          businessName,
          vertical,
          blueprintId,
          shortDescription: shortDescription.trim(),
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | OnboardingAiDraftApiResponse
        | {
            readonly success?: false;
            readonly code?: string;
            readonly message?: string;
          }
        | null;

      if (res.status === 422 && data && "code" in data && data.code === "AI_PII_DETECTED") {
        setPiiError(
          data.message ??
            "Hapus alamat email, nomor telepon/WhatsApp, atau NIK dari deskripsi singkat sebelum membuat draf AI.",
        );
        setPhase("ready");
        return;
      }

      if (!res.ok || !data || !("status" in data)) {
        setFallbackNotice({
          reason: "AI_PROVIDER_ERROR",
          message:
            (data && "message" in data && typeof data.message === "string"
              ? data.message
              : null) ??
            "Layanan draf AI sedang tidak tersedia. Blueprint standar Anda tetap siap digunakan tanpa hambatan.",
        });
        setPhase("fallback");
        return;
      }

      if (data.quota) {
        setQuota(data.quota);
      }
      setDraftBlueprint(data.blueprint);
      onDraftComplete?.(data);

      if (data.status === "skipped") {
        setGeneratedDraft(null);
        setPhase("skipped");
        onSkip?.();
        return;
      }

      if (data.status === "fallback" || data.fallback) {
        setGeneratedDraft(null);
        setFallbackNotice({
          reason: data.fallbackReason ?? "AI_PROVIDER_ERROR",
          message: data.message,
        });
        setPhase("fallback");
        return;
      }

      setGeneratedDraft(data.draft);
      setPersistedAsDraft(data.persistedAsDraft);
      setHadGeneratedOnce(true);
      setPhase("generated");
    } catch {
      setFallbackNotice({
        reason: "AI_PROVIDER_ERROR",
        message:
          "Koneksi ke layanan draf AI terputus. Blueprint standar Anda tetap utuh dan siap digunakan di dashboard.",
      });
      setPhase("fallback");
    }
  }

  const quotaRemaining = quota?.remaining ?? AI_WRITING_QUOTA_LIMIT;
  const quotaLimit = quota?.limit ?? AI_WRITING_QUOTA_LIMIT;

  return (
    <section
      aria-labelledby="onboarding-ai-draft-heading"
      className="space-y-4 rounded-xl border border-border bg-secondary/25 p-4 sm:p-5"
      data-testid="onboarding-ai-draft-step"
    >
      {/* Header & Quota Metadata */}
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-primary uppercase">
              <PenLineIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Langkah Opsional</span>
            </span>
            <Badge variant="outline" data-testid="onboarding-ai-draft-marker-badge">
              Draf CONTOH · Tidak Terbit Otomatis
            </Badge>
          </div>
          <h2
            id="onboarding-ai-draft-heading"
            className="text-base font-semibold tracking-tight text-foreground sm:text-lg"
          >
            Siapkan draf teks awal dengan AI?
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
            AI mengisi <strong>hanya kolom teks</strong> pada blueprint pilihan Anda berdasarkan 3
            jawaban onboarding dan menandainya sebagai <strong>CONTOH</strong>. Anda dapat langsung
            melewati langkah ini.
          </p>
        </div>

        <Badge
          variant={quotaRemaining > 0 ? "secondary" : "warning"}
          className="shrink-0 tabular-nums"
          data-testid="onboarding-ai-quota-badge"
        >
          Kuota AI 30 hari: {quotaRemaining}/{quotaLimit}
        </Badge>
      </div>

      {/* Skipped State */}
      {phase === "skipped" && (
        <div
          className="space-y-3 rounded-lg border border-border bg-card p-4"
          data-testid="onboarding-ai-draft-skipped"
        >
          <div className="flex items-start gap-2.5">
            <SkipForwardIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-foreground">
                {hadGeneratedOnce
                  ? "Pratinjau draf AI disembunyikan"
                  : "Langkah draf AI dilewati — blueprint polos tetap utuh"}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {hadGeneratedOnce
                  ? "Anda tetap dapat menggunakan atau mengganti blueprint standar di dashboard. Penggunaan 1 slot kuota AI dari pratinjau sebelumnya tetap tercatat."
                  : "Tidak ada teks yang diubah dan kuota AI bulanan Anda tidak terpotong. Anda bisa langsung masuk ke dashboard untuk menyunting situs kapan saja."}
              </p>
            </div>
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 text-xs font-medium md:min-h-9"
              onClick={() => setPhase("ready")}
              data-testid="onboarding-ai-draft-reopen"
            >
              Ingin mencoba buat draf AI sekarang?
            </Button>
          </div>
        </div>
      )}

      {/* Fallback State (Quota Exhausted / Provider Error / Timeout / Invalid Output) */}
      {phase === "fallback" && fallbackNotice && (
        <Alert
          variant="warning"
          data-testid="onboarding-ai-draft-fallback"
          data-fallback-reason={fallbackNotice.reason}
          aria-live="polite"
        >
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Menggunakan blueprint standar tanpa hambatan</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{fallbackNotice.message}</p>
            <p className="text-xs text-muted-foreground">
              Situs Anda sudah aktif dan blueprint bawaan siap disunting langsung di dashboard.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Generated CONTOH Preview State */}
      {phase === "generated" && generatedDraft && (
        <div
          className="space-y-4 rounded-lg border border-primary/30 bg-card p-4"
          data-testid="onboarding-ai-draft-preview"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-primary">
              <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="text-sm font-semibold text-foreground">
                Pratinjau Draf Teks AI ({selectedBlueprint.name})
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="warning" data-testid="onboarding-ai-draft-status-badge">
                CONTOH · Draf Belum Diterbitkan
              </Badge>
            </div>
          </div>

          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-border bg-secondary/30 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Bagian Hero (Hanya Teks)
                </span>
                <Badge variant="outline">CONTOH</Badge>
              </div>
              <p className="text-xs font-medium text-primary" data-testid="draft-hero-eyebrow">
                {generatedDraft.heroEyebrow}
              </p>
              <p
                className="mt-1 text-base font-semibold leading-snug text-foreground"
                data-testid="draft-hero-headline"
              >
                {generatedDraft.heroHeadline}
              </p>
              <p
                className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm"
                data-testid="draft-hero-subheadline"
              >
                {generatedDraft.heroSubheadline}
              </p>
              <div className="mt-2 inline-flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground">
                <span className="text-muted-foreground">Tombol CTA:</span>
                <span className="font-semibold" data-testid="draft-hero-cta">
                  {generatedDraft.heroCtaLabel}
                </span>
              </div>
            </div>

            <div className="rounded-md border border-border bg-secondary/30 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Tentang Usaha
                </span>
                <Badge variant="outline">CONTOH</Badge>
              </div>
              <p className="text-sm font-semibold text-foreground" data-testid="draft-about-heading">
                {generatedDraft.aboutHeading}
              </p>
              <p
                className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm"
                data-testid="draft-about-summary"
              >
                {generatedDraft.aboutSummary}
              </p>
            </div>

            {generatedDraft.serviceSummaries.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Ringkasan Penawaran (Draf Teks)
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {generatedDraft.serviceSummaries.map((item, idx) => (
                    <div
                      key={`${item.title}-${idx}`}
                      className="rounded-md border border-border bg-secondary/20 p-2.5"
                      data-testid={`draft-service-item-${idx}`}
                    >
                      <p className="text-xs font-semibold text-foreground">{item.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Explicit Empty Facts Verification Box */}
          <div
            className="space-y-2 rounded-md border border-border bg-muted/40 p-3"
            data-testid="onboarding-ai-draft-facts-empty"
          >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <ShieldCheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>Kolom fakta tetap kosong (tidak pernah dikarang AI)</span>
            </p>
            <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
              {EMPTY_FACT_ITEMS.map((fact) => (
                <div key={fact.key} className="flex flex-col">
                  <dt className="font-medium text-foreground">{fact.label}</dt>
                  <dd className="text-muted-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {persistedAsDraft === false
                ? "Pratinjau CONTOH saja — draf beranda Anda yang sudah ada tidak ditimpa"
                : draftBlueprint
                  ? `Status blueprint: ${draftBlueprint.status.toUpperCase()} (belum diterbitkan)`
                  : "Status blueprint: DRAFT (belum diterbitkan)"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 text-xs font-medium md:min-h-8"
              onClick={() => void submitAction("skip")}
              data-testid="onboarding-ai-draft-revert-plain"
            >
              Sembunyikan Pratinjau AI
            </Button>
          </div>
        </div>
      )}

      {/* Ready / Loading Input Form */}
      {(phase === "ready" || phase === "loading") && (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          {/* Summary of Answers 1 & 2 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                1. Nama Bisnis
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
                {businessName}
              </p>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="onboarding-ai-blueprint"
                className="block text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
              >
                2. Blueprint Pilihan
              </label>
              <select
                id="onboarding-ai-blueprint"
                value={blueprintId}
                disabled={phase === "loading"}
                onChange={(e) => setBlueprintId(e.target.value as B2BBlueprintId)}
                data-testid="onboarding-ai-blueprint-select"
                className="min-h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9 md:text-sm"
              >
                {B2B_BLUEPRINT_CATALOG.map((bp) => (
                  <option key={bp.id} value={bp.id}>
                    {bp.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Answer 3: Optional short description */}
          <div className="space-y-1.5">
            <label
              htmlFor="onboarding-ai-short-desc"
              className="block text-sm font-medium text-foreground"
            >
              3. Ceritakan singkat usaha atau layanan utama Anda{" "}
              <span className="font-normal text-muted-foreground">(opsional)</span>
            </label>
            <textarea
              id="onboarding-ai-short-desc"
              rows={3}
              maxLength={ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS}
              value={shortDescription}
              disabled={phase === "loading"}
              onChange={(e) => {
                setShortDescription(e.target.value);
                if (piiError) setPiiError(null);
              }}
              placeholder="Contoh: Layanan desain interior kantor dan ruang usaha modern untuk klien perusahaan di Jabodetabek."
              data-testid="onboarding-ai-short-desc"
              aria-describedby="onboarding-ai-short-desc-hint"
              className="min-h-24 w-full rounded-md border border-input bg-card p-3 text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 md:text-sm"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span id="onboarding-ai-short-desc-hint">
                Jangan sertakan email, nomor HP/WhatsApp, NIK, atau harga rahasia.
              </span>
              <span className="tabular-nums">
                {shortDescription.length}/{ONBOARDING_AI_DRAFT_MAX_SHORT_DESCRIPTION_CHARS}
              </span>
            </div>
          </div>

          {/* PII Blocker Error */}
          {piiError && (
            <Alert variant="destructive" data-testid="onboarding-ai-draft-pii-error" role="alert">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Data pribadi terdeteksi pada teks</AlertTitle>
              <AlertDescription>{piiError}</AlertDescription>
            </Alert>
          )}

          {/* Non-Fact & Unpublished Disclosure */}
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <p className="leading-relaxed">
              Setiap kolom hasil AI otomatis bertanda <strong className="text-foreground">CONTOH</strong>{" "}
              dan disimpan sebagai <strong className="text-foreground">draf</strong>. Harga, nomor
              izin, ulasan, nomor telepon/WhatsApp, dan alamat jalan tidak pernah diisi oleh AI.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <Button
              type="button"
              variant="default"
              disabled={phase === "loading"}
              onClick={() => void submitAction("generate")}
              className="min-h-11 flex-1 gap-2 text-sm font-semibold focus-visible:outline-solid"
              data-testid="onboarding-ai-draft-generate"
            >
              {phase === "loading" ? (
                <RefreshCwIcon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <FileEditIcon className="size-4" aria-hidden="true" />
              )}
              <span>
                {phase === "loading"
                  ? "Menyiapkan Draf Teks CONTOH..."
                  : "Buat Draf Teks AI (CONTOH)"}
              </span>
            </Button>

            <Button
              type="button"
              variant="outline"
              disabled={phase === "loading"}
              onClick={() => void submitAction("skip")}
              className="min-h-11 gap-2 text-sm font-medium focus-visible:outline-solid sm:w-auto"
              data-testid="onboarding-ai-draft-skip"
            >
              <SkipForwardIcon className="size-4" aria-hidden="true" />
              <span>Lewati — Blueprint Polos</span>
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
