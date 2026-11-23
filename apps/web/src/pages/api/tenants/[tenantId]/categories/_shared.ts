import { AuthorizationError } from "@punyasitus/auth";
import { isCatalogOfferingType, type CatalogOfferingType } from "@punyasitus/core/catalog/index";
import { PublicationValidationError } from "@punyasitus/core/content/index";
import { SlugValidationError } from "@punyasitus/core/slug/index";
import { TaxonomyDomainError } from "@punyasitus/core/taxonomy/index";
import {
  TaxonomyNotFoundError,
  TaxonomyStaleVersionError,
  type TaxonomyRecord,
} from "@punyasitus/db/taxonomy/index";
import {
  authorizeTenantBlogRequest,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  parseListPaginationParams,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
} from "../posts/_shared.ts";

/**
 * Shared HTTP response formatting, `private, no-store` / `noindex, nofollow` headers,
 * and domain error mapping for `/api/tenants/:tenantId/{categories,tags}/**`
 * (TASK-041; REQ-045, REQ-009, REQ-012, REQ-034, REQ-036, REQ-061).
 */

export const TAXONOMY_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function withPrivateNoStoreHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function taxonomyJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(TAXONOMY_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function taxonomyNoContentResponse(extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(null, { status: 204, headers });
}

export function taxonomyErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  fields?: readonly { readonly field: string; readonly code: string; readonly message: string }[],
  meta?: Readonly<Record<string, unknown>>,
  extraHeaders?: HeadersInit,
): Response {
  return taxonomyJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(fields && fields.length > 0 ? { fields } : {}),
        ...(meta ? meta : {}),
      },
      requestId,
    },
    extraHeaders,
  );
}

export function formatTaxonomyResponse(tax: TaxonomyRecord): Record<string, unknown> {
  return {
    id: tax.id,
    kind: tax.kind,
    offeringType: tax.offeringType,
    name: tax.name,
    slug: tax.slug,
    publicPath: tax.publicPath,
    description: tax.description,
    parentId: tax.parentId,
    depth: tax.depth,
    sortOrder: tax.sortOrder,
    publishedCount: tax.publishedCount,
    draftCount: tax.draftCount,
    totalUsageCount: tax.totalUsageCount,
    usageCount: tax.usageCount,
    childCount: tax.childCount,
    indexOptIn: tax.indexOptIn,
    hasUsefulIntro: tax.hasUsefulIntro,
    indexable: tax.indexable,
    formerSlugs: tax.formerSlugs,
    version: tax.version,
    createdAt: tax.createdAt,
    updatedAt: tax.updatedAt,
  };
}

export function extractIndexOptInField(
  body: Record<string, unknown>,
  requestId: string,
):
  | { readonly ok: true; readonly value: boolean | undefined }
  | { readonly ok: false; readonly response: Response } {
  const hasOptIn = body.indexOptIn !== undefined;
  const hasIndexable = body.indexable !== undefined;

  if (hasOptIn && typeof body.indexOptIn !== "boolean") {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "indexOptIn harus berupa boolean.",
        requestId,
        [{ field: "indexOptIn", code: "INVALID_TYPE", message: "Expected boolean for indexOptIn." }],
      ),
    };
  }
  if (hasIndexable && typeof body.indexable !== "boolean") {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "indexable harus berupa boolean.",
        requestId,
        [{ field: "indexable", code: "INVALID_TYPE", message: "Expected boolean for indexable." }],
      ),
    };
  }
  if (hasOptIn && hasIndexable && body.indexOptIn !== body.indexable) {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "indexOptIn dan indexable harus bernilai sama jika keduanya dikirim.",
        requestId,
        [
          {
            field: "indexOptIn",
            code: "CONFLICTING_FIELDS",
            message: "indexOptIn and indexable must match when both are provided.",
          },
        ],
      ),
    };
  }

  if (hasOptIn) return { ok: true, value: body.indexOptIn as boolean };
  if (hasIndexable) return { ok: true, value: body.indexable as boolean };
  return { ok: true, value: undefined };
}

export function parseOfferingTypeQueryParam(
  raw: string | null,
  requestId: string,
):
  | { readonly ok: true; readonly offeringType: CatalogOfferingType | undefined }
  | { readonly ok: false; readonly response: Response } {
  if (raw === null || raw.trim() === "") {
    return { ok: true, offeringType: undefined };
  }
  const trimmed = raw.trim();
  if (!isCatalogOfferingType(trimmed)) {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Parameter offeringType harus "service", "product", "tour", atau "vehicle".',
        requestId,
        [
          {
            field: "offeringType",
            code: "INVALID_OFFERING_TYPE",
            message: "offeringType must be service, product, tour, or vehicle.",
          },
        ],
      ),
    };
  }
  return { ok: true, offeringType: trimmed };
}

export function extractRequiredDeleteVersion(
  body: Record<string, unknown>,
  url: URL,
  requestId: string,
):
  | { readonly ok: true; readonly expectedVersion: number }
  | { readonly ok: false; readonly response: Response } {
  const versionCheck = extractBlogExpectedVersion(body, requestId, { required: false });
  if (!versionCheck.ok) {
    return { ok: false, response: withPrivateNoStoreHeaders(versionCheck.response) };
  }

  let expectedVersion = versionCheck.expectedVersion;
  if (expectedVersion === undefined) {
    const queryVersion = url.searchParams.get("expectedVersion") ?? url.searchParams.get("version");
    if (queryVersion !== null && queryVersion.trim() !== "") {
      if (!/^[1-9]\d{0,9}$/.test(queryVersion.trim())) {
        return {
          ok: false,
          response: taxonomyErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Parameter query version harus berupa bilangan bulat positif.",
            requestId,
            [{ field: "version", code: "INVALID_VERSION", message: "Invalid version query parameter." }],
          ),
        };
      }
      expectedVersion = Number(queryVersion.trim());
    }
  }

  if (expectedVersion === undefined) {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Field version wajib dikirim untuk kontrol konkurensi optimistik saat menghapus taksonomi.",
        requestId,
        [
          {
            field: "version",
            code: "REQUIRED",
            message: "Optimistic concurrency version is required on DELETE.",
          },
        ],
      ),
    };
  }

  if (expectedVersion < 1) {
    return {
      ok: false,
      response: taxonomyErrorResponse(
        422,
        "VALIDATION_ERROR",
        "version harus berupa bilangan bulat positif.",
        requestId,
        [{ field: "version", code: "INVALID_VERSION", message: "Expected a positive integer version." }],
      ),
    };
  }

  return { ok: true, expectedVersion };
}

export function mapTaxonomyDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof TaxonomyDomainError) {
    return taxonomyErrorResponse(
      err.httpStatus,
      err.code,
      err.message,
      requestId,
      err.fields,
      err.meta,
    );
  }
  if (err instanceof SlugValidationError) {
    return taxonomyErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields, {
      ...(err.suggestedSlug ? { suggestedSlug: err.suggestedSlug } : {}),
    });
  }
  if (err instanceof PublicationValidationError) {
    return taxonomyErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, err.fields);
  }
  if (err instanceof TaxonomyStaleVersionError) {
    return taxonomyErrorResponse(
      409,
      "STALE_VERSION",
      err.message,
      requestId,
      [{ field: "version", code: "STALE_VERSION", message: err.message }],
      {
        expectedVersion: err.expectedVersion,
        ...(err.actualVersion !== null ? { currentVersion: err.actualVersion } : {}),
      },
    );
  }
  if (err instanceof TaxonomyNotFoundError) {
    return taxonomyErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return taxonomyErrorResponse(err.status, err.code, err.message, requestId);
  }
  return taxonomyErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Gagal memproses operasi taksonomi tenant.",
    requestId,
    undefined,
    undefined,
    { "Retry-After": "60" },
  );
}

export {
  authorizeTenantBlogRequest,
  buildBlogRuntimeEnv,
  createBlogRequestId,
  extractBlogExpectedVersion,
  parseListPaginationParams,
  parseSequentialIdParam,
  parseStrictBlogJsonBody,
  type TenantBlogHandlerOptions,
  type TenantBlogRuntimeEnv,
};
