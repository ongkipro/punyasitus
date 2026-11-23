import { useState } from "react";
import {
  AFTER_SUBMIT_ACTION_LABELS_ID,
  AFTER_SUBMIT_ACTIONS,
  CHOICE_FIELD_TYPES,
  CLOSED_FORM_FIELD_TYPES,
  DEFAULT_CONFIRMATION_MESSAGE_ID,
  DEFAULT_SUBMIT_LABEL_ID,
  FORM_FIELD_TYPE_LABELS_ID,
  MAX_FIELDS_PER_FORM,
  type AfterSubmitAction,
  type CustomFormField,
  type CustomFormFieldType,
  type FormVerticalTemplate,
} from "@punyasitus/core/forms/index";
import type { TenantFormComplianceContext, TenantFormRecord } from "@punyasitus/db/forms/index";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface FormBuilderInitialState {
  readonly id: number | null;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly templateKey: string | null;
  readonly fields: readonly CustomFormField[];
  readonly afterSubmitAction: AfterSubmitAction;
  readonly afterSubmitConfig: {
    readonly message: string;
    readonly whatsappPhoneOverride: string;
    readonly whatsappIntro: string;
    readonly redirectUrl: string;
  };
  readonly isPublished: boolean;
  readonly publishedVersion: number;
  readonly hasUnpublishedChanges: boolean;
  readonly active: boolean;
  readonly version: number;
}

export interface FormBuilderClientProps {
  readonly handle: string;
  readonly basePath: string;
  readonly canWrite: boolean;
  readonly canPublish: boolean;
  readonly isLocked: boolean;
  readonly compliance: TenantFormComplianceContext;
  readonly templates: readonly FormVerticalTemplate[];
  readonly initialForm: FormBuilderInitialState;
}

function slugifyIndonesian(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function keyifyFieldLabel(raw: string, fallbackIdx: number): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!cleaned || !/^[a-z]/.test(cleaned)) {
    return `field_${fallbackIdx}`;
  }
  return cleaned;
}

function createEmptyField(index: number, existingKeys: ReadonlySet<string>): CustomFormField {
  let seq = index + 1;
  let key = `pertanyaan_${seq}`;
  while (existingKeys.has(key)) {
    seq += 1;
    key = `pertanyaan_${seq}`;
  }
  return {
    key,
    type: "short_text",
    label: `Pertanyaan ${seq}`,
    required: false,
    placeholder: "",
    helpText: "",
    condition: null,
  };
}

export function FormBuilderClient({
  handle,
  basePath,
  canWrite,
  canPublish,
  isLocked,
  compliance,
  templates,
  initialForm,
}: FormBuilderClientProps) {
  const [formId, setFormId] = useState<number | null>(initialForm.id);
  const [version, setVersion] = useState<number>(initialForm.version);
  const [isPublished, setIsPublished] = useState<boolean>(initialForm.isPublished);
  const [publishedVersion, setPublishedVersion] = useState<number>(initialForm.publishedVersion);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState<boolean>(
    initialForm.hasUnpublishedChanges,
  );
  const [active, setActive] = useState<boolean>(initialForm.active);

  const [name, setName] = useState<string>(initialForm.name);
  const [slug, setSlug] = useState<string>(initialForm.slug);
  const [slugTouched, setSlugTouched] = useState<boolean>(Boolean(initialForm.slug));
  const [description, setDescription] = useState<string>(initialForm.description);
  const [submitLabel, setSubmitLabel] = useState<string>(
    initialForm.submitLabel || DEFAULT_SUBMIT_LABEL_ID,
  );
  const [templateKey, setTemplateKey] = useState<string | null>(initialForm.templateKey);
  const [fields, setFields] = useState<readonly CustomFormField[]>(initialForm.fields);

  const [afterSubmitAction, setAfterSubmitAction] = useState<AfterSubmitAction>(
    initialForm.afterSubmitAction,
  );
  const [afterMessage, setAfterMessage] = useState<string>(
    initialForm.afterSubmitConfig.message || DEFAULT_CONFIRMATION_MESSAGE_ID,
  );
  const [whatsappPhoneOverride, setWhatsappPhoneOverride] = useState<string>(
    initialForm.afterSubmitConfig.whatsappPhoneOverride,
  );
  const [whatsappIntro, setWhatsappIntro] = useState<string>(
    initialForm.afterSubmitConfig.whatsappIntro,
  );
  const [redirectUrl, setRedirectUrl] = useState<string>(
    initialForm.afterSubmitConfig.redirectUrl,
  );

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [publishing, setPublishing] = useState<boolean>(false);
  const [staleConflict, setStaleConflict] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly { field: string; message: string }[]>([]);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const readOnly = !canWrite || isLocked;

  function applyTemplate(tpl: FormVerticalTemplate) {
    if (readOnly) return;
    setName(tpl.defaultName);
    if (!formId) {
      setSlug(tpl.defaultSlug);
      setSlugTouched(true);
    }
    setDescription(tpl.defaultDescription);
    setSubmitLabel(tpl.submitLabel);
    setTemplateKey(tpl.key);
    setFields(tpl.fields.map((f) => ({ ...f })));
    setAfterSubmitAction(tpl.afterSubmitAction);
    setAfterMessage(tpl.afterSubmitConfig.message);
    setWhatsappPhoneOverride(tpl.afterSubmitConfig.whatsappPhoneOverride ?? "");
    setWhatsappIntro(tpl.afterSubmitConfig.whatsappIntro ?? "");
    setRedirectUrl(tpl.afterSubmitConfig.redirectUrl ?? "");
    setSuccessBanner(`Template "${tpl.label}" diterapkan ke draf editor.`);
    setErrorBanner(null);
    setFieldErrors([]);
  }

  function addField() {
    if (readOnly || fields.length >= MAX_FIELDS_PER_FORM) return;
    setFields((prev) => {
      const existing = new Set(prev.map((f) => f.key));
      return [...prev, createEmptyField(prev.length, existing)];
    });
  }

  function updateField(index: number, patch: Partial<CustomFormField>) {
    if (readOnly) return;
    setFields((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) return item;
        const next: CustomFormField = { ...item, ...patch };
        if (patch.type && patch.type !== item.type) {
          if (CHOICE_FIELD_TYPES.has(patch.type)) {
            return {
              ...next,
              options:
                item.options && item.options.length >= 2
                  ? item.options
                  : ["Pilihan 1", "Pilihan 2"],
              min: undefined,
              max: undefined,
            };
          }
          if (patch.type === "number") {
            return { ...next, options: undefined };
          }
          return { ...next, options: undefined, min: undefined, max: undefined };
        }
        return next;
      }),
    );
  }

  function moveField(index: number, delta: -1 | 1) {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    setFields((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      if (moved) copy.splice(target, 0, moved);
      return copy;
    });
  }

  function removeField(index: number) {
    if (readOnly || fields.length <= 1) return;
    const removedKey = fields[index]?.key;
    setFields((prev) =>
      prev
        .filter((_, idx) => idx !== index)
        .map((f) => (f.condition?.fieldKey === removedKey ? { ...f, condition: null } : f)),
    );
  }

  function updateFieldOptionsText(index: number, rawLines: string) {
    const opts = rawLines
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    updateField(index, { options: opts });
  }

  function buildRequestPayload() {
    const cleanedFields = fields.map((f, idx) => {
      const key = f.key.trim() || keyifyFieldLabel(f.label, idx + 1);
      const isChoice = CHOICE_FIELD_TYPES.has(f.type);
      return {
        key,
        type: f.type,
        label: f.label.trim(),
        required: f.required,
        placeholder: f.placeholder?.trim() ? f.placeholder.trim() : null,
        helpText: f.helpText?.trim() ? f.helpText.trim() : null,
        ...(isChoice ? { options: f.options ?? [] } : {}),
        ...(f.type === "number" && typeof f.min === "number" ? { min: f.min } : {}),
        ...(f.type === "number" && typeof f.max === "number" ? { max: f.max } : {}),
        condition: f.condition
          ? {
              fieldKey: f.condition.fieldKey.trim(),
              equalsValue: f.condition.equalsValue.trim(),
            }
          : null,
      };
    });

    return {
      slug: (slug.trim() || slugifyIndonesian(name) || "formulir").toLowerCase(),
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      submitLabel: submitLabel.trim() || DEFAULT_SUBMIT_LABEL_ID,
      templateKey,
      fields: cleanedFields,
      afterSubmitAction,
      afterSubmitConfig: {
        message: afterMessage.trim() || DEFAULT_CONFIRMATION_MESSAGE_ID,
        whatsappPhoneOverride: whatsappPhoneOverride.trim() || null,
        whatsappIntro: whatsappIntro.trim() || null,
        redirectUrl: redirectUrl.trim() || null,
      },
      active,
    };
  }

  function applyServerFormRecord(saved: TenantFormRecord) {
    setFormId(saved.id);
    setVersion(saved.version);
    setSlug(saved.slug);
    setName(saved.name);
    setDescription(saved.description ?? "");
    setSubmitLabel(saved.submitLabel);
    setTemplateKey(saved.templateKey);
    setFields(saved.fields);
    setAfterSubmitAction(saved.afterSubmitAction);
    setAfterMessage(saved.afterSubmitConfig.message);
    setWhatsappPhoneOverride(saved.afterSubmitConfig.whatsappPhoneOverride ?? "");
    setWhatsappIntro(saved.afterSubmitConfig.whatsappIntro ?? "");
    setRedirectUrl(saved.afterSubmitConfig.redirectUrl ?? "");
    setIsPublished(saved.isPublished);
    setPublishedVersion(saved.publishedVersion);
    setHasUnpublishedChanges(saved.hasUnpublishedChanges);
    setActive(saved.active);
  }

  async function saveDraft(): Promise<TenantFormRecord | null> {
    if (readOnly || submitting) return null;
    setSubmitting(true);
    setErrorBanner(null);
    setSuccessBanner(null);
    setStaleConflict(null);
    setFieldErrors([]);

    try {
      const payload = buildRequestPayload();
      const isCreate = formId === null;
      const endpoint = isCreate
        ? `/api/tenants/${encodeURIComponent(handle)}/forms`
        : `/api/tenants/${encodeURIComponent(handle)}/forms/${formId}`;
      const body = isCreate ? payload : { ...payload, expectedVersion: version };

      const res = await fetch(endpoint, {
        method: isCreate ? "POST" : "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => null)) as {
        form?: TenantFormRecord;
        error?: {
          code?: string;
          message?: string;
          fields?: { field: string; message: string }[];
        };
      } | null;

      if (res.status === 409 && data?.error?.code === "STALE_VERSION") {
        setStaleConflict(
          data.error.message ??
            "Formulir telah diubah di sesi lain. Muat ulang versi terbaru sebelum menyimpan.",
        );
        return null;
      }

      if (!res.ok || !data?.form) {
        setErrorBanner(data?.error?.message ?? "Gagal menyimpan draf formulir.");
        setFieldErrors(data?.error?.fields ?? []);
        return null;
      }

      applyServerFormRecord(data.form);
      if (isCreate && typeof window !== "undefined") {
        window.history.replaceState(null, "", `${basePath}/forms/${data.form.id}`);
      }
      setSuccessBanner("Draf formulir berhasil disimpan.");
      return data.form;
    } catch {
      setErrorBanner("Koneksi terganggu saat menyimpan formulir.");
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePublishAction(action: "publish" | "unpublish") {
    if (!canPublish || isLocked || publishing || submitting) return;
    setErrorBanner(null);
    setSuccessBanner(null);
    setStaleConflict(null);
    setFieldErrors([]);

    let targetFormId = formId;
    let targetVersion = version;

    // Save unsaved draft first when publishing
    if (action === "publish") {
      const saved = await saveDraft();
      if (!saved) return;
      targetFormId = saved.id;
      targetVersion = saved.version;
    }

    if (!targetFormId) return;

    setPublishing(true);
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(handle)}/forms/${targetFormId}/publish`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify({ expectedVersion: targetVersion, action }),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        form?: TenantFormRecord;
        error?: {
          code?: string;
          message?: string;
          fields?: { field: string; message: string }[];
        };
      } | null;

      if (res.status === 409 && data?.error?.code === "STALE_VERSION") {
        setStaleConflict(
          data.error.message ??
            "Versi formulir sudah berubah. Muat ulang sebelum menerbitkan.",
        );
        return;
      }

      if (!res.ok || !data?.form) {
        setErrorBanner(data?.error?.message ?? "Gagal memproses penerbitan formulir.");
        setFieldErrors(data?.error?.fields ?? []);
        return;
      }

      applyServerFormRecord(data.form);
      setSuccessBanner(
        action === "publish"
          ? `Formulir "${data.form.name}" berhasil diterbitkan (v${data.form.publishedVersion}).`
          : `Formulir "${data.form.name}" telah dinonaktifkan.`,
      );
    } catch {
      setErrorBanner("Koneksi terganggu saat memproses penerbitan formulir.");
    } finally {
      setPublishing(false);
    }
  }

  async function reloadLatest() {
    if (!formId) return;
    setStaleConflict(null);
    setErrorBanner(null);
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(handle)}/forms/${formId}`,
        { headers: { Accept: "application/json" }, credentials: "same-origin" },
      );
      const data = (await res.json().catch(() => null)) as { form?: TenantFormRecord } | null;
      if (res.ok && data?.form) {
        applyServerFormRecord(data.form);
        setSuccessBanner("Data formulir terbaru telah dimuat ulang.");
      }
    } catch {
      setErrorBanner("Gagal memuat ulang data terbaru.");
    }
  }

  // Unconditional eligible fields for strict 1-level condition dropdown
  const eligibleConditionTargets = fields.filter(
    (f) => !f.condition && f.type !== "long_text" && f.key.trim().length > 0,
  );

  return (
    <div className="space-y-6 pb-16" data-testid="form-builder-root">
      {/* Top breadcrumb & actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              render={<a href={`${basePath}/forms`} />}
              className="min-h-10 sm:min-h-8 -ml-2"
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              Kembali ke Daftar Formulir
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
              {formId ? "Ubah Formulir Kustom" : "Buat Formulir Kustom"}
            </h1>
            {isPublished ? (
              <Badge className="bg-emerald-700 text-white" data-testid="form-status-badge">
                Terbit v{publishedVersion}
              </Badge>
            ) : (
              <Badge variant="outline" data-testid="form-status-badge">
                Draf
              </Badge>
            )}
            <Badge variant="outline" className="tabular-nums" data-testid="fields-count-badge">
              {fields.length} / {MAX_FIELDS_PER_FORM} field
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              disabled={submitting || publishing}
              onClick={() => void saveDraft()}
              className="min-h-11 sm:min-h-9"
              data-testid="save-form-draft-btn"
            >
              <SaveIcon className="size-4" aria-hidden="true" />
              {submitting ? "Menyimpan..." : "Simpan Draf"}
            </Button>
          )}

          {canPublish && !isLocked && (
            <Button
              type="button"
              disabled={submitting || publishing}
              onClick={() => void handlePublishAction("publish")}
              className="min-h-11 sm:min-h-9"
              data-testid="publish-form-btn"
            >
              <GlobeIcon className="size-4" aria-hidden="true" />
              {publishing ? "Menerbitkan..." : isPublished ? "Terbitkan Pembaruan" : "Terbitkan Formulir"}
            </Button>
          )}

          {canPublish && !isLocked && formId && isPublished && (
            <Button
              type="button"
              variant="destructive"
              disabled={submitting || publishing}
              onClick={() => void handlePublishAction("unpublish")}
              className="min-h-11 sm:min-h-9"
              data-testid="unpublish-form-btn"
            >
              Nonaktifkan
            </Button>
          )}
        </div>
      </div>

      {/* Compliance & Stale Version Alerts */}
      {!compliance.privacyContactConfigured && (
        <Alert
          className="border-amber-300 bg-amber-50 text-amber-950"
          data-testid="privacy-contact-missing-warning"
        >
          <AlertTriangleIcon className="size-4 text-amber-700" aria-hidden="true" />
          <AlertTitle>Kontak Privasi Wajib Diisi Sebelum Terbit</AlertTitle>
          <AlertDescription className="space-y-1.5">
            <p>
              Sesuai UU PDP, formulir belum bisa diterbitkan selama{" "}
              <strong>Kontak Privasi</strong> pada Profil Bisnis masih kosong.
            </p>
            <a
              href={`${basePath}/settings/profil`}
              className="inline-block text-sm font-medium underline underline-offset-2"
            >
              Buka Pengaturan Profil Bisnis
            </a>
          </AlertDescription>
        </Alert>
      )}

      {compliance.isHealthCategory && compliance.healthWarningMessage && (
        <Alert
          className="border-amber-400 bg-amber-50 text-amber-950"
          data-testid="uupdp-health-warning"
        >
          <ShieldAlertIcon className="size-4 text-amber-700" aria-hidden="true" />
          <AlertTitle>Peringatan UU PDP — Kategori Usaha Kesehatan</AlertTitle>
          <AlertDescription>{compliance.healthWarningMessage}</AlertDescription>
        </Alert>
      )}

      {staleConflict && (
        <Alert variant="destructive" role="alert" data-testid="form-stale-conflict">
          <AlertTitle>Konflik Versi Data (409)</AlertTitle>
          <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{staleConflict}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void reloadLatest()}>
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              Muat Ulang Versi Terbaru
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {errorBanner && (
        <Alert variant="destructive" role="alert" data-testid="form-builder-error">
          <AlertTitle>Periksa Konfigurasi Formulir</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{errorBanner}</p>
            {fieldErrors.length > 0 && (
              <ul className="list-disc pl-5 text-xs space-y-0.5">
                {fieldErrors.map((fe, idx) => (
                  <li key={`${fe.field}-${idx}`}>
                    <span className="font-mono">{fe.field}</span>: {fe.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {successBanner && (
        <Alert
          className="border-emerald-300 bg-emerald-50 text-emerald-950"
          role="status"
          data-testid="form-builder-success"
        >
          <CheckCircle2Icon className="size-4 text-emerald-700" aria-hidden="true" />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{successBanner}</AlertDescription>
        </Alert>
      )}

      {isPublished && hasUnpublishedChanges && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950">
          <AlertTitle>Perubahan Draf Belum Diterbitkan</AlertTitle>
          <AlertDescription>
            Pengunjung situs masih melihat formulir versi terbit (v{publishedVersion}). Klik{" "}
            <strong>Terbitkan Pembaruan</strong> agar perubahan ini aktif. Riwayat pesan masuk
            sebelumnya tetap utuh.
          </AlertDescription>
        </Alert>
      )}

      {/* Starter templates switcher (for new forms) */}
      {!formId && !readOnly && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Mulai dari Template Vertikal (Opsional)</CardTitle>
            <CardDescription className="text-xs">
              Isi cepat struktur field sesuai jenis bisnis Anda.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {templates.map((tpl) => (
              <Button
                key={tpl.key}
                type="button"
                variant={templateKey === tpl.key ? "default" : "outline"}
                size="sm"
                onClick={() => applyTemplate(tpl)}
                className="min-h-10 sm:min-h-8"
                data-testid={`apply-template-${tpl.key}`}
              >
                {tpl.label}
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Form Metadata */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identitas Formulir</CardTitle>
          <CardDescription className="text-xs">
            Nama, slug unik untuk penempatan di halaman/penawaran, dan deskripsi singkat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="form-name-input" className="text-sm font-medium text-foreground">
                Nama Formulir <span className="text-destructive">*</span>
              </label>
              <Input
                id="form-name-input"
                value={name}
                disabled={readOnly}
                maxLength={100}
                placeholder="Contoh: Permintaan Penawaran B2B"
                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                data-testid="form-name-input"
                onChange={(e) => {
                  const val = e.target.value;
                  setName(val);
                  if (!slugTouched) {
                    setSlug(slugifyIndonesian(val));
                  }
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="form-slug-input" className="text-sm font-medium text-foreground">
                Slug Formulir <span className="text-destructive">*</span>
              </label>
              <Input
                id="form-slug-input"
                value={slug}
                disabled={readOnly}
                maxLength={80}
                placeholder="permintaan-penawaran"
                className="min-h-11 font-mono text-base sm:min-h-9 sm:text-sm"
                data-testid="form-slug-input"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="form-desc-input" className="text-sm font-medium text-foreground">
              Deskripsi / Pengantar (Opsional)
            </label>
            <textarea
              id="form-desc-input"
              rows={2}
              value={description}
              disabled={readOnly}
              maxLength={500}
              placeholder="Jelaskan singkat tujuan formulir dan perkiraan waktu respons tim Anda."
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="max-w-xs space-y-1.5">
            <label htmlFor="form-submit-label-input" className="text-sm font-medium text-foreground">
              Label Tombol Kirim
            </label>
            <Input
              id="form-submit-label-input"
              value={submitLabel}
              disabled={readOnly}
              maxLength={60}
              placeholder="Kirim Formulir"
              className="min-h-11 text-base sm:min-h-9 sm:text-sm"
              onChange={(e) => setSubmitLabel(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Vertical List Field Editor (NO drag-and-drop; keyboard Naik/Turun controls) */}
      <section aria-label="Daftar Field Formulir" className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Daftar Field ({fields.length} / {MAX_FIELDS_PER_FORM})
            </h2>
            <p className="text-xs text-muted-foreground">
              Urutkan field dengan tombol Naik/Turun. Tipe unggah file dan field tersembunyi tidak
              tersedia demi keamanan.
            </p>
          </div>
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fields.length >= MAX_FIELDS_PER_FORM}
              onClick={addField}
              className="min-h-11 sm:min-h-9"
              data-testid="add-field-btn"
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {fields.length >= MAX_FIELDS_PER_FORM ? "Maksimal 12 Field" : "Tambah Field"}
            </Button>
          )}
        </div>

        <div className="space-y-3">
          {fields.map((field, index) => {
            const isChoice = CHOICE_FIELD_TYPES.has(field.type);
            const conditionTargetsForThisField = eligibleConditionTargets.filter(
              (t) => t.key !== field.key,
            );
            const selectedCondTarget = field.condition
              ? conditionTargetsForThisField.find((t) => t.key === field.condition?.fieldKey) ?? null
              : null;

            return (
              <Card key={`${index}-${field.key}`} data-testid={`builder-field-${index}`}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="tabular-nums">
                        #{index + 1}
                      </Badge>
                      <span className="text-sm font-semibold text-foreground">
                        {field.label || "Field Tanpa Label"}
                      </span>
                      {field.condition && (
                        <Badge variant="outline" className="text-xs">
                          Kondisional
                        </Badge>
                      )}
                    </div>

                    {!readOnly && (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={index === 0}
                          onClick={() => moveField(index, -1)}
                          aria-label={`Pindahkan field ${index + 1} ke atas`}
                          className="min-h-10 sm:min-h-8"
                          data-testid={`field-move-up-${index}`}
                        >
                          <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                          Naik
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={index === fields.length - 1}
                          onClick={() => moveField(index, 1)}
                          aria-label={`Pindahkan field ${index + 1} ke bawah`}
                          className="min-h-10 sm:min-h-8"
                          data-testid={`field-move-down-${index}`}
                        >
                          <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                          Turun
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={fields.length <= 1}
                          onClick={() => removeField(index)}
                          aria-label={`Hapus field ${index + 1}`}
                          className="min-h-10 sm:min-h-8"
                          data-testid={`field-remove-${index}`}
                        >
                          <Trash2Icon className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <label
                        htmlFor={`field-label-${index}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Label Pertanyaan <span className="text-destructive">*</span>
                      </label>
                      <Input
                        id={`field-label-${index}`}
                        value={field.label}
                        disabled={readOnly}
                        maxLength={120}
                        className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                        data-testid={`field-label-input-${index}`}
                        onChange={(e) => updateField(index, { label: e.target.value })}
                      />
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor={`field-type-${index}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Tipe Field
                      </label>
                      <select
                        id={`field-type-${index}`}
                        value={field.type}
                        disabled={readOnly}
                        className="h-11 w-full rounded-md border border-input bg-card px-2.5 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring sm:h-9 sm:text-sm"
                        data-testid={`field-type-select-${index}`}
                        onChange={(e) =>
                          updateField(index, { type: e.target.value as CustomFormFieldType })
                        }
                      >
                        {CLOSED_FORM_FIELD_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {FORM_FIELD_TYPE_LABELS_ID[t]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor={`field-key-${index}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Kunci Field (Identifier)
                      </label>
                      <Input
                        id={`field-key-${index}`}
                        value={field.key}
                        disabled={readOnly}
                        maxLength={48}
                        className="min-h-11 font-mono text-base sm:min-h-9 sm:text-sm"
                        data-testid={`field-key-input-${index}`}
                        onChange={(e) =>
                          updateField(index, {
                            key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""),
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* Choice options editor */}
                  {isChoice && (
                    <div className="space-y-1">
                      <label
                        htmlFor={`field-options-${index}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Daftar Pilihan (1 opsi per baris, maks 20 opsi)
                      </label>
                      <textarea
                        id={`field-options-${index}`}
                        rows={3}
                        disabled={readOnly}
                        value={(field.options ?? []).join("\n")}
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
                        onChange={(e) => updateFieldOptionsText(index, e.target.value)}
                      />
                    </div>
                  )}

                  {/* Numeric bounds */}
                  {field.type === "number" && (
                    <div className="grid grid-cols-2 gap-3 max-w-sm">
                      <div className="space-y-1">
                        <label
                          htmlFor={`field-min-${index}`}
                          className="text-xs font-medium text-foreground"
                        >
                          Nilai Minimum (Opsional)
                        </label>
                        <Input
                          id={`field-min-${index}`}
                          type="number"
                          disabled={readOnly}
                          value={typeof field.min === "number" ? String(field.min) : ""}
                          className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                          onChange={(e) =>
                            updateField(index, {
                              min: e.target.value === "" ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <label
                          htmlFor={`field-max-${index}`}
                          className="text-xs font-medium text-foreground"
                        >
                          Nilai Maksimum (Opsional)
                        </label>
                        <Input
                          id={`field-max-${index}`}
                          type="number"
                          disabled={readOnly}
                          value={typeof field.max === "number" ? String(field.max) : ""}
                          className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                          onChange={(e) =>
                            updateField(index, {
                              max: e.target.value === "" ? undefined : Number(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {!isChoice && field.type !== "consent_checkbox" && field.type !== "date" && (
                      <div className="space-y-1">
                        <label
                          htmlFor={`field-placeholder-${index}`}
                          className="text-xs font-medium text-foreground"
                        >
                          Placeholder (Opsional)
                        </label>
                        <Input
                          id={`field-placeholder-${index}`}
                          value={field.placeholder ?? ""}
                          disabled={readOnly}
                          maxLength={160}
                          className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                          onChange={(e) => updateField(index, { placeholder: e.target.value })}
                        />
                      </div>
                    )}

                    <div className="space-y-1">
                      <label
                        htmlFor={`field-help-${index}`}
                        className="text-xs font-medium text-foreground"
                      >
                        Teks Bantuan (Opsional)
                      </label>
                      <Input
                        id={`field-help-${index}`}
                        value={field.helpText ?? ""}
                        disabled={readOnly}
                        maxLength={240}
                        className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                        onChange={(e) => updateField(index, { helpText: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* Required toggle + 1-level conditional rule */}
                  <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex min-h-11 items-center gap-2 text-sm text-foreground sm:min-h-8 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={field.required}
                        disabled={readOnly}
                        className="size-4 accent-primary"
                        onChange={(e) => updateField(index, { required: e.target.checked })}
                      />
                      <span>Wajib diisi</span>
                    </label>

                    {conditionTargetsForThisField.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <label
                          htmlFor={`field-cond-target-${index}`}
                          className="text-xs font-medium text-muted-foreground"
                        >
                          Tampilkan jika:
                        </label>
                        <select
                          id={`field-cond-target-${index}`}
                          disabled={readOnly}
                          value={field.condition?.fieldKey ?? ""}
                          className="h-10 rounded-md border border-input bg-card px-2 text-xs text-foreground sm:h-8"
                          data-testid={`field-cond-target-${index}`}
                          onChange={(e) => {
                            const targetKey = e.target.value;
                            if (!targetKey) {
                              updateField(index, { condition: null });
                              return;
                            }
                            const targetField = conditionTargetsForThisField.find(
                              (t) => t.key === targetKey,
                            );
                            const defaultVal =
                              targetField && CHOICE_FIELD_TYPES.has(targetField.type)
                                ? (targetField.options?.[0] ?? "")
                                : targetField?.type === "consent_checkbox"
                                  ? "true"
                                  : "";
                            updateField(index, {
                              condition: { fieldKey: targetKey, equalsValue: defaultVal },
                            });
                          }}
                        >
                          <option value="">Selalu tampil</option>
                          {conditionTargetsForThisField.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.label} ({t.key})
                            </option>
                          ))}
                        </select>

                        {field.condition && selectedCondTarget && (
                          <>
                            <span className="text-xs text-muted-foreground">=</span>
                            {CHOICE_FIELD_TYPES.has(selectedCondTarget.type) ? (
                              <select
                                aria-label="Nilai kondisi"
                                disabled={readOnly}
                                value={field.condition.equalsValue}
                                className="h-10 rounded-md border border-input bg-card px-2 text-xs text-foreground sm:h-8"
                                data-testid={`field-cond-value-${index}`}
                                onChange={(e) =>
                                  updateField(index, {
                                    condition: {
                                      fieldKey: field.condition!.fieldKey,
                                      equalsValue: e.target.value,
                                    },
                                  })
                                }
                              >
                                {(selectedCondTarget.options ?? []).map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            ) : selectedCondTarget.type === "consent_checkbox" ? (
                              <select
                                aria-label="Nilai kondisi persetujuan"
                                disabled={readOnly}
                                value={field.condition.equalsValue}
                                className="h-10 rounded-md border border-input bg-card px-2 text-xs text-foreground sm:h-8"
                                onChange={(e) =>
                                  updateField(index, {
                                    condition: {
                                      fieldKey: field.condition!.fieldKey,
                                      equalsValue: e.target.value,
                                    },
                                  })
                                }
                              >
                                <option value="true">Dicentang (true)</option>
                                <option value="false">Tidak dicentang (false)</option>
                              </select>
                            ) : (
                              <Input
                                aria-label="Nilai kondisi teks"
                                disabled={readOnly}
                                value={field.condition.equalsValue}
                                maxLength={120}
                                className="h-10 w-36 text-xs sm:h-8"
                                onChange={(e) =>
                                  updateField(index, {
                                    condition: {
                                      fieldKey: field.condition!.fieldKey,
                                      equalsValue: e.target.value,
                                    },
                                  })
                                }
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* After-Submit Action Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aksi Setelah Pengunjung Mengirim Formulir</CardTitle>
          <CardDescription className="text-xs">
            Setiap pengiriman selalu disimpan terlebih dahulu di Pesan Masuk sebelum menjalankan aksi
            lanjutan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="after-submit-action" className="text-sm font-medium text-foreground">
              Pilih Aksi Setelah Kirim
            </label>
            <select
              id="after-submit-action"
              value={afterSubmitAction}
              disabled={readOnly}
              className="h-11 w-full max-w-md rounded-md border border-input bg-card px-3 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring sm:h-9 sm:text-sm"
              data-testid="after-submit-action-select"
              onChange={(e) => setAfterSubmitAction(e.target.value as AfterSubmitAction)}
            >
              {AFTER_SUBMIT_ACTIONS.map((act) => (
                <option key={act} value={act}>
                  {AFTER_SUBMIT_ACTION_LABELS_ID[act]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="after-submit-message" className="text-sm font-medium text-foreground">
              Pesan Konfirmasi
            </label>
            <textarea
              id="after-submit-message"
              rows={2}
              value={afterMessage}
              disabled={readOnly}
              maxLength={500}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring sm:text-sm"
              onChange={(e) => setAfterMessage(e.target.value)}
            />
          </div>

          {afterSubmitAction === "whatsapp" && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="wa-phone-override" className="text-sm font-medium text-foreground">
                  Nomor WhatsApp Tujuan Khusus (Opsional)
                </label>
                <Input
                  id="wa-phone-override"
                  value={whatsappPhoneOverride}
                  disabled={readOnly}
                  placeholder={
                    compliance.whatsappE164
                      ? `Bawaan profil: +${compliance.whatsappE164}`
                      : "0812-3456-7890"
                  }
                  className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                  data-testid="wa-phone-override-input"
                  onChange={(e) => setWhatsappPhoneOverride(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Kosongkan untuk memakai nomor WhatsApp utama dari Profil Bisnis.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="wa-intro-text" className="text-sm font-medium text-foreground">
                  Kalimat Pembuka Pesan WhatsApp (Opsional)
                </label>
                <Input
                  id="wa-intro-text"
                  value={whatsappIntro}
                  disabled={readOnly}
                  maxLength={300}
                  placeholder="Halo, saya baru mengirim formulir berikut:"
                  className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                  onChange={(e) => setWhatsappIntro(e.target.value)}
                />
              </div>
            </div>
          )}

          {afterSubmitAction === "url" && (
            <div className="space-y-1.5 max-w-lg">
              <label htmlFor="redirect-url-input" className="text-sm font-medium text-foreground">
                Tautan Tujuan (HTTPS publik atau path internal) <span className="text-destructive">*</span>
              </label>
              <Input
                id="redirect-url-input"
                value={redirectUrl}
                disabled={readOnly}
                placeholder="https://contoh.co.id/terima-kasih atau /terima-kasih"
                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                data-testid="redirect-url-input"
                onChange={(e) => setRedirectUrl(e.target.value)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
