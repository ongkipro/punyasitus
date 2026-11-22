import {
  extractTocFromSanitizedHtml,
  renderRichTextDocToSanitizedHtml,
} from "@punyasitus/core/content/index";
import { getDraftPostPreview } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../_shared.ts";

/**
 * `GET /api/tenants/:tenantId/posts/:postId/preview`
 * Private, uncacheable (`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`)
 * admin-only draft preview payload separating draft from published state (REQ-009, REQ-036).
 */

export async function handleTenantPostPreviewRequest(
  tenantId: string,
  rawPostId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan GET untuk pratinjau draf artikel.",
      requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    "content:read",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parseSequentialIdParam(rawPostId, "postId", "artikel", requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  try {
    const preview = await getDraftPostPreview(auth.ctx.tenantDb, parsedId.id);
    if (!preview) {
      return blogErrorResponse(
        404,
        "NOT_FOUND",
        `Pratinjau artikel #${parsedId.id} tidak ditemukan.`,
        requestId,
      );
    }

    const sanitizedHtml =
      preview.draft?.sanitizedHtml ??
      (preview.draft?.body ? renderRichTextDocToSanitizedHtml(preview.draft.body) : "");
    const showToc = Boolean(preview.draft?.showToc);

    return blogJsonResponse(200, {
      preview: true,
      resourceId: preview.resourceId,
      status: preview.status,
      version: preview.version,
      sanitizedHtml,
      readingTimeMinutes: preview.draft?.readingTimeMinutes ?? 1,
      toc: showToc ? extractTocFromSanitizedHtml(sanitizedHtml) : [],
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
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostPreviewRequest(
    params.tenantId ?? "",
    params.postId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
