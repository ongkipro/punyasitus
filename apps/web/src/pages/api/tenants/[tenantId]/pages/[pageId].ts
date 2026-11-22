import { getPageById, trashPage, updatePage } from "@punyasitus/db/pages/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  extractPageExpectedVersion,
  formatPageRecordResponse,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  pageNoContentResponse,
  parsePageIdParam,
  parseStrictPageJsonBody,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped single Static Page item endpoint:
 * - `GET    /api/tenants/:tenantId/pages/:pageId` -> read single page by sequential ID
 * - `PATCH  /api/tenants/:tenantId/pages/:pageId` -> save draft edits with optimistic concurrency
 * - `DELETE /api/tenants/:tenantId/pages/:pageId` -> soft-delete (trash) page (204)
 *
 * TASK-005 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const UPDATE_PAGE_ALLOWED_KEYS = new Set([
  "title",
  "slug",
  "confirmSlugChange",
  "isHomepage",
  "layoutMode",
  "sections",
  "seo",
  "version",
  "expectedVersion",
]);

const DELETE_PAGE_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

export async function handleTenantPageItemRequest(
  tenantId: string,
  rawPageId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint halaman.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "content:write";
  const auth = await authorizeTenantPageRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  const parsedId = parsePageIdParam(rawPageId, requestId);
  if (!parsedId.ok) {
    return parsedId.response;
  }

  const { member, platformDb, tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const includeTrashed = url.searchParams.get("includeTrashed") === "true";
      const page = await getPageById(tenantDb, parsedId.pageId, { includeTrashed });
      if (!page) {
        return pageErrorResponse(
          404,
          "NOT_FOUND",
          `Halaman #${parsedId.pageId} tidak ditemukan.`,
          requestId,
        );
      }
      return pageJsonResponse(200, formatPageRecordResponse(page));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictPageJsonBody(
        request,
        UPDATE_PAGE_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) {
        return parsedBody.response;
      }

      const body = parsedBody.body;
      const versionCheck = extractPageExpectedVersion(body, requestId, { required: true });
      if (!versionCheck.ok) {
        return versionCheck.response;
      }

      if (body.confirmSlugChange !== undefined && typeof body.confirmSlugChange !== "boolean") {
        return pageErrorResponse(
          422,
          "VALIDATION_ERROR",
          "confirmSlugChange harus berupa boolean.",
          requestId,
          [
            {
              field: "confirmSlugChange",
              code: "INVALID_TYPE",
              message: "Expected a boolean for confirmSlugChange.",
            },
          ],
        );
      }

      const updated = await updatePage(
        tenantDb,
        {
          pageId: parsedId.pageId,
          expectedVersion: versionCheck.expectedVersion!,
          ...(body.title !== undefined ? { title: body.title as string } : {}),
          ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
          ...(body.confirmSlugChange !== undefined
            ? { confirmSlugChange: body.confirmSlugChange as boolean }
            : {}),
          ...(body.isHomepage !== undefined ? { isHomepage: body.isHomepage as boolean } : {}),
          ...(body.layoutMode !== undefined
            ? { layoutMode: body.layoutMode as "standard" | "focused" }
            : {}),
          ...(body.sections !== undefined ? { sections: body.sections } : {}),
          ...(body.seo !== undefined ? { seo: body.seo } : {}),
          nowMs: options.nowMs,
        },
        { platformDb, tenantId: member.tenantId },
      );

      return pageJsonResponse(200, formatPageRecordResponse(updated));
    }

    // DELETE /api/tenants/:tenantId/pages/:pageId (soft-delete/trash -> 204 No Content)
    const parsedBody = await parseStrictPageJsonBody(
      request,
      DELETE_PAGE_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const versionCheck = extractPageExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) {
      return versionCheck.response;
    }

    let expectedVersion = versionCheck.expectedVersion;
    if (expectedVersion === undefined) {
      const url = new URL(request.url);
      const queryVersion = url.searchParams.get("version") ?? url.searchParams.get("expectedVersion");
      if (queryVersion !== null) {
        if (!/^\d+$/.test(queryVersion)) {
          return pageErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter query version harus berupa bilangan bulat non-negatif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Invalid version query parameter." }],
          );
        }
        expectedVersion = Number(queryVersion);
      }
    }

    await trashPage(platformDb, tenantDb, {
      tenantId: member.tenantId,
      pageId: parsedId.pageId,
      expectedVersion,
      nowMs: options.nowMs,
    });

    return pageNoContentResponse();
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPageItemRequest(
    params.tenantId ?? "",
    params.pageId ?? "",
    request,
    buildPagesRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
