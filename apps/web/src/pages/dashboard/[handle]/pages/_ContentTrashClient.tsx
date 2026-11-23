import { useCallback, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import type {
  ContentMediaReferenceReport,
  ContentResourceType,
  ProtectedContentReference,
  TrashedContentSummary,
} from "@punyasitus/db/trash/types";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClockIcon,
  ImageOffIcon,
  Link2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  formatDateTimeId,
  InlineFieldError,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
} from "@/components/admin/editor/cms-client-helpers";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TrashAdminPermissions } from "./_trash-ssr-gate";

/**
 * Shared Trash & Recovery UI Island for Pages, Blog Posts, and Catalog Offerings
 * (`_ContentTrashClient.tsx`; TASK-044, REQ-048, DESIGN.md §4 & §6, PLAN §11.5).
 *
 * Implements:
 * - Loading, empty-trash, empty-filtered, retryable error, 409 stale-version,
 *   409 slug-conflict (with alternate slug rename dialog), protected-reference 409 block,
 *   media-reference warnings, locked read-only, and editor vs owner/admin permission states.
 * - Accessible Base UI dialogs (`@base-ui/react`, `render` prop, Escape/focus-return).
 * - Zero horizontal overflow and >=44px mobile touch targets across 360px, 768px, 1440px.
 */

export interface ContentTrashClientProps {
  readonly resourceType: ContentResourceType;
  readonly handle: string;
  readonly basePath: string;
  readonly offeringLabel?: string;
  readonly permissions: TrashAdminPermissions;
  readonly initialItems: readonly TrashedContentSummary[];
}

interface TrashListApiResponse {
  readonly items: readonly TrashedContentSummary[];
}

interface RestoreApiResponse {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly status: "draft";
  readonly slugChanged?: boolean;
  readonly previousSlug?: string;
  readonly homepageDemoted?: boolean;
  readonly mediaReferences?: ContentMediaReferenceReport;
}

interface SlugConflictDialogState {
  readonly item: TrashedContentSummary;
  readonly message: string;
  readonly suggestedSlug: string;
  readonly conflictKind?: string;
}

const OFFERING_TYPE_LABEL: Readonly<Record<CatalogOfferingType, string>> = {
  service: "Layanan",
  product: "Produk",
  tour: "Paket Tur",
  vehicle: "Kendaraan",
};

const RESOURCE_UI_META: Readonly<
  Record<
    ContentResourceType,
    {
      readonly heading: string;
      readonly singular: string;
      readonly backLabel: string;
      readonly listSegment: "pages" | "posts" | "catalog";
      readonly apiSegment: "pages" | "posts" | "catalog";
    }
  >
> = {
  page: {
    heading: "Sampah Halaman",
    singular: "halaman",
    backLabel: "Kembali ke Daftar Halaman",
    listSegment: "pages",
    apiSegment: "pages",
  },
  post: {
    heading: "Sampah Artikel Blog",
    singular: "artikel",
    backLabel: "Kembali ke Daftar Artikel",
    listSegment: "posts",
    apiSegment: "posts",
  },
  offering: {
    heading: "Sampah Katalog",
    singular: "penawaran",
    backLabel: "Kembali ke Daftar Katalog",
    listSegment: "catalog",
    apiSegment: "catalog",
  },
};

function extractProtectedRefsFromError(err: CmsApiError): readonly ProtectedContentReference[] {
  const raw = err.extra.protectedReferences;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is ProtectedContentReference =>
      typeof item === "object" && item !== null && typeof (item as { reason?: unknown }).reason === "string",
  );
}

function isSlugConflictError(err: CmsApiError): boolean {
  if (err.status !== 409) return false;
  return err.fields.some((f) => f.code === "SLUG_CONFLICT") || typeof err.extra.suggestedSlug === "string";
}

function isProtectedRefError(err: CmsApiError): boolean {
  if (err.status !== 409) return false;
  return (
    err.fields.some((f) => f.code === "PROTECTED_REFERENCE") ||
    Array.isArray(err.extra.protectedReferences)
  );
}

export function ContentTrashClient({
  resourceType,
  handle,
  basePath,
  offeringLabel,
  permissions,
  initialItems,
}: ContentTrashClientProps) {
  const meta = RESOURCE_UI_META[resourceType];
  const headingText =
    resourceType === "offering" && offeringLabel ? `Sampah Katalog ${offeringLabel}` : meta.heading;

  const [items, setItems] = useState<readonly TrashedContentSummary[]>(initialItems);
  const [search, setSearch] = useState("");
  const [offeringTypeFilter, setOfferingTypeFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [feedback, setFeedback] = useState<{
    readonly tone: "success" | "warning" | "destructive";
    readonly title: string;
    readonly message: string;
    readonly details?: readonly string[];
  } | null>(null);

  // Slug-conflict 409 resolution dialog state
  const [slugConflict, setSlugConflict] = useState<SlugConflictDialogState | null>(null);
  const [resolvedSlugInput, setResolvedSlugInput] = useState("");
  const [slugDialogError, setSlugDialogError] = useState<string | null>(null);

  // Permanent purge confirmation dialog state
  const [purgeTarget, setPurgeTarget] = useState<TrashedContentSummary | null>(null);
  const [purgeAckChecked, setPurgeAckChecked] = useState(false);

  const loadTrash = useCallback(
    async (opts?: { readonly offeringType?: string }) => {
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        const activeType = opts?.offeringType ?? offeringTypeFilter;
        if (resourceType === "offering" && activeType !== "all") {
          params.set("offeringType", activeType);
        }
        const res = await cmsFetchJson<TrashListApiResponse>(
          `/api/tenants/${encodeURIComponent(handle)}/${meta.apiSegment}/trash?${params.toString()}`,
        );
        setItems(res.items);
        setStaleConflict(null);
      } catch (err) {
        setLoadError(
          err instanceof Error
            ? err.message
            : `Gagal memuat daftar sampah ${meta.singular}. Silakan coba lagi.`,
        );
      } finally {
        setLoading(false);
      }
    },
    [handle, meta.apiSegment, meta.singular, offeringTypeFilter, resourceType],
  );

  async function executeRestore(item: TrashedContentSummary, resolvedSlug?: string) {
    if (!permissions.canWriteContent || busyId !== null) return;
    setBusyId(item.resourceId);
    setFeedback(null);
    setStaleConflict(null);
    setSlugDialogError(null);
    try {
      const payload: Record<string, unknown> = {
        expectedVersion: item.version,
        ...(resolvedSlug !== undefined ? { resolvedSlug: resolvedSlug.trim() } : {}),
      };
      const restored = await cmsFetchJson<RestoreApiResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/${meta.apiSegment}/${item.resourceId}/restore`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      setSlugConflict(null);
      setResolvedSlugInput("");
      setItems((prev) => prev.filter((entry) => entry.resourceId !== item.resourceId));

      const mediaWarnings = restored.mediaReferences?.warnings ?? [];
      const details: string[] = [];
      if (restored.slugChanged && restored.previousSlug) {
        details.push(
          `Slug diperbarui dari "${restored.previousSlug}" menjadi "${restored.slug}" untuk menghindari bentrok.`,
        );
      }
      if (restored.homepageDemoted) {
        details.push(
          "Status Beranda dinonaktifkan otomatis karena situs sudah memiliki halaman Beranda aktif lain.",
        );
      }
      for (const warn of mediaWarnings) {
        details.push(warn.message);
      }

      setFeedback({
        tone: mediaWarnings.length > 0 ? "warning" : "success",
        title:
          mediaWarnings.length > 0
            ? `${item.title} dipulihkan sebagai draf (perlu periksa media)`
            : `${item.title} dipulihkan sebagai draf`,
        message:
          mediaWarnings.length > 0
            ? `Konten berhasil dipulihkan ke Draf tanpa merusak isi, namun ${mediaWarnings.length} referensi media perlu diganti atau dipulihkan sebelum publikasi.`
            : `Konten berhasil dipulihkan ke daftar Draf (tidak otomatis diterbitkan ke situs publik).`,
        details: details.length > 0 ? details : undefined,
      });
    } catch (err) {
      if (err instanceof CmsApiError) {
        if (isSlugConflictError(err)) {
          const suggested =
            typeof err.extra.suggestedSlug === "string"
              ? err.extra.suggestedSlug
              : `${item.slug}-2`;
          if (slugConflict) {
            setSlugDialogError(err.message);
            setResolvedSlugInput(suggested);
          } else {
            setSlugConflict({
              item,
              message: err.message,
              suggestedSlug: suggested,
              conflictKind:
                typeof err.extra.conflictKind === "string" ? err.extra.conflictKind : undefined,
            });
            setResolvedSlugInput(suggested);
          }
          return;
        }
        if (err.code === "STALE_VERSION") {
          setSlugConflict(null);
          setStaleConflict(err.message);
          return;
        }
        if (slugConflict && err.status === 422) {
          setSlugDialogError(err.message);
          return;
        }
        setSlugConflict(null);
        setFeedback({
          tone: "destructive",
          title: `Gagal memulihkan ${meta.singular}`,
          message: err.message,
        });
      } else {
        setSlugConflict(null);
        setFeedback({
          tone: "destructive",
          title: `Gagal memulihkan ${meta.singular}`,
          message: "Terjadi gangguan jaringan saat memulihkan konten.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function executePermanentPurge() {
    if (!purgeTarget || !permissions.canPurgeContent || !purgeAckChecked || busyId !== null) {
      return;
    }
    const target = purgeTarget;
    setBusyId(target.resourceId);
    setFeedback(null);
    setStaleConflict(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/${meta.apiSegment}/${target.resourceId}/purge`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: target.version,
            confirmPermanentDelete: true,
          }),
        },
      );
      setPurgeTarget(null);
      setPurgeAckChecked(false);
      setItems((prev) => prev.filter((entry) => entry.resourceId !== target.resourceId));
      setFeedback({
        tone: "success",
        title: `${target.title} dihapus permanen`,
        message:
          "Konten, relasi taksonomi, dan riwayat slug telah dihapus secara atomik. Media bersama tetap aman di Pustaka Media.",
      });
    } catch (err) {
      setPurgeTarget(null);
      setPurgeAckChecked(false);
      if (err instanceof CmsApiError) {
        if (isProtectedRefError(err)) {
          const refs = extractProtectedRefsFromError(err);
          setFeedback({
            tone: "destructive",
            title: "Penghapusan permanen diblokir oleh referensi terlindungi (409)",
            message: err.message,
            details: refs.map((r) => r.reason),
          });
          return;
        }
        if (err.code === "STALE_VERSION") {
          setStaleConflict(err.message);
          return;
        }
        setFeedback({
          tone: "destructive",
          title: `Gagal menghapus permanen ${meta.singular}`,
          message: err.message,
        });
      } else {
        setFeedback({
          tone: "destructive",
          title: `Gagal menghapus permanen ${meta.singular}`,
          message: "Terjadi gangguan jaringan saat menghapus permanen.",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  const filtered = items.filter((item) => {
    if (resourceType === "offering" && offeringTypeFilter !== "all" && item.offeringType !== offeringTypeFilter) {
      return false;
    }
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      item.slug.toLowerCase().includes(q) ||
      item.publicPath.toLowerCase().includes(q)
    );
  });

  const hasFilters = Boolean(
    search.trim() || (resourceType === "offering" && offeringTypeFilter !== "all"),
  );

  return (
    <div className="space-y-6" data-testid="content-trash-screen" data-resource-type={resourceType}>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2 min-h-11 px-2 text-muted-foreground md:min-h-8"
              render={<a href={`${basePath}/${meta.listSegment}`} />}
              data-testid="trash-back-link"
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {meta.backLabel}
            </Button>
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{headingText}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Konten di Sampah disimpan selama 30 hari sebelum dihapus permanen otomatis. Pemulihan
            selalu mengembalikan konten sebagai Draf tanpa menerbitkannya ke situs publik.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => void loadTrash()}
          className="min-h-11 self-start sm:self-auto md:min-h-9"
          data-testid="trash-refresh-btn"
        >
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          {loading ? "Memuat..." : "Muat ulang"}
        </Button>
      </div>

      {/* Lifecycle & RBAC Permission Banners */}
      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {!permissions.isLocked && !permissions.canPurgeContent && (
        <Alert variant="default" data-state-panel="permission-editor" data-testid="trash-editor-notice">
          <ShieldAlertIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Izin peran {permissions.roleLabel}</AlertTitle>
          <AlertDescription>
            Anda dapat memulihkan {meta.singular} dari Sampah ke status Draf. Penghapusan permanen
            hanya dapat dilakukan oleh Pemilik Situs atau Admin.
          </AlertDescription>
        </Alert>
      )}

      {/* Stale-version 409 Recovery Banner */}
      {staleConflict && (
        <StaleWriteRecoveryBanner
          message={staleConflict}
          reloading={loading}
          onReloadLatest={() => loadTrash()}
          onDismiss={() => setStaleConflict(null)}
        />
      )}

      {/* Retryable Load Error */}
      {loadError && (
        <Alert variant="destructive" data-state-panel="error" data-testid="trash-error-banner">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Gagal memuat daftar Sampah</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadTrash()}
              className="min-h-11 md:min-h-9"
              data-testid="trash-retry-btn"
            >
              Coba lagi
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* Mutation Feedback */}
      {feedback && (
        <Alert
          variant={feedback.tone}
          data-testid="trash-feedback-alert"
          data-feedback-tone={feedback.tone}
        >
          <AlertTitle>{feedback.title}</AlertTitle>
          <AlertDescription>
            <p>{feedback.message}</p>
            {feedback.details && feedback.details.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                {feedback.details.map((detail, idx) => (
                  <li key={idx}>{detail}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="tabular-nums" data-testid="trash-count-badge">
            {items.length} item di Sampah
          </Badge>
          {resourceType === "offering" && (
            <select
              aria-label="Filter tipe penawaran di Sampah"
              value={offeringTypeFilter}
              onChange={(e) => {
                setOfferingTypeFilter(e.target.value);
                void loadTrash({ offeringType: e.target.value });
              }}
              className="min-h-11 rounded-md border border-input bg-card px-3 py-2 text-base text-foreground md:min-h-9 md:text-sm"
              data-testid="trash-offering-type-filter"
            >
              <option value="all">Semua tipe penawaran</option>
              <option value="service">Layanan</option>
              <option value="product">Produk</option>
              <option value="tour">Paket Tur</option>
              <option value="vehicle">Kendaraan</option>
            </select>
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Cari judul atau slug ${meta.singular}...`}
            aria-label={`Cari ${meta.singular} di Sampah`}
            className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
            data-testid="trash-search-input"
          />
        </div>
      </div>

      {/* Loading Indicator */}
      {loading && items.length === 0 ? (
        <Card data-state-panel="loading" data-testid="trash-loading-panel">
          <CardContent className="py-8 text-sm text-muted-foreground">
            Memuat daftar {meta.singular} di Sampah...
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card
          data-state-panel={hasFilters ? "empty-filtered" : "empty-trash"}
          data-testid="trash-empty-panel"
        >
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Trash2Icon className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {hasFilters
                  ? `Tidak ada ${meta.singular} di Sampah yang cocok dengan filter`
                  : `Sampah ${meta.singular} kosong`}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {hasFilters
                ? "Ubah kata kunci pencarian atau reset filter untuk melihat semua konten yang dihapus."
                : `Semua ${meta.singular} yang Anda hapus sementara akan muncul di sini selama 30 hari sebelum dihapus permanen.`}
            </p>
            {hasFilters && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setOfferingTypeFilter("all");
                  if (resourceType === "offering") {
                    void loadTrash({ offeringType: "all" });
                  }
                }}
                className="min-h-11 md:min-h-9"
                data-testid="trash-reset-filter-btn"
              >
                Reset filter
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {/* Desktop & Tablet Table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Konten</TableHead>
                    <TableHead>Retensi 30 Hari</TableHead>
                    <TableHead>Referensi & Media</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((item) => {
                    const hasProtectedRefs = item.protectedReferences.length > 0;
                    const hasMediaWarnings = item.mediaReferences.warnings.length > 0;
                    const isBusy = busyId === item.resourceId;
                    return (
                      <TableRow
                        key={item.resourceId}
                        data-testid={`trash-row-${item.resourceId}`}
                      >
                        <TableCell>
                          <div className="space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium text-foreground">{item.title}</span>
                              {item.isHomepage && <Badge variant="info">Beranda</Badge>}
                              {item.offeringType && (
                                <Badge variant="outline">
                                  {OFFERING_TYPE_LABEL[item.offeringType]}
                                </Badge>
                              )}
                            </div>
                            <p className="font-mono text-xs text-muted-foreground">
                              {item.publicPath}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5 text-xs tabular-nums">
                            <div className="flex items-center gap-1.5">
                              <ClockIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                              <Badge variant={item.isExpired ? "destructive" : "warning"}>
                                {item.isExpired
                                  ? "Siap dihapus otomatis"
                                  : `Sisa ${item.daysRemaining} hari`}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground">
                              Dihapus: {formatDateTimeId(item.deletedAt)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            {hasProtectedRefs && (
                              <Badge
                                variant="destructive"
                                data-testid={`trash-protected-badge-${item.resourceId}`}
                              >
                                <Link2Icon className="size-3" aria-hidden="true" />
                                {item.protectedReferences.length} referensi terlindungi
                              </Badge>
                            )}
                            {hasMediaWarnings && (
                              <Badge
                                variant="warning"
                                data-testid={`trash-media-warn-badge-${item.resourceId}`}
                              >
                                <ImageOffIcon className="size-3" aria-hidden="true" />
                                {item.mediaReferences.warnings.length} media perlu dicek
                              </Badge>
                            )}
                            {!hasProtectedRefs && !hasMediaWarnings && (
                              <span className="text-xs text-muted-foreground">Siap dipulihkan</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!permissions.canWriteContent || isBusy}
                              onClick={() => void executeRestore(item)}
                              data-testid={`trash-restore-${item.resourceId}`}
                            >
                              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                              Pulihkan ke Draf
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              disabled={!permissions.canPurgeContent || isBusy}
                              onClick={() => {
                                setPurgeAckChecked(false);
                                setPurgeTarget(item);
                              }}
                              title={
                                !permissions.canPurgeContent
                                  ? "Hanya Pemilik Situs atau Admin yang dapat menghapus permanen"
                                  : undefined
                              }
                              data-testid={`trash-purge-${item.resourceId}`}
                            >
                              <Trash2Icon className="size-3.5" aria-hidden="true" />
                              Hapus Permanen
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Stacked Cards (360px zero overflow, >=44px targets) */}
            <ul className="divide-y divide-border md:hidden">
              {filtered.map((item) => {
                const hasProtectedRefs = item.protectedReferences.length > 0;
                const hasMediaWarnings = item.mediaReferences.warnings.length > 0;
                const isBusy = busyId === item.resourceId;
                return (
                  <li
                    key={item.resourceId}
                    className="space-y-3 p-4"
                    data-testid={`trash-mobile-card-${item.resourceId}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {item.title}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {item.publicPath}
                        </p>
                      </div>
                      <Badge
                        variant={item.isExpired ? "destructive" : "warning"}
                        className="shrink-0 tabular-nums"
                      >
                        {item.isExpired ? "Kedaluwarsa" : `${item.daysRemaining} hari`}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {item.isHomepage && <Badge variant="info">Beranda</Badge>}
                      {item.offeringType && (
                        <Badge variant="outline">{OFFERING_TYPE_LABEL[item.offeringType]}</Badge>
                      )}
                      {hasProtectedRefs && (
                        <Badge variant="destructive">
                          {item.protectedReferences.length} referensi terlindungi
                        </Badge>
                      )}
                      {hasMediaWarnings && (
                        <Badge variant="warning">
                          {item.mediaReferences.warnings.length} media perlu dicek
                        </Badge>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground tabular-nums">
                      Dihapus: {formatDateTimeId(item.deletedAt)}
                    </p>

                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 w-full"
                        disabled={!permissions.canWriteContent || isBusy}
                        onClick={() => void executeRestore(item)}
                        data-testid={`trash-mobile-restore-${item.resourceId}`}
                      >
                        <RotateCcwIcon className="size-4" aria-hidden="true" />
                        Pulihkan ke Draf
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="min-h-11 w-full"
                        disabled={!permissions.canPurgeContent || isBusy}
                        onClick={() => {
                          setPurgeAckChecked(false);
                          setPurgeTarget(item);
                        }}
                        data-testid={`trash-mobile-purge-${item.resourceId}`}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                        Hapus Permanen
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* 409 Slug Conflict Resolution Dialog */}
      <DialogPrimitive.Root
        open={slugConflict !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSlugConflict(null);
            setSlugDialogError(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-foreground/40 transition-opacity duration-150" />
          <DialogPrimitive.Popup
            data-testid="slug-conflict-dialog"
            className="fixed top-1/2 left-1/2 z-[75] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-warning">
                <AlertTriangleIcon className="size-5 shrink-0" aria-hidden="true" />
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Slug bentrok saat memulihkan (409)
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Tutup dialog konflik slug"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {slugConflict?.message}
            </DialogPrimitive.Description>

            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (slugConflict) {
                  void executeRestore(slugConflict.item, resolvedSlugInput);
                }
              }}
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="trash-resolved-slug-input"
                  className="text-sm font-medium text-foreground"
                >
                  Slug alternatif untuk pemulihan
                </label>
                <Input
                  id="trash-resolved-slug-input"
                  type="text"
                  value={resolvedSlugInput}
                  onChange={(e) => setResolvedSlugInput(e.target.value)}
                  className="min-h-11 font-mono text-base md:min-h-9 md:text-sm"
                  data-testid="slug-conflict-input"
                  required
                />
                <InlineFieldError message={slugDialogError} />
              </div>

              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => {
                    setSlugConflict(null);
                    setSlugDialogError(null);
                  }}
                  className="min-h-11 md:min-h-9"
                  data-testid="slug-conflict-cancel"
                >
                  Batal
                </Button>
                <Button
                  type="submit"
                  disabled={busyId !== null || !resolvedSlugInput.trim()}
                  className="min-h-11 md:min-h-9"
                  data-testid="slug-conflict-confirm"
                >
                  {busyId !== null ? "Memulihkan..." : "Pulihkan dengan Slug Ini"}
                </Button>
              </div>
            </form>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Permanent Purge Confirmation Dialog */}
      <DialogPrimitive.Root
        open={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPurgeTarget(null);
            setPurgeAckChecked(false);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-foreground/40 transition-opacity duration-150" />
          <DialogPrimitive.Popup
            data-testid="permanent-purge-dialog"
            className="fixed top-1/2 left-1/2 z-[75] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-destructive">
                <Trash2Icon className="size-5 shrink-0" aria-hidden="true" />
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Hapus permanen &ldquo;{purgeTarget?.title ?? ""}&rdquo;?
                </DialogPrimitive.Title>
              </div>
              <DialogPrimitive.Close
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Tutup dialog hapus permanen"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                  />
                }
              >
                <XIcon className="size-4" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
              Tindakan ini tidak dapat dibatalkan. Konten, relasi taksonomi, riwayat revisi, dan
              riwayat slug lama akan dihapus permanen. File media bersama di Pustaka Media tetap
              dipertahankan.
            </DialogPrimitive.Description>

            {purgeTarget && purgeTarget.protectedReferences.length > 0 && (
              <Alert variant="warning" className="mt-3" data-testid="purge-dialog-protected-warning">
                <AlertTriangleIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Referensi terlindungi terdeteksi</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4 text-xs">
                    {purgeTarget.protectedReferences.map((ref, idx) => (
                      <li key={idx}>{ref.reason}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <input
                type="checkbox"
                checked={purgeAckChecked}
                onChange={(e) => setPurgeAckChecked(e.target.checked)}
                className="mt-0.5 size-4 accent-destructive"
                data-testid="permanent-purge-checkbox"
              />
              <span>
                Saya memahami penghapusan permanen ini tidak dapat dikembalikan.
              </span>
            </label>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={busyId !== null}
                onClick={() => {
                  setPurgeTarget(null);
                  setPurgeAckChecked(false);
                }}
                className="min-h-11 md:min-h-9"
                data-testid="permanent-purge-cancel"
              >
                Batal
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!purgeAckChecked || busyId !== null}
                onClick={() => void executePermanentPurge()}
                className="min-h-11 md:min-h-9"
                data-testid="permanent-purge-confirm"
              >
                {busyId !== null ? "Menghapus..." : "Hapus Permanen"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
