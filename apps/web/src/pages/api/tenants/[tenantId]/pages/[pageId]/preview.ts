import { getDraftPagePreview } from "@punyasitus/db/pages/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parsePageIdParam,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/tenants/:tenantId/pages/:pageId/preview`
 * Private, uncacheable (`no-store`, `noindex`) admin-only draft preview payload
 * separating draft changes from published state (REQ-008, REQ-036).
 */

export async function handleTenantPagePreviewRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan GET untuk pratinjau draf halaman.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantPageRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  try {
    const preview = await getDraftPagePreview(auth.ctx.tenantDb, parsedId.pageId);
    if (!preview) {
      return pageErrorResponse(
        404,
        "NOT_FOUND",
        `Pratinjau halaman #${parsedId.pageId} tidak ditemukan.`,
        requestId,
      );
    }

    return pageJsonResponse(200, {
      preview: true,
      resourceId: preview.resourceId,
      status: preview.status,
      version: preview.version,
      layoutMode: preview.draft?.layoutMode ?? "standard",
      hideNavigationChrome: (preview.draft?.layoutMode ?? "standard") === "focused",
      draft: preview.draft,
      published: preview.published,
      hasUnpublishedChanges: preview.hasUnpublishedChanges,
      publishedAt: preview.publishedAt ? new Date(preview.publishedAt).toISOString() : null,
      contentModifiedAt: preview.contentModifiedAt
        ? new Date(preview.contentModifiedAt).toISOString()
        : null,
      updatedAt: new Date(preview.updatedAt).toISOString(),
    });
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagePreviewRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
