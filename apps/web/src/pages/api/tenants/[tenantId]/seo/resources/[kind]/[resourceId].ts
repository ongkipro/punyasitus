import type { SeoEditorResourceKind } from "@punyasitus/core/seo/editor";
import {
  getResourceSeoEditorState,
  updateResourceSeoOverrides,
} from "@punyasitus/db/seo/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantSeoRequest,
  buildSeoRuntimeEnv,
  createSeoRequestId,
  extractRequiredExpectedVersion,
  mapSeoDomainErrorToResponse,
  parseStrictSeoJsonBody,
  seoErrorResponse,
  seoJsonResponse,
  type TenantSeoHandlerOptions,
  type TenantSeoRuntimeEnv,
} from "../../_shared.ts";

/**
 * Per-Resource SEO Preview, Advisory Checklist & Override Endpoint (`TASK-052`, `REQ-053`):
 * - `GET   /api/tenants/:tenantId/seo/resources/:kind/:resourceId`
 * - `PATCH /api/tenants/:tenantId/seo/resources/:kind/:resourceId`
 *
 * Supported `:kind`: `page` | `post` | `offering` | `taxonomy`.
 * Enforces `content:read` on GET and `content:write` on PATCH (editors allowed; locked -> 403).
 */

const VALID_KINDS = new Set<SeoEditorResourceKind>(["page", "post", "offering", "taxonomy"]);

function parseResourceKind(raw: string): SeoEditorResourceKind | null {
  const clean = raw.trim().toLowerCase() as SeoEditorResourceKind;
  return VALID_KINDS.has(clean) ? clean : null;
}

function parseResourceId(raw: string): number | null {
  const clean = raw.trim();
  if (!/^[1-9]\d{0,9}$/.test(clean)) return null;
  const num = Number(clean);
  return Number.isSafeInteger(num) && num >= 1 ? num : null;
}

export async function handleTenantResourceSeoRequest(
  tenantId: string,
  rawKind: string,
  rawResourceId: string,
  request: Request,
  runtimeEnv: TenantSeoRuntimeEnv,
  options: TenantSeoHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createSeoRequestId();

  if (method !== "GET" && method !== "PATCH") {
    const auth = await authorizeTenantSeoRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return seoErrorResponse(405, "BAD_REQUEST", "Metode HTTP tidak diizinkan.", requestId, undefined, {
      Allow: "GET, PATCH",
    });
  }

  const requiredPermission = method === "GET" ? "content:read" : "content:write";
  const auth = await authorizeTenantSeoRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const resourceKind = parseResourceKind(rawKind);
  const resourceId = parseResourceId(rawResourceId);
  if (!resourceKind || resourceId === null) {
    return seoErrorResponse(404, "NOT_FOUND", "Sumber daya konten tidak ditemukan.", requestId);
  }

  const { member, platformDb, tenantDb, saasZone } = auth.ctx;

  try {
    if (method === "GET") {
      const state = await getResourceSeoEditorState(platformDb, tenantDb, {
        tenantId: member.tenantId,
        resourceKind,
        resourceId,
        saasZone,
        nowMs: options.nowMs,
      });
      return seoJsonResponse(200, { seo: state, requestId });
    }

    const parsedBody = await parseStrictSeoJsonBody(request, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractRequiredExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const state = await updateResourceSeoOverrides(platformDb, tenantDb, {
      tenantId: member.tenantId,
      resourceKind,
      resourceId,
      payload: parsedBody.body,
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      saasZone,
      nowMs: options.nowMs,
    });

    return seoJsonResponse(200, { seo: state, requestId });
  } catch (err) {
    return mapSeoDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantResourceSeoRequest(
    params.tenantId ?? "",
    params.kind ?? "",
    params.resourceId ?? "",
    request,
    buildSeoRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    },
  );
