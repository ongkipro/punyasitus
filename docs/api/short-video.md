# Short Video Upload, Validation and Delivery API (`TASK-060`, `REQ-062`)

Additive tenant-scoped endpoints for self-hosted short videos (`<= 10,000,000` bytes, `<= 1920x1080`, `<= 60 fps`, max `20` videos per website, MP4/MOV/WebM).

> **Note:** `docs/api/openapi.json` is drift-guarded against `packages/core/src/schemas/` (`tests/task-024/unit.test.ts`). This contract document records the `TASK-060` video sub-routes under `/api/tenants/{tenantId}/media/**` alongside the existing image pipeline.

## Endpoints

| Method & Path | Permission & CSRF | Purpose |
|---|---|---|
| `POST /api/tenants/{tenantId}/media/video/upload-intent` | `media:upload`, JSON + exact admin `Origin` | Atomically reserves storage quota (`storage_usage`) and a video slot (`< 20`), enforces 10,000,000-byte ceiling, rejects `placement: "hero"` & `autoplay: true`, returns same-origin upload path. Kill-switch: `VIDEO_UPLOAD_DISABLED=true` returns `503`. |
| `PUT\|POST /api/tenants/{tenantId}/media/video/upload/{intentId}` | `media:upload`, exact admin `Origin` | Streams video binary through hard `min(10,000,000, declaredBytes)` byte counter, verifies SHA-256, inspects container/codec/resolution/fps/MIME spoofing, rejects client R2 key overrides, writes private R2 quarantine `t/<tenantId>/quarantine/...`, allocates sequential `media_items`, enqueues `media.process_video`. |
| `PUT\|POST /api/tenants/{tenantId}/media/{resourceId}/captions` | `media:manage`, exact admin `Origin` | Uploads optional WebVTT (`.vtt`, `<= 256,000` bytes). Strictly validates UTF-8, `WEBVTT` header, cue timings, rejects `STYLE` blocks, strips `<script>` / HTML tags, stores sanitized `text/vtt` under `t/<tenantId>/media/<id>/<slug>-captions.vtt`. |
| `PUT\|POST /api/tenants/{tenantId}/media/{resourceId}/poster` | `media:manage`, exact admin `Origin` | Uploads client-captured poster frame (`<= 2,000,000` bytes), strips EXIF and normalizes to `image/webp` via Cloudflare Images binding, stores under `t/<tenantId>/media/<id>/<slug>-poster.webp`. |
| `POST /api/tenants/{tenantId}/media/{resourceId}/retry` | `media:manage`, JSON + exact admin `Origin` | Retries processing for a `failed` video whose quarantine source object still exists in R2. Re-enforces 20-video cap & storage quota atomically. |

## Error Codes

- `413 PAYLOAD_TOO_LARGE`: Video exceeds `10,000,000` bytes (including direct streaming bypass) or poster exceeds `2,000,000` bytes.
- `413 CAPTION_TOO_LARGE`: WebVTT exceeds `256,000` bytes.
- `415 UNSUPPORTED_MEDIA_TYPE`: Non-MP4/MOV/WebM container, SVG/HTML, or unsupported format.
- `422 VIDEO_LIMIT_REACHED`: Website already holds 20 active video slots (parallel intents enforced atomically in SQL; permanent purge frees a slot).
- `422 STORAGE_QUOTA_EXCEEDED`: Normalized storage quota exceeded (`100 MB` trial / `1 GB` paid/grace/locked).
- `422 VIDEO_HERO_PLACEMENT_FORBIDDEN`: Video placement in `hero` section rejected.
- `422 VIDEO_AUTOPLAY_FORBIDDEN`: `autoplay: true` rejected.
- `422 MIME_SPOOFING` / `OVERSIZED_DIMENSIONS` / `OVERSIZED_FRAMERATE` / `CORRUPT_VIDEO`: Binary container inspection failure.
- `422 INVALID_WEBVTT_HEADER` / `FORBIDDEN_WEBVTT_STYLE` / `INVALID_WEBVTT_CUE` / `EMPTY_CAPTION`: WebVTT caption validation failure.
- `403 FORBIDDEN`: Foreign R2 key override, unauthorized role, or locked/suspended tenant.
- `404 NOT_FOUND`: Cross-tenant handle or missing resource.
- `409 MEDIA_TRASHED`: Poster or caption upload rejected because the video is soft-deleted in trash.
- `409 INVALID_MEDIA_STATE`: Poster upload rejected when video is not `processing`/`ready`, or caption upload rejected when video is not `ready`.
- `409 RETRY_SOURCE_EXPIRED`: Quarantine object missing on retry.
- `429 RATE_LIMITED`: Exceeded 50 intents/hour or 200 intents/day (`Retry-After` header included).
- `VIDEO_TRANSCODER_UNAVAILABLE` (non-retryable worker failure): MOV/WebM or non-compliant/multi-track/fragmented MP4 uploaded in an environment where the `VideoTranscoder` Cloudflare Container binding is not yet provisioned. Marks `media_items` `failed` immediately with Indonesian guidance (*"Konversi MOV/WebM membutuhkan layanan transkode yang belum aktif; unggah MP4 H.264/AAC."*), deletes the quarantine object, and releases reserved storage bytes without retry loops.

## Dual-Path Queue Processing (`media.process_video`)

1. **Compliant Single-Track Non-Fragmented H.264/AAC MP4 (`worker_faststart`):** Pure-JS box rewriter strips metadata boxes (`udta`, `meta`, `uuid`, `free`, `skip`) and moves `moov` before `mdat` while adjusting all `stco`/`co64` chunk offsets inside the Worker. Fragmented MP4s (`moof`/`mvex`), multi-video-track MP4s, and files carrying timed-metadata tracks (`mebx`, `meta`, `gps `, `tmcd`, `text`) are excluded from `worker_faststart` and routed through `VideoTranscoder`.
2. **MOV / WebM / non-H.264/AAC MP4 (`container_transcode`):** Invokes bounded scale-to-zero `VideoTranscoder` Cloudflare Container (`ffmpeg`, concurrency `1`, `noUpscale: true`, `stripMetadata: true`, `extractPoster: true`), verifies output invariants, and runs fast-start normalization. If `env.VIDEO_TRANSCODER` is unbound (local dev / pre-provisioning), fails fast with `VIDEO_TRANSCODER_UNAVAILABLE` (Cloudflare Paid Container image provisioning is tracked as an explicit staging/production infra gate in `STATUS.md` / `TASK-063`).
3. **Poster Output:** Guaranteed `image/webp` from client-captured frame, container-extracted frame (normalized via Cloudflare Images), or built-in valid WebP default poster.
4. **Public Delivery:** Zero public source URL before status reaches `ready`; `<Video />` always emits `controls`, `preload="none"`, `playsinline`, `poster`, explicit `width`/`height`, optional `<track kind="captions">`, and never `autoplay`.
