import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  PLUGIN_CUSTOM_DEV_REQUEST_STATUSES,
  type PluginCustomDevRequestStatus,
} from "@punyasitus/core/plugins/billing";
import {
  listConsoleCustomPluginDevRequests,
  listPluginPrivateGrants,
  transitionConsoleCustomPluginDevRequest,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  mapConsolePluginStoreErrorToResponse,
  resolveConsolePluginsRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/plugins/requests`
 * - `GET`: Lists `plugin_custom_dev_requests` (`service_kind = 'custom_plugin'`) alongside
 *   active `private_client` grants so operators can link grants upon fulfillment.
 * - `PATCH`: Quotes, progresses, declines, or fulfills a `custom_plugin` request.
 *   - Mandatory 2FA step-up + RBAC + CSRF + OCC (`expectedVersion`) + mandatory `reason` + atomic `platform_audit`.
 *   - **CRITICAL INVARIANT:** `status = "fulfilled"` is STRICTLY BLOCKED (`422 GRANT_REQUIRED`)
 *     unless linked to an existing active `private_client` grant for that tenant (or its active agency)!
 *
 * (REQ-098, REQ-051, REQ-068, ADR-0010, TASK-098).
 */

const TRANSITION_ALLOWED_KEYS = new Set([
  "requestId",
  "id",
  "status",
  "expectedVersion",
  "quoteAmountIdr",
  "linkedGrantId",
  "operatorNotes",
  "reason",
]);

export async function handleConsoleCustomPluginRequests(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.plugins.requests.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status = PLUGIN_CUSTOM_DEV_REQUEST_STATUSES.includes(
      statusParam as PluginCustomDevRequestStatus,
    )
      ? (statusParam as PluginCustomDevRequestStatus)
      : undefined;

    try {
      const [requests, activeGrants] = await Promise.all([
        listConsoleCustomPluginDevRequests(authz.ctx.platformDb, { status }),
        listPluginPrivateGrants(authz.ctx.platformDb, { status: "active" }),
      ]);
      return consoleJsonResponse(200, {
        requests,
        activeGrants,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method !== "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.plugins.requests.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", authz.ctx.requestId);
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.plugins.requests.transition", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    TRANSITION_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const targetId =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : typeof body.requestId === "string" && body.requestId.trim()
        ? body.requestId.trim()
        : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";

  if (!targetId) {
    return consoleErrorResponse(422, "VALIDATION_ERROR", "id permintaan wajib diisi.", authz.ctx.requestId);
  }
  if (!PLUGIN_CUSTOM_DEV_REQUEST_STATUSES.includes(status as PluginCustomDevRequestStatus)) {
    return consoleErrorResponse(422, "VALIDATION_ERROR", "Status permintaan tidak valid.", authz.ctx.requestId);
  }
  if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "expectedVersion wajib berupa bilangan bulat.",
      authz.ctx.requestId,
    );
  }

  try {
    const updated = await transitionConsoleCustomPluginDevRequest(authz.ctx.platformDb, {
      id: targetId,
      status: status as PluginCustomDevRequestStatus,
      expectedVersion: body.expectedVersion,
      quoteAmountIdr:
        typeof body.quoteAmountIdr === "number"
          ? body.quoteAmountIdr
          : body.quoteAmountIdr === null
            ? null
            : undefined,
      linkedGrantId:
        typeof body.linkedGrantId === "string"
          ? body.linkedGrantId
          : body.linkedGrantId === null
            ? null
            : undefined,
      operatorNotes:
        typeof body.operatorNotes === "string"
          ? body.operatorNotes
          : body.operatorNotes === null
            ? null
            : undefined,
      reason: typeof body.reason === "string" ? body.reason : "",
      actorUserId: authz.ctx.user.id,
      actorRole: authz.ctx.actor.grant.role,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(200, {
      request: updated,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleConsoleCustomPluginRequests(
    request,
    resolveConsolePluginsRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser
        ? { id: locals.authUser.id, email: locals.authUser.email }
        : null,
    },
  );
