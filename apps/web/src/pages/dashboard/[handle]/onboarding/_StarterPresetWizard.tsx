import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import type {
  ApplyStarterPresetResult,
  PresetSectionStatusDto,
  PublishStarterPresetResult,
  TenantPresetStateDto,
} from "@punyasitus/db/presets/index";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  EyeIcon,
  LayersIcon,
  LockIcon,
  MonitorIcon,
  PencilIcon,
  RefreshCwIcon,
  RocketIcon,
  SaveIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import type { PresetPreviewResultDto } from "../../../api/tenants/[tenantId]/presets/_shared.ts";

export interface StarterPresetWizardProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly surfaceMode: "onboarding" | "appearance_presets";
  readonly presetsApiUrl: string;
  readonly applyApiUrl: string;
  readonly draftApiUrl: string;
  readonly previewApiUrl: string;
  readonly publishApiUrl: string;
  readonly customizerHref: string;
  readonly pagesHref: string;
  readonly initialState: TenantPresetStateDto;
}

interface ApiErrorNotice {
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
    readonly sectionId?: string;
  }[];
}

const SECTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  hero: "Hero Utama",
  about: "Tentang Perusahaan",
  rich_text: "Teks Kaya",
  services_grid: "Layanan Utama",
  offerings_grid: "Etalase Penawaran",
  gallery: "Portofolio & Dokumentasi",
  trust_logos: "Logo Mitra & Kredensial",
  testimonials: "Ulasan Klien",
  faq: "Pertanyaan Umum (FAQ)",
  contact_location: "Kontak & Lokasi",
  contact: "Kontak",
  branches: "Direktori Cabang",
};

function formatDateTimeId(iso: string | null): string | null {
  if (!iso) return null;
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

function generateOperationKey(handle: string): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `preset-${handle.slice(0, 18)}-${Date.now().toString(36)}-${randomPart}`;
}

function stripParagraphTags(html: string): string {
  return html
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function plainTextToParagraphHtml(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return "<p></p>";
  const escaped = cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function extractEditableFields(item: PresetSectionStatusDto): {
  heading: string;
  subheading: string;
  eyebrow: string;
  bodyText: string;
  faqQuestion: string;
  faqAnswer: string;
  address: string;
  phone: string;
  email: string;
} {
  const cfg = item.section.config as Record<string, unknown>;
  const faqFirst =
    item.section.type === "faq" && item.section.config.items[0]
      ? item.section.config.items[0]
      : null;

  return {
    eyebrow: typeof cfg.eyebrow === "string" ? cfg.eyebrow : "",
    heading: typeof cfg.heading === "string" ? cfg.heading : "",
    subheading: typeof cfg.subheading === "string" ? cfg.subheading : "",
    bodyText:
      item.section.type === "about" || item.section.type === "rich_text"
        ? stripParagraphTags(item.section.config.bodyHtml)
        : "",
    faqQuestion: faqFirst?.question ?? "",
    faqAnswer: faqFirst?.answer ?? "",
    address:
      item.section.type === "contact_location" || item.section.type === "contact"
        ? (item.section.config.address ?? "")
        : "",
    phone:
      item.section.type === "contact_location" || item.section.type === "contact"
        ? (item.section.config.phone ?? "")
        : "",
    email:
      item.section.type === "contact_location" || item.section.type === "contact"
        ? (item.section.config.email ?? "")
        : "",
  };
}

export function StarterPresetWizard({
  tenantHandle,
  workspaceName,
  surfaceMode,
  presetsApiUrl,
  applyApiUrl,
  draftApiUrl,
  previewApiUrl,
  publishApiUrl,
  customizerHref,
  pagesHref,
  initialState,
}: StarterPresetWizardProps) {
  const [state, setState] = React.useState<TenantPresetStateDto>(initialState);
  const [draftSections, setDraftSections] = React.useState<readonly PresetSectionStatusDto[]>(
    initialState.setup?.sections ?? [],
  );
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>(
    initialState.setup?.selectedPublishSectionIds ?? [],
  );
  const [hasUnsavedDraftChanges, setHasUnsavedDraftChanges] = React.useState(false);

  const [applyMode, setApplyMode] = React.useState<"preserve_existing" | "merge_draft">(
    "preserve_existing",
  );
  const [pendingOperationKey, setPendingOperationKey] = React.useState<string | null>(null);

  const [editingSectionId, setEditingSectionId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState<{
    eyebrow: string;
    heading: string;
    subheading: string;
    bodyText: string;
    faqQuestion: string;
    faqAnswer: string;
    address: string;
    phone: string;
    email: string;
  } | null>(null);

  const [isApplying, setIsApplying] = React.useState(false);
  const [isSavingDraft, setIsSavingDraft] = React.useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isReloading, setIsReloading] = React.useState(false);

  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewViewport, setPreviewViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [previewResult, setPreviewResult] = React.useState<PresetPreviewResultDto | null>(null);

  const [publishDialogOpen, setPublishDialogOpen] = React.useState(false);

  const [errorNotice, setErrorNotice] = React.useState<ApiErrorNotice | null>(null);
  const [successBanner, setSuccessBanner] = React.useState<string | null>(null);

  const isLocked = state.permissions.isLocked || !state.permissions.canMutate;
  const setup = state.setup;

  const syncFromServerState = React.useCallback((nextState: TenantPresetStateDto) => {
    setState(nextState);
    setDraftSections(nextState.setup?.sections ?? []);
    setSelectedIds(nextState.setup?.selectedPublishSectionIds ?? []);
    setHasUnsavedDraftChanges(false);
  }, []);

  const parseErrorPayload = async (res: Response): Promise<ApiErrorNotice> => {
    try {
      const json = (await res.json()) as {
        error?: {
          code?: string;
          message?: string;
          fields?: readonly {
            field: string;
            code: string;
            message: string;
            sectionId?: string;
          }[];
        };
      };
      return {
        code: json.error?.code ?? `HTTP_${res.status}`,
        message: json.error?.message ?? "Permintaan tidak dapat diproses. Silakan coba lagi.",
        fields: json.error?.fields,
      };
    } catch {
      return {
        code: `HTTP_${res.status}`,
        message: "Terjadi gangguan komunikasi dengan server. Input Anda tetap dipertahankan.",
      };
    }
  };

  const handleReload = async () => {
    setIsReloading(true);
    setErrorNotice(null);
    try {
      const res = await fetch(presetsApiUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }
      const nextState = (await res.json()) as TenantPresetStateDto;
      syncFromServerState(nextState);
      setEditingSectionId(null);
      setEditDraft(null);
      setSuccessBanner("Data preset terbaru berhasil dimuat ulang.");
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal memuat ulang data preset. Periksa koneksi Anda lalu coba lagi.",
      });
    } finally {
      setIsReloading(false);
    }
  };

  const handleApplyPreset = async (presetId: string) => {
    if (isLocked || isApplying) return;
    setErrorNotice(null);
    setSuccessBanner(null);
    setIsApplying(true);

    const opKey = pendingOperationKey ?? generateOperationKey(tenantHandle);
    setPendingOperationKey(opKey);

    try {
      const res = await fetch(applyApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          presetId,
          operationKey: opKey,
          applyMode,
        }),
      });

      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }

      const result = (await res.json()) as ApplyStarterPresetResult;
      syncFromServerState(result.state);
      setPendingOperationKey(null);
      setEditingSectionId(null);
      setEditDraft(null);

      if (result.idempotentReplay) {
        setSuccessBanner(
          "Permintaan preset yang sama terdeteksi sebagai pengulangan aman (idempoten). Tidak ada duplikasi halaman atau menu.",
        );
      } else if (result.preservedExistingContent) {
        setSuccessBanner(
          "Draf preset Profil Perusahaan berhasil disiapkan tanpa menghapus atau mengubah konten publik yang sudah ada.",
        );
      } else {
        setSuccessBanner(
          "Komposisi draf Profil Perusahaan & daftar periksa berhasil dibuat. Seluruh teks contoh tetap berstatus draf.",
        );
      }
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message:
          "Koneksi terputus saat menerapkan preset. Klik tombol lagi untuk mengulang dengan kunci idempoten yang sama tanpa duplikasi.",
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleToggleSelectSection = (sectionId: string) => {
    if (isLocked) return;
    setSelectedIds((prev) =>
      prev.includes(sectionId) ? prev.filter((id) => id !== sectionId) : [...prev, sectionId],
    );
    setHasUnsavedDraftChanges(true);
  };

  const handleMoveSection = (index: number, direction: -1 | 1) => {
    if (isLocked) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftSections.length) return;
    setDraftSections((prev) => {
      const next = [...prev];
      const current = next[index];
      const swapped = next[targetIndex];
      if (!current || !swapped) return prev;
      next[index] = { ...swapped, order: index, section: { ...swapped.section, order: index } };
      next[targetIndex] = {
        ...current,
        order: targetIndex,
        section: { ...current.section, order: targetIndex },
      };
      return next;
    });
    setHasUnsavedDraftChanges(true);
  };

  const openSectionEditor = (item: PresetSectionStatusDto) => {
    if (isLocked) return;
    setEditingSectionId(item.id);
    setEditDraft(extractEditableFields(item));
    setErrorNotice(null);
  };

  const applyInlineEditToLocalDraft = () => {
    if (!editingSectionId || !editDraft) return;
    setDraftSections((prev) =>
      prev.map((item) => {
        if (item.id !== editingSectionId) return item;
        const baseCfg = { ...(item.section.config as Record<string, unknown>) };

        if ("eyebrow" in baseCfg || editDraft.eyebrow.trim()) {
          baseCfg.eyebrow = editDraft.eyebrow.trim() || null;
        }
        baseCfg.heading = editDraft.heading.trim() || (baseCfg.heading as string);
        baseCfg.subheading = editDraft.subheading.trim() || null;

        if (item.section.type === "about" || item.section.type === "rich_text") {
          baseCfg.bodyHtml = plainTextToParagraphHtml(editDraft.bodyText);
        } else if (item.section.type === "faq") {
          if (editDraft.faqQuestion.trim() && editDraft.faqAnswer.trim()) {
            baseCfg.items = [
              {
                question: editDraft.faqQuestion.trim(),
                answer: editDraft.faqAnswer.trim(),
                defaultOpen: false,
              },
            ];
          } else {
            baseCfg.items = [];
          }
        } else if (item.section.type === "contact_location" || item.section.type === "contact") {
          baseCfg.address = editDraft.address.trim() || null;
          baseCfg.phone = editDraft.phone.trim() || null;
          baseCfg.email = editDraft.email.trim() || null;
        }

        const updatedSection = {
          ...item.section,
          config: baseCfg,
        } as PresetSectionStatusDto["section"];

        return {
          ...item,
          section: updatedSection,
        };
      }),
    );
    setHasUnsavedDraftChanges(true);
    setEditingSectionId(null);
    setEditDraft(null);
  };

  const handleSaveDraft = async () => {
    if (isLocked || !setup || isSavingDraft) return;
    setErrorNotice(null);
    setSuccessBanner(null);
    setIsSavingDraft(true);

    const payloadSections = draftSections.map((item, idx) => ({
      id: item.section.id,
      type: item.section.type,
      schemaVersion: item.section.schemaVersion,
      enabled: selectedIds.includes(item.id),
      order: idx,
      config: item.section.config,
    }));

    try {
      const res = await fetch(draftApiUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          expectedVersion: setup.version,
          sections: payloadSections,
          selectedPublishSectionIds: selectedIds,
        }),
      });

      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }

      const nextState = (await res.json()) as TenantPresetStateDto;
      syncFromServerState(nextState);
      setSuccessBanner(
        "Perubahan draf preset tersimpan. Situs publik belum berubah hingga Anda menekan Terbitkan Bagian Terpilih.",
      );
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal menyimpan draf preset. Perubahan lokal Anda tetap dipertahankan.",
      });
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleOpenPreview = async () => {
    if (isPreviewLoading) return;
    setErrorNotice(null);
    setIsPreviewLoading(true);
    try {
      const res = await fetch(previewApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          presetId: setup?.presetId ?? "company_profile",
          ...(selectedIds.length > 0 ? { selectedSectionIds: selectedIds } : {}),
        }),
      });

      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }

      const result = (await res.json()) as PresetPreviewResultDto;
      setPreviewResult(result);
      setPreviewOpen(true);

      // Update checklist preview item optimistically once preview succeeded
      setState((prev) => ({
        ...prev,
        checklist: {
          ...prev.checklist,
          items: prev.checklist.items.map((item) =>
            item.id === "preview"
              ? {
                  ...item,
                  status: "done",
                  detail: "Pratinjau draf sudah diperiksa.",
                }
              : item,
          ),
        },
      }));
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal memuat pratinjau draf preset. Silakan coba lagi.",
      });
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handlePublishSelected = async () => {
    if (isLocked || !setup || isPublishing) return;
    setErrorNotice(null);
    setSuccessBanner(null);
    setIsPublishing(true);

    try {
      const res = await fetch(publishApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          presetId: setup.presetId,
          selectedSectionIds: selectedIds,
          expectedVersion: setup.version,
          confirm: true,
        }),
      });

      if (!res.ok) {
        const err = await parseErrorPayload(res);
        setErrorNotice(err);
        setPublishDialogOpen(false);
        return;
      }

      const result = (await res.json()) as PublishStarterPresetResult;
      syncFromServerState(result.state);
      setPublishDialogOpen(false);
      setSuccessBanner(
        `${result.publishedSectionIds.length} bagian tervalidasi berhasil diterbitkan secara atomik (revisi #${result.revisionNumber}). Bagian draf lain tetap tersimpan aman.`,
      );
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal menerbitkan bagian terpilih karena gangguan jaringan. Silakan coba lagi.",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const selectedItems = draftSections.filter((s) => selectedIds.includes(s.id));
  const selectedSampleItems = selectedItems.filter((s) => s.containsSampleCopy);

  const handleDeselectSampleSections = () => {
    const sampleSet = new Set(draftSections.filter((s) => s.containsSampleCopy).map((s) => s.id));
    setSelectedIds((prev) => prev.filter((id) => !sampleSet.has(id)));
    setHasUnsavedDraftChanges(true);
  };

  return (
    <div className="space-y-6 pb-10" data-testid="starter-preset-wizard-root">
      {/* Page Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">
              {surfaceMode === "onboarding" ? "Onboarding Pemula" : "Tampilan · Preset"}
            </Badge>
            <Badge variant="secondary" className="tabular-nums">
              {setup ? `Versi draf v${setup.version}` : "Belum diterapkan"}
            </Badge>
            {setup?.status === "published" && (
              <Badge variant="success">Sebagian / Semua Terbit</Badge>
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {surfaceMode === "onboarding"
              ? "Pengaturan Awal Situs Profil Perusahaan"
              : "Preset Pemula Situs"}
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Siapkan struktur draf beranda profil perusahaan dan daftar periksa kesiapan terbit
            untuk <strong className="font-medium text-foreground">{workspaceName}</strong>.
            Teks contoh tetap berstatus draf dan konten yang sudah ada tidak pernah dihapus.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="default"
            className="min-h-11 sm:min-h-9"
            onClick={handleReload}
            disabled={isReloading}
          >
            <RefreshCwIcon className={isReloading ? "animate-spin" : ""} />
            Muat Ulang
          </Button>
          <Button
            variant="outline"
            size="default"
            className="min-h-11 sm:min-h-9"
            onClick={handleOpenPreview}
            disabled={isPreviewLoading}
            data-testid="preset-preview-btn"
          >
            <EyeIcon />
            {isPreviewLoading ? "Memuat Pratinjau..." : "Pratinjau Draf"}
          </Button>
          <Button
            variant="secondary"
            size="default"
            className="min-h-11 sm:min-h-9"
            render={<a href={customizerHref} />}
          >
            Buka Kustomisasi Tema
          </Button>
        </div>
      </header>

      {/* Locked Tenant Read-Only Banner */}
      {isLocked && (
        <Alert variant="warning" data-testid="preset-locked-banner">
          <LockIcon />
          <AlertTitle>Mode Hanya Baca — Akun Terkunci</AlertTitle>
          <AlertDescription>
            Status situs sedang terkunci. Anda tetap dapat meninjau daftar periksa dan pratinjau
            draf, namun penerapan preset, penyimpanan draf, dan penerbitan dinonaktifkan hingga
            langganan diaktifkan kembali.
          </AlertDescription>
        </Alert>
      )}

      {/* Permenkes Health Category Notice */}
      {state.isHealthCategory && (
        <Alert variant="warning" data-testid="preset-permenkes-notice">
          <ShieldAlertIcon />
          <AlertTitle>Pengingat Kepatuhan Kategori Kesehatan (Permenkes)</AlertTitle>
          <AlertDescription>
            Kategori usaha Anda terdeteksi sebagai layanan kesehatan/medis. Bagian testimoni
            dinonaktifkan secara default dan tidak disarankan menampilkan klaim hasil pengobatan.
          </AlertDescription>
        </Alert>
      )}

      {/* Error / Conflict Notice */}
      {errorNotice && (
        <Alert
          variant={errorNotice.code === "STALE_VERSION" ? "warning" : "destructive"}
          role="alert"
          data-testid="preset-error-alert"
        >
          <AlertCircleIcon />
          <AlertTitle>
            {errorNotice.code === "STALE_VERSION"
              ? "Konflik Versi Draf (409)"
              : errorNotice.code === "SAMPLE_CONTENT_BLOCKED"
                ? "Teks Contoh Belum Dapat Diterbitkan"
                : errorNotice.code === "CHECKLIST_INCOMPLETE"
                  ? "Daftar Periksa Utama Belum Lengkap"
                  : "Permintaan Gagal Diproses"}
          </AlertTitle>
          <AlertDescription>
            <p>{errorNotice.message}</p>
            {errorNotice.fields && errorNotice.fields.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {errorNotice.fields.slice(0, 6).map((f, idx) => (
                  <li key={`${f.field}-${idx}`}>
                    <span className="font-medium">{f.sectionId ?? f.field}:</span> {f.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
          {errorNotice.code === "STALE_VERSION" && (
            <AlertAction>
              <Button variant="outline" size="sm" onClick={handleReload} disabled={isReloading}>
                Muat Ulang Data Terbaru
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}

      {/* Success Feedback */}
      {successBanner && (
        <Alert variant="success" role="status" data-testid="preset-success-alert">
          <CheckCircle2Icon />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{successBanner}</AlertDescription>
        </Alert>
      )}

      {/* Populated Tenant Protection Notice */}
      {state.contentSummary.isPopulatedTenant && (
        <Alert variant="info" data-testid="preset-populated-notice">
          <ShieldCheckIcon />
          <AlertTitle>Konten Lama Tetap Terjaga Aman</AlertTitle>
          <AlertDescription>
            Situs ini sudah memiliki{" "}
            <span className="font-medium tabular-nums">
              {state.contentSummary.pages} halaman, {state.contentSummary.posts} artikel, dan{" "}
              {state.contentSummary.offerings} item katalog
            </span>
            . Menerapkan preset hanya membuat komposisi draf tanpa menghapus atau menurunkan
            halaman yang sudah terbit.
          </AlertDescription>
        </Alert>
      )}

      {/* Section 1: Preset Catalog Cards */}
      <section aria-labelledby="preset-catalog-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="preset-catalog-heading" className="text-lg font-semibold text-foreground">
              Pilih Preset Pemula
            </h2>
            <p className="text-sm text-muted-foreground">
              Rilis M1 menyediakan preset Profil Perusahaan. Preset vertikal lain hadir di M2.
            </p>
          </div>
          {state.contentSummary.isPopulatedTenant && !isLocked && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 sm:min-h-9">
                <input
                  type="radio"
                  name="preset-apply-mode"
                  value="preserve_existing"
                  checked={applyMode === "preserve_existing"}
                  onChange={() => setApplyMode("preserve_existing")}
                  className="accent-primary"
                />
                <span>Draf terpisah (pertahankan beranda lama)</span>
              </label>
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 sm:min-h-9">
                <input
                  type="radio"
                  name="preset-apply-mode"
                  value="merge_draft"
                  checked={applyMode === "merge_draft"}
                  onChange={() => setApplyMode("merge_draft")}
                  className="accent-primary"
                />
                <span>Gabungkan bagian baru ke draf beranda</span>
              </label>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {state.catalog.map((entry) => {
            const isActivePreset = setup?.presetId === entry.id;
            return (
              <Card
                key={entry.id}
                className={
                  entry.availableInM1
                    ? "border-primary/40 bg-card"
                    : "border-border bg-muted/40 opacity-85"
                }
                data-testid={`preset-card-${entry.id}`}
              >
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <LayersIcon className="size-4 text-primary" />
                      {entry.name}
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {entry.availableInM1 ? (
                        <Badge variant="success">Tersedia M1</Badge>
                      ) : (
                        <Badge variant="secondary">Segera Hadir (M2)</Badge>
                      )}
                      {isActivePreset && <Badge variant="info">Aktif di Draf</Badge>}
                    </div>
                  </div>
                  <CardDescription>{entry.shortDescription}</CardDescription>
                </CardHeader>

                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {entry.sectionSummary.map((sec) => (
                      <Badge
                        key={`${entry.id}-${sec.type}`}
                        variant={sec.optional ? "outline" : "secondary"}
                      >
                        {sec.label}
                        {sec.optional ? " (Opsional)" : ""}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{entry.safetyNote}</p>
                </CardContent>

                <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground">
                    Tema rekomendasi: <strong className="text-foreground">{entry.recommendedThemeId}</strong>
                  </span>
                  {entry.availableInM1 ? (
                    <Button
                      size="default"
                      className="min-h-11 sm:min-h-9"
                      disabled={isLocked || isApplying}
                      onClick={() => handleApplyPreset(entry.id)}
                      data-testid={`apply-preset-${entry.id}`}
                    >
                      <LayersIcon />
                      {isApplying
                        ? "Menyiapkan Draf..."
                        : isActivePreset
                          ? "Terapkan Ulang Draf (Aman)"
                          : "Terapkan Draf Preset"}
                    </Button>
                  ) : (
                    <Button
                      size="default"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      disabled
                    >
                      Dijadwalkan {entry.deferredTask}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Section 2: Two-column Main Workspace (Draft Sections + Live Readiness Checklist) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left 8 cols: Draft Section Composition & Selective Publication */}
        <section
          aria-labelledby="draft-composition-heading"
          className="min-w-0 space-y-4 xl:col-span-8"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2
                id="draft-composition-heading"
                className="text-lg font-semibold text-foreground"
              >
                Komposisi Bagian Draf & Penerbitan Terpilih
              </h2>
              <p className="text-sm text-muted-foreground">
                Ubah teks <span className="font-medium text-warning">[Contoh]</span> dengan
                informasi resmi usaha Anda. Bagian opsional yang kosong tidak menghalangi
                penerbitan awal.
              </p>
            </div>
            {setup && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="default"
                  className="min-h-11 sm:min-h-9"
                  disabled={isLocked || isSavingDraft || !hasUnsavedDraftChanges}
                  onClick={handleSaveDraft}
                  data-testid="preset-save-draft-btn"
                >
                  <SaveIcon />
                  {isSavingDraft ? "Menyimpan..." : "Simpan Draf"}
                </Button>
                <Button
                  variant="default"
                  size="default"
                  className="min-h-11 sm:min-h-9"
                  disabled={isLocked || selectedIds.length === 0 || hasUnsavedDraftChanges}
                  onClick={() => setPublishDialogOpen(true)}
                  data-testid="preset-open-publish-btn"
                >
                  <RocketIcon />
                  Terbitkan Terpilih ({selectedIds.length})
                </Button>
              </div>
            )}
          </div>

          {hasUnsavedDraftChanges && (
            <Alert variant="warning" data-testid="preset-unsaved-alert">
              <AlertTriangleIcon />
              <AlertTitle>Ada Perubahan Draf Belum Disimpan</AlertTitle>
              <AlertDescription>
                Simpan draf terlebih dahulu agar pilihan dan perubahan teks Anda divalidasi
                server sebelum menerbitkan.
              </AlertDescription>
            </Alert>
          )}

          {!setup ? (
            <Card data-testid="preset-empty-state">
              <CardHeader>
                <CardTitle>Belum Ada Komposisi Preset di Draf</CardTitle>
                <CardDescription>
                  Klik <strong>Terapkan Draf Preset</strong> pada kartu Profil Perusahaan di atas
                  untuk membuat 8 bagian draf terstruktur tanpa mengubah halaman yang sudah terbit.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button
                  disabled={isLocked || isApplying}
                  onClick={() => handleApplyPreset("company_profile")}
                  className="min-h-11 sm:min-h-9"
                >
                  <LayersIcon />
                  Mulai Preset Profil Perusahaan
                </Button>
              </CardFooter>
            </Card>
          ) : (
            <div className="space-y-3" data-testid="preset-sections-list">
              {draftSections.map((item, idx) => {
                const isSelected = selectedIds.includes(item.id);
                const isEditing = editingSectionId === item.id;
                const cfg = item.section.config as Record<string, unknown>;
                const headingText =
                  typeof cfg.heading === "string" && cfg.heading.trim()
                    ? cfg.heading
                    : (SECTION_TYPE_LABELS[item.type] ?? item.type);
                const subheadingText =
                  typeof cfg.subheading === "string" ? cfg.subheading : "";

                return (
                  <Card
                    key={item.id}
                    className={
                      isSelected ? "border-primary/40 bg-card" : "border-border bg-card/70"
                    }
                    data-testid={`preset-section-card-${item.id}`}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 items-start gap-3">
                          <label className="mt-0.5 flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-background sm:min-h-8 sm:min-w-8">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={isLocked}
                              onChange={() => handleToggleSelectSection(item.id)}
                              aria-label={`Pilih bagian ${SECTION_TYPE_LABELS[item.type] ?? item.type} untuk diterbitkan`}
                              className="size-4 accent-primary"
                              data-testid={`select-section-${item.id}`}
                            />
                          </label>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                                #{idx + 1}
                              </span>
                              <span className="text-sm font-semibold text-foreground">
                                {SECTION_TYPE_LABELS[item.type] ?? item.type}
                              </span>
                              {item.containsSampleCopy ? (
                                <Badge variant="warning" data-testid={`sample-badge-${item.id}`}>
                                  Teks Contoh (Draf)
                                </Badge>
                              ) : (
                                <Badge variant="success" data-testid={`ready-badge-${item.id}`}>
                                  Siap Terbit
                                </Badge>
                              )}
                              {item.optional && <Badge variant="outline">Opsional</Badge>}
                              {item.isPublished && <Badge variant="info">Sudah Terbit</Badge>}
                            </div>
                            <p className="break-words text-sm font-medium text-foreground">
                              {headingText}
                            </p>
                            {subheadingText && (
                              <p className="break-words text-xs text-muted-foreground">
                                {subheadingText}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Keyboard ordering & Edit actions */}
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            disabled={isLocked || idx === 0}
                            onClick={() => handleMoveSection(idx, -1)}
                            aria-label={`Pindahkan ${SECTION_TYPE_LABELS[item.type] ?? item.type} ke atas`}
                            data-testid={`move-up-${item.id}`}
                          >
                            <ArrowUpIcon />
                            Naik
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            disabled={isLocked || idx === draftSections.length - 1}
                            onClick={() => handleMoveSection(idx, 1)}
                            aria-label={`Pindahkan ${SECTION_TYPE_LABELS[item.type] ?? item.type} ke bawah`}
                            data-testid={`move-down-${item.id}`}
                          >
                            <ArrowDownIcon />
                            Turun
                          </Button>
                          <Button
                            variant={isEditing ? "secondary" : "outline"}
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            disabled={isLocked}
                            onClick={() =>
                              isEditing
                                ? (setEditingSectionId(null), setEditDraft(null))
                                : openSectionEditor(item)
                            }
                            data-testid={`edit-section-${item.id}`}
                          >
                            <PencilIcon />
                            {isEditing ? "Tutup" : "Ubah"}
                          </Button>
                        </div>
                      </div>
                    </CardHeader>

                    {/* Inline Editor Form */}
                    {isEditing && editDraft && (
                      <CardContent
                        className="space-y-3 border-t border-border bg-muted/30 pt-4"
                        data-testid={`editor-panel-${item.id}`}
                      >
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="space-y-1 text-xs font-medium text-foreground">
                            <span>Label Atas (Eyebrow)</span>
                            <Input
                              value={editDraft.eyebrow}
                              onChange={(e) =>
                                setEditDraft((prev) =>
                                  prev ? { ...prev, eyebrow: e.target.value } : prev,
                                )
                              }
                              className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              placeholder="Contoh: Profil Perusahaan"
                              data-testid={`input-eyebrow-${item.id}`}
                            />
                          </label>
                          <label className="space-y-1 text-xs font-medium text-foreground">
                            <span>Judul Bagian</span>
                            <Input
                              value={editDraft.heading}
                              onChange={(e) =>
                                setEditDraft((prev) =>
                                  prev ? { ...prev, heading: e.target.value } : prev,
                                )
                              }
                              className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              placeholder="Tulis judul resmi usaha Anda"
                              data-testid={`input-heading-${item.id}`}
                            />
                          </label>
                        </div>

                        <label className="block space-y-1 text-xs font-medium text-foreground">
                          <span>Subjudul / Deskripsi Ringkas</span>
                          <textarea
                            rows={2}
                            value={editDraft.subheading}
                            onChange={(e) =>
                              setEditDraft((prev) =>
                                prev ? { ...prev, subheading: e.target.value } : prev,
                              )
                            }
                            className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                            placeholder="Jelaskan secara ringkas dan faktual"
                            data-testid={`input-subheading-${item.id}`}
                          />
                        </label>

                        {(item.section.type === "about" || item.section.type === "rich_text") && (
                          <label className="block space-y-1 text-xs font-medium text-foreground">
                            <span>Isi Profil Perusahaan</span>
                            <textarea
                              rows={3}
                              value={editDraft.bodyText}
                              onChange={(e) =>
                                setEditDraft((prev) =>
                                  prev ? { ...prev, bodyText: e.target.value } : prev,
                                )
                              }
                              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                              placeholder="Tuliskan cerita dan ruang lingkup layanan perusahaan Anda"
                              data-testid={`input-body-${item.id}`}
                            />
                          </label>
                        )}

                        {item.section.type === "faq" && (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-xs font-medium text-foreground">
                              <span>Pertanyaan FAQ Utama</span>
                              <Input
                                value={editDraft.faqQuestion}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, faqQuestion: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </label>
                            <label className="space-y-1 text-xs font-medium text-foreground">
                              <span>Jawaban FAQ</span>
                              <Input
                                value={editDraft.faqAnswer}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, faqAnswer: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </label>
                          </div>
                        )}

                        {(item.section.type === "contact_location" ||
                          item.section.type === "contact") && (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <label className="space-y-1 text-xs font-medium text-foreground">
                              <span>Alamat Kantor</span>
                              <Input
                                value={editDraft.address}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, address: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                                data-testid={`input-address-${item.id}`}
                              />
                            </label>
                            <label className="space-y-1 text-xs font-medium text-foreground">
                              <span>Telepon</span>
                              <Input
                                value={editDraft.phone}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, phone: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </label>
                            <label className="space-y-1 text-xs font-medium text-foreground">
                              <span>Email Bisnis</span>
                              <Input
                                value={editDraft.email}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, email: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </label>
                          </div>
                        )}

                        <div className="flex flex-wrap justify-end gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            onClick={() => {
                              setEditingSectionId(null);
                              setEditDraft(null);
                            }}
                          >
                            Batal
                          </Button>
                          <Button
                            size="sm"
                            className="min-h-11 sm:min-h-8"
                            onClick={applyInlineEditToLocalDraft}
                            data-testid={`apply-edit-${item.id}`}
                          >
                            Terapkan ke Draf
                          </Button>
                        </div>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* Right 4 cols: Live 6-Item Readiness Checklist */}
        <aside aria-labelledby="checklist-heading" className="min-w-0 space-y-4 xl:col-span-4">
          <Card data-testid="preset-checklist-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle id="checklist-heading" className="text-base">
                  Daftar Periksa Kesiapan
                </CardTitle>
                <Badge variant="secondary" className="tabular-nums">
                  {state.checklist.completedCount}/{state.checklist.totalCount} selesai
                </Badge>
              </div>
              <CardDescription>
                Lengkapi poin utama sebelum terbit. Modul opsional tidak menghalangi penerbitan
                awal.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {state.checklist.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-md border border-border bg-background/60 p-3"
                  data-testid={`checklist-item-${item.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2">
                      {item.status === "done" ? (
                        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                      ) : (
                        <CircleDotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{item.label}</p>
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">
                          {item.detail}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={
                        item.status === "done"
                          ? "success"
                          : item.requiredForPublish
                            ? "warning"
                            : "outline"
                      }
                    >
                      {item.status === "done"
                        ? "Selesai"
                        : item.requiredForPublish
                          ? "Utama"
                          : "Opsional"}
                    </Badge>
                  </div>
                  {item.status !== "done" && (
                    <div className="mt-2 flex justify-end">
                      {item.id === "preview" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-11 px-2 text-xs sm:min-h-8"
                          onClick={handleOpenPreview}
                        >
                          {item.actionLabel}
                          <ChevronRightIcon />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-11 px-2 text-xs sm:min-h-8"
                          render={<a href={item.actionHref} />}
                        >
                          {item.actionLabel}
                          <ChevronRightIcon />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
            <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>
                Terakhir disimpan:{" "}
                <span className="tabular-nums">
                  {formatDateTimeId(setup?.updatedAt ?? null) ?? "Belum ada"}
                </span>
              </span>
              <Button variant="link" size="sm" className="min-h-11 px-1 text-xs sm:min-h-8" render={<a href={pagesHref} />}>
                Semua Halaman
              </Button>
            </CardFooter>
          </Card>
        </aside>
      </div>

      {/* Responsive Draft Preview Dialog (@base-ui/react/dialog) */}
      <DialogPrimitive.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/45" />
          <DialogPrimitive.Popup
            className="fixed inset-x-3 top-1/2 z-50 mx-auto flex max-h-[90vh] max-w-5xl -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg sm:inset-x-6"
            data-testid="preset-preview-dialog"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Pratinjau Draf Preset (Inert)
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-xs text-muted-foreground">
                  Tampilan pratinjau tanpa skrip dan belum memengaruhi situs publik.
                </DialogPrimitive.Description>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={previewViewport === "desktop" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPreviewViewport("desktop")}
                  data-testid="preview-viewport-desktop"
                >
                  <MonitorIcon />
                  Desktop
                </Button>
                <Button
                  variant={previewViewport === "mobile" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPreviewViewport("mobile")}
                  data-testid="preview-viewport-mobile"
                >
                  <SmartphoneIcon />
                  Seluler
                </Button>
                <DialogPrimitive.Close
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="Tutup pratinjau" />
                  }
                >
                  <XIcon />
                </DialogPrimitive.Close>
              </div>
            </div>

            {previewResult?.hasSampleContent && (
              <div className="border-b border-warning-border bg-warning-soft px-4 py-2 text-xs text-warning">
                Pratinjau masih memuat bagian bertanda <strong>[Contoh]</strong>. Ubah teks contoh
                atau batal pilih bagian tersebut sebelum menerbitkan.
              </div>
            )}

            <div className="flex flex-1 justify-center overflow-auto bg-muted/50 p-4">
              {previewResult ? (
                <iframe
                  title="Pratinjau draf preset profil perusahaan"
                  sandbox={PREVIEW_IFRAME_SANDBOX}
                  srcDoc={previewResult.html}
                  className={
                    previewViewport === "mobile"
                      ? "h-[600px] w-[360px] max-w-full rounded-md border border-border bg-white"
                      : "h-[600px] w-full rounded-md border border-border bg-white"
                  }
                  data-testid="preset-preview-iframe"
                />
              ) : (
                <p className="py-12 text-sm text-muted-foreground">Memuat pratinjau...</p>
              )}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Selective Publish Confirmation Dialog (@base-ui/react/dialog) */}
      <DialogPrimitive.Root open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/45" />
          <DialogPrimitive.Popup
            className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-lg -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg"
            data-testid="preset-publish-dialog"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Konfirmasi Penerbitan Bagian Terpilih
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  Hanya{" "}
                  <strong className="tabular-nums text-foreground">
                    {selectedItems.length} bagian terpilih
                  </strong>{" "}
                  yang akan diterbitkan ke beranda publik. Bagian lain tetap tersimpan di draf dan
                  halaman lain tidak terpengaruh.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close
                render={<Button variant="ghost" size="icon-sm" aria-label="Tutup dialog" />}
              >
                <XIcon />
              </DialogPrimitive.Close>
            </div>

            <div className="mt-4 space-y-3">
              <ul className="max-h-48 space-y-1.5 overflow-auto rounded-md border border-border bg-background p-3 text-xs">
                {selectedItems.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      {SECTION_TYPE_LABELS[item.type] ?? item.type}
                    </span>
                    <Badge variant={item.containsSampleCopy ? "warning" : "success"}>
                      {item.containsSampleCopy ? "Masih Teks Contoh" : "Valid"}
                    </Badge>
                  </li>
                ))}
              </ul>

              {selectedSampleItems.length > 0 && (
                <Alert variant="warning" data-testid="publish-sample-warning">
                  <AlertTriangleIcon />
                  <AlertTitle>Teks Contoh Terdeteksi</AlertTitle>
                  <AlertDescription>
                    <p>
                      {selectedSampleItems.length} bagian terpilih masih memuat teks{" "}
                      <strong>[Contoh]</strong>. Server akan menolak penerbitan teks contoh.
                      Silakan ubah teksnya terlebih dahulu atau batal pilih bagian contoh.
                    </p>
                    <div className="mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          handleDeselectSampleSections();
                          setPublishDialogOpen(false);
                        }}
                      >
                        Batal Pilih Bagian Contoh
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <DialogPrimitive.Close
                render={<Button variant="outline" className="min-h-11 sm:min-h-9" />}
              >
                Batal
              </DialogPrimitive.Close>
              <Button
                variant="default"
                className="min-h-11 sm:min-h-9"
                disabled={isPublishing || selectedItems.length === 0}
                onClick={handlePublishSelected}
                data-testid="preset-confirm-publish-btn"
              >
                <RocketIcon />
                {isPublishing ? "Menerbitkan..." : "Ya, Terbitkan Sekarang"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
