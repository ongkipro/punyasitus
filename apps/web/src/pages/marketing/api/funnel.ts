import { env } from "cloudflare:workers";
import {
  validateFunnelEventPayload,
  validateMarketingFunnelOrigin,
} from "@punyasitus/core/marketing/index";
import { recordFunnelEvent } from "@punyasitus/db/marketing/index";
import type { APIRoute } from "astro";

/**
 * `/marketing/api/funnel` — First-party cookieless funnel event intake (REQ-087, TASK-087).
 *
 * Security & Privacy Invariants:
 * - Strictly `POST` only; validates same-origin / canonical marketing host.
 * - Accepts only allowlisted funnel stages (`visit`, `demo_view`, `signup_start`,
 *   `email_verified`, `trial_created`, `first_payment`) + sanitized channel + allowlisted theme slug.
 * - Rejects any PII-carrying keys (`ip`, `email`, `phone`, `cookie`, `visitorId`, etc.) with `422`.
 * - Sets ZERO `Set-Cookie` headers and stores ZERO visitor IP, cookie, or PII.
 * - Returns `202 Accepted` on success.
 */

const MAX_FUNNEL_BODY_BYTES = 2048;

export interface MarketingFunnelRuntimeEnv {
  readonly APP_ENV?: string;
  readonly PLATFORM_DOMAIN?: string;
  readonly PLATFORM_DB?: D1Database | null;
}

export interface MarketingFunnelHandlerOptions {
  readonly nowMs?: number;
}

function jsonNoCookieResponse(
  status: 202 | 400 | 403 | 405 | 413 | 422 | 503,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-PunyaSitus-Surface": "marketing",
    ...extraHeaders,
  });
  // Guarantee zero Set-Cookie headers on every response path
  headers.delete("set-cookie");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Reads a UTF-8 request body with a hard byte ceiling (`maxBytes`), rejecting oversized
 * `Content-Length` headers upfront and aborting the stream mid-flight if total bytes exceed `maxBytes`.
 */
async function readBoundedUtf8Body(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: "too_large" }> {
  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw !== null) {
    const parsedLength = Number(contentLengthRaw.trim());
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder().decode(merged) };
}

export async function handleMarketingFunnelRequest(
  request: Request,
  runtimeEnv: MarketingFunnelRuntimeEnv,
  options: MarketingFunnelHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST") {
    return jsonNoCookieResponse(
      405,
      {
        accepted: false,
        code: "METHOD_NOT_ALLOWED",
        message: "Gunakan metode POST untuk mencatat event funnel tanpa cookie.",
      },
      { Allow: "POST" },
    );
  }

  const allowLocalLoopback = runtimeEnv.APP_ENV === "local" || runtimeEnv.APP_ENV === "test";
  const originOk = validateMarketingFunnelOrigin(request, {
    platformDomain: runtimeEnv.PLATFORM_DOMAIN,
    allowLocalLoopback,
  });
  if (!originOk) {
    return jsonNoCookieResponse(403, {
      accepted: false,
      code: "ORIGIN_NOT_ALLOWED",
      message: "Asal permintaan funnel tidak diizinkan.",
    });
  }

  const bodyRead = await readBoundedUtf8Body(request, MAX_FUNNEL_BODY_BYTES);
  if (!bodyRead.ok) {
    return jsonNoCookieResponse(413, {
      accepted: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "Ukuran payload funnel melebihi batas 2 KiB.",
    });
  }

  let parsedBody: unknown;
  try {
    parsedBody = bodyRead.text.trim().length > 0 ? JSON.parse(bodyRead.text) : null;
  } catch {
    return jsonNoCookieResponse(400, {
      accepted: false,
      code: "INVALID_JSON",
      message: "Body permintaan harus berupa JSON yang valid.",
    });
  }

  const validated = validateFunnelEventPayload(parsedBody);
  if (!validated.ok) {
    return jsonNoCookieResponse(422, {
      accepted: false,
      code: validated.code,
      message: validated.message,
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return jsonNoCookieResponse(503, {
      accepted: false,
      code: "DB_UNAVAILABLE",
      message: "Basis data platform sedang tidak tersedia.",
    });
  }

  const recorded = await recordFunnelEvent(runtimeEnv.PLATFORM_DB, {
    stage: validated.data.stage,
    sourceChannel: validated.data.sourceChannel,
    themeSlug: validated.data.themeSlug,
    nowMs: options.nowMs,
  });

  return jsonNoCookieResponse(202, {
    accepted: true,
    dayUtc: recorded.dayUtc,
    stage: recorded.stage,
    sourceChannel: recorded.sourceChannel,
    themeSlug: recorded.themeSlug,
  });
}

export const ALL: APIRoute = ({ request }) => {
  const runtimeEnv = env as typeof env;
  return handleMarketingFunnelRequest(request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
  });
};
