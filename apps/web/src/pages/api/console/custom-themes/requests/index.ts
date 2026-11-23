import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  CUSTOM_THEME_REQUEST_STATUSES,
  SERVICE_KINDS,
  type CustomThemeRequestStatus,
  type ServiceKind,
} from "@punyasitus/core/custom-themes/index";
import {
  listConsoleCustomThemeRequests,
  listTenantActiveCustomThemeGrants,
  type TenantCustomThemeGrantSummary,
} from "@punyasitus/db/custom-themes/index";
import type { APIRoute } from "astro";
import {
  formatConsoleRequestDto,
  mapConsoleCustomThemeErrorToResponse,
  resolveConsoleCustomThemesRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/console/custom-themes/requests`
 *
 * Lists custom theme service requests across tenants (from narrow `PLATFORM_DB`
 * control-plane metadata only; NEVER opens `TenantStore`), filterable by status
 * and tenant query, enriched with each tenant's active custom theme grants.
 * (REQ-063, PLAN §11.4 & §13, TASK-061).
 */

const STATUS_SET: ReadonlySet<string> = new Set(CUSTOM_THEME_REQUEST_STATUSES);
const SERVICE_KIND_SET: ReadonlySet<string> = new Set(SERVICE_KINDS);

export async function handleConsoleCustomThemeRequestsListRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.custom_themes.requests.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan untuk daftar permintaan tema kustom console. Gunakan GET.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const url = new URL(request.url);
    const rawStatus = url.searchParams.get("status")?.trim();
    const status: CustomThemeRequestStatus | undefined =
      rawStatus && STATUS_SET.has(rawStatus)
        ? (rawStatus as CustomThemeRequestStatus)
        : undefined;
    const rawKind = url.searchParams.get("serviceKind")?.trim();
    const serviceKind: ServiceKind | undefined =
      rawKind && SERVICE_KIND_SET.has(rawKind) ? (rawKind as ServiceKind) : undefined;
    const tenantQuery = url.searchParams.get("tenant")?.trim() || undefined;
    const rawLimit = url.searchParams.get("limit");
    const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
    const limit =
      typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    const requests = await listConsoleCustomThemeRequests(authz.ctx.platformDb, {
      serviceKind,
      status,
      tenantQuery,
      limit,
    });

    // Fetch active custom theme grants per distinct tenant so operators see eligible delivery grants
    const distinctTenantIds = Array.from(new Set(requests.map((r) => r.tenantId)));
    const grantEntries = await Promise.all(
      distinctTenantIds.map(async (tid) => {
        const grants = await listTenantActiveCustomThemeGrants(authz.ctx.platformDb, tid);
        return [tid, grants] as const;
      }),
    );
    const grantsByTenant = new Map<string, readonly TenantCustomThemeGrantSummary[]>(grantEntries);

    return consoleJsonResponse(200, {
      success: true,
      requests: requests.map((item) =>
        formatConsoleRequestDto(item, grantsByTenant.get(item.tenantId) ?? []),
      ),
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleCustomThemeRequestsListRequest(
    request,
    resolveConsoleCustomThemesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
