import { env } from "cloudflare:workers";
import {
  buildCustomThemeWhatsAppUrl,
  computeCustomThemeDayBucket,
  CUSTOM_THEME_DAILY_REQUEST_LIMIT,
  validateCreateCustomThemeRequestInput,
} from "@punyasitus/core/custom-themes/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  countTenantDailyCustomThemeRequests,
  listTenantCustomThemeRequests,
  submitTenantCustomThemeRequest,
} from "@punyasitus/db/custom-themes/index";
import { getPlatformSettings } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import { dispatchCustomThemeRequestOperatorNotices } from "../../../../../worker/queues/dispatch/custom-themes.ts";
import {
  authorizeTenantCustomThemeRequest,
  createCustomThemeRequestId,
  CUSTOM_THEME_REQUEST_CREATE_ALLOWED_KEYS,
  customThemeErrorResponse,
  customThemeJsonResponse,
  formatTenantCustomThemeRequestDto,
  mapTenantCustomThemeErrorToResponse,
  parseStrictTenantCustomThemeJsonBody,
  type TenantCustomThemeHandlerOptions,
  type TenantCustomThemeRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/tenants/:tenantId/custom-theme-requests`
 * - `GET`: list tenant-scoped custom theme requests (read-only) + daily quota + sales WA CTA
 * - `POST`: submit validated, idempotent, atomically 3/day-capped custom theme request
 *
 * (REQ-063, REQ-034, REQ-060; PLAN §11.4; TASK-061).
 * NEVER fetches submitted reference URLs. NEVER collects payment. ZERO runtime DDL.
 */

export async function handleTenantCustomThemeRequestsRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantCustomThemeRuntimeEnv,
  options: TenantCustomThemeHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createCustomThemeRequestId();

  const auth = await authorizeTenantCustomThemeRequest(tenantId, request, runtimeEnv, {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  const { platformDb, member, nowMs } = auth.ctx;

  if (method === "GET") {
    try {
      const dayBucket = computeCustomThemeDayBucket(nowMs);
      const [requests, dailyUsed, settings] = await Promise.all([
        listTenantCustomThemeRequests(platformDb, {
          tenantId: member.tenantId,
          serviceKind: "custom_theme",
          limit: 50,
        }),
        countTenantDailyCustomThemeRequests(platformDb, {
          tenantId: member.tenantId,
          serviceKind: "custom_theme",
          dayBucket,
        }),
        getPlatformSettings(platformDb),
      ]);

      const salesWhatsapp = settings.salesWhatsapp || null;
      const contactWa = buildCustomThemeWhatsAppUrl({
        salesWhatsapp,
        tenantHandle: member.handle,
      });

      return customThemeJsonResponse(200, {
        success: true,
        requests: requests.map((item) => formatTenantCustomThemeRequestDto(item, salesWhatsapp)),
        dailyQuota: {
          used: dailyUsed,
          limit: CUSTOM_THEME_DAILY_REQUEST_LIMIT,
          remaining: Math.max(0, CUSTOM_THEME_DAILY_REQUEST_LIMIT - dailyUsed),
          dayBucket,
        },
        salesWhatsappConfigured: contactWa !== null,
        contactWhatsappUrl: contactWa?.url ?? null,
        requestId: auth.ctx.requestId,
      });
    } catch (err) {
      return mapTenantCustomThemeErrorToResponse(err, auth.ctx.requestId);
    }
  }

  if (method === "POST") {
    const parsed = await parseStrictTenantCustomThemeJsonBody(
      request,
      auth.ctx.requestId,
      CUSTOM_THEME_REQUEST_CREATE_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const headerIdempotencyKey = request.headers.get("Idempotency-Key");
      const validated = validateCreateCustomThemeRequestInput(parsed.body, {
        headerIdempotencyKey,
        serviceKind: "custom_theme",
      });

      const submitted = await submitTenantCustomThemeRequest(platformDb, {
        tenantId: member.tenantId,
        tenantHandle: member.handle,
        requestedByUserId: member.userId,
        input: validated,
        nowMs,
      });

      if (submitted.created) {
        // Non-blocking durable email notice to active platform operators (PLAN §11.4, REQ-077)
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
      const dto = formatTenantCustomThemeRequestDto(submitted.request, salesWhatsapp);

      return customThemeJsonResponse(submitted.created ? 201 : 200, {
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
      return mapTenantCustomThemeErrorToResponse(err, auth.ctx.requestId);
    }
  }

  return customThemeErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk permintaan tema kustom. Gunakan GET atau POST.",
    auth.ctx.requestId,
    { extraHeaders: { Allow: "GET, POST" } },
  );
}

function buildRuntimeEnv(): TenantCustomThemeRuntimeEnv {
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
  handleTenantCustomThemeRequestsRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
