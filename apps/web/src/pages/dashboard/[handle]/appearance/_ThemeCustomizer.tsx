import * as React from "react";
import { PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import {
  PERMENKES_TESTIMONIALS_WARNING_MESSAGE,
  THEME_NUMERIC_BOUNDS,
  type AllowedThemeFont,
  type AnyValidatedPageSection,
  type ThemeTokens,
  type ThemeVariants,
} from "@punyasitus/core/theme/index";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  GaugeIcon,
  LockIcon,
  MonitorIcon,
  PaletteIcon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { ThemeCustomizerAdminState } from "../../../api/tenants/[tenantId]/theme/_shared.ts";
import {
  applyPresetPaletteToTokens,
  buildHomepageSnapshotFromSections,
  evaluateColorContrastStatus,
  getSectionHeadingPreview,
  getSectionLabelId,
  moveSectionInList,
  toggleSectionInList,
  validateThemeCustomizerTokens,
} from "./_customizer-helpers.ts";

export interface ThemeCustomizerProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly themeApiUrl: string;
  readonly publishApiUrl: string;
  readonly previewApiUrl: string;
  readonly initialState: ThemeCustomizerAdminState;
  readonly initialPreviewHtml: string | null;
}

interface ApiErrorNotice {
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[];
}

const RADIUS_PRESETS = [0, 4, 8, 12, 16] as const;

export function ThemeCustomizer({
  tenantHandle,
  workspaceName,
  themeApiUrl,
  publishApiUrl,
  previewApiUrl,
  initialState,
  initialPreviewHtml,
}: ThemeCustomizerProps) {
  const [themeId, setThemeId] = React.useState<string>(initialState.themeId);
  const [homepageSlug, setHomepageSlug] = React.useState<string>(initialState.homepageSlug);
  const [homepageTitle, setHomepageTitle] = React.useState<string>(initialState.homepageTitle);
  const [tokens, setTokens] = React.useState<ThemeTokens>(initialState.draft.tokens);
  const [variants, setVariants] = React.useState<ThemeVariants>(initialState.draft.variants);
  const [sections, setSections] = React.useState<readonly AnyValidatedPageSection[]>(
    initialState.draft.sections,
  );
  const [primaryInput, setPrimaryInput] = React.useState<string>(
    initialState.draft.tokens.primaryColor,
  );
  const [secondaryInput, setSecondaryInput] = React.useState<string>(
    initialState.draft.tokens.secondaryColor,
  );

  const [publishedState, setPublishedState] = React.useState(initialState.published);
  const [version, setVersion] = React.useState<number>(initialState.version);
  const [rowVersions, setRowVersions] = React.useState(initialState.versions);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = React.useState<boolean>(
    initialState.hasUnpublishedChanges,
  );
  const [isDirty, setIsDirty] = React.useState<boolean>(false);
  const [cacheVersion, setCacheVersion] = React.useState<number | null>(null);

  const [previewViewport, setPreviewViewport] = React.useState<"mobile" | "desktop">("desktop");
  const [mobilePanel, setMobilePanel] = React.useState<"edit" | "preview">("edit");
  const [previewHtml, setPreviewHtml] = React.useState<string | null>(initialPreviewHtml);
  const [isPreviewLoading, setIsPreviewLoading] = React.useState<boolean>(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const previewRequestSeqRef = React.useRef<number>(0);
  const previewAbortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
    };
  }, []);

  const [isSaving, setIsSaving] = React.useState<boolean>(false);
  const [isPublishing, setIsPublishing] = React.useState<boolean>(false);
  const [isReloading, setIsReloading] = React.useState<boolean>(false);
  const [conflictError, setConflictError] = React.useState<string | null>(null);
  const [apiError, setApiError] = React.useState<ApiErrorNotice | null>(null);
  const [successMessage, setSuccessMessage] = React.useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = React.useState<string>("");

  const isLocked = initialState.permissions.isLocked;
  const isEditorReadOnly = !isLocked && !initialState.permissions.canEdit;
  const isReadOnly = !initialState.permissions.canEdit || isLocked;

  const surfaceHex = tokens.surfaceColor ?? "#ffffff";
  const primaryContrast = React.useMemo(
    () => evaluateColorContrastStatus(primaryInput, surfaceHex),
    [primaryInput, surfaceHex],
  );
  const secondaryContrast = React.useMemo(
    () => evaluateColorContrastStatus(secondaryInput, surfaceHex),
    [secondaryInput, surfaceHex],
  );

  const enabledSectionCount = React.useMemo(
    () => sections.filter((s) => s.enabled).length,
    [sections],
  );

  const hydrateFromServerState = React.useCallback((next: ThemeCustomizerAdminState) => {
    setThemeId(next.themeId);
    setHomepageSlug(next.homepageSlug);
    setHomepageTitle(next.homepageTitle);
    setTokens(next.draft.tokens);
    setVariants(next.draft.variants);
    setSections(next.draft.sections);
    setPrimaryInput(next.draft.tokens.primaryColor);
    setSecondaryInput(next.draft.tokens.secondaryColor);
    setPublishedState(next.published);
    setVersion(next.version);
    setRowVersions(next.versions);
    setHasUnpublishedChanges(next.hasUnpublishedChanges);
    setIsDirty(false);
  }, []);

  const refreshDraftPreview = React.useCallback(
    async (
      nextTokens: ThemeTokens,
      nextVariants: ThemeVariants,
      nextSections: readonly AnyValidatedPageSection[],
    ) => {
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      const requestSeq = ++previewRequestSeqRef.current;

      setIsPreviewLoading(true);
      setPreviewError(null);

      try {
        const body = isReadOnly
          ? { resourceKind: "home" as const }
          : {
              resourceKind: "home" as const,
              themeId,
              draftOverride: {
                themeConfig: {
                  themeId,
                  tokens: nextTokens,
                  variants: nextVariants,
                },
                page: buildHomepageSnapshotFromSections(nextSections, {
                  slug: homepageSlug,
                  title: homepageTitle,
                }),
              },
            };

        const response = await fetch(previewApiUrl, {
          method: "POST",
          credentials: "same-origin",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });

        if (requestSeq !== previewRequestSeqRef.current) {
          return;
        }

        const rawText = await response.text();
        if (requestSeq !== previewRequestSeqRef.current) {
          return;
        }

        let parsed: Record<string, unknown> | null;
        try {
          parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }

        if (!response.ok || !parsed || typeof parsed.html !== "string") {
          const errObj =
            parsed?.error && typeof parsed.error === "object"
              ? (parsed.error as Record<string, unknown>)
              : null;
          setPreviewError(
            typeof errObj?.message === "string"
              ? errObj.message
              : "Pratinjau draf sementara tidak dapat diperbarui.",
          );
          return;
        }

        setPreviewHtml(parsed.html);
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestSeq !== previewRequestSeqRef.current ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }
        setPreviewError("Koneksi terputus saat memuat pratinjau draf.");
      } finally {
        if (requestSeq === previewRequestSeqRef.current) {
          setIsPreviewLoading(false);
        }
      }
    },
    [homepageSlug, homepageTitle, isReadOnly, previewApiUrl, themeId],
  );

  // Trigger initial preview fetch if SSR did not pre-render HTML, and debounced live updates on edit
  const didMountRef = React.useRef(false);
  React.useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      if (!initialPreviewHtml) {
        void refreshDraftPreview(tokens, variants, sections);
      }
      return;
    }

    if (isReadOnly) return;
    if (!primaryContrast.valid || !secondaryContrast.valid) return;

    const timer = window.setTimeout(() => {
      void refreshDraftPreview(tokens, variants, sections);
    }, 220);

    return () => window.clearTimeout(timer);
  }, [
    initialPreviewHtml,
    isReadOnly,
    primaryContrast.valid,
    refreshDraftPreview,
    secondaryContrast.valid,
    sections,
    tokens,
    variants,
  ]);

  const handlePrimaryColorChange = (raw: string) => {
    setPrimaryInput(raw);
    setSuccessMessage(null);
    const check = evaluateColorContrastStatus(raw, surfaceHex);
    if (check.valid && check.normalizedHex) {
      setTokens((prev) => ({ ...prev, primaryColor: check.normalizedHex! }));
      setIsDirty(true);
    }
  };

  const handleSecondaryColorChange = (raw: string) => {
    setSecondaryInput(raw);
    setSuccessMessage(null);
    const check = evaluateColorContrastStatus(raw, surfaceHex);
    if (check.valid && check.normalizedHex) {
      setTokens((prev) => ({ ...prev, secondaryColor: check.normalizedHex! }));
      setIsDirty(true);
    }
  };

  const handleApplyPreset = (presetThemeId: string) => {
    if (isReadOnly) return;
    const preset = initialState.availableThemes.find((t) => t.themeId === presetThemeId);
    if (!preset) return;
    const nextTokens = applyPresetPaletteToTokens(tokens, preset.tokens);
    setTokens(nextTokens);
    setPrimaryInput(nextTokens.primaryColor);
    setSecondaryInput(nextTokens.secondaryColor);
    setIsDirty(true);
    setSuccessMessage(null);
    setApiError(null);
    setLiveAnnouncement(`Palet preset ${preset.label} diterapkan ke draf.`);
  };

  const handleBorderRadiusChange = (nextRadius: number) => {
    if (isReadOnly) return;
    const clamped = Math.max(
      THEME_NUMERIC_BOUNDS.borderRadiusPx.min,
      Math.min(THEME_NUMERIC_BOUNDS.borderRadiusPx.max, Math.round(nextRadius)),
    );
    setTokens((prev) => ({ ...prev, borderRadiusPx: clamped }));
    setIsDirty(true);
    setSuccessMessage(null);
  };

  const handleFontChange = (font: AllowedThemeFont) => {
    if (isReadOnly) return;
    setTokens((prev) => {
      const { headingFontFamily: _clearedHeadingFont, ...rest } = prev;
      void _clearedHeadingFont;
      return {
        ...rest,
        fontFamily: font,
      };
    });
    setIsDirty(true);
    setSuccessMessage(null);
  };

  const handleFastestSystemFontToggle = () => {
    if (isReadOnly) return;
    setTokens((prev) => {
      const nextVal = !prev.fastestSystemFont;
      setLiveAnnouncement(
        nextVal
          ? "Mode tercepat (font sistem) diaktifkan."
          : "Mode tercepat (font sistem) dinonaktifkan.",
      );
      return { ...prev, fastestSystemFont: nextVal };
    });
    setIsDirty(true);
    setSuccessMessage(null);
  };

  const handleMoveSection = (index: number, direction: "up" | "down") => {
    if (isReadOnly) return;
    const result = moveSectionInList(sections, index, direction);
    if (!result.changed) return;
    setSections(result.sections);
    setIsDirty(true);
    setSuccessMessage(null);
    setLiveAnnouncement(result.announcement);
  };

  const handleToggleSection = (sectionId: string) => {
    if (isReadOnly) return;
    const result = toggleSectionInList(sections, sectionId);
    if (!result.changed) return;
    setSections(result.sections);
    setIsDirty(true);
    setSuccessMessage(null);
    setLiveAnnouncement(result.announcement);
  };

  const handleReloadLatest = async () => {
    setIsReloading(true);
    setApiError(null);
    try {
      const response = await fetch(themeApiUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        setApiError({
          code: "RELOAD_FAILED",
          message: "Gagal memuat ulang versi terbaru dari server.",
        });
        return;
      }
      const nextState = (await response.json()) as ThemeCustomizerAdminState;
      hydrateFromServerState(nextState);
      setConflictError(null);
      setSuccessMessage("Versi terbaru berhasil dimuat ulang dari server.");
      setLiveAnnouncement("Pengaturan tema disinkronkan ke versi terbaru.");
      await refreshDraftPreview(
        nextState.draft.tokens,
        nextState.draft.variants,
        nextState.draft.sections,
      );
    } catch {
      setApiError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat ulang versi terbaru.",
      });
    } finally {
      setIsReloading(false);
    }
  };

  const persistDraftToServer = async (): Promise<ThemeCustomizerAdminState | null> => {
    if (!primaryContrast.valid || !secondaryContrast.valid) {
      setApiError({
        code: "VALIDATION_ERROR",
        message: "Periksa format warna hex pada Warna Utama dan Warna Sekunder sebelum menyimpan.",
      });
      return null;
    }

    const tokenCheck = validateThemeCustomizerTokens(themeId, tokens, variants);
    if (!tokenCheck.ok) {
      setApiError({
        code: "VALIDATION_ERROR",
        message: tokenCheck.message,
      });
      return null;
    }

    const tokensPayload: Record<string, unknown> = {
      ...tokenCheck.snapshot.tokens,
      ...(tokenCheck.snapshot.tokens.headingFontFamily === undefined
        ? { headingFontFamily: null }
        : {}),
    };

    const response = await fetch(themeApiUrl, {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        tokens: tokensPayload,
        variants: tokenCheck.snapshot.variants,
        sections,
        expectedVersion: version,
        expectedVersions: rowVersions,
      }),
    });

    const rawText = await response.text();
    let parsed: Record<string, unknown> | null;
    try {
      parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }

    if (response.status === 409) {
      const errObj =
        parsed?.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : null;
      setConflictError(
        typeof errObj?.message === "string"
          ? errObj.message
          : "Pengaturan tema telah diubah di tab atau sesi lain (409 STALE_VERSION). Muat ulang versi terbaru sebelum menyimpan.",
      );
      setLiveAnnouncement("Konflik versi terdeteksi. Silakan muat ulang versi terbaru.");
      return null;
    }

    if (!response.ok || !parsed) {
      const errObj =
        parsed?.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : null;
      const fields = Array.isArray(errObj?.fields)
        ? (errObj.fields as { field: string; code: string; message: string }[])
        : undefined;
      setApiError({
        code: typeof errObj?.code === "string" ? errObj.code : `HTTP_${response.status}`,
        message:
          typeof errObj?.message === "string"
            ? errObj.message
            : "Gagal menyimpan draf tampilan. Perubahan lokal Anda tetap dipertahankan.",
        fields,
      });
      return null;
    }

    const saved = parsed as unknown as ThemeCustomizerAdminState;
    hydrateFromServerState(saved);
    setConflictError(null);
    setApiError(null);
    return saved;
  };

  const handleSaveDraft = async () => {
    if (isReadOnly || isSaving || isPublishing) return;
    setIsSaving(true);
    setApiError(null);
    setSuccessMessage(null);
    try {
      const saved = await persistDraftToServer();
      if (saved) {
        setSuccessMessage(
          `Draf tampilan berhasil disimpan (v${saved.version}). Situs publik belum berubah sampai Anda menerbitkannya.`,
        );
        setLiveAnnouncement(`Draf tampilan tersimpan pada versi ${saved.version}.`);
        await refreshDraftPreview(saved.draft.tokens, saved.draft.variants, saved.draft.sections);
      }
    } catch {
      setApiError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menyimpan draf. Perubahan Anda belum hilang.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async () => {
    if (isReadOnly || isSaving || isPublishing) return;
    setIsPublishing(true);
    setApiError(null);
    setSuccessMessage(null);

    try {
      let versionToPublish = version;
      let rowVersionsToPublish = rowVersions;
      if (isDirty) {
        const saved = await persistDraftToServer();
        if (!saved) {
          return;
        }
        versionToPublish = saved.version;
        rowVersionsToPublish = saved.versions;
      }

      const response = await fetch(publishApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          expectedVersion: versionToPublish,
          expectedVersions: rowVersionsToPublish,
        }),
      });

      const rawText = await response.text();
      let parsed: Record<string, unknown> | null;
      try {
        parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }

      if (response.status === 409) {
        const errObj =
          parsed?.error && typeof parsed.error === "object"
            ? (parsed.error as Record<string, unknown>)
            : null;
        setConflictError(
          typeof errObj?.message === "string"
            ? errObj.message
            : "Versi tema telah berubah di sesi lain (409 STALE_VERSION). Muat ulang versi terbaru sebelum menerbitkan.",
        );
        setLiveAnnouncement("Konflik versi saat menerbitkan. Silakan muat ulang.");
        return;
      }

      if (!response.ok || !parsed) {
        const errObj =
          parsed?.error && typeof parsed.error === "object"
            ? (parsed.error as Record<string, unknown>)
            : null;
        setApiError({
          code: typeof errObj?.code === "string" ? errObj.code : `HTTP_${response.status}`,
          message:
            typeof errObj?.message === "string"
              ? errObj.message
              : "Gagal menerbitkan perubahan tema.",
        });
        return;
      }

      const publishedPayload = parsed as unknown as ThemeCustomizerAdminState & {
        readonly cacheVersion?: number;
      };
      hydrateFromServerState(publishedPayload);
      if (typeof publishedPayload.cacheVersion === "number") {
        setCacheVersion(publishedPayload.cacheVersion);
      }
      setConflictError(null);
      setApiError(null);
      setSuccessMessage(
        `Perubahan tema & susunan beranda berhasil diterbitkan secara atomik (v${publishedPayload.version}${
          typeof publishedPayload.cacheVersion === "number"
            ? `, revisi cache #${publishedPayload.cacheVersion}`
            : ""
        }).`,
      );
      setLiveAnnouncement("Perubahan tema berhasil diterbitkan ke situs publik.");
      await refreshDraftPreview(
        publishedPayload.draft.tokens,
        publishedPayload.draft.variants,
        publishedPayload.draft.sections,
      );
    } catch {
      setApiError({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat menerbitkan perubahan. Silakan coba lagi.",
      });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div
      className="space-y-4"
      data-testid="theme-customizer-root"
      data-tenant-handle={tenantHandle}
      data-theme-id={themeId}
      data-version={version}
    >
      {/* Persistent Screen Reader Live Region */}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="customizer-live-status"
      >
        {liveAnnouncement}
      </p>

      {/* Top Context & Action Bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" data-testid="customizer-theme-badge">
                <PaletteIcon className="size-3.5" aria-hidden="true" />
                Tema: {themeId}
              </Badge>
              <Badge
                variant="secondary"
                className="tabular-nums"
                data-testid="customizer-version-badge"
              >
                v{version}
              </Badge>
              {isDirty || hasUnpublishedChanges ? (
                <Badge variant="warning" data-testid="customizer-draft-status-badge">
                  {isDirty ? "Perubahan belum disimpan" : "Draf belum diterbitkan"}
                </Badge>
              ) : (
                <Badge variant="success" data-testid="customizer-published-status-badge">
                  <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                  Sudah terbit
                </Badge>
              )}
              {cacheVersion !== null && (
                <Badge
                  variant="info"
                  className="tabular-nums"
                  data-testid="customizer-cache-version-badge"
                >
                  Cache #{cacheVersion}
                </Badge>
              )}
            </div>
            <h1 className="!m-0 !text-xl !leading-snug font-bold tracking-[-0.02em] text-foreground">
              Sesuaikan Tampilan — {workspaceName}
            </h1>
            <p className="text-xs leading-normal text-muted-foreground">
              Atur warna merek (kontras WCAG AA), tipografi, sudut komponen, serta urutan dan
              visibilitas bagian beranda. Perubahan disimpan ke draf terlebih dahulu hingga Anda
              menerbitkannya.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
            <Button
              type="button"
              variant="outline"
              disabled={isReadOnly || isSaving || isPublishing}
              aria-busy={isSaving}
              data-testid="customizer-save-draft-btn"
              className="min-h-11 flex-1 sm:flex-none md:min-h-9"
              onClick={handleSaveDraft}
            >
              <SaveIcon className="size-4" aria-hidden="true" />
              <span>{isSaving ? "Menyimpan..." : "Simpan Draf"}</span>
            </Button>

            <Button
              type="button"
              variant="default"
              disabled={isReadOnly || isSaving || isPublishing}
              aria-busy={isPublishing}
              data-testid="customizer-publish-btn"
              className="min-h-11 flex-1 sm:flex-none md:min-h-9"
              onClick={handlePublish}
            >
              <SendIcon className="size-4" aria-hidden="true" />
              <span>{isPublishing ? "Menerbitkan..." : "Terbitkan Perubahan"}</span>
            </Button>
          </div>
        </div>

        {/* Published snapshot status strip */}
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground"
          data-testid="customizer-published-summary"
        >
          <span>
            Status publik:{" "}
            {publishedState ? (
              <strong className="font-medium text-foreground">
                Warna utama{" "}
                <span className="font-mono">{publishedState.tokens.primaryColor}</span> &bull;{" "}
                <span className="tabular-nums">{publishedState.sections.length}</span> bagian aktif
              </strong>
            ) : (
              <strong className="font-medium text-foreground">Belum pernah diterbitkan</strong>
            )}
          </span>
          <span className="tabular-nums">
            Draf aktif: {enabledSectionCount} dari {sections.length} bagian ditampilkan
          </span>
        </div>
      </div>

      {/* Editor 403 Read-Only Notice */}
      {isEditorReadOnly && (
        <Alert variant="warning" data-testid="customizer-readonly-editor-banner">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Mode Baca Saja — Akses Editor Terbatas (403)</AlertTitle>
          <AlertDescription>
            Peran <strong>Editor</strong> hanya dapat meninjau konfigurasi tema dan tidak memiliki
            izin untuk mengubah atau menerbitkan tampilan situs. Hubungi Pemilik atau Admin situs
            untuk melakukan perubahan tema.
          </AlertDescription>
        </Alert>
      )}

      {/* Locked Subscription Read-Only Notice */}
      {isLocked && (
        <Alert variant="warning" data-testid="customizer-readonly-locked-banner">
          <LockIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Situs Terkunci — Perubahan Tampilan Dinonaktifkan</AlertTitle>
          <AlertDescription>
            Langganan situs sedang dalam status <strong>{initialState.permissions.tenantStatus}</strong>{" "}
            sehingga seluruh penyimpanan draf dan publikasi tema dinonaktifkan sementara
            (<code>SUBSCRIPTION_LOCKED</code>). Perpanjang langganan untuk mengaktifkan kembali
            editor tampilan.
          </AlertDescription>
        </Alert>
      )}

      {/* 409 STALE_VERSION Conflict Recovery Banner */}
      {conflictError && (
        <Alert variant="destructive" data-testid="customizer-conflict-banner">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Konflik Versi Terdeteksi (409 STALE_VERSION)</AlertTitle>
          <AlertDescription>
            {conflictError} Muat ulang versi terbaru agar perubahan tim lain tidak tertimpa.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isReloading}
              data-testid="customizer-conflict-reload-btn"
              className="min-h-11 md:min-h-8"
              onClick={handleReloadLatest}
            >
              <RefreshCwIcon
                className={`size-4 ${isReloading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>{isReloading ? "Memuat ulang..." : "Muat Ulang Versi Terbaru"}</span>
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* Validation / Network Error Banner (preserves user inputs) */}
      {apiError && (
        <Alert
          variant="destructive"
          data-testid="customizer-error-banner"
          data-error-code={apiError.code}
        >
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memproses perubahan tema ({apiError.code})</AlertTitle>
          <AlertDescription>
            <p>{apiError.message}</p>
            {apiError.fields && apiError.fields.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {apiError.fields.map((f, idx) => (
                  <li key={`${f.field}-${idx}`}>
                    <strong>{f.field}</strong>: {f.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Success Feedback Banner */}
      {successMessage && (
        <Alert variant="success" role="status" data-testid="customizer-success-banner">
          <CheckCircle2Icon className="size-4" aria-hidden="true" />
          <AlertTitle>Berhasil</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {/* Mobile Edit / Preview Switcher (< 1024px) */}
      <div
        role="tablist"
        aria-label="Mode editor tampilan"
        className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/50 p-1 lg:hidden"
        data-testid="customizer-mobile-tabs"
      >
        <Button
          type="button"
          role="tab"
          aria-selected={mobilePanel === "edit"}
          variant={mobilePanel === "edit" ? "default" : "ghost"}
          className="min-h-11 w-full"
          data-testid="customizer-mobile-tab-edit"
          onClick={() => setMobilePanel("edit")}
        >
          <PaletteIcon className="size-4" aria-hidden="true" />
          <span>Edit Tampilan</span>
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={mobilePanel === "preview"}
          variant={mobilePanel === "preview" ? "default" : "ghost"}
          className="min-h-11 w-full"
          data-testid="customizer-mobile-tab-preview"
          onClick={() => setMobilePanel("preview")}
        >
          <EyeIcon className="size-4" aria-hidden="true" />
          <span>Pratinjau</span>
        </Button>
      </div>

      {/* Main Split Workspace: Controls (left) + Live Sandboxed Preview (right) */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        {/* Left Pane: Token Editor + Accessible Section Composer */}
        <div
          className={`min-w-0 space-y-4 ${mobilePanel === "preview" ? "hidden lg:block" : "block"}`}
          data-testid="customizer-controls-pane"
        >
          {/* 1. Token Editor Card */}
          <Card data-testid="token-editor-card">
            <CardHeader>
              <CardTitle>Token Warna, Tipografi &amp; Sudut</CardTitle>
              <CardDescription>
                Diterapkan langsung ke CSS custom properties tanpa rebuild. Kontras teks dijaga
                minimal 4.5:1 (WCAG AA).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Preset Palette Shortcuts (6 Platform Themes) */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
                    Pintasan Palet 6 Tema Platform
                  </span>
                  <span className="text-xs text-muted-foreground">Terverifikasi AA</span>
                </div>
                <div
                  className="grid grid-cols-2 gap-2"
                  data-testid="preset-palette-list"
                  role="group"
                  aria-label="Pintasan palet tema platform"
                >
                  {initialState.availableThemes.map((preset) => {
                    const isActivePalette =
                      tokens.primaryColor.toLowerCase() ===
                        preset.tokens.primaryColor.toLowerCase() &&
                      tokens.secondaryColor.toLowerCase() ===
                        preset.tokens.secondaryColor.toLowerCase();
                    return (
                      <Button
                        key={preset.themeId}
                        type="button"
                        title={preset.label}
                        variant={isActivePalette ? "secondary" : "outline"}
                        disabled={isReadOnly}
                        data-testid={`preset-palette-${preset.themeId}`}
                        aria-pressed={isActivePalette}
                        className="h-auto min-h-11 justify-start gap-2 px-2.5 py-2 text-left"
                        onClick={() => handleApplyPreset(preset.themeId)}
                      >
                        <span className="flex shrink-0 items-center -space-x-1" aria-hidden="true">
                          <span
                            className="size-4 rounded-full border border-white shadow-xs"
                            style={{ backgroundColor: preset.tokens.primaryColor }}
                          />
                          <span
                            className="size-4 rounded-full border border-white shadow-xs"
                            style={{ backgroundColor: preset.tokens.secondaryColor }}
                          />
                        </span>
                        <span className="min-w-0 truncate text-xs font-medium">
                          {preset.label}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              {/* Primary Brand Color + Live WCAG AA Contrast Check */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="ps-primary-color-input"
                    className="text-sm font-medium text-foreground"
                  >
                    Warna Utama Merek
                  </label>
                  <Badge
                    variant={
                      !primaryContrast.valid
                        ? "destructive"
                        : primaryContrast.passesAa
                          ? "success"
                          : "warning"
                    }
                    className="tabular-nums"
                    data-testid="primary-contrast-badge"
                  >
                    {!primaryContrast.valid
                      ? "Hex tidak valid"
                      : primaryContrast.passesAa
                        ? `WCAG AA ${primaryContrast.contrastRatio?.toFixed(2)}:1`
                        : `Kontras ${primaryContrast.contrastRatio?.toFixed(2)}:1 (< 4.5:1)`}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pemilih warna utama merek"
                    value={primaryContrast.normalizedHex ?? tokens.primaryColor}
                    disabled={isReadOnly}
                    data-testid="picker-primary-color"
                    onChange={(e) => handlePrimaryColorChange(e.target.value)}
                    className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                  />
                  <Input
                    id="ps-primary-color-input"
                    type="text"
                    value={primaryInput}
                    disabled={isReadOnly}
                    aria-invalid={!primaryContrast.valid}
                    placeholder="#176b51"
                    data-testid="input-primary-color"
                    className="font-mono"
                    onChange={(e) => handlePrimaryColorChange(e.target.value)}
                  />
                </div>
                {primaryContrast.warningMessage && (
                  <p
                    className="flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-soft px-2.5 py-2 text-xs leading-relaxed text-warning"
                    role="status"
                    data-testid="primary-contrast-warning"
                  >
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span>{primaryContrast.warningMessage}</span>
                  </p>
                )}
              </div>

              {/* Secondary Brand Color + Live WCAG AA Contrast Check */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="ps-secondary-color-input"
                    className="text-sm font-medium text-foreground"
                  >
                    Warna Sekunder Merek
                  </label>
                  <Badge
                    variant={
                      !secondaryContrast.valid
                        ? "destructive"
                        : secondaryContrast.passesAa
                          ? "success"
                          : "warning"
                    }
                    className="tabular-nums"
                    data-testid="secondary-contrast-badge"
                  >
                    {!secondaryContrast.valid
                      ? "Hex tidak valid"
                      : secondaryContrast.passesAa
                        ? `WCAG AA ${secondaryContrast.contrastRatio?.toFixed(2)}:1`
                        : `Kontras ${secondaryContrast.contrastRatio?.toFixed(2)}:1 (< 4.5:1)`}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pemilih warna sekunder merek"
                    value={secondaryContrast.normalizedHex ?? tokens.secondaryColor}
                    disabled={isReadOnly}
                    data-testid="picker-secondary-color"
                    onChange={(e) => handleSecondaryColorChange(e.target.value)}
                    className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 md:h-9"
                  />
                  <Input
                    id="ps-secondary-color-input"
                    type="text"
                    value={secondaryInput}
                    disabled={isReadOnly}
                    aria-invalid={!secondaryContrast.valid}
                    placeholder="#0f4c5c"
                    data-testid="input-secondary-color"
                    className="font-mono"
                    onChange={(e) => handleSecondaryColorChange(e.target.value)}
                  />
                </div>
                {secondaryContrast.warningMessage && (
                  <p
                    className="flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-soft px-2.5 py-2 text-xs leading-relaxed text-warning"
                    role="status"
                    data-testid="secondary-contrast-warning"
                  >
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <span>{secondaryContrast.warningMessage}</span>
                  </p>
                )}
              </div>

              <Separator />

              {/* Border Radius Control */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="ps-border-radius-range"
                    className="text-sm font-medium text-foreground"
                  >
                    Radius Sudut Komponen
                  </label>
                  <span
                    className="font-mono text-xs font-semibold text-foreground tabular-nums"
                    data-testid="border-radius-value"
                  >
                    {tokens.borderRadiusPx}px
                  </span>
                </div>
                <input
                  id="ps-border-radius-range"
                  type="range"
                  min={THEME_NUMERIC_BOUNDS.borderRadiusPx.min}
                  max={THEME_NUMERIC_BOUNDS.borderRadiusPx.max}
                  step={1}
                  value={tokens.borderRadiusPx}
                  disabled={isReadOnly}
                  data-testid="input-border-radius"
                  onChange={(e) => handleBorderRadiusChange(Number(e.target.value))}
                  className="h-6 w-full accent-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pilihan cepat radius sudut">
                  {RADIUS_PRESETS.map((px) => (
                    <Button
                      key={px}
                      type="button"
                      size="sm"
                      variant={tokens.borderRadiusPx === px ? "default" : "outline"}
                      disabled={isReadOnly}
                      aria-pressed={tokens.borderRadiusPx === px}
                      data-testid={`radius-preset-${px}`}
                      className="min-h-11 px-3 tabular-nums md:min-h-8"
                      onClick={() => handleBorderRadiusChange(px)}
                    >
                      {px}px
                    </Button>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Font Stack Selector + Fastest System Font Mode (REQ-020) */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="ps-font-family-select"
                    className="text-sm font-medium text-foreground"
                  >
                    Pilihan Font Publik (Maks. 1 Font Kustom)
                  </label>
                  <select
                    id="ps-font-family-select"
                    value={tokens.fontFamily}
                    disabled={isReadOnly || tokens.fastestSystemFont}
                    data-testid="select-font-family"
                    onChange={(e) => handleFontChange(e.target.value as AllowedThemeFont)}
                    className="h-11 w-full rounded-md border border-input bg-card px-3 py-1.5 text-base text-foreground outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:h-9 md:text-sm"
                  >
                    {initialState.allowedFonts.map((font) => (
                      <option key={font.id} value={font.id}>
                        {font.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Situs publik menggunakan font sistem secara default agar langsung tampil cepat di
                    jaringan 4G.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      <GaugeIcon className="size-3.5 text-primary" aria-hidden="true" />
                      <span>Mode tercepat (font sistem)</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Paksa font sistem tanpa unduhan font tambahan (0 KiB).
                    </p>
                  </div>
                  <Button
                    type="button"
                    role="switch"
                    aria-checked={tokens.fastestSystemFont}
                    aria-label="Mode tercepat (font sistem)"
                    variant={tokens.fastestSystemFont ? "default" : "outline"}
                    size="sm"
                    disabled={isReadOnly}
                    data-testid="toggle-fastest-system-font"
                    className="min-h-11 shrink-0 px-3 md:min-h-8"
                    onClick={handleFastestSystemFontToggle}
                  >
                    {tokens.fastestSystemFont ? "Aktif" : "Nonaktif"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Accessible Section Reorder & Toggle Controls Card */}
          <Card data-testid="section-composer-card">
            <CardHeader>
              <CardTitle>Susunan Bagian Beranda</CardTitle>
              <CardDescription>
                Atur urutan dengan tombol <strong>Naik</strong> / <strong>Turun</strong> (aksesibel
                penuh lewat keyboard) dan aktifkan atau sembunyikan bagian tanpa menghapus isinya.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sections.length === 0 ? (
                <div
                  className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground"
                  data-testid="section-empty-state"
                >
                  Belum ada bagian beranda yang terdaftar.
                </div>
              ) : (
                <ol
                  className="space-y-2.5"
                  aria-label="Daftar urutan bagian beranda"
                  data-testid="section-order-list"
                >
                  {sections.map((section, index) => {
                    const labelId = getSectionLabelId(section.type);
                    const headingPreview = getSectionHeadingPreview(section);
                    const showPermenkes =
                      initialState.isHealthCategory && section.type === "testimonials";
                    const isFirst = index === 0;
                    const isLast = index === sections.length - 1;

                    return (
                      <li
                        key={section.id}
                        data-testid={`section-row-${section.id}`}
                        data-section-id={section.id}
                        data-section-type={section.type}
                        data-section-order={index}
                        data-section-enabled={String(section.enabled)}
                        className={`rounded-md border p-3 transition-colors ${
                          section.enabled
                            ? "border-border bg-card"
                            : "border-dashed border-border bg-muted/40"
                        }`}
                      >
                        <div className="flex flex-col gap-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-xs font-semibold text-foreground tabular-nums">
                                  {index + 1}
                                </span>
                                <span className="text-sm font-semibold text-foreground">
                                  {labelId}
                                </span>
                                <Badge
                                  variant={section.enabled ? "success" : "secondary"}
                                  data-testid={`section-status-${section.id}`}
                                >
                                  {section.enabled ? "Tampil" : "Disembunyikan"}
                                </Badge>
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {headingPreview}
                              </p>
                            </div>
                          </div>

                          {/* Permenkes compliance notice on testimonials for health categories */}
                          {showPermenkes && (
                            <div
                              className="flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-soft px-2.5 py-2 text-xs leading-relaxed text-warning"
                              role="note"
                              data-testid={`permenkes-notice-${section.id}`}
                            >
                              <AlertTriangleIcon
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden="true"
                              />
                              <span>{PERMENKES_TESTIMONIALS_WARNING_MESSAGE}</span>
                            </div>
                          )}

                          {/* Action row: Toggle Switch + Keyboard Move Up / Move Down */}
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <Button
                              type="button"
                              role="switch"
                              aria-checked={section.enabled}
                              aria-label={`${section.enabled ? "Sembunyikan" : "Tampilkan"} bagian ${labelId}`}
                              size="sm"
                              variant={section.enabled ? "outline" : "secondary"}
                              disabled={isReadOnly}
                              data-testid={`section-toggle-${section.id}`}
                              className="min-h-11 px-3 md:min-h-8"
                              onClick={() => handleToggleSection(section.id)}
                            >
                              {section.enabled ? (
                                <EyeIcon className="size-4 text-primary" aria-hidden="true" />
                              ) : (
                                <EyeOffIcon
                                  className="size-4 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              )}
                              <span>{section.enabled ? "Tampilkan" : "Disembunyikan"}</span>
                            </Button>

                            <div
                              className="flex items-center gap-1.5"
                              role="group"
                              aria-label={`Ubah urutan ${labelId}`}
                            >
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={isReadOnly || isFirst}
                                aria-label={`Naikkan bagian ${labelId}`}
                                data-testid={`section-move-up-${section.id}`}
                                className="min-h-11 min-w-11 px-2.5 md:min-h-8 md:min-w-8"
                                onClick={() => handleMoveSection(index, "up")}
                              >
                                <ArrowUpIcon className="size-4" aria-hidden="true" />
                                <span>Naik</span>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={isReadOnly || isLast}
                                aria-label={`Turunkan bagian ${labelId}`}
                                data-testid={`section-move-down-${section.id}`}
                                className="min-h-11 min-w-11 px-2.5 md:min-h-8 md:min-w-8"
                                onClick={() => handleMoveSection(index, "down")}
                              >
                                <ArrowDownIcon className="size-4" aria-hidden="true" />
                                <span>Turun</span>
                              </Button>
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Pane: Live Sandboxed Draft Preview */}
        <div
          className={`min-w-0 lg:sticky lg:top-20 ${mobilePanel === "edit" ? "hidden lg:block" : "block"}`}
          data-testid="customizer-preview-panel"
        >
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-2.5 border-b border-border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-semibold text-foreground">Pratinjau Draf Langsung</p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span>Terisolasi penuh (sandbox=&quot;&quot;): skrip &amp; formulir nonaktif.</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label="Ukuran layar pratinjau tema"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card p-1"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={previewViewport === "mobile" ? "default" : "ghost"}
                    aria-pressed={previewViewport === "mobile"}
                    data-testid="customizer-preview-mobile"
                    className="min-h-11 px-2.5 text-xs md:min-h-8"
                    onClick={() => setPreviewViewport("mobile")}
                  >
                    <SmartphoneIcon className="size-4" aria-hidden="true" />
                    <span>360px</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={previewViewport === "desktop" ? "default" : "ghost"}
                    aria-pressed={previewViewport === "desktop"}
                    data-testid="customizer-preview-desktop"
                    className="min-h-11 px-2.5 text-xs md:min-h-8"
                    onClick={() => setPreviewViewport("desktop")}
                  >
                    <MonitorIcon className="size-4" aria-hidden="true" />
                    <span>1440px</span>
                  </Button>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isPreviewLoading}
                  aria-busy={isPreviewLoading}
                  data-testid="customizer-preview-refresh"
                  className="min-h-11 md:min-h-8"
                  onClick={() => void refreshDraftPreview(tokens, variants, sections)}
                >
                  <RefreshCwIcon
                    className={`size-4 ${isPreviewLoading ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  <span>{isPreviewLoading ? "Memuat..." : "Segarkan"}</span>
                </Button>
              </div>
            </div>

            <CardContent className="bg-muted/30 p-3 sm:p-4">
              {previewError && (
                <Alert variant="destructive" className="mb-3" data-testid="customizer-preview-error">
                  <AlertCircleIcon className="size-4" aria-hidden="true" />
                  <AlertTitle>Pratinjau tidak tersedia</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              )}

              {previewHtml ? (
                <div className="mx-auto w-full overflow-x-auto pb-1">
                  <div
                    data-testid="customizer-preview-wrapper"
                    data-target-width={previewViewport === "mobile" ? 360 : 1440}
                    style={{
                      width: previewViewport === "mobile" ? "360px" : "100%",
                      maxWidth: "100%",
                    }}
                    className="mx-auto overflow-hidden rounded-md border border-border bg-card shadow-xs transition-[width] duration-150"
                  >
                    <iframe
                      title={`Pratinjau Draf Tema — ${workspaceName}`}
                      sandbox={PREVIEW_IFRAME_SANDBOX}
                      referrerPolicy="no-referrer"
                      srcDoc={previewHtml}
                      data-testid="customizer-preview-iframe"
                      className="block h-[68vh] min-h-[520px] w-full border-0 bg-white"
                    />
                  </div>
                </div>
              ) : (
                <div
                  className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card p-6 text-center"
                  data-testid="customizer-preview-empty"
                >
                  <EyeIcon className="size-6 text-muted-foreground" aria-hidden="true" />
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Pratinjau draf akan tampil di sini setelah selesai dimuat.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isPreviewLoading}
                    className="min-h-11 md:min-h-9"
                    onClick={() => void refreshDraftPreview(tokens, variants, sections)}
                  >
                    <RefreshCwIcon className="size-4" aria-hidden="true" />
                    <span>Muat Pratinjau</span>
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
