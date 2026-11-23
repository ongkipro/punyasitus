import {
  AFFILIATE_COOKIE_FUTURE_SKEW_SECONDS,
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_TTL_SECONDS,
  AFFILIATE_COOKIE_VERSION,
  type AffiliateCookieVerificationResult,
} from "./types.ts";
import { normalizeAffiliateReferralCode } from "./validation.ts";

/**
 * First-party HMAC-SHA256 signed referral attribution cookie (`ps_ref`) with strict
 * server-side 30-day TTL enforcement and zero visitor PII (`packages/core/src/affiliates/cookie.ts`;
 * REQ-084, PLAN §19.4, TASK-084).
 *
 * Cookie value format:
 *   `v1.<REFERRAL_CODE>.<ISSUED_AT_UNIX_SEC>.<SOURCE_TAG>.<HMAC_SHA256_BASE64URL>`
 *   where `<SOURCE_TAG>` is `"c"` (standard marketing `?ref=`) or `"f"` (tenant footer badge `?ref=`).
 */

const SOURCE_TAG_TO_NAME: Readonly<Record<string, "cookie" | "footer_badge">> = {
  c: "cookie",
  f: "footer_badge",
};

const SOURCE_NAME_TO_TAG: Readonly<Record<"cookie" | "footer_badge", string>> = {
  cookie: "c",
  footer_badge: "f",
};

const ISSUED_SEC_RE = /^\d{9,12}$/;
const SAFE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function computeCookieSignature(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`ps:affiliate_ref_cookie:v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return bytesToBase64Url(new Uint8Array(sigBuffer));
}

/**
 * Extracts and validates `?ref=<code>` (and optional `src=footer_badge`) from a URL search params.
 * Returns `null` if missing or invalid format.
 */
export function parseAffiliateReferralQueryParam(
  searchParams: URLSearchParams,
): {
  readonly referralCode: string;
  readonly source: "cookie" | "footer_badge";
} | null {
  const rawRef = searchParams.get("ref");
  const normalizedCode = normalizeAffiliateReferralCode(rawRef);
  if (!normalizedCode) {
    return null;
  }
  const rawSrc = (searchParams.get("src") ?? "").trim().toLowerCase();
  const source: "cookie" | "footer_badge" =
    rawSrc === "footer" || rawSrc === "footer_badge" || rawSrc === "badge"
      ? "footer_badge"
      : "cookie";

  return { referralCode: normalizedCode, source };
}

/**
 * Creates an HMAC-SHA256 signed `ps_ref` cookie value containing zero visitor PII.
 */
export async function createSignedAffiliateCookieValue(params: {
  readonly referralCode: string;
  readonly secret: string;
  readonly source?: "cookie" | "footer_badge";
  readonly nowMs?: number;
}): Promise<string> {
  const normalizedCode = normalizeAffiliateReferralCode(params.referralCode);
  if (!normalizedCode) {
    throw new Error("INVALID_REFERRAL_CODE");
  }
  const cleanSecret = params.secret.trim();
  if (cleanSecret.length < 16) {
    throw new Error("INVALID_AFFILIATE_COOKIE_SECRET");
  }
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const issuedAtSec = Math.floor(nowMs / 1000);
  const sourceTag = SOURCE_NAME_TO_TAG[params.source ?? "cookie"];
  const payload = `${AFFILIATE_COOKIE_VERSION}.${normalizedCode}.${issuedAtSec}.${sourceTag}`;
  const signature = await computeCookieSignature(payload, cleanSecret);
  return `${payload}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed `ps_ref` cookie value and enforces the strict
 * server-side 30-day (`2,592,000`s) attribution TTL regardless of browser `Max-Age`.
 */
export async function verifySignedAffiliateCookieValue(params: {
  readonly value: string | null | undefined;
  readonly secret: string;
  readonly nowMs?: number;
}): Promise<AffiliateCookieVerificationResult> {
  if (typeof params.value !== "string" || !params.value.trim()) {
    return { valid: false, reason: "missing" };
  }
  const cleanSecret = params.secret.trim();
  if (cleanSecret.length < 16) {
    return { valid: false, reason: "invalid_signature" };
  }

  const trimmed = params.value.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 5) {
    return { valid: false, reason: "malformed" };
  }

  const [version, rawCode, rawIssuedSec, rawSourceTag, providedSig] = parts;
  if (version !== AFFILIATE_COOKIE_VERSION || !rawCode || !rawIssuedSec || !rawSourceTag || !providedSig) {
    return { valid: false, reason: "malformed" };
  }

  const normalizedCode = normalizeAffiliateReferralCode(rawCode);
  if (!normalizedCode || normalizedCode !== rawCode) {
    return { valid: false, reason: "invalid_code" };
  }

  if (!ISSUED_SEC_RE.test(rawIssuedSec)) {
    return { valid: false, reason: "malformed" };
  }
  const issuedAtSec = Number(rawIssuedSec);
  if (!Number.isSafeInteger(issuedAtSec) || issuedAtSec <= 0) {
    return { valid: false, reason: "malformed" };
  }

  const source = SOURCE_TAG_TO_NAME[rawSourceTag];
  if (!source) {
    return { valid: false, reason: "malformed" };
  }

  const payload = `${version}.${normalizedCode}.${issuedAtSec}.${rawSourceTag}`;
  const expectedSig = await computeCookieSignature(payload, cleanSecret);
  if (!constantTimeEqualStrings(providedSig, expectedSig)) {
    return { valid: false, reason: "invalid_signature" };
  }

  const nowSec = Math.floor(Math.trunc(params.nowMs ?? Date.now()) / 1000);
  if (issuedAtSec > nowSec + AFFILIATE_COOKIE_FUTURE_SKEW_SECONDS) {
    return { valid: false, reason: "future_timestamp" };
  }
  if (nowSec - issuedAtSec > AFFILIATE_COOKIE_TTL_SECONDS) {
    return { valid: false, reason: "expired" };
  }

  return {
    valid: true,
    referralCode: normalizedCode,
    issuedAtSec,
    issuedAtMs: issuedAtSec * 1000,
    source,
  };
}

/**
 * Extracts a single named cookie value from a raw HTTP `Cookie` header.
 */
export function extractCookieValueFromHeader(
  cookieHeader: string | null | undefined,
  cookieName: string = AFFILIATE_COOKIE_NAME,
): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) continue;
    const name = pair.slice(0, eqIndex).trim();
    if (name === cookieName) {
      const val = pair.slice(eqIndex + 1).trim();
      if (!val) return null;
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

/**
 * Reads and verifies the `ps_ref` cookie from an HTTP `Cookie` header.
 */
export async function readVerifiedAffiliateCookieFromHeader(params: {
  readonly cookieHeader: string | null | undefined;
  readonly secret: string;
  readonly cookieName?: string;
  readonly nowMs?: number;
}): Promise<AffiliateCookieVerificationResult> {
  const rawValue = extractCookieValueFromHeader(
    params.cookieHeader,
    params.cookieName ?? AFFILIATE_COOKIE_NAME,
  );
  if (!rawValue) {
    return { valid: false, reason: "missing" };
  }
  return verifySignedAffiliateCookieValue({
    value: rawValue,
    secret: params.secret,
    nowMs: params.nowMs,
  });
}

/**
 * Builds the `Set-Cookie` header for the first-party 30-day `ps_ref` attribution cookie.
 *
 * - On `punyasitus.com`: sets `Domain=punyasitus.com; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
 *   so `app.punyasitus.com` signup reads it cleanly while keeping it strictly first-party.
 * - On local loopback (`http://127.0.0.1` / `localhost`): omits `Domain=` and sets `Secure` only if `secure: true`.
 */
export function buildAffiliateSetCookieHeader(params: {
  readonly value: string;
  readonly cookieName?: string;
  readonly domain?: string | null;
  readonly secure?: boolean;
  readonly maxAgeSeconds?: number;
}): string {
  const name = params.cookieName ?? AFFILIATE_COOKIE_NAME;
  const maxAge = Math.max(0, Math.trunc(params.maxAgeSeconds ?? AFFILIATE_COOKIE_TTL_SECONDS));
  const attrs: string[] = [
    `${name}=${params.value}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  const cleanDomain = params.domain?.trim().toLowerCase().replace(/^\.+/, "") ?? "";
  if (cleanDomain && SAFE_DOMAIN_RE.test(cleanDomain)) {
    attrs.push(`Domain=${cleanDomain}`);
  }

  if (params.secure !== false) {
    attrs.push("Secure");
  }

  return attrs.join("; ");
}
