import type { APIRoute } from "astro";
import { buildDomainsRuntimeEnv } from "../index.ts";
import { handleTenantDomainPromoteRequest } from "./promote.ts";

/**
 * Canonical OpenAPI alias (`POST /api/tenants/:tenantId/domains/:domainId/make-primary`)
 * delegating directly to the 4-gate primary promotion handler.
 */
export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDomainPromoteRequest(
    params.tenantId ?? "",
    params.domainId ?? "",
    request,
    buildDomainsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
