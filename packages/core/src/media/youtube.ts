/**
 * Privacy-Preserving Click-to-Load YouTube URL Parser, Video ID Extractor,
 * Local-Only Poster Sanitizer, and Canonical `youtube-nocookie.com` Embed Helpers
 * (REQ-089, REQ-021, REQ-039, REQ-040; PLAN §7.3; TASK-089).
 *
 * Security & privacy invariants:
 * - Accepts ONLY `https://` allowlisted YouTube forms:
 *   - `https://www.youtube.com/watch?v=<11-char-id>`
 *   - `https://youtube.com/watch?v=<11-char-id>`
 *   - `https://m.youtube.com/watch?v=<11-char-id>`
 *   - `https://youtu.be/<11-char-id>`
 *   - `https://www.youtube.com/shorts/<11-char-id>`
 *   - `https://youtube.com/shorts/<11-char-id>`
 *   - `https://m.youtube.com/shorts/<11-char-id>`
 * - Extracts and stores ONLY the validated 11-character video ID (`^[A-Za-z0-9_-]{11}$`).
 *   NEVER stores raw URLs or `<iframe>` HTML strings.
 * - Strictly rejects playlists, channels, search URLs, raw HTML/`<iframe>`,
 *   non-HTTPS schemes (`http:`, `javascript:`, `data:`, `vbscript:`),
 *   embedded credentials, foreign hosts, and invalid ID lengths.
 * - Poster sanitizer accepts ONLY tenant-relative `/media/...` or `/t/...` paths
 *   and strictly rejects `i.ytimg.com`, `ytimg.com`, `youtube.com`, `googlevideo.com`,
 *   or any external image URL so ZERO network requests reach YouTube/Google before click.
 * - Server NEVER contacts YouTube.
 */

export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const MAX_YOUTUBE_URL_LENGTH = 2048 as const;
export const MAX_YOUTUBE_POSTER_URL_LENGTH = 1024 as const;
export const MAX_YOUTUBE_TITLE_LENGTH = 160 as const;
export const MAX_YOUTUBE_CAPTION_LENGTH = 200 as const;
export const MAX_YOUTUBE_VIDEOS_PER_GALLERY = 3 as const;

export const YOUTUBE_NOCOOKIE_EMBED_ORIGIN = "https://www.youtube-nocookie.com" as const;
export const YOUTUBE_WATCH_ORIGIN = "https://www.youtube.com" as const;
export const YOUTUBE_CSP_FRAME_SRC = "https://www.youtube-nocookie.com" as const;
export const YOUTUBE_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" as const;
export const YOUTUBE_IFRAME_REFERRER_POLICY = "strict-origin-when-cross-origin" as const;

export const YOUTUBE_PRIVACY_DISCLOSURE_ID =
  "Video dari YouTube tidak dimuat otomatis demi privasi Anda. Klik Putar untuk memuat pemutar dari youtube-nocookie.com." as const;

export const YOUTUBE_ALLOWED_WATCH_HOSTS = new Set<string>([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
]);

export const YOUTUBE_SHORT_LINK_HOST = "youtu.be" as const;

/**
 * Third-party hosts that MUST NEVER receive any network request prior to an
 * explicit visitor click on a YouTube facade card (REQ-089, REQ-039).
 */
export const YOUTUBE_FORBIDDEN_INITIAL_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "ytimg.com",
  "i.ytimg.com",
  "googlevideo.com",
  "google.com",
  "ggpht.com",
] as const;

export type YouTubeUrlSourceForm = "watch" | "short_link" | "shorts";

export type YouTubeValidationErrorCode =
  | "EMPTY_INPUT"
  | "INPUT_TOO_LONG"
  | "CONTROL_CHARACTER"
  | "RAW_HTML_FORBIDDEN"
  | "UNSUPPORTED_PROTOCOL"
  | "EMBEDDED_CREDENTIALS"
  | "MALFORMED_URL"
  | "FORBIDDEN_HOST"
  | "PLAYLIST_ONLY_URL"
  | "UNSUPPORTED_PATH"
  | "INVALID_VIDEO_ID"
  | "INVALID_POSTER_URL"
  | "INVALID_TITLE"
  | "INVALID_CAPTION"
  | "TOO_MANY_VIDEOS";

export class YouTubeValidationError extends Error {
  readonly httpStatus = 422 as const;
  readonly code: YouTubeValidationErrorCode;

  constructor(code: YouTubeValidationErrorCode, message: string) {
    super(message);
    this.name = "YouTubeValidationError";
    this.code = code;
  }
}

export interface ParsedYouTubeVideo {
  readonly videoId: string;
  readonly sourceForm: YouTubeUrlSourceForm;
  /** Canonical non-autoplay `youtube-nocookie.com` embed URL. */
  readonly embedUrl: string;
  /** Click-time `youtube-nocookie.com` embed URL with `autoplay=1` (ONLY after explicit user click). */
  readonly clickEmbedUrl: string;
  /** Fallback external watch URL for no-JS / direct open. */
  readonly watchUrl: string;
}

export type ParseYouTubeUrlResult =
  | ({ readonly ok: true } & ParsedYouTubeVideo)
  | {
      readonly ok: false;
      readonly code: YouTubeValidationErrorCode;
      readonly message: string;
      readonly messageId: string;
    };

export type ValidateYouTubePosterResult =
  | { readonly ok: true; readonly posterUrl: string | null }
  | {
      readonly ok: false;
      readonly code: "INVALID_POSTER_URL";
      readonly message: string;
      readonly messageId: string;
    };

/**
 * Stored YouTube block payload.
 * Persists ONLY the validated 11-character `videoId`, accessible `title`,
 * optional tenant-relative `posterUrl`, and optional `caption`.
 * NEVER persists raw YouTube URLs or `<iframe>` HTML markup.
 */
export interface YouTubeVideoBlock {
  readonly videoId: string;
  readonly title: string;
  readonly posterUrl: string | null;
  readonly caption?: string | null;
}

export interface CreateYouTubeVideoBlockInput {
  readonly url: string;
  readonly title: string;
  readonly posterUrl?: string | null;
  readonly caption?: string | null;
}

export type CreateYouTubeVideoBlockResult =
  | { readonly ok: true; readonly block: YouTubeVideoBlock }
  | {
      readonly ok: false;
      readonly field: "url" | "title" | "posterUrl" | "caption";
      readonly code: YouTubeValidationErrorCode;
      readonly message: string;
      readonly messageId: string;
    };

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function containsHtmlMarkup(value: string): boolean {
  return /<\s*\/?\s*(?:iframe|script|object|embed|svg|img|video|a)\b/i.test(value) ||
    value.includes("<") ||
    value.includes(">");
}

/**
 * Localized Bahasa Indonesia validation messages for Admin UI display.
 */
export function getYouTubeErrorMessageId(code: YouTubeValidationErrorCode): string {
  switch (code) {
    case "EMPTY_INPUT":
      return "Masukkan tautan video YouTube terlebih dahulu.";
    case "INPUT_TOO_LONG":
      return "Tautan YouTube terlalu panjang.";
    case "CONTROL_CHARACTER":
      return "Tautan tidak boleh mengandung karakter kontrol yang tidak valid.";
    case "RAW_HTML_FORBIDDEN":
      return "Kode HTML atau <iframe> tidak diizinkan. Tempelkan tautan YouTube biasa (watch?v=, youtu.be/, atau shorts/).";
    case "UNSUPPORTED_PROTOCOL":
      return "Tautan harus menggunakan protokol https:// yang aman.";
    case "EMBEDDED_CREDENTIALS":
      return "Tautan tidak boleh menyertakan kredensial pengguna.";
    case "MALFORMED_URL":
      return "Format tautan YouTube tidak valid. Contoh: https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    case "FORBIDDEN_HOST":
      return "Hanya tautan resmi dari youtube.com, m.youtube.com, atau youtu.be yang diizinkan.";
    case "PLAYLIST_ONLY_URL":
      return "Tautan playlist tidak didukung. Gunakan tautan satu video (watch?v=, youtu.be/, atau shorts/).";
    case "UNSUPPORTED_PATH":
      return "Tautan kanal, pencarian, atau format ini tidak didukung. Gunakan tautan watch?v=, youtu.be/, atau shorts/.";
    case "INVALID_VIDEO_ID":
      return "ID video YouTube tidak valid (harus tepat 11 karakter huruf, angka, tanda hubung, atau garis bawah).";
    case "INVALID_POSTER_URL":
      return "Poster harus berupa path media lokal (/media/... atau /t/...). Tautan eksternal seperti i.ytimg.com ditolak demi privasi.";
    case "INVALID_TITLE":
      return "Judul video wajib diisi (1–160 karakter) agar mudah diakses pembaca layar.";
    case "INVALID_CAPTION":
      return "Keterangan video maksimal 200 karakter dan tidak boleh mengandung karakter kontrol.";
    case "TOO_MANY_VIDEOS":
      return `Maksimal ${MAX_YOUTUBE_VIDEOS_PER_GALLERY} video YouTube per seksi galeri.`;
  }
}

export function isValidYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

export function assertValidYouTubeVideoId(value: unknown): string {
  if (!isValidYouTubeVideoId(value)) {
    throw new YouTubeValidationError(
      "INVALID_VIDEO_ID",
      "YouTube video ID must be exactly 11 valid characters ([A-Za-z0-9_-]{11}).",
    );
  }
  return value;
}

/**
 * Emits the canonical `youtube-nocookie.com` embed URL for a validated video ID.
 * - Default (`autoplay: false`): `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`
 * - Click-time (`autoplay: true`, ONLY after explicit visitor interaction):
 *   `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`
 */
export function buildYouTubeEmbedUrl(
  videoId: string,
  options?: { readonly autoplay?: boolean },
): string {
  const safeId = assertValidYouTubeVideoId(videoId);
  if (options?.autoplay === true) {
    return `${YOUTUBE_NOCOOKIE_EMBED_ORIGIN}/embed/${safeId}?autoplay=1&rel=0&modestbranding=1`;
  }
  return `${YOUTUBE_NOCOOKIE_EMBED_ORIGIN}/embed/${safeId}?rel=0&modestbranding=1`;
}

/**
 * Emits the canonical outbound watch URL used for no-JS fallback links.
 */
export function buildYouTubeWatchUrl(videoId: string): string {
  const safeId = assertValidYouTubeVideoId(videoId);
  return `${YOUTUBE_WATCH_ORIGIN}/watch?v=${safeId}`;
}

/**
 * Checks whether a hostname belongs to YouTube/Google video/thumbnail domains
 * that must never be contacted before visitor click.
 */
export function isForbiddenYouTubeNetworkHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return YOUTUBE_FORBIDDEN_INITIAL_HOSTS.some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`),
  );
}

function failParse(code: YouTubeValidationErrorCode, message: string): ParseYouTubeUrlResult {
  return {
    ok: false,
    code,
    message,
    messageId: getYouTubeErrorMessageId(code),
  };
}

/**
 * Strictly validates an allowlisted YouTube URL and extracts ONLY the 11-char video ID.
 * Never returns or persists the raw input URL.
 */
export function parseYouTubeUrl(rawUrl: string): ParseYouTubeUrlResult {
  if (typeof rawUrl !== "string") {
    return failParse("MALFORMED_URL", "YouTube URL must be a string.");
  }

  if (hasControlChars(rawUrl)) {
    return failParse("CONTROL_CHARACTER", "YouTube URL must not contain control characters.");
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return failParse("EMPTY_INPUT", "YouTube URL is required.");
  }

  if (trimmed.length > MAX_YOUTUBE_URL_LENGTH) {
    return failParse(
      "INPUT_TOO_LONG",
      `YouTube URL exceeds maximum length of ${MAX_YOUTUBE_URL_LENGTH} characters.`,
    );
  }

  if (containsHtmlMarkup(trimmed)) {
    return failParse(
      "RAW_HTML_FORBIDDEN",
      "Raw HTML or <iframe> embed strings are strictly forbidden. Provide a standard YouTube URL.",
    );
  }

  // Require an explicit https:// scheme (reject http://, javascript:, data:, protocol-relative //, bare IDs).
  if (!/^https:\/\//i.test(trimmed)) {
    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
    if (schemeMatch) {
      return failParse(
        "UNSUPPORTED_PROTOCOL",
        `YouTube URL must use https:// (received '${schemeMatch[1]!.toLowerCase()}:').`,
      );
    }
    return failParse(
      "MALFORMED_URL",
      "YouTube URL must start with https:// (watch?v=, youtu.be/, or shorts/).",
    );
  }

  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);

  if (rawAuthority.includes("\\")) {
    return failParse("MALFORMED_URL", "YouTube URL authority must not contain backslashes.");
  }
  if (rawAuthority.includes("@")) {
    return failParse("EMBEDDED_CREDENTIALS", "YouTube URL must not contain embedded credentials.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return failParse("MALFORMED_URL", "YouTube URL is malformed.");
  }

  if (parsed.protocol !== "https:") {
    return failParse(
      "UNSUPPORTED_PROTOCOL",
      `YouTube URL must use https:// (received '${parsed.protocol}').`,
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return failParse("EMBEDDED_CREDENTIALS", "YouTube URL must not contain embedded credentials.");
  }

  if (parsed.port !== "") {
    return failParse("FORBIDDEN_HOST", "YouTube URL must not specify a custom port.");
  }

  // Reject trailing-dot hostnames (e.g. `youtube.com.`) and uppercase/mixed tricks safely
  const rawHost = rawAuthority.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (rawHost !== hostname || hostname.endsWith(".")) {
    return failParse("FORBIDDEN_HOST", `Host '${hostname}' is not an allowlisted YouTube host.`);
  }

  let videoId: string | null;
  let sourceForm: YouTubeUrlSourceForm;

  if (YOUTUBE_ALLOWED_WATCH_HOSTS.has(hostname)) {
    const rawPath = parsed.pathname;
    const normalizedPath =
      rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;

    if (normalizedPath === "/playlist" || normalizedPath.startsWith("/playlist/")) {
      return failParse("PLAYLIST_ONLY_URL", "YouTube playlist URLs are not allowed.");
    }

    if (normalizedPath === "/watch") {
      const vValues = parsed.searchParams.getAll("v");
      if (vValues.length === 0) {
        if (parsed.searchParams.has("list")) {
          return failParse("PLAYLIST_ONLY_URL", "Playlist-only YouTube URLs without a video ID are not allowed.");
        }
        return failParse("INVALID_VIDEO_ID", "YouTube watch URL is missing the 'v' video ID parameter.");
      }
      if (vValues.length > 1) {
        return failParse("INVALID_VIDEO_ID", "YouTube watch URL must contain a single 'v' parameter.");
      }
      videoId = vValues[0] ?? null;
      sourceForm = "watch";
    } else if (normalizedPath.startsWith("/shorts/")) {
      const rest = normalizedPath.slice("/shorts/".length);
      if (!rest || rest.includes("/")) {
        return failParse("INVALID_VIDEO_ID", "YouTube Shorts URL must contain a single 11-character video ID.");
      }
      videoId = rest;
      sourceForm = "shorts";
    } else {
      return failParse(
        "UNSUPPORTED_PATH",
        `YouTube path '${rawPath}' is not allowed. Use /watch?v=<id> or /shorts/<id>.`,
      );
    }
  } else if (hostname === YOUTUBE_SHORT_LINK_HOST) {
    const rawPath = parsed.pathname;
    const normalizedPath =
      rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    const segment = normalizedPath.startsWith("/") ? normalizedPath.slice(1) : normalizedPath;

    if (!segment || segment.includes("/")) {
      return failParse("INVALID_VIDEO_ID", "youtu.be URL must contain a single 11-character video ID.");
    }
    if (segment.toLowerCase() === "playlist") {
      return failParse("PLAYLIST_ONLY_URL", "YouTube playlist URLs are not allowed.");
    }
    videoId = segment;
    sourceForm = "short_link";
  } else {
    return failParse("FORBIDDEN_HOST", `Host '${hostname}' is not an allowlisted YouTube host.`);
  }

  if (!isValidYouTubeVideoId(videoId) || !sourceForm) {
    return failParse(
      "INVALID_VIDEO_ID",
      "Extracted YouTube video ID must be exactly 11 valid characters ([A-Za-z0-9_-]{11}).",
    );
  }

  return {
    ok: true,
    videoId,
    sourceForm,
    embedUrl: buildYouTubeEmbedUrl(videoId, { autoplay: false }),
    clickEmbedUrl: buildYouTubeEmbedUrl(videoId, { autoplay: true }),
    watchUrl: buildYouTubeWatchUrl(videoId),
  };
}

/**
 * Throwing helper that parses a YouTube URL and returns ONLY the validated 11-character video ID.
 */
export function extractYouTubeVideoId(rawUrl: string): string {
  const parsed = parseYouTubeUrl(rawUrl);
  if (!parsed.ok) {
    throw new YouTubeValidationError(parsed.code, parsed.message);
  }
  return parsed.videoId;
}

/**
 * Validates a local tenant poster URL for YouTube facade cards.
 *
 * Accepts ONLY tenant-relative paths under `/media/...` or `/t/...`.
 * Strictly rejects `i.ytimg.com`, `ytimg.com`, `youtube.com`, `googlevideo.com`,
 * all external `http://`/`https://` URLs, protocol-relative `//`, `data:`,
 * `javascript:`, backslashes, whitespace, and path traversal (`..`).
 */
export function validateYouTubePosterUrl(
  rawPosterUrl: string | null | undefined,
): ValidateYouTubePosterResult {
  if (rawPosterUrl === null || rawPosterUrl === undefined) {
    return { ok: true, posterUrl: null };
  }
  if (typeof rawPosterUrl !== "string") {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: "Poster URL must be a string or null.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  if (hasControlChars(rawPosterUrl)) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: "Poster URL must not contain control characters.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  const trimmed = rawPosterUrl.trim();
  if (trimmed.length === 0) {
    return { ok: true, posterUrl: null };
  }

  if (trimmed.length > MAX_YOUTUBE_POSTER_URL_LENGTH) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: `Poster URL exceeds maximum length of ${MAX_YOUTUBE_POSTER_URL_LENGTH} characters.`,
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  // Strictly reject whitespace, backslashes, protocol-relative //, and any scheme (https://, http://, data:, javascript:, etc.)
  if (
    /\s/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
  ) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message:
        "External, data:, javascript:, or non-local poster URLs are strictly forbidden. Use a tenant-relative /media/... or /t/... path.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  // Must start strictly with `/media/` or `/t/`
  if (!trimmed.startsWith("/media/") && !trimmed.startsWith("/t/")) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: "Poster URL must be a tenant-relative path starting with /media/ or /t/.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  // Reject path traversal (`..` or encoded `%2e%2e`) and embedded third-party YouTube/Google domains
  const lower = trimmed.toLowerCase();
  const pathPart = (trimmed.split(/[?#]/)[0] ?? "").toLowerCase();
  const segments = pathPart.split("/");
  if (
    segments.some((seg) => seg === ".." || seg === ".") ||
    lower.includes("%2e%2e") ||
    lower.includes("%5c") ||
    lower.includes("ytimg.com") ||
    lower.includes("youtube.com") ||
    lower.includes("youtube-nocookie.com") ||
    lower.includes("googlevideo.com")
  ) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: "Poster path contains forbidden traversal or external YouTube/Google host tokens.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  // Ensure there is an actual asset path segment after `/media/` or `/t/`
  const remainder = pathPart.startsWith("/media/")
    ? pathPart.slice("/media/".length)
    : pathPart.slice("/t/".length);
  if (!remainder || remainder.endsWith("/")) {
    return {
      ok: false,
      code: "INVALID_POSTER_URL",
      message: "Poster path must point to a local media asset file under /media/ or /t/.",
      messageId: getYouTubeErrorMessageId("INVALID_POSTER_URL"),
    };
  }

  return { ok: true, posterUrl: trimmed };
}

/**
 * Defensive SSR sanitizer for poster URLs.
 * Returns a safe tenant-relative `/media/...` or `/t/...` path, or `null`
 * (causing `YouTubeFacade.astro` to render its zero-network local SVG placeholder).
 */
export function sanitizeYouTubePosterUrl(rawPosterUrl: unknown): string | null {
  if (typeof rawPosterUrl !== "string") return null;
  const res = validateYouTubePosterUrl(rawPosterUrl);
  return res.ok ? res.posterUrl : null;
}

/**
 * Validates and constructs a clean, persisted `YouTubeVideoBlock` containing
 * ONLY the 11-char `videoId`, accessible `title`, safe local `posterUrl`, and optional `caption`.
 */
export function createYouTubeVideoBlock(
  input: CreateYouTubeVideoBlockInput,
): CreateYouTubeVideoBlockResult {
  const parsedUrl = parseYouTubeUrl(input.url);
  if (!parsedUrl.ok) {
    return {
      ok: false,
      field: "url",
      code: parsedUrl.code,
      message: parsedUrl.message,
      messageId: parsedUrl.messageId,
    };
  }

  if (typeof input.title !== "string" || hasControlChars(input.title)) {
    return {
      ok: false,
      field: "title",
      code: "INVALID_TITLE",
      message: "Video title must be a valid string without control characters.",
      messageId: getYouTubeErrorMessageId("INVALID_TITLE"),
    };
  }
  const title = input.title.trim();
  if (title.length < 1 || title.length > MAX_YOUTUBE_TITLE_LENGTH) {
    return {
      ok: false,
      field: "title",
      code: "INVALID_TITLE",
      message: `Video title must be between 1 and ${MAX_YOUTUBE_TITLE_LENGTH} characters.`,
      messageId: getYouTubeErrorMessageId("INVALID_TITLE"),
    };
  }

  const posterResult = validateYouTubePosterUrl(input.posterUrl);
  if (!posterResult.ok) {
    return {
      ok: false,
      field: "posterUrl",
      code: posterResult.code,
      message: posterResult.message,
      messageId: posterResult.messageId,
    };
  }

  let caption: string | null = null;
  if (input.caption !== undefined && input.caption !== null) {
    if (typeof input.caption !== "string" || hasControlChars(input.caption)) {
      return {
        ok: false,
        field: "caption",
        code: "INVALID_CAPTION",
        message: "Video caption must not contain control characters.",
        messageId: getYouTubeErrorMessageId("INVALID_CAPTION"),
      };
    }
    const trimmedCaption = input.caption.trim();
    if (trimmedCaption.length > MAX_YOUTUBE_CAPTION_LENGTH) {
      return {
        ok: false,
        field: "caption",
        code: "INVALID_CAPTION",
        message: `Video caption must be at most ${MAX_YOUTUBE_CAPTION_LENGTH} characters.`,
        messageId: getYouTubeErrorMessageId("INVALID_CAPTION"),
      };
    }
    caption = trimmedCaption.length > 0 ? trimmedCaption : null;
  }

  return {
    ok: true,
    block: {
      videoId: parsedUrl.videoId,
      title,
      posterUrl: posterResult.posterUrl,
      ...(caption ? { caption } : {}),
    },
  };
}

/**
 * Enforces REQ-089 gallery section limit (at most 3 YouTube videos per gallery section).
 */
export function validateGalleryYouTubeCount(youtubeItemCount: number):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "TOO_MANY_VIDEOS";
      readonly message: string;
      readonly messageId: string;
    } {
  if (!Number.isInteger(youtubeItemCount) || youtubeItemCount < 0) {
    return {
      ok: false,
      code: "TOO_MANY_VIDEOS",
      message: "YouTube video count must be a non-negative integer.",
      messageId: getYouTubeErrorMessageId("TOO_MANY_VIDEOS"),
    };
  }
  if (youtubeItemCount > MAX_YOUTUBE_VIDEOS_PER_GALLERY) {
    return {
      ok: false,
      code: "TOO_MANY_VIDEOS",
      message: `A gallery section may include at most ${MAX_YOUTUBE_VIDEOS_PER_GALLERY} YouTube videos (received ${youtubeItemCount}).`,
      messageId: getYouTubeErrorMessageId("TOO_MANY_VIDEOS"),
    };
  }
  return { ok: true };
}
