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
  issuePluginPrivateGrant,
  listPluginPrivateGrants,
  revokePluginPrivateGrant,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  mapConsolePluginStoreErrorToResponse,
  resolveConsolePluginsRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/plugins/grants`
 * - `GET`: Lists `plugin_private_grants` (filterable by `pluginSlug`, `tenantId`, `agencyId`, `status`).
 * - `POST`: Issues a new active `private_client` grant to a specific `tenantId` or `agencyId`
 *   (mandatory 2FA step-up + CSRF + mandatory 10–500 char `reason` + atomic `platform_audit`).
 * - `PATCH` / `DELETE`: Revokes an active grant (`{ grantId, reason }`) with mandatory 2FA step-up + audit.
 *
 * (REQ-098, REQ-051, REQ-068, ADR-0010, TASK-098).
 */

const ISSUE_GRANT_ALLOWED_KEYS = new Set(["pluginSlug", "tenantId", "agencyId", "reason"]);
const REVOKE_GRANT_ALLOWED_KEYS = new Set(["grantId", "reason", "action"]);

export async function handleConsolePluginGrantsRequest(
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
      { action: "console.plugins.grants.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "active" || statusParam === "revoked" ? statusParam : undefined;

    try {
      const grants = await listPluginPrivateGrants(authz.ctx.platformDb, {
        pluginSlug: url.searchParams.get("pluginSlug") ?? undefined,
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        agencyId: url.searchParams.get("agencyId") ?? undefined,
        status,
      });
      return consoleJsonResponse(200, { grants, requestId: authz.ctx.requestId });
    } catch (err) {
      return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.plugins.grants.issue", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      ISSUE_GRANT_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    try {
      const grant = await issuePluginPrivateGrant(authz.ctx.platformDb, {
        pluginSlug: typeof parsed.body.pluginSlug === "string" ? parsed.body.pluginSlug : "",
        tenantId: typeof parsed.body.tenantId === "string" ? parsed.body.tenantId : null,
        agencyId: typeof parsed.body.agencyId === "string" ? parsed.body.agencyId : null,
        grantedByUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        grantReason: typeof parsed.body.reason === "string" ? parsed.body.reason : "",
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(201, { grant, requestId: authz.ctx.requestId });
    } catch (err) {
      return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "PATCH" || method === "DELETE") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.plugins.grants.revoke", requireStepUp: true },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    const parsed = await parseStrictConsoleJsonBody(
      request,
      authz.ctx.requestId,
      REVOKE_GRANT_ALLOWED_KEYS,
    );
    if (!parsed.ok) return parsed.response;

    const grantId = typeof parsed.body.grantId === "string" ? parsed.body.grantId.trim() : "";
    if (!grantId) {
      return consoleErrorResponse(422, "VALIDATION_ERROR", "grantId wajib diisi.", authz.ctx.requestId);
    }

    try {
      const grant = await revokePluginPrivateGrant(authz.ctx.platformDb, {
        grantId,
        actorUserId: authz.ctx.user.id,
        actorRole: authz.ctx.actor.grant.role,
        reason: typeof parsed.body.reason === "string" ? parsed.body.reason : "",
        requestId: authz.ctx.requestId,
        nowMs: authz.ctx.nowMs,
      });
      return consoleJsonResponse(200, { grant, requestId: authz.ctx.requestId });
    } catch (err) {
      return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.plugins.grants.list", requireStepUp: false },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;
  return consoleErrorResponse(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", authz.ctx.requestId);
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleConsolePluginGrantsRequest(
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
