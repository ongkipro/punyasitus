import { readBoundedStream } from "@punyasitus/core/media/index";
import {
  WP_IMPORTER_LIMITS,
  WpImporterError,
  type WpImporterFetchPort,
} from "./types.ts";

/**
 * Strict SSRF URL Validator & Redirect-Guarded Fetcher for `wp-importer`
 * (`TASK-100`, `REQ-100`).
 *
 * Security invariants:
 * - Blocks ALL private, loopback, link-local, metadata, CGNAT, multicast, broadcast,
 *   reserved, ULA, unspecified, and IPv4-mapped/translated IPv6 targets.
 * - Inspects BOTH raw authority text (catching decimal `2130706433`, hex `0x7f000001`,
 *   octal `0177.0.0.1`, shorthand `127.1`) AND canonicalized `URL.hostname`.
 * - Rejects embedded credentials (`user:pass@host`), non-standard ports, single-label
 *   hostnames (`metadata`, `redis`), `.local`, `.internal`, `.localhost`, `.home.arpa`.
 * - Follows redirects ONLY via `redirect: "manual"`, re-validating EVERY hop against
 *   the exact same SSRF guard with a strict hop cap (`maxRedirects = 3`).
 * - Enforces hard streaming response byte ceiling (`readBoundedStream`) and timeout.
 */

export interface SsrfValidationOptions {
  readonly allowHttp?: boolean;
  readonly allowedPorts?: ReadonlySet<string>;
}

export interface ValidatedSsrfUrl {
  readonly url: URL;
  readonly normalizedHref: string;
  readonly hostname: string;
}

const DEFAULT_HTTPS_PORTS = new Set(["", "443"]);
const DEFAULT_HTTP_AND_HTTPS_PORTS = new Set(["", "80", "443"]);

const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
]);

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".corp",
  ".lan",
  ".intranet",
  ".nip.io",
  ".sslip.io",
  ".xip.io",
  ".localtest.me",
  ".lvh.me",
] as const;

function hasControlOrSpaceChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses a single IPv4 part in decimal, octal (`0177`), or hex (`0x7f`) notation.
 * Returns null if the token is not a valid numeric IPv4 component.
 */
function parseFlexibleIpv4Part(part: string): number | null {
  if (!part || part.length > 16) return null;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    const v = Number.parseInt(part.slice(2), 16);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  if (/^0[0-7]+$/.test(part)) {
    const v = Number.parseInt(part, 8);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  if (/^\d+$/.test(part)) {
    const v = Number.parseInt(part, 10);
    return Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff ? v : null;
  }
  return null;
}

/**
 * Parses standard dotted-quad IPv4 (`127.0.0.1`) as well as legacy POSIX/WHATWG
 * numeric forms (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `10.1`).
 * Returns a 32-bit unsigned integer or `null` if the host is not an IPv4 literal.
 */
export function parseIpv4ToUint32(rawHost: string): number | null {
  const host = rawHost.trim().replace(/\.+$/, "");
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    const parsed = parseFlexibleIpv4Part(part);
    if (parsed === null) return null;
    nums.push(parsed);
  }

  if (nums.length === 1) {
    return nums[0]! >>> 0;
  }
  if (nums.length === 2) {
    const [a, b] = nums as [number, number];
    if (a > 0xff || b > 0xffffff) return null;
    return (((a << 24) >>> 0) | b) >>> 0;
  }
  if (nums.length === 3) {
    const [a, b, c] = nums as [number, number, number];
    if (a > 0xff || b > 0xff || c > 0xffff) return null;
    return (((a << 24) >>> 0) | (b << 16) | c) >>> 0;
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  if (a > 0xff || b > 0xff || c > 0xff || d > 0xff) return null;
  return (((a << 24) >>> 0) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * Checks whether a 32-bit unsigned IPv4 address belongs to ANY private, loopback,
 * link-local, metadata, CGNAT, multicast, broadcast, documentation, or reserved range.
 */
export function isPrivateOrReservedIpv4(ip: number): boolean {
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;

  if (a === 0) return true; // 0.0.0.0/8 (this network / unspecified)
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (RFC 6598 CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Parses an IPv6 literal (with or without `[...]`, optional zone `%...`, `::` compression,
 * and optional dotted-quad IPv4 tail like `::ffff:127.0.0.1`) into 8 x 16-bit groups.
 */
export function parseIpv6ToGroups(rawHost: string): readonly number[] | null {
  const cleaned = rawHost
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  if (!cleaned.includes(":")) return null;

  let work = cleaned;
  let ipv4TailGroups: number[] = [];
  const colonIdx = work.lastIndexOf(":");
  if (colonIdx !== -1 && work.slice(colonIdx + 1).includes(".")) {
    const v4 = parseIpv4ToUint32(work.slice(colonIdx + 1));
    if (v4 === null) return null;
    ipv4TailGroups = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    const before = work.slice(0, colonIdx);
    work = before === ":" ? "::" : before.endsWith(":") ? `${before}:` : before;
  }

  const doubleColonParts = work.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseHexPart = (segment: string): number[] | null => {
    if (!segment) return [];
    const pieces = segment.split(":");
    const out: number[] = [];
    for (const p of pieces) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseHexPart(doubleColonParts[0]!);
    if (!groups) return null;
    const all = [...groups, ...ipv4TailGroups];
    return all.length === 8 ? all : null;
  }

  const left = parseHexPart(doubleColonParts[0]!);
  const right = parseHexPart(doubleColonParts[1]!);
  if (!left || !right) return null;

  const totalExplicit = left.length + right.length + ipv4TailGroups.length;
  if (totalExplicit > 7) return null;

  const missingZeros = 8 - totalExplicit;
  return [...left, ...new Array<number>(missingZeros).fill(0), ...right, ...ipv4TailGroups];
}

/**
 * Checks whether an 8-group IPv6 address is loopback, unspecified, ULA, link-local,
 * site-local, multicast, documentation, IPv4-mapped/translated, NAT64, 6to4, or Teredo.
 */
export function isPrivateOrReservedIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const allZeroPrefix6 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // Unspecified :: and loopback ::1
  if (allZeroPrefix6 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-compatible ::w.x.y.z
  if (allZeroPrefix6 && g5 === 0) return true;
  // IPv4-mapped ::ffff:0:0/96 (both private AND all mapped forms blocked for defense-in-depth)
  if (allZeroPrefix6 && g5 === 0xffff) return true;
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
  // Discard 100::/64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b) return true;
  // Teredo 2001::/32 & Documentation 2001:db8::/32 & Benchmarking 2001:2::/48
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8 || (g1 === 0x0002 && g2 === 0))) {
    return true;
  }
  // 6to4 2002::/16 (check embedded IPv4 — block if private or altogether for safety)
  if (g0 === 0x2002) {
    const embeddedV4 = (((g1 << 16) >>> 0) | g2) >>> 0;
    if (isPrivateOrReservedIpv4(embeddedV4)) return true;
    return true;
  }
  // Unique Local Address (ULA) fc00::/7 (fc00..fdff)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (fe80..febf)
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Extracts raw host authority before WHATWG `new URL()` canonicalization so sneaky
 * octal/hex/decimal/shorthand/IPv4-mapped forms can also be inspected directly.
 */
function extractRawAuthorityHost(rawUrl: string): string | null {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl.trim());
  if (!schemeMatch) return null;
  const authority = schemeMatch[1]!;
  // Strip userinfo if present (we also reject userinfo explicitly later)
  const atIdx = authority.lastIndexOf("@");
  const hostPort = atIdx !== -1 ? authority.slice(atIdx + 1) : authority;
  if (hostPort.startsWith("[")) {
    const closeBracket = hostPort.indexOf("]");
    return closeBracket !== -1 ? hostPort.slice(0, closeBracket + 1) : hostPort;
  }
  const colonIdx = hostPort.indexOf(":");
  return colonIdx !== -1 ? hostPort.slice(0, colonIdx) : hostPort;
}

function assertSafeHostnameOrIp(rawHost: string, contextLabel: string): void {
  const trimmed = rawHost.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} tidak memiliki hostname yang valid.`,
    );
  }

  if (trimmed.includes("%")) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} mengandung karakter zone/encoding hostname yang dilarang.`,
    );
  }

  // IPv6 literal check
  if (trimmed.startsWith("[") || trimmed.includes(":")) {
    const groups = parseIpv6ToGroups(trimmed);
    if (!groups || isPrivateOrReservedIpv6(groups)) {
      throw new WpImporterError(
        422,
        "SSRF_BLOCKED",
        `${contextLabel} mengarah ke alamat IPv6 lokal, privat, atau tidak diizinkan (${trimmed}).`,
        { host: trimmed },
      );
    }
    return;
  }

  // IPv4 literal check (standard dotted quad + decimal/octal/hex/shorthand forms)
  const ipv4 = parseIpv4ToUint32(trimmed);
  if (ipv4 !== null) {
    if (isPrivateOrReservedIpv4(ipv4)) {
      throw new WpImporterError(
        422,
        "SSRF_BLOCKED",
        `${contextLabel} mengarah ke alamat IPv4 privat, loopback, atau metadata cloud yang diblokir (${trimmed}).`,
        { host: trimmed },
      );
    }
    return;
  }

  // Hostname blocklist
  if (
    FORBIDDEN_HOSTNAMES.has(trimmed) ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))
  ) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} menggunakan domain internal atau lokal yang diblokir (${trimmed}).`,
      { host: trimmed },
    );
  }

  // Require a valid public multi-label DNS name (blocks single-label internal service names like `http://redis`)
  if (!trimmed.includes(".")) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} harus menggunakan nama domain publik lengkap.`,
      { host: trimmed },
    );
  }

  // Reject malformed DNS labels or numeric-only TLD tricks
  const labels = trimmed.split(".");
  for (const label of labels) {
    if (
      !label ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) {
      throw new WpImporterError(
        422,
        "SSRF_BLOCKED",
        `${contextLabel} memiliki format hostname tidak valid (${trimmed}).`,
        { host: trimmed },
      );
    }
  }
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} menggunakan TLD numerik yang tidak diizinkan.`,
      { host: trimmed },
    );
  }
}

/**
 * Validates any untrusted external URL (WordPress site base URL, `/wp-json` endpoint,
 * image URL, or redirect `Location` target) against strict SSRF guardrails.
 */
export function validateSsrfUrl(
  rawUrl: string,
  options: SsrfValidationOptions = {},
  contextLabel = "URL eksternal",
): ValidatedSsrfUrl {
  if (typeof rawUrl !== "string") {
    throw new WpImporterError(422, "SSRF_BLOCKED", `${contextLabel} harus berupa teks URL.`);
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || hasControlOrSpaceChar(trimmed)) {
    throw new WpImporterError(422, "SSRF_BLOCKED", `${contextLabel} kosong atau mengandung karakter kontrol.`);
  }
  if (trimmed.includes("\\")) {
    throw new WpImporterError(422, "SSRF_BLOCKED", `${contextLabel} tidak boleh mengandung backslash.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WpImporterError(422, "SSRF_BLOCKED", `${contextLabel} bukan URL yang valid.`);
  }

  const allowHttp = options.allowHttp === true;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} hanya mengizinkan protokol ${allowHttp ? "HTTPS/HTTP" : "HTTPS"} publik.`,
      { protocol: parsed.protocol },
    );
  }

  if (parsed.username || parsed.password) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} tidak boleh menyertakan kredensial (user:pass@host).`,
    );
  }

  const allowedPorts =
    options.allowedPorts ?? (allowHttp ? DEFAULT_HTTP_AND_HTTPS_PORTS : DEFAULT_HTTPS_PORTS);
  if (!allowedPorts.has(parsed.port)) {
    throw new WpImporterError(
      422,
      "SSRF_BLOCKED",
      `${contextLabel} menggunakan port non-standar (${parsed.port}) yang diblokir.`,
      { port: parsed.port },
    );
  }

  // Validate BOTH pre-canonicalized authority host and WHATWG-canonicalized hostname.
  // lazy: Cloudflare Workers `fetch()` does not expose pre-connect DNS A/AAAA resolution
  // to userland JS; hostname-to-private-IP egress (DNS rebinding on arbitrary public domains)
  // is bounded by the Workers egress sandbox. Upgrade path if ported off Workers: resolve DNS
  // via DoH/net.lookup and validate every returned A/AAAA record before opening a pinned socket.
  const rawAuthorityHost = extractRawAuthorityHost(trimmed);
  if (rawAuthorityHost) {
    assertSafeHostnameOrIp(rawAuthorityHost, contextLabel);
  }
  assertSafeHostnameOrIp(parsed.hostname, contextLabel);

  return {
    url: parsed,
    normalizedHref: parsed.toString(),
    hostname: parsed.hostname.toLowerCase(),
  };
}

export interface GuardedFetchOptions extends SsrfValidationOptions {
  readonly fetchImpl?: WpImporterFetchPort;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly accept?: string;
  readonly contextLabel?: string;
}

export interface GuardedFetchResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly redirectChain: readonly string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Performs an SSRF-guarded HTTP GET with manual redirect handling (re-validating EVERY hop),
 * timeout via `AbortController`, and a strict streaming byte cap via `readBoundedStream`.
 */
export async function guardedFetch(
  initialUrl: string,
  options: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WpImporterError(502, "FETCH_FAILED", "Runtime fetch tidak tersedia.");
  }

  const contextLabel = options.contextLabel ?? "URL eksternal";
  const maxRedirects = options.maxRedirects ?? WP_IMPORTER_LIMITS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? WP_IMPORTER_LIMITS.fetchTimeoutMs;

  let current = validateSsrfUrl(initialUrl, options, contextLabel);
  const redirectChain: string[] = [current.normalizedHref];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("FETCH_TIMEOUT"), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(current.normalizedHref, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "PunyaSitus-WP-Importer/1.0 (+https://punyasitus.com)",
          Accept: options.accept ?? "*/*",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        throw new WpImporterError(
          504,
          "FETCH_TIMEOUT",
          `Permintaan ke ${contextLabel} melebihi batas waktu (${timeoutMs} ms).`,
        );
      }
      throw new WpImporterError(
        502,
        "FETCH_FAILED",
        `Gagal menghubungi ${contextLabel}: ${err instanceof Error ? err.message : "network error"}`,
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      clearTimeout(timer);
      // Drain/cancel body to release connection cleanly
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel error
      }

      if (hop >= maxRedirects) {
        throw new WpImporterError(
          422,
          "TOO_MANY_REDIRECTS",
          `${contextLabel} melebihi batas maksimal ${maxRedirects} redirect.`,
        );
      }

      const location = response.headers.get("location");
      if (!location || !location.trim()) {
        throw new WpImporterError(
          502,
          "FETCH_FAILED",
          `Redirect (${response.status}) tanpa header Location yang valid.`,
        );
      }

      let resolvedTarget: string;
      try {
        resolvedTarget = new URL(location.trim(), current.normalizedHref).toString();
      } catch {
        throw new WpImporterError(
          422,
          "SSRF_REDIRECT_BLOCKED",
          `Target redirect "${location}" tidak valid.`,
        );
      }

      try {
        current = validateSsrfUrl(resolvedTarget, options, `Target redirect ${contextLabel}`);
      } catch (err) {
        if (err instanceof WpImporterError && err.code === "SSRF_BLOCKED") {
          throw new WpImporterError(
            422,
            "SSRF_REDIRECT_BLOCKED",
            `Redirect ke alamat terlarang diblokir: ${err.message}`,
            { redirectTarget: resolvedTarget, hop: hop + 1 },
          );
        }
        throw err;
      }

      redirectChain.push(current.normalizedHref);
      continue;
    }

    // Non-redirect response: enforce Content-Length pre-check + streaming byte cap
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader.trim());
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        clearTimeout(timer);
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        throw new WpImporterError(
          413,
          "RESPONSE_TOO_LARGE",
          `Ukuran respons ${contextLabel} (${declared} byte) melebihi batas maksimal ${options.maxBytes} byte.`,
        );
      }
    }

    let bytes: Uint8Array;
    try {
      if (!response.body) {
        const buf = new Uint8Array(await response.arrayBuffer());
        if (buf.byteLength > options.maxBytes) {
          throw new WpImporterError(
            413,
            "RESPONSE_TOO_LARGE",
            `Ukuran respons ${contextLabel} melebihi batas maksimal ${options.maxBytes} byte.`,
          );
        }
        bytes = buf;
      } else {
        const streamed = await readBoundedStream(response.body, options.maxBytes);
        if (!streamed.ok) {
          if (streamed.code === "PAYLOAD_TOO_LARGE") {
            throw new WpImporterError(
              413,
              "RESPONSE_TOO_LARGE",
              `Ukuran respons ${contextLabel} melebihi batas maksimal ${options.maxBytes} byte.`,
            );
          }
          bytes = new Uint8Array(0);
        } else {
          bytes = streamed.bytes;
        }
      }
    } catch (err) {
      if (err instanceof WpImporterError) {
        throw err;
      }
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        throw new WpImporterError(
          504,
          "FETCH_TIMEOUT",
          `Pembacaan respons dari ${contextLabel} melebihi batas waktu (${timeoutMs} ms).`,
        );
      }
      throw new WpImporterError(
        502,
        "FETCH_FAILED",
        `Gagal membaca respons dari ${contextLabel}: ${err instanceof Error ? err.message : "stream error"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    return {
      finalUrl: current.normalizedHref,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      headers: response.headers,
      bytes,
      redirectChain,
    };
  }

  throw new WpImporterError(
    422,
    "TOO_MANY_REDIRECTS",
    `${contextLabel} melebihi batas redirect yang diizinkan.`,
  );
}
