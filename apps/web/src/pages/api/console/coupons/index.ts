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
import { validateCreatePromoCouponInput } from "@punyasitus/core/billing/coupons";
import { createPromoCoupon, listPromoCoupons } from "@punyasitus/db/billing/coupons/index";
import type { APIRoute } from "astro";
import {
  formatPromoCouponDto,
  mapConsoleCouponErrorToResponse,
  resolveConsoleCouponsRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/coupons` — List & audited creation of promotional coupons
 * (REQ-082, REQ-051, PLAN §13 & §19.3, TASK-082).
 *
 * Security boundaries:
 * - Strictly `console.punyasitus.com` host (404 on app/tenant/marketing hosts).
 * - Requires active platform operator + verified 2FA; POST requires recent 2FA step-up
 *   (`403 REAUTH_REQUIRED`), CSRF/Origin validation, strict JSON key allowlist,
 *   mandatory 10–500 char audit reason, and atomic `platform_audit` persistence.
 * - ZERO runtime DDL.
 */

const CREATE_COUPON_ALLOWED_KEYS = new Set([
  "code",
  "discountKind",
  "discountValue",
  "eligiblePlans",
  "eligiblePayerTypes",
  "maxRedemptions",
  "startsAt",
  "endsAt",
  "active",
  "notes",
  "reason",
]);

export async function handleConsoleCouponsRequest(
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
      { action: "console.coupons.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const url = new URL(request.url);
      const activeOnlyParam = url.searchParams.get("activeOnly")?.trim().toLowerCase();
      const activeOnly = activeOnlyParam === "true" || activeOnlyParam === "1";
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
      const limit =
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

      const coupons = await listPromoCoupons(authz.ctx.platformDb, { activeOnly, limit });
      return consoleJsonResponse(200, {
        success: true,
        coupons: coupons.map(formatPromoCouponDto),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCouponErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.coupons.create", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      CREATE_COUPON_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const validated = validateCreatePromoCouponInput(parsed.body);
      const result = await createPromoCoupon(authz.ctx.platformDb, {
        input: validated,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, {
        success: true,
        coupon: formatPromoCouponDto(result.coupon),
        auditId: result.audit.id,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsoleCouponErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.coupons.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan untuk endpoint kupon promo console. Gunakan GET atau POST.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleCouponsRequest(
    request,
    resolveConsoleCouponsRuntimeEnv(env as unknown as Record<string, unknown>),
  );
