import type { ResourceLifecycleStatus } from "@punyasitus/core/content/index";
import { createPage, listPages } from "@punyasitus/db/pages/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantPageRequest,
  buildPagesRuntimeEnv,
  createRequestId,
  formatPageRecordResponse,
  mapPageDomainErrorToResponse,
  pageErrorResponse,
  pageJsonResponse,
  parseStrictPageJsonBody,
  type TenantPagesHandlerOptions,
  type TenantPagesRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Static Pages collection endpoint:
 * - `GET  /api/tenants/:tenantId/pages` -> paginated list with status filter
 * - `POST /api/tenants/:tenantId/pages` -> create a draft page (201)
 *
 * TASK-005 (`REQ-008`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const CREATE_PAGE_ALLOWED_KEYS = new Set([
  "title",
  "slug",
  "isHomepage",
  "layoutMode",
  "sections",
  "seo",
]);

const ALLOWED_STATUS_FILTERS = new Set(["draft", "published", "trashed", "all"]);

export async function handleTenantPagesCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantPagesRuntimeEnv,
  options: TenantPagesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantPageRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return pageErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk koleksi halaman.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
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

  const { tenantDb } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawStatus = url.searchParams.get("status")?.trim() ?? "all";
      if (!ALLOWED_STATUS_FILTERS.has(rawStatus)) {
        return pageErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Parameter status harus salah satu dari "draft", "published", "trashed", atau "all".',
          requestId,
          [
            {
              field: "status",
              code: "INVALID_STATUS_FILTER",
              message: "Unsupported status filter value.",
            },
          ],
        );
      }

      const rawLimit = url.searchParams.get("limit");
      let limit = 20;
      if (rawLimit !== null && rawLimit.trim() !== "") {
        if (!/^\d+$/.test(rawLimit.trim())) {
          return pageErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter limit harus berupa bilangan bulat antara 1 hingga 100.",
            requestId,
            [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100" }],
          );
        }
        const parsedLimit = Number(rawLimit.trim());
        if (parsedLimit < 1 || parsedLimit > 100) {
          return pageErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter limit harus antara 1 hingga 100.",
            requestId,
            [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be between 1 and 100" }],
          );
        }
        limit = parsedLimit;
      }

      const rawSortOrder = url.searchParams.get("sortOrder")?.trim() ?? "desc";
      if (rawSortOrder !== "asc" && rawSortOrder !== "desc") {
        return pageErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Parameter sortOrder harus "asc" atau "desc".',
          requestId,
          [
            {
              field: "sortOrder",
              code: "INVALID_SORT_ORDER",
              message: 'sortOrder must be "asc" or "desc"',
            },
          ],
        );
      }

      const includeTrashed = url.searchParams.get("includeTrashed") === "true";
      const cursor = url.searchParams.get("cursor") ?? undefined;

      const list = await listPages(tenantDb, {
        status: rawStatus as ResourceLifecycleStatus | "all",
        includeTrashed,
        cursor,
        limit,
        sortOrder: rawSortOrder,
      });

      return pageJsonResponse(200, {
        items: list.items.map(formatPageRecordResponse),
        page: list.page,
      });
    }

    // POST /api/tenants/:tenantId/pages
    const parsedBody = await parseStrictPageJsonBody(request, CREATE_PAGE_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const body = parsedBody.body;
    const created = await createPage(tenantDb, {
      title: body.title as string,
      ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
      ...(body.isHomepage !== undefined ? { isHomepage: body.isHomepage as boolean } : {}),
      ...(body.layoutMode !== undefined ? { layoutMode: body.layoutMode as "standard" | "focused" } : {}),
      ...(body.sections !== undefined ? { sections: body.sections } : {}),
      ...(body.seo !== undefined ? { seo: body.seo } : {}),
      nowMs: options.nowMs,
    });

    return pageJsonResponse(201, formatPageRecordResponse(created));
  } catch (err) {
    return mapPageDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPagesCollectionRequest(params.tenantId ?? "", request, buildPagesRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
