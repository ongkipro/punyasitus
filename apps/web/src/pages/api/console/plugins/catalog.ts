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
  PLUGIN_BILLING_MODELS,
  PLUGIN_VISIBILITY_TIERS,
  type PluginBillingModel,
  type PluginVisibilityTier,
} from "@punyasitus/core/plugins/billing";
import {
  listPluginCatalogItems,
  upsertConsolePluginCatalogItem,
} from "@punyasitus/db/plugins/store/index";
import type { APIRoute } from "astro";
import {
  mapConsolePluginStoreErrorToResponse,
  resolveConsolePluginsRuntimeEnv,
} from "./_shared.ts";

/**
 * `/api/console/plugins/catalog`
 * - `GET`: Lists all `plugin_catalog_items` (including `private_client` & inactive).
 * - `POST` / `PATCH`: Creates or updates a catalog item — including promoting
 *   `private_client` -> `public_free` | `public_paid` purely via audited metadata update
 *   with ZERO code rewrite!
 *
 * Security invariants:
 * - `console.punyasitus.com` host isolation, active operator RBAC, mandatory 2FA step-up
 *   (`requireStepUp: true`) + CSRF + mandatory 10–500 char `reason` + OCC (`expectedVersion` on update)
 *   + atomic `platform_audit`.
 *
 * (REQ-098, REQ-051, REQ-068, ADR-0010, TASK-098).
 */

const CATALOG_MUTATION_ALLOWED_KEYS = new Set([
  "slug",
  "name",
  "tagline",
  "description",
  "visibilityTier",
  "billingModel",
  "priceIdr",
  "active",
  "expectedVersion",
  "reason",
]);

export async function handleConsolePluginCatalogRequest(
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
      { action: "console.plugins.catalog.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;

    try {
      const items = await listPluginCatalogItems(authz.ctx.platformDb, { includeInactive: true });
      return consoleJsonResponse(200, {
        items,
        requestId: authz.ctx.requestId,
      });
    } catch (err) {
      return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method !== "POST" && method !== "PATCH") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.plugins.catalog.list", requireStepUp: false },
      { ...options, requestId },
    );
    if (!authz.ok) return authz.response;
    return consoleErrorResponse(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", authz.ctx.requestId);
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.plugins.catalog.write", requireStepUp: true },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  const parsed = await parseStrictConsoleJsonBody(
    request,
    authz.ctx.requestId,
    CATALOG_MUTATION_ALLOWED_KEYS,
  );
  if (!parsed.ok) return parsed.response;

  const body = parsed.body;
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const visibilityTier =
    typeof body.visibilityTier === "string" ? body.visibilityTier.trim() : "";
  const billingModel = typeof body.billingModel === "string" ? body.billingModel.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";

  if (!PLUGIN_VISIBILITY_TIERS.includes(visibilityTier as PluginVisibilityTier)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "visibilityTier harus public_free, public_paid, atau private_client.",
      authz.ctx.requestId,
    );
  }
  if (!PLUGIN_BILLING_MODELS.includes(billingModel as PluginBillingModel)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "billingModel harus free, paid_once, paid_monthly, atau paid_yearly.",
      authz.ctx.requestId,
    );
  }
  if (typeof body.priceIdr !== "number" || !Number.isInteger(body.priceIdr)) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "priceIdr wajib berupa bilangan bulat IDR.",
      authz.ctx.requestId,
    );
  }

  try {
    const res = await upsertConsolePluginCatalogItem(authz.ctx.platformDb, {
      slug,
      name,
      tagline: typeof body.tagline === "string" ? body.tagline : "",
      description: typeof body.description === "string" ? body.description : "",
      visibilityTier: visibilityTier as PluginVisibilityTier,
      billingModel: billingModel as PluginBillingModel,
      priceIdr: body.priceIdr,
      active: typeof body.active === "boolean" ? body.active : true,
      expectedVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
      actorUserId: authz.ctx.user.id,
      actorRole: authz.ctx.actor.grant.role,
      reason,
      requestId: authz.ctx.requestId,
      nowMs: authz.ctx.nowMs,
    });

    return consoleJsonResponse(res.created ? 201 : 200, {
      item: res.item,
      created: res.created,
      requestId: authz.ctx.requestId,
    });
  } catch (err) {
    return mapConsolePluginStoreErrorToResponse(err, authz.ctx.requestId);
  }
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleConsolePluginCatalogRequest(
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
