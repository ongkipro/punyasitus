import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
} from "@punyasitus/auth/platform/index";
import {
  listConsoleBillingRecords,
  type BillingObligationApiState,
} from "@punyasitus/db/billing/index";
import type { APIRoute } from "astro";
import {
  getConsoleSettlementPolicySummary,
  mapConsoleBillingErrorToResponse,
  resolveConsoleBillingRuntimeEnv,
  type ConsoleBillingHandlerOptions,
  type ConsoleBillingRuntimeEnv,
} from "./_shared.ts";

/**
 * `GET /api/console/billing` — Scoped, strictly redacted platform operator billing
 * inspection & review queue (REQ-057, REQ-058; PLAN §16.3, §16.4; TASK-056).
 *
 * Security boundaries:
 * - Strictly `console.punyasitus.com` host ONLY (404 on app/tenant/marketing hosts).
 * - Requires active platform operator + verified 2FA.
 * - Returns `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 * - NEVER leaks API keys, QRIS payloads, VA numbers, payment redirect URLs, raw
 *   provider payloads, or customer PII.
 */

const VALID_STATE_FILTERS: ReadonlySet<string> = new Set([
  "open",
  "paid",
  "cancelled",
  "expired",
  "review",
]);

export async function handleConsoleBillingListRequest(
  request: Request,
  runtimeEnv: ConsoleBillingRuntimeEnv,
  options: ConsoleBillingHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method !== "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.billing.method_check", requireStepUp: false, enforceCsrf: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Hanya metode GET yang diizinkan untuk daftar billing console.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.billing.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get("tenantId")?.trim() || undefined;
    const reviewOnlyParam = url.searchParams.get("reviewOnly")?.trim().toLowerCase();
    const reviewOnly = reviewOnlyParam === "true" || reviewOnlyParam === "1";
    const rawState = url.searchParams.get("state")?.trim().toLowerCase() || undefined;
    if (rawState && !VALID_STATE_FILTERS.has(rawState)) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Filter state "${rawState}" tidak valid.`,
        authz.ctx.requestId,
      );
    }

    const rawLimit = url.searchParams.get("limit");
    const parsedLimit = rawLimit !== null ? Number.parseInt(rawLimit, 10) : undefined;
    const limit =
      typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;

    const data = await listConsoleBillingRecords(authz.ctx.platformDb, {
      tenantId,
      reviewOnly,
      state: rawState as BillingObligationApiState | undefined,
      limit,
    });

    return consoleJsonResponse(200, {
      success: true,
      settlementPolicy: getConsoleSettlementPolicySummary(options.settlementPolicy),
      obligations: data.obligations,
      refunds: data.refunds,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleBillingErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleBillingListRequest(
    request,
    resolveConsoleBillingRuntimeEnv(env as unknown as Record<string, unknown>),
  );
