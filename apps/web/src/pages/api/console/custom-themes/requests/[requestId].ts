import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { validateTransitionCustomThemeRequestInput } from "@punyasitus/core/custom-themes/index";
import {
  getConsoleCustomThemeRequestById,
  getTenantSeatUsageForServiceRequest,
  listTenantActiveCustomThemeGrants,
  transitionConsoleCustomThemeRequest,
} from "@punyasitus/db/custom-themes/index";
import type { APIRoute } from "astro";
import { getRegisteredTheme } from "../../../../../core/theme-registry.ts";
import {
  formatConsoleRequestDto,
  mapConsoleCustomThemeErrorToResponse,
  resolveConsoleCustomThemesRuntimeEnv,
} from "../_shared.ts";

/**
 * `/api/console/custom-themes/requests/:requestId`
 * - `GET`: read single request + tenant's active custom theme grants
 * - `PATCH`: audited status transition (`new -> contacted -> quoted -> in_progress -> delivered`
 *   or `declined` / `cancelled`) requiring recent 2FA step-up, `expectedVersion`, mandatory
 *   10–500 char `reason`, atomic `platform_audit`, and active `tenant_theme_entitlements`
 *   custom theme grant when marking `delivered`!
 *
 * (REQ-063, REQ-051, PLAN §11.4 & §13, TASK-061). ZERO runtime DDL.
 */

const TRANSITION_REQUEST_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "status",
  "reason",
  "operatorNotes",
  "deliveredThemeId",
  "staffUserEmail",
  "staffUserId",
]);

export async function handleConsoleCustomThemeRequestDetail(
  targetRequestId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();
  const cleanId = targetRequestId.trim();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.requests.read", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanId) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Permintaan tema kustom tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    try {
      const item = await getConsoleCustomThemeRequestById(authz.ctx.platformDb, cleanId);
      if (!item) {
        return consoleErrorResponse(
          404,
          "NOT_FOUND",
          "Permintaan tema kustom tidak ditemukan.",
          authz.ctx.requestId,
        );
      }
      const [grants, seats] = await Promise.all([
        listTenantActiveCustomThemeGrants(authz.ctx.platformDb, item.tenantId),
        getTenantSeatUsageForServiceRequest(authz.ctx.platformDb, {
          tenantId: item.tenantId,
          nowMs: authz.ctx.nowMs,
        }),
      ]);
      return consoleJsonResponse(200, {
        success: true,
        request: formatConsoleRequestDto(item, grants, seats),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.requests.transition", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanId) {
      return consoleErrorResponse(
        404,
        "NOT_FOUND",
        "Permintaan tema kustom tidak ditemukan.",
        authz.ctx.requestId,
      );
    }

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      TRANSITION_REQUEST_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const existing = await getConsoleCustomThemeRequestById(authz.ctx.platformDb, cleanId);
      if (!existing) {
        return consoleErrorResponse(
          404,
          "NOT_FOUND",
          "Permintaan layanan tidak ditemukan.",
          authz.ctx.requestId,
        );
      }

      const validated = validateTransitionCustomThemeRequestInput(parsed.body, {
        serviceKind: existing.serviceKind,
      });

      if (existing.serviceKind === "custom_theme" && validated.status === "delivered") {
        const targetId = validated.deliveredThemeId?.trim().toLowerCase() ?? "";
        const registered = targetId ? getRegisteredTheme(targetId) : null;
        if (!registered || !registered.isCustom) {
          return consoleErrorResponse(
            409,
            "THEME_NOT_REGISTERED",
            `Tema kustom "${targetId}" belum terdaftar di registri tema aktif aplikasi sehingga belum dapat diaktifkan oleh tenant.`,
            authz.ctx.requestId,
            { reasonCode: "THEME_NOT_REGISTERED" },
          );
        }
      }

      const result = await transitionConsoleCustomThemeRequest(authz.ctx.platformDb, {
        requestId: cleanId,
        input: validated,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        httpRequestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });
      const [grants, seats] = await Promise.all([
        listTenantActiveCustomThemeGrants(authz.ctx.platformDb, result.request.tenantId),
        getTenantSeatUsageForServiceRequest(authz.ctx.platformDb, {
          tenantId: result.request.tenantId,
          nowMs: authz.ctx.nowMs,
        }),
      ]);

      return consoleJsonResponse(200, {
        success: true,
        request: formatConsoleRequestDto(result.request, grants, seats),
        ...(result.staffMembershipRemoved !== undefined
          ? { staffMembershipRemoved: result.staffMembershipRemoved }
          : {}),
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: "console.custom_themes.requests.detail_method_check",
      requireStepUp: false,
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk detail permintaan tema kustom console. Gunakan GET atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PATCH" },
  );
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleCustomThemeRequestDetail(
    params.requestId ?? "",
    request,
    resolveConsoleCustomThemesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
