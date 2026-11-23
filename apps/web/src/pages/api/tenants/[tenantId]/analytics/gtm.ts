import {
  GTM_DATALAYER_CONTRACT_VERSION,
  GTM_DATALAYER_EVENT_DOCS,
  GTM_RISK_ACK_STATEMENTS_ID,
  GTM_RISK_ACK_VERSION,
  type GtmKillSwitchReasonCategory,
  type GtmOperatorKillSwitchState,
} from "@punyasitus/core/analytics/gtm";
import {
  getTenantFullAnalyticsSettings,
  GtmSettingsDomainError,
  updateTenantGtmSettings,
} from "@punyasitus/db/analytics-settings/index";
import type { APIRoute } from "astro";
import {
  analyticsErrorResponse,
  analyticsJsonResponse,
  authorizeTenantAnalyticsRequest,
  buildAnalyticsRuntimeEnv,
  createRequestId,
  extractRequiredExpectedVersion,
  mapAnalyticsDomainErrorToResponse,
  MAX_ANALYTICS_BODY_BYTES,
  type TenantAnalyticsHandlerOptions,
  type TenantAnalyticsRuntimeEnv,
} from "./_shared.ts";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";

/**
 * Tenant-scoped Google Tag Manager & Per-Vendor Delivery Settings API
 * (`TASK-076`, `REQ-027`, `DEC-027`, `PLAN §18.1`):
 * - `GET   /api/tenants/:tenantId/analytics/gtm` -> read full direct + GTM settings, risk ack, kill switch status
 * - `PATCH /api/tenants/:tenantId/analytics/gtm` -> update GTM container ID, per-vendor modes (`direct`/`gtm`),
 *   optional direct IDs, and owner-only audited GTM activation (`riskAcknowledgement`).
 */

const PATCH_GTM_ALLOWED_KEYS = new Set([
  "gtmContainerId",
  "gtmEnabled",
  "vendorModes",
  "ga4MeasurementId",
  "metaPixelId",
  "tiktokPixelId",
  "riskAcknowledgement",
  "expectedVersion",
]);

const FORBIDDEN_TENANT_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_TENANT_SELECTOR_KEYS);

function findNestedForbiddenKey(value: unknown, prefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenKey(value[i], `${prefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = prefix ? `${prefix}.${k}` : k;
    if (FORBIDDEN_TENANT_KEY_SET.has(k)) return nextPath;
    const hit = findNestedForbiddenKey(v, nextPath);
    if (hit) return hit;
  }
  return null;
}

async function parseStrictGtmPatchBody(
  request: Request,
  requestId: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_ANALYTICS_BODY_BYTES) {
    return {
      ok: false,
      response: analyticsErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_ANALYTICS_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    return {
      ok: false,
      response: analyticsErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: analyticsErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: analyticsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Body permintaan harus berupa objek JSON.",
        requestId,
      ),
    };
  }

  const record = parsed as Record<string, unknown>;
  const forbiddenPath = findNestedForbiddenKey(record);
  if (forbiddenPath) {
    return {
      ok: false,
      response: analyticsErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Field "${forbiddenPath}" tidak diizinkan dalam body permintaan tenant.`,
        requestId,
      ),
    };
  }

  for (const key of Object.keys(record)) {
    if (!PATCH_GTM_ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        response: analyticsErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
          [{ field: key, code: "UNKNOWN_FIELD", message: `Unknown field "${key}".` }],
        ),
      };
    }
  }

  return { ok: true, body: record };
}

function mapGtmDomainError(err: unknown, requestId: string): Response {
  if (err instanceof GtmSettingsDomainError) {
    const apiCode: ApiErrorCode =
      err.code === "STALE_VERSION"
        ? "STALE_VERSION"
        : err.code === "FORBIDDEN" ||
            err.code === "OWNER_ONLY_GTM_ACTIVATION" ||
            err.code === "GTM_DISABLED_BY_OPERATOR"
          ? "FORBIDDEN"
          : err.code === "NOT_FOUND"
            ? "NOT_FOUND"
            : err.status === 503
              ? "SERVICE_UNAVAILABLE"
              : "VALIDATION_ERROR";
    return analyticsJsonResponse(
      err.status,
      {
        error: {
          code: err.code,
          apiCode,
          message: err.message,
          ...(err.fields && err.fields.length > 0 ? { fields: err.fields } : {}),
        },
        requestId,
      },
      err.status === 503 ? { "Retry-After": "60" } : undefined,
    );
  }
  return mapAnalyticsDomainErrorToResponse(err, requestId);
}

export interface TenantVisibleOperatorKillSwitch {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly category: GtmKillSwitchReasonCategory | null;
  readonly reasonCategory: GtmKillSwitchReasonCategory | null;
  readonly reason: string | null;
  readonly disabledAt: string | null;
  readonly liftedAt: string | null;
}

/**
 * Redacts internal platform operator identity (`disabledBy`) before returning
 * kill-switch status on tenant-facing responses.
 */
export function sanitizeOperatorKillSwitchForTenant(
  killSwitch: GtmOperatorKillSwitchState,
): TenantVisibleOperatorKillSwitch {
  return {
    active: killSwitch.disabled,
    disabled: killSwitch.disabled,
    category: killSwitch.reasonCategory,
    reasonCategory: killSwitch.reasonCategory,
    reason: killSwitch.reason,
    disabledAt: killSwitch.disabledAt,
    liftedAt: killSwitch.liftedAt,
  };
}

export async function handleTenantGtmAnalyticsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAnalyticsRuntimeEnv,
  options: TenantAnalyticsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantAnalyticsRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return analyticsErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk pengaturan Google Tag Manager.",
      requestId,
      undefined,
      { Allow: "GET, PATCH" },
    );
  }

  const requiredPermission = method === "GET" ? "settings:read" : "settings:write";
  const auth = await authorizeTenantAnalyticsRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { tenantDb, platformDb, member } = auth.ctx;

  try {
    if (method === "GET") {
      const settings = await getTenantFullAnalyticsSettings(tenantDb, platformDb, member.tenantId);
      return analyticsJsonResponse(200, {
        ...settings,
        operatorKillSwitch: sanitizeOperatorKillSwitchForTenant(settings.operatorKillSwitch),
        requiredRiskAckVersion: GTM_RISK_ACK_VERSION,
        riskAckStatements: GTM_RISK_ACK_STATEMENTS_ID,
        dataLayerContractVersion: GTM_DATALAYER_CONTRACT_VERSION,
        dataLayerEvents: GTM_DATALAYER_EVENT_DOCS,
      });
    }

    const parsedBody = await parseStrictGtmPatchBody(request, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const patch: Record<string, unknown> = {};
    for (const key of [
      "gtmContainerId",
      "gtmEnabled",
      "vendorModes",
      "ga4MeasurementId",
      "metaPixelId",
      "tiktokPixelId",
      "riskAcknowledgement",
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(parsedBody.body, key)) {
        patch[key] = parsedBody.body[key];
      }
    }

    const updated = await updateTenantGtmSettings(tenantDb, platformDb, {
      tenantId: member.tenantId,
      patch,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return analyticsJsonResponse(200, {
      ...updated,
      operatorKillSwitch: sanitizeOperatorKillSwitchForTenant(updated.operatorKillSwitch),
      requiredRiskAckVersion: GTM_RISK_ACK_VERSION,
    });
  } catch (err) {
    return mapGtmDomainError(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantGtmAnalyticsRequest(params.tenantId ?? "", request, buildAnalyticsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
