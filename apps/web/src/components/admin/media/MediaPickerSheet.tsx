import { useCallback, useEffect, useState } from "react";
import { CheckIcon, ImageIcon, RefreshCwIcon, SearchIcon, UploadIcon } from "lucide-react";
import {
  CmsApiError,
  cmsFetchJson,
  formatBytesHuman,
} from "@/components/admin/editor/cms-client-helpers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MAX_CLIENT_IMAGE_BYTES, processImageFileForUpload } from "./client-image-processor";

export interface MediaLibraryItemDto {
  readonly id: number;
  readonly kind: "image" | "video";
  readonly status: "quarantined" | "processing" | "ready" | "failed" | "trashed";
  readonly alt: string;
  readonly normalizedBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly publicUrl: string | null;
  readonly version: number;
  readonly createdAt: string;
}

interface MediaListApiResponse {
  readonly items: readonly MediaLibraryItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

interface UploadIntentResponse {
  readonly intentId: string;
  readonly uploadPath: string;
  readonly expiresAt: string;
  readonly reservedBytes: number;
  readonly quotaUsedBytes: number;
  readonly quotaLimitBytes: number;
}

export interface MediaPickerSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly handle: string;
  readonly title?: string;
  readonly selectedMediaId?: number | null;
  readonly canUpload?: boolean;
  readonly onSelect: (item: MediaLibraryItemDto) => void;
}

export function MediaPickerSheet({
  open,
  onOpenChange,
  handle,
  title = "Pilih Gambar dari Pustaka Media",
  selectedMediaId = null,
  canUpload = true,
  onSelect,
}: MediaPickerSheetProps) {
  const [items, setItems] = useState<readonly MediaLibraryItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await cmsFetchJson<MediaListApiResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/media?limit=50`,
      );
      setItems(res.items);
    } catch (err) {
      setListError(
        err instanceof CmsApiError
          ? err.message
          : "Gagal memuat pustaka media. Silakan coba lagi.",
      );
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    if (open) {
      void loadMedia();
    }
  }, [open, loadMedia]);

  async function handleQuickUpload(file: File | null) {
    if (!canUpload || !file || uploading) return;
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const processed = await processImageFileForUpload(file);
      if (processed.declaredBytes > MAX_CLIENT_IMAGE_BYTES) {
        throw new Error(
          `Ukuran gambar (${formatBytesHuman(processed.declaredBytes)}) melebihi batas maksimum ${formatBytesHuman(MAX_CLIENT_IMAGE_BYTES)}.`,
        );
      }
      const notes: string[] = [];
      if (processed.wasAvifConverted) notes.push(`AVIF dikonversi ke ${processed.mimeType}`);
      if (processed.wasResized) {
        notes.push(`diperkecil ke ${processed.width}×${processed.height} px`);
      }

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
            alt: processed.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 120),
          }),
        },
      );

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

      if (!putRes.ok) {
        let msg = `Unggahan gagal (HTTP ${putRes.status}).`;
        try {
          const j = (await putRes.json()) as { error?: { message?: string } };
          if (j?.error?.message) msg = j.error.message;
        } catch {
          // ignore
        }
        throw new CmsApiError(putRes.status, "UPLOAD_FAILED", msg);
      }

      setUploadNote(
        notes.length > 0
          ? `Berkas diunggah (${notes.join(", ")}) dan sedang diproses.`
          : "Berkas berhasil diunggah dan sedang diproses.",
      );
      await loadMedia();
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "Gagal mengunggah berkas gambar.",
      );
    } finally {
      setUploading(false);
    }
  }

  const filtered = items.filter((item) => {
    if (item.status === "trashed") return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return item.alt.toLowerCase().includes(q) || String(item.id).includes(q);
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(32rem,94vw)]"
        data-testid="media-picker-sheet"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            Pilih gambar siap pakai dari pustaka tenant atau unggah gambar baru.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Cari teks ALT atau ID media..."
                aria-label="Cari media"
                className="min-h-11 pl-9 text-base md:min-h-9 md:text-sm"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void loadMedia()}
              aria-label="Muat ulang daftar media"
              className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
            </Button>
          </div>

          {canUpload && (
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
              <UploadIcon className="size-4 text-primary" aria-hidden="true" />
              <span>{uploading ? "Memproses & mengunggah..." : "Unggah gambar baru"}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/tiff,image/avif"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  void handleQuickUpload(f);
                }}
                className="sr-only"
              />
            </label>
          )}

          {uploadNote && (
            <Alert variant="success">
              <AlertTitle>Unggahan diterima</AlertTitle>
              <AlertDescription>{uploadNote}</AlertDescription>
            </Alert>
          )}

          {uploadError && (
            <Alert variant="destructive">
              <AlertTitle>Gagal mengunggah gambar</AlertTitle>
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          )}

          {listError && (
            <Alert variant="destructive">
              <AlertTitle>Gagal memuat media</AlertTitle>
              <AlertDescription>{listError}</AlertDescription>
            </Alert>
          )}

          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Memuat pustaka media...</p>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
              Belum ada media yang cocok. Unggah foto baru atau buka halaman Media.
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3">
              {filtered.map((item) => {
                const isSelected = selectedMediaId === item.id;
                const isReady = item.status === "ready";
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={!isReady}
                      onClick={() => {
                        onSelect(item);
                        onOpenChange(false);
                      }}
                      data-testid={`media-picker-item-${item.id}`}
                      className={`group flex w-full flex-col overflow-hidden rounded-md border text-left transition-colors ${
                        isSelected
                          ? "border-primary ring-2 ring-primary/25"
                          : "border-border hover:border-primary/60"
                      } ${!isReady ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <div className="relative flex aspect-4/3 w-full items-center justify-center bg-muted">
                        {item.publicUrl ? (
                          <img
                            src={item.publicUrl}
                            alt={item.alt || `Media #${item.id}`}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="size-8 text-muted-foreground" aria-hidden="true" />
                        )}
                        {isSelected && (
                          <span className="absolute top-1.5 right-1.5 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <CheckIcon className="size-3.5" aria-hidden="true" />
                          </span>
                        )}
                      </div>
                      <div className="space-y-1 p-2">
                        <p className="truncate text-xs font-medium text-foreground">
                          {item.alt || `Media #${item.id}`}
                        </p>
                        <div className="flex items-center justify-between gap-1 text-[11px] text-muted-foreground tabular-nums">
                          <span>#{item.id} · {formatBytesHuman(item.normalizedBytes)}</span>
                          {!isReady && <Badge variant="warning">{item.status}</Badge>}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="min-h-11 md:min-h-9"
          >
            Tutup
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
