import { DomainProviderError, type DomainSslMethod } from "./validation.ts";

/**
 * Cloudflare for SaaS Custom Hostnames REST API client with injectable `fetch`
 * (REQ-004, PLAN §3.2 & §12.2).
 *
 * Security invariants:
 * - Zone-scoped Bearer token is NEVER logged or included in error messages.
 * - Leaves `certificate_authority` unset on create so Cloudflare honors CAA & default CA selection.
 * - Automatically re-fetches via `GET` after `POST` when `ssl.validation_records` is initially empty.
 * - Supports `findCustomHostnameByName` so timeout/5xx retries reconcile existing provider records
 *   instead of creating duplicates.
 * - Supports documented `PATCH /custom_hostnames/:id` with current `ssl` settings for "Periksa sekarang".
 */

export const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4" as const;
export const DEFAULT_CLOUDFLARE_TIMEOUT_MS = 10_000 as const;

export interface CloudflareOwnershipVerificationTxt {
  readonly type: "txt";
  readonly name: string;
  readonly value: string;
}

export interface CloudflareOwnershipVerificationHttp {
  readonly http_url: string;
  readonly http_body: string;
}

export interface CloudflareSslValidationRecord {
  readonly status?: string;
  readonly txt_name?: string;
  readonly txt_value?: string;
  readonly http_url?: string;
  readonly http_body?: string;
  readonly cname?: string;
  readonly cname_target?: string;
}

export interface CloudflareDcvDelegationRecord {
  readonly cname?: string;
  readonly cname_target?: string;
}

export interface CloudflareSslValidationError {
  readonly message: string;
}

export interface CloudflareCustomHostnameSsl {
  readonly id?: string;
  readonly status: string;
  readonly method: string;
  readonly type: string;
  readonly certificate_authority?: string;
  readonly validation_records?: readonly CloudflareSslValidationRecord[];
  readonly dcv_delegation_records?: readonly CloudflareDcvDelegationRecord[];
  readonly validation_errors?: readonly CloudflareSslValidationError[];
  readonly settings?: {
    readonly min_tls_version?: string;
    readonly http2?: string;
    readonly tls_1_3?: string;
  };
}

export interface CloudflareCustomHostname {
  readonly id: string;
  readonly hostname: string;
  readonly status: string;
  readonly verification_errors?: readonly string[];
  readonly ownership_verification?: CloudflareOwnershipVerificationTxt;
  readonly ownership_verification_http?: CloudflareOwnershipVerificationHttp;
  readonly ssl: CloudflareCustomHostnameSsl;
  readonly created_at?: string;
}

export interface CloudflareCustomHostnameQuota {
  readonly allocated: number;
  readonly used: number;
}

export interface CreateCustomHostnameInput {
  readonly hostname: string;
  readonly sslMethod: DomainSslMethod;
  readonly minTlsVersion?: "1.2" | "1.3";
  /** If true (default), performs a follow-up GET when POST omits `ssl.validation_records`. */
  readonly refetchIfValidationRecordsEmpty?: boolean;
}

export interface PatchCustomHostnameSslInput {
  readonly method: DomainSslMethod;
  readonly type?: "dv";
  readonly minTlsVersion?: "1.2" | "1.3";
}

export interface CloudflareSaasClient {
  createCustomHostname(input: CreateCustomHostnameInput): Promise<CloudflareCustomHostname>;
  getCustomHostname(customHostnameId: string): Promise<CloudflareCustomHostname>;
  findCustomHostnameByName(hostname: string): Promise<CloudflareCustomHostname | null>;
  patchCustomHostnameSsl(
    customHostnameId: string,
    ssl: PatchCustomHostnameSslInput,
  ): Promise<CloudflareCustomHostname>;
  deleteCustomHostname(
    customHostnameId: string,
  ): Promise<{ readonly id: string; readonly deleted: boolean; readonly alreadyAbsent: boolean }>;
  getCustomHostnameQuota(): Promise<CloudflareCustomHostnameQuota>;
}

export interface CreateCloudflareSaasClientOptions {
  readonly zoneId: string;
  readonly apiToken: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface CloudflareEnvelope<T> {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: ReadonlyArray<{ readonly code?: number; readonly message?: string }>;
}

function sanitizeBaseUrl(raw?: string): string {
  const base = (raw ?? DEFAULT_CLOUDFLARE_API_BASE_URL).trim().replace(/\/+$/, "");
  if (!base) {
    throw new DomainProviderError(
      "config_error",
      "URL API Cloudflare for SaaS belum dikonfigurasi.",
      { retryable: false },
    );
  }
  return base;
}

function isAbortOrTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  return (
    name === "aborterror" ||
    name === "timeouterror" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("aborted")
  );
}

function parseCustomHostnameResult(raw: unknown): CloudflareCustomHostname {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DomainProviderError(
      "invalid_response",
      "Respons Cloudflare Custom Hostname tidak valid.",
      { retryable: false },
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.id !== "string" ||
    obj.id.trim().length === 0 ||
    typeof obj.hostname !== "string" ||
    obj.hostname.trim().length === 0 ||
    typeof obj.status !== "string"
  ) {
    throw new DomainProviderError(
      "invalid_response",
      "Respons Cloudflare Custom Hostname kehilangan field wajib (id/hostname/status).",
      { retryable: false },
    );
  }

  const rawSsl =
    obj.ssl && typeof obj.ssl === "object" && !Array.isArray(obj.ssl)
      ? (obj.ssl as Record<string, unknown>)
      : {};

  const ssl: CloudflareCustomHostnameSsl = {
    ...(typeof rawSsl.id === "string" ? { id: rawSsl.id } : {}),
    status: typeof rawSsl.status === "string" ? rawSsl.status : "pending_validation",
    method: typeof rawSsl.method === "string" ? rawSsl.method : "http",
    type: typeof rawSsl.type === "string" ? rawSsl.type : "dv",
    ...(typeof rawSsl.certificate_authority === "string"
      ? { certificate_authority: rawSsl.certificate_authority }
      : {}),
    ...(Array.isArray(rawSsl.validation_records)
      ? { validation_records: rawSsl.validation_records as readonly CloudflareSslValidationRecord[] }
      : {}),
    ...(Array.isArray(rawSsl.dcv_delegation_records)
      ? {
          dcv_delegation_records:
            rawSsl.dcv_delegation_records as readonly CloudflareDcvDelegationRecord[],
        }
      : {}),
    ...(Array.isArray(rawSsl.validation_errors)
      ? { validation_errors: rawSsl.validation_errors as readonly CloudflareSslValidationError[] }
      : {}),
    ...(rawSsl.settings && typeof rawSsl.settings === "object"
      ? {
          settings: rawSsl.settings as CloudflareCustomHostnameSsl["settings"],
        }
      : {}),
  };

  return {
    id: obj.id.trim(),
    hostname: obj.hostname.trim().toLowerCase(),
    status: obj.status.trim().toLowerCase(),
    ...(Array.isArray(obj.verification_errors)
      ? {
          verification_errors: obj.verification_errors.filter(
            (e): e is string => typeof e === "string",
          ),
        }
      : {}),
    ...(obj.ownership_verification && typeof obj.ownership_verification === "object"
      ? {
          ownership_verification: obj.ownership_verification as CloudflareOwnershipVerificationTxt,
        }
      : {}),
    ...(obj.ownership_verification_http && typeof obj.ownership_verification_http === "object"
      ? {
          ownership_verification_http:
            obj.ownership_verification_http as CloudflareOwnershipVerificationHttp,
        }
      : {}),
    ssl,
    ...(typeof obj.created_at === "string" ? { created_at: obj.created_at } : {}),
  };
}

export function createCloudflareSaasClient(
  options: CreateCloudflareSaasClientOptions,
): CloudflareSaasClient {
  const zoneId = options.zoneId.trim();
  const apiToken = options.apiToken.trim();
  if (!zoneId || !apiToken) {
    throw new DomainProviderError(
      "config_error",
      "Konfigurasi Cloudflare for SaaS (zoneId / apiToken) belum lengkap.",
      { retryable: false },
    );
  }

  const baseUrl = sanitizeBaseUrl(options.apiBaseUrl);
  const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? DEFAULT_CLOUDFLARE_TIMEOUT_MS));
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  async function requestCf<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly result: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/zones/${encodeURIComponent(zoneId)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortOrTimeoutError(err)) {
        throw new DomainProviderError(
          "timeout",
          "Permintaan ke penyedia domain (Cloudflare) melebihi batas waktu. Status domain tetap pending dan aman diulang.",
          { retryable: true, cause: err },
        );
      }
      throw new DomainProviderError(
        "upstream_5xx",
        "Gagal menghubungi penyedia domain (Cloudflare). Silakan coba lagi.",
        { retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    let envelope: CloudflareEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      // Non-JSON upstream error body; envelope stays null
    }

    const firstError = envelope?.errors?.[0];
    const providerErrorCode = typeof firstError?.code === "number" ? firstError.code : null;
    const safeProviderMsg = firstError?.message
      ? `Cloudflare API error${providerErrorCode ? ` (${providerErrorCode})` : ""}: ${firstError.message.slice(0, 200)}`
      : `Cloudflare API HTTP ${response.status}`;

    if (response.status === 404) {
      throw new DomainProviderError("not_found", safeProviderMsg, {
        statusCode: 404,
        retryable: false,
        providerErrorCode,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new DomainProviderError("auth_error", safeProviderMsg, {
        statusCode: response.status,
        retryable: false,
        providerErrorCode,
      });
    }
    if (response.status === 429) {
      throw new DomainProviderError("rate_limited", safeProviderMsg, {
        statusCode: 429,
        retryable: true,
        providerErrorCode,
      });
    }
    if (response.status >= 500) {
      throw new DomainProviderError("upstream_5xx", safeProviderMsg, {
        statusCode: response.status,
        retryable: true,
        providerErrorCode,
      });
    }
    if (!response.ok || envelope?.success === false || envelope?.result === undefined) {
      throw new DomainProviderError("bad_request", safeProviderMsg, {
        statusCode: response.status,
        retryable: false,
        providerErrorCode,
      });
    }

    return { status: response.status, result: envelope.result };
  }

  return {
    async createCustomHostname(input: CreateCustomHostnameInput): Promise<CloudflareCustomHostname> {
      const payload = {
        hostname: input.hostname.trim().toLowerCase(),
        ssl: {
          method: input.sslMethod,
          type: "dv" as const,
          settings: {
            min_tls_version: input.minTlsVersion ?? "1.2",
          },
        },
      };

      const { result } = await requestCf<unknown>("POST", "/custom_hostnames", payload);
      const created = parseCustomHostnameResult(result);

      // PLAN §3.2: POST may omit `ssl.validation_records` for a few seconds -> re-GET immediately.
      const shouldRefetch = input.refetchIfValidationRecordsEmpty !== false;
      const hasValidationRecords =
        (created.ssl.validation_records && created.ssl.validation_records.length > 0) ||
        (created.ssl.dcv_delegation_records && created.ssl.dcv_delegation_records.length > 0);

      if (shouldRefetch && !hasValidationRecords && created.ssl.status !== "active") {
        try {
          return await this.getCustomHostname(created.id);
        } catch {
          // Non-fatal: keep created snapshot so local row still persists `cf_custom_hostname_id`!
          return created;
        }
      }

      return created;
    },

    async getCustomHostname(customHostnameId: string): Promise<CloudflareCustomHostname> {
      const id = customHostnameId.trim();
      const { result } = await requestCf<unknown>(
        "GET",
        `/custom_hostnames/${encodeURIComponent(id)}`,
      );
      return parseCustomHostnameResult(result);
    },

    async findCustomHostnameByName(hostname: string): Promise<CloudflareCustomHostname | null> {
      const normalized = hostname.trim().toLowerCase();
      const { result } = await requestCf<unknown>(
        "GET",
        `/custom_hostnames?hostname=${encodeURIComponent(normalized)}`,
      );
      if (!Array.isArray(result) || result.length === 0) {
        return null;
      }
      const match = result.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const h = (entry as Record<string, unknown>).hostname;
        return typeof h === "string" && h.trim().toLowerCase() === normalized;
      });
      return match ? parseCustomHostnameResult(match) : null;
    },

    async patchCustomHostnameSsl(
      customHostnameId: string,
      ssl: PatchCustomHostnameSslInput,
    ): Promise<CloudflareCustomHostname> {
      const id = customHostnameId.trim();
      const payload = {
        ssl: {
          method: ssl.method,
          type: ssl.type ?? "dv",
          settings: {
            min_tls_version: ssl.minTlsVersion ?? "1.2",
          },
        },
      };
      const { result } = await requestCf<unknown>(
        "PATCH",
        `/custom_hostnames/${encodeURIComponent(id)}`,
        payload,
      );
      return parseCustomHostnameResult(result);
    },

    async deleteCustomHostname(
      customHostnameId: string,
    ): Promise<{ readonly id: string; readonly deleted: boolean; readonly alreadyAbsent: boolean }> {
      const id = customHostnameId.trim();
      try {
        await requestCf<unknown>("DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
        return { id, deleted: true, alreadyAbsent: false };
      } catch (err) {
        if (err instanceof DomainProviderError && err.kind === "not_found") {
          return { id, deleted: true, alreadyAbsent: true };
        }
        throw err;
      }
    },

    async getCustomHostnameQuota(): Promise<CloudflareCustomHostnameQuota> {
      const { result } = await requestCf<unknown>("GET", "/custom_hostnames/quota");
      if (!result || typeof result !== "object") {
        throw new DomainProviderError(
          "invalid_response",
          "Respons kuota custom hostname Cloudflare tidak valid.",
          { retryable: false },
        );
      }
      const obj = result as Record<string, unknown>;
      const allocated = typeof obj.allocated === "number" ? obj.allocated : 0;
      const used = typeof obj.used === "number" ? obj.used : 0;
      return { allocated, used };
    },
  };
}
