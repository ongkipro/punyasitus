import { normalizeHost } from "@punyasitus/core";
import { FORBIDDEN_TENANT_SELECTOR_KEYS } from "@punyasitus/core/schemas";

/**
 * Public POST input guard for host-scoped anonymous tenant endpoints:
 * - `POST /api/leads`
 * - `POST /api/events`
 * - `POST /api/abuse-report`
 *
 * Enforces PLAN §6 & REQ-038:
 * - Exact Origin & Sec-Fetch-Site matrix (preserving no-JS progressive enhancement)
 * - Streaming + Content-Length strict body cap (16 KiB default -> 413)
 * - Strict UTF-8 decoding, syntax parsing, and control-character rejection
 * - Forged tenant selector rejection (`tenantId`, `tenant_id`, etc. -> 422)
 * - Accessible honeypot rejection
 * - Standard `ApiErrorSchema` JSON error response generation
 */

export const DEFAULT_PUBLIC_POST_MAX_BYTES = 16_384;

export const JSON_CONTENT_TYPE = "application/json" as const;
export const FORM_URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded" as const;
export const MULTIPART_FORM_CONTENT_TYPE = "multipart/form-data" as const;

export type PublicPostContentType =
  | typeof JSON_CONTENT_TYPE
  | typeof FORM_URLENCODED_CONTENT_TYPE
  | typeof MULTIPART_FORM_CONTENT_TYPE;

export const PUBLIC_LEAD_ALLOWED_CONTENT_TYPES: readonly PublicPostContentType[] = [
  JSON_CONTENT_TYPE,
  FORM_URLENCODED_CONTENT_TYPE,
  MULTIPART_FORM_CONTENT_TYPE,
];

export const PUBLIC_EVENT_ALLOWED_CONTENT_TYPES: readonly PublicPostContentType[] = [
  JSON_CONTENT_TYPE,
];

export const PUBLIC_ABUSE_REPORT_ALLOWED_CONTENT_TYPES: readonly PublicPostContentType[] = [
  JSON_CONTENT_TYPE,
  FORM_URLENCODED_CONTENT_TYPE,
  MULTIPART_FORM_CONTENT_TYPE,
];

const FORM_CONTENT_TYPE_SET: ReadonlySet<string> = new Set([
  FORM_URLENCODED_CONTENT_TYPE,
  MULTIPART_FORM_CONTENT_TYPE,
]);

const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_TENANT_SELECTOR_KEYS.map((key) => key.toLowerCase()),
);

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type PublicInputGuardCode =
  | "METHOD_NOT_ALLOWED"
  | "INVALID_TENANT_HOST"
  | "NULL_ORIGIN"
  | "ORIGIN_MISMATCH"
  | "MISSING_ORIGIN"
  | "CROSS_SITE_FORM"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_SYNTAX"
  | "INVALID_ENCODING"
  | "CONTROL_CHARACTERS"
  | "FORGED_TENANT_FIELD"
  | "HONEYPOT_TRIGGERED"
  | "VALIDATION_ERROR";

export type CanonicalApiErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "VALIDATION_ERROR";

export interface PublicInputErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface PublicInputFailure {
  readonly ok: false;
  readonly status: 400 | 403 | 405 | 413 | 415 | 422;
  readonly code: PublicInputGuardCode;
  readonly apiErrorCode: CanonicalApiErrorCode;
  readonly message: string;
  readonly fields?: readonly PublicInputErrorField[];
}

export interface SafeParseIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code: string;
}

export interface SafeParseSchemaLike<TOutput> {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: TOutput }
    | { readonly success: false; readonly error: { readonly issues: readonly SafeParseIssueLike[] } };
}

export interface PublicPostValidationSuccess<TData = Record<string, unknown>> {
  readonly ok: true;
  readonly data: TData;
  readonly rawPayload: Record<string, unknown>;
  readonly submissionMode: "json" | "form";
  readonly contentType: PublicPostContentType;
  readonly byteLength: number;
  readonly tenantHost: string;
  readonly expectedOrigin: string;
  readonly clientIp: string | null;
  readonly idempotencyKey: string | null;
}

export type PublicPostValidationResult<TData = Record<string, unknown>> =
  | PublicPostValidationSuccess<TData>
  | PublicInputFailure;

export interface ValidatePublicPostOptions<TData = Record<string, unknown>> {
  /**
   * Verified tenant host resolved exclusively from request URL/Host context
   * (NEVER from `X-Forwarded-Host` or `X-Tenant-ID`).
   */
  readonly tenantHost: string;
  /**
   * Optional explicit origin override (e.g. local loopback HTTP fixture).
   * Defaults to `https://${normalizedTenantHost}`.
   */
  readonly expectedOrigin?: string;
  /**
   * Maximum allowed request body size in bytes. Defaults to `16_384` (16 KiB).
   */
  readonly maxBytes?: number;
  /**
   * Allowed request content types. Defaults to JSON + HTML form POST types.
   */
  readonly allowedContentTypes?: readonly PublicPostContentType[];
  /**
   * Accessible honeypot field name checked for non-empty bot submissions.
   * Defaults to `"honeypot"`. Pass `null` to disable.
   */
  readonly honeypotField?: string | null;
  /**
   * Optional Zod (or compatible `safeParse`) schema applied after structural/security guards.
   */
  readonly schema?: SafeParseSchemaLike<TData>;
}

interface ParsedContentType {
  readonly mediaType: string;
  readonly charset: string | null;
  readonly raw: string;
}

function parseContentType(headerValue: string | null): ParsedContentType | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(";");
  const mediaType = (parts[0] ?? "").trim().toLowerCase();
  if (!mediaType) return null;
  let charset: string | null = null;
  for (let i = 1; i < parts.length; i += 1) {
    const param = (parts[i] ?? "").trim();
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key === "charset") {
      charset = param
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "")
        .toLowerCase();
    }
  }
  return { mediaType, charset, raw: trimmed };
}

function isFormMediaType(mediaType: string | null): boolean {
  return mediaType !== null && FORM_CONTENT_TYPE_SET.has(mediaType);
}

function makeFailure(
  status: PublicInputFailure["status"],
  code: PublicInputGuardCode,
  apiErrorCode: CanonicalApiErrorCode,
  message: string,
  fields?: readonly PublicInputErrorField[],
): PublicInputFailure {
  return {
    ok: false,
    status,
    code,
    apiErrorCode,
    message,
    ...(fields && fields.length > 0 ? { fields } : {}),
  };
}

export interface OriginCheckSuccess {
  readonly ok: true;
  readonly tenantHost: string;
  readonly expectedOrigin: string;
}

export type OriginCheckResult = OriginCheckSuccess | PublicInputFailure;

/**
 * Enforces the EXACT PLAN §6 Origin & Sec-Fetch-Site matrix for public POST endpoints:
 * - Present `Origin`:
 *   - Literal `"null"` -> `403 NULL_ORIGIN`
 *   - Anything !== `expectedOrigin` (`https://${tenantHost}`) -> `403 ORIGIN_MISMATCH`
 * - Missing `Origin`:
 *   - Non-form request (JSON, text/plain, missing content-type, etc.) -> `403 MISSING_ORIGIN`
 *   - Normal HTML form POST (`application/x-www-form-urlencoded` or `multipart/form-data`):
 *     - Present `Sec-Fetch-Site` !== `"same-origin"` (e.g. `cross-site`, `same-site`, `none`) -> `403 CROSS_SITE_FORM`
 *     - Absent `Sec-Fetch-Site` OR `"same-origin"` -> ACCEPT (no-JS progressive enhancement)
 */
export function validatePublicPostOrigin(
  request: Pick<Request, "headers">,
  options: { readonly tenantHost: string; readonly expectedOrigin?: string },
): OriginCheckResult {
  const normalizedHost = normalizeHost(options.tenantHost);
  if (!normalizedHost) {
    return makeFailure(
      403,
      "INVALID_TENANT_HOST",
      "FORBIDDEN",
      "Host situs tidak valid untuk permintaan publik.",
    );
  }
  const expectedOrigin = options.expectedOrigin?.trim() || `https://${normalizedHost}`;

  const rawOrigin = request.headers.get("origin");
  if (rawOrigin !== null) {
    const trimmedOrigin = rawOrigin.trim();
    if (trimmedOrigin.toLowerCase() === "null") {
      return makeFailure(
        403,
        "NULL_ORIGIN",
        "FORBIDDEN",
        "Permintaan dari Origin null tidak diizinkan.",
      );
    }
    if (trimmedOrigin !== expectedOrigin) {
      return makeFailure(
        403,
        "ORIGIN_MISMATCH",
        "FORBIDDEN",
        "Origin permintaan tidak cocok dengan situs ini.",
      );
    }
    return { ok: true, tenantHost: normalizedHost, expectedOrigin };
  }

  // Origin header is missing.
  const parsedCt = parseContentType(request.headers.get("content-type"));
  if (!isFormMediaType(parsedCt?.mediaType ?? null)) {
    return makeFailure(
      403,
      "MISSING_ORIGIN",
      "FORBIDDEN",
      "Header Origin wajib disertakan untuk permintaan ini.",
    );
  }

  const rawSecFetchSite = request.headers.get("sec-fetch-site");
  if (rawSecFetchSite !== null) {
    const secFetchSite = rawSecFetchSite.trim().toLowerCase();
    if (secFetchSite !== "same-origin") {
      return makeFailure(
        403,
        "CROSS_SITE_FORM",
        "FORBIDDEN",
        "Pengiriman formulir lintas situs tidak diizinkan.",
      );
    }
  }

  return { ok: true, tenantHost: normalizedHost, expectedOrigin };
}

export type ReadBoundedBodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | PublicInputFailure;

/**
 * Reads a Request body while enforcing a hard `maxBytes` cap both from `Content-Length`
 * (fast rejection) and via a streaming byte counter over `request.body` (chunked bodies).
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number = DEFAULT_PUBLIC_POST_MAX_BYTES,
): Promise<ReadBoundedBodyResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("INVALID_MAX_BYTES: maxBytes must be a positive integer");
  }

  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const trimmedLen = rawContentLength.trim();
    if (!/^\d+$/.test(trimmedLen)) {
      return makeFailure(
        400,
        "MALFORMED_SYNTAX",
        "BAD_REQUEST",
        "Header Content-Length tidak valid.",
      );
    }
    const declaredBytes = Number(trimmedLen);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      return makeFailure(
        413,
        "PAYLOAD_TOO_LARGE",
        "PAYLOAD_TOO_LARGE",
        `Ukuran permintaan melebihi batas maksimum ${maxBytes} byte.`,
      );
    }
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array(0) };
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
        await reader.cancel().catch(() => undefined);
        return makeFailure(
          413,
          "PAYLOAD_TOO_LARGE",
          "PAYLOAD_TOO_LARGE",
          `Ukuran permintaan melebihi batas maksimum ${maxBytes} byte.`,
        );
      }
      chunks.push(value);
    }
  } catch {
    return makeFailure(
      400,
      "MALFORMED_SYNTAX",
      "BAD_REQUEST",
      "Body permintaan tidak dapat dibaca.",
    );
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined };
}

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function decodePercentComponentStrict(
  raw: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: "syntax" | "encoding" } {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x2b) {
      // '+' -> space in application/x-www-form-urlencoded
      bytes.push(0x20);
    } else if (ch === 0x25) {
      // '%' must be followed by two hex digits
      if (i + 2 >= raw.length) {
        return { ok: false, reason: "syntax" };
      }
      const hi = hexValue(raw.charCodeAt(i + 1));
      const lo = hexValue(raw.charCodeAt(i + 2));
      if (hi === -1 || lo === -1) {
        return { ok: false, reason: "syntax" };
      }
      bytes.push((hi << 4) | lo);
      i += 2;
    } else if (ch < 0x80) {
      bytes.push(ch);
    } else {
      const encoded = new TextEncoder().encode(raw[i] ?? "");
      for (let j = 0; j < encoded.length; j += 1) {
        bytes.push(encoded[j] ?? 0);
      }
    }
  }
  const decoded = decodeStrictUtf8(new Uint8Array(bytes));
  if (decoded === null) {
    return { ok: false, reason: "encoding" };
  }
  return { ok: true, value: decoded };
}

/**
 * Strictly decodes `application/x-www-form-urlencoded` bytes, rejecting malformed `%`
 * escapes (`400 MALFORMED_SYNTAX`) and invalid UTF-8 byte sequences (`400 INVALID_ENCODING`).
 */
export function decodeStrictFormUrlEncoded(
  bytes: Uint8Array,
): { readonly ok: true; readonly payload: Record<string, unknown> } | PublicInputFailure {
  const rawText = decodeStrictUtf8(bytes);
  if (rawText === null) {
    return makeFailure(
      400,
      "INVALID_ENCODING",
      "BAD_REQUEST",
      "Encoding UTF-8 pada permintaan tidak valid.",
    );
  }
  if (rawText.trim().length === 0) {
    return makeFailure(
      400,
      "MALFORMED_SYNTAX",
      "BAD_REQUEST",
      "Body formulir tidak boleh kosong.",
    );
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const pairs = rawText.split("&");
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);

    const keyRes = decodePercentComponentStrict(rawKey);
    if (!keyRes.ok) {
      return keyRes.reason === "encoding"
        ? makeFailure(400, "INVALID_ENCODING", "BAD_REQUEST", "Encoding UTF-8 pada field formulir tidak valid.")
        : makeFailure(400, "MALFORMED_SYNTAX", "BAD_REQUEST", "Format formulir tidak valid.");
    }
    const valRes = decodePercentComponentStrict(rawVal);
    if (!valRes.ok) {
      return valRes.reason === "encoding"
        ? makeFailure(400, "INVALID_ENCODING", "BAD_REQUEST", "Encoding UTF-8 pada nilai formulir tidak valid.")
        : makeFailure(400, "MALFORMED_SYNTAX", "BAD_REQUEST", "Format nilai formulir tidak valid.");
    }

    if (PROTOTYPE_POLLUTION_KEYS.has(keyRes.value)) {
      return makeFailure(400, "MALFORMED_SYNTAX", "BAD_REQUEST", "Nama field tidak diizinkan.");
    }
    out[keyRes.value] = valRes.value;
  }

  return { ok: true, payload: { ...out } };
}

async function decodeStrictMultipartForm(
  bytes: Uint8Array<ArrayBuffer>,
  rawContentType: string,
): Promise<{ readonly ok: true; readonly payload: Record<string, unknown> } | PublicInputFailure> {
  let formData: FormData;
  try {
    const response = new Response(bytes, {
      headers: { "content-type": rawContentType },
    });
    formData = await response.formData();
  } catch {
    return makeFailure(
      400,
      "MALFORMED_SYNTAX",
      "BAD_REQUEST",
      "Format multipart/form-data tidak valid.",
    );
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let entryCount = 0;

  for (const [key, value] of formData.entries()) {
    entryCount += 1;
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      return makeFailure(400, "MALFORMED_SYNTAX", "BAD_REQUEST", "Nama field tidak diizinkan.");
    }
    if (typeof value !== "string") {
      return makeFailure(
        422,
        "VALIDATION_ERROR",
        "VALIDATION_ERROR",
        "Unggahan file tidak diizinkan pada formulir publik ini.",
        [{ field: key, code: "FILE_NOT_ALLOWED", message: "Hanya nilai teks yang diizinkan." }],
      );
    }
    out[key] = value;
  }

  if (entryCount === 0) {
    return makeFailure(
      400,
      "MALFORMED_SYNTAX",
      "BAD_REQUEST",
      "Body formulir tidak boleh kosong.",
    );
  }

  return { ok: true, payload: { ...out } };
}

function hasDisallowedControlCharsInString(value: string, allowLineBreaks: boolean): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
    if (code <= 0x1f) {
      if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Recursively scans a parsed payload for any forged tenant selector field
 * (`tenantId`, `tenant_id`, `organizationId`, `organization_id`, `tenantHandle`, `tenant_handle`).
 */
export function findForgedTenantField(value: unknown, prefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForgedTenantField(value[i], `${prefix}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_TENANT_KEY_SET.has(key.toLowerCase())) {
      return path;
    }
    const found = findForgedTenantField(nested, path);
    if (found) return found;
  }
  return null;
}

/**
 * Recursively scans keys and string values for disallowed control characters (NUL, C0/C1, DEL).
 * Object keys forbid all control characters; string values allow standard tab/newline (`\t`, `\n`, `\r`).
 */
export function findDisallowedControlChars(value: unknown, prefix = ""): string | null {
  if (typeof value === "string") {
    return hasDisallowedControlCharsInString(value, true) ? prefix || "body" : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findDisallowedControlChars(value[i], `${prefix}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (hasDisallowedControlCharsInString(key, false)) {
      return path;
    }
    const found = findDisallowedControlChars(nested, path);
    if (found) return found;
  }
  return null;
}

function hasPrototypePollutionKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasPrototypePollutionKey(item));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) return true;
    if (hasPrototypePollutionKey((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function extractTrustedClientIp(request: Pick<Request, "headers">): string | null {
  const raw = request.headers.get("cf-connecting-ip");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractIdempotencyKeyHeader(request: Pick<Request, "headers">): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Complete PLAN §6 public POST guard for `/api/leads`, `/api/events`, and `/api/abuse-report`.
 *
 * Validation order (fail-fast, fail-closed):
 * 1. HTTP method (`POST` only)
 * 2. Exact Origin & Sec-Fetch-Site matrix (derived solely from resolved `tenantHost`)
 * 3. Allowed Content-Type & UTF-8 charset check (`415`)
 * 4. Strict `Content-Length` + streaming byte cap (`413`, default `16_384` bytes)
 * 5. Strict UTF-8 & JSON/Form decoding (`400`)
 * 6. Forged tenant selector rejection (`422 FORGED_TENANT_FIELD`)
 * 7. Disallowed control character rejection (`422 CONTROL_CHARACTERS`)
 * 8. Accessible honeypot check (`422 HONEYPOT_TRIGGERED`)
 * 9. Optional Zod/contract schema validation (`422 VALIDATION_ERROR`)
 */
export async function validatePublicPostRequest<TData = Record<string, unknown>>(
  request: Request,
  options: ValidatePublicPostOptions<TData>,
): Promise<PublicPostValidationResult<TData>> {
  if (request.method.toUpperCase() !== "POST") {
    return makeFailure(
      405,
      "METHOD_NOT_ALLOWED",
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint ini.",
    );
  }

  // 1. Exact Origin & Sec-Fetch-Site matrix (ignores X-Forwarded-Host and X-Tenant-ID).
  const originCheck = validatePublicPostOrigin(request, {
    tenantHost: options.tenantHost,
    expectedOrigin: options.expectedOrigin,
  });
  if (!originCheck.ok) {
    return originCheck;
  }

  // 2. Content-Type & charset check.
  const allowedContentTypes = options.allowedContentTypes ?? PUBLIC_LEAD_ALLOWED_CONTENT_TYPES;
  const parsedCt = parseContentType(request.headers.get("content-type"));
  if (!parsedCt || !allowedContentTypes.includes(parsedCt.mediaType as PublicPostContentType)) {
    return makeFailure(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "UNSUPPORTED_MEDIA_TYPE",
      "Tipe konten permintaan tidak didukung.",
    );
  }
  if (parsedCt.charset && parsedCt.charset !== "utf-8" && parsedCt.charset !== "utf8") {
    return makeFailure(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "UNSUPPORTED_MEDIA_TYPE",
      "Charset permintaan harus UTF-8.",
    );
  }

  // 3. Strict body size enforcement (Content-Length header AND streaming reader cap).
  const maxBytes = options.maxBytes ?? DEFAULT_PUBLIC_POST_MAX_BYTES;
  const bodyRes = await readBoundedRequestBody(request, maxBytes);
  if (!bodyRes.ok) {
    return bodyRes;
  }

  // 4. Strict syntax & UTF-8 decoding.
  const contentType = parsedCt.mediaType as PublicPostContentType;
  const submissionMode: "json" | "form" = contentType === JSON_CONTENT_TYPE ? "json" : "form";
  let payload: Record<string, unknown>;

  if (contentType === JSON_CONTENT_TYPE) {
    const text = decodeStrictUtf8(bodyRes.bytes);
    if (text === null) {
      return makeFailure(
        400,
        "INVALID_ENCODING",
        "BAD_REQUEST",
        "Encoding UTF-8 pada body JSON tidak valid.",
      );
    }
    if (text.trim().length === 0) {
      return makeFailure(
        400,
        "MALFORMED_SYNTAX",
        "BAD_REQUEST",
        "Body JSON tidak boleh kosong.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return makeFailure(
        400,
        "MALFORMED_SYNTAX",
        "BAD_REQUEST",
        "Format JSON tidak valid.",
      );
    }
    if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
      return makeFailure(
        400,
        "MALFORMED_SYNTAX",
        "BAD_REQUEST",
        "Body JSON harus berupa objek.",
      );
    }
    if (hasPrototypePollutionKey(parsedJson)) {
      return makeFailure(
        400,
        "MALFORMED_SYNTAX",
        "BAD_REQUEST",
        "Nama properti JSON tidak diizinkan.",
      );
    }
    payload = parsedJson as Record<string, unknown>;
  } else if (contentType === FORM_URLENCODED_CONTENT_TYPE) {
    const decodedForm = decodeStrictFormUrlEncoded(bodyRes.bytes);
    if (!decodedForm.ok) {
      return decodedForm;
    }
    payload = decodedForm.payload;
  } else {
    const decodedMultipart = await decodeStrictMultipartForm(bodyRes.bytes, parsedCt.raw);
    if (!decodedMultipart.ok) {
      return decodedMultipart;
    }
    payload = decodedMultipart.payload;
  }

  // 5. Reject forged tenant selector fields before schema checks.
  const forgedField = findForgedTenantField(payload);
  if (forgedField !== null) {
    return makeFailure(
      422,
      "FORGED_TENANT_FIELD",
      "VALIDATION_ERROR",
      "Field identitas tenant tidak diizinkan pada permintaan publik.",
      [
        {
          field: forgedField,
          code: "FORGED_TENANT_FIELD",
          message: "Scope tenant hanya ditentukan dari host permintaan yang terverifikasi.",
        },
      ],
    );
  }

  // 6. Reject disallowed control characters in keys and string values.
  const controlCharField = findDisallowedControlChars(payload);
  if (controlCharField !== null) {
    return makeFailure(
      422,
      "CONTROL_CHARACTERS",
      "VALIDATION_ERROR",
      "Input mengandung karakter kontrol yang tidak diizinkan.",
      [
        {
          field: controlCharField,
          code: "CONTROL_CHARACTERS",
          message: "Karakter kontrol tidak diizinkan pada field ini.",
        },
      ],
    );
  }

  // 7. Accessible honeypot check (empty string is valid for real human form submits).
  const honeypotField = options.honeypotField === undefined ? "honeypot" : options.honeypotField;
  if (honeypotField !== null && Object.prototype.hasOwnProperty.call(payload, honeypotField)) {
    const honeypotVal = payload[honeypotField];
    const isEmpty =
      honeypotVal === undefined ||
      (typeof honeypotVal === "string" && honeypotVal.trim().length === 0);
    if (!isEmpty) {
      return makeFailure(
        422,
        "HONEYPOT_TRIGGERED",
        "VALIDATION_ERROR",
        "Permintaan tidak dapat diproses.",
        [
          {
            field: honeypotField,
            code: "HONEYPOT_TRIGGERED",
            message: "Field verifikasi harus dibiarkan kosong.",
          },
        ],
      );
    }
  }

  // 8. Optional schema validation.
  let validatedData: TData;
  if (options.schema) {
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      const fields: PublicInputErrorField[] = parsed.error.issues.slice(0, 50).map((issue) => ({
        field:
          issue.path.length > 0
            ? issue.path.map((segment) => String(segment)).join(".")
            : "body",
        code: issue.code || "INVALID_VALUE",
        message: issue.message || "Nilai tidak valid.",
      }));
      return makeFailure(
        422,
        "VALIDATION_ERROR",
        "VALIDATION_ERROR",
        "Data permintaan tidak valid.",
        fields,
      );
    }
    validatedData = parsed.data;
  } else {
    validatedData = payload as TData;
  }

  return {
    ok: true,
    data: validatedData,
    rawPayload: payload,
    submissionMode,
    contentType,
    byteLength: bodyRes.bytes.byteLength,
    tenantHost: originCheck.tenantHost,
    expectedOrigin: originCheck.expectedOrigin,
    clientIp: extractTrustedClientIp(request),
    idempotencyKey: extractIdempotencyKeyHeader(request),
  };
}

/**
 * Formats a `PublicInputFailure` into a standard PLAN §6 JSON error `Response`
 * (`ApiErrorSchema`: `{ error: { code, message, fields? }, requestId }`) with zero stack traces.
 */
export function createPublicInputErrorResponse(
  failure: PublicInputFailure,
  requestId: string,
): Response {
  return Response.json(
    {
      error: {
        code: failure.apiErrorCode,
        message: failure.message,
        ...(failure.fields && failure.fields.length > 0 ? { fields: failure.fields } : {}),
      },
      requestId,
    },
    {
      status: failure.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        ...(failure.status === 405 ? { Allow: "POST" } : {}),
      },
    },
  );
}
