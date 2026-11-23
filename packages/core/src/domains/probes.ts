import { doesCnameMatchTarget } from "./connect-modes.ts";
import { DEFAULT_SAAS_CNAME_TARGET } from "./validation.ts";

/**
 * Injectable DNS lookup (with production Cloudflare DoH implementation),
 * fail-closed `DOMAIN_MARKER_SECRET` resolver, live HTTPS tenant-marker probe,
 * and 4-gate primary promotion evaluator (REQ-004, PLAN §3.1, §3.2, §12.2).
 *
 * All 4 gates MUST pass before a custom hostname can be promoted to primary:
 *   1. Cloudflare hostname ownership `status === "active"`
 *   2. Cloudflare `ssl.status === "active"`
 *   3. Target CNAME verification passing (`cnameTarget`)
 *   4. Live HTTPS tenant-marker probe confirming THIS exact tenant answers on the hostname
 */

export const TENANT_DOMAIN_MARKER_PATH = "/.well-known/punyasitus-domain-check" as const;
export const TENANT_DOMAIN_MARKER_HEADER = "x-punyasitus-tenant-marker" as const;
export const MIN_DOMAIN_MARKER_SECRET_LENGTH = 32 as const;
export const DEFAULT_CLOUDFLARE_DOH_URL = "https://cloudflare-dns.com/dns-query" as const;
export const DEFAULT_CLOUDFLARE_DOH_TIMEOUT_MS = 4_000 as const;

export class DomainMarkerConfigError extends Error {
  readonly status = 503 as const;
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly reasonCode = "DOMAIN_MARKER_SECRET_UNCONFIGURED" as const;

  constructor(
    message = "DOMAIN_MARKER_SECRET belum dikonfigurasi (wajib minimal 32 karakter) untuk verifikasi marker domain.",
  ) {
    super(message);
    this.name = "DomainMarkerConfigError";
  }
}

export interface DomainMarkerSecretEnv {
  readonly APP_ENV?: string;
  readonly DOMAIN_MARKER_SECRET?: string;
}

/**
 * Resolves the dedicated `DOMAIN_MARKER_SECRET` (>= 32 chars) for HMAC-SHA256
 * tenant domain marker generation and verification.
 *
 * Security invariants:
 * - NEVER falls back to a public hardcoded secret.
 * - NEVER reuses `AUTH_SECRET`.
 * - Outside `APP_ENV === "local"` or `APP_ENV === "test"`, ALWAYS fails closed
 *   with `DomainMarkerConfigError` (`503 DOMAIN_MARKER_SECRET_UNCONFIGURED`) when missing/short.
 * - In `local`/`test`, an explicit `testMarkerSecret` (>= 32 chars) may be injected for tests.
 */
export function resolveDomainMarkerSecret(
  env: DomainMarkerSecretEnv,
  options?: { readonly testMarkerSecret?: string },
): string {
  const configured = env.DOMAIN_MARKER_SECRET?.trim() ?? "";
  if (configured.length >= MIN_DOMAIN_MARKER_SECRET_LENGTH) {
    return configured;
  }

  const appEnv = (env.APP_ENV ?? "").trim().toLowerCase();
  const isLocalOrTest = appEnv === "local" || appEnv === "test";
  if (isLocalOrTest && options?.testMarkerSecret) {
    const injected = options.testMarkerSecret.trim();
    if (injected.length >= MIN_DOMAIN_MARKER_SECRET_LENGTH) {
      return injected;
    }
  }

  throw new DomainMarkerConfigError();
}

export interface DnsResolverPort {
  resolveCname(hostname: string): Promise<readonly string[]>;
  resolveTxt(hostname: string): Promise<readonly string[]>;
  resolveCaa?(hostname: string): Promise<readonly string[]>;
  resolveNs?(hostname: string): Promise<readonly string[]>;
}

interface CloudflareDohAnswer {
  readonly name?: string;
  readonly type?: number;
  readonly TTL?: number;
  readonly data?: string;
}

interface CloudflareDohResponse {
  readonly Status?: number;
  readonly Answer?: readonly CloudflareDohAnswer[];
}

const DNS_RECORD_TYPES = {
  NS: 2,
  CNAME: 5,
  TXT: 16,
  CAA: 257,
} as const;

function normalizeDohTargetName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Decodes RFC 1035 quoted TXT strings returned by DoH JSON (e.g., `"part1" "part2"` -> `part1part2`).
 */
function parseDohTxtData(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"')) {
    return trimmed;
  }
  const segments: string[] = [];
  const segmentRe = /"((?:\\.|[^"\\])*)"/g;
  for (const match of trimmed.matchAll(segmentRe)) {
    const body = match[1] ?? "";
    segments.push(body.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return segments.length > 0 ? segments.join("") : trimmed.replace(/^"|"$/g, "");
}

export interface CreateCloudflareDohDnsResolverOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpointUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Production DNS-over-HTTPS (DoH) resolver querying Cloudflare DNS JSON API
 * (`https://cloudflare-dns.com/dns-query?name=...&type=CNAME|TXT|CAA|NS`)
 * with `Accept: application/dns-json` and bounded 4s timeout.
 */
export function createCloudflareDohDnsResolver(
  fetchImplOrOptions?: typeof fetch | CreateCloudflareDohDnsResolverOptions,
): DnsResolverPort {
  const opts: CreateCloudflareDohDnsResolverOptions =
    typeof fetchImplOrOptions === "function"
      ? { fetchImpl: fetchImplOrOptions }
      : (fetchImplOrOptions ?? {});

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const endpointUrl = (opts.endpointUrl ?? DEFAULT_CLOUDFLARE_DOH_URL).trim().replace(/\?.*$/, "");
  const timeoutMs = Math.max(
    500,
    Math.min(10_000, opts.timeoutMs ?? DEFAULT_CLOUDFLARE_DOH_TIMEOUT_MS),
  );

  async function queryDoh(
    hostname: string,
    recordType: keyof typeof DNS_RECORD_TYPES,
  ): Promise<readonly string[]> {
    const cleanName = hostname.trim().toLowerCase().replace(/\.+$/, "");
    if (!cleanName) return [];

    const expectedTypeCode = DNS_RECORD_TYPES[recordType];
    const queryUrl = `${endpointUrl}?name=${encodeURIComponent(cleanName)}&type=${recordType}`;

    let response: Response;
    const hasAbortSignalTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    const controller = hasAbortSignalTimeout ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      response = await fetchFn(queryUrl, {
        method: "GET",
        headers: {
          Accept: "application/dns-json",
        },
        signal: hasAbortSignalTimeout ? AbortSignal.timeout(timeoutMs) : controller!.signal,
      });
    } catch {
      return [];
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    if (!response.ok) {
      return [];
    }

    let parsed: CloudflareDohResponse;
    try {
      parsed = (await response.json()) as CloudflareDohResponse;
    } catch {
      return [];
    }

    if (parsed.Status !== 0 || !Array.isArray(parsed.Answer)) {
      return [];
    }

    const out: string[] = [];
    for (const answer of parsed.Answer) {
      if (!answer || typeof answer.data !== "string") continue;
      if (answer.type !== undefined && answer.type !== expectedTypeCode) continue;

      if (recordType === "CNAME" || recordType === "NS") {
        const normalized = normalizeDohTargetName(answer.data);
        if (normalized) out.push(normalized);
      } else if (recordType === "TXT") {
        const txt = parseDohTxtData(answer.data);
        if (txt) out.push(txt);
      } else {
        const caa = answer.data.trim();
        if (caa) out.push(caa);
      }
    }

    return out;
  }

  return {
    resolveCname: (hostname) => queryDoh(hostname, "CNAME"),
    resolveTxt: (hostname) => queryDoh(hostname, "TXT"),
    resolveCaa: (hostname) => queryDoh(hostname, "CAA"),
    resolveNs: (hostname) => queryDoh(hostname, "NS"),
  };
}

export interface HttpsMarkerProbeInput {
  readonly hostname: string;
  readonly expectedTenantId: string;
  readonly expectedMarker: string;
}

export interface HttpsMarkerProbeResult {
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly observedTenantId: string | null;
  readonly markerMatched: boolean;
  readonly errorCode: string | null;
}

export interface HttpsProbePort {
  probeTenantMarker(input: HttpsMarkerProbeInput): Promise<HttpsMarkerProbeResult>;
}

export type PromotionGateName =
  | "ownership_active"
  | "ssl_active"
  | "cname_verified"
  | "https_marker_probe";

export interface PromotionGateFailure {
  readonly gate: PromotionGateName;
  readonly code: string;
  readonly messageId: string;
}

export interface PrimaryPromotionEvaluation {
  readonly eligible: boolean;
  readonly gates: {
    readonly ownershipActive: boolean;
    readonly sslActive: boolean;
    readonly cnameVerified: boolean;
    readonly httpsProbePassed: boolean;
  };
  readonly failedGates: readonly PromotionGateFailure[];
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generates a deterministic HMAC-SHA256 tenant marker bound to `(tenantId, hostname)`
 * so the HTTPS marker probe proves THIS exact tenant (not another tenant or third-party origin)
 * answers on the hostname over HTTPS.
 */
export async function computeTenantDomainMarker(
  tenantId: string,
  hostname: string,
  secret: string,
): Promise<string> {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length < MIN_DOMAIN_MARKER_SECRET_LENGTH) {
    throw new DomainMarkerConfigError();
  }
  const normalizedHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(trimmedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`punyasitus-domain-marker:v1:${tenantId.trim()}:${normalizedHost}`),
  );
  return `ps-v1:${tenantId.trim()}:${bytesToHex(new Uint8Array(sig)).slice(0, 32)}`;
}

/**
 * Default `fetch`-based HTTPS tenant-marker probe calling
 * `https://<hostname>/.well-known/punyasitus-domain-check`.
 */
export function createFetchHttpsProbe(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): HttpsProbePort {
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(500, Math.min(15_000, options?.timeoutMs ?? 6_000));

  return {
    async probeTenantMarker(input: HttpsMarkerProbeInput): Promise<HttpsMarkerProbeResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `https://${input.hostname}${TENANT_DOMAIN_MARKER_PATH}`;
        const res = await fetchFn(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (res.status !== 200) {
          return {
            ok: false,
            statusCode: res.status,
            observedTenantId: null,
            markerMatched: false,
            errorCode: `HTTPS_PROBE_HTTP_${res.status}`,
          };
        }

        const headerMarker = res.headers.get(TENANT_DOMAIN_MARKER_HEADER)?.trim() ?? null;
        let bodyTenantId: string | null = null;
        let bodyMarker: string | null = null;
        try {
          const parsed = (await res.json()) as Record<string, unknown>;
          if (typeof parsed.tenantId === "string") bodyTenantId = parsed.tenantId.trim();
          if (typeof parsed.marker === "string") bodyMarker = parsed.marker.trim();
        } catch {
          // Body may be non-JSON if only header marker is used
        }

        const observedMarker = bodyMarker ?? headerMarker;
        const markerMatched =
          observedMarker !== null && observedMarker === input.expectedMarker;
        const tenantMatched =
          bodyTenantId !== null ? bodyTenantId === input.expectedTenantId : markerMatched;

        if (!markerMatched || !tenantMatched) {
          return {
            ok: false,
            statusCode: res.status,
            observedTenantId: bodyTenantId,
            markerMatched: false,
            errorCode: "HTTPS_PROBE_MARKER_MISMATCH",
          };
        }

        return {
          ok: true,
          statusCode: res.status,
          observedTenantId: bodyTenantId ?? input.expectedTenantId,
          markerMatched: true,
          errorCode: null,
        };
      } catch (err) {
        const isTimeout =
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError");
        return {
          ok: false,
          statusCode: null,
          observedTenantId: null,
          markerMatched: false,
          errorCode: isTimeout ? "HTTPS_PROBE_TIMEOUT" : "HTTPS_PROBE_NETWORK_ERROR",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Evaluates ALL 4 mandatory primary promotion gates (PLAN §3.1 & TASK-003):
 *   1. `providerStatus === "active"`
 *   2. `providerSslStatus === "active"`
 *   3. DNS CNAME target verified against `cnameTarget`
 *   4. Live HTTPS tenant-marker probe confirming THIS exact tenant answers
 */
export function evaluatePrimaryPromotionGates(input: {
  readonly providerStatus: string;
  readonly providerSslStatus: string;
  readonly observedCnameTargets: readonly string[];
  readonly cnameTarget?: string;
  readonly httpsProbe: HttpsMarkerProbeResult;
  readonly expectedTenantId: string;
}): PrimaryPromotionEvaluation {
  const cnameTarget = input.cnameTarget ?? DEFAULT_SAAS_CNAME_TARGET;
  const ownershipActive = input.providerStatus.trim().toLowerCase() === "active";
  const sslActive = input.providerSslStatus.trim().toLowerCase() === "active";
  const cnameVerified = doesCnameMatchTarget(input.observedCnameTargets, cnameTarget);
  const httpsProbePassed =
    input.httpsProbe.ok === true &&
    input.httpsProbe.markerMatched === true &&
    input.httpsProbe.observedTenantId === input.expectedTenantId;

  const failedGates: PromotionGateFailure[] = [];

  if (!ownershipActive) {
    failedGates.push({
      gate: "ownership_active",
      code: "GATE_OWNERSHIP_NOT_ACTIVE",
      messageId: `Kepemilikan hostname belum berstatus active di Cloudflare (saat ini: ${input.providerStatus}).`,
    });
  }

  if (!sslActive) {
    failedGates.push({
      gate: "ssl_active",
      code: "GATE_SSL_NOT_ACTIVE",
      messageId: `Sertifikat SSL belum berstatus active di Cloudflare (saat ini: ${input.providerSslStatus}).`,
    });
  }

  if (!cnameVerified) {
    failedGates.push({
      gate: "cname_verified",
      code: "GATE_CNAME_MISMATCH",
      messageId: `Verifikasi DNS CNAME belum mengarah ke target ${cnameTarget}.`,
    });
  }

  if (!httpsProbePassed) {
    failedGates.push({
      gate: "https_marker_probe",
      code: input.httpsProbe.errorCode ?? "GATE_HTTPS_PROBE_FAILED",
      messageId:
        "Probe HTTPS langsung ke domain gagal mengonfirmasi marker tenant ini. Domain utama lama tetap dipertahankan.",
    });
  }

  return {
    eligible: failedGates.length === 0,
    gates: {
      ownershipActive,
      sslActive,
      cnameVerified,
      httpsProbePassed,
    },
    failedGates,
  };
}
