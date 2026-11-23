import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CaptionsIcon,
  FilmIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import {
  createShortVideoBlock,
  MAX_VIDEO_CAPTION_TEXT_LENGTH,
  MAX_VIDEO_TITLE_LENGTH,
  validateVideoPlacement,
  type ShortVideoBlock,
  type VideoPlacement,
} from "@punyasitus/core/media/video";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  MediaPickerSheet,
  type MediaLibraryItemDto,
} from "@/components/admin/media/MediaPickerSheet";
import { cn } from "@/lib/utils";

export interface ShortVideoBlockEditorProps {
  readonly handle: string;
  readonly placement?: VideoPlacement;
  readonly value?: ShortVideoBlock | null;
  readonly onChange?: (block: ShortVideoBlock | null) => void;
  readonly onApply?: (block: ShortVideoBlock) => void;
  readonly onRemove?: () => void;
  readonly disabled?: boolean;
  readonly contextLabel?: string;
  readonly idPrefix?: string;
  readonly className?: string;
}

/**
 * Accessible Admin Editor Block for Self-Hosted Short Videos (`<= 10 MB`, max 20/site)
 * (REQ-062, REQ-039, REQ-040; DESIGN.md §8; built strictly on `@base-ui/react`
 * primitives via `@/components/ui/*`).
 *
 * Guarantees:
 * - Strictly rejects `placement="hero"` with an explicit Bahasa Indonesia guardrail alert.
 * - Never permits `autoplay` (`preload="none"`, `playsinline`, `controls` always).
 * - Selects only `ready` videos from `MediaPickerSheet` (supports video error/processing/retry/caption states).
 */
export function ShortVideoBlockEditor({
  handle,
  placement = "portfolio",
  value = null,
  onChange,
  onApply,
  onRemove,
  disabled = false,
  contextLabel = "Portofolio",
  idPrefix = "short-video-block",
  className,
}: ShortVideoBlockEditorProps) {
  const placementCheck = React.useMemo(() => validateVideoPlacement(placement), [placement]);
  const isHeroBlocked = !placementCheck.ok;

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [selectedVideo, setSelectedVideo] = React.useState<{
    readonly id: number;
    readonly src: string;
    readonly posterUrl: string;
    readonly width: number;
    readonly height: number;
    readonly durationSeconds: number | null;
    readonly captionsUrl: string | null;
    readonly captionsLang: string | null;
    readonly captionsLabel: string | null;
  } | null>(() =>
    value
      ? {
          id: value.mediaId,
          src: value.src,
          posterUrl: value.posterUrl,
          width: value.width,
          height: value.height,
          durationSeconds: value.durationSeconds ?? null,
          captionsUrl: value.captionsUrl ?? null,
          captionsLang: value.captionsLang ?? "id",
          captionsLabel: value.captionsLabel ?? "Bahasa Indonesia",
        }
      : null,
  );

  const [titleInput, setTitleInput] = React.useState(value?.title ?? "");
  const [captionInput, setCaptionInput] = React.useState(value?.caption ?? "");
  const [touched, setTouched] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  const titleTrimmed = titleInput.trim();
  const titleError =
    touched && titleTrimmed.length === 0
      ? "Judul video wajib diisi agar pengunjung dan pembaca layar memahami isi video."
      : titleTrimmed.length > MAX_VIDEO_TITLE_LENGTH
        ? `Judul video maksimal ${MAX_VIDEO_TITLE_LENGTH} karakter.`
        : null;

  function handleVideoPicked(item: MediaLibraryItemDto) {
    if (item.kind !== "video" || item.status !== "ready" || !item.publicUrl) {
      return;
    }
    const nextSelected = {
      id: item.id,
      src: item.publicUrl,
      posterUrl: item.posterUrl ?? item.publicUrl,
      width: item.width ?? 1280,
      height: item.height ?? 720,
      durationSeconds: item.durationSeconds ?? null,
      captionsUrl: item.captionsUrl ?? null,
      captionsLang: item.captionsLang ?? "id",
      captionsLabel: item.captionsLabel ?? "Bahasa Indonesia",
    };
    setSelectedVideo(nextSelected);
    if (!titleInput.trim() && item.alt) {
      setTitleInput(item.alt.slice(0, MAX_VIDEO_TITLE_LENGTH));
    }
    setErrorMessage(null);
    setStatusMessage(null);
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    setErrorMessage(null);
    setStatusMessage(null);

    if (isHeroBlocked) {
      setErrorMessage(placementCheck.messageId);
      return;
    }

    if (!selectedVideo) {
      setErrorMessage("Pilih video pendek berstatus Siap dari Pustaka Media terlebih dahulu.");
      return;
    }

    const built = createShortVideoBlock({
      mediaId: selectedVideo.id,
      src: selectedVideo.src,
      posterUrl: selectedVideo.posterUrl,
      width: selectedVideo.width,
      height: selectedVideo.height,
      title: titleInput,
      placement,
      caption: captionInput || null,
      captionsUrl: selectedVideo.captionsUrl,
      captionsLang: selectedVideo.captionsLang,
      captionsLabel: selectedVideo.captionsLabel,
      durationSeconds: selectedVideo.durationSeconds,
      autoplay: false,
    });

    if (!built.ok) {
      setErrorMessage(built.messageId);
      return;
    }

    onChange?.(built.block);
    onApply?.(built.block);
    setStatusMessage(
      `Video #${built.block.mediaId} (${built.block.width}×${built.block.height}) siap dipasang tanpa autoplay.`,
    );
  }

  const titleFieldId = `${idPrefix}-title`;
  const captionFieldId = `${idPrefix}-caption`;

  return (
    <Card
      className={cn("w-full", className)}
      data-slot="short-video-block-editor"
      data-testid="short-video-block-editor"
      data-placement={placement}
    >
      <CardHeader className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FilmIcon className="size-4 text-primary" aria-hidden="true" />
            <CardTitle>Blok Video Pendek (MP4 Lokal)</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{contextLabel}</Badge>
            <Badge variant="success">
              <ShieldCheckIcon className="size-3" aria-hidden="true" />
              Tanpa autoplay
            </Badge>
          </div>
        </div>
        <CardDescription>
          Maksimal 10 MB per video (MP4, MOV, WebM; maks 20 video). Untuk video panjang gunakan
          tautan YouTube. Putar otomatis (autoplay) dinonaktifkan agar situs tetap cepat.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="space-y-4 pt-4">
          {isHeroBlocked && (
            <Alert variant="destructive" data-testid="video-hero-placement-error">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Penempatan Hero ditolak</AlertTitle>
              <AlertDescription>{placementCheck.messageId}</AlertDescription>
            </Alert>
          )}

          {/* Video Selector */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                Video dari Pustaka Media <span className="text-destructive">*</span>
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={disabled || isHeroBlocked}
                onClick={() => setPickerOpen(true)}
                className="min-h-11 md:min-h-9"
                data-testid="short-video-open-picker-btn"
              >
                <FilmIcon className="size-4" aria-hidden="true" />
                {selectedVideo ? `Ganti Video (#${selectedVideo.id})` : "Pilih atau Unggah Video"}
              </Button>
            </div>

            {selectedVideo ? (
              <div
                className="overflow-hidden rounded-lg border border-border bg-muted/30"
                data-testid="short-video-selected-preview"
              >
                <div className="relative aspect-video w-full bg-[#132220]">
                  <img
                    src={selectedVideo.posterUrl}
                    alt={`Poster video: ${titleTrimmed || `Video #${selectedVideo.id}`}`}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground tabular-nums">
                  <span>
                    ID #{selectedVideo.id} · {selectedVideo.width}×{selectedVideo.height} px ·{" "}
                    <span className="font-mono">preload=&quot;none&quot;</span>
                  </span>
                  {selectedVideo.captionsUrl && (
                    <Badge variant="outline">
                      <CaptionsIcon className="size-3" aria-hidden="true" />
                      Takarir WebVTT aktif
                    </Badge>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                Belum ada video dipilih. Klik tombol di atas untuk memilih video siap pakai atau
                mengunggah MP4/MOV/WebM baru.
              </div>
            )}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <label htmlFor={titleFieldId} className="block text-sm font-medium text-foreground">
              Judul Video <span className="text-destructive">*</span>
            </label>
            <Input
              id={titleFieldId}
              type="text"
              maxLength={MAX_VIDEO_TITLE_LENGTH}
              disabled={disabled || isHeroBlocked}
              value={titleInput}
              onChange={(e) => {
                setTitleInput(e.target.value);
                setTouched(true);
              }}
              placeholder="Contoh: Proses Pengerjaan Proyek di Lapangan"
              aria-invalid={titleError ? "true" : undefined}
              className="min-h-11 text-base md:min-h-9 md:text-sm"
              data-testid="short-video-title-input"
            />
            {titleError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {titleError}
              </p>
            )}
          </div>

          {/* Optional Caption */}
          <div className="space-y-1.5">
            <label htmlFor={captionFieldId} className="block text-sm font-medium text-foreground">
              Keterangan Singkat (Opsional)
            </label>
            <Input
              id={captionFieldId}
              type="text"
              maxLength={MAX_VIDEO_CAPTION_TEXT_LENGTH}
              disabled={disabled || isHeroBlocked}
              value={captionInput}
              onChange={(e) => setCaptionInput(e.target.value)}
              placeholder="Contoh: Cuplikan singkat 25 detik hasil akhir instalasi"
              className="min-h-11 text-base md:min-h-9 md:text-sm"
              data-testid="short-video-caption-input"
            />
          </div>

          {errorMessage && !isHeroBlocked && (
            <Alert variant="destructive" data-testid="short-video-editor-error">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              <AlertTitle>Blok video belum valid</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {statusMessage && (
            <Alert variant="success" data-testid="short-video-editor-status">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              <AlertTitle>Blok video siap disimpan</AlertTitle>
              <AlertDescription>{statusMessage}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button
            type="submit"
            disabled={disabled || isHeroBlocked || !selectedVideo || !titleTrimmed}
            className="min-h-11 md:min-h-9"
            data-testid="short-video-apply-btn"
          >
            Terapkan Blok Video
          </Button>
          {onRemove && (
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={onRemove}
              className="min-h-11 md:min-h-9"
              data-testid="short-video-remove-btn"
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              Hapus Blok
            </Button>
          )}
        </CardFooter>
      </form>

      <MediaPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        handle={handle}
        title="Pilih atau Unggah Video Pendek"
        acceptKind="video"
        placement={placement}
        selectedMediaId={selectedVideo?.id ?? null}
        canUpload={!disabled && !isHeroBlocked}
        onSelect={handleVideoPicked}
      />
    </Card>
  );
}
