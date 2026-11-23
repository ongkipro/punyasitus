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
import {
  SERVICE_KINDS,
  validateCreateCustomThemePackageInput,
  type ServiceKind,
} from "@punyasitus/core/custom-themes/index";
import {
  createCustomThemePackage,
  listCustomThemePackages,
} from "@punyasitus/db/custom-themes/index";
import type { APIRoute } from "astro";
import {
  formatConsolePackageDto,
  mapConsoleCustomThemeErrorToResponse,
  resolveConsoleCustomThemesRuntimeEnv,
} from "../_shared.ts";

/**
 * `/api/console/custom-themes/packages`
 * - `GET`: list all service packages (active + inactive, ordered by `sort_order`)
 * - `POST`: create a new service package with recent 2FA step-up, mandatory reason,
 *   and atomic `platform_audit` (`WHERE changes() = 1`).
 *
 * Strictly `console.punyasitus.com` host (404 on app/tenant/marketing hosts).
 * ZERO runtime DDL. (REQ-063, PLAN §11.4 & §13, TASK-061).
 */

const CREATE_PACKAGE_ALLOWED_KEYS = new Set([
  "serviceKind",
  "slug",
  "name",
  "description",
  "inclusions",
  "startingPriceIdr",
  "estimatedDuration",
  "sortOrder",
  "active",
  "reason",
]);

const SERVICE_KIND_SET: ReadonlySet<string> = new Set(SERVICE_KINDS);

export async function handleConsoleCustomThemePackagesRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.packages.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const url = new URL(request.url);
      const activeOnlyParam = url.searchParams.get("activeOnly")?.trim().toLowerCase();
      const activeOnly = activeOnlyParam === "true" || activeOnlyParam === "1";
      const rawKind = url.searchParams.get("serviceKind")?.trim();
      const serviceKind: ServiceKind | undefined =
        rawKind && SERVICE_KIND_SET.has(rawKind) ? (rawKind as ServiceKind) : undefined;
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
      const limit =
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

      const packages = await listCustomThemePackages(authz.ctx.platformDb, {
        serviceKind,
        activeOnly,
        limit,
      });

      return consoleJsonResponse(200, {
        success: true,
        packages: packages.map(formatConsolePackageDto),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.packages.create", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      CREATE_PACKAGE_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const validated = validateCreateCustomThemePackageInput(parsed.body);
      const result = await createCustomThemePackage(authz.ctx.platformDb, {
        input: validated,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, {
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
    { action: "console.custom_themes.packages.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk paket tema kustom console. Gunakan GET atau POST.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleCustomThemePackagesRequest(
    request,
    resolveConsoleCustomThemesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
