import { PLATFORM_HOSTS } from "../index.ts";
import {
  FORBIDDEN_TENANT_SELECTOR_KEYS,
  type ApiErrorCode,
} from "../schemas/common.ts";
import type { DomainConnectModeSchema, DomainSslMethodSchema } from "../schemas/domains.ts";
import type { z } from "zod";

/**
 * Custom domain hostname validation, eligibility, REQ-065 domain-set rules,
 * connect mode normalization, and typed domain errors (REQ-004, REQ-043, REQ-065; PLAN §3.1-3.2).
 */

export const MAX_CUSTOM_HOSTNAME_LENGTH = 64 as const; // Cloudflare SSL CN Error 1469
export const MAX_CUSTOM_HOSTNAMES_PER_TENANT = 2 as const;
export const DEFAULT_SAAS_CNAME_TARGET = `cname.${PLATFORM_HOSTS.saasZone}` as const;

export type DomainConnectMode = z.infer<typeof DomainConnectModeSchema>;
export type DomainConnectModeInput = DomainConnectMode | "o2o";
export type DomainSslMethod = z.infer<typeof DomainSslMethodSchema>;

export const FORBIDDEN_DOMAIN_BODY_KEYS = [
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "cfCustomHostnameId",
  "cf_custom_hostname_id",
  "status",
  "sslStatus",
  "ssl_status",
  "isPrimary",
  "is_primary",
  "verifiedAt",
  "verified_at",
  "quarantinedUntil",
  "quarantined_until",
  "forceActive",
  "force_active",
  "bypassVerification",
  "bypass_verification",
] as const;

const RESERVED_PRIVATE_TLDS = new Set([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "home",
  "lan",
  "arpa",
  "invalid",
  "example",
  "test",
]);

const IPV4_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const NUMERIC_TLD_RE = /^\d+$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Explicit multi-label public suffixes for Indonesian & common regional apex domains
 * (e.g. `bisnis.co.id`, `toko.web.id`, `sekolah.sch.id`) used for syntactic apex detection
 * and REQ-065 counterpart suggestion. Never used to claim DNS authority (PLAN §3.1).
 */
export const MULTI_LABEL_PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.id",
  "web.id",
  "or.id",
  "ac.id",
  "sch.id",
  "go.id",
  "my.id",
  "biz.id",
  "desa.id",
  "ponpes.id",
  "co.uk",
  "com.sg",
  "com.my",
  "com.au",
]);

/**
 * Syntactically determines whether a hostname is a root/apex domain (e.g. `toko.id`,
 * `bisnis.co.id`, `sekolah.sch.id`) as opposed to `www.*` or a deeper subdomain.
 */
export function isApexDomainHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!hostname) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (labels[0] === "www") return false;
  if (labels.length === 2) return true;
  if (labels.length === 3) {
    const lastTwo = `${labels[1]}.${labels[2]}`;
    return MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo);
  }
  return false;
}

export type HostnameValidationErrorCode =
  | "HOSTNAME_EMPTY"
  | "HOSTNAME_MALFORMED"
  | "HOSTNAME_TOO_LONG"
  | "HOSTNAME_WILDCARD_FORBIDDEN"
  | "HOSTNAME_IP_FORBIDDEN"
  | "HOSTNAME_PRIVATE_FORBIDDEN"
  | "HOSTNAME_PLATFORM_FORBIDDEN"
  | "HOSTNAME_SAAS_ZONE_FORBIDDEN";

export interface ValidateCustomHostnameOptions {
  readonly platformDomain?: string;
  readonly saasZone?: string;
  /** Allows `.test` / `.example` TLDs in test fixtures when explicitly enabled (defaults to true for `.test`/`.example`? No: keep safe!). */
  readonly allowTestTlds?: boolean;
}

export type HostnameValidationResult =
  | {
      readonly ok: true;
      readonly hostname: string;
      readonly labels: readonly string[];
      readonly isWww: boolean;
      readonly isLikelyApex: boolean;
      readonly suggestedWwwCounterpart: string | null;
      readonly apexCounterpart: string | null;
    }
  | {
      readonly ok: false;
      readonly code: HostnameValidationErrorCode;
      readonly message: string;
    };

export class DomainValidationError extends Error {
  readonly status: 400 | 422;
  readonly code: ApiErrorCode;
  readonly reasonCode: string;
  readonly field?: string;

  constructor(
    reasonCode: string,
    message: string,
    options?: { readonly status?: 400 | 422; readonly code?: ApiErrorCode; readonly field?: string },
  ) {
    super(message);
    this.name = "DomainValidationError";
    this.status = options?.status ?? 422;
    this.code = options?.code ?? "VALIDATION_ERROR";
    this.reasonCode = reasonCode;
    this.field = options?.field;
  }
}

export class DomainEligibilityError extends Error {
  readonly status = 403 as const;
  readonly code: Extract<ApiErrorCode, "TRIAL_DOMAIN_FORBIDDEN" | "DOMAIN_LOCKED" | "FORBIDDEN">;

  constructor(
    code: Extract<ApiErrorCode, "TRIAL_DOMAIN_FORBIDDEN" | "DOMAIN_LOCKED" | "FORBIDDEN">,
    message: string,
  ) {
    super(message);
    this.name = "DomainEligibilityError";
    this.code = code;
  }
}

export class DomainConflictError extends Error {
  readonly status = 409 as const;
  readonly code: ApiErrorCode;
  readonly reasonCode:
    | "DOMAIN_ALREADY_CLAIMED"
    | "DOMAIN_LIMIT_REACHED"
    | "DOMAIN_SET_MISMATCH"
    | "STALE_VERSION"
    | "IDEMPOTENCY_CONFLICT"
    | "DOMAIN_CLEANUP_PENDING"
    | "PROMOTION_GATE_FAILED";

  constructor(
    reasonCode: DomainConflictError["reasonCode"],
    message: string,
    apiCode: ApiErrorCode = reasonCode === "STALE_VERSION"
      ? "STALE_VERSION"
      : reasonCode === "IDEMPOTENCY_CONFLICT"
        ? "IDEMPOTENCY_CONFLICT"
        : "CONFLICT",
  ) {
    super(message);
    this.name = "DomainConflictError";
    this.reasonCode = reasonCode;
    this.code = apiCode;
  }
}

export class DomainNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;

  constructor(message = "Domain tidak ditemukan.") {
    super(message);
    this.name = "DomainNotFoundError";
  }
}

export class DomainRateLimitError extends Error {
  readonly status = 429 as const;
  readonly code = "RATE_LIMITED" as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(
      message ??
        `Terlalu banyak permintaan pemeriksaan domain. Coba lagi dalam ${retryAfterSeconds} detik.`,
    );
    this.name = "DomainRateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export type DomainProviderErrorKind =
  | "timeout"
  | "upstream_5xx"
  | "rate_limited"
  | "auth_error"
  | "not_found"
  | "bad_request"
  | "config_error"
  | "invalid_response";

export class DomainProviderError extends Error {
  readonly kind: DomainProviderErrorKind;
  readonly statusCode: number | null;
  readonly retryable: boolean;
  readonly providerErrorCode: number | null;

  constructor(
    kind: DomainProviderErrorKind,
    message: string,
    options?: {
      readonly statusCode?: number | null;
      readonly retryable?: boolean;
      readonly providerErrorCode?: number | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DomainProviderError";
    this.kind = kind;
    this.statusCode = options?.statusCode ?? null;
    this.retryable =
      options?.retryable ?? (kind === "timeout" || kind === "upstream_5xx" || kind === "rate_limited");
    this.providerErrorCode = options?.providerErrorCode ?? null;
  }
}

export function normalizeConnectMode(raw: unknown): DomainConnectMode {
  if (raw === "o2o" || raw === "cloudflare_o2o") {
    return "cloudflare_o2o";
  }
  if (raw === "new_domain" || raw === "zero_downtime_migration") {
    return raw;
  }
  throw new DomainValidationError(
    "INVALID_CONNECT_MODE",
    "Mode koneksi domain harus salah satu dari: new_domain, zero_downtime_migration, atau cloudflare_o2o.",
    { field: "mode" },
  );
}

/**
 * Default Cloudflare SSL validation method per connect mode (PLAN §3.2):
 * - `new_domain`: `http`
 * - `zero_downtime_migration`: `txt` (pre-validation while old site stays live)
 * - `cloudflare_o2o`: `http` (pre-validation is not supported for O2O)
 */
export function resolveSslMethodForMode(
  mode: DomainConnectMode,
  requested?: DomainSslMethod,
): DomainSslMethod {
  if (mode === "zero_downtime_migration") {
    if (requested && requested !== "txt") {
      throw new DomainValidationError(
        "MIGRATION_REQUIRES_TXT_DCV",
        "Mode pindahan nol downtime wajib menggunakan metode validasi SSL 'txt' agar sertifikat terbit sebelum cutover CNAME.",
        { field: "sslMethod" },
      );
    }
    return "txt";
  }
  if (mode === "cloudflare_o2o") {
    if (requested && requested !== "http") {
      throw new DomainValidationError(
        "O2O_REQUIRES_HTTP_DCV",
        "Mode Cloudflare O2O tidak mendukung pre-validasi TXT; gunakan metode validasi SSL 'http'.",
        { field: "sslMethod" },
      );
    }
    return "http";
  }
  return requested ?? "http";
}

function normalizeZoneDomain(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? fallback).trim().toLowerCase().replace(/\.+$/, "");
  return cleaned || fallback;
}

/**
 * Syntactically validates and normalizes a customer custom hostname (PLAN §3.1 & §12.2).
 *
 * Enforces:
 * - Rejects schemes, paths, queries, fragments, credentials, ports, whitespace, wildcards.
 * - Rejects hostnames > 64 characters (Cloudflare SSL CN Error 1469).
 * - Rejects IPv4/IPv6 literals, single-label names, numeric TLDs, and reserved/private TLDs.
 * - Rejects the platform domain (`punyasitus.com` & subdomains) and SaaS zone (`situsku.click` & subdomains).
 * - Does NOT guess DNS authority with a public-suffix regex (PLAN §3.1).
 */
export function validateCustomHostname(
  rawInput: unknown,
  options: ValidateCustomHostnameOptions = {},
): HostnameValidationResult {
  if (typeof rawInput !== "string") {
    return {
      ok: false,
      code: "HOSTNAME_EMPTY",
      message: "Nama domain wajib diisi berupa teks hostname saja (contoh: www.tokocontoh.id).",
    };
  }

  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed) {
    return {
      ok: false,
      code: "HOSTNAME_EMPTY",
      message: "Nama domain tidak boleh kosong.",
    };
  }

  // Reject schemes, paths, queries, fragments, credentials, ports, whitespace, brackets
  if (
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("@") ||
    trimmed.includes(":") ||
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    /\s/.test(trimmed)
  ) {
    return {
      ok: false,
      code: "HOSTNAME_MALFORMED",
      message:
        "Masukkan nama domain saja tanpa http://, https://, port, kredensial, atau path (contoh: www.tokocontoh.id).",
    };
  }

  if (trimmed.includes("*")) {
    return {
      ok: false,
      code: "HOSTNAME_WILDCARD_FORBIDDEN",
      message: "Domain wildcard (*.domain.com) tidak didukung. Masukkan hostname spesifik.",
    };
  }

  // Strip a single trailing FQDN dot if present, reject double/leading dots
  if (trimmed.startsWith(".") || trimmed.includes("..")) {
    return {
      ok: false,
      code: "HOSTNAME_MALFORMED",
      message: "Format nama domain tidak valid.",
    };
  }
  const hostname = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;

  if (!hostname) {
    return {
      ok: false,
      code: "HOSTNAME_EMPTY",
      message: "Nama domain tidak boleh kosong.",
    };
  }

  if (hostname.length > MAX_CUSTOM_HOSTNAME_LENGTH) {
    return {
      ok: false,
      code: "HOSTNAME_TOO_LONG",
      message: `Nama domain tidak boleh lebih dari ${MAX_CUSTOM_HOSTNAME_LENGTH} karakter (batas sertifikat SSL Cloudflare Error 1469).`,
    };
  }

  if (IPV4_LITERAL_RE.test(hostname)) {
    return {
      ok: false,
      code: "HOSTNAME_IP_FORBIDDEN",
      message: "Alamat IP tidak dapat digunakan sebagai custom domain.",
    };
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return {
      ok: false,
      code: "HOSTNAME_MALFORMED",
      message: "Nama domain harus berupa FQDN lengkap dengan minimal dua segmen (contoh: www.tokocontoh.id).",
    };
  }

  for (const label of labels) {
    if (!DNS_LABEL_RE.test(label)) {
      return {
        ok: false,
        code: "HOSTNAME_MALFORMED",
        message:
          "Nama domain hanya boleh berisi huruf a-z, angka 0-9, dan tanda hubung (-) tidak di awal/akhir label.",
      };
    }
  }

  const tld = labels[labels.length - 1] ?? "";
  if (NUMERIC_TLD_RE.test(tld)) {
    return {
      ok: false,
      code: "HOSTNAME_IP_FORBIDDEN",
      message: "TLD numerik atau alamat IP tidak valid sebagai custom domain.",
    };
  }

  const isReservedPrivateTld =
    RESERVED_PRIVATE_TLDS.has(tld) &&
    !(options.allowTestTlds && (tld === "test" || tld === "example"));
  if (isReservedPrivateTld || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return {
      ok: false,
      code: "HOSTNAME_PRIVATE_FORBIDDEN",
      message: `Nama domain dengan akhiran privat/cadangan (.${tld}) tidak dapat dihubungkan.`,
    };
  }

  const platformDomain = normalizeZoneDomain(options.platformDomain, PLATFORM_HOSTS.marketing);
  if (hostname === platformDomain || hostname.endsWith(`.${platformDomain}`)) {
    return {
      ok: false,
      code: "HOSTNAME_PLATFORM_FORBIDDEN",
      message: `Domain platform (${platformDomain}) tidak dapat diklaim sebagai custom domain tenant.`,
    };
  }

  const saasZone = normalizeZoneDomain(options.saasZone, PLATFORM_HOSTS.saasZone);
  if (hostname === saasZone || hostname.endsWith(`.${saasZone}`)) {
    return {
      ok: false,
      code: "HOSTNAME_SAAS_ZONE_FORBIDDEN",
      message: `Zona SaaS (${saasZone}) tidak dapat ditambahkan sebagai custom domain.`,
    };
  }

  const isWww = labels[0] === "www" && labels.length >= 3;
  const apexCounterpart = isWww ? labels.slice(1).join(".") : null;
  const suggestedWwwCounterpart = !isWww ? `www.${hostname}` : null;
  // Syntactic indicator only including Indonesian multi-label suffixes (never claims DNS authority per PLAN §3.1)
  const isLikelyApex = isApexDomainHostname(hostname);

  return {
    ok: true,
    hostname,
    labels,
    isWww,
    isLikelyApex,
    suggestedWwwCounterpart,
    apexCounterpart,
  };
}

/**
 * Throws `DomainValidationError` if the hostname is invalid; returns normalized validation result.
 */
export function assertValidCustomHostname(
  rawInput: unknown,
  options: ValidateCustomHostnameOptions = {},
): Extract<HostnameValidationResult, { readonly ok: true }> {
  const result = validateCustomHostname(rawInput, options);
  if (!result.ok) {
    throw new DomainValidationError(result.code, result.message, { field: "hostname" });
  }
  return result;
}

/**
 * Checks whether two custom hostnames form a valid REQ-065 counterpart pair (`www.X` <-> `X`).
 */
export function areDomainCounterparts(a: string, b: string): boolean {
  const normA = a.trim().toLowerCase().replace(/\.$/, "");
  const normB = b.trim().toLowerCase().replace(/\.$/, "");
  if (normA === normB) return false;
  return normA === `www.${normB}` || normB === `www.${normA}`;
}

/**
 * Enforces REQ-065 per-website custom domain limits:
 * - At most 2 custom hostnames per website.
 * - Must belong to one domain name: `www.X` and/or `X`, or a single subdomain without a counterpart.
 */
export function assertTenantDomainSetCompatibility(
  existingCustomHostnames: readonly string[],
  candidateHostname: string,
): void {
  const normalizedCandidate = candidateHostname.trim().toLowerCase();
  const others = existingCustomHostnames
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== normalizedCandidate);

  if (others.length >= MAX_CUSTOM_HOSTNAMES_PER_TENANT) {
    throw new DomainConflictError(
      "DOMAIN_LIMIT_REACHED",
      `Maksimal ${MAX_CUSTOM_HOSTNAMES_PER_TENANT} custom hostname per website (misalnya domain utama dan versi www).`,
    );
  }

  if (others.length === 1 && !areDomainCounterparts(others[0]!, normalizedCandidate)) {
    throw new DomainConflictError(
      "DOMAIN_SET_MISMATCH",
      `Satu website hanya mendukung satu nama domain (pasangan ${others[0]} dan versi www/apex-nya).`,
    );
  }
}

/**
 * Enforces paid-website eligibility (DEC-035 C4 / REQ-043):
 * Trial websites CANNOT connect custom domains (`403 TRIAL_DOMAIN_FORBIDDEN`).
 */
export function assertTenantPaidForCustomDomain(tenantStatus: string): void {
  if (tenantStatus === "trial") {
    throw new DomainEligibilityError(
      "TRIAL_DOMAIN_FORBIDDEN",
      "Website masa percobaan (trial) tidak dapat menghubungkan custom domain. Aktifkan paket berbayar terlebih dahulu.",
    );
  }
}

/**
 * Checks whether any observed authoritative NS record belongs to Cloudflare
 * (`*.ns.cloudflare.com`), used solely as a non-authorizing setup hint (PLAN §3.2).
 */
export function isCloudflareNameserver(nameservers?: readonly string[] | null): boolean {
  if (!nameservers || nameservers.length === 0) return false;
  return nameservers.some((ns) => {
    const cleaned = ns.trim().toLowerCase().replace(/\.+$/, "");
    return cleaned.endsWith(".ns.cloudflare.com") || cleaned === "ns.cloudflare.com";
  });
}

export interface ApexCapabilityEvaluationInput {
  readonly hostname: string;
  readonly isLikelyApex?: boolean;
  readonly connectMode?: DomainConnectMode;
  readonly confirmApexFlattening?: boolean;
  readonly providerSupportsApex?: boolean;
  readonly nameservers?: readonly string[];
}

export interface ApexCapabilityEvaluation {
  readonly isApex: boolean;
  readonly supported: boolean;
  readonly reasonCode:
    | "NOT_APEX"
    | "APEX_SUPPORTED"
    | "APEX_UNSUPPORTED_CAPABILITY"
    | "APEX_FLATTENING_UNCONFIRMED";
  readonly messageId: string | null;
  readonly suggestedWwwHostname: string | null;
  readonly cloudflareNameserverDetected: boolean;
}

/**
 * Evaluates apex/root domain setup capability before creating a custom hostname (PLAN §3.1).
 * Never tells users to create a standards-invalid apex CNAME, guess IP addresses, or change nameservers.
 */
export function evaluateApexCapability(
  input: ApexCapabilityEvaluationInput,
): ApexCapabilityEvaluation {
  const normalized = input.hostname.trim().toLowerCase().replace(/\.$/, "");
  const isApex = input.isLikelyApex ?? isApexDomainHostname(normalized);
  const cloudflareNameserverDetected = isCloudflareNameserver(input.nameservers);
  if (!isApex) {
    return {
      isApex: false,
      supported: true,
      reasonCode: "NOT_APEX",
      messageId: null,
      suggestedWwwHostname: null,
      cloudflareNameserverDetected,
    };
  }

  const suggestedWwwHostname = normalized.startsWith("www.") ? null : `www.${normalized}`;

  if (input.providerSupportsApex === false) {
    return {
      isApex: true,
      supported: false,
      reasonCode: "APEX_UNSUPPORTED_CAPABILITY",
      messageId:
        `Penyedia/paket domain saat ini belum mendukung proxying root/apex domain (${normalized}) tanpa CNAME flattening/ALIAS. Gunakan ${suggestedWwwHostname ?? normalized} sebagai domain utama, lalu atur pengalihan apex-ke-www di registrar Anda.`,
      suggestedWwwHostname,
      cloudflareNameserverDetected,
    };
  }

  const requiresExplicitConfirm =
    input.confirmApexFlattening === false ||
    (input.connectMode === "new_domain" && input.confirmApexFlattening !== true);

  if (requiresExplicitConfirm) {
    return {
      isApex: true,
      supported: false,
      reasonCode: "APEX_FLATTENING_UNCONFIRMED",
      messageId:
        `Domain root/apex (${normalized}) hanya dapat dihubungkan jika penyedia DNS Anda mendukung CNAME flattening, ALIAS, atau ANAME. Konfirmasi dukungan DNS Anda atau gunakan ${suggestedWwwHostname ?? normalized} sebagai domain utama.`,
      suggestedWwwHostname,
      cloudflareNameserverDetected,
    };
  }

  return {
    isApex: true,
    supported: true,
    reasonCode: "APEX_SUPPORTED",
    messageId:
      `Pastikan penyedia DNS Anda mendukung CNAME flattening/ALIAS/ANAME untuk ${normalized}; jika tidak, gunakan ${suggestedWwwHostname ?? normalized} sebagai domain utama.`,
    suggestedWwwHostname,
    cloudflareNameserverDetected,
  };
}

export interface ConnectSituationInput {
  readonly hasLiveSite: boolean;
  readonly usesCloudflareNameservers: boolean;
}

export function suggestConnectModeFromSituation(input: ConnectSituationInput): DomainConnectMode {
  if (input.usesCloudflareNameservers) {
    return "cloudflare_o2o";
  }
  if (input.hasLiveSite) {
    return "zero_downtime_migration";
  }
  return "new_domain";
}

export interface TenantDomainCapabilityInput {
  readonly id: number;
  readonly hostname: string;
  readonly kind: "subdomain" | "custom";
  readonly status: string;
  readonly sslStatus: string;
  readonly isPrimary: boolean;
  readonly isLocked: boolean;
}

export interface PerDomainActionEligibility {
  readonly id: number;
  readonly hostname: string;
  readonly canRecheck: boolean;
  readonly canMakePrimary: boolean;
  readonly canOwnerRemove: boolean;
  readonly lockedAfterActivation: boolean;
}

export interface TenantDomainSetCapabilities {
  readonly customCount: number;
  readonly maxCustomHostnames: typeof MAX_CUSTOM_HOSTNAMES_PER_TENANT;
  readonly customDomainLocked: boolean;
  readonly canAddMoreCustomHostnames: boolean;
  readonly suggestedCounterpartHostname: string | null;
  readonly domains: readonly PerDomainActionEligibility[];
}

/**
 * Evaluates REQ-065 2-hostname counterpart rules, post-activation lock,
 * and per-domain eligibility (counterpart add & primary switch remain allowed while locked!).
 */
export function evaluateTenantDomainSetCapabilities(
  items: readonly TenantDomainCapabilityInput[],
): TenantDomainSetCapabilities {
  const customItems = items.filter((item) => item.kind === "custom");
  const customCount = customItems.length;
  const customDomainLocked = customItems.some(
    (item) => item.isLocked || item.status === "active",
  );
  const canAddMoreCustomHostnames = customCount < MAX_CUSTOM_HOSTNAMES_PER_TENANT;

  let suggestedCounterpartHostname: string | null = null;
  if (customCount === 1) {
    const existing = customItems[0]!.hostname.trim().toLowerCase().replace(/\.$/, "");
    const labels = existing.split(".");
    if (labels[0] === "www" && labels.length >= 3) {
      const stripped = labels.slice(1).join(".");
      if (isApexDomainHostname(stripped)) {
        suggestedCounterpartHostname = stripped;
      }
    } else if (isApexDomainHostname(existing)) {
      suggestedCounterpartHostname = `www.${existing}`;
    }
  }

  const domains: PerDomainActionEligibility[] = items.map((item) => {
    const isCustom = item.kind === "custom";
    const isDeleting = item.status === "disabled" || item.status === "deleting";
    const lockedAfterActivation = isCustom && (item.isLocked || item.status === "active");
    const canRecheck = isCustom && !isDeleting;
    const canMakePrimary =
      !item.isPrimary &&
      item.status === "active" &&
      (item.kind === "subdomain" || item.sslStatus === "active");
    // Owner may remove ONLY before activation; active domains are locked (REQ-065)
    const canOwnerRemove = isCustom && !lockedAfterActivation && !isDeleting;

    return {
      id: item.id,
      hostname: item.hostname,
      canRecheck,
      canMakePrimary,
      canOwnerRemove,
      lockedAfterActivation,
    };
  });

  return {
    customCount,
    maxCustomHostnames: MAX_CUSTOM_HOSTNAMES_PER_TENANT,
    customDomainLocked,
    canAddMoreCustomHostnames,
    suggestedCounterpartHostname,
    domains,
  };
}
