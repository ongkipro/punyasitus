import {
  evaluateTenantApiEntitlement,
  loadLiveTenantEntitlement,
} from "@punyasitus/auth/entitlements/index";
import {
  listAllLeadsForExport,
  recordLeadCsvExportAudit,
  serializeLeadsToCsv,
} from "@punyasitus/db/leads/index";
import { checkAndConsumeLeadsExportRateLimit } from "@punyasitus/db/offboarding/index";
import { appendPlatformAudit } from "@punyasitus/db/platform/audit";
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
 * Owner-Only Locked/Suspended Leads CSV Export endpoint (`REQ-069`, `DEC-022`, `TASK-068`):
 * - `GET /api/tenants/:tenantId/leads/export`
 *
 * Security, lockout & privacy invariants:
 * - Works while tenant is `locked` (`H+4..H+7`) OR `suspended` (`H+8+`, unpaid trial expiry,
 *   or manual operator hold) — passes the lockout allowlist while leads inbox UI and other lead
 *   APIs stay locked (`403 SUBSCRIPTION_LOCKED`).
 * - Strictly **owner-only** (direct tenant: `owner` only; agency-managed: `agency_admin` only);
 *   `admin` and `editor` get `403 FORBIDDEN`, cross-tenant / non-member gets `404 NOT_FOUND`.
 * - Denied when tenant is `purging` (`403 SUBSCRIPTION_LOCKED`) or `purged` (`404 NOT_FOUND`).
 * - Rate-limited per `(tenantId, userId)` with `429 RATE_LIMITED` + `Retry-After` + audited denial.
 * - Audited in BOTH `TenantStore.tenant_activity_log` AND `PLATFORM_DB.platform_audit` (zero PII).
 * - Always returns formula-injection-safe CSV with `Cache-Control: private, no-store`,
 *   `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, `Vary: Cookie`.
 */

export interface TenantLeadsExportEndpointOptions extends TenantLeadsHandlerOptions {
  /** Optional row cap override (defaults to 10,000). */
  readonly maxExportRows?: number;
  /** Optional rate-limit ceiling override (defaults to 10 per window). */
  readonly rateLimitMax?: number;
  /** Optional rate-limit window override in ms (defaults to 15 minutes). */
  readonly rateLimitWindowMs?: number;
}

export async function handleTenantLeadsExportRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsExportEndpointOptions = {},
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
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  let effectiveStatus: string;

  // Enforce strict live entitlement + owner-only payer gate (passes `locked` & `suspended`,
  // denies `admin`/`editor` with 403, denies `purging` with 403, denies `purged` with 404).
  try {
    const entitlement = await loadLiveTenantEntitlement(
      platformDb,
      { tenantId: member.tenantId },
      { nowMs },
    );
    if (!entitlement) {
      return leadErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId);
    }
    effectiveStatus = entitlement.evaluation.effectiveStatus;

    const decision = evaluateTenantApiEntitlement({
      entitlement,
      method: "GET",
      subPath: "/leads/export",
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

    // Strict owner-only enforcement on direct tenants (never admin/editor)
    if (!entitlement.evaluation.agencyManaged && member.role !== "owner") {
      return leadErrorResponse(
        403,
        "FORBIDDEN",
        "Hanya pemilik situs (Owner) yang dapat mengekspor data pesan masuk (CSV).",
        requestId,
      );
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

  // Enforce per-(tenant, owner) rate limit with zero runtime DDL
  let rateLimit;
  try {
    rateLimit = await checkAndConsumeLeadsExportRateLimit(platformDb, {
      tenantId: member.tenantId,
      userId: member.userId,
      nowMs,
      maxRequests: options.rateLimitMax,
      windowMs: options.rateLimitWindowMs,
    });
  } catch {
    return leadErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal memeriksa batas laju ekspor CSV.",
      requestId,
      undefined,
      { "Retry-After": "60" },
    );
  }

  if (!rateLimit.allowed) {
    try {
      await appendPlatformAudit(platformDb, {
        actorUserId: member.userId,
        actorRole: member.role,
        action: "tenant.leads.export_csv_rate_limited",
        targetType: "tenant",
        targetId: member.tenantId,
        tenantId: member.tenantId,
        outcome: "denied",
        requestId,
        metadata: {
          effectiveStatus,
          limit: rateLimit.limit,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        createdAtMs: nowMs,
      });
    } catch {
      // Non-blocking audit on rate-limit denial
    }

    return leadErrorResponse(
      429,
      "RATE_LIMITED",
      "Terlalu banyak permintaan ekspor CSV pesan masuk. Silakan coba lagi beberapa saat lagi.",
      requestId,
      undefined,
      {
        "Retry-After": String(rateLimit.retryAfterSeconds),
        "X-RateLimit-Limit": String(rateLimit.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(rateLimit.resetAtMs / 1000)),
      },
    );
  }

  try {
    const { leads, truncated } = await listAllLeadsForExport(tenantDb, {
      maxRows: options.maxExportRows,
    });
    const csv = serializeLeadsToCsv(leads);
    const safeHandle = member.handle.replace(/[^a-z0-9-]/gi, "") || "tenant";

    // Audit in BOTH tenant activity log and immutable platform_audit (strictly zero PII)
    await recordLeadCsvExportAudit(tenantDb, {
      actorUserId: member.userId,
      actorRole: member.role,
      exportedCount: leads.length,
      truncated,
      nowMs,
    });

    try {
      await appendPlatformAudit(platformDb, {
        actorUserId: member.userId,
        actorRole: member.role,
        action: "tenant.leads.export_csv",
        targetType: "tenant",
        targetId: member.tenantId,
        tenantId: member.tenantId,
        outcome: "success",
        requestId,
        metadata: {
          effectiveStatus,
          exportedCount: leads.length,
          truncated,
        },
        createdAtMs: nowMs,
      });
    } catch {
      // Non-blocking: transient platform_audit failure must never block owner recovery export
      // after a rate-limit slot has already been consumed (strictly zero PII in warning).
      console.warn(
        JSON.stringify({
          event: "tenant.leads.export_csv.platform_audit_failed",
          tenantId: member.tenantId,
          requestId,
        }),
      );
    }

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-${safeHandle}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
        Vary: "Cookie",
        "X-RateLimit-Limit": String(rateLimit.limit),
        "X-RateLimit-Remaining": String(rateLimit.remaining),
        "X-RateLimit-Reset": String(Math.floor(rateLimit.resetAtMs / 1000)),
        ...(truncated ? { "X-Truncated": "1" } : {}),
      },
    });
  } catch (err) {
    return mapLeadDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadsExportRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
