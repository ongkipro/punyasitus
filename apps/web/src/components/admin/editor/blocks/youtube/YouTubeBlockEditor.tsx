import * as React from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ImageIcon,
  PlayIcon,
  ShieldCheckIcon,
  Trash2Icon,
  VideoIcon,
} from "lucide-react";
import {
  buildYouTubeWatchUrl,
  createYouTubeVideoBlock,
  MAX_YOUTUBE_CAPTION_LENGTH,
  MAX_YOUTUBE_TITLE_LENGTH,
  MAX_YOUTUBE_VIDEOS_PER_GALLERY,
  parseYouTubeUrl,
  validateYouTubePosterUrl,
  YOUTUBE_PRIVACY_DISCLOSURE_ID,
  type YouTubeVideoBlock,
} from "@punyasitus/core/media/youtube";
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
import { cn } from "@/lib/utils";

export interface YouTubeBlockEditorProps {
  readonly value?: YouTubeVideoBlock | null;
  readonly onChange?: (block: YouTubeVideoBlock | null) => void;
  readonly onApply?: (block: YouTubeVideoBlock) => void;
  readonly onRemove?: () => void;
  readonly disabled?: boolean;
  readonly contextLabel?: string;
  readonly showGalleryLimitHint?: boolean;
  readonly idPrefix?: string;
  readonly className?: string;
}

/**
 * Accessible Admin Editor Block for Privacy-Preserving Click-to-Load YouTube Videos
 * (REQ-089, REQ-039, DEC-036; Bahasa Indonesia; built strictly on `@base-ui/react`
 * primitives via `@/components/ui/*`).
 *
 * Guarantees:
 * - Accepts only `youtube.com/watch?v=`, `youtu.be/`, and `youtube.com/shorts/` URLs.
 * - Extracts and persists ONLY the validated 11-character `videoId` (never raw URL or embed HTML).
 * - Renders a zero-network local preview card (never fetches YouTube thumbnails or mounts embeds).
 */
export function YouTubeBlockEditor({
  value = null,
  onChange,
  onApply,
  onRemove,
  disabled = false,
  contextLabel = "Galeri",
  showGalleryLimitHint = true,
  idPrefix = "yt-block",
  className,
}: YouTubeBlockEditorProps) {
  const [urlInput, setUrlInput] = React.useState<string>(() =>
    value?.videoId ? buildYouTubeWatchUrl(value.videoId) : "",
  );
  const [titleInput, setTitleInput] = React.useState<string>(() => value?.title ?? "");
  const [posterInput, setPosterInput] = React.useState<string>(() => value?.posterUrl ?? "");
  const [captionInput, setCaptionInput] = React.useState<string>(() => value?.caption ?? "");
  const [touched, setTouched] = React.useState<{
    url: boolean;
    title: boolean;
    poster: boolean;
  }>({ url: false, title: false, poster: false });
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  const urlParseResult = React.useMemo(() => {
    if (urlInput.trim().length === 0) return null;
    return parseYouTubeUrl(urlInput);
  }, [urlInput]);

  const posterValidation = React.useMemo(
    () => validateYouTubePosterUrl(posterInput),
    [posterInput],
  );

  const titleTrimmed = titleInput.trim();
  const titleError = React.useMemo(() => {
    if (!touched.title && titleTrimmed.length === 0) return null;
    if (titleTrimmed.length === 0) {
      return "Judul video wajib diisi agar pengunjung dan pembaca layar memahami isi video.";
    }
    if (titleTrimmed.length > MAX_YOUTUBE_TITLE_LENGTH) {
      return `Judul video maksimal ${MAX_YOUTUBE_TITLE_LENGTH} karakter.`;
    }
    return null;
  }, [titleTrimmed, touched.title]);

  const urlError =
    urlParseResult && !urlParseResult.ok
      ? urlParseResult.messageId
      : touched.url && urlInput.trim().length === 0
        ? "Tempelkan tautan video YouTube yang valid (watch?v=, youtu.be/, atau shorts/)."
        : null;

  const posterError = !posterValidation.ok ? posterValidation.messageId : null;

  const captionError =
    captionInput.trim().length > MAX_YOUTUBE_CAPTION_LENGTH
      ? `Keterangan video maksimal ${MAX_YOUTUBE_CAPTION_LENGTH} karakter.`
      : null;

  const validatedVideoId = urlParseResult && urlParseResult.ok ? urlParseResult.videoId : null;
  const safePosterPreviewUrl = posterValidation.ok ? posterValidation.posterUrl : null;

  const emitBlockIfChanged = React.useCallback(
    (nextUrl: string, nextTitle: string, nextPoster: string, nextCaption: string) => {
      if (!onChange) return;
      const built = createYouTubeVideoBlock({
        url: nextUrl,
        title: nextTitle,
        posterUrl: nextPoster || null,
        caption: nextCaption || null,
      });
      onChange(built.ok ? built.block : null);
    },
    [onChange],
  );

  const handleUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setUrlInput(next);
    setTouched((prev) => ({ ...prev, url: true }));
    setStatusMessage(null);
    emitBlockIfChanged(next, titleInput, posterInput, captionInput);
  };

  const handleTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setTitleInput(next);
    setTouched((prev) => ({ ...prev, title: true }));
    setStatusMessage(null);
    emitBlockIfChanged(urlInput, next, posterInput, captionInput);
  };

  const handlePosterChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setPosterInput(next);
    setTouched((prev) => ({ ...prev, poster: true }));
    setStatusMessage(null);
    emitBlockIfChanged(urlInput, titleInput, next, captionInput);
  };

  const handleCaptionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setCaptionInput(next);
    setStatusMessage(null);
    emitBlockIfChanged(urlInput, titleInput, posterInput, next);
  };

  const handleApply = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched({ url: true, title: true, poster: true });

    const built = createYouTubeVideoBlock({
      url: urlInput,
      title: titleInput,
      posterUrl: posterInput || null,
      caption: captionInput || null,
    });

    if (!built.ok) {
      setStatusMessage(null);
      return;
    }

    onChange?.(built.block);
    onApply?.(built.block);
    setStatusMessage(`ID video ${built.block.videoId} siap disimpan tanpa memuat skrip YouTube otomatis.`);
  };

  const handleReset = () => {
    setUrlInput("");
    setTitleInput("");
    setPosterInput("");
    setCaptionInput("");
    setTouched({ url: false, title: false, poster: false });
    setStatusMessage(null);
    onChange?.(null);
  };

  const canSubmit =
    !disabled &&
    Boolean(validatedVideoId) &&
    titleTrimmed.length > 0 &&
    titleTrimmed.length <= MAX_YOUTUBE_TITLE_LENGTH &&
    posterValidation.ok &&
    !captionError;

  const urlFieldId = `${idPrefix}-url`;
  const urlErrorId = `${idPrefix}-url-error`;
  const urlHintId = `${idPrefix}-url-hint`;
  const titleFieldId = `${idPrefix}-title`;
  const titleErrorId = `${idPrefix}-title-error`;
  const posterFieldId = `${idPrefix}-poster`;
  const posterErrorId = `${idPrefix}-poster-error`;
  const captionFieldId = `${idPrefix}-caption`;

  return (
    <Card
      className={cn("w-full", className)}
      data-slot="youtube-block-editor"
      data-testid="youtube-block-editor"
    >
      <CardHeader className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <VideoIcon className="size-4 text-primary" aria-hidden="true" />
            <CardTitle>Blok Video YouTube (Klik untuk Memutar)</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{contextLabel}</Badge>
            <Badge variant="success">
              <ShieldCheckIcon className="size-3" aria-hidden="true" />
              Privasi terjaga
            </Badge>
          </div>
        </div>
        <CardDescription>
          Sistem hanya menyimpan ID video 11 karakter dan memuat pemutar dari{" "}
          <span className="font-mono text-xs text-foreground">youtube-nocookie.com</span>{" "}
          setelah pengunjung menekan tombol Putar.
          {showGalleryLimitHint &&
            ` Maksimal ${MAX_YOUTUBE_VIDEOS_PER_GALLERY} video YouTube per seksi galeri.`}
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleApply} noValidate>
        <CardContent className="space-y-4 pt-4">
          {/* 1. YouTube URL Input */}
          <div className="space-y-1.5">
            <label
              htmlFor={urlFieldId}
              className="block text-sm font-medium text-foreground"
            >
              Tautan Video YouTube <span className="text-destructive">*</span>
            </label>
            <Input
              id={urlFieldId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={urlInput}
              onChange={handleUrlChange}
              placeholder="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
              aria-invalid={urlError ? "true" : undefined}
              aria-describedby={urlError ? `${urlHintId} ${urlErrorId}` : urlHintId}
              data-testid="youtube-editor-url-input"
            />
            <p id={urlHintId} className="text-xs text-muted-foreground">
              Format yang didukung:{" "}
              <span className="font-mono">youtube.com/watch?v=...</span>,{" "}
              <span className="font-mono">youtu.be/...</span>, atau{" "}
              <span className="font-mono">youtube.com/shorts/...</span>. Playlist dan kode{" "}
              <span className="font-mono">&lt;iframe&gt;</span> ditolak otomatis.
            </p>

            {urlError && (
              <Alert variant="destructive" id={urlErrorId} data-testid="youtube-editor-url-error">
                <AlertCircleIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Tautan YouTube tidak valid</AlertTitle>
                <AlertDescription>{urlError}</AlertDescription>
              </Alert>
            )}

            {validatedVideoId && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-success-border bg-success-soft px-3 py-2 text-xs text-success"
                data-testid="youtube-editor-extracted-id"
              >
                <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
                <span>
                  ID video tervalidasi:{" "}
                  <strong className="font-mono font-semibold">{validatedVideoId}</strong> (hanya
                  ID 11 karakter yang disimpan).
                </span>
              </div>
            )}
          </div>

          {/* 2. Accessible Title Input */}
          <div className="space-y-1.5">
            <label
              htmlFor={titleFieldId}
              className="block text-sm font-medium text-foreground"
            >
              Judul Video <span className="text-destructive">*</span>
            </label>
            <Input
              id={titleFieldId}
              type="text"
              maxLength={MAX_YOUTUBE_TITLE_LENGTH}
              disabled={disabled}
              value={titleInput}
              onChange={handleTitleChange}
              placeholder="Contoh: Profil Layanan & Alur Kerja Kami"
              aria-invalid={titleError ? "true" : undefined}
              aria-describedby={titleError ? titleErrorId : undefined}
              data-testid="youtube-editor-title-input"
            />
            {titleError && (
              <p
                id={titleErrorId}
                role="alert"
                className="text-xs font-medium text-destructive"
                data-testid="youtube-editor-title-error"
              >
                {titleError}
              </p>
            )}
          </div>

          {/* 3. Optional Local Tenant Poster Input */}
          <div className="space-y-1.5">
            <label
              htmlFor={posterFieldId}
              className="flex items-center gap-1.5 text-sm font-medium text-foreground"
            >
              <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span>Poster Lokal dari Pustaka Media (Opsional)</span>
            </label>
            <Input
              id={posterFieldId}
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={posterInput}
              onChange={handlePosterChange}
              placeholder="/media/t/toko-anda/poster-video.webp"
              aria-invalid={posterError ? "true" : undefined}
              aria-describedby={posterError ? posterErrorId : undefined}
              data-testid="youtube-editor-poster-input"
            />
            <p className="text-xs text-muted-foreground">
              Kosongkan untuk memakai placeholder bawaan platform. Hanya path lokal{" "}
              <span className="font-mono">/media/...</span> atau{" "}
              <span className="font-mono">/t/...</span> yang diterima agar tidak ada permintaan
              otomatis ke <span className="font-mono">i.ytimg.com</span>.
            </p>
            {posterError && (
              <Alert
                variant="destructive"
                id={posterErrorId}
                data-testid="youtube-editor-poster-error"
              >
                <AlertCircleIcon className="size-4" aria-hidden="true" />
                <AlertTitle>Poster eksternal ditolak</AlertTitle>
                <AlertDescription>{posterError}</AlertDescription>
              </Alert>
            )}
          </div>

          {/* 4. Optional Caption Input */}
          <div className="space-y-1.5">
            <label
              htmlFor={captionFieldId}
              className="block text-sm font-medium text-foreground"
            >
              Keterangan Singkat (Opsional)
            </label>
            <Input
              id={captionFieldId}
              type="text"
              maxLength={MAX_YOUTUBE_CAPTION_LENGTH}
              disabled={disabled}
              value={captionInput}
              onChange={handleCaptionChange}
              placeholder="Contoh: Durasi 2 menit · Gambaran ruang layanan"
              data-testid="youtube-editor-caption-input"
            />
            {captionError && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {captionError}
              </p>
            )}
          </div>

          {/* 5. Zero-Network Editor Preview Card */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pratinjau Kartu Video (Tanpa Koneksi Eksternal)
              </p>
              {validatedVideoId && (
                <Badge variant="outline" className="font-mono">
                  ID: {validatedVideoId}
                </Badge>
              )}
            </div>

            <div
              className="overflow-hidden rounded-lg border border-border bg-card"
              data-testid="youtube-editor-preview"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-[#132220]">
                {safePosterPreviewUrl ? (
                  <img
                    src={safePosterPreviewUrl}
                    alt={`Pratinjau poster: ${titleTrimmed || "Video YouTube"}`}
                    className="size-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <svg
                    viewBox="0 0 640 360"
                    className="size-full"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect width="640" height="360" fill="#132220" />
                    <rect
                      x="24"
                      y="24"
                      width="592"
                      height="312"
                      rx="14"
                      fill="#1b332f"
                      stroke="#335750"
                      strokeWidth="1.5"
                    />
                    <circle cx="536" cy="84" r="56" fill="#ffffff" fillOpacity="0.06" />
                    <circle cx="108" cy="284" r="76" fill="#ffffff" fillOpacity="0.05" />
                  </svg>
                )}

                <div
                  className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 p-4"
                  aria-hidden="true"
                >
                  <span className="inline-flex min-h-12 items-center gap-2 rounded-full border-2 border-white/90 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-md">
                    <PlayIcon className="size-4 fill-current" />
                    <span>{validatedVideoId ? "Putar Video" : "Menunggu ID Video"}</span>
                  </span>
                </div>
              </div>

              <div className="space-y-1.5 border-t border-border bg-muted/60 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Video YouTube</span>
                  <span className="font-mono">youtube-nocookie.com</span>
                </div>
                <p className="text-sm font-semibold text-foreground">
                  {titleTrimmed || "Judul video akan tampil di sini"}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {YOUTUBE_PRIVACY_DISCLOSURE_ID}
                </p>
                {captionInput.trim() && (
                  <p className="text-xs text-foreground">{captionInput.trim()}</p>
                )}
              </div>
            </div>
          </div>

          {statusMessage && (
            <Alert variant="success" data-testid="youtube-editor-status">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              <AlertTitle>Blok video siap digunakan</AlertTitle>
              <AlertDescription>{statusMessage}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="youtube-editor-apply-btn"
            >
              Terapkan Blok Video
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={handleReset}
              data-testid="youtube-editor-reset-btn"
            >
              Bersihkan
            </Button>
          </div>

          {onRemove && (
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={onRemove}
              data-testid="youtube-editor-remove-btn"
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              <span>Hapus Blok</span>
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
