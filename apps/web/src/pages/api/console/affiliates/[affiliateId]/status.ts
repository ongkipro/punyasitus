import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { APIRoute } from "astro";
import {
  handleConsoleAffiliateStatusMutation,
  resolveConsoleAffiliatesRuntimeEnv,
} from "../_shared.ts";

/**
 * `POST /api/console/affiliates/[affiliateId]/status`
 * Audited superadmin status transitions (`approve`, `suspend`, `reject`) requiring
 * console host isolation, CSRF/Origin, `platform_superadmin` RBAC, fresh 2FA step-up,
 * mandatory 10–500 char `reason`, OCC `expectedVersion`, and atomic `platform_audit`.
 */

export async function handleConsoleAffiliateStatusRequest(
  affiliateId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "POST") {
    return handleConsoleAffiliateStatusMutation(affiliateId, request, runtimeEnv, options);
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.status.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Gunakan metode POST untuk mengubah status akun afiliasi.",
    authz.ctx.requestId,
    undefined,
    { Allow: "POST" },
  );
}

export const POST: APIRoute = ({ params, request }) =>
  handleConsoleAffiliateStatusRequest(
    params.affiliateId ?? "",
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleAffiliateStatusRequest(
    params.affiliateId ?? "",
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
