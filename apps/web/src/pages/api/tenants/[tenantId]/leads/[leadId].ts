import { deleteSingleLeadPermanently } from "@punyasitus/db/activity-log/index";
import {
  getLeadById,
  updateLeadStatus,
  type LeadStatus,
} from "@punyasitus/db/leads/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantLeadRequest,
  buildLeadsRuntimeEnv,
  createRequestId,
  formatLeadRecordResponse,
  leadErrorResponse,
  leadJsonResponse,
  mapLeadDomainErrorToResponse,
  parseLeadIdParam,
  parseStrictLeadJsonBody,
  PRIVATE_NO_STORE_JSON_HEADERS,
  type TenantLeadsHandlerOptions,
  type TenantLeadsRuntimeEnv,
} from "./_shared.ts";

/**
 * Tenant-scoped Lead Inbox single-item endpoint:
 * - `GET    /api/tenants/:tenantId/leads/:leadId` -> read single lead
 * - `PATCH  /api/tenants/:tenantId/leads/:leadId` -> update status + optional internalNotes with optimistic `version` (`409 STALE_VERSION`)
 * - `DELETE /api/tenants/:tenantId/leads/:leadId` -> permanently delete single lead & dedup record with atomic PII-free `tenant_activity_log` entry (`204 No Content`)
 *
 * TASK-021 (`REQ-031`, `REQ-032`, `REQ-038`) & TASK-094 (`REQ-094`, `REQ-039`).
 */

const UPDATE_LEAD_ALLOWED_KEYS = new Set([
  "status",
  "internalNotes",
  "version",
  "expectedVersion",
]);

const DELETE_LEAD_ALLOWED_KEYS = new Set(["version", "expectedVersion"]);

function extractExpectedVersion(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const hasVersion = body.version !== undefined;
  const hasExpectedVersion = body.expectedVersion !== undefined;

  if (hasVersion && hasExpectedVersion && body.version !== body.expectedVersion) {
    return {
      ok: false,
      response: leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version dan expectedVersion harus bernilai sama jika keduanya dikirim.",
        requestId,
        [{ field: "version", code: "INVALID_VERSION", message: "Conflicting version fields." }],
      ),
    };
  }

  const raw = hasExpectedVersion ? body.expectedVersion : body.version;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return {
      ok: false,
      response: leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field version wajib berupa bilangan bulat positif untuk kontrol konkurensi optimistik.",
        requestId,
        [{ field: "version", code: "INVALID_VERSION", message: "Expected positive integer version." }],
      ),
    };
  }

  return { ok: true, expectedVersion: raw };
}

export async function handleTenantLeadDetailRequest(
  tenantId: string,
  rawLeadId: string,
  request: Request,
  runtimeEnv: TenantLeadsRuntimeEnv,
  options: TenantLeadsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createRequestId();

  if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
    const auth = await authorizeTenantLeadRequest(tenantId, request, runtimeEnv, "lead:read", {
      ...options,
      requestId,
    });
    if (!auth.ok) return auth.response;
    return leadErrorResponse(
      405,
      "BAD_REQUEST",
      "Metode HTTP tidak diizinkan untuk detail pesan masuk.",
      requestId,
      undefined,
      { Allow: "GET, PATCH, DELETE" },
    );
  }

  const requiredPermission =
    method === "GET" ? "lead:read" : method === "DELETE" ? "lead:delete" : "lead:update";
  const auth = await authorizeTenantLeadRequest(
    tenantId,
    request,
    runtimeEnv,
    requiredPermission,
    { ...options, requestId },
  );
  if (!auth.ok) return auth.response;

  const parsedId = parseLeadIdParam(rawLeadId, requestId);
  if (!parsedId.ok) return parsedId.response;

  const { tenantDb, member, primaryOrigin } = auth.ctx;

  try {
    if (method === "GET") {
      const lead = await getLeadById(tenantDb, parsedId.leadId);
      if (!lead) {
        return leadErrorResponse(404, "NOT_FOUND", "Pesan masuk tidak ditemukan.", requestId);
      }
      return leadJsonResponse(200, formatLeadRecordResponse(lead, primaryOrigin));
    }

    if (method === "DELETE") {
      let expectedVersion: number | undefined;
      const urlVersion = new URL(request.url).searchParams.get("version");
      if (urlVersion !== null && urlVersion.trim() !== "") {
        const parsedQueryVersion = Number(urlVersion.trim());
        if (
          !Number.isSafeInteger(parsedQueryVersion) ||
          parsedQueryVersion < 1 ||
          parsedQueryVersion > 2_147_483_647
        ) {
          return leadErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter version harus berupa bilangan bulat positif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Expected positive integer version." }],
          );
        }
        expectedVersion = parsedQueryVersion;
      } else {
        const clonedText = (await request.clone().text()).trim();
        if (clonedText.length > 0) {
          const parsedBody = await parseStrictLeadJsonBody(
            request,
            DELETE_LEAD_ALLOWED_KEYS,
            requestId,
          );
          if (!parsedBody.ok) return parsedBody.response;
          const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
          if (!versionCheck.ok) return versionCheck.response;
          expectedVersion = versionCheck.expectedVersion;
        }
      }

      await deleteSingleLeadPermanently(tenantDb, {
        leadId: parsedId.leadId,
        expectedVersion,
        actorUserId: member.userId,
        actorRole: member.role,
        nowMs: options.nowMs,
      });

      const headers = new Headers(PRIVATE_NO_STORE_JSON_HEADERS);
      headers.delete("Content-Type");
      headers.set("X-Request-Id", requestId);
      return new Response(null, { status: 204, headers });
    }

    // PATCH /api/tenants/:tenantId/leads/:leadId
    const parsedBody = await parseStrictLeadJsonBody(request, UPDATE_LEAD_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const versionCheck = extractExpectedVersion(parsedBody.body, requestId);
    if (!versionCheck.ok) return versionCheck.response;

    const rawStatus = parsedBody.body.status;
    if (typeof rawStatus !== "string" || !rawStatus.trim()) {
      return leadErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field status wajib diisi.",
        requestId,
        [{ field: "status", code: "REQUIRED", message: "status is required." }],
      );
    }

    const updated = await updateLeadStatus(tenantDb, {
      leadId: parsedId.leadId,
      status: rawStatus.trim().toLowerCase() as LeadStatus,
      ...(parsedBody.body.internalNotes !== undefined
        ? { internalNotes: parsedBody.body.internalNotes as string | null }
        : {}),
      expectedVersion: versionCheck.expectedVersion,
      actorUserId: member.userId,
      actorRole: member.role,
      nowMs: options.nowMs,
    });

    return leadJsonResponse(200, formatLeadRecordResponse(updated, primaryOrigin));
  } catch (err) {
    return mapLeadDomainErrorToResponse(err, requestId);
  }
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantLeadDetailRequest(
    params.tenantId ?? "",
    params.leadId ?? "",
    request,
    buildLeadsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
