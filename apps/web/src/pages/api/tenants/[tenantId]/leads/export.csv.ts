import type { APIRoute } from "astro";
import { buildLeadsRuntimeEnv, type TenantLeadsRuntimeEnv } from "./_shared.ts";
import {
  handleTenantLeadsExportRequest,
  type TenantLeadsExportEndpointOptions,
} from "./export.ts";

/**
 * Legacy-compatible alias for the Owner-Only Formula-Injection-Safe Lead CSV Export endpoint:
 * - `GET /api/tenants/:tenantId/leads/export.csv`
 *
 * Delegates directly to `handleTenantLeadsExportRequest` (`./export.ts`) so both routes enforce
 * identical strict live entitlement gates (fail-closed on null entitlement), owner-only authorization,
 * per-(tenant, user) rate limiting, and dual PII-free audit logging.
 */

export type TenantLeadsExportOptions = TenantLeadsExportEndpointOptions;

export function handleTenantLeadsExportCsvRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsExportOptions = {},
): Promise<Response> {
  return handleTenantLeadsExportRequest(tenantId, request, runtimeEnv, options);
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadsExportCsvRequest(params.tenantId ?? "", request, buildLeadsRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
