import { validateExternalLink } from "../link-sanitizer.ts";
import {
  MCP_CIMD_FETCH_TIMEOUT_MS,
  MCP_CIMD_MAX_RESPONSE_BYTES,
  MCP_SCOPES,
} from "./constants.ts";
import { CimdMetadataDocumentSchema, type CimdMetadataDocument } from "./schemas.ts";

/**
 * Runtime-neutral Web Crypto, PKCE S256, RFC 8707 resource matching, RFC 9728/8414
 * discovery metadata builders, and SSRF-safe CIMD metadata fetcher
 * (REQ-076, ADR-0008, PLAN §18.3, TASK-075).
 */

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time string comparison over UTF-8 bytes to avoid timing leaks on
 * PKCE challenges, hashes, or tokens.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function generateOpaqueToken(prefix: string, byteLength = 32): string {
  const random = new Uint8Array(byteLength);
  crypto.getRandomValues(random);
  return `${prefix}_${bytesToBase64Url(random)}`;
}

export function isValidPkceCodeVerifier(verifier: string): boolean {
  return typeof verifier === "string" && PKCE_VERIFIER_RE.test(verifier);
}

export function isValidPkceCodeChallenge(challenge: string): boolean {
  return typeof challenge === "string" && PKCE_CHALLENGE_RE.test(challenge);
}

/**
 * Computes RFC 7636 PKCE `S256` challenge: `BASE64URL(SHA256(ASCII(code_verifier)))`.
 */
export async function computePkceS256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function verifyPkceS256(
  codeVerifier: string,
  expectedChallenge: string,
): Promise<boolean> {
  if (!isValidPkceCodeVerifier(codeVerifier) || !isValidPkceCodeChallenge(expectedChallenge)) {
    return false;
  }
  const computed = await computePkceS256Challenge(codeVerifier);
  return constantTimeEqual(computed, expectedChallenge);
}

/**
 * Canonical RFC 8707 MCP resource identifier for a given admin origin.
 * Example: `https://app.punyasitus.com/mcp`
 */
export function buildCanonicalMcpResource(adminOrigin: string): string {
  const cleanOrigin = adminOrigin.trim().replace(/\/+$/, "");
  return `${cleanOrigin}/mcp`;
}

/**
 * Normalizes and validates an RFC 8707 `resource` indicator URL.
 * Rejects fragments, credentials, query strings, and non-HTTP(S) schemes.
 */
export function normalizeMcpResourceUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hash || parsed.search) return null;
    const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return null;
  }
}

/**
 * Strictly validates that an RFC 8707 `resource` parameter matches the canonical MCP resource URL.
 */
export function isMatchingMcpResource(
  providedResource: string | null | undefined,
  canonicalResource: string,
): boolean {
  const normalizedProvided = normalizeMcpResourceUrl(providedResource);
  const normalizedCanonical = normalizeMcpResourceUrl(canonicalResource);
  if (!normalizedProvided || !normalizedCanonical) return false;
  return constantTimeEqual(normalizedProvided, normalizedCanonical);
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata for `/.well-known/oauth-protected-resource`.
 */
export function buildProtectedResourceMetadata(adminOrigin: string) {
  const cleanOrigin = adminOrigin.trim().replace(/\/+$/, "");
  return {
    resource: buildCanonicalMcpResource(cleanOrigin),
    authorization_servers: [cleanOrigin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "PunyaSitus Tenant MCP Server",
    resource_documentation: `${cleanOrigin}/docs/mcp`,
  } as const;
}

/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata for `/.well-known/oauth-authorization-server`.
 */
export function buildAuthorizationServerMetadata(adminOrigin: string) {
  const cleanOrigin = adminOrigin.trim().replace(/\/+$/, "");
  return {
    issuer: cleanOrigin,
    authorization_endpoint: `${cleanOrigin}/oauth2/authorize`,
    token_endpoint: `${cleanOrigin}/oauth2/token`,
    revocation_endpoint: `${cleanOrigin}/oauth2/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    client_id_metadata_document_supported: true,
    resource_indicators_supported: true,
  } as const;
}

/**
 * Validates an OAuth 2.1 redirect URI:
 * - Public HTTPS URL (validated via `validateExternalLink`), OR
 * - RFC 8252 loopback redirect (`http://127.0.0.1[:port]/...` or `http://localhost[:port]/...` or `http://[::1][:port]/...`)
 * - Strictly rejects fragments (`#`), embedded credentials, control characters, and non-HTTP(S) schemes.
 */
export function validateOAuthRedirectUri(
  rawUri: string,
): { readonly ok: true; readonly uri: string } | { readonly ok: false; readonly reason: string } {
  if (typeof rawUri !== "string") {
    return { ok: false, reason: "redirect_uri harus berupa string." };
  }
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.length > 2048) {
    return { ok: false, reason: "redirect_uri tidak valid." };
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return { ok: false, reason: "redirect_uri mengandung karakter kontrol ilegal." };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Format redirect_uri tidak valid." };
  }

  if (parsed.hash) {
    return { ok: false, reason: "redirect_uri tidak boleh mengandung fragment (#)." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "redirect_uri tidak boleh mengandung kredensial." };
  }

  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (!isLoopback) {
      return {
        ok: false,
        reason: "redirect_uri HTTP hanya diizinkan untuk loopback lokal (RFC 8252).",
      };
    }
    return { ok: true, uri: trimmed };
  }

  const ext = validateExternalLink(trimmed);
  if (!ext.ok) {
    return { ok: false, reason: `redirect_uri ditolak: ${ext.message}` };
  }

  return { ok: true, uri: trimmed };
}

export type CimdValidationErrorCode =
  | "INVALID_CLIENT_ID_URL"
  | "SSRF_BLOCKED"
  | "REDIRECT_BLOCKED"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_METADATA_DOCUMENT"
  | "CLIENT_ID_MISMATCH";

export type CimdUrlValidationResult =
  | { readonly ok: true; readonly url: string; readonly hostname: string }
  | { readonly ok: false; readonly code: CimdValidationErrorCode; readonly message: string };

/**
 * Validates a Client ID Metadata Document (CIMD) URL before any outbound fetch:
 * - Strict `https://` public host via `validateExternalLink` (blocks private/loopback/link-local/CGNAT/metadata IPs & local suffixes)
 * - Must include a non-root pathname (e.g. `https://client.example/oauth/client.json`)
 * - Rejects fragments, credentials, and control chars.
 */
export function validateCimdClientIdUrl(rawUrl: string): CimdUrlValidationResult {
  const ext = validateExternalLink(rawUrl);
  if (!ext.ok) {
    const isSsrf = ext.code === "FORBIDDEN_HOST" || ext.code === "UNSUPPORTED_PROTOCOL";
    return {
      ok: false,
      code: isSsrf ? "SSRF_BLOCKED" : "INVALID_CLIENT_ID_URL",
      message: ext.message,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      code: "INVALID_CLIENT_ID_URL",
      message: "client_id CIMD bukan URL HTTPS yang valid.",
    };
  }

  if (parsed.hash) {
    return {
      ok: false,
      code: "INVALID_CLIENT_ID_URL",
      message: "client_id CIMD tidak boleh mengandung fragment (#).",
    };
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    return {
      ok: false,
      code: "SSRF_BLOCKED",
      message: "client_id CIMD hanya diizinkan pada port HTTPS standar (443).",
    };
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    return {
      ok: false,
      code: "INVALID_CLIENT_ID_URL",
      message: "client_id CIMD harus memiliki path dokumen metadata (bukan root '/').",
    };
  }

  return {
    ok: true,
    url: rawUrl.trim(),
    hostname: parsed.hostname.toLowerCase(),
  };
}

export interface FetchCimdOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export type FetchCimdResult =
  | { readonly ok: true; readonly document: CimdMetadataDocument }
  | { readonly ok: false; readonly code: CimdValidationErrorCode; readonly message: string };

/**
 * SSRF-hardened fetcher for OAuth 2.1 Client ID Metadata Documents (CIMD).
 *
 * Security invariants (ADR-0008, PLAN §18.3, TASK-075):
 * - Validates `client_id` is a strict public `https://` URL on default port 443 before any network call.
 * - Uses `redirect: "error"` AND rejects any 3xx status (zero redirect following!).
 * - Keeps the `AbortController` timeout active across BOTH response headers AND body read (`<= 5s`).
 * - Enforces bounded response body (`<= 32 KiB`).
 * - Validates strict Zod schema, verifies `document.client_id === requestedClientId`,
 *   and validates every `redirect_uri`.
 */
export async function fetchCimdMetadataDocument(
  rawClientIdUrl: string,
  options: FetchCimdOptions = {},
): Promise<FetchCimdResult> {
  const urlCheck = validateCimdClientIdUrl(rawClientIdUrl);
  if (!urlCheck.ok) {
    return urlCheck;
  }

  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = Math.max(200, Math.min(10_000, options.timeoutMs ?? MCP_CIMD_FETCH_TIMEOUT_MS));
  const maxBytes = Math.max(1024, Math.min(65_536, options.maxBytes ?? MCP_CIMD_MAX_RESPONSE_BYTES));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let rawBytes: Uint8Array;
  try {
    let response: Response;
    try {
      response = await fetchImpl(urlCheck.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "PunyaSitus-MCP-CIMD/1.0",
        },
      });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return {
          ok: false,
          code: "FETCH_TIMEOUT",
          message: "Pengambilan dokumen metadata klien CIMD melewati batas waktu.",
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/redirect/i.test(msg)) {
        return {
          ok: false,
          code: "REDIRECT_BLOCKED",
          message: "Pengalihan HTTP (redirect) dilarang saat mengambil metadata klien CIMD.",
        };
      }
      return {
        ok: false,
        code: "FETCH_FAILED",
        message: "Gagal mengambil dokumen metadata klien CIMD.",
      };
    }

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return {
        ok: false,
        code: "REDIRECT_BLOCKED",
        message: "Pengalihan HTTP (redirect) dilarang saat mengambil metadata klien CIMD.",
      };
    }

    if (response.status !== 200) {
      return {
        ok: false,
        code: "FETCH_FAILED",
        message: `Dokumen metadata klien CIMD mengembalikan HTTP ${response.status}.`,
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      return {
        ok: false,
        code: "INVALID_METADATA_DOCUMENT",
        message: "Dokumen metadata klien CIMD harus memiliki Content-Type application/json.",
      };
    }

    const declaredLen = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      return {
        ok: false,
        code: "RESPONSE_TOO_LARGE",
        message: `Dokumen metadata klien CIMD melebihi batas ${maxBytes} byte.`,
      };
    }

    try {
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const abortRead = () => {
          void reader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener("abort", abortRead, { once: true });
        try {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            if (controller.signal.aborted) {
              return {
                ok: false,
                code: "FETCH_TIMEOUT",
                message: "Pembacaan dokumen metadata klien CIMD melewati batas waktu.",
              };
            }
            const readPromise = reader.read();
            const abortPromise = new Promise<never>((_resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              controller.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
            const { done, value } = await Promise.race([readPromise, abortPromise]);
            if (controller.signal.aborted) {
              return {
                ok: false,
                code: "FETCH_TIMEOUT",
                message: "Pembacaan dokumen metadata klien CIMD melewati batas waktu.",
              };
            }
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return {
                  ok: false,
                  code: "RESPONSE_TOO_LARGE",
                  message: `Dokumen metadata klien CIMD melebihi batas ${maxBytes} byte.`,
                };
              }
              chunks.push(value);
            }
          }
          rawBytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            rawBytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } finally {
          controller.signal.removeEventListener("abort", abortRead);
        }
      } else {
        const text = await response.text();
        if (controller.signal.aborted) {
          return {
            ok: false,
            code: "FETCH_TIMEOUT",
            message: "Pembacaan dokumen metadata klien CIMD melewati batas waktu.",
          };
        }
        rawBytes = new TextEncoder().encode(text);
        if (rawBytes.byteLength > maxBytes) {
          return {
            ok: false,
            code: "RESPONSE_TOO_LARGE",
            message: `Dokumen metadata klien CIMD melebihi batas ${maxBytes} byte.`,
          };
        }
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return {
          ok: false,
          code: "FETCH_TIMEOUT",
          message: "Pembacaan dokumen metadata klien CIMD melewati batas waktu.",
        };
      }
      return {
        ok: false,
        code: "FETCH_FAILED",
        message: "Gagal membaca isi dokumen metadata klien CIMD.",
      };
    }
  } finally {
    clearTimeout(timer);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return {
      ok: false,
      code: "INVALID_METADATA_DOCUMENT",
      message: "Dokumen metadata klien CIMD bukan JSON yang valid.",
    };
  }

  const validated = CimdMetadataDocumentSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      code: "INVALID_METADATA_DOCUMENT",
      message: "Struktur dokumen metadata klien CIMD tidak valid.",
    };
  }

  if (validated.data.client_id !== urlCheck.url) {
    return {
      ok: false,
      code: "CLIENT_ID_MISMATCH",
      message: "Nilai client_id di dalam dokumen CIMD tidak cocok dengan URL permintaan.",
    };
  }

  for (const uri of validated.data.redirect_uris) {
    const uriCheck = validateOAuthRedirectUri(uri);
    if (!uriCheck.ok) {
      return {
        ok: false,
        code: "INVALID_METADATA_DOCUMENT",
        message: `redirect_uri dalam dokumen CIMD tidak valid: ${uriCheck.reason}`,
      };
    }
  }

  return { ok: true, document: validated.data };
}
