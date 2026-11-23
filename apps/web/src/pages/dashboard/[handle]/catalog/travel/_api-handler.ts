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
import type { CatalogPriceMode } from "@punyasitus/core/catalog/index";
import {
  assertCanPublishTravelPackage,
  attachTravelPackageToDraftSnapshotJson,
  attachTravelPackageToPublishedSnapshotJson,
  extractTravelPackageFromSnapshotJson,
  stripUntrustedTravelGateFields,
  toCatalogTourAttributes,
  TravelPublishGateError,
  TravelValidationError,
  validateTravelPackageAttributes,
  type TravelPackageAttributes,
  type TrustedTravelGateState,
} from "@punyasitus/core/catalog/travel";
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
 * Pure Runtime-Agnostic Handler & Persistence Helpers for Travel & Umrah API
 * (`apps/web/src/pages/dashboard/[handle]/catalog/travel/_api-handler.ts`; TASK-020, REQ-028, DEC-042).
 *
 * Security & Compliance Invariants:
 * 1. Host isolation (`app` surface only -> neutral `404` on tenant/marketing/console hosts).
 * 2. CSRF & Origin validation (`assertAdminCsrfAndOrigin`).
 * 3. Better Auth session + lifetime ceiling + live `PLATFORM_DB` membership & tenant status
 *    matching `[handle]` (foreign tenant -> neutral `404`, locked -> `403`).
 * 4. Strips any client-forged `operatorVerified` / `umrahCounselApproved` flags and resolves
 *    authoritative `TrustedTravelGateState` strictly from server runtime / platform records.
 * 5. Enforces `assertCanPublishTravelPackage` SERVER-SIDE on `action: "publish"`, returning
 *    `422 UMRAH_PUBLISH_BLOCKED` even if a client sends forged verification flags.
 * 6. Stores lossless `travelPackageV1` in `draft_snapshot_json._draftMetadata` (and on publish,
 *    in `published_snapshot_json` outer envelope) while keeping `attributes_json` 100% valid
 *    under `TourAttributesSchema`.
 */

const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const MAX_TRAVEL_API_BODY_BYTES = 131_072; // 128 KiB
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const VALID_PRICE_MODES = new Set<CatalogPriceMode>(["fixed", "from", "range", "on_request"]);

export interface DashboardTravelRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly UMRAH_COUNSEL_APPROVED?: string;
}

export interface DashboardTravelHandlerOptions {
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
  readonly resolveTrustedGateState?: (params: {
    readonly tenantId: string;
    readonly platformDb: D1Database;
    readonly tenantDb: D1Database;
  }) => Promise<TrustedTravelGateState> | TrustedTravelGateState;
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
 * Resolves server-trusted DEC-042 gate state from platform runtime/database.
 * Defaults strictly to fail-closed (`operatorVerified: false`, `umrahCounselApproved: false`).
 */
export async function resolveServerTrustedTravelGateState(params: {
  readonly tenantId: string;
  readonly platformDb: D1Database | undefined;
  readonly runtimeEnv: { readonly UMRAH_COUNSEL_APPROVED?: string };
}): Promise<TrustedTravelGateState> {
  const umrahCounselApproved = params.runtimeEnv.UMRAH_COUNSEL_APPROVED === "true";
  let operatorVerified = false;

  if (params.platformDb) {
    try {
      const row = await params.platformDb
        .prepare("SELECT operator_verified_ppiu FROM tenants WHERE id = ? LIMIT 1")
        .bind(params.tenantId)
        .first<{ readonly operator_verified_ppiu?: number | null }>();
      if (row && Number(row.operator_verified_ppiu ?? 0) === 1) {
        operatorVerified = true;
      }
    } catch {
      operatorVerified = false;
    }
  }

  return {
    operatorVerified,
    umrahCounselApproved,
  };
}

/**
 * Loads lossless `TravelPackageAttributes` for admin editing from `offerings.draft_snapshot_json`.
 */
export async function loadLosslessDraftTravelMap(
  tenantDb: D1Database,
  offeringIds: readonly number[],
): Promise<Map<number, TravelPackageAttributes>> {
  const map = new Map<number, TravelPackageAttributes>();
  if (offeringIds.length === 0) return map;
  const placeholders = offeringIds.map(() => "?").join(", ");
  try {
    const res = await tenantDb
      .prepare(
        `SELECT id, draft_snapshot_json
         FROM offerings
         WHERE offering_type = 'tour' AND id IN (${placeholders})`,
      )
      .bind(...offeringIds)
      .all<{ readonly id: number; readonly draft_snapshot_json: string | null }>();
    for (const row of res.results) {
      const extracted = extractTravelPackageFromSnapshotJson(row.draft_snapshot_json);
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
 * Loads the frozen published `TravelPackageAttributes` strictly from `offerings.published_snapshot_json`
 * (NEVER reads draft columns!).
 */
export async function loadFrozenPublishedTravelBySlug(
  tenantDb: D1Database,
  slug: string,
): Promise<TravelPackageAttributes | null> {
  const cleanSlug = slug.trim();
  if (!cleanSlug) return null;
  try {
    const row = await tenantDb
      .prepare(
        `SELECT published_snapshot_json
         FROM offerings
         WHERE offering_type = 'tour'
           AND slug = ?
           AND status = 'published'
           AND deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(cleanSlug)
      .first<{ readonly published_snapshot_json: string | null }>();
    return extractTravelPackageFromSnapshotJson(row?.published_snapshot_json);
  } catch {
    return null;
  }
}

async function persistLosslessDraftTravelEnvelope(
  tenantDb: D1Database,
  offeringId: number,
  expectedVersion: number,
  travel: TravelPackageAttributes,
): Promise<void> {
  const row = await tenantDb
    .prepare(`SELECT draft_snapshot_json FROM offerings WHERE id = ? LIMIT 1`)
    .bind(offeringId)
    .first<{ readonly draft_snapshot_json: string | null }>();
  const nextDraftJson = attachTravelPackageToDraftSnapshotJson(
    row?.draft_snapshot_json,
    travel,
  );
  await tenantDb
    .prepare(`UPDATE offerings SET draft_snapshot_json = ? WHERE id = ? AND version = ?`)
    .bind(nextDraftJson, offeringId, expectedVersion)
    .run();
}

async function persistLosslessPublishedTravelEnvelope(
  tenantDb: D1Database,
  offeringId: number,
  expectedVersion: number,
  travel: TravelPackageAttributes,
): Promise<void> {
  const row = await tenantDb
    .prepare(
      `SELECT draft_snapshot_json, published_snapshot_json FROM offerings WHERE id = ? LIMIT 1`,
    )
    .bind(offeringId)
    .first<{
      readonly draft_snapshot_json: string | null;
      readonly published_snapshot_json: string | null;
    }>();
  const nextDraftJson = attachTravelPackageToDraftSnapshotJson(
    row?.draft_snapshot_json,
    travel,
  );
  const nextPublishedJson = attachTravelPackageToPublishedSnapshotJson(
    row?.published_snapshot_json,
    travel,
  );
  if (nextPublishedJson) {
    await tenantDb
      .prepare(
        `UPDATE offerings
         SET draft_snapshot_json = ?, published_snapshot_json = ?
         WHERE id = ? AND version = ?`,
      )
      .bind(nextDraftJson, nextPublishedJson, offeringId, expectedVersion)
      .run();
  } else {
    await tenantDb
      .prepare(`UPDATE offerings SET draft_snapshot_json = ? WHERE id = ? AND version = ?`)
      .bind(nextDraftJson, offeringId, expectedVersion)
      .run();
  }
}

export async function handleDashboardTravelApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: DashboardTravelRuntimeEnv,
  options: DashboardTravelHandlerOptions = {},
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
      "Metode HTTP harus POST untuk endpoint pengelola paket tur.",
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

  // 4. Parse JSON body strictly
  let rawBody: Record<string, unknown>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_TRAVEL_API_BODY_BYTES) {
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

  // 5. Authenticate session + verify tenant membership + RBAC + lifecycle
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
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
      return errorRes(503, "SERVICE_UNAVAILABLE", "Verifikasi sesi sementara tidak tersedia.", requestId);
    }
  }

  if (!userId) {
    return errorRes(401, "UNAUTHENTICATED", "Sesi login diperlukan.", requestId);
  }

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

  // 7. Validate title, pricing, and strip ALL untrusted gate flags from `travel`
  const title = typeof rawBody.title === "string" ? rawBody.title.trim() : "";
  if (!title || title.length > 200) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Judul paket perjalanan wajib diisi (maks. 200 karakter).",
      requestId,
      { fields: [{ field: "title", code: "INVALID_TITLE", message: "Judul paket wajib diisi." }] },
    );
  }

  const summary =
    typeof rawBody.summary === "string" && rawBody.summary.trim()
      ? rawBody.summary.trim().slice(0, 500)
      : null;

  const rawPriceMode = typeof rawBody.priceMode === "string" ? rawBody.priceMode : "from";
  const priceMode: CatalogPriceMode = VALID_PRICE_MODES.has(rawPriceMode as CatalogPriceMode)
    ? (rawPriceMode as CatalogPriceMode)
    : "from";

  const price =
    priceMode === "on_request"
      ? null
      : typeof rawBody.price === "number" && Number.isSafeInteger(rawBody.price) && rawBody.price >= 0
        ? rawBody.price
        : null;

  const rawTravel = rawBody.travel;
  if (!rawTravel || typeof rawTravel !== "object" || Array.isArray(rawTravel)) {
    return errorRes(
      422,
      "VALIDATION_ERROR",
      "Objek atribut paket perjalanan (`travel`) wajib diisi.",
      requestId,
    );
  }

  // CRITICAL (B1): Strip any client-forged `operatorVerified` / `umrahCounselApproved`!
  const strippedTravel = stripUntrustedTravelGateFields(rawTravel as Record<string, unknown>);

  let validatedTravel: TravelPackageAttributes;
  try {
    validatedTravel = validateTravelPackageAttributes(strippedTravel);
  } catch (err) {
    if (err instanceof TravelValidationError) {
      return errorRes(422, "VALIDATION_ERROR", err.message, requestId, {
        fields: err.fields,
      });
    }
    throw err;
  }

  // Resolve authoritative server-side DEC-042 gate state (NEVER from client payload!)
  const trustedGateState = options.resolveTrustedGateState
    ? await options.resolveTrustedGateState({
        tenantId: member.tenantId,
        platformDb: runtimeEnv.PLATFORM_DB,
        tenantDb,
      })
    : await resolveServerTrustedTravelGateState({
        tenantId: member.tenantId,
        platformDb: runtimeEnv.PLATFORM_DB,
        runtimeEnv,
      });

  // CRITICAL (B1): Enforce DEC-042 Umrah/Hajj publish gate SERVER-SIDE before any publish write!
  if (action === "publish") {
    try {
      assertCanPublishTravelPackage(validatedTravel, trustedGateState);
    } catch (err) {
      if (err instanceof TravelPublishGateError) {
        return errorRes(422, "UMRAH_PUBLISH_BLOCKED", err.message, requestId, {
          reasons: err.reasons,
        });
      }
      throw err;
    }
  }

  const legacyTourAttributes = toCatalogTourAttributes(validatedTravel, trustedGateState);
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

  try {
    let saved: StoredCatalogOffering;
    if (offeringId === null) {
      saved = await createCatalogOffering(
        tenantDb,
        {
          offeringType: "tour",
          title,
          summary,
          priceMode,
          price,
          ctaMode: "whatsapp",
          attributes: legacyTourAttributes,
        },
        { nowMs: options.nowMs, actorUserId: member.userId },
      );
    } else {
      if (expectedVersion === null) {
        return errorRes(
          422,
          "VALIDATION_ERROR",
          "expectedVersion wajib diisi saat memperbarui paket tur.",
          requestId,
        );
      }
      const existing = await getCatalogOfferingById(tenantDb, offeringId);
      if (!existing || existing.offeringType !== "tour") {
        return errorRes(404, "NOT_FOUND", "Paket tur tidak ditemukan.", requestId);
      }
      saved = await updateCatalogOffering(
        tenantDb,
        offeringId,
        {
          title,
          summary,
          priceMode,
          price,
          ctaMode: "whatsapp",
          attributes: legacyTourAttributes,
        },
        {
          expectedVersion,
          nowMs: options.nowMs,
          actorUserId: member.userId,
        },
      );
    }

    await persistLosslessDraftTravelEnvelope(tenantDb, saved.id, saved.version, validatedTravel);

    if (action === "publish") {
      const pub = await publishCatalogOffering(runtimeEnv.PLATFORM_DB, tenantDb, {
        tenantId: member.tenantId,
        offeringId: saved.id,
        expectedVersion: saved.version,
        actorUserId: member.userId,
        nowMs: options.nowMs,
      });
      await persistLosslessPublishedTravelEnvelope(
        tenantDb,
        pub.offering.id,
        pub.offering.version,
        validatedTravel,
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
        attributes: validatedTravel,
        trustedGateState,
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
      attributes: validatedTravel,
      trustedGateState,
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
