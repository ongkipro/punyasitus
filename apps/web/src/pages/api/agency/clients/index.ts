import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  parseStrictAgencyJsonBody,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { UuidSchema } from "@punyasitus/core/schemas";
import {
  listAgencyClients,
  provisionAgencyClientTenant,
} from "@punyasitus/db/agencies/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";
import type { APIRoute } from "astro";
import {
  formatAgencyClientDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../_shared.ts";

/**
 * `/api/agency/clients` — Scoped list (GET) & atomic client website provisioning (POST)
 * enforcing max 3 unpaid trials until first paid client (`409 AGENCY_TRIAL_LIMIT_REACHED`).
 */
const CREATE_CLIENT_ALLOWED_KEYS = new Set([
  "agencyId",
  "handle",
  "name",
  "vertical",
  "clientOwnerEmail",
  "idempotencyKey",
]);

export interface AgencyClientsHandlerOptions extends AgencyHandlerOptions {
  readonly tenantStore?: TenantStoreNamespaceLike | null;
}

export async function handleAgencyClientsRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyClientsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  if (method === "GET") {
    const authz = await authorizeAgencyRequest(
      request,
      runtimeEnv,
      {
        action: "agency.clients.list",
        requestedAgencyId: queryAgencyId,
        requireAgencyMembership: true,
        requiredPermission: "agency:read",
      },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const agency = authz.ctx.actor.activeAgency!;
      const clients = await listAgencyClients(authz.ctx.platformDb, agency.id, {
        nowMs: authz.ctx.nowMs,
        saasZone: runtimeEnv.SAAS_ZONE,
      });

      return agencyJsonResponse(200, {
        success: true,
        agencyId: agency.id,
        trialQuota: agency.trialQuota,
        clients: clients.map(formatAgencyClientDto),
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapAgencyErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeAgencyRequest(
      request,
      runtimeEnv,
      {
        action: "agency.clients.provision",
        requestedAgencyId: queryAgencyId,
        requireAgencyMembership: true,
        requiredPermission: "agency:clients:write",
      },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictAgencyJsonBody(
      request,
      authz.ctx.requestId,
      CREATE_CLIENT_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    // Cross-agency body selector + target-agency RBAC check (404 if not a member; 403 if lacking write permission on target)
    const bodyAgencyId =
      typeof parsed.body.agencyId === "string" && parsed.body.agencyId.trim().length > 0
        ? parsed.body.agencyId.trim()
        : null;
    const resolvedTarget = resolveAuthorizedTargetMembership(
      authz.ctx.actor,
      bodyAgencyId,
      "agency:clients:write",
      authz.ctx.requestId,
    );
    if (!resolvedTarget.ok) return resolvedTarget.response;
    const targetAgency = resolvedTarget.membership.agency;

    const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const bodyKey = typeof parsed.body.idempotencyKey === "string" ? parsed.body.idempotencyKey.trim() : "";
    const candidateKey = headerKey || bodyKey;
    const validKey = UuidSchema.safeParse(candidateKey);
    if (!validKey.success) {
      return agencyErrorResponse(
        422,
        "INVALID_IDEMPOTENCY_KEY",
        "Header Idempotency-Key berupa UUID yang valid wajib disertakan.",
        authz.ctx.requestId,
      );
    }

    try {
      const result = await provisionAgencyClientTenant(authz.ctx.platformDb, {
        agencyId: targetAgency.id,
        actorUserId: authz.ctx.actor.userId,
        actorAgencyRole: resolvedTarget.membership.role,
        handle: typeof parsed.body.handle === "string" ? parsed.body.handle : "",
        name: typeof parsed.body.name === "string" ? parsed.body.name : "",
        vertical:
          typeof parsed.body.vertical === "string"
            ? (parsed.body.vertical as TenantVertical)
            : undefined,
        clientOwnerEmail:
          typeof parsed.body.clientOwnerEmail === "string"
            ? parsed.body.clientOwnerEmail
            : undefined,
        idempotencyKey: validKey.data,
        saasZone: runtimeEnv.SAAS_ZONE,
        tenantStore: options.tenantStore,
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return agencyJsonResponse(result.replayed ? 200 : 201, {
        success: true,
        replayed: result.replayed,
        client: formatAgencyClientDto(result.client),
        trialQuota: result.trialQuota,
        auditId: result.auditId,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapAgencyErrorToResponse(err, authz.ctx.requestId);
    }
  }

  return agencyErrorResponse(
    405,
    "METHOD_NOT_ALLOWED",
    "Metode HTTP tidak diizinkan. Gunakan GET atau POST.",
    requestId,
    undefined,
    { Allow: "GET, POST" },
  );
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyClientsRequest(
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
      tenantStore: (env as unknown as { readonly TENANT_STORE?: TenantStoreNamespaceLike }).TENANT_STORE ?? null,
    },
  );
