import {
  createEmptyInsightsSummary,
  getTenantInsightsSummary,
  type TenantInsightsSummary,
} from "@punyasitus/db/analytics/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { TenantVertical } from "@punyasitus/db/platform";
import type { LifecycleStatus } from "../../../../components/admin/navigation.ts";
import { bindTenantDatabase } from "../../../../core/tenant.ts";

/**
 * Shared server-side loader & formatters for `/dashboard/[handle]` and
 * `/dashboard/[handle]/insights` (TASK-072, REQ-073).
 */

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export function parseInsightsRangeDays(rawRange: string | null | undefined): 7 | 30 {
  return rawRange === "30" ? 30 : 7;
}

export function mapLifecycleStatus(status: string): LifecycleStatus {
  if (
    status === "trial" ||
    status === "active" ||
    status === "grace" ||
    status === "locked" ||
    status === "suspended"
  ) {
    return status;
  }
  return "suspended";
}

export function mapVerticalToOfferingLabel(vertical?: TenantVertical): string {
  switch (vertical) {
    case "catalog":
    case "resto":
      return "Produk";
    case "travel":
      return "Paket Tur";
    case "dealer":
      return "Kendaraan";
    case "compro":
    case "sales":
    default:
      return "Layanan";
  }
}

export function formatNumberId(value: number): string {
  return new Intl.NumberFormat("id-ID").format(value);
}

export function formatPercentId(value: number): string {
  return `${new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

export function formatDayLabelId(isoDay: string): string {
  const parts = isoDay.split("-");
  if (parts.length !== 3) return isoDay;
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return isoDay;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(dt);
}

export function createNeutralNotFoundHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export async function loadTenantInsightsSafe(params: {
  readonly tenantId: string;
  readonly tenantDb?: D1Database | null;
  readonly tenantStoreNamespace?: TenantStoreNamespaceLike | null;
  readonly days: 7 | 30;
  readonly isLocalLoopback?: boolean;
  readonly nowMs?: number;
  readonly popularItemsLimit?: number;
}): Promise<{
  readonly insights: TenantInsightsSummary;
  readonly error: string | null;
}> {
  const activeTenantDb =
    params.tenantDb ??
    (params.tenantStoreNamespace
      ? bindTenantDatabase(params.tenantStoreNamespace, params.tenantId)
      : null);

  if (!activeTenantDb) {
    if (params.isLocalLoopback) {
      return {
        insights: createEmptyInsightsSummary({ days: params.days, nowMs: params.nowMs }),
        error: null,
      };
    }
    return {
      insights: createEmptyInsightsSummary({ days: params.days, nowMs: params.nowMs }),
      error: "Penyimpanan data tenant tidak tersedia sementara.",
    };
  }

  try {
    const insights = await getTenantInsightsSummary(activeTenantDb, {
      days: params.days,
      nowMs: params.nowMs,
      popularItemsLimit: params.popularItemsLimit,
    });
    return { insights, error: null };
  } catch {
    if (params.isLocalLoopback) {
      return {
        insights: createEmptyInsightsSummary({ days: params.days, nowMs: params.nowMs }),
        error: null,
      };
    }
    return {
      insights: createEmptyInsightsSummary({ days: params.days, nowMs: params.nowMs }),
      error: "Wawasan pengunjung sementara tidak dapat dimuat. Silakan coba muat ulang.",
    };
  }
}
