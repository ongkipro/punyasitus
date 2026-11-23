import { env } from "cloudflare:workers";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { listMediaItems, type MediaItemPublicStatus } from "@punyasitus/db/media/index";
import { getVideoSlotUsage } from "@punyasitus/db/media/video";
import { getStorageUsageSnapshot } from "@punyasitus/db/storage-usage/index";
import type { APIRoute } from "astro";
import {
  authorizeMediaApiRequest,
  createMediaErrorResponse,
  createMediaJsonResponse,
  parsePositiveIntParam,
  serializeMediaItemRecord,
  type MediaApiHandlerOptions,
  type MediaApiRuntimeEnv,
} from "./helpers.ts";

/**
 * `GET /api/tenants/{tenantId}/media` — List tenant media library items & storage usage
 * (OpenAPI `tenantListMedia`, REQ-010, REQ-034, REQ-064).
 */

const ALLOWED_STATUS_FILTERS = new Set<MediaItemPublicStatus>([
  "quarantined",
  "processing",
  "ready",
  "failed",
  "trashed",
]);

export async function handleMediaListGet(
  tenantHandle: string,
  request: Request,
  runtimeEnv: MediaApiRuntimeEnv,
  options: MediaApiHandlerOptions = {},
): Promise<Response> {
  const auth = await authorizeMediaApiRequest(
    request,
    tenantHandle,
    runtimeEnv,
    { requiredPermission: "content:read", csrfMode: "none" },
    options,
  );
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = 20;
  if (rawLimit !== null) {
    const parsedLimit = parsePositiveIntParam(rawLimit);
    if (!parsedLimit || parsedLimit > 100) {
      return createMediaErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter limit harus berupa bilangan bulat antara 1 hingga 100.",
        auth.requestId,
      );
    }
    limit = parsedLimit;
  }

  const rawCursor = url.searchParams.get("cursor");
  let cursorId: number | null = null;
  if (rawCursor !== null && rawCursor.trim() !== "") {
    cursorId = parsePositiveIntParam(rawCursor);
    if (!cursorId) {
      return createMediaErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter cursor tidak valid.",
        auth.requestId,
      );
    }
  }

  const rawStatus = url.searchParams.get("status");
  let statusFilter: MediaItemPublicStatus | undefined;
  if (rawStatus !== null && rawStatus.trim() !== "") {
    if (!ALLOWED_STATUS_FILTERS.has(rawStatus as MediaItemPublicStatus)) {
      return createMediaErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Filter status media tidak valid.",
        auth.requestId,
      );
    }
    statusFilter = rawStatus as MediaItemPublicStatus;
  }

  const rawKind = url.searchParams.get("kind");
  let kindFilter: "image" | "video" | undefined;
  if (rawKind !== null && rawKind.trim() !== "") {
    if (rawKind !== "image" && rawKind !== "video") {
      return createMediaErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Filter jenis media harus berupa image atau video.",
        auth.requestId,
      );
    }
    kindFilter = rawKind;
  }

  const includeTrashed = url.searchParams.get("includeTrashed") === "true";

  const [listed, storage, videoSlots] = await Promise.all([
    listMediaItems(auth.tenantDb, {
      cursorId,
      limit,
      includeTrashed,
      status: statusFilter,
      kind: kindFilter,
    }),
    getStorageUsageSnapshot(auth.tenantDb, {
      tenantStatus: auth.member.tenantStatus,
      nowMs: auth.nowMs,
    }),
    getVideoSlotUsage(auth.tenantDb, options.maxVideos).catch(() => ({
      usedSlots: 0,
      maxSlots: 20,
      remainingSlots: 20,
    })),
  ]);

  return createMediaJsonResponse(200, {
    items: listed.items.map((item) => serializeMediaItemRecord(item, runtimeEnv)),
    page: {
      nextCursor: listed.nextCursor,
      limit: listed.limit,
      hasMore: listed.hasMore,
    },
    storage: {
      usedBytes: storage.usedBytes,
      reservedBytes: storage.reservedBytes,
      quotaBytes: storage.quotaBytes,
      availableBytes: storage.availableBytes,
      percentUsed: storage.percentUsed,
      warningAt80: storage.warningAt80,
    },
    videoSlots: {
      used: videoSlots.usedSlots,
      limit: videoSlots.maxSlots,
      remaining: videoSlots.remainingSlots,
    },
  });
}

export const GET: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return handleMediaListGet(params.tenantId ?? "", request, {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
  });
};
