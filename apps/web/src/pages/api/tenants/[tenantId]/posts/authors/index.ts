import { createPostAuthor, listPostAuthors } from "@punyasitus/db/posts/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  formatAuthorRecordResponse,
  mapBlogDomainErrorToResponse,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../_shared.ts";

/**
 * Tenant-scoped Blog Author Profiles collection endpoint (REQ-092, TASK-092):
 * - `GET  /api/tenants/:tenantId/posts/authors` -> list tenant-scoped author profiles
 * - `POST /api/tenants/:tenantId/posts/authors` -> create author profile (201)
 *
 * Security:
 * - Platform `app` host surface check (neutral 404 on tenant/console/marketing hosts)
 * - CSRF & Origin check on POST
 * - Live membership + RBAC (`content:read` / `content:write` -> owner/admin/editor)
 * - Tenant lifecycle lock enforcement (`locked`/`suspended` -> 403 on write)
 * - Same-tenant ready-image ownership verification for `avatarMediaId`
 */

const CREATE_AUTHOR_ALLOWED_KEYS = new Set([
  "name",
  "slug",
  "roleTitle",
  "role_title",
  "bio",
  "avatarMediaId",
  "avatar_media_id",
  "sameAs",
]);

export type TenantAuthorRuntimeEnv = TenantBlogRuntimeEnv & {
  readonly MEDIA_PUBLIC_BASE_URL?: string;
};

export async function handleTenantPostAuthorsCollectionRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantAuthorRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET" && method !== "POST") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk koleksi profil penulis.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const requiredPermission = method === "GET" ? "content:read" : "content:write";
  const auth = await authorizeTenantBlogRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const { member, tenantDb } = auth.ctx;
  const scopeOptions = {
    tenantId: member.tenantId,
    mediaBaseOrigin: runtimeEnv.MEDIA_PUBLIC_BASE_URL ?? null,
  };

  try {
    if (method === "GET") {
      const url = new URL(request.url);
      const rawLimit = url.searchParams.get("limit");
      let limit = 50;
      if (rawLimit !== null && rawLimit.trim() !== "") {
        if (!/^\d+$/.test(rawLimit.trim())) {
          return blogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter limit harus berupa bilangan bulat 1..100.",
            requestId,
            [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be an integer 1..100." }],
          );
        }
        const parsedLimit = Number(rawLimit.trim());
        if (parsedLimit < 1 || parsedLimit > 100) {
          return blogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter limit harus antara 1 hingga 100.",
            requestId,
            [{ field: "limit", code: "INVALID_LIMIT", message: "limit must be between 1 and 100." }],
          );
        }
        limit = parsedLimit;
      }

      const items = await listPostAuthors(tenantDb, { ...scopeOptions, limit });
      return blogJsonResponse(200, {
        items: items.map(formatAuthorRecordResponse),
      });
    }

    // POST /api/tenants/:tenantId/posts/authors
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      CREATE_AUTHOR_ALLOWED_KEYS,
      requestId,
    );
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body;
    const created = await createPostAuthor(
      tenantDb,
      {
        name: body.name as string,
        ...(body.slug !== undefined ? { slug: body.slug as string | null } : {}),
        ...(body.roleTitle !== undefined ? { roleTitle: body.roleTitle as string | null } : {}),
        ...(body.role_title !== undefined ? { role_title: body.role_title as string | null } : {}),
        ...(body.bio !== undefined ? { bio: body.bio as string | null } : {}),
        ...(body.avatarMediaId !== undefined
          ? { avatarMediaId: body.avatarMediaId as number | null }
          : {}),
        ...(body.avatar_media_id !== undefined
          ? { avatar_media_id: body.avatar_media_id as number | null }
          : {}),
        ...(body.sameAs !== undefined ? { sameAs: body.sameAs as readonly string[] | string | null } : {}),
        nowMs: options.nowMs,
      },
      scopeOptions,
    );

    return blogJsonResponse(201, formatAuthorRecordResponse(created));
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostAuthorsCollectionRequest(
    params.tenantId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
