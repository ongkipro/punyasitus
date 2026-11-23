import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import {
  DEFAULT_SAAS_CNAME_TARGET,
  DomainConflictError,
  DomainEligibilityError,
  DomainMarkerConfigError,
  DomainNotFoundError,
  DomainProviderError,
  DomainRateLimitError,
  DomainValidationError,
  FORBIDDEN_DOMAIN_BODY_KEYS,
  buildConnectInstructions,
  buildPostActivationCleanupGuidance,
  createCloudflareDohDnsResolver,
  createCloudflareSaasClient,
  createFetchHttpsProbe,
  doesCnameMatchTarget,
  isCloudflareNameserver,
  resolveDomainMarkerSecret,
  type CloudflareCustomHostname,
  type CloudflareSaasClient,
  type ConnectModeInstructionPlan,
  type DnsObservationSnapshot,
  type DnsResolverPort,
  type DomainConnectMode,
  type DomainSslMethod,
  type HttpsProbePort,
} from "@punyasitus/core/domains/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import type { ApiErrorCode } from "@punyasitus/core/schemas";
import type {
  DomainRecheckRateLimitPolicy,
  TenantDomainRecord,
} from "@punyasitus/db/domains/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared security, auth, RBAC, host-isolation, strict JSON parsing, Cloudflare client wiring,
 * DNS/HTTPS probe resolution, and response formatting for `/api/tenants/:tenantId/domains/**`
 * (TASK-003; REQ-004, REQ-034, REQ-042, REQ-043, PLAN §3.1-3.2).
 */

export const MAX_DOMAINS_BODY_BYTES = 16_384 as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FORBIDDEN_DOMAIN_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_DOMAIN_BODY_KEYS);

export const PRIVATE_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface TenantDomainsRuntimeEnv extends AuthRuntimeEnv {
  readonly SAAS_ZONE?: string;
  readonly SAAS_CNAME_TARGET?: string;
  readonly CF_SAAS_ZONE_ID?: string;
  readonly CF_SAAS_API_TOKEN?: string;
  readonly CF_API_BASE_URL?: string;
  readonly CF_APEX_CAPABILITY_SUPPORTED?: string;
  readonly DOMAIN_MARKER_SECRET?: string;
}

export interface TenantDomainsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly cloudflareClient?: CloudflareSaasClient | null;
  readonly cloudflareFetch?: typeof fetch;
  readonly dnsResolver?: DnsResolverPort | null;
  readonly dnsFetch?: typeof fetch;
  readonly httpsProbe?: HttpsProbePort | null;
  readonly httpsProbeFetch?: typeof fetch;
  readonly recheckRateLimitPolicy?: Partial<DomainRecheckRateLimitPolicy>;
  readonly allowTestTlds?: boolean;
  /** Optional provider apex capability override for tests or gated plans. */
  readonly apexCapabilitySupported?: boolean;
  /** Test-only marker secret injection (strictly ignored outside APP_ENV=local|test). */
  readonly testMarkerSecret?: string;
}

export interface AuthorizedDomainsRequestContext {
  readonly requestId: string;
  readonly nowMs: number;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly cnameTarget: string;
  readonly platformDomain: string;
  readonly saasZone: string;
}

export function createDomainRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function domainsJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRIVATE_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function domainsErrorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extra?: {
    readonly reasonCode?: string;
    readonly fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[];
    readonly details?: Record<string, unknown>;
    readonly headers?: HeadersInit;
  },
): Response {
  return domainsJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(extra?.reasonCode ? { reasonCode: extra.reasonCode } : {}),
        ...(extra?.fields && extra.fields.length > 0 ? { fields: extra.fields } : {}),
      },
      ...(extra?.details ?? {}),
      requestId,
    },
    extra?.headers,
  );
}

export function resolveCnameTarget(runtimeEnv: TenantDomainsRuntimeEnv): string {
  const explicit = runtimeEnv.SAAS_CNAME_TARGET?.trim().toLowerCase().replace(/\.$/, "");
  if (explicit) return explicit;
  const zone = runtimeEnv.SAAS_ZONE?.trim().toLowerCase().replace(/\.$/, "");
  return zone ? `cname.${zone}` : DEFAULT_SAAS_CNAME_TARGET;
}

export function resolveCloudflareClient(
  runtimeEnv: TenantDomainsRuntimeEnv,
  options: TenantDomainsHandlerOptions = {},
): CloudflareSaasClient {
  if (options.cloudflareClient) {
    return options.cloudflareClient;
  }
  const zoneId = runtimeEnv.CF_SAAS_ZONE_ID?.trim() ?? "";
  const apiToken = runtimeEnv.CF_SAAS_API_TOKEN?.trim() ?? "";
  if (!zoneId || !apiToken) {
    throw new DomainProviderError(
      "config_error",
      "Integrasi Cloudflare for SaaS belum dikonfigurasi pada server ini.",
      { retryable: false },
    );
  }
  return createCloudflareSaasClient({
    zoneId,
    apiToken,
    apiBaseUrl: runtimeEnv.CF_API_BASE_URL,
    fetchImpl: options.cloudflareFetch,
  });
}

export function resolveDnsResolver(options: TenantDomainsHandlerOptions = {}): DnsResolverPort {
  if (options.dnsResolver) {
    return options.dnsResolver;
  }
  return createCloudflareDohDnsResolver({ fetchImpl: options.dnsFetch });
}

export function resolveHttpsProbe(options: TenantDomainsHandlerOptions = {}): HttpsProbePort {
  if (options.httpsProbe) {
    return options.httpsProbe;
  }
  return createFetchHttpsProbe({ fetchImpl: options.httpsProbeFetch });
}

export async function observeDnsForHostname(
  dnsResolver: DnsResolverPort | null | undefined,
  hostname: string,
): Promise<DnsObservationSnapshot | undefined> {
  if (!dnsResolver) return undefined;
  const acmeName = `_acme-challenge.${hostname}`;
  const labels = hostname.trim().toLowerCase().replace(/\.$/, "").split(".");
  const nsLookupHost = labels[0] === "www" && labels.length >= 3 ? labels.slice(1).join(".") : hostname;

  const [cnameTargets, acmeChallengeTxtRecords, acmeChallengeCnameTargets, caaRecords, nameservers] =
    await Promise.all([
      dnsResolver.resolveCname(hostname).catch(() => []),
      dnsResolver.resolveTxt(acmeName).catch(() => []),
      dnsResolver.resolveCname(acmeName).catch(() => []),
      dnsResolver.resolveCaa ? dnsResolver.resolveCaa(hostname).catch(() => []) : Promise.resolve([]),
      dnsResolver.resolveNs ? dnsResolver.resolveNs(nsLookupHost).catch(() => []) : Promise.resolve([]),
    ]);

  return {
    cnameTargets,
    acmeChallengeTxtRecords,
    acmeChallengeCnameTargets,
    caaRecords,
    nameservers,
  };
}

/**
 * Reconciles against an existing Cloudflare custom hostname (by ID or hostname lookup)
 * before creating a new one — preventing duplicate provider records after timeouts/retries.
 */
export async function reconcileOrCreateCloudflareHostname(
  cloudflareClient: CloudflareSaasClient,
  input: {
    readonly hostname: string;
    readonly cfCustomHostnameId: string | null;
    readonly sslMethod: DomainSslMethod;
  },
): Promise<{ readonly provider: CloudflareCustomHostname; readonly reconciledExisting: boolean }> {
  if (input.cfCustomHostnameId) {
    try {
      const existing = await cloudflareClient.getCustomHostname(input.cfCustomHostnameId);
      return { provider: existing, reconciledExisting: true };
    } catch (err) {
      if (!(err instanceof DomainProviderError && err.kind === "not_found")) {
        throw err;
      }
    }
  }

  const foundByName = await cloudflareClient.findCustomHostnameByName(input.hostname);
  if (foundByName) {
    return { provider: foundByName, reconciledExisting: true };
  }

  const created = await cloudflareClient.createCustomHostname({
    hostname: input.hostname,
    sslMethod: input.sslMethod,
  });
  return { provider: created, reconciledExisting: false };
}

function mapDomainApiStatus(record: TenantDomainRecord): string {
  if (record.kind === "subdomain") {
    return record.status === "active" ? "active" : "disabled";
  }
  if (record.status === "active" && record.sslStatus === "active") {
    return "active";
  }
  if (record.status === "failed" || record.providerStatus === "blocked") {
    return "failed";
  }
  if (record.status === "deleting" || record.status === "moved") {
    return "disabled";
  }
  if (record.providerStatus === "active" && record.providerSslStatus !== "active") {
    return "pending_ssl";
  }
  if (!record.cfCustomHostnameId) {
    return "requested";
  }
  return "pending_verification";
}

function mapDomainApiSslStatus(record: TenantDomainRecord): string {
  const raw = (record.providerSslStatus ?? record.sslStatus ?? "pending_validation")
    .trim()
    .toLowerCase();
  if (raw === "active") return "active";
  if (raw === "pending_issuance") return "pending_issuance";
  if (raw === "expired") return "expired";
  if (raw === "deleted") return "deleted";
  if (raw === "validation_timed_out" || raw === "failed") return "failed";
  return "pending_validation";
}

function deriveOwnershipStatus(record: TenantDomainRecord): "active" | "pending" | "error" {
  if (record.kind === "subdomain") {
    return record.status === "active" ? "active" : "error";
  }
  const raw = (record.providerStatus ?? record.status).trim().toLowerCase();
  if (raw === "active") return "active";
  if (raw === "blocked" || raw === "moved" || raw === "failed") return "error";
  return "pending";
}

function deriveTlsStatus(record: TenantDomainRecord): "active" | "pending" | "error" {
  if (record.kind === "subdomain") {
    return record.status === "active" ? "active" : "error";
  }
  const raw = (record.providerSslStatus ?? record.sslStatus).trim().toLowerCase();
  if (raw === "active") return "active";
  if (raw === "validation_timed_out" || raw === "failed" || raw === "expired" || raw === "deleted") {
    return "error";
  }
  return "pending";
}

export function formatDomainRecordResponse(
  record: TenantDomainRecord,
  options: {
    readonly cnameTarget: string;
    readonly dnsObservation?: DnsObservationSnapshot;
    readonly nowMs: number;
  },
): Record<string, unknown> {
  const mode: DomainConnectMode | null = record.kind === "custom" ? record.connectMode ?? "new_domain" : null;
  const sslMethod: DomainSslMethod = record.sslMethod ?? (mode === "zero_downtime_migration" ? "txt" : "http");

  let instructionPlan: ConnectModeInstructionPlan | null = null;
  if (record.kind === "custom" && mode) {
    instructionPlan = buildConnectInstructions({
      hostname: record.hostname,
      mode,
      sslMethod,
      cnameTarget: options.cnameTarget,
      provider: record.providerSnapshot,
      dns: options.dnsObservation ?? (record.dnsTargetObserved ? { cnameTargets: [record.dnsTargetObserved] } : undefined),
      tokenIssuedAtMs: record.tokenIssuedAt,
      nowMs: options.nowMs,
    });
  }

  const apiStatus = mapDomainApiStatus(record);
  const ownershipStatus = deriveOwnershipStatus(record);
  const tlsStatus = deriveTlsStatus(record);

  const cloudflareNameserverHint =
    record.kind === "custom" &&
    (mode === "cloudflare_o2o" || isCloudflareNameserver(options.dnsObservation?.nameservers));

  // Do NOT expose routing CNAME inside postActivationCleanup until the domain is fully active
  // (ownership + TLS active AND two-step migration cutover unlocked)!
  const postActivationCleanup =
    record.kind === "custom" &&
    mode &&
    instructionPlan &&
    apiStatus === "active" &&
    ownershipStatus === "active" &&
    tlsStatus === "active" &&
    !instructionPlan.cnameCutoverLocked
      ? buildPostActivationCleanupGuidance({
          hostname: record.hostname,
          mode,
          validationRecords: instructionPlan.validationRecords,
          cnameTarget: options.cnameTarget,
        })
      : null;

  return {
    id: record.id,
    hostname: record.hostname,
    kind: record.kind,
    mode,
    sslMethod: record.kind === "custom" ? sslMethod : null,
    cfCustomHostnameId: record.cfCustomHostnameId,
    status: apiStatus,
    hostStatus: record.status,
    sslStatus: mapDomainApiSslStatus(record),
    ownershipStatus,
    tlsStatus,
    providerStatus: record.providerStatus,
    providerSslStatus: record.providerSslStatus,
    certificateAuthority: record.certificateAuthority,
    dnsTargetObserved: record.dnsTargetObserved,
    httpsProbePassed: record.httpsProbePassed,
    isPrimary: record.isPrimary,
    isLocked: record.kind === "custom" && (record.everActivated || record.status === "active"),
    failureCode: record.failureCode,
    lastCheckedAt: record.lastCheckedAt ? new Date(record.lastCheckedAt).toISOString() : null,
    tokenIssuedAt: record.tokenIssuedAt ? new Date(record.tokenIssuedAt).toISOString() : null,
    tokenExpiresAt: instructionPlan?.tokenAge?.expiresAtIso ?? (record.tokenExpiresAt ? new Date(record.tokenExpiresAt).toISOString() : null),
    tokenAge: instructionPlan?.tokenAge ?? null,
    validationRecords: instructionPlan?.validationRecords ?? [],
    cloudflareNameserverHint,
    postActivationCleanup,
    instructions: instructionPlan
      ? {
          mode: instructionPlan.mode,
          sslMethod: instructionPlan.sslMethod,
          cnameTarget: instructionPlan.cnameTarget,
          createBeforeCnameSatisfied: instructionPlan.createBeforeCnameSatisfied,
          cnameCutoverLocked: instructionPlan.cnameCutoverLocked,
          readyForCutover: instructionPlan.readyForCutover,
          awaitingProviderTokens: instructionPlan.awaitingProviderTokens,
          steps: instructionPlan.steps,
          noticesId: instructionPlan.noticesId,
        }
      : null,
    remedies: instructionPlan?.remedies ?? [],
    version: record.version,
  };
}

/**
 * Enforces:
 * 1. Platform `app` host ONLY (returns neutral `404` on tenant/console/marketing hosts).
 * 2. Admin CSRF & Origin check on state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`).
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership & RBAC (`domain:read` / `domain:connect` / `domain:recheck` /
 *    `domain:make_primary` / `domain:remove_inactive`), cross-tenant neutral `404`, trial `403`,
 *    and `locked`/`suspended` write guard (`403 SUBSCRIPTION_LOCKED`).
 */
export async function authorizeTenantDomainsRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantDomainsRuntimeEnv,
  requiredPermission: Extract<
    PermissionAction,
    | "domain:read"
    | "domain:connect"
    | "domain:recheck"
    | "domain:make_primary"
    | "domain:remove_inactive"
  >,
  options: TenantDomainsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedDomainsRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createDomainRequestId();
  const nowMs = Math.trunc(options.nowMs ?? Date.now());

  // 1. Platform `app` host only (neutral 404 on tenant/console/marketing hosts)
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: domainsErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: domainsErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: domainsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        { headers: { "Retry-After": "60" } },
      ),
    };
  }

  // 4. Session verification + lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: domainsErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          { headers: { "Retry-After": "60" } },
        ),
      };
    }

    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
      });
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionResult.session.id,
          userId: sessionResult.user.id,
          surface: "app",
          pathname,
          nowMs,
        });
        if (lifetime.valid) {
          userId = sessionResult.user.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: domainsErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Autentikasi diperlukan untuk mengelola domain.",
        requestId,
      ),
    };
  }

  // 5. Live DB membership + RBAC + tenant lifecycle guard
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: domainsErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: domainsErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: domainsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { headers: { "Retry-After": "60" } },
      ),
    };
  }

  const platformDomain = (runtimeEnv.PLATFORM_DOMAIN ?? "punyasitus.com").trim().toLowerCase();
  const saasZone = (runtimeEnv.SAAS_ZONE ?? "situsku.click").trim().toLowerCase();
  const cnameTarget = resolveCnameTarget(runtimeEnv);

  return {
    ok: true,
    ctx: {
      requestId,
      nowMs,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      cnameTarget,
      platformDomain,
      saasZone,
    },
  };
}

function findNestedForbiddenDomainKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenDomainKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_DOMAIN_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findNestedForbiddenDomainKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictDomainsJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_DOMAINS_BODY_BYTES) {
    return {
      ok: false,
      response: domainsErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_DOMAINS_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (rawText.length === 0) {
    return {
      ok: false,
      response: domainsErrorResponse(400, "BAD_REQUEST", "Body JSON wajib diisi.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: domainsErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: domainsErrorResponse(
        400,
        "BAD_REQUEST",
        "Body permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenDomainKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: domainsErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field terlarang "${forbiddenPath}" tidak diperbolehkan pada permintaan domain.`,
        requestId,
        {
          reasonCode: "FORBIDDEN_FIELD",
          fields: [{ field: forbiddenPath, code: "FORBIDDEN_FIELD", message: "Field tidak diizinkan." }],
        },
      ),
    };
  }

  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      response: domainsErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field tidak dikenal tidak diperbolehkan: ${unknownKeys.join(", ")}.`,
        requestId,
        {
          reasonCode: "UNKNOWN_FIELD",
          fields: unknownKeys.map((field) => ({
            field,
            code: "UNKNOWN_FIELD",
            message: "Field tidak dikenal.",
          })),
        },
      ),
    };
  }

  return { ok: true, body: record };
}

export function mapDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof DomainValidationError) {
    return domainsErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
      ...(err.field
        ? { fields: [{ field: err.field, code: err.reasonCode, message: err.message }] }
        : {}),
    });
  }
  if (err instanceof DomainEligibilityError) {
    return domainsErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.code,
    });
  }
  if (err instanceof DomainConflictError) {
    return domainsErrorResponse(err.status, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
    });
  }
  if (err instanceof DomainNotFoundError) {
    return domainsErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof DomainRateLimitError) {
    return domainsErrorResponse(429, "RATE_LIMITED", err.message, requestId, {
      headers: { "Retry-After": String(err.retryAfterSeconds) },
    });
  }
  if (err instanceof DomainMarkerConfigError) {
    return domainsErrorResponse(503, err.code, err.message, requestId, {
      reasonCode: err.reasonCode,
    });
  }
  if (err instanceof DomainProviderError) {
    return domainsErrorResponse(503, "SERVICE_UNAVAILABLE", err.message, requestId, {
      reasonCode: `PROVIDER_${err.kind.toUpperCase()}`,
      headers: { "Retry-After": "15" },
    });
  }
  return domainsErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Terjadi kesalahan sementara saat memproses permintaan domain.",
    requestId,
  );
}

export { doesCnameMatchTarget, resolveDomainMarkerSecret };
