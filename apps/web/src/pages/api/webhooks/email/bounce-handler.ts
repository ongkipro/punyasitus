import { assertValidRecipient } from "@punyasitus/core/email/index";
import {
  recordWebhookBounceAtomically,
  recordWebhookEventOnce,
  type EmailSuppressionReason,
} from "@punyasitus/db/email/index";

export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300; // 5 minutes
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const HEX_SHA256_RE = /^[a-f0-9]{64}$/;

export interface SignEmailWebhookInput {
  readonly secret: string;
  readonly timestampSeconds: number | string;
  readonly rawBody: string;
}

export interface HandleEmailBounceWebhookDeps {
  readonly db: D1Database;
  readonly secret: string | undefined;
  readonly suppressionSalt?: string;
  readonly nowMs?: number;
  readonly maxSkewSeconds?: number;
}

async function computeHmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sigBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseTimestampMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{10,13}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  // Support 10-digit Unix seconds and 13-digit Unix milliseconds
  return trimmed.length <= 10 ? num * 1000 : num;
}

function extractHexSignature(rawHeader: string): string | null {
  const trimmed = rawHeader.trim().toLowerCase();
  const stripped = trimmed.startsWith("sha256=")
    ? trimmed.slice("sha256=".length)
    : trimmed.startsWith("v1=")
      ? trimmed.slice("v1=".length)
      : trimmed;
  return HEX_SHA256_RE.test(stripped) ? stripped : null;
}

/**
 * Produces the canonical `X-Webhook-Signature` header (`sha256=<hex>`) over
 * `${timestampSeconds}.${rawBody}` using HMAC-SHA256.
 */
export async function signEmailWebhookPayload(input: SignEmailWebhookInput): Promise<string> {
  const ts = String(input.timestampSeconds).trim();
  const hex = await computeHmacSha256Hex(input.secret, `${ts}.${input.rawBody}`);
  return `sha256=${hex}`;
}

type NormalizedWebhookEventType = "hard_bounce" | "complaint" | "soft_bounce" | "delivery";

function normalizeEventType(rawType: unknown): NormalizedWebhookEventType | null {
  if (typeof rawType !== "string") return null;
  const value = rawType.trim().toLowerCase();
  if (value === "hard_bounce" || value === "bounce" || value === "email.bounced") {
    return "hard_bounce";
  }
  if (value === "complaint" || value === "spam_complaint" || value === "email.complained") {
    return "complaint";
  }
  if (value === "soft_bounce" || value === "email.delivery_delayed") {
    return "soft_bounce";
  }
  if (value === "delivery" || value === "email.delivered") {
    return "delivery";
  }
  return null;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * Verifies signed email bounce/complaint webhooks (HMAC-SHA256 + <= 5 minute replay window
 * + atomic event-id/nonce deduplication) and records hard bounces/complaints in
 * `PLATFORM_DB.email_suppressions` using SHA-256 email hashes only.
 */
export async function handleEmailBounceWebhook(
  request: Request,
  deps: HandleEmailBounceWebhookDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "E_METHOD_NOT_ALLOWED" }, 405);
  }

  const secret = deps.secret?.trim();
  if (!secret) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_NOT_CONFIGURED" }, 503);
  }

  const signatureHeader = request.headers.get("x-webhook-signature");
  const timestampHeader = request.headers.get("x-webhook-timestamp");
  if (!signatureHeader || !timestampHeader) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_UNSIGNED" }, 401);
  }

  const nowMs = Math.floor(deps.nowMs ?? Date.now());
  const maxSkewMs = Math.max(1, Math.floor(deps.maxSkewSeconds ?? DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS)) * 1000;
  const timestampMs = parseTimestampMs(timestampHeader);
  if (timestampMs === null || Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_TIMESTAMP_EXPIRED" }, 401);
  }

  const providedHex = extractHexSignature(signatureHeader);
  if (!providedHex) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_INVALID_SIGNATURE" }, 401);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_BODY_TOO_LARGE" }, 413);
  }

  const expectedHex = await computeHmacSha256Hex(secret, `${timestampHeader.trim()}.${rawBody}`);
  if (!timingSafeEqualAscii(providedHex, expectedHex)) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_INVALID_SIGNATURE" }, 401);
  }

  let parsed: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(rawBody);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return jsonResponse({ ok: false, error: "E_WEBHOOK_INVALID_PAYLOAD" }, 400);
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_INVALID_JSON" }, 400);
  }

  // Derive replay eventId EXCLUSIVELY from the HMAC-authenticated body (never unsigned headers)
  // so a captured signed request cannot be replayed with a forged X-Webhook-Event-Id header.
  const rawEventId =
    (typeof parsed.eventId === "string" ? parsed.eventId.trim() : "") ||
    (typeof parsed.id === "string" ? parsed.id.trim() : "");

  if (!rawEventId || rawEventId.length > 200 || /[\r\n\0]/.test(rawEventId)) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_MISSING_EVENT_ID" }, 400);
  }

  const eventType = normalizeEventType(parsed.type);
  if (!eventType) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_UNSUPPORTED_EVENT" }, 400);
  }

  const rawEmail =
    typeof parsed.email === "string"
      ? parsed.email
      : typeof parsed.recipient === "string"
        ? parsed.recipient
        : "";

  let email: string;
  try {
    email = assertValidRecipient(rawEmail);
  } catch {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_INVALID_RECIPIENT" }, 400);
  }

  if (eventType === "hard_bounce" || eventType === "complaint") {
    const reason: EmailSuppressionReason = eventType;
    const source =
      typeof parsed.source === "string" && parsed.source.trim()
        ? `webhook:${parsed.source.trim().slice(0, 80)}`
        : "webhook:email";
    const atomic = await recordWebhookBounceAtomically(deps.db, {
      eventId: rawEventId,
      eventType,
      email,
      reason,
      source,
      salt: deps.suppressionSalt,
      nowMs,
    });
    if (atomic.kind === "replayed") {
      return jsonResponse({ ok: false, error: "E_WEBHOOK_REPLAYED" }, 409);
    }
    return jsonResponse(
      {
        ok: true,
        suppressed: true,
        emailHash: atomic.emailHash,
        reason,
      },
      200,
    );
  }

  const freshEvent = await recordWebhookEventOnce(deps.db, {
    eventId: rawEventId,
    eventType,
    nowMs,
  });
  if (!freshEvent) {
    return jsonResponse({ ok: false, error: "E_WEBHOOK_REPLAYED" }, 409);
  }

  return jsonResponse(
    {
      ok: true,
      suppressed: false,
      eventType,
    },
    200,
  );
}
