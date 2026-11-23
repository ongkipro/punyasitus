import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { AffiliatePayoutBatchStatus } from "@punyasitus/core/affiliates/commission";
import type { AffiliateDbStatus } from "@punyasitus/core/affiliates/index";
import { appendPlatformAudit } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  loadConsoleAffiliatesDashboard,
  mapConsoleAffiliateErrorToResponse,
  resolveConsoleAffiliatesRuntimeEnv,
  resolveConsoleMarketingOrigin,
  serializeConsoleAffiliatesCsv,
  serializeConsolePayoutBatchesCsv,
} from "./_shared.ts";

/**
 * `GET /api/console/affiliates`
 * Lists affiliates & payout batches (JSON) or exports formula-injection-safe CSV
 * (`?format=csv&export=affiliates|batches`) on `console.punyasitus.com` ONLY
 * (REQ-086, REQ-051, REQ-068, PLAN §19.4, TASK-086).
 */

function parseAffiliateStatusFilter(raw: string | null): AffiliateDbStatus | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "pending" || v === "active" || v === "suspended" || v === "rejected") {
    return v;
  }
  return undefined;
}

function parseBatchStatusFilter(raw: string | null): AffiliatePayoutBatchStatus | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "pending_review" || v === "paid" || v === "canceled") {
    return v;
  }
  return undefined;
}

export async function handleConsoleAffiliatesListRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.affiliates.list", requireStepUp: false, enforceCsrf: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET untuk membaca atau mengekspor data afiliasi console.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  try {
    const url = new URL(request.url);
    const status = parseAffiliateStatusFilter(url.searchParams.get("status"));
    const batchStatus = parseBatchStatusFilter(url.searchParams.get("batchStatus"));
    const format = (url.searchParams.get("format") ?? "json").trim().toLowerCase();
    const exportScope = (url.searchParams.get("export") ?? "affiliates").trim().toLowerCase();

    const dashboard = await loadConsoleAffiliatesDashboard(authz.ctx.platformDb, {
      status,
      batchStatus,
      marketingOrigin: resolveConsoleMarketingOrigin(runtimeEnv),
      limit: 200,
    });

    if (format === "csv") {
      const dateStamp = new Date(authz.ctx.nowMs).toISOString().slice(0, 10);
      const isBatches = exportScope === "batches";
      const csv = isBatches
        ? serializeConsolePayoutBatchesCsv(dashboard.batches)
        : serializeConsoleAffiliatesCsv(dashboard.affiliates);
      const filename = isBatches
        ? `punyasitus-affiliate-payout-batches-${dateStamp}.csv`
        : `punyasitus-affiliates-${dateStamp}.csv`;

      await appendPlatformAudit(authz.ctx.platformDb, {
        actorUserId: authz.ctx.user.id,
        actorRole: "platform_operator",
        action: "console.affiliates.export_csv",
        targetType: isBatches ? "affiliate_payout_batch" : "affiliate",
        targetId: isBatches ? "batches_csv" : "affiliates_csv",
        reason: null,
        requireReason: false,
        outcome: "success",
        requestId: authz.ctx.requestId,
        createdAtMs: authz.ctx.nowMs,
        metadata: {
          exportScope: isBatches ? "batches" : "affiliates",
          rowCount: isBatches ? dashboard.batches.length : dashboard.affiliates.length,
          statusFilter: status ?? null,
          batchStatusFilter: batchStatus ?? null,
        },
      });

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return consoleJsonResponse(200, {
      success: true,
      ...dashboard,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsoleAffiliateErrorToResponse(err, authz.ctx.requestId);
  }
}

export const GET: APIRoute = ({ request }) =>
  handleConsoleAffiliatesListRequest(
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );

export const ALL: APIRoute = ({ request }) =>
  handleConsoleAffiliatesListRequest(
    request,
    resolveConsoleAffiliatesRuntimeEnv(env as unknown as Record<string, unknown>),
  );
