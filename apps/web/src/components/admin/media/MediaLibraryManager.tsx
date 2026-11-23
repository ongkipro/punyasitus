import { useCallback, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ImageIcon,
  PencilIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  UploadCloudIcon,
} from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  ConfirmDestructiveDialog,
  formatBytesHuman,
  formatDateTimeId,
  LockedTenantBanner,
  StaleWriteRecoveryBanner,
} from "@/components/admin/editor/cms-client-helpers";
import type { CmsAdminPermissions } from "@/components/admin/editor/cms-server-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  MAX_CLIENT_IMAGE_BYTES,
  MAX_CLIENT_IMAGE_LONGEST_EDGE,
  processImageFileForUpload,
} from "./client-image-processor";
import type { MediaLibraryItemDto } from "./MediaPickerSheet";

export interface StorageQuotaSnapshotDto {
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly quotaBytes: number;
  readonly availableBytes: number;
  readonly percentUsed: number;
  readonly warningAt80: boolean;
}

interface MediaListApiResponse {
  readonly items: readonly MediaLibraryItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
  readonly storage: StorageQuotaSnapshotDto;
}

interface UploadIntentResponse {
  readonly intentId: string;
  readonly uploadPath: string;
  readonly expiresAt: string;
  readonly reservedBytes: number;
  readonly quotaUsedBytes: number;
  readonly quotaLimitBytes: number;
}

export interface MediaLibraryManagerProps {
  readonly handle: string;
  readonly basePath: string;
  readonly permissions: CmsAdminPermissions;
  readonly initialItems: readonly MediaLibraryItemDto[];
  readonly initialNextCursor: string | null;
  readonly initialHasMore: boolean;
  readonly initialStorage: StorageQuotaSnapshotDto;
}

const STATUS_FILTERS = [
  { id: "all", label: "Semua" },
  { id: "ready", label: "Siap pakai" },
  { id: "processing", label: "Diproses" },
  { id: "failed", label: "Gagal" },
  { id: "trashed", label: "Sampah" },
] as const;

export function MediaLibraryManager({
  handle,
  basePath,
  permissions,
  initialItems,
  initialNextCursor,
  initialHasMore,
  initialStorage,
}: MediaLibraryManagerProps) {
  const [items, setItems] = useState<readonly MediaLibraryItemDto[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [storage, setStorage] = useState<StorageQuotaSnapshotDto>(initialStorage);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly title: string;
    readonly message: string;
    readonly transformMeta?: string;
  } | null>(null);
  const [altForUpload, setAltForUpload] = useState("");

  // Edit ALT sheet state
  const [editingItem, setEditingItem] = useState<MediaLibraryItemDto | null>(null);
  const [editAltValue, setEditAltValue] = useState("");
  const [savingAlt, setSavingAlt] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editConflict, setEditConflict] = useState(false);

  // Destructive delete/trash dialog
  const [deleteTarget, setDeleteTarget] = useState<MediaLibraryItemDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchMediaList = useCallback(
    async (opts?: { readonly cursor?: string | null; readonly append?: boolean; readonly status?: string }) => {
      setLoadingList(true);
      try {
        const activeStatus = opts?.status ?? statusFilter;
        const params = new URLSearchParams({ limit: "24" });
        if (activeStatus === "trashed") {
          params.set("status", "trashed");
          params.set("includeTrashed", "true");
        } else if (activeStatus !== "all") {
          params.set("status", activeStatus);
        }
        if (opts?.cursor) {
          params.set("cursor", opts.cursor);
        }

        const res = await cmsFetchJson<MediaListApiResponse>(
          `/api/tenants/${encodeURIComponent(handle)}/media?${params.toString()}`,
        );
        setItems((prev) => (opts?.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.page.nextCursor);
        setHasMore(res.page.hasMore);
        setStorage(res.storage);
      } catch (err) {
        setUploadFeedback({
          tone: "destructive",
          title: "Gagal memuat pustaka media",
          message: err instanceof Error ? err.message : "Terjadi gangguan saat memuat media.",
        });
      } finally {
        setLoadingList(false);
      }
    },
    [handle, statusFilter],
  );

  async function handleFileSelected(file: File | null) {
    if (!file || uploading || !permissions.canUploadMedia) return;
    setUploading(true);
    setUploadFeedback(null);

    try {
      const processed = await processImageFileForUpload(file, {
        maxLongestEdge: MAX_CLIENT_IMAGE_LONGEST_EDGE,
      });

      if (processed.declaredBytes > MAX_CLIENT_IMAGE_BYTES) {
        throw new Error(
          `Ukuran gambar (${formatBytesHuman(processed.declaredBytes)}) melebihi batas maksimum ${formatBytesHuman(MAX_CLIENT_IMAGE_BYTES)} setelah optimasi peramban.`,
        );
      }

      const transformParts: string[] = [];
      if (processed.wasAvifConverted) {
        transformParts.push(`AVIF dikonversi ke ${processed.mimeType}`);
      }
      if (processed.wasResized && processed.width && processed.height) {
        transformParts.push(
          `diperkecil dari ${processed.originalWidth}×${processed.originalHeight} ke ${processed.width}×${processed.height} px`,
        );
      }
      const transformMeta = transformParts.join(" · ");

      const resolvedAlt =
        altForUpload.trim() ||
        processed.filename
          .replace(/\.[a-z0-9]{1,8}$/i, "")
          .replace(/[-_]+/g, " ")
          .trim()
          .slice(0, 140);

      // Step 1: Authoritative server upload intent & quota reservation
      const intent = await cmsFetchJson<UploadIntentResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/media/upload-intent`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            kind: "image",
            filename: processed.filename,
            mimeType: processed.mimeType,
            declaredBytes: processed.declaredBytes,
            sha256: processed.sha256,
            alt: resolvedAlt,
          }),
        },
      );

      // Step 2: Same-origin binary streaming upload (never presigned browser PUT)
      const uploadBody = new Uint8Array(processed.bytes.byteLength);
      uploadBody.set(processed.bytes);
      const putRes = await fetch(intent.uploadPath, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": processed.mimeType,
        },
        body: new Blob([uploadBody], { type: processed.mimeType }),
      });

      let putJson: Record<string, unknown> | null = null;
      try {
        putJson = (await putRes.json()) as Record<string, unknown>;
      } catch {
        putJson = null;
      }

      if (!putRes.ok) {
        const errObj = putJson?.error as { code?: string; message?: string } | undefined;
        throw new CmsApiError(
          putRes.status,
          errObj?.code ?? "UPLOAD_FAILED",
          errObj?.message ?? `Server menolak unggahan (HTTP ${putRes.status}).`,
        );
      }

      setAltForUpload("");
      setUploadFeedback({
        tone: "success",
        title: "Gambar berhasil diunggah",
        message: `Berkas "${processed.filename}" (${formatBytesHuman(processed.declaredBytes)}) lolos validasi dan masuk antrean optimasi WebP.`,
        transformMeta: transformMeta || undefined,
      });

      await fetchMediaList({ status: statusFilter });
    } catch (err) {
      const message =
        err instanceof CmsApiError
          ? `${err.message} (${err.code})`
          : err instanceof Error
            ? err.message
            : "Unggahan gambar gagal diproses.";
      setUploadFeedback({
        tone: "destructive",
        title: "Unggahan ditolak atau gagal",
        message,
      });
    } finally {
      setUploading(false);
    }
  }

  function openEditSheet(item: MediaLibraryItemDto) {
    setEditingItem(item);
    setEditAltValue(item.alt);
    setEditError(null);
    setEditConflict(false);
  }

  async function handleSaveAlt() {
    if (!editingItem || savingAlt || !permissions.canManageMedia) return;
    setSavingAlt(true);
    setEditError(null);
    setEditConflict(false);
    try {
      const updated = await cmsFetchJson<MediaLibraryItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/media/${editingItem.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            alt: editAltValue.trim(),
            version: editingItem.version,
          }),
        },
      );
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      setEditingItem(null);
    } catch (err) {
      if (err instanceof CmsApiError && err.isStaleVersion) {
        setEditConflict(true);
        setEditError(err.message);
      } else {
        setEditError(err instanceof Error ? err.message : "Gagal menyimpan teks ALT media.");
      }
    } finally {
      setSavingAlt(false);
    }
  }

  async function handleReloadEditingItem() {
    if (!editingItem) return;
    try {
      const fresh = await cmsFetchJson<MediaLibraryItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/media/${editingItem.id}`,
      );
      setEditingItem(fresh);
      setEditAltValue(fresh.alt);
      setEditConflict(false);
      setEditError(null);
      setItems((prev) => prev.map((it) => (it.id === fresh.id ? fresh : it)));
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Gagal memuat ulang metadata media.");
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting || !permissions.canManageMedia) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const isPermanent = deleteTarget.status === "trashed";
      const url = `/api/tenants/${encodeURIComponent(handle)}/media/${deleteTarget.id}${
        isPermanent ? "?permanent=true" : ""
      }`;
      await cmsFetchJson(url, { method: "DELETE" });
      setDeleteTarget(null);
      await fetchMediaList({ status: statusFilter });
    } catch (err) {
      if (err instanceof CmsApiError) {
        setDeleteError(err.message);
      } else {
        setDeleteError("Gagal menghapus media. Pastikan media tidak sedang dipakai di konten.");
      }
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleRestoreMedia(item: MediaLibraryItemDto) {
    if (!permissions.canManageMedia) return;
    try {
      await cmsFetchJson<MediaLibraryItemDto>(
        `/api/tenants/${encodeURIComponent(handle)}/media/${item.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ version: item.version }),
        },
      );
      await fetchMediaList({ status: statusFilter });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Gagal memulihkan media.");
    }
  }

  const visibleItems = items.filter((item) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return item.alt.toLowerCase().includes(q) || String(item.id).includes(q);
  });

  const usedTotal = storage.usedBytes + storage.reservedBytes;
  const clampedPercent = Math.min(100, Math.max(0, storage.percentUsed));

  return (
    <div className="space-y-6" data-testid="media-library-screen">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            Pustaka Media
          </h1>
          <p className="text-sm text-muted-foreground">
            Unggah dan kelola gambar situs Anda. Foto AVIF dikonversi dan foto besar (&gt;2560 px)
            diperkecil otomatis di peramban sebelum diunggah.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loadingList}
          onClick={() => void fetchMediaList()}
          className="min-h-11 self-start sm:self-auto md:min-h-9"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          Muat ulang
        </Button>
      </div>

      {permissions.isLocked && <LockedTenantBanner billingHref={`${basePath}/service-status`} />}

      {/* Storage Quota Card (DESIGN.md §8) */}
      <Card data-testid="media-quota-card">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Kuota Penyimpanan Media</CardTitle>
              <CardDescription className="tabular-nums">
                Terpakai {formatBytesHuman(usedTotal)} dari {formatBytesHuman(storage.quotaBytes)} (
                {clampedPercent.toFixed(0)}%)
              </CardDescription>
            </div>
            <Badge variant={storage.warningAt80 ? "warning" : "outline"} className="tabular-nums">
              Sisa {formatBytesHuman(storage.availableBytes)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div
            role="progressbar"
            aria-label="Penggunaan kuota penyimpanan media"
            aria-valuenow={Math.round(clampedPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full transition-all ${
                storage.warningAt80 ? "bg-amber-600" : "bg-primary"
              }`}
              style={{ width: `${clampedPercent}%` }}
            />
          </div>
          {storage.warningAt80 && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
              <AlertTriangleIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Penggunaan penyimpanan telah mencapai 80% atau lebih. Hapus media yang tidak terpakai
              untuk menjaga ruang tetap tersedia.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Upload Dropzone Card */}
      <Card data-testid="media-upload-card">
        <CardHeader>
          <CardTitle className="text-base">Unggah Foto Baru</CardTitle>
          <CardDescription>
            Maksimal {Math.round(MAX_CLIENT_IMAGE_BYTES / 1_000_000)} MB per foto (JPG, PNG, WebP,
            HEIC, GIF, TIFF, AVIF); dioptimalkan otomatis ke WebP &le; 2 MB. SVG dan BMP ditolak.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="media-upload-alt"
                className="block text-sm font-medium text-foreground"
              >
                Teks ALT gambar (opsional, disarankan untuk aksesibilitas &amp; SEO)
              </label>
              <Input
                id="media-upload-alt"
                value={altForUpload}
                onChange={(e) => setAltForUpload(e.target.value)}
                disabled={!permissions.canUploadMedia || uploading}
                placeholder="Contoh: Tampak depan kantor pusat di Jakarta"
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="media-upload-alt-input"
              />
            </div>

            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-foreground">Pilih berkas gambar</span>
              <label
                className={`flex min-h-11 items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-2 text-sm font-medium transition-colors ${
                  !permissions.canUploadMedia || uploading
                    ? "cursor-not-allowed bg-muted/50 text-muted-foreground opacity-60"
                    : "cursor-pointer bg-muted/20 text-foreground hover:border-primary hover:bg-muted/40"
                }`}
              >
                <UploadCloudIcon className="size-4 text-primary" aria-hidden="true" />
                <span>
                  {uploading ? "Memproses & mengunggah foto..." : "Pilih atau tarik foto ke sini"}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/tiff,image/avif"
                  disabled={!permissions.canUploadMedia || uploading}
                  data-testid="media-file-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    void handleFileSelected(f);
                  }}
                  className="sr-only"
                />
              </label>
            </div>
          </div>

          {uploadFeedback && (
            <Alert
              variant={uploadFeedback.tone}
              data-testid="media-upload-feedback"
              data-feedback-tone={uploadFeedback.tone}
            >
              {uploadFeedback.tone === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertTriangleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertTitle>{uploadFeedback.title}</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>{uploadFeedback.message}</p>
                {uploadFeedback.transformMeta && (
                  <p className="text-xs font-medium" data-testid="media-transform-summary">
                    Pra-proses peramban: {uploadFeedback.transformMeta}
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {deleteError && (
        <Alert variant="destructive" data-testid="media-delete-error">
          <AlertTriangleIcon className="size-4" aria-hidden="true" />
          <AlertTitle>Tidak dapat menghapus media</AlertTitle>
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      {/* Filters & Search */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div
          role="tablist"
          aria-label="Filter status media"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1"
        >
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={statusFilter === f.id}
              size="sm"
              variant={statusFilter === f.id ? "default" : "ghost"}
              onClick={() => {
                setStatusFilter(f.id);
                void fetchMediaList({ status: f.id });
              }}
              className="min-h-11 md:min-h-8"
            >
              {f.label}
            </Button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari teks ALT atau ID..."
            aria-label="Cari di pustaka media"
            className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
          />
        </div>
      </div>

      {/* Media Grid */}
      {visibleItems.length === 0 ? (
        <Card data-state-panel={search || statusFilter !== "all" ? "empty-filtered" : "empty-first-run"}>
          <CardContent className="flex flex-col items-start gap-3 py-8">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ImageIcon className="size-5" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                {search || statusFilter !== "all"
                  ? "Tidak ada media yang cocok dengan filter"
                  : "Belum ada media yang diunggah"}
              </h2>
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              {search || statusFilter !== "all"
                ? "Ubah kata kunci pencarian atau pilih tab Semua untuk melihat seluruh berkas."
                : "Unggah foto produk, tim, atau lokasi bisnis pertama Anda menggunakan formulir di atas."}
            </p>
            {(search || statusFilter !== "all") && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                  void fetchMediaList({ status: "all" });
                }}
                className="min-h-11 md:min-h-9"
              >
                Reset filter
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="media-grid">
          {visibleItems.map((item) => (
            <li key={item.id}>
              <Card className="flex h-full flex-col overflow-hidden" data-testid={`media-card-${item.id}`}>
                <div className="relative flex aspect-16/10 w-full items-center justify-center border-b border-border bg-muted">
                  {item.publicUrl ? (
                    <img
                      src={item.publicUrl}
                      alt={item.alt || `Media #${item.id}`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="size-10 text-muted-foreground" aria-hidden="true" />
                  )}
                  <div className="absolute top-2 left-2">
                    <Badge
                      variant={
                        item.status === "ready"
                          ? "success"
                          : item.status === "failed" || item.status === "trashed"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {item.status === "ready"
                        ? "Siap"
                        : item.status === "processing"
                          ? "Diproses"
                          : item.status === "trashed"
                            ? "Sampah"
                            : item.status}
                    </Badge>
                  </div>
                </div>
                <CardContent className="flex flex-1 flex-col gap-2.5 p-3.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.alt || `(Tanpa teks ALT — #${item.id})`}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      ID #{item.id} · {formatBytesHuman(item.normalizedBytes)}
                      {item.width && item.height ? ` · ${item.width}×${item.height} px` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Diunggah {formatDateTimeId(item.createdAt)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {item.status !== "trashed" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!permissions.canManageMedia}
                        onClick={() => openEditSheet(item)}
                        className="min-h-11 flex-1 md:min-h-8"
                        data-testid={`media-edit-alt-${item.id}`}
                      >
                        <PencilIcon className="size-3.5" aria-hidden="true" />
                        Ubah ALT
                      </Button>
                    )}
                    {item.status === "trashed" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!permissions.canManageMedia}
                        onClick={() => void handleRestoreMedia(item)}
                        className="min-h-11 flex-1 md:min-h-8"
                      >
                        <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                        Pulihkan
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={!permissions.canManageMedia}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(item);
                      }}
                      className="min-h-11 md:min-h-8"
                      data-testid={`media-delete-${item.id}`}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden="true" />
                      {item.status === "trashed" ? "Hapus permanen" : "Hapus"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {hasMore && nextCursor && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingList}
            onClick={() => void fetchMediaList({ cursor: nextCursor, append: true })}
            className="min-h-11 md:min-h-9"
          >
            {loadingList ? "Memuat..." : "Muat lebih banyak"}
          </Button>
        </div>
      )}

      {/* Edit ALT Sheet */}
      <Sheet open={editingItem !== null} onOpenChange={(o) => !o && setEditingItem(null)}>
        <SheetContent side="right" className="w-[min(26rem,92vw)]">
          <SheetHeader>
            <SheetTitle>Ubah Teks ALT Media #{editingItem?.id}</SheetTitle>
            <SheetDescription>
              Teks ALT membantu pembaca layar dan mesin pencari memahami isi gambar.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-1 flex-col gap-4 px-4">
            {editConflict && (
              <StaleWriteRecoveryBanner
                message={editError ?? undefined}
                onReloadLatest={handleReloadEditingItem}
              />
            )}
            {editError && !editConflict && (
              <Alert variant="destructive">
                <AlertTitle>Gagal menyimpan</AlertTitle>
                <AlertDescription>{editError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="media-edit-alt-input"
                className="block text-sm font-medium text-foreground"
              >
                Teks ALT (maks 250 karakter)
              </label>
              <Input
                id="media-edit-alt-input"
                value={editAltValue}
                maxLength={250}
                onChange={(e) => setEditAltValue(e.target.value)}
                className="min-h-11 text-base md:min-h-9 md:text-sm"
                data-testid="media-edit-alt-field"
              />
            </div>
          </div>

          <SheetFooter className="flex-row justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingItem(null)}
              className="min-h-11 md:min-h-9"
            >
              Batal
            </Button>
            <Button
              type="button"
              disabled={savingAlt}
              onClick={() => void handleSaveAlt()}
              className="min-h-11 md:min-h-9"
              data-testid="media-edit-alt-save"
            >
              {savingAlt ? "Menyimpan..." : "Simpan ALT"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Explicit Destructive Confirmation Dialog */}
      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget?.status === "trashed"
            ? `Hapus permanen media #${deleteTarget?.id}?`
            : `Pindahkan media #${deleteTarget?.id} ke sampah?`
        }
        description={
          deleteTarget?.status === "trashed"
            ? "Berkas media akan dihapus permanen dari penyimpanan dan tidak dapat dipulihkan. Penghapusan akan ditolak jika media masih direferensikan oleh halaman, artikel, katalog, atau identitas situs."
            : "Media akan dipindahkan ke folder Sampah. Server akan menolak penghapusan jika gambar masih dipakai di halaman, artikel, katalog, atau logo situs."
        }
        confirmLabel={deleteTarget?.status === "trashed" ? "Hapus permanen" : "Pindahkan ke Sampah"}
        busy={deleting}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
