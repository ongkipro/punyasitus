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
import { validateUpdateCustomThemePackageInput } from "@punyasitus/core/custom-themes/index";
import {
  getCustomThemePackageById,
  updateCustomThemePackage,
} from "@punyasitus/db/custom-themes/index";
import type { APIRoute } from "astro";
import {
  formatConsolePackageDto,
  mapConsoleCustomThemeErrorToResponse,
  resolveConsoleCustomThemesRuntimeEnv,
} from "../_shared.ts";

/**
 * `/api/console/custom-themes/packages/:packageId`
 * - `GET`: read single service package
 * - `PATCH`: optimistic-locked edit / reorder / deactivate / reactivate with recent 2FA
 *   step-up, mandatory reason (10–500 chars), and atomic `platform_audit` (`WHERE changes() = 1`).
 *
 * Deactivating preserves referenced packages — DELETE is intentionally disallowed!
 * (REQ-063, PLAN §11.4 & §13, TASK-061).
 */

const UPDATE_PACKAGE_ALLOWED_KEYS = new Set([
  "expectedVersion",
  "name",
  "description",
  "inclusions",
  "startingPriceIdr",
  "estimatedDuration",
  "sortOrder",
  "active",
  "reason",
]);

export async function handleConsoleCustomThemePackageDetailRequest(
  packageId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();
  const cleanId = packageId.trim();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.packages.read", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanId) {
      return consoleErrorResponse(404, "NOT_FOUND", "Paket tema kustom tidak ditemukan.", authz.ctx.requestId);
    }

    try {
      const pkg = await getCustomThemePackageById(authz.ctx.platformDb, cleanId);
      if (!pkg) {
        return consoleErrorResponse(
          404,
          "NOT_FOUND",
          "Paket tema kustom tidak ditemukan.",
          authz.ctx.requestId,
        );
      }
      return consoleJsonResponse(200, {
        success: true,
        package: formatConsolePackageDto(pkg),
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
      { action: "console.custom_themes.packages.update", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    if (!cleanId) {
      return consoleErrorResponse(404, "NOT_FOUND", "Paket tema kustom tidak ditemukan.", authz.ctx.requestId);
    }

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      UPDATE_PACKAGE_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const validated = validateUpdateCustomThemePackageInput(parsed.body);
      const result = await updateCustomThemePackage(authz.ctx.platformDb, {
        packageId: cleanId,
        input: validated,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(200, {
        success: true,
        package: formatConsolePackageDto(result.pkg),
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
      action: "console.custom_themes.packages.detail_method_check",
      requireStepUp: false,
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk detail paket tema kustom console. Gunakan GET atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PATCH" },
  );
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleCustomThemePackageDetailRequest(
    params.packageId ?? "",
    request,
    resolveConsoleCustomThemesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
