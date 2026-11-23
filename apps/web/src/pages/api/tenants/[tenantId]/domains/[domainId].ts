import { DomainProviderError } from "@punyasitus/core/domains/index";
import {
  beginDomainRemoval,
  finalizeDomainRemoval,
  getTenantDomainBySelector,
} from "@punyasitus/db/domains/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantDomainsRequest,
  createDomainRequestId,
  domainsErrorResponse,
  domainsJsonResponse,
  formatDomainRecordResponse,
  mapDomainErrorToResponse,
  observeDnsForHostname,
  parseStrictDomainsJsonBody,
  resolveCloudflareClient,
  resolveDnsResolver,
  type TenantDomainsHandlerOptions,
  type TenantDomainsRuntimeEnv,
} from "./_shared.ts";
import { buildDomainsRuntimeEnv } from "./index.ts";

/**
 * Single Tenant Domain endpoints:
 * - `GET /api/tenants/:tenantId/domains/:domainId` — read domain status, records, token age & remedies
 * - `DELETE /api/tenants/:tenantId/domains/:domainId` — safe removal of never-activated custom domain
 *   (requires confirmation naming exact hostname + optimistic version; active custom domains are locked
 *   for owners per REQ-065 -> `403 DOMAIN_LOCKED`)
 */

const DELETE_ALLOWED_KEYS = new Set(["confirmHostname", "version"]);

export async function handleTenantDomainDetailRequest(
  tenantId: string,
  domainId: string,
  request: Request,
  runtimeEnv: TenantDomainsRuntimeEnv,
  options: TenantDomainsHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createDomainRequestId();

  if (method === "GET") {
    const auth = await authorizeTenantDomainsRequest(
      tenantId,
      request,
      runtimeEnv,
      "domain:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;

    try {
      const record = await getTenantDomainBySelector(
        auth.ctx.platformDb,
        auth.ctx.member.tenantId,
        domainId,
      );
      if (!record) {
        return domainsErrorResponse(404, "NOT_FOUND", "Domain tidak ditemukan.", requestId);
      }

      const dnsObservation =
        record.kind === "custom" && options.dnsResolver !== null
          ? await observeDnsForHostname(resolveDnsResolver(options), record.hostname)
          : undefined;

      return domainsJsonResponse(
        200,
        formatDomainRecordResponse(record, {
          cnameTarget: auth.ctx.cnameTarget,
          dnsObservation,
          nowMs: auth.ctx.nowMs,
        }),
      );
    } catch (err) {
      return mapDomainErrorToResponse(err, requestId);
    }
  }

  if (method === "DELETE") {
    const auth = await authorizeTenantDomainsRequest(
      tenantId,
      request,
      runtimeEnv,
      "domain:remove_inactive",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;

    const parsedBody = await parseStrictDomainsJsonBody(request, DELETE_ALLOWED_KEYS, requestId);
    if (!parsedBody.ok) return parsedBody.response;

    const rawConfirm = parsedBody.body.confirmHostname;
    const rawVersion = parsedBody.body.version;

    if (typeof rawConfirm !== "string" || !rawConfirm.trim()) {
      return domainsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "confirmHostname wajib diisi sama persis dengan hostname yang akan dihapus.",
        requestId,
        {
          fields: [
            { field: "confirmHostname", code: "REQUIRED", message: "confirmHostname is required" },
          ],
        },
      );
    }

    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
      return domainsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa bilangan bulat non-negatif.",
        requestId,
        { fields: [{ field: "version", code: "INVALID_VERSION", message: "Invalid version" }] },
      );
    }

    try {
      const existing = await getTenantDomainBySelector(
        auth.ctx.platformDb,
        auth.ctx.member.tenantId,
        domainId,
      );
      if (!existing) {
        return domainsErrorResponse(404, "NOT_FOUND", "Domain tidak ditemukan.", requestId);
      }

      const normalizedConfirm = rawConfirm.trim().toLowerCase().replace(/\.$/, "");
      if (normalizedConfirm !== existing.hostname) {
        return domainsErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Konfirmasi hostname tidak cocok. Ketik persis "${existing.hostname}" untuk menghapus.`,
          requestId,
          {
            reasonCode: "CONFIRM_HOSTNAME_MISMATCH",
            fields: [
              {
                field: "confirmHostname",
                code: "CONFIRM_HOSTNAME_MISMATCH",
                message: "Hostname confirmation mismatch",
              },
            ],
          },
        );
      }

      // Step 1: Disable routing atomically, bump cache_version, evict isolate cache, enforce REQ-065 lock
      const started = await beginDomainRemoval(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        hostname: existing.hostname,
        expectedVersion: rawVersion,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        requestId,
        enforceOwnerActiveLock: true,
        nowMs: auth.ctx.nowMs,
      });

      // Step 2: Delete from Cloudflare for SaaS if registered
      if (started.cfCustomHostnameId) {
        try {
          const cfClient = resolveCloudflareClient(runtimeEnv, options);
          await cfClient.deleteCustomHostname(started.cfCustomHostnameId);
        } catch (err) {
          if (err instanceof DomainProviderError && err.retryable) {
            // PLAN §3.1: keep routing disabled & claim retained in `deleting` until cleanup succeeds
            return domainsJsonResponse(202, {
              cleanupPending: true,
              hostname: existing.hostname,
              status: "disabled",
              message:
                "Routing domain telah dinonaktifkan. Pembersihan pada Cloudflare tertunda dan akan dicoba ulang.",
              requestId,
            });
          }
          throw err;
        }
      }

      // Step 3: Release local claim cleanly with audit trail
      await finalizeDomainRemoval(auth.ctx.platformDb, {
        tenantId: auth.ctx.member.tenantId,
        hostname: existing.hostname,
        cfCustomHostnameId: started.cfCustomHostnameId,
        actorUserId: auth.ctx.member.userId,
        actorRole: auth.ctx.member.role,
        requestId,
        nowMs: auth.ctx.nowMs,
      });

      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    } catch (err) {
      return mapDomainErrorToResponse(err, requestId);
    }
  }

  return domainsErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan untuk endpoint detail domain.",
    requestId,
    { headers: { Allow: "GET, DELETE" } },
  );
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantDomainDetailRequest(
    params.tenantId ?? "",
    params.domainId ?? "",
    request,
    buildDomainsRuntimeEnv(),
    {
      authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
      activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
    },
  );
