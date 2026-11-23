import { PLATFORM_HOSTS } from "../index.ts";
import {
  isIndexableTenantStatus,
  normalizePublicPath,
  validateCanonicalHostname,
  type SeoHostKind,
  type SeoHostStatus,
  type SeoTenantStatus,
  type SiteVisibility,
} from "./index.ts";
import { isSpeculativeLlmsTxtPath } from "./robots.ts";

/**
 * Verified Custom-Domain `IndexNow` Key & Deduplicated Submission Engine
 * (REQ-095, PLAN §19.6, DESIGN §9, TASK-095).
 *
 * Hard Invariants:
 * - Strictly active ONLY for paid (`active`, `grace`, `locked`, no `operatorHold`) tenants
 *   serving on an active, SSL-verified **custom domain** (`hostKind === "custom"`).
 * - Strictly SKIPPED on `*.situsku.click` trial/subdomains, unverified domains, `noindex` sites,
 *   and `suspended` / `recovery` / `purged` tenants.
 * - Tenant-scoped cryptographic 32-hex key (valid 32–128 char alphanumeric/hyphen key).
 * - URL normalization strips tracking params, rejects cross-origin/private/faceted/llms.txt URLs,
 *   deduplicates preserving order, and batches within IndexNow limits (`<= 10,000` URLs/POST).
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow" as const;
export const INDEXNOW_KEY_MIN_LENGTH = 32 as const;
export const INDEXNOW_KEY_MAX_LENGTH = 128 as const;
export const INDEXNOW_KEY_HEX_LENGTH = 32 as const;
export const INDEXNOW_MAX_URLS_PER_REQUEST = 10_000 as const;
export const INDEXNOW_DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000;

const INDEXNOW_KEY_RE = /^[a-zA-Z0-9-]{32,128}$/;

const PRIVATE_URL_PREFIXES = [
  "/api",
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/preview",
  "/admin",
  "/_astro",
] as const;

const TRACKING_QUERY_KEYS = new Set<string>([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "yclid",
  "dclid",
  "ref",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "si",
]);

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generates a cryptographic 32-character lowercase hex IndexNow verification key
 * (128 bits of entropy via Web Crypto `crypto.getRandomValues`).
 */
export function generateIndexNowKey(randomBytes?: Uint8Array): string {
  const bytes = randomBytes
    ? randomBytes.slice(0, 16)
    : (() => {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        return buf;
      })();

  if (bytes.length < 16) {
    throw new RangeError("IndexNow key requires at least 16 random bytes (32 hex chars).");
  }

  return bytesToHex(bytes);
}

/**
 * Strictly validates an IndexNow key (32–128 ASCII alphanumeric/hyphen chars,
 * zero slashes, dots, whitespace, or control characters).
 */
export function isValidIndexNowKey(rawKey: unknown): rawKey is string {
  if (typeof rawKey !== "string") return false;
  return INDEXNOW_KEY_RE.test(rawKey);
}

/**
 * Constant-time string comparison for verifying `/<key>.txt` path parameters
 * against the tenant's stored `indexnow_key`.
 */
export function constantTimeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export type IndexNowSkipReason =
  | "trial_or_subdomain_host"
  | "non_indexable_tenant_status"
  | "site_noindex"
  | "seo_autopilot_disabled"
  | "custom_domain_not_verified"
  | "invalid_host";

export interface IndexNowTenantEligibilityInput {
  readonly tenantStatus: SeoTenantStatus;
  readonly operatorHold?: boolean;
  readonly primaryHost?: string | null;
  readonly primaryHostKind?: SeoHostKind | null;
  readonly primaryHostStatus?: SeoHostStatus | null;
  readonly primaryHostSslStatus?: string | null;
  readonly primaryHostVerified?: boolean;
  readonly siteVisibility?: SiteVisibility | null;
  readonly seoAutopilotEnabled?: boolean;
  readonly saasZone?: string;
}

export type IndexNowEligibilityDecision =
  | {
      readonly eligible: true;
      readonly host: string;
      readonly origin: string;
    }
  | {
      readonly eligible: false;
      readonly reason: IndexNowSkipReason;
    };

/**
 * Evaluates whether a tenant is eligible to serve `/<key>.txt` and submit
 * `IndexNow` notifications.
 *
 * Strictly requires:
 * - Indexable paid tenant status (`active`, `grace`, `locked`) with no `operatorHold`
 * - `siteVisibility !== "noindex"` and `seoAutopilotEnabled !== false`
 * - An active, SSL-active, explicitly verified **custom domain** (NEVER `*.situsku.click`)
 */
export function evaluateIndexNowEligibility(
  input: IndexNowTenantEligibilityInput,
): IndexNowEligibilityDecision {
  if (!isIndexableTenantStatus(input.tenantStatus, input.operatorHold)) {
    return { eligible: false, reason: "non_indexable_tenant_status" };
  }
  if (input.siteVisibility === "noindex") {
    return { eligible: false, reason: "site_noindex" };
  }
  if (input.seoAutopilotEnabled === false) {
    return { eligible: false, reason: "seo_autopilot_disabled" };
  }

  const rawHost = input.primaryHost?.trim() ?? "";
  if (!rawHost) {
    return { eligible: false, reason: "trial_or_subdomain_host" };
  }

  let host: string;
  try {
    host = validateCanonicalHostname(rawHost);
  } catch {
    return { eligible: false, reason: "invalid_host" };
  }

  const saasZone = (input.saasZone ?? PLATFORM_HOSTS.saasZone).trim().toLowerCase();
  if (
    input.primaryHostKind !== "custom" ||
    host === saasZone ||
    host.endsWith(`.${saasZone}`)
  ) {
    return { eligible: false, reason: "trial_or_subdomain_host" };
  }

  if (
    input.primaryHostStatus !== "active" ||
    input.primaryHostSslStatus !== "active" ||
    input.primaryHostVerified !== true
  ) {
    return { eligible: false, reason: "custom_domain_not_verified" };
  }

  return {
    eligible: true,
    host,
    origin: `https://${host}`,
  };
}

/**
 * Builds the canonical verification file URL `https://<host>/<key>.txt`.
 */
export function buildIndexNowKeyLocation(host: string, key: string): string {
  const cleanHost = validateCanonicalHostname(host);
  if (!isValidIndexNowKey(key)) {
    throw new RangeError("INVALID_INDEXNOW_KEY: key must be 32-128 ASCII alphanumeric/hyphen chars.");
  }
  return `https://${cleanHost}/${key}.txt`;
}

function isPrivateOrDisallowedPath(normalizedPath: string): boolean {
  const lower = normalizedPath.toLowerCase();
  if (isSpeculativeLlmsTxtPath(lower)) {
    return true;
  }
  for (const prefix of PRIVATE_URL_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes, filters, and deduplicates changed tenant URLs for an IndexNow submission:
 * - Accepts root-relative paths (`/blog/artikel-1`) or `https://<host>/...` URLs.
 * - Drops foreign hosts, `http://` URLs, private/admin/preview paths, multi-parameter
 *   faceted filter URLs on `/kendaraan` & `/produk`, and speculative `llms.txt`.
 * - Strips tracking params (`utm_*`, `fbclid`, `gclid`, etc.) and fragments.
 * - Deduplicates preserving first-seen order, capped at `maxUrls` (default 10,000).
 */
export function normalizeAndDeduplicateIndexNowUrls(
  verifiedHost: string,
  rawUrls: readonly string[],
  options?: { readonly maxUrls?: number },
): readonly string[] {
  const cleanHost = validateCanonicalHostname(verifiedHost);
  const origin = `https://${cleanHost}`;
  const maxUrls = Math.max(
    1,
    Math.min(INDEXNOW_MAX_URLS_PER_REQUEST, Math.floor(options?.maxUrls ?? INDEXNOW_MAX_URLS_PER_REQUEST)),
  );

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of rawUrls) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let parsed: URL;
    try {
      if (trimmed.startsWith("/")) {
        parsed = new URL(trimmed, origin);
      } else if (/^https:\/\//i.test(trimmed)) {
        parsed = new URL(trimmed);
      } else {
        continue;
      }
    } catch {
      continue;
    }

    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.hostname.toLowerCase() !== cleanHost
    ) {
      continue;
    }

    let normalizedPath: string;
    try {
      normalizedPath = normalizePublicPath(parsed.pathname).normalizedPath;
    } catch {
      continue;
    }

    if (isPrivateOrDisallowedPath(normalizedPath)) {
      continue;
    }

    // Filter tracking query params; reject multi-param faceted filter queries on /kendaraan & /produk
    const keptParams: Array<[string, string]> = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      const lowerKey = k.toLowerCase();
      if (lowerKey.startsWith("utm_") || TRACKING_QUERY_KEYS.has(lowerKey)) {
        continue;
      }
      keptParams.push([k, v]);
    }

    if (
      (normalizedPath === "/kendaraan" || normalizedPath === "/produk") &&
      keptParams.length >= 2
    ) {
      continue;
    }

    const search =
      keptParams.length > 0
        ? `?${new URLSearchParams(keptParams).toString()}`
        : "";
    const finalUrl = `${origin}${normalizedPath}${search}`;

    if (seen.has(finalUrl)) continue;
    seen.add(finalUrl);
    out.push(finalUrl);
    if (out.length >= maxUrls) break;
  }

  return out;
}

export interface IndexNowSubmissionPayload {
  readonly host: string;
  readonly key: string;
  readonly keyLocation: string;
  readonly urlList: readonly string[];
}

/**
 * Constructs a strict IndexNow batch JSON submission payload.
 */
export function buildIndexNowSubmissionPayload(input: {
  readonly host: string;
  readonly key: string;
  readonly urls: readonly string[];
}): IndexNowSubmissionPayload {
  const host = validateCanonicalHostname(input.host);
  if (!isValidIndexNowKey(input.key)) {
    throw new RangeError("INVALID_INDEXNOW_KEY: key must be 32-128 ASCII alphanumeric/hyphen chars.");
  }
  const urlList = normalizeAndDeduplicateIndexNowUrls(host, input.urls);
  return {
    host,
    key: input.key,
    keyLocation: buildIndexNowKeyLocation(host, input.key),
    urlList,
  };
}

/**
 * Computes a deterministic SHA-256 idempotency key for an IndexNow ping batch
 * over sorted deduplicated URLs within a time/dedup bucket.
 */
export async function buildIndexNowBatchIdempotencyKey(params: {
  readonly tenantId: string;
  readonly host: string;
  readonly urls: readonly string[];
  readonly dedupBucket?: string;
  readonly nowMs?: number;
  readonly windowMs?: number;
}): Promise<string> {
  const cleanTenant = params.tenantId.trim();
  const cleanHost = validateCanonicalHostname(params.host);
  const sortedUrls = [...normalizeAndDeduplicateIndexNowUrls(cleanHost, params.urls)].sort();
  const windowMs = Math.max(1_000, Math.floor(params.windowMs ?? INDEXNOW_DEFAULT_DEDUP_WINDOW_MS));
  const bucket =
    params.dedupBucket?.trim() ||
    String(Math.floor((params.nowMs ?? Date.now()) / windowMs));

  const digestInput = `${cleanTenant}|${cleanHost}|${bucket}|${sortedUrls.join("\n")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestInput));
  const hashPrefix = bytesToHex(new Uint8Array(digest)).slice(0, 24);
  return `seo:indexnow:${cleanTenant}:${bucket}:${hashPrefix}`;
}

export type IndexNowSubmissionResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly submittedCount: number;
      readonly host: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly retryable: boolean;
      readonly code: string;
      readonly message: string;
    };

export interface SubmitIndexNowOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

/**
 * Submits ONE deduplicated batch POST to `https://api.indexnow.org/indexnow`
 * using an injectable `fetch` implementation.
 */
export async function submitIndexNowBatch(
  payload: IndexNowSubmissionPayload,
  options?: SubmitIndexNowOptions,
): Promise<IndexNowSubmissionResult> {
  if (payload.urlList.length === 0) {
    return {
      ok: false,
      status: 422,
      retryable: false,
      code: "INDEXNOW_EMPTY_URL_LIST",
      message: "Tidak ada URL publik valid untuk dikirim ke IndexNow.",
    };
  }

  const endpoint = options?.endpoint ?? INDEXNOW_ENDPOINT;
  const fetchFn = options?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/plain",
      },
      body: JSON.stringify({
        host: payload.host,
        key: payload.key,
        keyLocation: payload.keyLocation,
        urlList: payload.urlList,
      }),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      retryable: true,
      code: "INDEXNOW_NETWORK_ERROR",
      message: "Gagal menghubungi endpoint IndexNow.",
    };
  }

  if (response.status === 200 || response.status === 202) {
    return {
      ok: true,
      status: response.status,
      submittedCount: payload.urlList.length,
      host: payload.host,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      ok: false,
      status: response.status,
      retryable: true,
      code: `INDEXNOW_HTTP_${response.status}`,
      message: `IndexNow mengembalikan status sementara (${response.status}).`,
    };
  }

  return {
    ok: false,
    status: response.status,
    retryable: false,
    code: `INDEXNOW_HTTP_${response.status}`,
    message: `IndexNow menolak permintaan (${response.status}).`,
  };
}
