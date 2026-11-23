import { env } from "cloudflare:workers";
import {
  agencyErrorResponse,
  agencyJsonResponse,
  authorizeAgencyRequest,
  createAgencyRequestId,
  type AgencyHandlerOptions,
  type AgencyRuntimeEnv,
} from "@punyasitus/auth/agency/index";
import { getAgencyBillingOverview } from "@punyasitus/db/agencies/index";
import {
  listAgencyPluginStoreOverview,
  PluginStoreError,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  formatAgencyClientDto,
  formatAgencySummaryDto,
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../_shared.ts";

/**
 * `GET /api/agency/plugins`
 * Lists commercial paid add-on plugins, agency's active `private_client` grants,
 * linked client plugin entitlements, orders, and immutable PDF receipts for the
 * authorized target agency (REQ-098, REQ-083, TASK-098).
 *
 * Security invariants:
 * - Mandatory 2FA + `agency:billing:read` via `authorizeAgencyRequest`.
 * - Target agency strictly resolved via `resolveAuthorizedTargetMembership` (ZERO cross-agency leak!).
 */

export async function handleAgencyPluginsOverviewRequest(
  request: Request,
  runtimeEnv: AgencyRuntimeEnv,
  options: AgencyHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createAgencyRequestId();
  const url = new URL(request.url);
  const queryAgencyId = url.searchParams.get("agencyId");

  const authz = await authorizeAgencyRequest(
    request,
    runtimeEnv,
    {
      action: "agency.plugins.list",
      requestedAgencyId: queryAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:read",
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode GET.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    queryAgencyId,
    "agency:billing:read",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  try {
    const [billingOverview, pluginOverview] = await Promise.all([
      getAgencyBillingOverview(authz.ctx.platformDb, targetAgency.id, { nowMs: authz.ctx.nowMs }),
      listAgencyPluginStoreOverview(authz.ctx.platformDb, targetAgency.id, {
        nowMs: authz.ctx.nowMs,
      }),
    ]);

    return agencyJsonResponse(200, {
      agency: billingOverview ? formatAgencySummaryDto(billingOverview.agency) : null,
      clients: billingOverview ? billingOverview.clients.map(formatAgencyClientDto) : [],
      effectiveDiscountPercent: pluginOverview.effectiveDiscountPercent,
      paidPlugins: pluginOverview.paidPlugins,
      privateGrants: pluginOverview.privateGrants,
      entitlements: pluginOverview.entitlements,
      orders: pluginOverview.orders,
      receipts: pluginOverview.receipts,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    if (err instanceof PluginStoreError) {
      return agencyErrorResponse(err.status, err.code, err.message, authz.ctx.requestId);
    }
    return mapAgencyErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleAgencyPluginsOverviewRequest(
    request,
    resolveAgencyRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email, name: locals.authUser.name }
        : null,
    },
  );
