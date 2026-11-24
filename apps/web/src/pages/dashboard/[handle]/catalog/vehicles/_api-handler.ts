import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  canPerform,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { CatalogValidationError } from "@punyasitus/core/catalog/index";
import {
  attachVehicleShowroomToDraftSnapshotJson,
  attachVehicleShowroomToPublishedSnapshotJson,
  extractVehicleShowroomFromSnapshotJson,
  toCatalogVehicleAttributes,
  toCatalogVehiclePricing,
  validateVehicleShowroomAttributes,
  VehicleValidationError,
  type VehicleShowroomAttributes,
} from "@punyasitus/core/catalog/vehicle";
import { buildPublishedSnapshot, PublicationAtomicError } from "@punyasitus/core/content/index";
import {
  CatalogConflictError,
  CatalogNotFoundError,
  createCatalogOffering,
  getCatalogOfferingById,
  updateCatalogOffering,
  type StoredCatalogOffering,
} from "@punyasitus/db/catalog/index";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { bumpTenantCacheVersion } from "@punyasitus/db/publication/index";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Pure Runtime-Agnostic Handler & Persistence Helpers for Vehicle Showroom API
 * (`apps/web/src/pages/dashboard/[handle]/catalog/vehicles/_api-handler.ts`; TASK-079, REQ-079).
 *
 * Security & Persistence Invariants:
 * 1. Host isolation (`app` surface only -> neutral `404` on tenant/marketing/console hosts).
 * 2. `POST`-only (`405` with `Allow: POST`).
 * 3. CSRF & Origin enforcement (`assertAdminCsrfAndOrigin` -> `403`).
 * 4. Better Auth session + lifetime ceiling (`401`) strictly BEFORE body parsing/validation.
 *    NEVER skips `enforceSessionLifetimeCeiling`: if `authenticatedUser` is supplied without
 *    `authenticatedSessionId`, falls back to live session verification and fails closed (`401`).
 * 5. `Content-Length` precheck + byte cap (128 KiB -> `413`).
 * 6. Live `PLATFORM_DB` membership + RBAC (`content:write` AND `content:publish` on `publish`)
 *    + tenant handle match (`404` foreign, `403` locked/RBAC).
 * 7. Strict Zod `.strict()` validation via `validateVehicleShowroomAttributes` (`422`), including
 *    rejecting `mileageKm` and `ownershipCount` on `"new"` units.
 * 8. Atomic single-statement SQL publish of `published_snapshot_json` WITH `vehicleShowroomV1`
 *    already embedded (`status = 'published'`, `published_at`, `content_modified_at`, `version = version + 1`
 *    WHERE `id = ? AND version = ?`) + `bumpTenantCacheVersion` with fail-closed compensation rollback,
 *    ensuring ZERO window where a published vehicle exists without its frozen `vehicleShowroomV1` envelope.
 * 9. Passes `whatsappOverride` (canonical catalog write key) and `unitStatus` (`available`/`booked`/`sold`).
 */

const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const MAX_VEHICLES_API_BODY_BYTES = 131_072; // 128 KiB
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export interface DashboardVehiclesRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface DashboardVehiclesHandlerOptions {
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
 * Loads lossless `VehicleShowroomAttributes` for admin editing from `offerings.draft_snapshot_json`.
 */
export async function loadLosslessDraftVehicleMap(
  tenantDb: D1Database,
  offeringIds: readonly number[],
): Promise<Map<number, VehicleShowroomAttributes>> {
  const map = new Map<number, VehicleShowroomAttributes>();
  if (offeringIds.length === 0) return map;
  const placeholders = offeringIds.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(
        `SELECT id, draft_snapshot_json
         FROM offerings
         WHERE offering_type = 'vehicle' AND id IN (${placeholders})`,
      )
      .bind(...offeringIds)
      .all<{ readonly id: number; readonly draft_snapshot_json: string | null }>();
    for (const row of res.results) {
      const extracted = extractVehicleShowroomFromSnapshotJson(row.draft_snapshot_json);
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
 * Loads the frozen published `VehicleShowroomAttributes` strictly from
 * `offerings.published_snapshot_json` (NEVER reads unpublished draft columns!).
 */
export async function loadFrozenPublishedVehicleBySlug(
  tenantDb: D1Database,
  slug: string,
): Promise<VehicleShowroomAttributes | null> {
  const cleanSlug = slug.trim();
  if (!cleanSlug) return null;
  try {
    const row = await tenantDb
      .prepare(
        `SELECT published_snapshot_json
         FROM offerings
         WHERE offering_type = 'vehicle'
           AND slug = ?
           AND status = 'published'
           AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(cleanSlug)
      .first<{ readonly published_snapshot_json: string | null }>();
    return extractVehicleShowroomFromSnapshotJson(row?.published_snapshot_json);
  } catch {
    return null;
  }
}

/**
 * Batch-loads frozen published `VehicleShowroomAttributes` keyed by `slug`, strictly from
 * `offerings.published_snapshot_json` (NEVER reads unpublished draft columns!).
 */
export async function loadFrozenPublishedVehicleMapBySlugs(
  tenantDb: D1Database,
  slugs: readonly string[],
): Promise<Map<string, VehicleShowroomAttributes>> {
  const map = new Map<string, VehicleShowroomAttributes>();
  const uniqueSlugs = Array.from(new Set(slugs.map((s) => s.trim()).filter(Boolean)));
  if (uniqueSlugs.length === 0) return map;
  const placeholders = uniqueSlugs.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(
        `SELECT slug, published_snapshot_json
         FROM offerings
         WHERE offering_type = 'vehicle'
           AND slug IN (${placeholders})
           AND status = 'published'
           AND deleted_at IS NULL`,
      )
      .bind(...uniqueSlugs)
      .all<{ readonly slug: string; readonly published_snapshot_json: string | null }>();
    for (const row of res.results) {
      const extracted = extractVehicleShowroomFromSnapshotJson(row.published_snapshot_json);
      if (extracted) {
        map.set(row.slug, extracted);
      }
    }
  } catch {
    // Graceful fallback to legacy snapshot attributes
  }
  return map;
}

export async function persistLosslessDraftVehicleEnvelope(
  tenantDb: D1Database,
  offeringId: number,
  expectedVersion: number,
  vehicle: VehicleShowroomAttributes,
): Promise<void> {
  const row = await tenantDb
    .prepare(`SELECT draft_snapshot_json FROM offerings WHERE id = ? AND version = ? LIMIT 1`)
    .bind(offeringId, expectedVersion)
    .first<{ readonly draft_snapshot_json: string | null }>();
  if (!row) {
    throw new CatalogConflictError(
      "Versi unit kendaraan berubah secara bersamaan saat menyimpan draf. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
  const nextDraftJson = attachVehicleShowroomToDraftSnapshotJson(
    row.draft_snapshot_json,
    vehicle,
  );
  const res = await tenantDb
    .prepare(`UPDATE offerings SET draft_snapshot_json = ? WHERE id = ? AND version = ?`)
    .bind(nextDraftJson, offeringId, expectedVersion)
    .run();
  if (Number(res.meta?.changes ?? 0) !== 1) {
    throw new CatalogConflictError(
      "Konflik versi saat memperbarui snapshot draf kendaraan. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion },
    );
  }
}

interface RawPublishableVehicleRow {
  readonly id: number;
  readonly draft_snapshot_json: string | null;
  readonly published_snapshot_json: string | null;
  readonly status: string;
  readonly published_at: number | null;
  readonly content_modified_at: number | null;
  readonly version: number;
  readonly updated_at: number;
}

/**
 * Atomically publishes a vehicle offering in ONE SQLite `UPDATE` statement with
 * `vehicleShowroomV1` ALREADY embedded on `published_snapshot_json` (ZERO window where
 * `status = 'published'` exists without `vehicleShowroomV1`), then bumps
 * `PLATFORM_DB.tenants.cache_version` with fail-closed compensation rollback on failure.
 */
export async function publishVehicleOfferingAtomically(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly offeringId: number;
    readonly expectedVersion: number;
    readonly vehicle: VehicleShowroomAttributes;
    readonly nowMs?: number;
  },
): Promise<{ readonly offering: StoredCatalogOffering; readonly cacheVersion: number }> {
  const nowMs = params.nowMs ?? Date.now();
  const priorRow = await tenantDb
    .prepare(
      `SELECT id, draft_snapshot_json, published_snapshot_json, status,
              published_at, content_modified_at, version, updated_at
       FROM offerings
       WHERE id = ? AND version = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(params.offeringId, params.expectedVersion)
    .first<RawPublishableVehicleRow>();

  if (!priorRow) {
    throw new CatalogConflictError(
      "Versi unit kendaraan berubah secara bersamaan saat memublikasikan snapshot. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion: params.expectedVersion },
    );
  }

  let draftData: unknown = null;
  if (priorRow.draft_snapshot_json && priorRow.draft_snapshot_json.trim()) {
    try {
      const parsed = JSON.parse(priorRow.draft_snapshot_json) as Record<string, unknown>;
      draftData = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
    } catch {
      draftData = null;
    }
  }
  if (!draftData || typeof draftData !== "object") {
    throw new CatalogConflictError(
      "Snapshot draf kendaraan tidak valid untuk dipublikasikan. Muat ulang dan coba lagi.",
      { code: "CONFLICT", expectedVersion: params.expectedVersion },
    );
  }

  const publishedAt = priorRow.published_at ?? nowMs;
  const contentModifiedAt = nowMs;
  const canonicalEnvelope = buildPublishedSnapshot("offering", draftData, {
    publishedAt,
    contentModifiedAt,
  });
  const nextPublishedJson = attachVehicleShowroomToPublishedSnapshotJson(
    JSON.stringify(canonicalEnvelope),
    params.vehicle,
  );
  if (!nextPublishedJson) {
    throw new CatalogConflictError(
      "Snapshot publikasi kendaraan tidak valid. Muat ulang dan coba lagi.",
      { code: "CONFLICT", expectedVersion: params.expectedVersion },
    );
  }
  const nextDraftJson = attachVehicleShowroomToDraftSnapshotJson(
    priorRow.draft_snapshot_json,
    params.vehicle,
  );

  // Single atomic SQL statement: status='published' + published_snapshot_json (WITH vehicleShowroomV1)
  // + version increment under OCC guard `WHERE id = ? AND version = ? AND deleted_at IS NULL`.
  const swappedVersion = params.expectedVersion + 1;
  const updateRes = await tenantDb
    .prepare(
      `UPDATE offerings
       SET draft_snapshot_json = ?,
           published_snapshot_json = ?,
           status = 'published',
           published_at = ?,
           content_modified_at = ?,
           version = ?,
           updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(
      nextDraftJson,
      nextPublishedJson,
      publishedAt,
      contentModifiedAt,
      swappedVersion,
      nowMs,
      params.offeringId,
      params.expectedVersion,
    )
    .run();

  if (Number(updateRes.meta?.changes ?? 0) !== 1) {
    throw new CatalogConflictError(
      "Konflik versi saat memublikasikan unit kendaraan. Muat ulang dan coba lagi.",
      { code: "STALE_VERSION", expectedVersion: params.expectedVersion },
    );
  }

  let cacheVersion: number;
  try {
    cacheVersion = await bumpTenantCacheVersion(platformDb, params.tenantId, nowMs);
  } catch (cause) {
    let compensated = false;
    try {
      const rollbackRes = await tenantDb
        .prepare(
          `UPDATE offerings
           SET draft_snapshot_json = ?,
               published_snapshot_json = ?,
               status = ?,
               published_at = ?,
               content_modified_at = ?,
               version = ?,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          priorRow.draft_snapshot_json,
          priorRow.published_snapshot_json,
          priorRow.status,
          priorRow.published_at,
          priorRow.content_modified_at,
          priorRow.version,
          priorRow.updated_at,
          params.offeringId,
          swappedVersion,
        )
        .run();
      compensated = Number(rollbackRes.meta?.changes ?? 0) === 1;
    } catch {
      // Compensation failed; `compensated` stays `false`
    }
    throw new PublicationAtomicError(
      `Gagal menyelesaikan publikasi kendaraan atomik (${compensated ? "dikembalikan ke status sebelumnya" : "kompensasi gagal"}).`,
      { compensated, cause },
    );
  }

  const reloaded = await getCatalogOfferingById(tenantDb, params.offeringId);
  if (!reloaded) {
    throw new CatalogNotFoundError("offering", params.offeringId);
  }
  return { offering: reloaded, cacheVersion };
}

export async function handleDashboardVehiclesApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: DashboardVehiclesRuntimeEnv,
  options: DashboardVehiclesHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();
  const method = request.method.toUpperCase();
  const normalizedHandle = rawHandle.trim().toLowerCase();

  // 1. Host isolation (`app` surface only)
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app" || !HANDLE_RE.test(normalizedHandle)) {
    return errorRes(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId);
  }

  // 2. Method check (POST only)
  if (method !== "POST") {
    return errorRes(
      405,
      "BAD_REQUEST",
      "Metode HTTP harus POST untuk endpoint pengelola showroom kendaraan.",
      requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  // 3. CSRF & Origin enforcement
  const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
  if (!csrf.ok) {
    return errorRes(csrf.status, csrf.code, csrf.reason, requestId);
  }

  // 4. Fail-closed PLATFORM_DB check
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

  // 5. Authenticate session + ALWAYS enforce session lifetime ceiling BEFORE parsing/validating body.
  //    Fail-closed: NEVER skip `enforceSessionLifetimeCeiling` when `authenticatedSessionId` is absent!
  let userId: string | null = null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;
  const pathname = new URL(request.url).pathname.toLowerCase();

  if (options.authenticatedUser?.id && options.authenticatedSessionId) {
    try {
      const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
        sessionId: options.authenticatedSessionId,
        userId: options.authenticatedUser.id,
        surface: "app",
        pathname,
        nowMs: options.nowMs,
      });
      if (lifetime.valid) {
        userId = options.authenticatedUser.id;
      } else {
        activeOrganizationId = null;
      }
    } catch {
      return errorRes(
        503,
        "SERVICE_UNAVAILABLE",
        "Verifikasi sesi sementara tidak tersedia.",
        requestId,
      );
    }
  } else {
    // Either no pre-resolved user OR `authenticatedSessionId` missing: resolve live session from request headers.
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return errorRes(
        503,
        "SERVICE_UNAVAILABLE",
        "Konfigurasi autentikasi belum lengkap.",
        requestId,
      );
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
        // If caller passed an explicit `authenticatedUser`, it must match the live session user.
        const userMatches =
          !options.authenticatedUser?.id || options.authenticatedUser.id === sessionResult.user.id;
        if (userMatches) {
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
      }
    } catch {
      return errorRes(
        503,
        "SERVICE_UNAVAILABLE",
        "Verifikasi sesi sementara tidak tersedia.",
        requestId,
      );
    }
  }

  if (!userId) {
    return errorRes(401, "UNAUTHENTICATED", "Sesi login diperlukan.", requestId);
  }

  // 6. Content-Length precheck + parse JSON body strictly & validate `action`
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null) {
    const declaredBytes = Number(rawContentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_VEHICLES_API_BODY_BYTES) {
      return errorRes(413, "PAYLOAD_TOO_LARGE", "Ukuran payload terlalu besar.", requestId);
    }
  }

  let rawBody: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_VEHICLES_API_BODY_BYTES) {
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

  // 7. Verify live tenant membership + RBAC (both `content:write` AND `content:publish` on publish) + lifecycle
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

  if (action === "publish" && !canPerform(member.role, "content:write")) {
    return errorRes(
      403,
      "FORBIDDEN",
      "Peran akun Anda memerlukan izin menulis dan menerbitkan konten untuk memublikasikan perubahan unit.",
      requestId,
    );
  }

  if (member.tenantStatus === "locked") {
    return errorRes(
      403,
      "TENANT_LOCKED",
      "Situs sedang dalam status terkunci (read-only). Selesaikan perpanjangan untuk menyimpan perubahan.",
      requestId,
    );
  }

  // 8. Open isolated TenantStore DB
  let tenantDb: D1Database;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  } else {
    return errorRes(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan tenant sementara tidak tersedia.",
      requestId,
    );
  }

  // 9. Strict title & structured `vehicle` validation
  const title = typeof rawBody.title === "string" ? rawBody.title.trim() : "";
  if (!title || title.length > 200) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Judul unit kendaraan wajib diisi (maks. 200 karakter).",
      requestId,
      { fields: [{ field: "title", code: "INVALID_TITLE", message: "Judul unit wajib diisi." }] },
    );
  }

  const summary =
    typeof rawBody.summary === "string" && rawBody.summary.trim()
      ? rawBody.summary.trim().slice(0, 500)
      : null;

  const rawVehicle = rawBody.vehicle;
  if (!rawVehicle || typeof rawVehicle !== "object" || Array.isArray(rawVehicle)) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Objek atribut kendaraan (`vehicle`) wajib diisi.",
      requestId,
    );
  }

  let validatedVehicle: VehicleShowroomAttributes;
  try {
    const referenceYear =
      typeof options.nowMs === "number" ? new Date(options.nowMs).getUTCFullYear() : undefined;
    validatedVehicle = validateVehicleShowroomAttributes(rawVehicle, { referenceYear });
  } catch (err) {
    if (err instanceof VehicleValidationError) {
      return errorRes(422, "VALIDATION_ERROR", err.message, requestId, {
        fields: err.fields,
      });
    }
    throw err;
  }

  const catalogPricing = toCatalogVehiclePricing(validatedVehicle);
  const legacyVehicleAttributes = toCatalogVehicleAttributes(validatedVehicle);
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

  const salesPhoneOverride = validatedVehicle.salesWhatsappOverride ?? null;

  try {
    let saved: StoredCatalogOffering;
    if (offeringId === null) {
      saved = await createCatalogOffering(
        tenantDb,
        {
          offeringType: "vehicle",
          title,
          summary,
          priceMode: catalogPricing.priceMode,
          price: catalogPricing.price,
          priceMax: catalogPricing.priceMax,
          negotiable: catalogPricing.negotiable,
          ctaMode: "whatsapp",
          whatsappOverride: salesPhoneOverride,
          unitStatus: validatedVehicle.unitStatus,
          attributes: legacyVehicleAttributes,
        },
        { nowMs: options.nowMs, actorUserId: member.userId },
      );
    } else {
      if (expectedVersion === null) {
        return errorRes(
          422,
          "VALIDATION_ERROR",
          "expectedVersion wajib diisi saat memperbarui unit kendaraan.",
          requestId,
        );
      }
      const existing = await getCatalogOfferingById(tenantDb, offeringId);
      if (!existing || existing.offeringType !== "vehicle") {
        return errorRes(404, "NOT_FOUND", "Unit kendaraan tidak ditemukan.", requestId);
      }
      saved = await updateCatalogOffering(
        tenantDb,
        offeringId,
        {
          title,
          summary,
          priceMode: catalogPricing.priceMode,
          price: catalogPricing.price,
          priceMax: catalogPricing.priceMax,
          negotiable: catalogPricing.negotiable,
          ctaMode: "whatsapp",
          whatsappOverride: salesPhoneOverride,
          unitStatus: validatedVehicle.unitStatus,
          attributes: legacyVehicleAttributes,
        },
        {
          expectedVersion,
          nowMs: options.nowMs,
          actorUserId: member.userId,
        },
      );
    }

    if (action === "publish") {
      // Atomic single-statement SQL publish: embeds `vehicleShowroomV1` into BOTH
      // `draft_snapshot_json` and `published_snapshot_json` at the exact instant `status = 'published'`
      // commits, with fail-closed cache_version compensation rollback.
      const pub = await publishVehicleOfferingAtomically(runtimeEnv.PLATFORM_DB, tenantDb, {
        tenantId: member.tenantId,
        offeringId: saved.id,
        expectedVersion: saved.version,
        vehicle: validatedVehicle,
        nowMs: options.nowMs,
      });
      return jsonRes(200, {
        id: pub.offering.id,
        slug: pub.offering.slug,
        publicPath: pub.offering.publicPath,
        title: pub.offering.title,
        summary: pub.offering.summary ?? "",
        priceMode: pub.offering.priceMode,
        price: pub.offering.price,
        priceMax: pub.offering.priceMax,
        negotiable: pub.offering.negotiable,
        unitStatus: pub.offering.unitStatus ?? validatedVehicle.unitStatus,
        status: pub.offering.status,
        version: pub.offering.version,
        attributes: validatedVehicle,
      });
    }

    await persistLosslessDraftVehicleEnvelope(tenantDb, saved.id, saved.version, validatedVehicle);

    return jsonRes(offeringId === null ? 201 : 200, {
      id: saved.id,
      slug: saved.slug,
      publicPath: saved.publicPath,
      title: saved.title,
      summary: saved.summary ?? "",
      priceMode: saved.priceMode,
      price: saved.price,
      priceMax: saved.priceMax,
      negotiable: saved.negotiable,
      unitStatus: saved.unitStatus ?? validatedVehicle.unitStatus,
      status: saved.status,
      version: saved.version,
      attributes: validatedVehicle,
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
    if (err instanceof PublicationAtomicError) {
      return errorRes(503, "SERVICE_UNAVAILABLE", err.message, requestId, undefined, {
        "Retry-After": "15",
      });
    }
    throw err;
  }
}
