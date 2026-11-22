import * as React from "react";
import {
  PREVIEW_IFRAME_SANDBOX,
  PREVIEW_VIEWPORT_IDS,
  PREVIEW_VIEWPORTS,
  type PreviewResourceKind,
  type PreviewViewportId,
} from "@punyasitus/core/preview/index";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  EyeIcon,
  MonitorIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export interface PreviewErrorState {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string | null;
}

export interface AdminPreviewShellProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly backHref: string;
  readonly previewEndpointUrl: string;
  readonly initialHtml: string | null;
  readonly initialResourceKind: PreviewResourceKind;
  readonly initialResourceId: number | string | null;
  readonly initialVersion: number;
  readonly initialThemeId: string;
  readonly initialLayoutMode: "standard" | "focused";
  readonly initialHasUnpublishedChanges: boolean;
  readonly initialViewport?: PreviewViewportId;
  readonly initialError?: PreviewErrorState | null;
}

const RESOURCE_KIND_LABELS: Readonly<Record<PreviewResourceKind, string>> = {
  home: "Beranda",
  page: "Halaman",
  post: "Artikel",
  offering: "Penawaran",
  theme: "Tema",
  identity: "Identitas Situs",
  menu: "Menu Navigasi",
};

function ViewportIcon({ viewport }: { readonly viewport: PreviewViewportId }) {
  if (viewport === "mobile") {
    return <SmartphoneIcon className="size-4" aria-hidden="true" />;
  }
  if (viewport === "tablet") {
    return <TabletIcon className="size-4" aria-hidden="true" />;
  }
  return <MonitorIcon className="size-4" aria-hidden="true" />;
}

export function AdminPreviewShell({
  tenantHandle,
  workspaceName,
  backHref,
  previewEndpointUrl,
  initialHtml,
  initialResourceKind,
  initialResourceId,
  initialVersion,
  initialThemeId,
  initialLayoutMode,
  initialHasUnpublishedChanges,
  initialViewport = "desktop",
  initialError = null,
}: AdminPreviewShellProps) {
  const [viewport, setViewport] = React.useState<PreviewViewportId>(initialViewport);
  const [html, setHtml] = React.useState<string | null>(initialHtml);
  const [version, setVersion] = React.useState<number>(initialVersion);
  const [themeId, setThemeId] = React.useState<string>(initialThemeId);
  const [layoutMode, setLayoutMode] = React.useState<"standard" | "focused">(initialLayoutMode);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = React.useState<boolean>(
    initialHasUnpublishedChanges,
  );
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<PreviewErrorState | null>(initialError);
  const [statusMessage, setStatusMessage] = React.useState<string>(
    initialError
      ? "Pratinjau gagal dimuat. Anda dapat mencoba memuat ulang."
      : "Pratinjau draf siap ditampilkan.",
  );

  const viewportButtonRefs = React.useRef<Record<PreviewViewportId, HTMLButtonElement | null>>({
    mobile: null,
    tablet: null,
    desktop: null,
  });

  const activeViewport = PREVIEW_VIEWPORTS[viewport];
  const resourceLabel = RESOURCE_KIND_LABELS[initialResourceKind] ?? "Konten";

  const handleSelectViewport = React.useCallback((next: PreviewViewportId) => {
    setViewport(next);
    const preset = PREVIEW_VIEWPORTS[next];
    setStatusMessage(`Ukuran pratinjau diubah ke ${preset.label}.`);
  }, []);

  const handleViewportKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      let nextIndex = -1;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % PREVIEW_VIEWPORT_IDS.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + PREVIEW_VIEWPORT_IDS.length) % PREVIEW_VIEWPORT_IDS.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = PREVIEW_VIEWPORT_IDS.length - 1;
      }

      if (nextIndex !== -1) {
        event.preventDefault();
        const nextViewport = PREVIEW_VIEWPORT_IDS[nextIndex];
        if (nextViewport) {
          handleSelectViewport(nextViewport);
          viewportButtonRefs.current[nextViewport]?.focus();
        }
      }
    },
    [handleSelectViewport],
  );

  const handleReloadPreview = React.useCallback(async () => {
    setIsLoading(true);
    setStatusMessage("Memuat ulang pratinjau draf...");

    const payload: Record<string, unknown> = {
      resourceKind: initialResourceKind,
      expectedVersion: version,
      themeId,
      layoutMode,
    };
    if (typeof initialResourceId === "number") {
      payload.resourceId = initialResourceId;
    }

    try {
      const response = await fetch(previewEndpointUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const errObj =
          parsed?.error && typeof parsed.error === "object"
            ? (parsed.error as Record<string, unknown>)
            : null;
        const code =
          typeof errObj?.code === "string"
            ? errObj.code
            : response.status === 401
              ? "UNAUTHENTICATED"
              : response.status === 409
                ? "STALE_VERSION"
                : "PREVIEW_FAILED";
        const message =
          typeof errObj?.message === "string"
            ? errObj.message
            : response.status === 401
              ? "Sesi Anda telah berakhir. Silakan masuk kembali untuk membuka pratinjau draf."
              : response.status === 409
                ? "Versi draf telah berubah. Muat ulang halaman editor untuk menyinkronkan versi terbaru."
                : "Pratinjau draf sementara tidak dapat dimuat. Silakan coba lagi.";
        const reqId = typeof parsed?.requestId === "string" ? parsed.requestId : null;

        setError({ code, message, requestId: reqId });
        setStatusMessage(`Gagal memuat pratinjau (${code}).`);
        return;
      }

      if (!parsed || typeof parsed.html !== "string") {
        setError({
          code: "INVALID_RESPONSE",
          message: "Respons pratinjau dari server tidak valid. Silakan coba muat ulang.",
        });
        setStatusMessage("Respons pratinjau tidak valid.");
        return;
      }

      setHtml(parsed.html);
      if (typeof parsed.version === "number") setVersion(parsed.version);
      if (typeof parsed.themeId === "string") setThemeId(parsed.themeId);
      if (parsed.layoutMode === "focused" || parsed.layoutMode === "standard") {
        setLayoutMode(parsed.layoutMode);
      }
      if (typeof parsed.hasUnpublishedChanges === "boolean") {
        setHasUnpublishedChanges(parsed.hasUnpublishedChanges);
      }
      setError(null);
      setStatusMessage("Pratinjau draf berhasil diperbarui.");
    } catch {
      setError({
        code: "NETWORK_ERROR",
        message: "Koneksi ke server terputus saat memuat pratinjau. Draf Anda tetap aman.",
      });
      setStatusMessage("Gagal terhubung ke server pratinjau.");
    } finally {
      setIsLoading(false);
    }
  }, [initialResourceId, initialResourceKind, layoutMode, previewEndpointUrl, themeId, version]);

  return (
    <div
      className="space-y-4"
      data-testid="admin-preview-shell"
      data-tenant-handle={tenantHandle}
      data-viewport={viewport}
    >
      {/* Top context & responsive viewport toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="warning" data-testid="preview-draft-badge">
                <EyeIcon className="size-3.5" aria-hidden="true" />
                Mode Pratinjau Draf
              </Badge>
              <Badge variant="outline" data-testid="preview-resource-badge">
                {resourceLabel}
                {initialResourceId !== null ? ` #${String(initialResourceId)}` : ""}
              </Badge>
              <Badge variant="secondary" className="tabular-nums" data-testid="preview-version-badge">
                v{version}
              </Badge>
              <Badge variant="outline" data-testid="preview-theme-badge">
                Tema: {themeId}
              </Badge>
              {hasUnpublishedChanges && (
                <Badge variant="info" data-testid="preview-unpublished-badge">
                  Belum diterbitkan
                </Badge>
              )}
            </div>
            <h1 className="!m-0 !text-xl !leading-snug font-bold tracking-[-0.02em] text-foreground">
              Pratinjau Draf — {workspaceName}
            </h1>
            <p className="flex items-start gap-1.5 text-xs leading-normal text-muted-foreground">
              <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span>
                Pratinjau visual terisolasi: skrip, formulir, pelacak, dan tautan eksternal
                dinonaktifkan sepenuhnya.
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
            {/* Responsive viewport switcher (360px / 768px / 1440px) */}
            <div
              role="group"
              aria-label="Pilih ukuran layar pratinjau"
              data-testid="viewport-switcher"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 p-1"
            >
              {PREVIEW_VIEWPORT_IDS.map((vpId, idx) => {
                const preset = PREVIEW_VIEWPORTS[vpId];
                const isSelected = viewport === vpId;
                return (
                  <Button
                    key={vpId}
                    ref={(el) => {
                      viewportButtonRefs.current[vpId] = el;
                    }}
                    type="button"
                    size="sm"
                    variant={isSelected ? "default" : "ghost"}
                    aria-pressed={isSelected}
                    aria-label={preset.label}
                    data-testid={`viewport-btn-${vpId}`}
                    data-viewport-width={preset.widthPx}
                    className="min-h-11 px-2.5 text-xs sm:px-3 md:min-h-8"
                    onClick={() => handleSelectViewport(vpId)}
                    onKeyDown={(e) => handleViewportKeyDown(e, idx)}
                  >
                    <ViewportIcon viewport={vpId} />
                    <span>{preset.shortLabel}</span>
                    <span className="hidden tabular-nums sm:inline">{preset.widthPx}px</span>
                  </Button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isLoading}
                aria-busy={isLoading}
                data-testid="preview-reload-button"
                className="min-h-11 md:min-h-8"
                onClick={handleReloadPreview}
              >
                <RefreshCwIcon
                  className={`size-4 ${isLoading ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                <span>{isLoading ? "Memuat..." : "Muat ulang pratinjau"}</span>
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 md:min-h-8"
                data-testid="preview-back-link"
                render={<a href={backHref} />}
              >
                <ArrowLeftIcon className="size-4" aria-hidden="true" />
                <span>Kembali</span>
              </Button>
            </div>
          </div>
        </div>

        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="preview-live-status"
        >
          {statusMessage}
        </p>
      </div>

      {/* Accessible error/retry banner — preserves saved draft context */}
      {error && (
        <Alert variant="destructive" data-testid="preview-error-banner" data-error-code={error.code}>
          <AlertCircleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat pratinjau draf</AlertTitle>
          <AlertDescription>
            <span>{error.message}</span>{" "}
            <span>Draf tersimpan Anda tetap aman dan tidak berubah.</span>
            {error.requestId && (
              <span className="ml-1 font-mono text-xs">({error.requestId})</span>
            )}
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isLoading}
              data-testid="preview-error-retry-button"
              className="min-h-11 md:min-h-8"
              onClick={handleReloadPreview}
            >
              <RefreshCwIcon
                className={`size-4 ${isLoading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              <span>Muat ulang pratinjau</span>
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* Sandboxed preview stage */}
      <Card data-testid="preview-stage-card" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground" data-testid="preview-stage-label">
            Tampilan aktif: {activeViewport.label}
          </span>
          <span className="tabular-nums">
            Mode tata letak: {layoutMode === "focused" ? "Fokus (tanpa navigasi)" : "Standar"}
          </span>
        </div>

        <CardContent className="bg-muted/30 p-3 sm:p-5">
          {html ? (
            <div
              className="mx-auto w-full overflow-x-auto pb-1"
              data-testid="preview-frame-scroll-container"
            >
              <div
                data-testid="preview-frame-wrapper"
                data-target-width={activeViewport.widthPx}
                style={{
                  width: `${activeViewport.widthPx}px`,
                  maxWidth: "100%",
                }}
                className="mx-auto overflow-hidden rounded-md border border-border bg-card shadow-xs transition-[width] duration-150"
              >
                <iframe
                  title={`Pratinjau draf — ${workspaceName}`}
                  sandbox={PREVIEW_IFRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  srcDoc={html}
                  data-testid="preview-sandbox-iframe"
                  className="block h-[72vh] min-h-[520px] w-full border-0 bg-white"
                />
              </div>
            </div>
          ) : (
            <div
              className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card p-6 text-center"
              data-testid="preview-empty-fallback"
            >
              <AlertCircleIcon className="size-6 text-muted-foreground" aria-hidden="true" />
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-foreground">
                  Pratinjau belum dapat ditampilkan
                </h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  Klik tombol di bawah untuk mencoba memuat ulang pratinjau draf dari server.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={isLoading}
                data-testid="preview-empty-retry-button"
                className="min-h-11 md:min-h-9"
                onClick={handleReloadPreview}
              >
                <RefreshCwIcon className="size-4" aria-hidden="true" />
                <span>Muat ulang pratinjau</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
