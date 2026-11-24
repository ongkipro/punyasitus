/**
 * Comprehensive SSRF Guard for Outbound CRM / Google Sheets HTTPS Webhooks
 * (`REQ-101`, `TASK-101`).
 *
 * Strictly enforces:
 * - HTTPS scheme ONLY (`https://`), zero embedded credentials, zero backslashes/control chars
 * - Standard HTTPS ports ONLY (default 443, explicit 443, or 8443)
 * - Blocks localhost, single-label internal hostnames, `.local`/`.internal`/`.lan`/`.arpa`/metadata hosts
 * - Blocks ALL private, loopback, link-local, CGNAT, multicast, broadcast, documentation,
 *   and reserved IPv4 ranges (including decimal/hex/octal/short IPv4 encodings)
 * - Blocks ALL loopback, unspecified, ULA (`fc00::/7`), link-local (`fe80::/10`), site-local,
 *   multicast, documentation, IPv4-mapped (`::ffff:*`), IPv4-compatible, NAT64, 6to4, and Teredo IPv6 forms
 * - Re-applied on EVERY redirect hop (`redirect: "manual"`).
 */

export const MAX_WEBHOOK_URL_LENGTH = 2048 as const;

const ALLOWED_HTTPS_PORTS = new Set(["", "443", "8443"]);

const BLOCKED_EXACT_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default.svc",
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
  ".svc.cluster.local",
  ".nip.io",
  ".sslip.io",
  ".xip.io",
  ".localtest.me",
  ".lvh.me",
] as const;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses standard dotted-quad IPv4 OR single/short integer/hex/octal IPv4 forms
 * into a 32-bit unsigned integer, or returns `null` if not an IPv4 literal.
 */
export function parseIpv4ToUint32(rawHost: string): number | null {
  const host = rawHost.trim().toLowerCase();
  if (!host) return null;

  // Reject anything containing non-IPv4 chars
  if (!/^[0-9a-fx.]+$/.test(host)) return null;

  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let val: number;
    if (/^0x[0-9a-f]+$/.test(part)) {
      val = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      val = Number.parseInt(part, 8);
    } else if (/^(?:0|[1-9][0-9]*)$/.test(part)) {
      val = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isSafeInteger(val) || val < 0) return null;
    nums.push(val);
  }

  if (nums.length === 1) {
    const n = nums[0]!;
    return n <= 0xffffffff ? n >>> 0 : null;
  }
  if (nums.length === 2) {
    const [a, b] = nums as [number, number];
    if (a > 0xff || b > 0xffffff) return null;
    return (((a << 24) >>> 0) + b) >>> 0;
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [number, number, number];
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return (((a << 24) >>> 0) + ((b << 16) >>> 0) + c) >>> 0;
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
  return ((((a << 24) >>> 0) | (b << 16) | (c << 8) | d) >>> 0);
}

export function isBlockedIpv4Uint32(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;

  // 0.0.0.0/8 (unspecified / "this network")
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC 6598 CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments) & 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.168.0.0/16 (RFC 1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved + 255.255.255.255 Broadcast)
  if (a >= 224) return true;

  return false;
}

export function isPrivateOrReservedIpv4(host: string): boolean {
  const uint = parseIpv4ToUint32(host);
  if (uint === null) return false;
  return isBlockedIpv4Uint32(uint);
}

/**
 * Expands an IPv6 literal (with or without brackets, compressed `::`, or trailing IPv4)
 * into 8 16-bit unsigned words, or returns `null` if not a valid IPv6 literal.
 */
export function parseIpv6ToWords(rawHost: string): readonly number[] | null {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host.includes(":")) return null;
  // Zone identifiers (`%eth0`, `%25eth0`) are never valid public webhook hosts
  if (host.includes("%")) return null;

  // Handle trailing dotted IPv4 inside IPv6 (e.g. `::ffff:127.0.0.1`)
  const lastColon = host.lastIndexOf(":");
  const tail = host.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4 = parseIpv4ToUint32(tail);
    if (ipv4 === null) return null;
    const hi = ((ipv4 >>> 16) & 0xffff).toString(16);
    const lo = (ipv4 & 0xffff).toString(16);
    host = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (segment: string): number[] | null => {
    if (segment === "") return [];
    const items = segment.split(":");
    const out: number[] = [];
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(Number.parseInt(item, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const words = parseSegmentList(doubleColonParts[0]!);
    return words && words.length === 8 ? words : null;
  }

  const left = parseSegmentList(doubleColonParts[0]!);
  const right = parseSegmentList(doubleColonParts[1]!);
  if (!left || !right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

export function isPrivateOrReservedIpv6(rawHost: string): boolean {
  const words = parseIpv6ToWords(rawHost);
  if (!words) return false;

  const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::/128 (unspecified) and ::1/128 (loopback)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) {
    return true;
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6 — block ALL IPv4-mapped forms to eliminate SSRF bypasses)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return true;
  }

  // ::ffff:0:0:0/96 (IPv4-translated)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) {
    return true;
  }

  // ::/96 (deprecated IPv4-compatible IPv6)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return true;
  }

  // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64)
  if (w0 === 0x0064 && w1 === 0xff9b) {
    return true;
  }

  // 100::/64 (Discard-only)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
    return true;
  }

  // 2001::/32 (Teredo) & 2001:db8::/32 (Documentation)
  if (w0 === 0x2001 && (w1 === 0x0000 || w1 === 0x0db8)) {
    return true;
  }

  // 2002::/16 (6to4 — can embed private IPv4)
  if (w0 === 0x2002) {
    return true;
  }

  // fc00::/7 (Unique Local Address fc00:: - fdff::)
  if ((w0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (Link-local fe80:: - febf::)
  if ((w0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // fec0::/10 (Deprecated site-local)
  if ((w0 & 0xffc0) === 0xfec0) {
    return true;
  }

  // ff00::/8 (Multicast)
  if ((w0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export type WebhookUrlRejectionCode =
  | "EMPTY_URL"
  | "URL_TOO_LONG"
  | "INVALID_URL"
  | "HTTPS_REQUIRED"
  | "EMBEDDED_CREDENTIALS_FORBIDDEN"
  | "DISALLOWED_PORT"
  | "SSRF_HOST_BLOCKED"
  | "SSRF_IP_BLOCKED";

export type WebhookUrlValidationResult =
  | { readonly ok: true; readonly normalizedUrl: string; readonly hostname: string }
  | { readonly ok: false; readonly code: WebhookUrlRejectionCode; readonly message: string };

/**
 * Validates that a webhook destination URL is strictly HTTPS, public, credential-free,
 * and not targeting any loopback, private, link-local, metadata, or internal address.
 */
export function validateWebhookTargetUrl(rawUrl: unknown): WebhookUrlValidationResult {
  if (typeof rawUrl !== "string") {
    return { ok: false, code: "EMPTY_URL", message: "URL webhook wajib diisi." };
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, code: "EMPTY_URL", message: "URL webhook wajib diisi." };
  }
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
    return {
      ok: false,
      code: "URL_TOO_LONG",
      message: `URL webhook melebihi batas ${MAX_WEBHOOK_URL_LENGTH} karakter.`,
    };
  }
  if (hasControlChars(trimmed)) {
    return { ok: false, code: "INVALID_URL", message: "URL webhook mengandung karakter tidak valid." };
  }

  if (!/^https:\/\//i.test(trimmed)) {
    return {
      ok: false,
      code: "HTTPS_REQUIRED",
      message: "URL webhook wajib menggunakan protokol HTTPS (https://).",
    };
  }

  // Inspect raw authority before URL normalization catches backslashes or userinfo
  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (rawAuthority.includes("@")) {
    return {
      ok: false,
      code: "EMBEDDED_CREDENTIALS_FORBIDDEN",
      message: "URL webhook tidak boleh mengandung kredensial (username/password).",
    };
  }
  if (rawAuthority.includes("\\")) {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "URL webhook mengandung karakter authority yang tidak valid.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "INVALID_URL", message: "Format URL webhook tidak valid." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "HTTPS_REQUIRED",
      message: "URL webhook wajib menggunakan protokol HTTPS.",
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "EMBEDDED_CREDENTIALS_FORBIDDEN",
      message: "URL webhook tidak boleh mengandung kredensial.",
    };
  }

  if (!ALLOWED_HTTPS_PORTS.has(parsed.port)) {
    return {
      ok: false,
      code: "DISALLOWED_PORT",
      message: "Port URL webhook tidak diizinkan (gunakan port HTTPS standar 443 atau 8443).",
    };
  }

  // Normalize hostname (strip trailing dot for FQDN bypass attempts like `localhost.`)
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
  if (!host) {
    return { ok: false, code: "INVALID_URL", message: "Hostname URL webhook kosong." };
  }

  // Reject IPv6 zone IDs or bracketed forms with `%`
  if (host.includes("%")) {
    return {
      ok: false,
      code: "SSRF_IP_BLOCKED",
      message: "Alamat IPv6 dengan zone identifier diblokir demi keamanan SSRF.",
    };
  }

  // Check IPv6 literal first (`[...]` or contains `:`)
  if (host.startsWith("[") || host.includes(":")) {
    const words = parseIpv6ToWords(host);
    if (!words || isPrivateOrReservedIpv6(host)) {
      return {
        ok: false,
        code: "SSRF_IP_BLOCKED",
        message: "Alamat IPv6 privat, loopback, link-local, atau IPv4-mapped diblokir demi keamanan SSRF.",
      };
    }
    return { ok: true, normalizedUrl: parsed.toString(), hostname: host };
  }

  // Check IPv4 literal (including normalized decimal/hex/octal forms)
  const ipv4Uint = parseIpv4ToUint32(host);
  if (ipv4Uint !== null) {
    if (isBlockedIpv4Uint32(ipv4Uint)) {
      return {
        ok: false,
        code: "SSRF_IP_BLOCKED",
        message: "Alamat IP privat, loopback, atau metadata jaringan internal diblokir demi keamanan SSRF.",
      };
    }
    return { ok: true, normalizedUrl: parsed.toString(), hostname: host };
  }

  // Check hostname blocklist & suffixes
  if (
    BLOCKED_EXACT_HOSTNAMES.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return {
      ok: false,
      code: "SSRF_HOST_BLOCKED",
      message: "Hostname lokal atau internal diblokir demi keamanan SSRF.",
    };
  }

  // Require public multi-label DNS hostname (reject bare single-label internal service names like `https://redis/hook`)
  if (!host.includes(".") || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    return {
      ok: false,
      code: "SSRF_HOST_BLOCKED",
      message: "URL webhook harus mengarah ke domain publik yang valid.",
    };
  }

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    hostname: host,
  };
}
