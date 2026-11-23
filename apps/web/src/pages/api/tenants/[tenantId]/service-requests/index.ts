import { env } from "cloudflare:workers";
import { validateCreateSetupServiceRequestInput } from "@punyasitus/core/custom-themes/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { submitTenantCustomThemeRequest } from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import { dispatchCustomThemeRequestOperatorNotices } from "../../../../../worker/queues/dispatch/custom-themes.ts";
import {
  authorizeTenantServiceRequest,
  createServiceRequestId,
  formatTenantSetupRequestDto,
  loadTenantSetupServiceState,
  mapTenantServiceRequestErrorToResponse,
  parseStrictServiceRequestJsonBody,
  serviceRequestErrorResponse,
  serviceRequestJsonResponse,
  type TenantServiceRequestHandlerOptions,
  type TenantServiceRequestRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/tenants/:tenantId/service-requests`
 * - `GET`: list active Terima Beres (`service_kind = 'setup'`) packages, tenant-scoped
 *   requests (with staff access status), live 5-seat usage, daily quota, and sales WA CTA.
 * - `POST`: submit validated (Zod v4 `.strict()`), idempotent, atomically 3/day-capped
 *   Terima Beres setup service request.
 *
 * (REQ-070, REQ-034, REQ-035, REQ-065; PLAN §11.4 & §18.2; TASK-069).
 * NEVER collects payment. NEVER fetches submitted reference URLs. ZERO runtime DDL.
 */

export async function handleTenantServiceRequestsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantServiceRequestRuntimeEnv,
  options: TenantServiceRequestHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createServiceRequestId();

  const auth = await authorizeTenantServiceRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
    requiredPermission: "theme:custom_request",
  });
  if (!auth.ok) return auth.response;

  const { platformDb, member, nowMs } = auth.ctx;

  if (method === "GET") {
    try {
      const state = await loadTenantSetupServiceState(platformDb, member, nowMs);
      return serviceRequestJsonResponse(200, {
        success: true,
        packages: state.packages,
        requests: state.requests,
        seats: state.seats,
        canApproveStaff: state.canApproveStaff,
        dailyQuota: state.dailyQuota,
        salesWhatsappConfigured: state.salesWhatsappConfigured,
        contactWhatsappUrl: state.contactWhatsappUrl,
        supportEmail: state.supportEmail,
        requestId: auth.ctx.requestId,
      });
    } catch (err) {
      return mapTenantServiceRequestErrorToResponse(err, auth.ctx.requestId);
    }
  }

  if (method === "POST") {
    const parsed = await parseStrictServiceRequestJsonBody(request, auth.ctx.requestId);
    if (!parsed.ok) return parsed.response;

    try {
      const headerIdempotencyKey = request.headers.get("Idempotency-Key");
      const validated = validateCreateSetupServiceRequestInput(parsed.body, {
        headerIdempotencyKey,
      });

      const submitted = await submitTenantCustomThemeRequest(platformDb, {
        tenantId: member.tenantId,
        tenantHandle: member.handle,
        requestedByUserId: member.userId,
        input: validated,
        nowMs,
      });

      if (submitted.created) {
        await dispatchCustomThemeRequestOperatorNotices(
          {
            PLATFORM_DB: platformDb,
            JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
            PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
          },
          {
            request: submitted.request,
            correlationId: auth.ctx.requestId,
            nowMs,
          },
        );
      }

      const settings = await getPlatformSettings(platformDb);
      const salesWhatsapp = settings.salesWhatsapp || null;
      const dto = formatTenantSetupRequestDto(submitted.request, salesWhatsapp);

      return serviceRequestJsonResponse(submitted.created ? 201 : 200, {
        success: true,
        created: submitted.created,
        idempotentReplay: !submitted.created,
        request: dto,
        dailyQuota: {
          used: submitted.dailyUsedCount,
          limit: submitted.dailyLimit,
          remaining: Math.max(0, submitted.dailyLimit - submitted.dailyUsedCount),
          dayBucket: submitted.request.dayBucket,
        },
        requestId: auth.ctx.requestId,
      });
    } catch (err) {
      return mapTenantServiceRequestErrorToResponse(err, auth.ctx.requestId);
    }
  }

  return serviceRequestErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk permintaan Layanan Terima Beres. Gunakan GET atau POST.",
    auth.ctx.requestId,
    { extraHeaders: { Allow: "GET, POST" } },
  );
}

function buildRuntimeEnv(): TenantServiceRequestRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly JOBS_QUEUE?: { send(message: unknown): Promise<unknown> };
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantServiceRequestsRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
