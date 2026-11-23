import {
  deletePostAuthor,
  getPostAuthorById,
  updatePostAuthor,
} from "@punyasitus/db/posts/index";
import { bumpTenantCacheVersion } from "@punyasitus/db/publication/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantBlogRequest,
  blogErrorResponse,
  blogJsonResponse,
  blogNoContentResponse,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  formatAuthorRecordResponse,
  mapBlogDomainErrorToResponse,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
} from "../_shared.ts";
import type { TenantAuthorRuntimeEnv } from "./index.ts";

/**
 * Tenant-scoped single Blog Author Profile endpoint (REQ-092, TASK-092):
 * - `GET    /api/tenants/:tenantId/posts/authors/:authorId` -> read single author profile
 * - `PATCH  /api/tenants/:tenantId/posts/authors/:authorId` -> update author profile (optimistic `version`)
 * - `DELETE /api/tenants/:tenantId/posts/authors/:authorId` -> guarded delete (204 or 409 `AUTHOR_IN_USE`)
 */

const UPDATE_AUTHOR_ALLOWED_KEYS = new Set([
  "name",
  "slug",
  "roleTitle",
  "role_title",
  "bio",
  "avatarMediaId",
  "avatar_media_id",
  "sameAs",
  "version",
  "expectedVersion",
]);

const DELETE_AUTHOR_ALLOWED_KEYS = new Set([
  "version",
  "expectedVersion",
  "detach",
  "reassignToAuthorId",
]);

export async function handleTenantPostAuthorItemRequest(
  tenantId: string,
  rawAuthorId: string,
  request: Request,
  runtimeEnv: TenantAuthorRuntimeEnv,
  options: TenantBlogHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createBlogRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    const auth = await authorizeTenantBlogRequest(tenantId, request, runtimeEnv, "content:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return blogErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk endpoint profil penulis.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
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

  const parsedId = parseSequentialIdParam(rawAuthorId, "authorId", "penulis", requestId);
  if (!parsedId.ok) return parsedId.response;

  const { member, platformDb, tenantDb } = auth.ctx;
  const scopeOptions = {
    tenantId: member.tenantId,
    mediaBaseOrigin: runtimeEnv.MEDIA_PUBLIC_BASE_URL ?? null,
  };

  try {
    if (method === "GET") {
      const author = await getPostAuthorById(tenantDb, parsedId.id, scopeOptions);
      if (!author) {
        return blogErrorResponse(
          404,
          "NOT_FOUND",
          `Profil penulis #${parsedId.id} tidak ditemukan.`,
          requestId,
        );
      }
      return blogJsonResponse(200, formatAuthorRecordResponse(author));
    }

    if (method === "PATCH") {
      const parsedBody = await parseStrictBlogJsonBody(
        request,
        UPDATE_AUTHOR_ALLOWED_KEYS,
        requestId,
      );
      if (!parsedBody.ok) return parsedBody.response;

      const body = parsedBody.body;
      const versionCheck = extractBlogExpectedVersion(body, requestId, { required: true });
      if (!versionCheck.ok) return versionCheck.response;

      const updated = await updatePostAuthor(
        tenantDb,
        {
          authorId: parsedId.id,
          expectedVersion: versionCheck.expectedVersion!,
          ...(body.name !== undefined ? { name: body.name as string } : {}),
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
          ...(body.sameAs !== undefined
            ? { sameAs: body.sameAs as readonly string[] | string | null }
            : {}),
          nowMs: options.nowMs,
        },
        scopeOptions,
      );

      // Invalidate public blog caches so updated author byline/JSON-LD reflects immediately
      const cacheVersion = await bumpTenantCacheVersion(
        platformDb,
        member.tenantId,
        options.nowMs ?? Date.now(),
      );

      return blogJsonResponse(200, {
        ...formatAuthorRecordResponse(updated),
        cacheVersion,
      });
    }

    // DELETE /api/tenants/:tenantId/posts/authors/:authorId
    const parsedBody = await parseStrictBlogJsonBody(
      request,
      DELETE_AUTHOR_ALLOWED_KEYS,
      requestId,
      { allowEmptyBody: true },
    );
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body;
    const versionCheck = extractBlogExpectedVersion(body, requestId, { required: false });
    if (!versionCheck.ok) return versionCheck.response;

    const url = new URL(request.url);
    let expectedVersion = versionCheck.expectedVersion;
    if (expectedVersion === undefined) {
      const queryVersion = url.searchParams.get("version") ?? url.searchParams.get("expectedVersion");
      if (queryVersion !== null && queryVersion.trim() !== "") {
        if (!/^\d+$/.test(queryVersion.trim())) {
          return blogErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter query version harus berupa bilangan bulat non-negatif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Invalid version query parameter." }],
          );
        }
        expectedVersion = Number(queryVersion.trim());
      }
    }

    if (expectedVersion === undefined) {
      return blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field version wajib dikirim untuk kontrol konkurensi optimistik saat menghapus profil penulis.",
        requestId,
        [
          {
            field: "version",
            code: "REQUIRED",
            message: "Optimistic concurrency version is required on author DELETE.",
          },
        ],
      );
    }

    if (body.detach !== undefined && typeof body.detach !== "boolean") {
      return blogErrorResponse(
        422,
        "VALIDATION_ERROR",
        "detach harus berupa boolean.",
        requestId,
        [{ field: "detach", code: "INVALID_TYPE", message: "detach must be a boolean." }],
      );
    }

    const detach = body.detach === true || url.searchParams.get("detach") === "true";

    let reassignToAuthorId: number | null | undefined;
    if (body.reassignToAuthorId !== undefined) {
      if (
        body.reassignToAuthorId !== null &&
        (typeof body.reassignToAuthorId !== "number" ||
          !Number.isSafeInteger(body.reassignToAuthorId) ||
          body.reassignToAuthorId < 1)
      ) {
        return blogErrorResponse(
          422,
          "VALIDATION_ERROR",
          "reassignToAuthorId harus berupa bilangan bulat positif.",
          requestId,
          [
            {
              field: "reassignToAuthorId",
              code: "INVALID_ID",
              message: "reassignToAuthorId must be a positive integer.",
            },
          ],
        );
      }
      reassignToAuthorId = body.reassignToAuthorId;
    }

    await deletePostAuthor(tenantDb, {
      authorId: parsedId.id,
      expectedVersion,
      detach,
      reassignToAuthorId,
      nowMs: options.nowMs,
    });

    // Invalidate public blog caches so detached/reassigned author reflects immediately
    await bumpTenantCacheVersion(platformDb, member.tenantId, options.nowMs ?? Date.now());

    return blogNoContentResponse();
  } catch (err) {
    return mapBlogDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantPostAuthorItemRequest(
    params.tenantId ?? "",
    params.authorId ?? "",
    request,
    buildBlogRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
