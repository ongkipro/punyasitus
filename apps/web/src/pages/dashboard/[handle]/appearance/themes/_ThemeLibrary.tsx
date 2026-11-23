import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { PREVIEW_IFRAME_SANDBOX } from "@punyasitus/core/preview/index";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  EyeIcon,
  HistoryIcon,
  LayersIcon,
  LockIcon,
  MonitorIcon,
  PaletteIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
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
import type {
  ThemeLibraryActivateResultDto,
  ThemeLibraryItemDto,
  ThemeLibraryPreviewResultDto,
  ThemeLibraryStateDto,
} from "../../../../api/tenants/[tenantId]/themes/_shared.ts";

export interface ThemeLibraryProps {
  readonly tenantHandle: string;
  readonly workspaceName: string;
  readonly themesApiUrl: string;
  readonly previewApiUrl: string;
  readonly activateApiUrl: string;
  readonly customizerHref: string;
  readonly initialState: ThemeLibraryStateDto;
}

type ThemeTierFilter = "all" | "included" | "custom";

interface ApiErrorNotice {
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly {
    readonly field: string;
    readonly code: string;
    readonly message: string;
  }[];
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

function ThemePalettePreview({ theme }: { readonly theme: ThemeLibraryItemDto }) {
  const effectiveTokens = theme.savedTokens ?? theme.defaultTokens;
  const surface = effectiveTokens.surfaceColor ?? theme.palette.surface;
  const surfaceMuted = theme.palette.surfaceMuted;
  const primary = effectiveTokens.primaryColor;
  const secondary = effectiveTokens.secondaryColor;
  const border = theme.palette.border;
  const ink = effectiveTokens.textColor ?? theme.palette.ink;

  return (
    <div
      className="relative overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: surface }}
      aria-hidden="true"
    >
      {/* Miniature top nav bar */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ backgroundColor: surface, borderBottom: `1px solid ${border}` }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-xs"
            style={{ backgroundColor: primary }}
          />
          <span
            className="inline-block h-2 w-14 rounded-xs opacity-75"
            style={{ backgroundColor: ink }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-6 rounded-xs opacity-35"
            style={{ backgroundColor: ink }}
          />
          <span
            className="inline-block h-1.5 w-6 rounded-xs opacity-35"
            style={{ backgroundColor: ink }}
          />
          <span
            className="inline-block h-3.5 w-9 rounded-xs"
            style={{ backgroundColor: primary }}
          />
        </div>
      </div>

      {/* Miniature hero block */}
      <div className="grid grid-cols-[1.3fr_0.9fr] gap-2.5 p-3" style={{ backgroundColor: surfaceMuted }}>
        <div className="flex flex-col justify-center gap-1.5">
          <span
            className="inline-block h-2 w-10 rounded-xs"
            style={{ backgroundColor: secondary }}
          />
          <span
            className="inline-block h-2.5 w-4/5 rounded-xs opacity-85"
            style={{ backgroundColor: ink }}
          />
          <span
            className="inline-block h-1.5 w-3/5 rounded-xs opacity-45"
            style={{ backgroundColor: ink }}
          />
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className="inline-block h-4 w-12 rounded-xs"
              style={{ backgroundColor: primary }}
            />
            <span
              className="inline-block h-4 w-10 rounded-xs"
              style={{ backgroundColor: surface, border: `1px solid ${border}` }}
            />
          </div>
        </div>
        <div
          className="flex min-h-14 flex-col justify-between rounded-xs p-2"
          style={{ backgroundColor: surface, border: `1px solid ${border}` }}
        >
          <span
            className="inline-block h-1.5 w-8 rounded-xs opacity-40"
            style={{ backgroundColor: ink }}
          />
          <div className="flex items-center gap-1">
            <span
              className="inline-block size-3 rounded-xs"
              style={{ backgroundColor: primary }}
            />
            <span
              className="inline-block size-3 rounded-xs"
              style={{ backgroundColor: secondary }}
            />
            <span
              className="inline-block size-3 rounded-xs"
              style={{ backgroundColor: surfaceMuted, border: `1px solid ${border}` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ThemeLibrary({
  tenantHandle,
  workspaceName,
  themesApiUrl,
  previewApiUrl,
  activateApiUrl,
  customizerHref,
  initialState,
}: ThemeLibraryProps) {
  const [libraryState, setLibraryState] = React.useState<ThemeLibraryStateDto>(initialState);
  const [tierFilter, setTierFilter] = React.useState<ThemeTierFilter>("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  const [isRefreshing, setIsRefreshing] = React.useState<boolean>(false);
  const [isActivating, setIsActivating] = React.useState<boolean>(false);

  const [conflictNotice, setConflictNotice] = React.useState<ApiErrorNotice | null>(null);
  const [errorNotice, setErrorNotice] = React.useState<ApiErrorNotice | null>(null);
  const [successBanner, setSuccessBanner] = React.useState<{
    readonly title: string;
    readonly detail: string;
  } | null>(null);

  // Preview dialog state
  const [previewTarget, setPreviewTarget] = React.useState<ThemeLibraryItemDto | null>(null);
  const [previewViewport, setPreviewViewport] = React.useState<"desktop" | "mobile">("desktop");
  const [previewResult, setPreviewResult] = React.useState<ThemeLibraryPreviewResultDto | null>(
    null,
  );
  const [isPreviewLoading, setIsPreviewLoading] = React.useState<boolean>(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  // Activation confirmation dialog state
  const [confirmTarget, setConfirmTarget] = React.useState<ThemeLibraryItemDto | null>(null);

  const previewAbortRef = React.useRef<AbortController | null>(null);
  const previewSeqRef = React.useRef<number>(0);

  React.useEffect(() => {
    return () => {
      previewAbortRef.current?.abort();
    };
  }, []);

  const activeTheme = React.useMemo(
    () =>
      libraryState.themes.find((t) => t.id === libraryState.activeThemeId) ??
      libraryState.themes[0] ??
      null,
    [libraryState.themes, libraryState.activeThemeId],
  );

  const includedCount = React.useMemo(
    () => libraryState.themes.filter((t) => !t.isCustom).length,
    [libraryState.themes],
  );
  const customCount = React.useMemo(
    () => libraryState.themes.filter((t) => t.isCustom).length,
    [libraryState.themes],
  );

  const filteredThemes = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return libraryState.themes.filter((theme) => {
      if (tierFilter === "included" && theme.isCustom) return false;
      if (tierFilter === "custom" && !theme.isCustom) return false;
      if (!q) return true;
      return (
        theme.name.toLowerCase().includes(q) ||
        theme.id.toLowerCase().includes(q) ||
        theme.description.toLowerCase().includes(q)
      );
    });
  }, [libraryState.themes, tierFilter, searchQuery]);

  const isEditorReadOnly =
    !libraryState.permissions.canActivate &&
    !libraryState.permissions.isLocked &&
    libraryState.permissions.role === "editor";

  const refreshLibraryState = React.useCallback(async () => {
    setIsRefreshing(true);
    setErrorNotice(null);
    try {
      const res = await fetch(themesApiUrl, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const json = (await res.json()) as ThemeLibraryStateDto & {
        readonly error?: ApiErrorNotice;
      };
      if (!res.ok) {
        setErrorNotice(
          json.error ?? {
            code: "LOAD_FAILED",
            message: "Gagal memuat ulang daftar tema dari server.",
          },
        );
        return;
      }
      setLibraryState(json);
      setConflictNotice(null);
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat memuat ulang perpustakaan tema. Coba lagi.",
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [themesApiUrl]);

  const openCompatibilityPreview = React.useCallback(
    async (theme: ThemeLibraryItemDto) => {
      setPreviewTarget(theme);
      setPreviewResult(null);
      setPreviewError(null);
      setErrorNotice(null);

      if (!theme.compatibility.compatible) {
        setPreviewError(
          theme.compatibility.blockingReasons[0]?.message ??
            "Tema ini tidak kompatibel dengan struktur konten situs saat ini.",
        );
        return;
      }

      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      const reqId = previewSeqRef.current + 1;
      previewSeqRef.current = reqId;
      setIsPreviewLoading(true);

      try {
        const res = await fetch(previewApiUrl, {
          method: "POST",
          credentials: "same-origin",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ themeId: theme.id }),
        });
        const json = (await res.json()) as ThemeLibraryPreviewResultDto & {
          readonly error?: ApiErrorNotice;
        };
        if (previewSeqRef.current !== reqId) return;

        if (!res.ok) {
          setPreviewError(
            json.error?.message ?? "Pratinjau kompatibilitas gagal dimuat. Coba lagi.",
          );
          return;
        }

        setPreviewResult(json);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (previewSeqRef.current !== reqId) return;
        setPreviewError("Koneksi terputus saat memuat pratinjau kompatibilitas tema.");
      } finally {
        if (previewSeqRef.current === reqId) {
          setIsPreviewLoading(false);
        }
      }
    },
    [previewApiUrl],
  );

  const handleConfirmActivate = React.useCallback(async () => {
    if (!confirmTarget || !libraryState.permissions.canActivate) return;

    setIsActivating(true);
    setErrorNotice(null);
    setConflictNotice(null);
    setSuccessBanner(null);

    try {
      const res = await fetch(activateApiUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          themeId: confirmTarget.id,
          expectedVersion: libraryState.version,
          confirm: true,
        }),
      });

      const json = (await res.json()) as ThemeLibraryActivateResultDto & {
        readonly error?: ApiErrorNotice;
      };

      if (res.status === 409 || json.error?.code === "STALE_VERSION") {
        setConflictNotice(
          json.error ?? {
            code: "STALE_VERSION",
            message:
              "Perubahan tema lain telah tersimpan lebih dulu. Muat ulang status terbaru sebelum mengaktifkan tema.",
          },
        );
        setConfirmTarget(null);
        return;
      }

      if (!res.ok) {
        setErrorNotice(
          json.error ?? {
            code: "ACTIVATE_FAILED",
            message: "Gagal mengaktifkan tema. Tema aktif sebelumnya tetap dipertahankan.",
          },
        );
        setConfirmTarget(null);
        return;
      }

      setLibraryState(json);
      setConfirmTarget(null);
      setPreviewTarget(null);
      setPreviewResult(null);

      setSuccessBanner({
        title: `Tema "${confirmTarget.name}" berhasil diaktifkan`,
        detail: json.recoveredExistingConfig
          ? `Konfigurasi warna dan tipografi tersimpan sebelumnya untuk "${confirmTarget.name}" berhasil dipulihkan otomatis. Seluruh konten situs tetap utuh (Cache v${json.cacheVersion}).`
          : `Tema "${confirmTarget.name}" kini aktif secara publik. Konfigurasi tema sebelumnya (${json.previousThemeId}) tetap tersimpan aman dan seluruh konten situs tidak berubah (Cache v${json.cacheVersion}).`,
      });
    } catch {
      setErrorNotice({
        code: "NETWORK_ERROR",
        message: "Koneksi terputus saat mengaktifkan tema. Tidak ada perubahan yang diterapkan.",
      });
      setConfirmTarget(null);
    } finally {
      setIsActivating(false);
    }
  }, [activateApiUrl, confirmTarget, libraryState.permissions.canActivate, libraryState.version]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-testid="theme-library-root">
      {/* Page Header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Perpustakaan Tema
            </h1>
            <Badge variant="outline" className="tabular-nums" data-testid="theme-library-version">
              Versi v{libraryState.version}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Kelola tema bawaan dan tema kustom berizin untuk{" "}
            <span className="font-medium text-foreground">{workspaceName}</span> ({tenantHandle}).
            Pratinjau kompatibilitas tersedia sebelum mengaktifkan tema baru tanpa menghapus konten.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={refreshLibraryState}
            disabled={isRefreshing}
            data-testid="btn-refresh-themes"
          >
            <RefreshCwIcon
              className={`size-4 ${isRefreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>{isRefreshing ? "Memuat..." : "Muat Ulang"}</span>
          </Button>
          <Button
            variant="default"
            className="min-h-11"
            render={<a href={customizerHref} data-testid="link-theme-customizer" />}
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
            <span>Sesuaikan Tema Aktif</span>
          </Button>
        </div>
      </header>

      {/* Active Theme & Content Preservation Context Bar */}
      <section
        aria-label="Ringkasan tema aktif dan konten terlindungi"
        className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="theme-library-summary"
      >
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-muted-foreground">Tema Aktif Saat Ini</p>
          <p
            className="truncate text-sm font-semibold text-foreground"
            data-testid="active-theme-name"
          >
            {activeTheme?.name ?? libraryState.activeThemeId}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums" data-testid="active-theme-id">
            ID: {libraryState.activeThemeId}
          </p>
        </div>

        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-muted-foreground">Tema Tersedia</p>
          <p className="text-sm font-semibold text-foreground tabular-nums" data-testid="available-themes-count">
            {libraryState.themes.length} tema ({includedCount} bawaan, {customCount} kustom)
          </p>
          <p className="text-xs text-muted-foreground">
            Hanya tema bawaan &amp; berizin untuk situs ini
          </p>
        </div>

        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-muted-foreground">Konten Terlindungi</p>
          <p className="text-sm font-semibold text-foreground tabular-nums">
            {libraryState.contentSummary.pages} halaman · {libraryState.contentSummary.posts} artikel ·{" "}
            {libraryState.contentSummary.offerings} penawaran
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {libraryState.contentSummary.menus} menu · {libraryState.contentSummary.media} media
            tetap utuh
          </p>
        </div>

        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-muted-foreground">Status Publikasi</p>
          <p className="text-sm font-semibold text-foreground tabular-nums" data-testid="cache-version-badge">
            Cache v{libraryState.cacheVersion}
          </p>
          <p className="text-xs text-muted-foreground">
            {formatDateTimeId(libraryState.updatedAt) ?? "Siap diaktifkan secara atomik"}
          </p>
        </div>
      </section>

      {/* Locked / Suspended Read-Only Banner */}
      {libraryState.permissions.isLocked && (
        <Alert variant="warning" data-testid="locked-readonly-banner">
          <LockIcon aria-hidden="true" />
          <AlertTitle>Mode Baca-Saja — Langganan Terkunci</AlertTitle>
          <AlertDescription>
            Status situs saat ini <strong>{libraryState.permissions.tenantStatus}</strong>. Anda
            dapat meninjau daftar tema, tetapi aktivasi tema dinonaktifkan hingga perpanjangan
            langganan selesai diverifikasi.
          </AlertDescription>
        </Alert>
      )}

      {/* Editor Read-Only Notice */}
      {isEditorReadOnly && (
        <Alert variant="info" data-testid="editor-readonly-banner">
          <ShieldAlertIcon aria-hidden="true" />
          <AlertTitle>Akses Terbatas (Peran Editor)</AlertTitle>
          <AlertDescription>
            Sebagai <strong>Editor</strong>, Anda dapat melihat daftar tema yang tersedia untuk
            situs ini. Pratinjau dan aktivasi tema hanya dapat dilakukan oleh{" "}
            <strong>Pemilik Situs</strong> atau <strong>Admin</strong>.
          </AlertDescription>
        </Alert>
      )}

      {/* 409 Stale-Write Recovery Banner */}
      {conflictNotice && (
        <Alert variant="destructive" data-testid="stale-conflict-banner">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertTitle>Konflik Versi Tema Terdeteksi (409)</AlertTitle>
          <AlertDescription>{conflictNotice.message}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 bg-card text-foreground"
              onClick={refreshLibraryState}
              disabled={isRefreshing}
              data-testid="btn-recover-conflict"
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              <span>Muat Ulang Status Terbaru</span>
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* Generic Error Banner */}
      {errorNotice && (
        <Alert variant="destructive" data-testid="theme-error-banner">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>Gagal Memproses Permintaan Tema ({errorNotice.code})</AlertTitle>
          <AlertDescription>
            <p>{errorNotice.message}</p>
            {errorNotice.fields && errorNotice.fields.length > 0 && (
              <ul className="mt-1.5 list-disc pl-5 text-xs">
                {errorNotice.fields.map((f, idx) => (
                  <li key={`${f.field}-${idx}`}>
                    {f.field}: {f.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Success Banner */}
      {successBanner && (
        <Alert variant="success" data-testid="theme-success-banner">
          <CheckCircle2Icon aria-hidden="true" />
          <AlertTitle>{successBanner.title}</AlertTitle>
          <AlertDescription>{successBanner.detail}</AlertDescription>
        </Alert>
      )}

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex flex-wrap items-center gap-2"
          role="tablist"
          aria-label="Filter kategori tema"
        >
          {(
            [
              { id: "all", label: "Semua Tema", count: libraryState.themes.length },
              { id: "included", label: "Tema Bawaan", count: includedCount },
              { id: "custom", label: "Tema Kustom", count: customCount },
            ] as const
          ).map((tab) => {
            const selected = tierFilter === tab.id;
            return (
              <Button
                key={tab.id}
                role="tab"
                aria-selected={selected}
                variant={selected ? "default" : "outline"}
                className="min-h-11 tabular-nums"
                onClick={() => setTierFilter(tab.id)}
                data-testid={`filter-tab-${tab.id}`}
              >
                <span>{tab.label}</span>
                <span className="rounded-sm bg-background/15 px-1.5 py-0.5 text-xs">
                  {tab.count}
                </span>
              </Button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari nama atau ID tema..."
            aria-label="Cari tema"
            className="min-h-11 pl-9 text-base sm:text-sm"
            data-testid="theme-search-input"
          />
        </div>
      </div>

      {/* Theme Gallery Grid */}
      {filteredThemes.length === 0 ? (
        <Card data-testid="themes-empty-state">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <PaletteIcon className="size-8 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-1">
              <p className="text-base font-semibold text-foreground">
                Tidak ada tema yang cocok dengan filter saat ini
              </p>
              <p className="text-sm text-muted-foreground">
                {tierFilter === "custom" && customCount === 0
                  ? "Belum ada tema kustom yang diberikan akses oleh operator platform untuk situs ini."
                  : "Coba ubah kata kunci pencarian atau pilih tab Semua Tema."}
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setTierFilter("all");
                setSearchQuery("");
              }}
              data-testid="btn-reset-theme-filter"
            >
              Tampilkan Semua Tema
            </Button>
          </CardContent>
        </Card>
      ) : (
        <section
          aria-label="Daftar tema yang tersedia"
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          data-testid="themes-gallery-grid"
        >
          {filteredThemes.map((theme) => {
            const canPreviewCard = libraryState.permissions.canPreview;
            const canActivateCard =
              libraryState.permissions.canActivate &&
              !theme.isActive &&
              theme.compatibility.compatible;

            return (
              <Card
                key={theme.id}
                className={theme.isActive ? "border-primary/70 ring-1 ring-primary/20" : undefined}
                data-testid={`theme-card-${theme.id}`}
                data-theme-active={theme.isActive ? "true" : "false"}
                data-theme-compatible={theme.compatibility.compatible ? "true" : "false"}
              >
                <CardHeader className="gap-2.5">
                  <ThemePalettePreview theme={theme} />

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {theme.isActive && (
                      <Badge variant="success" data-testid={`badge-active-${theme.id}`}>
                        <CheckCircle2Icon className="size-3" aria-hidden="true" />
                        Aktif
                      </Badge>
                    )}
                    {theme.isRecommended && (
                      <Badge variant="info">Direkomendasikan</Badge>
                    )}
                    <Badge variant={theme.isCustom ? "secondary" : "outline"}>
                      {theme.isCustom ? "Tema Kustom Berizin" : "Bawaan Platform"}
                    </Badge>
                    <Badge
                      variant={theme.compatibility.compatible ? "success" : "destructive"}
                      data-testid={`badge-compat-${theme.id}`}
                    >
                      {theme.compatibility.compatible ? (
                        <>
                          <ShieldCheckIcon className="size-3" aria-hidden="true" />
                          Kompatibel
                        </>
                      ) : (
                        <>
                          <AlertTriangleIcon className="size-3" aria-hidden="true" />
                          Tidak Kompatibel
                        </>
                      )}
                    </Badge>
                  </div>

                  <div>
                    <CardTitle>{theme.name}</CardTitle>
                    <CardDescription className="mt-1 line-clamp-2">
                      {theme.description}
                    </CardDescription>
                  </div>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <LayersIcon className="size-3.5" aria-hidden="true" />
                      {theme.supportedRoutes.length} rute · {theme.supportedSectionTypes.length}{" "}
                      bagian
                    </span>
                    <span>Skema v{theme.schemaVersion}</span>
                    <span>v{theme.version}</span>
                  </div>

                  {theme.hasSavedConfig && (
                    <div
                      className="flex items-start gap-2 rounded-md border border-border bg-muted/60 px-2.5 py-2 text-xs text-foreground"
                      data-testid={`saved-config-note-${theme.id}`}
                    >
                      <HistoryIcon
                        className="mt-0.5 size-3.5 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <span>
                        Konfigurasi tersimpan tersedia ({theme.savedTokens?.primaryColor ?? "default"}
                        ) dan akan dipulihkan otomatis saat diaktifkan.
                      </span>
                    </div>
                  )}

                  {!theme.compatibility.compatible && (
                    <div
                      className="rounded-md border border-destructive-border bg-destructive-soft px-3 py-2 text-xs text-destructive"
                      role="status"
                      data-testid={`incompatibility-reasons-${theme.id}`}
                    >
                      <p className="font-semibold">Aktivasi diblokir:</p>
                      <ul className="mt-1 list-disc pl-4">
                        {theme.compatibility.blockingReasons.map((reason, idx) => (
                          <li key={`${reason.code}-${idx}`}>{reason.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {theme.compatibility.compatible && theme.compatibility.warnings.length > 0 && (
                    <div className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning">
                      {theme.compatibility.warnings[0]}
                    </div>
                  )}
                </CardContent>

                <CardFooter className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    className="min-h-11 w-full sm:flex-1"
                    disabled={!canPreviewCard}
                    onClick={() => openCompatibilityPreview(theme)}
                    data-testid={`btn-preview-${theme.id}`}
                  >
                    <EyeIcon className="size-4" aria-hidden="true" />
                    <span>Pratinjau Kompatibilitas</span>
                  </Button>

                  <Button
                    variant={theme.isActive ? "secondary" : "default"}
                    className="min-h-11 w-full sm:w-auto"
                    disabled={!canActivateCard || isActivating}
                    onClick={() => setConfirmTarget(theme)}
                    data-testid={`btn-activate-${theme.id}`}
                  >
                    <span>{theme.isActive ? "Sedang Aktif" : "Aktifkan Tema"}</span>
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </section>
      )}

      {/* Sandboxed Compatibility Preview Dialog (@base-ui/react/dialog) */}
      <DialogPrimitive.Root
        open={previewTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            previewAbortRef.current?.abort();
            setPreviewTarget(null);
            setPreviewResult(null);
            setPreviewError(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[55] bg-foreground/40 transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <DialogPrimitive.Popup
            className="fixed inset-3 z-[60] mx-auto flex max-h-[92dvh] max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg sm:inset-6"
            data-testid="compatibility-preview-dialog"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <DialogPrimitive.Title className="truncate text-base font-semibold text-foreground">
                  Pratinjau Kompatibilitas — {previewTarget?.name ?? ""}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-xs text-muted-foreground">
                  Pratinjau draf dengan konten publik situs Anda. Status situs publik tidak diubah.
                </DialogPrimitive.Description>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div className="inline-flex rounded-md border border-border bg-muted p-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={previewViewport === "desktop" ? "default" : "ghost"}
                    className="min-h-11 sm:min-h-9"
                    aria-pressed={previewViewport === "desktop"}
                    onClick={() => setPreviewViewport("desktop")}
                    data-testid="preview-viewport-desktop"
                  >
                    <MonitorIcon className="size-4" aria-hidden="true" />
                    <span>1440px</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={previewViewport === "mobile" ? "default" : "ghost"}
                    className="min-h-11 sm:min-h-9"
                    aria-pressed={previewViewport === "mobile"}
                    onClick={() => setPreviewViewport("mobile")}
                    data-testid="preview-viewport-mobile"
                  >
                    <SmartphoneIcon className="size-4" aria-hidden="true" />
                    <span>360px</span>
                  </Button>
                </div>

                {previewTarget &&
                  !previewTarget.isActive &&
                  previewTarget.compatibility.compatible &&
                  libraryState.permissions.canActivate && (
                    <Button
                      variant="default"
                      className="min-h-11"
                      onClick={() => setConfirmTarget(previewTarget)}
                      data-testid="btn-activate-from-preview"
                    >
                      <span>Aktifkan Tema</span>
                    </Button>
                  )}

                <DialogPrimitive.Close
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11"
                      aria-label="Tutup pratinjau kompatibilitas"
                      data-testid="btn-close-preview"
                    />
                  }
                >
                  <XIcon className="size-4" aria-hidden="true" />
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Compatibility Report Strip */}
            {previewTarget && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant={previewTarget.compatibility.compatible ? "success" : "destructive"}>
                    {previewTarget.compatibility.compatible ? "Kompatibel" : "Tidak Kompatibel"}
                  </Badge>
                  <span className="tabular-nums">
                    Bagian didukung: {previewTarget.compatibility.supportedSections.length}
                  </span>
                  {previewTarget.hasSavedConfig && (
                    <span className="font-medium text-primary">
                      Menggunakan konfigurasi tersimpan tema ini
                    </span>
                  )}
                </div>
                <span>Sandbox iframe terisolasi (tanpa skrip &amp; tanpa mutasi langsung)</span>
              </div>
            )}

            {/* Sandboxed Preview Frame Body */}
            <div className="flex flex-1 flex-col items-center overflow-auto bg-muted/60 p-3 sm:p-4">
              {isPreviewLoading && (
                <div
                  className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
                  role="status"
                  data-testid="preview-loading-state"
                >
                  <RefreshCwIcon className="size-5 animate-spin text-primary" aria-hidden="true" />
                  <span>Memuat pratinjau kompatibilitas tema...</span>
                </div>
              )}

              {!isPreviewLoading && previewError && (
                <Alert variant="destructive" className="max-w-xl" data-testid="preview-error-state">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertTitle>Pratinjau Tidak Dapat Dimuat</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              )}

              {!isPreviewLoading && !previewError && previewResult && (
                <div
                  className={`flex h-full min-h-[26rem] w-full flex-col overflow-hidden rounded-md border border-border bg-card transition-[max-width] duration-150 ${
                    previewViewport === "mobile" ? "max-w-[360px]" : "max-w-full"
                  }`}
                  data-testid="preview-viewport-frame"
                  data-viewport={previewViewport}
                >
                  <iframe
                    title={`Pratinjau Kompatibilitas Tema ${previewResult.themeName}`}
                    sandbox={PREVIEW_IFRAME_SANDBOX}
                    srcDoc={previewResult.html}
                    className="h-full min-h-[26rem] w-full flex-1 border-0 bg-card"
                    data-testid="theme-compatibility-iframe"
                  />
                </div>
              )}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Activation Confirmation Dialog (@base-ui/react/dialog) */}
      <DialogPrimitive.Root
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isActivating) {
            setConfirmTarget(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[65] bg-foreground/40 transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <DialogPrimitive.Popup
            className="fixed top-1/2 left-1/2 z-[70] flex w-[min(32rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
            data-testid="activate-confirm-dialog"
          >
            <div className="space-y-1.5">
              <DialogPrimitive.Title className="text-lg font-semibold text-foreground">
                Aktifkan Tema &ldquo;{confirmTarget?.name ?? ""}&rdquo;?
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-muted-foreground">
                Perubahan tema akan diterbitkan secara atomik untuk pengunjung publik situs{" "}
                <strong className="text-foreground">{workspaceName}</strong>.
              </DialogPrimitive.Description>
            </div>

            <Separator />

            <div className="space-y-2.5 text-sm text-foreground">
              <div className="flex items-start gap-2.5">
                <ShieldCheckIcon
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p>
                  <strong>Konten situs tetap 100% utuh:</strong> seluruh{" "}
                  <span className="tabular-nums">
                    {libraryState.contentSummary.pages} halaman,{" "}
                    {libraryState.contentSummary.posts} artikel,{" "}
                    {libraryState.contentSummary.offerings} penawaran,{" "}
                    {libraryState.contentSummary.menus} menu, dan{" "}
                    {libraryState.contentSummary.media} media
                  </span>{" "}
                  tidak akan dihapus atau diubah.
                </p>
              </div>

              <div className="flex items-start gap-2.5">
                <HistoryIcon
                  className="mt-0.5 size-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <p>
                  <strong>Konfigurasi tema sebelumnya tetap tersimpan:</strong> pengaturan warna,
                  tipografi, dan varian untuk{" "}
                  <strong>{activeTheme?.name ?? libraryState.activeThemeId}</strong> tetap aman dan
                  dapat dipulihkan kapan saja saat Anda beralih kembali.
                </p>
              </div>

              {confirmTarget?.hasSavedConfig && (
                <div
                  className="rounded-md border border-info-border bg-info-soft px-3 py-2 text-xs text-info"
                  data-testid="confirm-recovery-notice"
                >
                  Konfigurasi tersimpan sebelumnya untuk tema{" "}
                  <strong>{confirmTarget.name}</strong> terdeteksi dan akan langsung dipulihkan
                  saat aktivasi.
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={isActivating}
                onClick={() => setConfirmTarget(null)}
                data-testid="btn-cancel-activate"
              >
                Batal
              </Button>
              <Button
                variant="default"
                className="min-h-11"
                disabled={isActivating}
                onClick={handleConfirmActivate}
                data-testid="btn-confirm-activate"
              >
                {isActivating ? "Mengaktifkan Tema..." : "Konfirmasi & Aktifkan Tema"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
