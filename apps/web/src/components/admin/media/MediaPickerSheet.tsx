import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  CaptionsIcon,
  CheckCircle2Icon,
  CheckIcon,
  FilmIcon,
  ImageIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react";
import {
  validateVideoPlacement,
  type VideoPlacement,
} from "@punyasitus/core/media/video";
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
import {
  MAX_CLIENT_VIDEOS_PER_SITE,
  prepareVideoFileForUpload,
  prepareWebVttCaptionFile,
  VideoClientValidationError,
  type VideoClientValidationErrorKind,
} from "./client-video-processor";

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
  readonly durationSeconds?: number | null;
  readonly posterUrl?: string | null;
  readonly captionsUrl?: string | null;
  readonly captionsLang?: string | null;
  readonly captionsLabel?: string | null;
  readonly processingPath?: "worker_faststart" | "container_transcode" | null;
  readonly posterSource?: "client_frame" | "container_frame" | "default" | null;
  readonly errorCode?: string | null;
}

export interface VideoSlotsDto {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

interface MediaListApiResponse {
  readonly items: readonly MediaLibraryItemDto[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
  readonly videoSlots?: VideoSlotsDto;
}

interface UploadIntentResponse {
  readonly intentId: string;
  readonly uploadPath: string;
  readonly expiresAt: string;
  readonly reservedBytes: number;
  readonly quotaUsedBytes: number;
  readonly quotaLimitBytes: number;
  readonly videoSlotsUsed?: number;
  readonly videoSlotsLimit?: number;
}

export interface MediaPickerSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly handle: string;
  readonly title?: string;
  readonly acceptKind?: "image" | "video" | "all";
  readonly placement?: VideoPlacement;
  readonly selectedMediaId?: number | null;
  readonly canUpload?: boolean;
  readonly onSelect: (item: MediaLibraryItemDto) => void;
}

export function MediaPickerSheet({
  open,
  onOpenChange,
  handle,
  title = "Pilih Gambar dari Pustaka Media",
  acceptKind = "image",
  placement,
  selectedMediaId = null,
  canUpload = true,
  onSelect,
}: MediaPickerSheetProps) {
  const [activeKind, setActiveKind] = useState<"image" | "video">(
    acceptKind === "video" ? "video" : "image",
  );
  const [items, setItems] = useState<readonly MediaLibraryItemDto[]>([]);
  const [videoSlots, setVideoSlots] = useState<VideoSlotsDto>({
    used: 0,
    limit: MAX_CLIENT_VIDEOS_PER_SITE,
    remaining: MAX_CLIENT_VIDEOS_PER_SITE,
  });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{
    readonly message: string;
    readonly kind?: VideoClientValidationErrorKind | "server";
  } | null>(null);
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [captionTargetId, setCaptionTargetId] = useState<number | null>(null);
  const [captionFeedback, setCaptionFeedback] = useState<{
    readonly tone: "success" | "destructive";
    readonly message: string;
  } | null>(null);

  const placementCheck = placement ? validateVideoPlacement(placement) : null;
  const isHeroVideoBlocked = activeKind === "video" && placementCheck !== null && !placementCheck.ok;

  useEffect(() => {
    if (acceptKind === "video") {
      setActiveKind("video");
    } else if (acceptKind === "image") {
      setActiveKind("image");
    }
  }, [acceptKind]);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (acceptKind !== "all") {
        params.set("kind", acceptKind);
      }
      const res = await cmsFetchJson<MediaListApiResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/media?${params.toString()}`,
      );
      setItems(res.items);
      if (res.videoSlots) {
        setVideoSlots(res.videoSlots);
      }
    } catch (err) {
      setListError(
        err instanceof CmsApiError
          ? err.message
          : "Gagal memuat pustaka media. Silakan coba lagi.",
      );
    } finally {
      setLoading(false);
    }
  }, [handle, acceptKind]);

  useEffect(() => {
    if (open) {
      void loadMedia();
    }
  }, [open, loadMedia]);

  async function handleQuickImageUpload(file: File | null) {
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
      setUploadError({
        kind: "server",
        message: err instanceof Error ? err.message : "Gagal mengunggah berkas gambar.",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handleQuickVideoUpload(file: File | null) {
    if (!canUpload || !file || uploading || isHeroVideoBlocked) return;
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const prepared = await prepareVideoFileForUpload(file);

      const intent = await cmsFetchJson<UploadIntentResponse>(
        `/api/tenants/${encodeURIComponent(handle)}/media/video/upload-intent`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            kind: "video",
            filename: prepared.filename,
            mimeType: prepared.mimeType,
            declaredBytes: prepared.declaredBytes,
            sha256: prepared.sha256,
            alt: prepared.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 120),
            ...(placement ? { placement } : {}),
          }),
        },
      );

      const uploadBody = new Uint8Array(prepared.bytes.byteLength);
      uploadBody.set(prepared.bytes);
      const putRes = await fetch(intent.uploadPath, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": prepared.mimeType,
        },
        body: new Blob([uploadBody], { type: prepared.mimeType }),
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
          errObj?.message ?? `Unggahan video gagal (HTTP ${putRes.status}).`,
        );
      }

      // Optional client-captured WebP poster upload
      const mediaId = typeof putJson?.mediaId === "number" ? putJson.mediaId : null;
      if (mediaId && prepared.posterWebpBytes && prepared.posterWebpBytes.byteLength > 0) {
        const posterCopy = new Uint8Array(prepared.posterWebpBytes.byteLength);
        posterCopy.set(prepared.posterWebpBytes);
        await fetch(`/api/tenants/${encodeURIComponent(handle)}/media/${mediaId}/poster`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "image/webp" },
          body: new Blob([posterCopy], { type: "image/webp" }),
        }).catch(() => undefined);
      }

      setUploadNote(
        `Video "${prepared.filename}" (${formatBytesHuman(prepared.declaredBytes)}) diterima dan sedang diproses. Video akan siap dipilih setelah selesai.`,
      );
      await loadMedia();
    } catch (err) {
      if (err instanceof VideoClientValidationError) {
        setUploadError({ kind: err.kind, message: err.message });
      } else if (err instanceof CmsApiError) {
        const kind: VideoClientValidationErrorKind | "server" =
          err.status === 413
            ? "size"
            : err.status === 415
              ? "format"
              : err.code === "VIDEO_LIMIT_REACHED"
                ? "limit"
                : "server";
        setUploadError({ kind, message: `${err.message} (${err.code})` });
      } else {
        setUploadError({
          kind: "server",
          message: err instanceof Error ? err.message : "Gagal mengunggah video.",
        });
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleRetryVideo(item: MediaLibraryItemDto) {
    if (retryingId !== null) return;
    setRetryingId(item.id);
    setUploadError(null);
    setUploadNote(null);
    try {
      await cmsFetchJson(
        `/api/tenants/${encodeURIComponent(handle)}/media/${item.id}/retry`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      setUploadNote(`Pemrosesan ulang video #${item.id} dijadwalkan. Status kini Diproses.`);
      await loadMedia();
    } catch (err) {
      setUploadError({
        kind: "server",
        message:
          err instanceof CmsApiError
            ? err.message
            : "Gagal menjadwalkan ulang pemrosesan video. Silakan unggah ulang berkas.",
      });
    } finally {
      setRetryingId(null);
    }
  }

  async function handleCaptionUpload(item: MediaLibraryItemDto, file: File | null) {
    if (!file) return;
    setCaptionTargetId(item.id);
    setCaptionFeedback(null);
    try {
      const prepared = await prepareWebVttCaptionFile(file);
      const vttCopy = new Uint8Array(prepared.sanitizedBytes.byteLength);
      vttCopy.set(prepared.sanitizedBytes);
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(handle)}/media/${item.id}/captions?lang=id`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "text/vtt; charset=utf-8",
            "X-Caption-Lang": "id",
            "X-Caption-Label": "Bahasa Indonesia",
          },
          body: new Blob([vttCopy], { type: "text/vtt" }),
        },
      );
      let json: Record<string, unknown> | null = null;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const errObj = json?.error as { message?: string } | undefined;
        throw new Error(errObj?.message ?? `Unggahan takarir gagal (HTTP ${res.status}).`);
      }
      setCaptionFeedback({
        tone: "success",
        message: `Takarir WebVTT untuk video #${item.id} tersimpan (${prepared.cueCount} baris${prepared.strippedHtml ? ", tag HTML dibersihkan" : ""}).`,
      });
      await loadMedia();
    } catch (err) {
      setCaptionFeedback({
        tone: "destructive",
        message:
          err instanceof Error ? err.message : "Berkas takarir WebVTT (.vtt) tidak valid.",
      });
    } finally {
      setCaptionTargetId(null);
    }
  }

  const filtered = items.filter((item) => {
    if (item.status === "trashed") return false;
    if (acceptKind === "all" && item.kind !== activeKind) return false;
    if (acceptKind !== "all" && item.kind !== acceptKind) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return item.alt.toLowerCase().includes(q) || String(item.id).includes(q);
  });

  const isVideoMode = activeKind === "video";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(34rem,94vw)]"
        data-testid="media-picker-sheet"
        data-picker-kind={activeKind}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {isVideoMode
              ? "Maksimal 10 MB per video (MP4, MOV, WebM; maks 20 video). Untuk video panjang gunakan tautan YouTube."
              : "Pilih gambar siap pakai dari pustaka tenant atau unggah gambar baru."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-2">
          {acceptKind === "all" && (
            <div
              role="tablist"
              aria-label="Jenis media"
              className="flex items-center gap-1 rounded-md border border-border bg-card p-1"
            >
              <Button
                type="button"
                role="tab"
                size="sm"
                aria-selected={activeKind === "image"}
                variant={activeKind === "image" ? "default" : "ghost"}
                onClick={() => {
                  setActiveKind("image");
                  setUploadError(null);
                  setUploadNote(null);
                }}
                className="min-h-11 flex-1 md:min-h-8"
                data-testid="media-picker-tab-image"
              >
                <ImageIcon className="size-3.5" aria-hidden="true" />
                Foto
              </Button>
              <Button
                type="button"
                role="tab"
                size="sm"
                aria-selected={activeKind === "video"}
                variant={activeKind === "video" ? "default" : "ghost"}
                onClick={() => {
                  setActiveKind("video");
                  setUploadError(null);
                  setUploadNote(null);
                }}
                className="min-h-11 flex-1 md:min-h-8"
                data-testid="media-picker-tab-video"
              >
                <FilmIcon className="size-3.5" aria-hidden="true" />
                Video Pendek ({videoSlots.used}/{videoSlots.limit})
              </Button>
            </div>
          )}

          {isVideoMode && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground tabular-nums">
              <span>Slot video situs: {videoSlots.used} dari {videoSlots.limit} terpakai</span>
              <Badge variant={videoSlots.remaining === 0 ? "destructive" : "outline"}>
                Sisa {videoSlots.remaining} slot
              </Badge>
            </div>
          )}

          {isHeroVideoBlocked && placementCheck && !placementCheck.ok && (
            <Alert variant="destructive" data-testid="media-picker-hero-video-error">
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Video tidak diizinkan pada Hero</AlertTitle>
              <AlertDescription>{placementCheck.messageId}</AlertDescription>
            </Alert>
          )}

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
                placeholder={isVideoMode ? "Cari judul video atau ID..." : "Cari teks ALT atau ID media..."}
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

          {canUpload && !isHeroVideoBlocked && (
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted">
              <UploadIcon className="size-4 text-primary" aria-hidden="true" />
              <span>
                {uploading
                  ? isVideoMode
                    ? "Memvalidasi & mengunggah video..."
                    : "Memproses & mengunggah..."
                  : isVideoMode
                    ? "Unggah video baru (MP4, MOV, WebM ≤ 10 MB)"
                    : "Unggah gambar baru"}
              </span>
              <input
                type="file"
                accept={
                  isVideoMode
                    ? "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                    : "image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/tiff,image/avif"
                }
                disabled={uploading}
                data-testid={isVideoMode ? "media-picker-video-input" : "media-picker-image-input"}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.target.value = "";
                  if (isVideoMode) {
                    void handleQuickVideoUpload(f);
                  } else {
                    void handleQuickImageUpload(f);
                  }
                }}
                className="sr-only"
              />
            </label>
          )}

          {uploadNote && (
            <Alert variant="success" data-testid="media-picker-upload-note">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              <AlertTitle>Unggahan diterima</AlertTitle>
              <AlertDescription>{uploadNote}</AlertDescription>
            </Alert>
          )}

          {uploadError && (
            <Alert
              variant="destructive"
              data-testid={isVideoMode ? "video-upload-error" : "image-upload-error"}
              data-error-kind={uploadError.kind ?? "server"}
            >
              <AlertTriangleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>
                {isVideoMode ? "Gagal mengunggah video" : "Gagal mengunggah gambar"}
              </AlertTitle>
              <AlertDescription>{uploadError.message}</AlertDescription>
            </Alert>
          )}

          {captionFeedback && (
            <Alert
              variant={captionFeedback.tone}
              data-testid="video-caption-feedback"
              data-feedback-tone={captionFeedback.tone}
            >
              {captionFeedback.tone === "success" ? (
                <CheckCircle2Icon className="size-4" aria-hidden="true" />
              ) : (
                <AlertTriangleIcon className="size-4" aria-hidden="true" />
              )}
              <AlertTitle>
                {captionFeedback.tone === "success" ? "Takarir tersimpan" : "Takarir ditolak"}
              </AlertTitle>
              <AlertDescription>{captionFeedback.message}</AlertDescription>
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
              {isVideoMode
                ? "Belum ada video pendek. Unggah video MP4/MOV/WebM hingga 10 MB di atas."
                : "Belum ada media yang cocok. Unggah foto baru atau buka halaman Media."}
            </div>
          ) : (
            <ul className={isVideoMode ? "space-y-3" : "grid grid-cols-2 gap-3"}>
              {filtered.map((item) => {
                const isSelected = selectedMediaId === item.id;
                const isReady = item.status === "ready" && !isHeroVideoBlocked;
                const isProcessing = item.status === "processing" || item.status === "quarantined";
                const isFailed = item.status === "failed";
                const previewImgUrl = item.kind === "video" ? item.posterUrl : item.publicUrl;

                if (item.kind === "video") {
                  return (
                    <li
                      key={item.id}
                      className={`overflow-hidden rounded-md border bg-card ${
                        isSelected ? "border-primary ring-2 ring-primary/25" : "border-border"
                      }`}
                      data-testid={`media-picker-video-card-${item.id}`}
                      data-video-status={item.status}
                    >
                      <button
                        type="button"
                        disabled={!isReady}
                        onClick={() => {
                          onSelect(item);
                          onOpenChange(false);
                        }}
                        data-testid={`media-picker-item-${item.id}`}
                        className={`flex w-full items-start gap-3 p-3 text-left transition-colors ${
                          !isReady ? "cursor-not-allowed opacity-80" : "hover:bg-muted/30"
                        }`}
                      >
                        <div className="relative flex aspect-video w-28 shrink-0 items-center justify-center overflow-hidden rounded bg-[#132220]">
                          {previewImgUrl ? (
                            <img
                              src={previewImgUrl}
                              alt={item.alt || `Video #${item.id}`}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : isProcessing ? (
                            <Loader2Icon
                              className="size-6 animate-spin text-emerald-300"
                              aria-hidden="true"
                            />
                          ) : (
                            <FilmIcon className="size-6 text-slate-300" aria-hidden="true" />
                          )}
                          {isSelected && (
                            <span className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <CheckIcon className="size-3" aria-hidden="true" />
                            </span>
                          )}
                        </div>

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <p className="truncate text-sm font-medium text-foreground">
                              {item.alt || `Video #${item.id}`}
                            </p>
                            <Badge
                              variant={
                                item.status === "ready"
                                  ? "success"
                                  : isFailed
                                    ? "destructive"
                                    : "warning"
                              }
                            >
                              {item.status === "ready"
                                ? "Siap"
                                : isProcessing
                                  ? "Diproses"
                                  : "Gagal"}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground tabular-nums">
                            #{item.id} · {formatBytesHuman(item.normalizedBytes)}
                            {item.width && item.height ? ` · ${item.width}×${item.height} px` : ""}
                            {item.captionsUrl ? " · Takarir WebVTT" : ""}
                          </p>
                          {isProcessing && (
                            <p className="text-xs font-medium text-amber-700" data-testid={`video-processing-note-${item.id}`}>
                              Sedang memproses video... Video dapat dipilih setelah selesai.
                            </p>
                          )}
                          {isFailed && (
                            <p className="text-xs font-medium text-destructive" data-testid={`video-failed-note-${item.id}`}>
                              Pemrosesan gagal{item.errorCode ? ` (${item.errorCode})` : ""}. Klik Coba lagi atau unggah berkas baru.
                            </p>
                          )}
                        </div>
                      </button>

                      {/* Action row for Retry (failed) or WebVTT Caption upload (ready) */}
                      {(isFailed || item.status === "ready") && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-3 py-2">
                          {isFailed && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={retryingId === item.id}
                              onClick={() => void handleRetryVideo(item)}
                              className="min-h-11 md:min-h-8"
                              data-testid={`video-retry-btn-${item.id}`}
                            >
                              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                              {retryingId === item.id ? "Menjadwalkan ulang..." : "Coba lagi"}
                            </Button>
                          )}
                          {item.status === "ready" && canUpload && (
                            <label
                              className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted md:min-h-8"
                              data-testid={`video-caption-upload-${item.id}`}
                            >
                              <CaptionsIcon className="size-3.5 text-primary" aria-hidden="true" />
                              <span>
                                {captionTargetId === item.id
                                  ? "Mengunggah takarir..."
                                  : item.captionsUrl
                                    ? "Ganti takarir (.vtt)"
                                    : "Unggah takarir (.vtt)"}
                              </span>
                              <input
                                type="file"
                                accept=".vtt,text/vtt"
                                disabled={captionTargetId === item.id}
                                data-testid={`video-caption-input-${item.id}`}
                                onChange={(e) => {
                                  const f = e.target.files?.[0] ?? null;
                                  e.target.value = "";
                                  void handleCaptionUpload(item, f);
                                }}
                                className="sr-only"
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </li>
                  );
                }

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
