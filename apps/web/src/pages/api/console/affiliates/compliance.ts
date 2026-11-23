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
import type { APIRoute } from "astro";
import {
  assertConsoleAffiliateSuperadminRole,
  mapConsoleAffiliateErrorToResponse,
  resolveConsoleAffiliatesRuntimeEnv,
  updatePlatformAffiliateCompliance,
} from "./_shared.ts";

/**
 * `POST /api/console/affiliates/compliance`
 * Audited superadmin endpoint to record resolution of the REQ-095 affiliate tax & terms
 * compliance gate (`affiliate.payout_compliance` in `platform_settings` + `platform_audit`).
 */

const COMPLIANCE_ALLOWED_KEYS = new Set([
  "affiliateTermsPublished",
  "affiliateTaxReviewCompleted",
  "notes",
  "reason",
]);

export async function handleConsoleAffiliateComplianceRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method !== "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.affiliates.compliance.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk memperbarui status kepatuhan pajak & ketentuan afiliasi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.compliance.update", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const rbacErr = assertConsoleAffiliateSuperadminRole(authz.ctx.actor, authz.ctx.requestId);
  if (rbacErr) return rbacErr;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    COMPLIANCE_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  if (
    typeof parsed.body.affiliateTermsPublished !== "boolean" ||
    typeof parsed.body.affiliateTaxReviewCompleted !== "boolean"
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field affiliateTermsPublished dan affiliateTaxReviewCompleted wajib berupa boolean.",
      authz.ctx.requestId,
    );
  }

  try {
    const result = await updatePlatformAffiliateCompliance(authz.ctx.platformDb, {
      actorUserId: authz.ctx.user.id,
      affiliateTermsPublished: parsed.body.affiliateTermsPublished,
      affiliateTaxReviewCompleted: parsed.body.affiliateTaxReviewCompleted,
      notes: typeof parsed.body.notes === "string" ? parsed.body.notes : null,
      reason: typeof parsed.body.reason === "string" ? parsed.body.reason : "",
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      success: true,
      compliance: result.compliance,
      auditId: result.audit.id,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleAffiliateErrorToResponse(err, authz.ctx.requestId);
  }
}

export const POST: APIRoute = ({ request }) =>
  handleConsoleAffiliateComplianceRequest(
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ request }) =>
  handleConsoleAffiliateComplianceRequest(
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
