/**
 * HMAC-SHA256 signed ephemeral download tokens bound to `(exportId, tenantId, ownerUserId, expiresAtMs)`
 * for owner full-website export archives (REQ-107, PLAN §20.4, TASK-107).
 *
 * Security invariants:
 * - Bound to exact `exportId`, `tenantId`, `ownerUserId`, and `expiresAtMs` (24-hour TTL).
 * - Verified with Web Crypto HMAC-SHA256 + constant-time byte comparison.
 * - Never logged; persisted in `PLATFORM_DB` strictly as a SHA-256 hex digest (`hashExportDownloadToken`).
 */

const TOKEN_VERSION = "v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ExportDownloadTokenClaims {
  readonly exportId: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly expiresAtMs: number;
}

export type VerifyExportDownloadTokenResult =
  | { readonly ok: true; readonly claims: ExportDownloadTokenClaims }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed"
        | "invalid_signature"
        | "expired"
        | "scope_mismatch";
    };

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(encoded: string): Uint8Array | null {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = textEncoder.encode(secret);
  if (keyMaterial.byteLength < 16) {
    throw new Error("EXPORT_SIGNING_SECRET_TOO_SHORT");
  }
  return crypto.subtle.importKey(
    "raw",
    keyMaterial.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const msgBytes = textEncoder.encode(message);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes.buffer as ArrayBuffer);
  return new Uint8Array(sig);
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const input: BufferSource =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes as unknown as BufferSource);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export async function hashExportDownloadToken(token: string): Promise<string> {
  return sha256HexBytes(textEncoder.encode(token));
}

function encodeClaimsPayload(claims: ExportDownloadTokenClaims): string {
  const exportId = claims.exportId.trim();
  const tenantId = claims.tenantId.trim();
  const ownerUserId = claims.ownerUserId.trim();
  const expiresAtMs = Math.trunc(claims.expiresAtMs);

  if (!exportId || !tenantId || !ownerUserId || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error("INVALID_EXPORT_TOKEN_CLAIMS");
  }
  if (
    exportId.includes("|") ||
    tenantId.includes("|") ||
    ownerUserId.includes("|")
  ) {
    throw new Error("INVALID_EXPORT_TOKEN_CLAIM_CHARS");
  }

  return `${TOKEN_VERSION}|${exportId}|${tenantId}|${ownerUserId}|${expiresAtMs}`;
}

export async function signExportDownloadToken(
  secret: string,
  claims: ExportDownloadTokenClaims,
): Promise<string> {
  const payload = encodeClaimsPayload(claims);
  const payloadB64 = toBase64Url(textEncoder.encode(payload));
  const sigBytes = await hmacSha256(secret, `punyasitus-export-download:${payloadB64}`);
  return `${payloadB64}.${toBase64Url(sigBytes)}`;
}

export async function verifyExportDownloadToken(
  secret: string,
  rawToken: string,
  expected: {
    readonly exportId: string;
    readonly tenantId: string;
    readonly ownerUserId: string;
    readonly nowMs?: number;
  },
): Promise<VerifyExportDownloadTokenResult> {
  const trimmed = rawToken.trim();
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx <= 0 || dotIdx !== trimmed.lastIndexOf(".")) {
    return { ok: false, reason: "malformed" };
  }

  const payloadB64 = trimmed.slice(0, dotIdx);
  const sigB64 = trimmed.slice(dotIdx + 1);
  const payloadBytes = fromBase64Url(payloadB64);
  const providedSig = fromBase64Url(sigB64);
  if (!payloadBytes || !providedSig || providedSig.byteLength !== 32) {
    return { ok: false, reason: "malformed" };
  }

  let expectedSig: Uint8Array;
  try {
    expectedSig = await hmacSha256(secret, `punyasitus-export-download:${payloadB64}`);
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  if (!constantTimeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let decoded: string;
  try {
    decoded = textDecoder.decode(payloadBytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const parts = decoded.split("|");
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "malformed" };
  }

  const exportId = parts[1] ?? "";
  const tenantId = parts[2] ?? "";
  const ownerUserId = parts[3] ?? "";
  const expiresAtMs = Number(parts[4]);

  if (!exportId || !tenantId || !ownerUserId || !Number.isSafeInteger(expiresAtMs)) {
    return { ok: false, reason: "malformed" };
  }

  if (
    exportId !== expected.exportId.trim() ||
    tenantId !== expected.tenantId.trim() ||
    ownerUserId !== expected.ownerUserId.trim()
  ) {
    return { ok: false, reason: "scope_mismatch" };
  }

  const nowMs = Math.trunc(expected.nowMs ?? Date.now());
  if (nowMs >= expiresAtMs) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    claims: {
      exportId,
      tenantId,
      ownerUserId,
      expiresAtMs,
    },
  };
}
