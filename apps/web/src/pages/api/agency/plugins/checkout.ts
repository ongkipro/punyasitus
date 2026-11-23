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
import { PLUGIN_FORBIDDEN_PRICE_KEYS } from "@punyasitus/core/plugins/billing";
import { createPluginAddonOrder, PluginStoreError } from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  mapAgencyErrorToResponse,
  resolveAgencyRuntimeEnv,
  resolveAuthorizedTargetMembership,
} from "../_shared.ts";

/**
 * `POST /api/agency/plugins/checkout`
 * Server-priced AutoLaris add-on plugin checkout billed strictly to the owning agency
 * (`payer_kind = 'agency'`) for a linked client website!
 *
 * Security invariants:
 * - Mandatory 2FA + CSRF + `agency:billing:write` via `authorizeAgencyRequest`.
 * - Target agency verified via `resolveAuthorizedTargetMembership` (ZERO cross-agency RBAC escalation!).
 * - Client-supplied price/amount/discount/status fields rejected (`422`).
 * - Foreign or non-agency client tenant returns neutral `404 NOT_FOUND`.
 *
 * (REQ-098, REQ-083, TASK-098).
 */

const CHECKOUT_ALLOWED_KEYS = new Set([
  "agencyId",
  "tenantId",
  "pluginSlug",
  "channelCode",
  "couponCode",
  "idempotencyKey",
]);

export async function handleAgencyPluginCheckoutRequest(
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
      action: "agency.plugins.checkout",
      requestedAgencyId: queryAgencyId,
      requireAgencyMembership: true,
      requiredPermission: "agency:billing:write",
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "POST") {
    return agencyErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan metode POST untuk checkout plugin agensi.",
      authz.ctx.requestId,
      undefined,
      { Allow: "POST" },
    );
  }

  const parsed = await parseStrictAgencyJsonBody(
    request,
    authz.ctx.requestId,
    CHECKOUT_ALLOWED_KEYS,
    { rejectForbiddenBillingFields: true },
  );
  if (!parsed.ok) return parsed.response;

  for (const key of Object.keys(parsed.body)) {
    if (PLUGIN_FORBIDDEN_PRICE_KEYS.has(key)) {
      return agencyErrorResponse(
        422,
        "PLUGIN_CHECKOUT_CLIENT_PRICE_FORBIDDEN",
        `Field harga "${key}" tidak boleh dikirim oleh klien.`,
        authz.ctx.requestId,
      );
    }
  }

  const bodyAgencyId =
    typeof parsed.body.agencyId === "string" && parsed.body.agencyId.trim()
      ? parsed.body.agencyId.trim()
      : queryAgencyId;
  const resolvedTarget = resolveAuthorizedTargetMembership(
    authz.ctx.actor,
    bodyAgencyId,
    "agency:billing:write",
    authz.ctx.requestId,
  );
  if (!resolvedTarget.ok) return resolvedTarget.response;
  const targetAgency = resolvedTarget.membership.agency;

  const tenantId =
    typeof parsed.body.tenantId === "string" ? parsed.body.tenantId.trim() : "";
  const pluginSlug =
    typeof parsed.body.pluginSlug === "string" ? parsed.body.pluginSlug.trim().toLowerCase() : "";
  if (!tenantId || !pluginSlug) {
    return agencyErrorResponse(
      422,
      "VALIDATION_ERROR",
      "tenantId klien dan pluginSlug wajib diisi.",
      authz.ctx.requestId,
    );
  }

  const headerIdem = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyIdem =
    typeof parsed.body.idempotencyKey === "string" ? parsed.body.idempotencyKey.trim() : "";
  const idempotencyKey = headerIdem || bodyIdem || crypto.randomUUID();

  try {
    const result = await createPluginAddonOrder(authz.ctx.platformDb, {
      tenantId,
      pluginSlug,
      payerKind: "agency",
      payerAgencyId: targetAgency.id,
      payerUserId: authz.ctx.actor.userId,
      channelCode: typeof parsed.body.channelCode === "string" ? parsed.body.channelCode : "QRIS",
      couponCode: typeof parsed.body.couponCode === "string" ? parsed.body.couponCode : null,
      idempotencyKey,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return agencyJsonResponse(result.idempotentReplay ? 200 : 201, {
      order: result.order,
      plugin: result.item,
      idempotentReplay: result.idempotentReplay,
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
  handleAgencyPluginCheckoutRequest(
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
