import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { CatalogValidationError } from "@punyasitus/core/catalog/index";
import {
  attachServiceConsultationToDraftSnapshotJson,
  attachServiceConsultationToPublishedSnapshotJson,
  extractServiceConsultationFromSnapshotJson,
  resolveServiceHeadlinePricing,
  ServiceValidationError,
  toCatalogServiceAttributes,
  validateServiceConsultationAttributes,
  type ServiceConsultationAttributes,
} from "@punyasitus/core/catalog/service";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  createCatalogOffering,
  getCatalogOfferingById,
  publishCatalogOffering,
  updateCatalogOffering,
  type StoredCatalogOffering,
} from "@punyasitus/db/catalog/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Pure Runtime-Agnostic Handler & Persistence Helpers for Professional Services API
 * (`apps/web/src/pages/dashboard/[handle]/catalog/services/_api-handler.ts`; TASK-035, REQ-030).
 *
 * Security & Persistence Invariants:
 * 1. Host isolation (`app` surface only -> neutral `404` on tenant/marketing/console hosts).
 * 2. CSRF & Origin validation (`assertAdminCsrfAndOrigin`).
 * 3. Better Auth session + lifetime ceiling + live `PLATFORM_DB` membership & tenant status
 *    matching `[handle]` (foreign tenant -> neutral `404`, locked -> `403`, missing RBAC -> `403`).
 * 4. Strict Zod `.strict()` validation via `validateServiceConsultationAttributes` (`422`).
 * 5. Optimistic concurrency control (`expectedVersion` -> `409`) AND strict `changes === 1`
 *    verification when persisting lossless `serviceConsultationV1` snapshot envelopes.
 * 6. Synchronizes offering `priceMode` / `price` with resolved visible pricing (`inquiry` -> `on_request` + `null`)
 *    and stores lossless `serviceConsultationV1` in `draft_snapshot_json._draftMetadata` (and on publish,
 *    in `published_snapshot_json` outer envelope).
 */

const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const MAX_SERVICES_API_BODY_BYTES = 131_072; // 128 KiB
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export interface DashboardServicesRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface DashboardServicesHandlerOptions {
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly authenticatedSessionId?: string | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function jsonRes(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.set(k, v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorRes(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
  extraHeaders?: HeadersInit,
): Response {
  return jsonRes(
    status,
    {
      error: {
        code,
        message,
        ...(extra ?? {}),
      },
      requestId,
    },
    extraHeaders,
  );
}

/**
 * Loads lossless `ServiceConsultationAttributes` for admin editing from `offerings.draft_snapshot_json`.
 */
export async function loadLosslessDraftServiceMap(
  tenantDb: D1Database,
  offeringIds: readonly number[],
): Promise<Map<number, ServiceConsultationAttributes>> {
  const map = new Map<number, ServiceConsultationAttributes>();
  if (offeringIds.length === 0) return map;
  const placeholders = offeringIds.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(
        `SELECT id, draft_snapshot_json
         FROM offerings
         WHERE offering_type = 'service' AND id IN (${placeholders})`,
      )
      .bind(...offeringIds)
      .all<{ readonly id: number; readonly draft_snapshot_json: string | null }>();
    for (const row of res.results) {
      const extracted = extractServiceConsultationFromSnapshotJson(row.draft_snapshot_json);
      if (extracted) {
        map.set(Number(row.id), extracted);
      }
    }
  } catch {
    // Graceful fallback to legacy `offering.attributes`
  }
  return map;
}

/**
 * Loads the frozen published `ServiceConsultationAttributes` strictly from
 * `offerings.published_snapshot_json` (NEVER reads unpublished draft columns!).
 */
export async function loadFrozenPublishedServiceBySlug(
  tenantDb: D1Database,
  slug: string,
): Promise<ServiceConsultationAttributes | null> {
  const cleanSlug = slug.trim();
  if (!cleanSlug) return null;
  try {
    const row = await tenantDb
      .prepare(
        `SELECT published_snapshot_json
         FROM offerings
         WHERE offering_type = 'service'
           AND slug = ?
           AND status = 'published'
           AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(cleanSlug)
      .first<{ readonly published_snapshot_json: string | null }>();
    return extractServiceConsultationFromSnapshotJson(row?.published_snapshot_json);
  } catch {
    return null;
  }
}

export async function persistLosslessDraftServiceEnvelope(
  tenantDb: D1Database,
  offeringId: number,
  expectedVersion: number,
  service: ServiceConsultationAttributes,
): Promise<void> {
  const row = await tenantDb
    .prepare(`SELECT draft_snapshot_json FROM offerings WHERE id = ? AND version = ? LIMIT 1`)
    .bind(offeringId, expectedVersion)
    .first<{ readonly draft_snapshot_json: string | null }>();
  if (!row) {
    throw new CatalogConflictError(
      "Versi layanan berubah secara bersamaan saat menyimpan draf. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
  const nextDraftJson = attachServiceConsultationToDraftSnapshotJson(
    row.draft_snapshot_json,
    service,
  );
  const res = await tenantDb
    .prepare(`UPDATE offerings SET draft_snapshot_json = ? WHERE id = ? AND version = ?`)
    .bind(nextDraftJson, offeringId, expectedVersion)
    .run();
  if (Number(res.meta?.changes ?? 0) !== 1) {
    throw new CatalogConflictError(
      "Konflik versi saat memperbarui snapshot draf layanan. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
}

export async function persistLosslessPublishedServiceEnvelope(
  tenantDb: D1Database,
  offeringId: number,
  expectedVersion: number,
  service: ServiceConsultationAttributes,
): Promise<void> {
  const row = await tenantDb
    .prepare(
      `SELECT draft_snapshot_json, published_snapshot_json FROM offerings WHERE id = ? AND version = ? LIMIT 1`,
    )
    .bind(offeringId, expectedVersion)
    .first<{
      readonly draft_snapshot_json: string | null;
      readonly published_snapshot_json: string | null;
    }>();
  if (!row) {
    throw new CatalogConflictError(
      "Versi layanan berubah secara bersamaan saat memublikasikan snapshot. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
  const nextDraftJson = attachServiceConsultationToDraftSnapshotJson(
    row.draft_snapshot_json,
    service,
  );
  const nextPublishedJson = attachServiceConsultationToPublishedSnapshotJson(
    row.published_snapshot_json,
    service,
  );
  if (!nextPublishedJson) {
    throw new CatalogConflictError(
      "Snapshot publikasi layanan tidak valid. Muat ulang dan coba lagi.",
      { code: "CONFLICT", expectedVersion },
    );
  }
  const res = await tenantDb
    .prepare(
      `UPDATE offerings
       SET draft_snapshot_json = ?, published_snapshot_json = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(nextDraftJson, nextPublishedJson, offeringId, expectedVersion)
    .run();
  if (Number(res.meta?.changes ?? 0) !== 1) {
    throw new CatalogConflictError(
      "Konflik versi saat menyimpan snapshot publikasi layanan. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
}

export async function handleDashboardServicesApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: DashboardServicesRuntimeEnv,
  options: DashboardServicesHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();
  const method = request.method.toUpperCase();
  const normalizedHandle = rawHandle.trim().toLowerCase();

  // 1. Host isolation (`app` surface only)
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app" || !HANDLE_RE.test(normalizedHandle)) {
    return errorRes(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId);
  }

  if (method !== "POST") {
    return errorRes(
      405,
      "BAD_REQUEST",
      "Metode HTTP harus POST untuk endpoint pengelola layanan profesional.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  // 2. CSRF & Origin enforcement
  const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
  if (!csrf.ok) {
    return errorRes(csrf.status, csrf.code, csrf.reason, requestId);
  }

  // 3. Fail-closed PLATFORM_DB check
  if (!runtimeEnv.PLATFORM_DB) {
    return errorRes(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan basis data platform sementara tidak tersedia.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }

  // 4. Authenticate session + enforce session lifetime ceiling BEFORE parsing/validating body
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;
  const pathname = new URL(request.url).pathname.toLowerCase();

  if (userId && options.authenticatedSessionId) {
    try {
      const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
        sessionId: options.authenticatedSessionId,
        userId,
        surface: "app",
        pathname,
        nowMs: options.nowMs,
      });
      if (!lifetime.valid) {
        userId = null;
        activeOrganizationId = null;
      }
    } catch {
      return errorRes(503, "SERVICE_UNAVAILABLE", "Verifikasi sesi sementara tidak tersedia.", requestId);
    }
  } else if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return errorRes(503, "SERVICE_UNAVAILABLE", "Konfigurasi autentikasi belum lengkap.", requestId);
    }
    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, null),
      });
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
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
      return errorRes(503, "SERVICE_UNAVAILABLE", "Verifikasi sesi sementara tidak tersedia.", requestId);
    }
  }

  if (!userId) {
    return errorRes(401, "UNAUTHENTICATED", "Sesi login diperlukan.", requestId);
  }

  // 5. Parse JSON body strictly & validate `action`
  let rawBody: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SERVICES_API_BODY_BYTES) {
      return errorRes(413, "PAYLOAD_TOO_LARGE", "Ukuran payload terlalu besar.", requestId);
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorRes(400, "BAD_REQUEST", "Body JSON harus berupa objek.", requestId);
    }
    rawBody = parsed as Record<string, unknown>;
  } catch {
    return errorRes(400, "BAD_REQUEST", "Body JSON tidak valid.", requestId);
  }

  const action =
    rawBody.action === "publish"
      ? "publish"
      : rawBody.action === "save_draft"
        ? "save_draft"
        : null;
  if (!action) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      'Aksi harus berupa "save_draft" atau "publish".',
      requestId,
    );
  }

  // 6. Verify live tenant membership + RBAC + lifecycle

  const requiredPermission: PermissionAction =
    action === "publish" ? "content:publish" : "content:write";

  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      handle: normalizedHandle,
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return errorRes(err.status, err.code, err.message, requestId);
    }
    return errorRes(404, "NOT_FOUND", "Workspace tidak ditemukan.", requestId);
  }

  if (member.handle.toLowerCase() !== normalizedHandle) {
    return errorRes(404, "NOT_FOUND", "Workspace tidak ditemukan.", requestId);
  }

  if (member.tenantStatus === "locked") {
    return errorRes(
      403,
      "TENANT_LOCKED",
      "Situs sedang dalam status terkunci (read-only). Selesaikan perpanjangan untuk menyimpan perubahan.",
      requestId,
    );
  }

  // 6. Open isolated TenantStore DB
  let tenantDb: D1Database;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  } else {
    return errorRes(503, "SERVICE_UNAVAILABLE", "Penyimpanan tenant sementara tidak tersedia.", requestId);
  }

  // 7. Strict title & structured `service` validation
  const title = typeof rawBody.title === "string" ? rawBody.title.trim() : "";
  if (!title || title.length > 200) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Judul layanan profesional wajib diisi (maks. 200 karakter).",
      requestId,
      { fields: [{ field: "title", code: "INVALID_TITLE", message: "Judul layanan wajib diisi." }] },
    );
  }

  const summary =
    typeof rawBody.summary === "string" && rawBody.summary.trim()
      ? rawBody.summary.trim().slice(0, 500)
      : null;

  const rawService = rawBody.service;
  if (!rawService || typeof rawService !== "object" || Array.isArray(rawService)) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Objek atribut layanan (`service`) wajib diisi.",
      requestId,
    );
  }

  let validatedService: ServiceConsultationAttributes;
  try {
    validatedService = validateServiceConsultationAttributes(rawService);
  } catch (err) {
    if (err instanceof ServiceValidationError) {
      return errorRes(422, "VALIDATION_ERROR", err.message, requestId, {
        fields: err.fields,
      });
    }
    throw err;
  }

  // Resolve synchronized offering headline pricing (strictly refuses missing numeric price on fixed/from!)
  const headlinePricing = resolveServiceHeadlinePricing(validatedService);
  if (validatedService.pricingMode !== "inquiry" && headlinePricing.priceIdr === null) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Layanan mode 'Mulai dari' atau 'Harga Tetap' wajib memiliki nominal harga dasar atau minimal satu paket berharga Rupiah.",
      requestId,
      {
        fields: [
          {
            field: "basePriceIdr",
            code: "MISSING_SERVICE_PRICE",
            message:
              "Isi harga dasar (Rp) atau tambahkan minimal satu paket dengan nominal harga Rupiah.",
          },
        ],
      },
    );
  }

  const legacyServiceAttributes = toCatalogServiceAttributes(validatedService);
  const offeringId =
    typeof rawBody.id === "number" && Number.isSafeInteger(rawBody.id) && rawBody.id >= 1
      ? rawBody.id
      : null;
  const expectedVersion =
    typeof rawBody.expectedVersion === "number" &&
    Number.isSafeInteger(rawBody.expectedVersion) &&
    rawBody.expectedVersion >= 1
      ? rawBody.expectedVersion
      : null;

  const specialistPhoneOverride = validatedService.specialistCta?.whatsappNumber ?? null;

  try {
    let saved: StoredCatalogOffering;
    if (offeringId === null) {
      saved = await createCatalogOffering(
        tenantDb,
        {
          offeringType: "service",
          title,
          summary,
          priceMode: headlinePricing.catalogPriceMode,
          price: headlinePricing.priceIdr,
          ctaMode: "whatsapp",
          whatsappOverride: specialistPhoneOverride,
          attributes: legacyServiceAttributes,
        },
        { nowMs: options.nowMs, actorUserId: member.userId },
      );
    } else {
      if (expectedVersion === null) {
        return errorRes(
          422,
          "VALIDATION_ERROR",
          "expectedVersion wajib diisi saat memperbarui layanan.",
          requestId,
        );
      }
      const existing = await getCatalogOfferingById(tenantDb, offeringId);
      if (!existing || existing.offeringType !== "service") {
        return errorRes(404, "NOT_FOUND", "Layanan tidak ditemukan.", requestId);
      }
      saved = await updateCatalogOffering(
        tenantDb,
        offeringId,
        {
          title,
          summary,
          priceMode: headlinePricing.catalogPriceMode,
          price: headlinePricing.priceIdr,
          ctaMode: "whatsapp",
          whatsappOverride: specialistPhoneOverride,
          attributes: legacyServiceAttributes,
        },
        {
          expectedVersion,
          nowMs: options.nowMs,
          actorUserId: member.userId,
        },
      );
    }

    await persistLosslessDraftServiceEnvelope(tenantDb, saved.id, saved.version, validatedService);

    if (action === "publish") {
      const pub = await publishCatalogOffering(runtimeEnv.PLATFORM_DB, tenantDb, {
        tenantId: member.tenantId,
        offeringId: saved.id,
        expectedVersion: saved.version,
        actorUserId: member.userId,
        nowMs: options.nowMs,
      });
      await persistLosslessPublishedServiceEnvelope(
        tenantDb,
        pub.offering.id,
        pub.offering.version,
        validatedService,
      );
      return jsonRes(200, {
        id: pub.offering.id,
        slug: pub.offering.slug,
        publicPath: pub.offering.publicPath,
        title: pub.offering.title,
        summary: pub.offering.summary ?? "",
        priceMode: pub.offering.priceMode,
        price: pub.offering.price,
        priceMax: pub.offering.priceMax,
        status: pub.offering.status,
        version: pub.offering.version,
        attributes: validatedService,
      });
    }

    return jsonRes(offeringId === null ? 201 : 200, {
      id: saved.id,
      slug: saved.slug,
      publicPath: saved.publicPath,
      title: saved.title,
      summary: saved.summary ?? "",
      priceMode: saved.priceMode,
      price: saved.price,
      priceMax: saved.priceMax,
      status: saved.status,
      version: saved.version,
      attributes: validatedService,
    });
  } catch (err) {
    if (err instanceof CatalogNotFoundError) {
      return errorRes(404, "NOT_FOUND", err.message, requestId);
    }
    if (err instanceof CatalogConflictError) {
      return errorRes(409, err.code, err.message, requestId);
    }
    if (err instanceof CatalogValidationError) {
      return errorRes(422, "VALIDATION_ERROR", err.message, requestId, {
        fields: err.fields,
      });
    }
    throw err;
  }
}
