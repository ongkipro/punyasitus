import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertValidYouTubeVideoId,
  buildYouTubeEmbedUrl,
  buildYouTubeWatchUrl,
  createYouTubeVideoBlock,
  extractYouTubeVideoId,
  getYouTubeErrorMessageId,
  isForbiddenYouTubeNetworkHost,
  isValidYouTubeVideoId,
  MAX_YOUTUBE_VIDEOS_PER_GALLERY,
  parseYouTubeUrl,
  sanitizeYouTubePosterUrl,
  validateGalleryYouTubeCount,
  validateYouTubePosterUrl,
  YOUTUBE_PRIVACY_DISCLOSURE_ID,
  YouTubeValidationError,
} from "../../packages/core/src/media/youtube.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("TASK-089: Privacy-Preserving Click-to-Load YouTube URL Parser & Sanitizers", () => {
  describe("valid allowlisted YouTube URLs", () => {
    const validCases: ReadonlyArray<{
      readonly label: string;
      readonly input: string;
      readonly expectedId: string;
      readonly expectedForm: "watch" | "short_link" | "shorts";
    }> = [
      {
        label: "www.youtube.com/watch?v=",
        input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        expectedId: "dQw4w9WgXcQ",
        expectedForm: "watch",
      },
      {
        label: "youtube.com/watch?v= with extra query params stripped",
        input: "https://youtube.com/watch?v=9bZkp7q19f0&t=45s&si=abc123",
        expectedId: "9bZkp7q19f0",
        expectedForm: "watch",
      },
      {
        label: "m.youtube.com/watch?v= with hyphen and underscore",
        input: "https://m.youtube.com/watch?v=Ab_12-Cd34E",
        expectedId: "Ab_12-Cd34E",
        expectedForm: "watch",
      },
      {
        label: "youtu.be short link",
        input: "https://youtu.be/dQw4w9WgXcQ",
        expectedId: "dQw4w9WgXcQ",
        expectedForm: "short_link",
      },
      {
        label: "youtu.be short link with tracking params & trailing slash",
        input: "https://youtu.be/M7lc1UVf-VE/?si=trackingToken",
        expectedId: "M7lc1UVf-VE",
        expectedForm: "short_link",
      },
      {
        label: "www.youtube.com/shorts/",
        input: "https://www.youtube.com/shorts/aqz-KE-bpKQ",
        expectedId: "aqz-KE-bpKQ",
        expectedForm: "shorts",
      },
      {
        label: "youtube.com/shorts/ with trailing slash and query",
        input: "https://youtube.com/shorts/aqz-KE-bpKQ/?feature=share",
        expectedId: "aqz-KE-bpKQ",
        expectedForm: "shorts",
      },
    ];

    for (const tc of validCases) {
      it(`extracts ONLY 11-char video ID from ${tc.label}`, () => {
        const res = parseYouTubeUrl(tc.input);
        expect(res.ok).toBe(true);
        if (!res.ok) return;

        expect(res.videoId).toBe(tc.expectedId);
        expect(res.sourceForm).toBe(tc.expectedForm);
        expect(res.embedUrl).toBe(
          `https://www.youtube-nocookie.com/embed/${tc.expectedId}?rel=0&modestbranding=1`,
        );
        expect(res.clickEmbedUrl).toBe(
          `https://www.youtube-nocookie.com/embed/${tc.expectedId}?autoplay=1&rel=0&modestbranding=1`,
        );
        expect(res.watchUrl).toBe(`https://www.youtube.com/watch?v=${tc.expectedId}`);
        expect(extractYouTubeVideoId(tc.input)).toBe(tc.expectedId);
      });
    }
  });

  describe("strict rejection of invalid, hostile, playlist, channel, and raw HTML inputs", () => {
    const rejectedCases: ReadonlyArray<{
      readonly label: string;
      readonly input: string;
      readonly expectedCode: string;
    }> = [
      { label: "empty string", input: "", expectedCode: "EMPTY_INPUT" },
      { label: "whitespace only", input: "   ", expectedCode: "EMPTY_INPUT" },
      { label: "malformed plain text", input: "not-a-valid-url", expectedCode: "MALFORMED_URL" },
      { label: "bare 11-char ID without https URL", input: "dQw4w9WgXcQ", expectedCode: "MALFORMED_URL" },
      {
        label: "http:// non-TLS scheme",
        input: "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "UNSUPPORTED_PROTOCOL",
      },
      {
        label: "javascript: URI",
        input: "javascript:alert(1)",
        expectedCode: "UNSUPPORTED_PROTOCOL",
      },
      {
        label: "data: URI",
        input: "data:text/html,alert(1)",
        expectedCode: "UNSUPPORTED_PROTOCOL",
      },
      {
        label: "protocol-relative URL",
        input: "//www.youtube.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "MALFORMED_URL",
      },
      {
        label: "raw <iframe> HTML embed string",
        input: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
        expectedCode: "RAW_HTML_FORBIDDEN",
      },
      {
        label: "raw script injection",
        input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ<script>alert(1)</script>",
        expectedCode: "RAW_HTML_FORBIDDEN",
      },
      {
        label: "playlist-only /playlist?list=...",
        input: "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        expectedCode: "PLAYLIST_ONLY_URL",
      },
      {
        label: "watch?list=... without v param",
        input: "https://www.youtube.com/watch?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
        expectedCode: "PLAYLIST_ONLY_URL",
      },
      {
        label: "channel handle URL",
        input: "https://www.youtube.com/@GoogleDevelopers",
        expectedCode: "UNSUPPORTED_PATH",
      },
      {
        label: "channel ID URL",
        input: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
        expectedCode: "UNSUPPORTED_PATH",
      },
      {
        label: "search results URL",
        input: "https://www.youtube.com/results?search_query=punyasitus",
        expectedCode: "UNSUPPORTED_PATH",
      },
      {
        label: "direct /embed/ path (only watch/youtu.be/shorts accepted)",
        input: "https://www.youtube.com/embed/dQw4w9WgXcQ",
        expectedCode: "UNSUPPORTED_PATH",
      },
      {
        label: "foreign host evil-youtube.com",
        input: "https://evil-youtube.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "FORBIDDEN_HOST",
      },
      {
        label: "subdomain spoof youtube.com.evil.com",
        input: "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "FORBIDDEN_HOST",
      },
      {
        label: "unlisted host youtube-nocookie.com as input",
        input: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        expectedCode: "FORBIDDEN_HOST",
      },
      {
        label: "embedded credentials user:pass@youtube.com",
        input: "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "EMBEDDED_CREDENTIALS",
      },
      {
        label: "credential authority confusion youtube.com@evil.com",
        input: "https://www.youtube.com@evil.com/watch?v=dQw4w9WgXcQ",
        expectedCode: "EMBEDDED_CREDENTIALS",
      },
      {
        label: "custom port on youtube.com",
        input: "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
        expectedCode: "FORBIDDEN_HOST",
      },
      {
        label: "video ID too short (10 chars)",
        input: "https://www.youtube.com/watch?v=dQw4w9WgXc",
        expectedCode: "INVALID_VIDEO_ID",
      },
      {
        label: "video ID too long (12 chars)",
        input: "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
        expectedCode: "INVALID_VIDEO_ID",
      },
      {
        label: "video ID with illegal character",
        input: "https://youtu.be/dQw4w9WgX$Q",
        expectedCode: "INVALID_VIDEO_ID",
      },
      {
        label: "duplicate v query parameters",
        input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=9bZkp7q19f0",
        expectedCode: "INVALID_VIDEO_ID",
      },
      {
        label: "shorts with extra nested path segment",
        input: "https://www.youtube.com/shorts/dQw4w9WgXcQ/extra",
        expectedCode: "INVALID_VIDEO_ID",
      },
      {
        label: "control character injection",
        input: "https://youtu.be/dQw4w9WgXcQ\n",
        expectedCode: "CONTROL_CHARACTER",
      },
    ];

    for (const tc of rejectedCases) {
      it(`rejects ${tc.label}`, () => {
        const res = parseYouTubeUrl(tc.input);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.code).toBe(tc.expectedCode);
        expect(res.messageId.length).toBeGreaterThan(10);
        expect(() => extractYouTubeVideoId(tc.input)).toThrow(YouTubeValidationError);
      });
    }
  });

  describe("local-only poster URL sanitizer (strictly blocks ytimg.com and all external URLs)", () => {
    it("accepts valid tenant-relative /media/... and /t/... paths and empty/null values", () => {
      expect(sanitizeYouTubePosterUrl("/media/t/demo/video-poster.webp")).toBe(
        "/media/t/demo/video-poster.webp",
      );
      expect(sanitizeYouTubePosterUrl("/t/demo/media/poster.webp?v=2")).toBe(
        "/t/demo/media/poster.webp?v=2",
      );
      expect(sanitizeYouTubePosterUrl(null)).toBeNull();
      expect(sanitizeYouTubePosterUrl(undefined)).toBeNull();
      expect(sanitizeYouTubePosterUrl("   ")).toBeNull();

      const validRes = validateYouTubePosterUrl("/media/t/demo/poster.webp");
      expect(validRes).toEqual({ ok: true, posterUrl: "/media/t/demo/poster.webp" });
    });

    const forbiddenPosters = [
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      "https://ytimg.com/vi/dQw4w9WgXcQ/0.jpg",
      "https://r3---sn-abc.googlevideo.com/poster.jpg",
      "https://www.youtube.com/thumb.jpg",
      "https://cdn.example.com/poster.webp",
      "http://example.com/poster.jpg",
      "//i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "/media/../etc/passwd",
      "/media/%2e%2e/secret.webp",
      "/media/t/demo\\evil.webp",
      "/assets/not-tenant-media.webp",
      "/media/",
      "/t/",
    ];

    for (const badPoster of forbiddenPosters) {
      it(`rejects forbidden poster URL: ${badPoster}`, () => {
        expect(sanitizeYouTubePosterUrl(badPoster)).toBeNull();
        const res = validateYouTubePosterUrl(badPoster);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.code).toBe("INVALID_POSTER_URL");
        }
      });
    }
  });

  describe("canonical embed URL, watch URL, block creation & gallery limit", () => {
    it("emits canonical youtube-nocookie.com embed URL without autoplay by default, and autoplay=1 only on click", () => {
      expect(buildYouTubeEmbedUrl("dQw4w9WgXcQ")).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1",
      );
      expect(buildYouTubeEmbedUrl("dQw4w9WgXcQ", { autoplay: false })).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1",
      );
      expect(buildYouTubeEmbedUrl("dQw4w9WgXcQ", { autoplay: true })).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&modestbranding=1",
      );
      expect(buildYouTubeWatchUrl("dQw4w9WgXcQ")).toBe(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      expect(() => assertValidYouTubeVideoId("bad")).toThrow(YouTubeValidationError);
      expect(isValidYouTubeVideoId("dQw4w9WgXcQ")).toBe(true);
      expect(isValidYouTubeVideoId("invalid!")).toBe(false);
    });

    it("creates persisted block containing ONLY 11-char videoId, title, local posterUrl, and optional caption", () => {
      const res = createYouTubeVideoBlock({
        url: "https://youtu.be/dQw4w9WgXcQ?si=secretTrackParam",
        title: "  Video Profil Usaha  ",
        posterUrl: "/media/t/demo/poster.webp",
        caption: "  Durasi 2 menit  ",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.block).toEqual({
        videoId: "dQw4w9WgXcQ",
        title: "Video Profil Usaha",
        posterUrl: "/media/t/demo/poster.webp",
        caption: "Durasi 2 menit",
      });
      const serialized = JSON.stringify(res.block);
      expect(serialized).not.toContain("youtu.be");
      expect(serialized).not.toContain("secretTrackParam");
      expect(serialized).not.toContain("<iframe");
    });

    it("rejects block creation with external ytimg poster or empty title", () => {
      const badPoster = createYouTubeVideoBlock({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "Profil",
        posterUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      });
      expect(badPoster.ok).toBe(false);
      if (!badPoster.ok) {
        expect(badPoster.field).toBe("posterUrl");
        expect(badPoster.code).toBe("INVALID_POSTER_URL");
      }

      const emptyTitle = createYouTubeVideoBlock({
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "   ",
      });
      expect(emptyTitle.ok).toBe(false);
      if (!emptyTitle.ok) {
        expect(emptyTitle.field).toBe("title");
        expect(emptyTitle.code).toBe("INVALID_TITLE");
      }
    });

    it("enforces max 3 YouTube videos per gallery section and classifies forbidden initial hosts", () => {
      expect(MAX_YOUTUBE_VIDEOS_PER_GALLERY).toBe(3);
      expect(validateGalleryYouTubeCount(0).ok).toBe(true);
      expect(validateGalleryYouTubeCount(3).ok).toBe(true);
      const over = validateGalleryYouTubeCount(4);
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.code).toBe("TOO_MANY_VIDEOS");

      expect(isForbiddenYouTubeNetworkHost("i.ytimg.com")).toBe(true);
      expect(isForbiddenYouTubeNetworkHost("www.youtube.com")).toBe(true);
      expect(isForbiddenYouTubeNetworkHost("www.youtube-nocookie.com")).toBe(true);
      expect(isForbiddenYouTubeNetworkHost("rr1---sn-abc.googlevideo.com")).toBe(true);
      expect(isForbiddenYouTubeNetworkHost("www.google.com")).toBe(true);
      expect(isForbiddenYouTubeNetworkHost("127.0.0.1")).toBe(false);
      expect(isForbiddenYouTubeNetworkHost("situsku.click")).toBe(false);

      expect(getYouTubeErrorMessageId("PLAYLIST_ONLY_URL")).toContain("playlist");
      expect(YOUTUBE_PRIVACY_DISCLOSURE_ID).toContain("youtube-nocookie.com");
    });
  });

  describe("source hygiene: zero @radix-ui/*, zero asChild, zero ytimg.com, and tiny inline script (< 1.5 KiB)", () => {
    it("verifies admin YouTube editor block uses Base UI only (zero Radix / asChild)", () => {
      const editorDir = path.join(repoRoot, "apps/web/src/components/admin/editor/blocks/youtube");
      const files = fs
        .readdirSync(editorDir)
        .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      expect(files.length).toBeGreaterThanOrEqual(2);

      for (const file of files) {
        const content = fs.readFileSync(path.join(editorDir, file), "utf8");
        expect(content).not.toMatch(/@radix-ui\/|["']radix-ui["']/);
        expect(content).not.toMatch(/\basChild\b/);
        expect(content).not.toMatch(/<iframe\b/i);
        expect(content).not.toMatch(/src\s*=\s*["'`][^"'`]*ytimg\.com/i);
      }
    });

    it("verifies YouTubeFacade.astro has zero initial <iframe>, zero preconnect, zero React/Base-UI, and < 1.5 KiB inline script", () => {
      const facadePath = path.join(
        repoRoot,
        "apps/web/src/themes/default/components/YouTubeFacade.astro",
      );
      const source = fs.readFileSync(facadePath, "utf8");

      expect(source).not.toMatch(/<iframe\b/i);
      expect(source).not.toMatch(/rel\s*=\s*["']preconnect["']/i);
      expect(source).not.toMatch(/i\.ytimg\.com/i);
      expect(source).not.toMatch(/from\s+["'](?:react|@base-ui|@radix-ui)/);

      const scriptMatch = /<script\s+is:inline>([\s\S]*?)<\/script>/.exec(source);
      expect(scriptMatch).not.toBeNull();
      const inlineBytes = Buffer.byteLength(scriptMatch?.[1] ?? "", "utf8");
      expect(inlineBytes).toBeGreaterThan(100);
      expect(inlineBytes).toBeLessThan(1536); // Strictly < 1.5 KiB
    });
  });
});
