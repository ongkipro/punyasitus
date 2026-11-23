import { QR_UTM_QUERY_KEY, QR_UTM_QUERY_VALUE } from "./canonical.ts";

/**
 * First-Party QR Scan Visit Classification & Insights Aggregation (`REQ-108`, `REQ-017`, `REQ-073`).
 *
 * Matches `utm_source=qr` case-insensitively without storing visitor PII or raw query strings.
 */

export const QR_SCAN_CHANNEL_KEY = "qr_scan" as const;
export const QR_SCAN_CHANNEL_LABEL_ID = "Pindaian QR" as const;

export type QrScanVisitSourceInput =
  | string
  | URL
  | URLSearchParams
  | {
      readonly landingUrl?: string | null;
      readonly searchParams?: URLSearchParams | null;
      readonly utmSource?: string | null;
      readonly path?: string | null;
      readonly count?: number;
    };

export interface QrScanClassification {
  readonly isQrScan: boolean;
  readonly utmSource: string | null;
  readonly channel: "qr_scan" | "other";
  readonly label: string;
  readonly path: string | null;
}

export interface QrScanPathCount {
  readonly path: string;
  readonly qrScans: number;
}

export interface QrScanCountSummary {
  readonly totalVisits: number;
  readonly qrScans: number;
  readonly nonQrVisits: number;
  readonly sharePercent: number;
  readonly label: string;
  readonly byPath: readonly QrScanPathCount[];
}

function readUtmSourceFromSearchParams(params: URLSearchParams): string | null {
  for (const [key, value] of params.entries()) {
    if (key.trim().toLowerCase() === QR_UTM_QUERY_KEY) {
      const normalized = value.trim().toLowerCase();
      return normalized.length > 0 ? normalized : null;
    }
  }
  return null;
}

function parseUrlString(raw: string): { readonly utmSource: string | null; readonly path: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { utmSource: null, path: null };

  // Handle bare query strings like "?utm_source=qr" or "utm_source=qr"
  if (trimmed.startsWith("?")) {
    return { utmSource: readUtmSourceFromSearchParams(new URLSearchParams(trimmed)), path: null };
  }
  if (!trimmed.includes("://") && !trimmed.startsWith("/") && trimmed.includes("=")) {
    return { utmSource: readUtmSourceFromSearchParams(new URLSearchParams(trimmed)), path: null };
  }

  try {
    const parsed = new URL(trimmed, "https://example.invalid");
    return {
      utmSource: readUtmSourceFromSearchParams(parsed.searchParams),
      path: parsed.pathname || "/",
    };
  } catch {
    return { utmSource: null, path: null };
  }
}

/**
 * Classifies a single visit URL, `URL`, `URLSearchParams`, or structured visit record
 * to determine whether it originated from a tagged QR scan (`utm_source=qr`, case-insensitive).
 */
export function classifyQrScanVisit(input: QrScanVisitSourceInput | null | undefined): QrScanClassification {
  let utmSource: string | null = null;
  let path: string | null = null;

  if (typeof input === "string") {
    const parsed = parseUrlString(input);
    utmSource = parsed.utmSource;
    path = parsed.path;
  } else if (input instanceof URL) {
    utmSource = readUtmSourceFromSearchParams(input.searchParams);
    path = input.pathname || "/";
  } else if (input instanceof URLSearchParams) {
    utmSource = readUtmSourceFromSearchParams(input);
  } else if (input && typeof input === "object") {
    if (typeof input.utmSource === "string" && input.utmSource.trim().length > 0) {
      utmSource = input.utmSource.trim().toLowerCase();
    } else if (input.searchParams instanceof URLSearchParams) {
      utmSource = readUtmSourceFromSearchParams(input.searchParams);
    } else if (typeof input.landingUrl === "string") {
      const parsed = parseUrlString(input.landingUrl);
      utmSource = parsed.utmSource;
      path = parsed.path;
    }

    if (typeof input.path === "string" && input.path.trim().length > 0) {
      path = input.path.trim().split("?")[0] ?? "/";
    }
  }

  const isQrScan = utmSource === QR_UTM_QUERY_VALUE;
  return {
    isQrScan,
    utmSource,
    channel: isQrScan ? QR_SCAN_CHANNEL_KEY : "other",
    label: isQrScan ? QR_SCAN_CHANNEL_LABEL_ID : "Lainnya",
    path,
  };
}

/**
 * Aggregates QR scan visits (`utm_source=qr`) across a batch of visits or daily/path buckets
 * for tenant Insights reporting (`REQ-108`, `REQ-073`).
 */
export function countQrScanVisits(visits: readonly QrScanVisitSourceInput[]): QrScanCountSummary {
  let totalVisits = 0;
  let qrScans = 0;
  const byPathMap = new Map<string, number>();

  for (const visit of visits) {
    const rawCount =
      typeof visit === "object" &&
      visit !== null &&
      !(visit instanceof URL) &&
      !(visit instanceof URLSearchParams) &&
      typeof visit.count === "number" &&
      Number.isFinite(visit.count) &&
      visit.count >= 0
        ? Math.floor(visit.count)
        : 1;

    if (rawCount === 0) continue;

    const classified = classifyQrScanVisit(visit);
    totalVisits += rawCount;
    if (classified.isQrScan) {
      qrScans += rawCount;
      const bucketPath = classified.path ?? "/";
      byPathMap.set(bucketPath, (byPathMap.get(bucketPath) ?? 0) + rawCount);
    }
  }

  const nonQrVisits = Math.max(0, totalVisits - qrScans);
  const sharePercent =
    totalVisits > 0 ? Math.round((qrScans / totalVisits) * 1000) / 10 : 0;

  const byPath: QrScanPathCount[] = Array.from(byPathMap.entries())
    .map(([path, count]) => ({ path, qrScans: count }))
    .sort((a, b) => (b.qrScans !== a.qrScans ? b.qrScans - a.qrScans : a.path.localeCompare(b.path)));

  return {
    totalVisits,
    qrScans,
    nonQrVisits,
    sharePercent,
    label: QR_SCAN_CHANNEL_LABEL_ID,
    byPath,
  };
}
