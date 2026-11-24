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
  CONSOLE_AFFILIATE_DASHBOARD_MAX_ROWS,
  loadConsoleAffiliatesCsvExport,
  loadConsoleAffiliatesDashboard,
  mapConsoleAffiliateErrorToResponse,
  parseConsoleCsvExportOffset,
  resolveConsoleAffiliatesRuntimeEnv,
  resolveConsoleCsvMaxRows,
  resolveConsoleMarketingOrigin,
  serializeConsoleAffiliatesCsv,
  serializeConsolePayoutBatchesCsv,
} from "./_shared.ts";

/**
 * `GET /api/console/affiliates`
 * Lists affiliates & payout batches (JSON) or exports formula-injection-safe CSV
 * (`?format=csv&export=affiliates|batches[&offset=<n>][&limit=<n>]`) on `console.punyasitus.com` ONLY.
 *
 * Security & correctness invariants (SEC-004, ASVS V6.4, V16.3, REQ-086, REQ-051, REQ-068):
 * - Read-only JSON listing (`format !== "csv"`) requires active operator + 2FA (`requireStepUp: false`).
 * - Payout/bank CSV export (`format === "csv"`) requires recent 10-minute 2FA step-up (`requireStepUp: true`).
 * - CSV export queries `maxRows + 1` (default cap 5,000) and always emits `X-Export-Row-Count`,
 *   `X-Export-Max-Rows`, `X-Export-Truncated`, `X-Export-Offset`, and (when truncated) `X-Export-Next-Offset`.
 */

export interface ConsoleAffiliatesListOptions extends ConsoleHandlerOptions {
  /** Optional upper bound override for CSV export rows (bounded to [1, CONSOLE_AFFILIATE_CSV_MAX_ROWS]). */
  readonly csvMaxRows?: number;
}

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

function safeParseRequestUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export async function handleConsoleAffiliatesListRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleAffiliatesListOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();
  const parsedUrl = safeParseRequestUrl(request.url);
  const format = (parsedUrl?.searchParams.get("format") ?? "json").trim().toLowerCase();
  const isCsvExport = format === "csv";

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: isCsvExport ? "console.affiliates.export_csv" : "console.affiliates.list",
      requireStepUp: isCsvExport,
      enforceCsrf: false,
    },
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
    const url = parsedUrl ?? new URL(request.url);
    const status = parseAffiliateStatusFilter(url.searchParams.get("status"));
    const batchStatus = parseBatchStatusFilter(url.searchParams.get("batchStatus"));
    const exportScope = (url.searchParams.get("export") ?? "affiliates").trim().toLowerCase();
    const marketingOrigin = resolveConsoleMarketingOrigin(runtimeEnv);

    if (isCsvExport) {
      const dateStamp = new Date(authz.ctx.nowMs).toISOString().slice(0, 10);
      const isBatches = exportScope === "batches";
      const maxRows = resolveConsoleCsvMaxRows(url.searchParams.get("limit"), options.csvMaxRows);
      const offset = parseConsoleCsvExportOffset(url.searchParams.get("offset"));

      const exportPage = await loadConsoleAffiliatesCsvExport(authz.ctx.platformDb, {
        scope: isBatches ? "batches" : "affiliates",
        status,
        batchStatus,
        marketingOrigin,
        maxRows,
        offset,
      });

      const csv =
        exportPage.scope === "batches"
          ? serializeConsolePayoutBatchesCsv(exportPage.rows)
          : serializeConsoleAffiliatesCsv(exportPage.rows);
      const filename =
        exportPage.scope === "batches"
          ? `punyasitus-affiliate-payout-batches-${dateStamp}.csv`
          : `punyasitus-affiliates-${dateStamp}.csv`;

      await appendPlatformAudit(authz.ctx.platformDb, {
        actorUserId: authz.ctx.user.id,
        actorRole: "platform_operator",
        action: "console.affiliates.export_csv",
        targetType: exportPage.scope === "batches" ? "affiliate_payout_batch" : "affiliate",
        targetId: exportPage.scope === "batches" ? "batches_csv" : "affiliates_csv",
        reason: null,
        requireReason: false,
        outcome: "success",
        requestId: authz.ctx.requestId,
        createdAtMs: authz.ctx.nowMs,
        metadata: {
          exportScope: exportPage.scope,
          rowCount: exportPage.rowCount,
          maxRows: exportPage.maxRows,
          offset: exportPage.offset,
          truncated: exportPage.truncated,
          nextOffset: exportPage.nextOffset,
          statusFilter: status ?? null,
          batchStatusFilter: batchStatus ?? null,
        },
      });

      const responseHeaders: Record<string, string> = {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Row-Count": String(exportPage.rowCount),
        "X-Export-Max-Rows": String(exportPage.maxRows),
        "X-Export-Truncated": exportPage.truncated ? "true" : "false",
        "X-Export-Offset": String(exportPage.offset),
      };
      if (exportPage.nextOffset !== null) {
        responseHeaders["X-Export-Next-Offset"] = String(exportPage.nextOffset);
      }

      return new Response(csv, {
        status: 200,
        headers: responseHeaders,
      });
    }

    const dashboard = await loadConsoleAffiliatesDashboard(authz.ctx.platformDb, {
      status,
      batchStatus,
      marketingOrigin,
      limit: CONSOLE_AFFILIATE_DASHBOARD_MAX_ROWS,
    });

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
