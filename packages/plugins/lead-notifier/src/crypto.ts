import { constantTimeEqual } from "@punyasitus/core/plugins/index";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "./constants.ts";

const TEXT_ENCODER = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateRandomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(Math.max(1, Math.trunc(byteLength)));
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function generateRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(Math.max(1, Math.trunc(byteLength)));
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export function generateWebhookSigningSecret(): string {
  return `whsec_${generateRandomHex(24)}`;
}

export function maskSigningSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return "whsec_****";
  }
  const tail = trimmed.slice(-4);
  return `whsec_****${tail}`;
}

export function generateDeliveryId(prefix = "dlv"): string {
  return `${prefix}_${generateRandomHex(12)}`;
}

/**
 * Computes `X-PunyaSitus-Signature` value in `t=<epoch_seconds>,v1=<hmac_sha256_hex>` format.
 * Signed canonical string is `${timestampSec}.${rawBody}`.
 */
export async function buildWebhookSignatureHeader(
  secret: string,
  rawBody: string,
  timestampSec: number,
): Promise<string> {
  const ts = Math.floor(timestampSec);
  const v1 = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  return `t=${ts},v1=${v1}`;
}

export interface VerifyWebhookSignatureInput {
  readonly rawBody: string;
  readonly signatureHeader: string;
  readonly secret: string;
  readonly nowMs?: number;
  readonly toleranceSeconds?: number;
}

export type VerifyWebhookSignatureResult =
  | { readonly ok: true; readonly timestamp: number }
  | {
      readonly ok: false;
      readonly reason:
        | "MISSING_HEADER"
        | "MALFORMED_HEADER"
        | "TIMESTAMP_EXPIRED"
        | "SIGNATURE_MISMATCH";
    };

/**
 * Constant-time verification for `X-PunyaSitus-Signature: t=<ts>,v1=<hex>`.
 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<VerifyWebhookSignatureResult> {
  const header = input.signatureHeader.trim();
  if (!header) {
    return { ok: false, reason: "MISSING_HEADER" };
  }

  let parsedTs: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === "t" && /^\d{9,12}$/.test(val)) {
      parsedTs = Number(val);
    } else if (key === "v1" && /^[a-f0-9]{64}$/i.test(val)) {
      signatures.push(val.toLowerCase());
    }
  }

  if (parsedTs === null || signatures.length === 0) {
    return { ok: false, reason: "MALFORMED_HEADER" };
  }

  const toleranceSec = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (toleranceSec > 0) {
    const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSec - parsedTs) > toleranceSec) {
      return { ok: false, reason: "TIMESTAMP_EXPIRED" };
    }
  }

  const expected = await hmacSha256Hex(input.secret, `${parsedTs}.${input.rawBody}`);
  const matched = signatures.some((sig) => constantTimeEqual(sig, expected));
  if (!matched) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }

  return { ok: true, timestamp: parsedTs };
}

/**
 * Constant-time verification of Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
 * Strictly fail-closed when expected secret is unconfigured or header is missing.
 */
export function verifyTelegramWebhookSecret(
  request: Request,
  runtimeEnv: Readonly<Record<string, unknown>>,
  overrideSecret?: string,
): boolean {
  const expectedRaw =
    overrideSecret ??
    (typeof runtimeEnv.TELEGRAM_WEBHOOK_SECRET === "string"
      ? runtimeEnv.TELEGRAM_WEBHOOK_SECRET
      : typeof runtimeEnv.LEAD_NOTIFIER_TELEGRAM_WEBHOOK_SECRET === "string"
        ? runtimeEnv.LEAD_NOTIFIER_TELEGRAM_WEBHOOK_SECRET
        : "");
  const expected = expectedRaw.trim();
  if (!expected) {
    return false;
  }
  const provided = request.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER) ?? "";
  if (!provided) {
    return false;
  }
  return constantTimeEqual(provided, expected);
}
