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
  handleConsoleAffiliateRead,
  handleConsoleAffiliateStatusMutation,
  resolveConsoleAffiliatesRuntimeEnv,
} from "../_shared.ts";

/**
 * `/api/console/affiliates/[affiliateId]`
 * - `GET`: Inspect single affiliate detail, compliance, balances, and payout batches.
 * - `PATCH`: Approve, suspend, or reject an affiliate (2FA step-up + superadmin RBAC +
 *   CSRF + mandatory 10–500 char reason + OCC `expectedVersion` + atomic `platform_audit`).
 */

export async function handleConsoleAffiliateDetailRequest(
  affiliateId: string,
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return handleConsoleAffiliateRead(affiliateId, request, runtimeEnv, options);
  }
  if (method === "PATCH") {
    return handleConsoleAffiliateStatusMutation(affiliateId, request, runtimeEnv, options);
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.method_check", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  return consoleErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan. Gunakan GET atau PATCH.",
    authz.ctx.requestId,
    undefined,
    { Allow: "GET, PATCH" },
  );
}

export const ALL: APIRoute = ({ params, request }) =>
  handleConsoleAffiliateDetailRequest(
    params.affiliateId ?? "",
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
