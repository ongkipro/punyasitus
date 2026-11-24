import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import type { VerticalStarterPresetId } from "@punyasitus/core/presets/index";
import type {
  ApplyVerticalStarterPresetResult,
  PresetSectionStatusDto,
  PublishVerticalStarterPresetResult,
  VerticalPresetDashboardStateDto,
} from "@punyasitus/db/presets/index";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BriefcaseIcon,
  Building2Icon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CompassIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileTextIcon,
  LayersIcon,
  LockIcon,
  MapPinIcon,
  MonitorIcon,
  PackageIcon,
  PencilIcon,
  RefreshCwIcon,
  RocketIcon,
  SaveIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  StoreIcon,
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

export interface VerticalOnboardingWorkspaceProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly verticalPresetsApiUrl: string;
  readonly customizerHref: string;
  readonly pagesHref: string;
  readonly initialVerticalState: VerticalPresetDashboardStateDto;
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
  about: "Tentang Usaha",
  rich_text: "Teks Kaya",
  features: "Tahapan & Standar",
  services_grid: "Etalase Layanan",
  products_grid: "Etalase Menu & Produk",
  tours_grid: "Etalase Paket Travel",
  offerings_grid: "Etalase Penawaran",
  gallery: "Galeri & Dokumentasi",
  trust_logos: "Logo Mitra & Kredensial",
  testimonials: "Ulasan Klien",
  faq: "Pertanyaan Umum (FAQ)",
  contact_location: "Kontak & Lokasi",
  contact: "Kontak",
  branches: "Direktori Gerai & Cabang",
};

function renderPresetIcon(presetId: VerticalStarterPresetId) {
  switch (presetId) {
    case "company_profile":
      return <Building2Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "professional_services":
      return <BriefcaseIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "travel_umrah":
      return <CompassIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "multi_outlet":
      return <StoreIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />;
  }
}

function renderArtifactIcon(kind: "page" | "offering" | "outlet" | "checklist") {
  switch (kind) {
    case "page":
      return <FileTextIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "offering":
      return <PackageIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "outlet":
      return <MapPinIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />;
    case "checklist":
      return <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />;
  }
}

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

function generateSetupKey(handle: string, presetId: VerticalStarterPresetId): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `v2-${presetId.slice(0, 12)}-${handle.slice(0, 12)}-${Date.now().toString(36)}-${randomPart}`;
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

function extractEditableFields(item: PresetSectionStatusDto) {
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
      item.section.type === "contact_location" ||
      item.section.type === "contact" ||
      item.section.type === "branches"
        ? (item.section.config.address ?? "")
        : "",
    phone:
      item.section.type === "contact_location" ||
      item.section.type === "contact" ||
      item.section.type === "branches"
        ? (item.section.config.phone ?? "")
        : "",
    email:
      item.section.type === "contact_location" ||
      item.section.type === "contact" ||
      item.section.type === "branches"
        ? (item.section.config.email ?? "")
        : "",
  };
}

export function VerticalOnboardingWorkspace({
  tenantHandle,
  workspaceName,
  verticalPresetsApiUrl,
  customizerHref,
  pagesHref,
  initialVerticalState,
}: VerticalOnboardingWorkspaceProps) {
  const [state, setState] = React.useState<VerticalPresetDashboardStateDto>(initialVerticalState);
  const [selectedPresetId, setSelectedPresetId] = React.useState<VerticalStarterPresetId>(
    initialVerticalState.setup?.presetId ?? initialVerticalState.recommendedPresetId,
  );
  const [checklistFilter, setChecklistFilter] = React.useState<"all" | "pending" | "vertical">(
    "all",
  );
  const [manualCheckedIds, setManualCheckedIds] = React.useState<readonly string[]>([]);

  const [draftSections, setDraftSections] = React.useState<readonly PresetSectionStatusDto[]>(
    initialVerticalState.setup?.sections ?? [],
  );
  const [selectedSectionIds, setSelectedSectionIds] = React.useState<readonly string[]>(
    initialVerticalState.setup?.selectedPublishSectionIds ?? [],
  );
  const [hasUnsavedDraftChanges, setHasUnsavedDraftChanges] = React.useState(false);

  const [applyMode, setApplyMode] = React.useState<"preserve_existing" | "merge_draft">(
    "preserve_existing",
  );
  const [pendingSetupKeyByPreset, setPendingSetupKeyByPreset] = React.useState<
    Partial<Record<VerticalStarterPresetId, string>>
  >({});

  const [editingSectionId, setEditingSectionId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState<ReturnType<typeof extractEditableFields> | null>(
    null,
  );

  const [isApplying, setIsApplying] = React.useState(false);
  const [isSavingDraft, setIsSavingDraft] = React.useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isReloading, setIsReloading] = React.useState(false);

  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewViewport, setPreviewViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [previewResult, setPreviewResult] = React.useState<PresetPreviewResultDto | null>(null);
  const [publishDialogOpen, setPublishDialogOpen] = React.useState(false);

  const [lastApplySummary, setLastApplySummary] = React.useState<ApplyVerticalStarterPresetResult | null>(
    null,
  );
  const [errorNotice, setErrorNotice] = React.useState<ApiErrorNotice | null>(null);
  const [successBanner, setSuccessBanner] = React.useState<string | null>(null);

  const isLocked = state.permissions.isLocked || !state.permissions.canMutate;
  const setup = state.setup;
  const basePath = `/dashboard/${encodeURIComponent(tenantHandle)}`;

  const selectedCatalogEntry =
    state.catalog.find((c) => c.id === selectedPresetId) ?? state.catalog[0]!;
  const activeChecklist = state.checklistByPreset[selectedPresetId] ?? state.checklist;

  const filteredChecklistItems = React.useMemo(() => {
    return activeChecklist.items.filter((item) => {
      const isEffectivelyDone = item.status === "done" || manualCheckedIds.includes(item.id);
      if (checklistFilter === "pending") return !isEffectivelyDone;
      if (checklistFilter === "vertical") return item.verticalScope !== "shared";
      return true;
    });
  }, [activeChecklist.items, checklistFilter, manualCheckedIds]);

  const effectiveCompletedCount = React.useMemo(() => {
    return activeChecklist.items.filter(
      (item) => item.status === "done" || manualCheckedIds.includes(item.id),
    ).length;
  }, [activeChecklist.items, manualCheckedIds]);

  const syncFromServerState = React.useCallback((nextState: VerticalPresetDashboardStateDto) => {
    setState(nextState);
    if (nextState.setup) {
      setSelectedPresetId(nextState.setup.presetId);
    }
    setDraftSections(nextState.setup?.sections ?? []);
    setSelectedSectionIds(nextState.setup?.selectedPublishSectionIds ?? []);
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
      const res = await fetch(verticalPresetsApiUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }
      const nextState = (await res.json()) as VerticalPresetDashboardStateDto;
      syncFromServerState(nextState);
      setEditingSectionId(null);
      setEditDraft(null);
      setSuccessBanner("Data preset onboarding terbaru berhasil dimuat ulang.");
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal memuat ulang data preset. Periksa koneksi Anda lalu coba lagi.",
      });
    } finally {
      setIsReloading(false);
    }
  };

  const handleApplyVerticalPreset = async (presetId: VerticalStarterPresetId) => {
    if (isLocked || isApplying) return;
    setSelectedPresetId(presetId);
    setErrorNotice(null);
    setSuccessBanner(null);
    setIsApplying(true);

    const isSwitchingPreset = Boolean(setup && setup.presetId !== presetId);
    const setupKey = pendingSetupKeyByPreset[presetId] ?? generateSetupKey(tenantHandle, presetId);
    setPendingSetupKeyByPreset((prev) => ({ ...prev, [presetId]: setupKey }));

    try {
      const res = await fetch(verticalPresetsApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "apply",
          presetId,
          setupKey,
          applyMode,
          ...(isSwitchingPreset ? { confirmSwitch: true } : {}),
        }),
      });

      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }

      const result = (await res.json()) as ApplyVerticalStarterPresetResult;
      syncFromServerState(result.state);
      setLastApplySummary(result);
      setPendingSetupKeyByPreset((prev) => {
        const next = { ...prev };
        delete next[presetId];
        return next;
      });
      setEditingSectionId(null);
      setEditDraft(null);

      const label = state.catalog.find((c) => c.id === presetId)?.name ?? presetId;
      if (result.alreadyApplied || result.idempotentReplay) {
        setSuccessBanner(
          `Permintaan preset ${label} yang sama terdeteksi sebagai pengulangan aman (idempoten). Tidak ada duplikasi halaman, penawaran, atau gerai.`,
        );
      } else if (result.preservedExistingContent) {
        setSuccessBanner(
          `Komposisi draf ${label} berhasil disiapkan tanpa menghapus atau menimpa halaman, katalog, maupun gerai yang sudah ada.`,
        );
      } else {
        setSuccessBanner(
          `Komposisi draf ${label} dan daftar periksa peluncuran berhasil dibuat. Seluruh data bertanda CONTOH tetap berstatus Draf dan belum tayang.`,
        );
      }
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message:
          "Koneksi terputus saat menerapkan preset. Klik lagi untuk mengulang dengan kunci idempoten yang sama tanpa duplikasi.",
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleOpenPreview = async (presetOverride?: VerticalStarterPresetId) => {
    if (isPreviewLoading) return;
    const targetPresetId = presetOverride ?? selectedPresetId;
    setErrorNotice(null);
    setIsPreviewLoading(true);
    try {
      const res = await fetch(verticalPresetsApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "preview",
          presetId: targetPresetId,
          ...(setup?.presetId === targetPresetId && selectedSectionIds.length > 0
            ? { selectedSectionIds }
            : {}),
        }),
      });

      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }

      const result = (await res.json()) as PresetPreviewResultDto;
      setPreviewResult(result);
      setPreviewOpen(true);
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal memuat pratinjau draf preset. Silakan coba lagi.",
      });
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleToggleSelectSection = (sectionId: string) => {
    if (isLocked) return;
    setSelectedSectionIds((prev) =>
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
          baseCfg.items =
            editDraft.faqQuestion.trim() && editDraft.faqAnswer.trim()
              ? [
                  {
                    question: editDraft.faqQuestion.trim(),
                    answer: editDraft.faqAnswer.trim(),
                    defaultOpen: false,
                  },
                ]
              : [];
        } else if (
          item.section.type === "contact_location" ||
          item.section.type === "contact" ||
          item.section.type === "branches"
        ) {
          baseCfg.address = editDraft.address.trim() || null;
          baseCfg.phone = editDraft.phone.trim() || null;
          baseCfg.email = editDraft.email.trim() || null;
        }

        return {
          ...item,
          section: { ...item.section, config: baseCfg } as PresetSectionStatusDto["section"],
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
      enabled: selectedSectionIds.includes(item.id),
      order: idx,
      config: item.section.config,
    }));

    try {
      const res = await fetch(verticalPresetsApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "save_draft",
          expectedVersion: setup.version,
          sections: payloadSections,
          selectedPublishSectionIds: selectedSectionIds,
        }),
      });
      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        return;
      }
      const nextState = (await res.json()) as VerticalPresetDashboardStateDto;
      syncFromServerState(nextState);
      setSuccessBanner(
        "Perubahan draf preset tersimpan. Situs publik belum berubah hingga Anda menekan Terbitkan Terpilih.",
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

  const handlePublishSelected = async () => {
    if (isLocked || !setup || isPublishing) return;
    setErrorNotice(null);
    setSuccessBanner(null);
    setIsPublishing(true);

    try {
      const res = await fetch(verticalPresetsApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "publish",
          presetId: setup.presetId,
          selectedSectionIds,
          expectedVersion: setup.version,
          confirm: true,
        }),
      });
      if (!res.ok) {
        setErrorNotice(await parseErrorPayload(res));
        setPublishDialogOpen(false);
        return;
      }
      const result = (await res.json()) as PublishVerticalStarterPresetResult;
      syncFromServerState(result.state);
      setPublishDialogOpen(false);
      setSuccessBanner(
        `${result.publishedSectionIds.length} bagian tervalidasi berhasil diterbitkan secara atomik (revisi #${result.revisionNumber}). Draf katalog dan gerai tetap terpisah.`,
      );
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Gagal menerbitkan bagian terpilih. Silakan coba lagi.",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const toggleManualChecklistItem = (itemId: string) => {
    setManualCheckedIds((prev) =>
      prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId],
    );
  };

  const selectedItems = draftSections.filter((s) => selectedSectionIds.includes(s.id));
  const selectedSampleItems = selectedItems.filter((s) => s.containsSampleCopy);

  return (
    <div className="space-y-6 pb-10" data-testid="vertical-onboarding-root">
      {/* Page Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info">Onboarding Preset Pemula</Badge>
            <Badge variant="secondary" className="tabular-nums">
              {setup ? `Draf v${setup.version}` : "4 Vertikal Siap Pakai"}
            </Badge>
            <Badge variant={setup?.status === "published" ? "success" : "outline"}>
              {setup?.status === "published" ? "Sebagian / Semua Terbit" : "Draf Saja — Belum Tayang"}
            </Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Pilih Preset Pemula Berdasarkan Jenis Usaha
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Siapkan komposisi halaman awal, templat modul vertikal, dan daftar periksa peluncuran
            untuk <strong className="font-medium text-foreground">{workspaceName}</strong>.
            Seluruh hasil preset dibuat sebagai <strong className="font-medium text-foreground">Draf</strong>{" "}
            bertanda <strong className="font-medium text-foreground">CONTOH</strong> tanpa klaim fiktif.
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
            <RefreshCwIcon className={isReloading ? "animate-spin" : ""} aria-hidden="true" />
            Muat Ulang
          </Button>
          <Button
            variant="outline"
            size="default"
            className="min-h-11 sm:min-h-9"
            onClick={() => handleOpenPreview(selectedPresetId)}
            disabled={isPreviewLoading}
            data-testid="preview-selected-vertical-btn"
          >
            <EyeIcon aria-hidden="true" />
            {isPreviewLoading ? "Memuat Pratinjau..." : "Pratinjau Draf"}
          </Button>
          <Button
            variant="secondary"
            size="default"
            className="min-h-11 sm:min-h-9"
            render={<a href={customizerHref} />}
          >
            Kustomisasi Tema
          </Button>
        </div>
      </header>

      {/* Locked Tenant Read-Only Banner */}
      {isLocked && (
        <Alert variant="warning" data-testid="preset-locked-banner">
          <LockIcon aria-hidden="true" />
          <AlertTitle>Mode Hanya Baca — Situs Terkunci</AlertTitle>
          <AlertDescription>
            Status langganan situs sedang terkunci. Anda tetap dapat meninjau pilihan vertikal,
            pratinjau draf, dan daftar periksa, namun penerapan preset dan penerbitan dinonaktifkan
            hingga perpanjangan selesai.
          </AlertDescription>
        </Alert>
      )}

      {/* Anti-Fabrication & Draft-Only Guardrail Notice */}
      <Alert variant="info" data-testid="vertical-anti-fabrication-notice">
        <ShieldCheckIcon aria-hidden="true" />
        <AlertTitle>Jaminan Draf Saja & Anti-Fabrikasi</AlertTitle>
        <AlertDescription>
          Setiap halaman, penawaran layanan/travel, dan templat gerai yang dibuat preset berstatus{" "}
          <strong>Draf</strong> (tidak otomatis tayang ke publik). Seluruh teks awal bertanda{" "}
          <strong>CONTOH</strong> — nol harga palsu, nol ulasan atau rating fiktif, nol izin SK PPIU
          buatan, dan nol alamat atau koordinat karangan.
        </AlertDescription>
      </Alert>

      {/* Populated Tenant Protection Notice */}
      {state.contentSummary.isPopulatedTenant && (
        <Alert variant="info" data-testid="preset-populated-notice">
          <ShieldCheckIcon aria-hidden="true" />
          <AlertTitle>Konten Eksisting Tetap Terjaga Utuh</AlertTitle>
          <AlertDescription>
            Situs ini sudah memiliki{" "}
            <span className="font-medium tabular-nums">
              {state.contentSummary.pages} halaman, {state.contentSummary.offerings} penawaran
              katalog, dan {state.contentSummary.outlets} gerai
            </span>
            . Menerapkan preset tidak akan pernah menghapus, menimpa, atau menurunkan konten lama.
          </AlertDescription>
        </Alert>
      )}

      {/* Permenkes Health Category Notice */}
      {state.isHealthCategory && (
        <Alert variant="warning" data-testid="preset-permenkes-notice">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>Pengingat Kepatuhan Kategori Kesehatan (Permenkes)</AlertTitle>
          <AlertDescription>
            Kategori usaha terdeteksi sebagai layanan kesehatan/medis. Testimoni dinonaktifkan
            secara default dan tidak disarankan mencantumkan klaim hasil pengobatan.
          </AlertDescription>
        </Alert>
      )}

      {/* Error Notice */}
      {errorNotice && (
        <Alert
          variant={errorNotice.code === "STALE_VERSION" ? "warning" : "destructive"}
          role="alert"
          data-testid="preset-error-alert"
        >
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>
            {errorNotice.code === "STALE_VERSION"
              ? "Konflik Versi Draf (409)"
              : errorNotice.code === "SAMPLE_CONTENT_BLOCKED"
                ? "Teks CONTOH Belum Dapat Diterbitkan"
                : errorNotice.code === "IDEMPOTENCY_KEY_CONFLICT"
                  ? "Konflik Kunci Setup (409)"
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

      {/* Success Banner */}
      {successBanner && (
        <Alert variant="success" role="status" data-testid="preset-success-alert">
          <CheckCircle2Icon aria-hidden="true" />
          <AlertTitle>Draf Preset Siap</AlertTitle>
          <AlertDescription>
            <p>{successBanner}</p>
            {lastApplySummary && (
              <p className="mt-1 text-xs tabular-nums">
                Ringkasan draf: {lastApplySummary.createdPageSlugs.length} halaman baru,{" "}
                {lastApplySummary.createdOfferingSlugs.length} penawaran draf,{" "}
                {lastApplySummary.createdOutletSlugs.length} templat gerai draf.
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Section 1: 4-Vertical Starter Preset Selector Grid */}
      <section aria-labelledby="vertical-selector-heading" className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="vertical-selector-heading" className="text-lg font-semibold text-foreground">
              1. Pilih Vertikal Usaha (4 Preset Tersedia)
            </h2>
            <p className="text-sm text-muted-foreground">
              Klik salah satu kartu vertikal untuk melihat rincian komposisi draf dan daftar periksa
              peluncurannya.
            </p>
          </div>
          {state.contentSummary.isPopulatedTenant && !isLocked && (
            <fieldset className="flex flex-wrap items-center gap-2 text-xs">
              <legend className="sr-only">Mode penerapan preset pada situs berisi konten</legend>
              <div className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 sm:min-h-9">
                <input
                  id="apply-mode-preserve"
                  type="radio"
                  name="vertical-apply-mode"
                  value="preserve_existing"
                  checked={applyMode === "preserve_existing"}
                  onChange={() => setApplyMode("preserve_existing")}
                  className="accent-primary"
                />
                <label htmlFor="apply-mode-preserve" className="cursor-pointer">
                  Draf terpisah (pertahankan konten lama)
                </label>
              </div>
              <div className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 sm:min-h-9">
                <input
                  id="apply-mode-merge"
                  type="radio"
                  name="vertical-apply-mode"
                  value="merge_draft"
                  checked={applyMode === "merge_draft"}
                  onChange={() => setApplyMode("merge_draft")}
                  className="accent-primary"
                />
                <label htmlFor="apply-mode-merge" className="cursor-pointer">
                  Gabungkan slot draf
                </label>
              </div>
            </fieldset>
          )}
        </div>

        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          data-testid="vertical-preset-grid"
        >
          {state.catalog.map((entry) => {
            const isSelected = selectedPresetId === entry.id;
            const isActiveDraft = setup?.presetId === entry.id;
            const isRecommended = state.recommendedPresetId === entry.id;

            return (
              <Card
                key={entry.id}
                className={
                  isSelected
                    ? "border-primary bg-card ring-1 ring-primary/30"
                    : "border-border bg-card hover:border-primary/40"
                }
                data-testid={`vertical-preset-card-${entry.id}`}
                data-selected={isSelected ? "true" : "false"}
              >
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      {renderPresetIcon(entry.id)}
                      <span>{entry.name}</span>
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={entry.milestone === "M2" ? "info" : "secondary"}>
                        {entry.milestone}
                      </Badge>
                      {isRecommended && !isActiveDraft && (
                        <Badge variant="outline">Rekomendasi</Badge>
                      )}
                      {isActiveDraft && <Badge variant="success">Aktif di Draf</Badge>}
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
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{entry.safetyNote}</p>
                </CardContent>

                <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground">
                    Tema: <strong className="text-foreground">{entry.recommendedThemeId}</strong>
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={isSelected ? "secondary" : "outline"}
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      onClick={() => setSelectedPresetId(entry.id)}
                      aria-pressed={isSelected}
                      data-testid={`select-vertical-${entry.id}`}
                    >
                      {isSelected ? "Sedang Ditinjau" : "Lihat Rincian"}
                    </Button>
                    <Button
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={isLocked || isApplying}
                      onClick={() => handleApplyVerticalPreset(entry.id)}
                      data-testid={`apply-vertical-preset-${entry.id}`}
                    >
                      <LayersIcon aria-hidden="true" />
                      {isApplying && selectedPresetId === entry.id
                        ? "Menyiapkan..."
                        : isActiveDraft
                          ? "Terapkan Ulang"
                          : "Terapkan Draf"}
                    </Button>
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Section 2: Selected Vertical Preview + Interactive Vertical Launch Checklist */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left 7 cols: Selected Vertical Composition Preview & Active Draft Editor */}
        <div className="min-w-0 space-y-6 xl:col-span-7">
          <Card data-testid="selected-vertical-preview">
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="info">{selectedCatalogEntry.verticalModule}</Badge>
                    <Badge variant="outline">Draf · CONTOH</Badge>
                  </div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    {renderPresetIcon(selectedCatalogEntry.id)}
                    <span>Pratinjau Komposisi: {selectedCatalogEntry.name}</span>
                  </CardTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  render={
                    <a href={`${basePath}${selectedCatalogEntry.manageModuleHrefSuffix}`} />
                  }
                >
                  {selectedCatalogEntry.manageModuleLabel}
                  <ChevronRightIcon aria-hidden="true" />
                </Button>
              </div>
              <CardDescription>{selectedCatalogEntry.description}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Aset Draf yang Disiapkan
                </h3>
                {state.contentSummary.isPopulatedTenant && (
                  <p
                    className="mt-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                    data-testid="populated-artifacts-note"
                  >
                    Mode situs berisi konten: seluruh halaman, penawaran katalog, dan gerai lama
                    Anda dipertahankan utuh. Preset hanya menyiapkan komposisi draf beranda tanpa
                    membuat templat penawaran atau gerai baru di atas konten lama.
                  </p>
                )}
                <ul className="mt-2 space-y-2.5">
                  {selectedCatalogEntry.starterArtifacts.map((artifact) => (
                    <li
                      key={artifact.label}
                      className="flex items-start gap-2.5 rounded-md border border-border bg-background/70 p-3"
                    >
                      {renderArtifactIcon(artifact.kind)}
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {artifact.label}
                          </span>
                          <Badge variant="warning">Draf Saja</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{artifact.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              {selectedCatalogEntry.complianceNotice && (
                <Alert
                  variant="warning"
                  data-testid={`compliance-notice-${selectedCatalogEntry.id}`}
                >
                  <ShieldAlertIcon aria-hidden="true" />
                  <AlertTitle>Catatan Kepatuhan Vertikal</AlertTitle>
                  <AlertDescription>{selectedCatalogEntry.complianceNotice}</AlertDescription>
                </Alert>
              )}
            </CardContent>

            <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <Button
                variant="outline"
                size="default"
                className="min-h-11 sm:min-h-9"
                disabled={isPreviewLoading}
                onClick={() => handleOpenPreview(selectedCatalogEntry.id)}
              >
                <EyeIcon aria-hidden="true" />
                Pratinjau Komposisi (Inert)
              </Button>
              <Button
                size="default"
                className="min-h-11 sm:min-h-9"
                disabled={isLocked || isApplying}
                onClick={() => handleApplyVerticalPreset(selectedCatalogEntry.id)}
                data-testid="apply-selected-vertical-btn"
              >
                <LayersIcon aria-hidden="true" />
                {isApplying
                  ? "Menyiapkan Draf..."
                  : `Terapkan Draf ${selectedCatalogEntry.shortName}`}
              </Button>
            </CardFooter>
          </Card>

          {/* Active Draft Section Composer (visible once a preset has been applied) */}
          {setup && (
            <section
              aria-labelledby="active-draft-sections-heading"
              className="space-y-4"
              data-testid="preset-sections-list"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2
                    id="active-draft-sections-heading"
                    className="text-base font-semibold text-foreground"
                  >
                    Komposisi Draf Beranda Aktif ({draftSections.length} bagian)
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Ganti teks <strong>CONTOH</strong> dengan info asli usaha Anda sebelum memilih
                    bagian untuk diterbitkan.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    disabled={isLocked || isSavingDraft || !hasUnsavedDraftChanges}
                    onClick={handleSaveDraft}
                    data-testid="preset-save-draft-btn"
                  >
                    <SaveIcon aria-hidden="true" />
                    {isSavingDraft ? "Menyimpan..." : "Simpan Draf"}
                  </Button>
                  <Button
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    disabled={isLocked || selectedSectionIds.length === 0 || hasUnsavedDraftChanges}
                    onClick={() => setPublishDialogOpen(true)}
                    data-testid="preset-open-publish-btn"
                  >
                    <RocketIcon aria-hidden="true" />
                    Terbitkan Terpilih ({selectedSectionIds.length})
                  </Button>
                </div>
              </div>

              <div className="space-y-2.5">
                {draftSections.map((item, idx) => {
                  const isSelected = selectedSectionIds.includes(item.id);
                  const isEditing = editingSectionId === item.id;
                  const cfg = item.section.config as Record<string, unknown>;
                  const headingText =
                    typeof cfg.heading === "string" && cfg.heading.trim()
                      ? cfg.heading
                      : (SECTION_TYPE_LABELS[item.type] ?? item.type);
                  const checkboxId = `section-check-${item.id}`;

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
                            <div className="mt-0.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background sm:min-h-8 sm:min-w-8">
                              <input
                                id={checkboxId}
                                type="checkbox"
                                checked={isSelected}
                                disabled={isLocked}
                                onChange={() => handleToggleSelectSection(item.id)}
                                className="size-4 accent-primary"
                                data-testid={`select-section-${item.id}`}
                              />
                            </div>
                            <div className="min-w-0 space-y-1">
                              <label
                                htmlFor={checkboxId}
                                className="flex cursor-pointer flex-wrap items-center gap-1.5"
                              >
                                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                                  #{idx + 1}
                                </span>
                                <span className="text-sm font-semibold text-foreground">
                                  {SECTION_TYPE_LABELS[item.type] ?? item.type}
                                </span>
                                {item.containsSampleCopy ? (
                                  <Badge variant="warning" data-testid={`sample-badge-${item.id}`}>
                                    CONTOH (Draf)
                                  </Badge>
                                ) : (
                                  <Badge variant="success" data-testid={`ready-badge-${item.id}`}>
                                    Siap Terbit
                                  </Badge>
                                )}
                                {item.optional && <Badge variant="outline">Opsional</Badge>}
                                {item.isPublished && <Badge variant="info">Terbit</Badge>}
                              </label>
                              <p className="break-words text-xs text-muted-foreground">
                                {headingText}
                              </p>
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-11 sm:min-h-8"
                              disabled={isLocked || idx === 0}
                              onClick={() => handleMoveSection(idx, -1)}
                              aria-label={`Pindahkan ${SECTION_TYPE_LABELS[item.type] ?? item.type} ke atas`}
                            >
                              <ArrowUpIcon aria-hidden="true" />
                              Naik
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-11 sm:min-h-8"
                              disabled={isLocked || idx === draftSections.length - 1}
                              onClick={() => handleMoveSection(idx, 1)}
                              aria-label={`Pindahkan ${SECTION_TYPE_LABELS[item.type] ?? item.type} ke bawah`}
                            >
                              <ArrowDownIcon aria-hidden="true" />
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
                              <PencilIcon aria-hidden="true" />
                              {isEditing ? "Tutup" : "Ubah"}
                            </Button>
                          </div>
                        </div>
                      </CardHeader>

                      {isEditing && editDraft && (
                        <CardContent
                          className="space-y-3 border-t border-border bg-muted/30 pt-4"
                          data-testid={`editor-panel-${item.id}`}
                        >
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                              <label
                                htmlFor={`edit-eyebrow-${item.id}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Label Atas (Eyebrow)
                              </label>
                              <Input
                                id={`edit-eyebrow-${item.id}`}
                                value={editDraft.eyebrow}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, eyebrow: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </div>
                            <div className="space-y-1">
                              <label
                                htmlFor={`edit-heading-${item.id}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Judul Bagian
                              </label>
                              <Input
                                id={`edit-heading-${item.id}`}
                                value={editDraft.heading}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, heading: e.target.value } : prev,
                                  )
                                }
                                className="min-h-11 text-base sm:min-h-9 sm:text-sm"
                              />
                            </div>
                          </div>

                          <div className="space-y-1">
                            <label
                              htmlFor={`edit-subheading-${item.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Subjudul / Deskripsi Ringkas
                            </label>
                            <textarea
                              id={`edit-subheading-${item.id}`}
                              rows={2}
                              value={editDraft.subheading}
                              onChange={(e) =>
                                setEditDraft((prev) =>
                                  prev ? { ...prev, subheading: e.target.value } : prev,
                                )
                              }
                              className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                            />
                          </div>

                          {(item.section.type === "about" || item.section.type === "rich_text") && (
                            <div className="space-y-1">
                              <label
                                htmlFor={`edit-body-${item.id}`}
                                className="block text-xs font-medium text-foreground"
                              >
                                Isi Teks Bagian
                              </label>
                              <textarea
                                id={`edit-body-${item.id}`}
                                rows={3}
                                value={editDraft.bodyText}
                                onChange={(e) =>
                                  setEditDraft((prev) =>
                                    prev ? { ...prev, bodyText: e.target.value } : prev,
                                  )
                                }
                                className="w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
                              />
                            </div>
                          )}

                          <div className="flex flex-wrap justify-end gap-2">
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
            </section>
          )}
        </div>

        {/* Right 5 cols: Interactive Vertical Launch Checklist */}
        <aside
          aria-labelledby="vertical-checklist-heading"
          className="min-w-0 space-y-4 xl:col-span-5"
        >
          <Card data-testid="vertical-launch-checklist">
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle id="vertical-checklist-heading" className="text-base">
                  Daftar Periksa Peluncuran · {selectedCatalogEntry.shortName}
                </CardTitle>
                <Badge variant="secondary" className="tabular-nums">
                  {effectiveCompletedCount}/{activeChecklist.totalCount} selesai
                </Badge>
              </div>
              <CardDescription>
                Tinjau kesiapan inti dan kebutuhan khusus modul{" "}
                <strong className="text-foreground">{selectedCatalogEntry.shortName}</strong>{" "}
                sebelum menerbitkan situs.
              </CardDescription>

              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter daftar periksa">
                <Button
                  variant={checklistFilter === "all" ? "default" : "outline"}
                  size="sm"
                  className="min-h-10 sm:min-h-8"
                  onClick={() => setChecklistFilter("all")}
                  data-testid="checklist-filter-all"
                >
                  Semua ({activeChecklist.totalCount})
                </Button>
                <Button
                  variant={checklistFilter === "pending" ? "default" : "outline"}
                  size="sm"
                  className="min-h-10 sm:min-h-8"
                  onClick={() => setChecklistFilter("pending")}
                  data-testid="checklist-filter-pending"
                >
                  Belum Selesai
                </Button>
                <Button
                  variant={checklistFilter === "vertical" ? "default" : "outline"}
                  size="sm"
                  className="min-h-10 sm:min-h-8"
                  onClick={() => setChecklistFilter("vertical")}
                  data-testid="checklist-filter-vertical"
                >
                  Khusus Vertikal
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-2.5">
              {filteredChecklistItems.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  Semua poin pada filter ini sudah selesai ditinjau.
                </p>
              ) : (
                filteredChecklistItems.map((item) => {
                  const isDone = item.status === "done" || manualCheckedIds.includes(item.id);
                  const checkInputId = `checklist-toggle-${selectedPresetId}-${item.id}`;
                  return (
                    <div
                      key={item.id}
                      className="rounded-md border border-border bg-background/60 p-3"
                      data-testid={`checklist-item-${item.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <input
                            id={checkInputId}
                            type="checkbox"
                            checked={isDone}
                            disabled={item.status === "done"}
                            onChange={() => toggleManualChecklistItem(item.id)}
                            className="mt-1 size-4 shrink-0 accent-primary"
                            data-testid={`checklist-checkbox-${item.id}`}
                          />
                          <div className="min-w-0 space-y-1">
                            <label
                              htmlFor={checkInputId}
                              className="block cursor-pointer text-sm font-medium text-foreground"
                            >
                              {item.label}
                            </label>
                            <p className="break-words text-xs text-muted-foreground">
                              {item.detail}
                            </p>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <Badge
                            variant={
                              isDone
                                ? "success"
                                : item.requiredForPublish
                                  ? "warning"
                                  : "outline"
                            }
                          >
                            {isDone
                              ? "Selesai"
                              : item.requiredForPublish
                                ? "Utama"
                                : "Opsional"}
                          </Badge>
                          {item.verticalScope !== "shared" && (
                            <Badge variant="info">Vertikal</Badge>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                        {item.officialHelpUrl && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-h-10 text-xs sm:min-h-7"
                            render={
                              <a
                                href={item.officialHelpUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              />
                            }
                          >
                            Panduan Google
                            <ExternalLinkIcon aria-hidden="true" />
                          </Button>
                        )}
                        {item.id === "preview" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-10 px-2 text-xs sm:min-h-7"
                            onClick={() => handleOpenPreview(selectedPresetId)}
                          >
                            {item.actionLabel}
                            <ChevronRightIcon aria-hidden="true" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-10 px-2 text-xs sm:min-h-7"
                            render={<a href={item.actionHref} />}
                          >
                            {item.actionLabel}
                            <ChevronRightIcon aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>

            <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>
                Pembaruan draf:{" "}
                <span className="tabular-nums">
                  {formatDateTimeId(setup?.updatedAt ?? null) ?? "Belum diterapkan"}
                </span>
              </span>
              <Button
                variant="link"
                size="sm"
                className="min-h-10 px-1 text-xs sm:min-h-7"
                render={<a href={pagesHref} />}
              >
                Semua Halaman
              </Button>
            </CardFooter>
          </Card>
        </aside>
      </div>

      {/* Responsive Inert Preview Dialog (@base-ui/react/dialog) */}
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
                  <MonitorIcon aria-hidden="true" />
                  Desktop
                </Button>
                <Button
                  variant={previewViewport === "mobile" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPreviewViewport("mobile")}
                  data-testid="preview-viewport-mobile"
                >
                  <SmartphoneIcon aria-hidden="true" />
                  Seluler
                </Button>
                <DialogPrimitive.Close
                  render={<Button variant="ghost" size="icon-sm" aria-label="Tutup pratinjau" />}
                >
                  <XIcon aria-hidden="true" />
                </DialogPrimitive.Close>
              </div>
            </div>

            {previewResult?.hasSampleContent && (
              <div className="border-b border-warning-border bg-warning-soft px-4 py-2 text-xs text-warning">
                Pratinjau memuat teks bertanda <strong>CONTOH</strong>. Ubah teks contoh dengan data
                resmi usaha Anda sebelum menerbitkan.
              </div>
            )}

            <div className="flex flex-1 justify-center overflow-auto bg-muted/50 p-4">
              {previewResult ? (
                <iframe
                  title="Pratinjau draf preset vertikal"
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
                  yang akan diterbitkan ke beranda publik. Draf penawaran dan gerai tetap terpisah.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close
                render={<Button variant="ghost" size="icon-sm" aria-label="Tutup dialog" />}
              >
                <XIcon aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>

            {selectedSampleItems.length > 0 && (
              <Alert variant="warning" className="mt-4" data-testid="publish-sample-warning">
                <AlertTriangleIcon aria-hidden="true" />
                <AlertTitle>Teks CONTOH Terdeteksi</AlertTitle>
                <AlertDescription>
                  {selectedSampleItems.length} bagian terpilih masih memuat teks{" "}
                  <strong>CONTOH</strong>. Server akan menolak penerbitan hingga teks contoh diubah
                  atau bagian tersebut dibatalkan pilihannya.
                </AlertDescription>
              </Alert>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <DialogPrimitive.Close
                render={<Button variant="outline" className="min-h-11 sm:min-h-9" />}
              >
                Batal
              </DialogPrimitive.Close>
              <Button
                className="min-h-11 sm:min-h-9"
                disabled={isPublishing || selectedItems.length === 0}
                onClick={handlePublishSelected}
                data-testid="preset-confirm-publish-btn"
              >
                <RocketIcon aria-hidden="true" />
                {isPublishing ? "Menerbitkan..." : "Ya, Terbitkan Sekarang"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
