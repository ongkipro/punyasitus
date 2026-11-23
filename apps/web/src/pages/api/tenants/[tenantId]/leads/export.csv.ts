import {
  evaluateTenantApiEntitlement,
  loadLiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import {
  listAllLeadsForExport,
  recordLeadCsvExportAudit,
  serializeLeadsToCsv,
} from "@punyasitus/db/leads/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantLeadRequest,
  buildLeadsRuntimeEnv,
  createRequestId,
  leadErrorResponse,
  mapLeadDomainErrorToResponse,
  type TenantLeadsHandlerOptions,
  type TenantLeadsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Formula-Injection-Safe Lead CSV Export endpoint:
 * - `GET /api/tenants/:tenantId/leads/export.csv`
 *
 * Security & lifecycle invariants (REQ-032, REQ-039, REQ-060):
 * - Restricted to payer roles (`owner` or `agency_admin`) via `lead:export_csv` + live entitlement gate.
 * - Explicitly ALLOWED on `locked` (H+4..H+7) AND `suspended` (H+8+ / operator hold / trial expired)
 *   tenants so site owners can always recover their leads data.
 * - Neutralizes spreadsheet formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`).
 * - Always sets `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`.
 */

export interface TenantLeadsExportOptions extends TenantLeadsHandlerOptions {
  /** Optional row cap override (primarily for truncation testing; defaults to 10,000). */
  readonly maxExportRows?: number;
}

export async function handleTenantLeadsExportCsvRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsExportOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  const auth = await authorizeTenantLeadRequest(tenantId, request, runtimeEnv, "lead:export_csv", {
    ...options,
    requestId,
  });
  if (!auth.ok) return auth.response;

  if (method !== "GET") {
    return leadErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk ekspor CSV pesan masuk.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const { platformDb, tenantDb, member } = auth.ctx;

  // Enforce agencyManaged payer-only gate (owner on direct tenants, agency_admin on agency-managed tenants).
  try {
    const entitlement = await loadLiveTenantEntitlement(
      platformDb,
      { tenantId: member.tenantId },
      { nowMs: options.nowMs },
    );
    if (entitlement) {
      const decision = evaluateTenantApiEntitlement({
        entitlement,
        method: "GET",
        subPath: "/leads/export.csv",
        role: member.role,
      });
      if (!decision.allowed) {
        return leadErrorResponse(
          decision.status === 404 ? 404 : 403,
          decision.code ?? "FORBIDDEN",
          decision.message ?? "Akses ekspor CSV pesan masuk ditolak.",
          requestId,
        );
      }
    }
  } catch {
    return leadErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memverifikasi hak akses ekspor CSV.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }

  try {
    const { leads, truncated } = await listAllLeadsForExport(tenantDb, {
      maxRows: options.maxExportRows,
    });
    const csv = serializeLeadsToCsv(leads);
    const safeHandle = member.handle.replace(/[^a-z0-9-]/gi, "") || "tenant";

    await recordLeadCsvExportAudit(tenantDb, {
      actorUserId: member.userId,
      actorRole: member.role,
      exportedCount: leads.length,
      truncated,
      nowMs: options.nowMs,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-${safeHandle}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        Vary: "Cookie",
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (err) {
    return mapLeadDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadsExportCsvRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
