import { env } from "cloudflare:workers";
import {
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import type { CatalogOfferingType } from "@punyasitus/core/catalog/index";
import type { CloudflareSendEmailBinding, EmailPort } from "@punyasitus/core/email/index";
import {
  QrDraftNotAllowedError,
  QrValidationError,
  buildCanonicalQrTargetUrl,
  buildQrDownloadFilename,
  buildTenantQrApiUrl,
  renderQrPngBytes,
  renderQrSvg,
  type QrFormat,
  type QrTargetKind,
} from "@punyasitus/core/qr/index";
import {
  resolveVerifiedCanonicalOrigin,
  type SeoHostKind,
  type SeoHostStatus,
} from "@punyasitus/core/seo/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import type { APIRoute } from "astro";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Scoped Tenant Free QR Code API (`TASK-108`, `REQ-108`, `REQ-017`, `REQ-073`, `PLAN §20.5`):
 * `GET /api/tenants/:tenantId/qr?target=website|page|offering&id=<num>&format=svg|png|json&utm=1|0`
 *
 * Security & Isolation Invariants:
 * - Strictly `app`-host only (returns neutral `404` on marketing, console, and public tenant hosts).
 * - Verifies Better Auth session + lifetime ceiling + live `PLATFORM_DB` membership & `content:read` RBAC.
 * - Cross-tenant / non-member / purged tenants return neutral `404`; suspended/purging denied cleanly (`403`).
 * - Resolves the tenant's live verified active primary host from `PLATFORM_DB` (never raw `Host` header or
 *   client-supplied URL parameters), so switching primary domain immediately updates generated QR codes.
 * - Verifies target page/offering inside the tenant's own `TenantStore` (`status = 'published' AND deleted_at IS NULL`):
 *   drafts/unpublished return `409 DRAFT_QR_NOT_ALLOWED`; missing/trashed return `404 NOT_FOUND`.
 * - Generates SVG and PNG 100% in-Worker with zero external QR APIs.
 * - Emits `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`.
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d{0,9}$/;
const ALLOWED_QUERY_KEYS = new Set(["target", "id", "format", "utm"]);

const BASE_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface TenantQrRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantQrHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

interface RawTenantHostRow {
  readonly host: string;
  readonly kind: SeoHostKind;
  readonly status: SeoHostStatus;
  readonly ssl_status: string;
  readonly is_primary: number;
  readonly verified_at: number | null;
}

interface RawQrPageRow {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly is_homepage: number;
  readonly status: string;
  readonly deleted_at: number | null;
}

interface RawQrOfferingRow {
  readonly id: number;
  readonly offering_type: CatalogOfferingType;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly deleted_at: number | null;
}

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function qrJsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    ...BASE_SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function qrErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  return qrJsonResponse(
    status,
    {
      error: {
        code,
        message,
      },
      requestId,
    },
    extraHeaders,
  );
}

export function buildQrRuntimeEnv(): TenantQrRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

interface ParsedQrQuery {
  readonly target: QrTargetKind;
  readonly id: number | null;
  readonly format: QrFormat;
  readonly includeUtmQr: boolean;
}

function parseQrQueryParams(
  searchParams: URLSearchParams,
): { readonly ok: true; readonly query: ParsedQrQuery } | { readonly ok: false; readonly message: string } {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      return {
        ok: false,
        message: `Parameter kueri '${key}' tidak diizinkan pada endpoint kode QR.`,
      };
    }
  }

  const rawTarget = (searchParams.get("target") ?? "website").trim().toLowerCase();
  if (rawTarget !== "website" && rawTarget !== "page" && rawTarget !== "offering") {
    return {
      ok: false,
      message: 'Parameter target harus salah satu dari "website", "page", atau "offering".',
    };
  }

  const rawFormat = (searchParams.get("format") ?? "json").trim().toLowerCase();
  if (rawFormat !== "svg" && rawFormat !== "png" && rawFormat !== "json") {
    return {
      ok: false,
      message: 'Parameter format harus salah satu dari "svg", "png", atau "json".',
    };
  }

  const rawUtm = searchParams.get("utm");
  let includeUtmQr = false;
  if (rawUtm !== null && rawUtm.trim() !== "") {
    const normUtm = rawUtm.trim().toLowerCase();
    if (normUtm === "1" || normUtm === "true") {
      includeUtmQr = true;
    } else if (normUtm === "0" || normUtm === "false") {
      includeUtmQr = false;
    } else {
      return {
        ok: false,
        message: 'Parameter utm harus bernilai "1" atau "0".',
      };
    }
  }

  const rawId = searchParams.get("id");
  let parsedId: number | null = null;
  if (rawTarget === "page" || rawTarget === "offering") {
    const trimmedId = (rawId ?? "").trim();
    if (!POSITIVE_INT_PATTERN.test(trimmedId)) {
      return {
        ok: false,
        message: "Parameter id wajib berupa bilangan bulat positif untuk target halaman atau penawaran.",
      };
    }
    const numericId = Number(trimmedId);
    if (!Number.isSafeInteger(numericId) || numericId < 1 || numericId > 2_147_483_647) {
      return {
        ok: false,
        message: "Parameter id di luar rentang bilangan bulat yang diizinkan.",
      };
    }
    parsedId = numericId;
  }

  return {
    ok: true,
    query: {
      target: rawTarget,
      id: parsedId,
      format: rawFormat,
      includeUtmQr,
    },
  };
}

async function resolveLivePrimaryOrigin(
  platformDb: D1Database,
  member: AuthorizedTenantMember,
): Promise<string> {
  const result = await platformDb
    .prepare(
      `SELECT host, kind, status, ssl_status, is_primary, verified_at
       FROM tenant_hosts
       WHERE tenant_id = ?`,
    )
    .bind(member.tenantId)
    .all<RawTenantHostRow>();

  const rows = result.results ?? [];
  const verifiedHosts: string[] = [];
  let primaryRow: RawTenantHostRow | null = null;

  for (const row of rows) {
    const isActiveVerified =
      row.status === "active" &&
      row.ssl_status === "active" &&
      (row.kind === "subdomain" || row.verified_at !== null);
    if (isActiveVerified) {
      verifiedHosts.push(row.host);
      if (row.is_primary === 1) {
        primaryRow = row;
      }
    }
  }

  const resolved = resolveVerifiedCanonicalOrigin({
    tenantHandle: member.handle,
    tenantStatus: member.tenantStatus,
    primaryHost: primaryRow?.host ?? null,
    primaryHostKind: primaryRow?.kind,
    primaryHostStatus: primaryRow?.status,
    primaryHostSslStatus: primaryRow?.ssl_status,
    primaryHostVerified: primaryRow
      ? primaryRow.kind === "subdomain" || primaryRow.verified_at !== null
      : false,
    verifiedTenantHosts: verifiedHosts,
  });

  return resolved.origin;
}

export async function handleTenantQrRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantQrRuntimeEnv,
  options: TenantQrHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();

  // 1. Platform `app` host isolation (neutral 404 on marketing, console, or public tenant hosts)
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return qrErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId);
  }

  // 2. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return qrErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan basis data platform sementara tidak tersedia.",
      requestId,
      { "Retry-After": "60" },
    );
  }

  // 3. Resolve authenticated session user
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return qrErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Konfigurasi autentikasi belum lengkap.",
        requestId,
        { "Retry-After": "60" },
      );
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
          nowMs: options.nowMs,
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
    return qrErrorResponse(
      401,
      "UNAUTHENTICATED",
      "Autentikasi diperlukan untuk mengunduh kode QR tenant.",
      requestId,
    );
  }

  // 4. Live PLATFORM_DB membership + `content:read` RBAC + lifecycle check
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return qrErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId);
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission: "content:read",
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return qrErrorResponse(err.status, err.code, err.message, requestId);
    }
    return qrErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memverifikasi otorisasi tenant.",
      requestId,
      { "Retry-After": "60" },
    );
  }

  // 5. Enforce GET-only
  const method = request.method.toUpperCase();
  if (method !== "GET") {
    return qrErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint kode QR.",
      requestId,
      { Allow: "GET" },
    );
  }

  // 6. Validate query parameters strictly
  const url = new URL(request.url);
  const parsedQuery = parseQrQueryParams(url.searchParams);
  if (!parsedQuery.ok) {
    return qrErrorResponse(422, "VALIDATION_ERROR", parsedQuery.message, requestId);
  }
  const { target, id, format, includeUtmQr } = parsedQuery.query;

  // 7. Resolve live verified primary origin from PLATFORM_DB
  let primaryOrigin: string;
  try {
    primaryOrigin = await resolveLivePrimaryOrigin(runtimeEnv.PLATFORM_DB, member);
  } catch {
    return qrErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memuat domain utama situs.",
      requestId,
      { "Retry-After": "60" },
    );
  }

  // 8. Verify target publication status in TenantStore (for page / offering)
  let targetTitle = member.tenantName;
  let slug: string | null = null;
  let isHomepage = false;
  let offeringType: CatalogOfferingType | null = null;

  if (target === "page" || target === "offering") {
    let tenantDb: D1Database | null = null;
    if (options.resolveTenantDb) {
      tenantDb = await options.resolveTenantDb(member.tenantId);
    } else if (runtimeEnv.TENANT_STORE) {
      tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
    }

    if (!tenantDb) {
      return qrErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        { "Retry-After": "60" },
      );
    }

    if (target === "page") {
      const pageRow = await tenantDb
        .prepare(
          `SELECT id, slug, title, is_homepage, status, deleted_at
           FROM pages
           WHERE id = ?
           LIMIT 1`,
        )
        .bind(id)
        .first<RawQrPageRow>();

      if (!pageRow || pageRow.deleted_at !== null || pageRow.status === "trashed") {
        return qrErrorResponse(404, "NOT_FOUND", "Halaman tidak ditemukan.", requestId);
      }
      if (pageRow.status !== "published") {
        return qrErrorResponse(
          409,
          "DRAFT_QR_NOT_ALLOWED",
          "Kode QR tidak tersedia untuk draf atau halaman yang belum diterbitkan.",
          requestId,
        );
      }

      targetTitle = pageRow.title;
      slug = pageRow.slug;
      isHomepage = pageRow.is_homepage === 1;
    } else {
      const offeringRow = await tenantDb
        .prepare(
          `SELECT id, offering_type, slug, title, status, deleted_at
           FROM offerings
           WHERE id = ?
           LIMIT 1`,
        )
        .bind(id)
        .first<RawQrOfferingRow>();

      if (!offeringRow || offeringRow.deleted_at !== null || offeringRow.status === "trashed") {
        return qrErrorResponse(404, "NOT_FOUND", "Penawaran tidak ditemukan.", requestId);
      }
      if (offeringRow.status !== "published") {
        return qrErrorResponse(
          409,
          "DRAFT_QR_NOT_ALLOWED",
          "Kode QR tidak tersedia untuk draf atau penawaran yang belum diterbitkan.",
          requestId,
        );
      }

      targetTitle = offeringRow.title;
      slug = offeringRow.slug;
      offeringType = offeringRow.offering_type;
    }
  }

  // 9. Construct canonical URL and render requested format in-Worker
  let canonicalUrl: string;
  try {
    canonicalUrl = buildCanonicalQrTargetUrl({
      primaryOrigin,
      targetKind: target,
      offeringType,
      slug,
      isHomepage,
      status: "published",
      deletedAt: null,
      includeUtmQr,
    });
  } catch (err) {
    if (err instanceof QrDraftNotAllowedError) {
      return qrErrorResponse(err.status, err.code, err.message, requestId);
    }
    if (err instanceof QrValidationError) {
      return qrErrorResponse(err.status, err.code, err.message, requestId);
    }
    return qrErrorResponse(500, "INTERNAL_ERROR", "Gagal membentuk URL kanonik kode QR.", requestId);
  }

  const qrLabel = `Kode QR untuk ${targetTitle} (${canonicalUrl})`;

  if (format === "svg") {
    const svg = renderQrSvg(canonicalUrl, { label: qrLabel, pixelSize: 512 });
    const filename = buildQrDownloadFilename({
      targetKind: target,
      tenantHandle: member.handle,
      offeringType,
      slug,
      isHomepage,
      format: "svg",
    });
    return new Response(svg, {
      status: 200,
      headers: {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }

  if (format === "png") {
    const pngBytes = renderQrPngBytes(canonicalUrl);
    const filename = buildQrDownloadFilename({
      targetKind: target,
      tenantHandle: member.handle,
      offeringType,
      slug,
      isHomepage,
      format: "png",
    });
    return new Response(pngBytes.slice().buffer, {
      status: 200,
      headers: {
        ...BASE_SECURITY_HEADERS,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pngBytes.byteLength),
      },
    });
  }

  const svg = renderQrSvg(canonicalUrl, { label: qrLabel, pixelSize: 256 });
  const svgDownloadUrl = buildTenantQrApiUrl({
    tenantId: member.tenantId,
    targetKind: target,
    targetId: id,
    format: "svg",
    includeUtmQr,
  });
  const pngDownloadUrl = buildTenantQrApiUrl({
    tenantId: member.tenantId,
    targetKind: target,
    targetId: id,
    format: "png",
    includeUtmQr,
  });

  return qrJsonResponse(200, {
    canonicalUrl,
    primaryOrigin,
    targetKind: target,
    targetId: id,
    targetTitle,
    includeUtmQr,
    svg,
    svgDownloadUrl,
    pngDownloadUrl,
  });
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantQrRequest(params.tenantId ?? "", request, buildQrRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
