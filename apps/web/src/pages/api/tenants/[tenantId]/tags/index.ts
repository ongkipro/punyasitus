import { createTaxonomy, listTaxonomies } from "@punyasitus/db/taxonomy/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractIndexOptInField,
  formatTaxonomyResponse,
  mapTaxonomyDomainErrorToResponse,
  parseListPaginationParams,
  parseStrictBlogJsonBody,
  taxonomyErrorResponse,
  taxonomyJsonResponse,
  withPrivateNoStoreHeaders,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../categories/_shared.ts";

/**
 * Tenant-scoped Flat Blog Tags collection endpoint (`taxonomy_type = 'post_tag'`):
 * - `GET  /api/tenants/:tenantId/tags` -> paginated list with published/draft counts
 * - `POST /api/tenants/:tenantId/tags` -> create flat blog tag (201, rejects parentId, atomic audit)
 *
 * TASK-006 + TASK-041 (`REQ-045`, `REQ-009`, `REQ-034`, `REQ-036`, `REQ-061`).
 */

const CREATE_TAG_ALLOWED_KEYS = new Set([
  "kind",
  "name",
  "slug",
  "description",
  "parentId",
  "sortOrder",
  "indexOptIn",
  "indexable",
]);

export async function handleTenantTagsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantBlogRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);
    return taxonomyErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk koleksi tag blog.",
      requestId,
      undefined,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "taxonomy:manage";
  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return withPrivateNoStoreHeaders(auth.response);

  const { tenantDb, platformDb, member } = auth.ctx;

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawKind = url.searchParams.get("kind")?.trim();
      if (rawKind && rawKind !== "post_tag") {
        return taxonomyErrorResponse(
          422,
          "VALIDATION_ERROR",
          'Endpoint tag blog hanya mendukung kind "post_tag".',
          requestId,
          [{ field: "kind", code: "INVALID_KIND", message: 'Expected kind "post_tag".' }],
        );
      }

      const pagination = parseListPaginationParams(url, requestId);
      if (!pagination.ok) return withPrivateNoStoreHeaders(pagination.response);

      const list = await listTaxonomies(tenantDb, {
        kind: "post_tag",
        search: url.searchParams.get("search") ?? undefined,
        cursor: pagination.cursor,
        limit: pagination.limit,
        sortOrder: pagination.sortOrder,
      });

      return taxonomyJsonResponse(200, {
        items: list.items.map(formatTaxonomyResponse),
        page: list.page,
      });
    }

    // POST /api/tenants/:tenantId/tags
    const parsedBody = await parseStrictBlogJsonBody(request, CREATE_TAG_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) return withPrivateNoStoreHeaders(parsedBody.response);

    const body = parsedBody.body;
    if (body.kind !== undefined && body.kind !== "post_tag") {
      return taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Field kind untuk tag blog harus "post_tag".',
        requestId,
        [{ field: "kind", code: "INVALID_KIND", message: 'Expected kind "post_tag".' }],
      );
    }

    const optInCheck = extractIndexOptInField(body, requestId);
    if (!optInCheck.ok) return optInCheck.response;

    const created = await createTaxonomy(
      tenantDb,
      {
        kind: "post_tag",
        name: body.name as string,
        ...(body.slug !== undefined ? { slug: body.slug as string } : {}),
        ...(body.description !== undefined ? { description: body.description as string | null } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId as number | null } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder as number } : {}),
        ...(optInCheck.value !== undefined ? { indexOptIn: optInCheck.value } : {}),
        nowMs: options.nowMs,
      },
      {
        actorUserId: member.userId,
        actorRole: member.role,
        platformDb,
        tenantId: member.tenantId,
      },
    );

    return taxonomyJsonResponse(201, formatTaxonomyResponse(created));
  } catch (err) {
    return mapTaxonomyDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantTagsCollectionRequest(params.tenantId ?? "", request, buildBlogRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
