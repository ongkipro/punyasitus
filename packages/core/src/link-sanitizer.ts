export const MAX_EXTERNAL_URL_LENGTH = 2048 as const;
export const EXTERNAL_LINK_TARGET = "_blank" as const;
export const BASE_EXTERNAL_LINK_REL = ["noopener", "noreferrer"] as const;

export type ExternalLinkErrorCode =
  | "EMPTY_URL"
  | "URL_TOO_LONG"
  | "CONTROL_CHARACTER"
  | "MALFORMED_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "EMBEDDED_CREDENTIALS"
  | "FORBIDDEN_HOST";

export class ExternalLinkValidationError extends Error {
  readonly code: ExternalLinkErrorCode;

  constructor(code: ExternalLinkErrorCode, message: string) {
    super(message);
    this.name = "ExternalLinkValidationError";
    this.code = code;
  }
}

export interface SanitizeExternalLinkOptions {
  readonly nofollow?: boolean;
  readonly sponsored?: boolean;
  readonly ugc?: boolean;
}

export interface SanitizedExternalLink {
  readonly href: string;
  readonly target: typeof EXTERNAL_LINK_TARGET;
  readonly rel: string;
  readonly hostname: string;
}

export type ExternalLinkValidationResult =
  | { readonly ok: true; readonly link: SanitizedExternalLink }
  | { readonly ok: false; readonly code: ExternalLinkErrorCode; readonly message: string };

const FORBIDDEN_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "localdomain",
  "home.arpa",
] as const;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseIpv4Octets(host: string): readonly [number, number, number, number] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return null;
  }
  const parts = host.split(".");
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  const d = Number(parts[3]);
  if (a > 255 || b > 255 || c > 255 || d > 255) {
    return null;
  }
  return [a, b, c, d];
}

function isBlockedIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 unspecified / current network
  if (a === 10) return true; // 10.0.0.0/8 RFC 1918 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function parseIpv6Hextets(rawAddress: string): readonly number[] | null {
  // Reject IPv6 zone identifiers (e.g. fe80::1%eth0)
  if (rawAddress.includes("%")) return null;

  let address = rawAddress.toLowerCase();

  // Convert trailing embedded IPv4 dotted-quad into two hex groups if present
  const lastColon = address.lastIndexOf(":");
  if (lastColon !== -1 && address.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseIpv4Octets(address.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonParts = address.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const pieces = segment.split(":");
    const values: number[] = [];
    for (const piece of pieces) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      values.push(Number.parseInt(piece, 16));
    }
    return values;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0] ?? "");
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroups(doubleColonParts[0] ?? "");
  const right = parseGroups(doubleColonParts[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(hextets: readonly number[]): boolean {
  const h0 = hextets[0] ?? 0;
  const h1 = hextets[1] ?? 0;
  const h2 = hextets[2] ?? 0;
  const h3 = hextets[3] ?? 0;
  const h4 = hextets[4] ?? 0;
  const h5 = hextets[5] ?? 0;
  const h6 = hextets[6] ?? 0;
  const h7 = hextets[7] ?? 0;

  // :: (unspecified) and ::1 (loopback)
  const firstSevenZero =
    h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0;
  if (firstSevenZero && (h7 === 0 || h7 === 1)) {
    return true;
  }

  // fc00::/7 Unique Local Address (fc00:: - fdff::)
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 Link-Local (fe80:: - febf::)
  if ((h0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 Deprecated Site-Local
  if ((h0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 Multicast
  if ((h0 & 0xff00) === 0xff00) return true;

  // ::ffff:0:0/96 IPv4-mapped IPv6
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return isBlockedIpv4([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  // ::/96 IPv4-compatible IPv6
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIpv4([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  // 64:ff9b::/96 NAT64 well-known prefix
  if (h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIpv4([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff]);
  }
  // 2002::/16 6to4
  if (h0 === 0x2002) {
    return isBlockedIpv4([(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff]);
  }

  return false;
}

function isForbiddenHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6Literal = hostname.slice(1, -1);
    const hextets = parseIpv6Hextets(ipv6Literal);
    if (!hextets) return true;
    return isBlockedIpv6(hextets);
  }

  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (normalized.length === 0) return true;

  const ipv4 = parseIpv4Octets(normalized);
  if (ipv4) {
    return isBlockedIpv4(ipv4);
  }

  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
      return true;
    }
  }

  // Reject single-label / dotless internal hostnames (e.g., https://intranet/path)
  if (!normalized.includes(".")) {
    return true;
  }
  const labels = normalized.split(".");
  if (labels.some((label) => label.length === 0)) {
    return true;
  }

  return false;
}

export function buildExternalLinkRel(options?: SanitizeExternalLinkOptions): string {
  const tokens: string[] = [...BASE_EXTERNAL_LINK_REL];
  if (options?.nofollow) tokens.push("nofollow");
  if (options?.sponsored) tokens.push("sponsored");
  if (options?.ugc) tokens.push("ugc");
  return tokens.join(" ");
}

/**
 * Validates and normalizes an external HTTPS CTA/marketplace link-out URL.
 * Never falls back to `#`; throws `ExternalLinkValidationError` on any invalid input.
 * Always emits `target="_blank"` and `rel` containing at least `noopener noreferrer`.
 */
export function sanitizeExternalLink(
  rawUrl: string,
  options?: SanitizeExternalLinkOptions,
): SanitizedExternalLink {
  if (typeof rawUrl !== "string") {
    throw new ExternalLinkValidationError("MALFORMED_URL", "External URL must be a string.");
  }
  if (hasControlCharacters(rawUrl)) {
    throw new ExternalLinkValidationError(
      "CONTROL_CHARACTER",
      "External URL must not contain ASCII control characters.",
    );
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new ExternalLinkValidationError("EMPTY_URL", "External URL is required.");
  }
  if (trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new ExternalLinkValidationError(
      "URL_TOO_LONG",
      `External URL exceeds maximum length of ${MAX_EXTERNAL_URL_LENGTH} characters.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ExternalLinkValidationError(
      "MALFORMED_URL",
      "External URL is malformed or missing a valid HTTPS scheme.",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new ExternalLinkValidationError(
      "UNSUPPORTED_PROTOCOL",
      `External URL must use https:// (received '${parsed.protocol}').`,
    );
  }

  if (!/^https:\/\//i.test(trimmed)) {
    throw new ExternalLinkValidationError(
      "MALFORMED_URL",
      "External URL must start explicitly with 'https://'.",
    );
  }

  const afterScheme = trimmed.slice(8);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const rawAuthority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);

  if (rawAuthority.includes("\\")) {
    throw new ExternalLinkValidationError(
      "MALFORMED_URL",
      "External URL authority must not contain backslashes.",
    );
  }
  if (rawAuthority.includes("@") || parsed.username !== "" || parsed.password !== "") {
    throw new ExternalLinkValidationError(
      "EMBEDDED_CREDENTIALS",
      "External URL must not include embedded credentials.",
    );
  }

  if (isForbiddenHostname(parsed.hostname)) {
    throw new ExternalLinkValidationError(
      "FORBIDDEN_HOST",
      `External URL host '${parsed.hostname}' is private, loopback, local, or otherwise forbidden.`,
    );
  }

  return {
    href: parsed.href,
    target: EXTERNAL_LINK_TARGET,
    rel: buildExternalLinkRel(options),
    hostname: parsed.hostname,
  };
}

/**
 * Non-throwing wrapper around `sanitizeExternalLink` for schema/form validation.
 * Never returns a `#` hash-link fallback.
 */
export function validateExternalLink(
  rawUrl: string,
  options?: SanitizeExternalLinkOptions,
): ExternalLinkValidationResult {
  try {
    return { ok: true, link: sanitizeExternalLink(rawUrl, options) };
  } catch (error) {
    if (error instanceof ExternalLinkValidationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
