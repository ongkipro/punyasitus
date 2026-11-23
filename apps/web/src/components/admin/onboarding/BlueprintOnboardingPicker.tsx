import * as React from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileTextIcon,
  LayoutGridIcon,
  MessageCircleIcon,
  ShieldCheckIcon,
} from "lucide-react";
import {
  applyVerticalBlueprint,
  B2B_BLUEPRINT_CATALOG,
  B2B_VERTICAL_BLUEPRINTS,
  type AppliedVerticalBlueprint,
  type B2BBlueprintId,
  type RegulatedProfessionalSubtype,
} from "@punyasitus/core/presets/blueprints";
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

export interface BlueprintOnboardingPickerProps {
  readonly defaultBusinessName?: string;
  readonly defaultBlueprintId?: B2BBlueprintId;
  /** Leave empty by default — never pre-fill a stranger's phone number. */
  readonly defaultWhatsAppPhone?: string;
  readonly defaultRegulatedSubtype?: RegulatedProfessionalSubtype;
  readonly tenantHandle?: string;
  readonly onApplyBlueprint?: (applied: AppliedVerticalBlueprint) => void;
}

const REGULATED_SUBTYPE_OPTIONS: readonly {
  readonly id: RegulatedProfessionalSubtype;
  readonly label: string;
}[] = [
  { id: "medical_clinic", label: "Klinik / Praktik Dokter (SIP/STR)" },
  { id: "legal_notary", label: "Kantor Hukum / Advokat / Notaris-PPAT" },
  { id: "tax_accounting", label: "Kantor Akuntan / Konsultan Pajak" },
];

function formatFriendlyValidationError(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err && Array.isArray(err.issues)) {
    const messages = (err.issues as readonly { readonly message?: unknown }[])
      .map((issue) => (typeof issue.message === "string" ? issue.message.trim() : ""))
      .filter(Boolean);
    if (messages.length > 0) {
      return Array.from(new Set(messages)).join(". ");
    }
  }
  if (err instanceof Error && err.message && !err.message.trim().startsWith("[")) {
    return err.message;
  }
  return "Periksa kembali nama usaha, pilihan model bisnis, dan format nomor WhatsApp Indonesia Anda.";
}

export function BlueprintOnboardingPicker({
  defaultBusinessName = "",
  defaultBlueprintId = "b2b_corporate",
  defaultWhatsAppPhone = "",
  defaultRegulatedSubtype = "medical_clinic",
  tenantHandle = "situs-anda",
  onApplyBlueprint,
}: BlueprintOnboardingPickerProps) {
  const [businessName, setBusinessName] = React.useState(defaultBusinessName);
  const [blueprintId, setBlueprintId] = React.useState<B2BBlueprintId>(defaultBlueprintId);
  const [regulatedSubtype, setRegulatedSubtype] =
    React.useState<RegulatedProfessionalSubtype>(defaultRegulatedSubtype);
  const [whatsappPhone, setWhatsappPhone] = React.useState(defaultWhatsAppPhone);
  const [appliedNotice, setAppliedNotice] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const selectedBlueprint = B2B_VERTICAL_BLUEPRINTS[blueprintId];

  const previewResult = React.useMemo(() => {
    const trimmedWa = whatsappPhone.trim();
    if (!trimmedWa) return null;
    try {
      return applyVerticalBlueprint({
        businessName: businessName.trim() || "Usaha Anda",
        blueprintId,
        whatsappPhone: trimmedWa,
        ...(blueprintId === "regulated_professional" ? { regulatedSubtype } : {}),
        handle: tenantHandle,
      });
    } catch {
      return null;
    }
  }, [businessName, blueprintId, regulatedSubtype, whatsappPhone, tenantHandle]);

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setAppliedNotice(null);

    try {
      const applied = applyVerticalBlueprint({
        businessName,
        blueprintId,
        whatsappPhone,
        ...(blueprintId === "regulated_professional" ? { regulatedSubtype } : {}),
        handle: tenantHandle,
      });
      onApplyBlueprint?.(applied);
      setAppliedNotice(
        `Blueprint "${applied.blueprint.name}" siap diterapkan (tema ${applied.recommendedThemeId}, menu sidebar "${applied.sidebarOffering.primaryMenuLabel}", ${applied.sections.length} bagian draf). Konten yang sudah ada tetap aman.`,
      );
    } catch (err) {
      setFormError(formatFriendlyValidationError(err));
    }
  };

  return (
    <Card data-testid="blueprint-onboarding-picker">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2">
          <LayoutGridIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>Pengaturan Cepat 3 Langkah (Blueprint Vertikal B2B)</span>
        </CardTitle>
        <CardDescription>
          Isi nama usaha, pilih model bisnis, dan masukkan WhatsApp utama. Sistem langsung
          menyiapkan tema, urutan bagian, menu sidebar adaptif, formulir awal, dan 3 kerangka
          artikel draf tanpa menghapus konten yang sudah Anda tulis.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="space-y-6 pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="onboarding-business-name"
                className="block text-sm font-medium text-foreground"
              >
                1. Nama Usaha atau Nama Personal
              </label>
              <Input
                id="onboarding-business-name"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Contoh: PT Karya Kemas Nusantara"
                required
                data-testid="onboarding-input-business-name"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="onboarding-whatsapp"
                className="block text-sm font-medium text-foreground"
              >
                3. Nomor WhatsApp Utama
              </label>
              <Input
                id="onboarding-whatsapp"
                type="tel"
                value={whatsappPhone}
                onChange={(e) => setWhatsappPhone(e.target.value)}
                placeholder="Contoh: 081234567890"
                required
                data-testid="onboarding-input-whatsapp"
              />
            </div>
          </div>

          <fieldset className="space-y-2.5">
            <legend className="text-sm font-medium text-foreground">
              2. Pilih Model Usaha (7 Blueprint Siap Pakai)
            </legend>
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
              {B2B_BLUEPRINT_CATALOG.map((bp) => {
                const selected = bp.id === blueprintId;
                return (
                  <button
                    key={bp.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setBlueprintId(bp.id);
                      setAppliedNotice(null);
                    }}
                    data-testid={`blueprint-option-${bp.id}`}
                    className={
                      selected
                        ? "flex min-h-11 flex-col gap-1.5 rounded-lg border-2 border-primary bg-primary/5 p-3 text-left transition-colors"
                        : "flex min-h-11 flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted/60"
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="text-sm font-semibold text-foreground">{bp.name}</span>
                      <Badge variant={selected ? "default" : "outline"}>{bp.defaultThemeId}</Badge>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {bp.targetSegment}
                    </p>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {blueprintId === "regulated_professional" && (
            <fieldset className="space-y-2 rounded-lg border border-border bg-card p-3.5">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Bidang Profesi Teregulasi
              </legend>
              <div className="flex flex-wrap gap-2">
                {REGULATED_SUBTYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={regulatedSubtype === opt.id}
                    onClick={() => setRegulatedSubtype(opt.id)}
                    data-testid={`regulated-subtype-${opt.id}`}
                    className={
                      regulatedSubtype === opt.id
                        ? "min-h-11 rounded-md border-2 border-primary bg-primary/5 px-3 py-1.5 text-xs font-semibold text-foreground md:min-h-8"
                        : "min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted md:min-h-8"
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <div
            className="space-y-4 rounded-lg border border-border bg-muted/40 p-4"
            data-testid="blueprint-preview-summary"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h3 className="text-sm font-semibold text-foreground">
                  Ringkasan Blueprint: {selectedBlueprint.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {selectedBlueprint.shortDescription}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">Tema: {selectedBlueprint.defaultThemeId}</Badge>
                <Badge variant="outline">
                  Sidebar: {selectedBlueprint.sidebarOffering.primaryMenuLabel}
                </Badge>
                <Badge variant="warning">Draf CONTOH</Badge>
              </div>
            </div>

            {selectedBlueprint.testimonialsDefaultOff && (
              <Alert variant="warning" data-testid="blueprint-regulated-warning">
                <AlertTriangleIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Pengaman Profesi Teregulasi Aktif</AlertTitle>
                <AlertDescription>
                  Bagian testimoni dan AggregateRating dinonaktifkan otomatis sesuai Permenkes dan
                  kode etik profesi. Formulir janji temu menampilkan pemberitahuan data sensitif UU
                  PDP.
                </AlertDescription>
              </Alert>
            )}

            <Separator />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <ShieldCheckIcon className="size-3.5 text-primary" aria-hidden="true" />
                  <span>Kredensial Opsional &amp; Pesan WhatsApp</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedBlueprint.credentialGuidanceNote}
                </p>
                {previewResult && (
                  <div className="flex flex-wrap gap-1.5">
                    {previewResult.credentialPrompts.map((cred) => (
                      <Badge key={cred.key} variant="outline">
                        {cred.schemaPropertyId}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="rounded-md border border-border bg-card p-2.5 text-xs text-foreground">
                  <span className="mb-1 inline-flex items-center gap-1 font-medium text-primary">
                    <MessageCircleIcon className="size-3.5" aria-hidden="true" />
                    Template WhatsApp:
                  </span>
                  <p className="text-muted-foreground">
                    {previewResult
                      ? previewResult.whatsappMessagePreview
                      : "Masukkan nomor WhatsApp Anda di atas untuk melihat pratinjau pesan otomatis."}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <FileTextIcon className="size-3.5 text-primary" aria-hidden="true" />
                  <span>3 Kerangka Artikel Draf (Tidak Terbit Otomatis)</span>
                </p>
                <ul className="space-y-1.5">
                  {selectedBlueprint.draftBlogOutlines.map((post) => (
                    <li
                      key={post.slug}
                      className="flex items-start justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs"
                    >
                      <span className="font-medium text-foreground">{post.title}</span>
                      <Badge variant="outline" className="shrink-0">
                        {post.sampleBadge}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {formError && (
            <Alert variant="destructive" data-testid="blueprint-form-error">
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Periksa data onboarding</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          {appliedNotice && (
            <Alert variant="success" data-testid="blueprint-applied-notice">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              <AlertTitle>Blueprint siap digunakan</AlertTitle>
              <AlertDescription>{appliedNotice}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Mengganti atau meninjau blueprint tidak pernah menghapus halaman atau konten milik Anda.
          </p>
          <Button
            type="submit"
            className="min-h-11 md:min-h-9"
            data-testid="blueprint-apply-button"
          >
            Terapkan Blueprint Draf
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
