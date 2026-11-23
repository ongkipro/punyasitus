import {
  INSIGHT_CONTENT_KIND_LABELS_ID,
  INSIGHT_SOURCE_BUCKETS,
  INSIGHT_SOURCE_LABELS_ID,
  INSIGHTS_ESTIMATE_LABEL_ID,
  inferInsightContentKind,
  normalizeInsightsTimeZone,
  projectUtcHourlyRowsToTimezone,
  type InsightContentKind,
  type InsightSourceBucket,
  type ProjectedPeakHoursResult,
  type StoredUtcHourRow,
} from "@punyasitus/core/analytics/insights";
import {
  DEFAULT_ANALYTICS_TIMEZONE,
  formatAnalyticsDay,
  type AnalyticsDailyRow,
} from "./counters.ts";

/**
 * First-Party Insights Read & Aggregation Repository
 * (`packages/db/src/analytics/insights.ts`; TASK-072, REQ-073, PLAN §7.3, §18.4).
 *
 * Reads strictly daily per-tenant aggregates from the tenant's isolated `TenantStore`
 * and dynamically projects stored UTC hourly buckets into the tenant's configured
 * `site_settings.timezone` at query time WITHOUT rewriting stored rows.
 */

export interface AnalyticsContentDailyRow {
  readonly day_utc: string;
  readonly content_kind: InsightContentKind;
  readonly content_id: number;
  readonly path: string;
  readonly page_views: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
}

export interface AnalyticsSourcesDailyRow {
  readonly day_utc: string;
  readonly source_bucket: InsightSourceBucket;
  readonly utm_source: string;
  readonly page_views: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
}

export interface PopularContentItemMetric {
  readonly contentKind: InsightContentKind;
  readonly contentKindLabel: string;
  readonly contentId: number;
  readonly path: string;
  readonly title: string;
  readonly pageViews: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalInterestSignals: number;
  readonly totalActivity: number;
}

export interface TrafficSourceMetric {
  readonly bucket: InsightSourceBucket;
  readonly label: string;
  readonly pageViews: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalActivity: number;
  readonly sharePercent: number;
}

export interface UtmCampaignMetric {
  readonly utmSource: string;
  readonly pageViews: number;
  readonly waClicks: number;
  readonly externalClicks: number;
  readonly leadSubmits: number;
  readonly totalActivity: number;
}

export interface TenantInsightsSummary {
  readonly days: 7 | 30;
  readonly startDay: string;
  readonly endDay: string;
  readonly timeZone: string;
  readonly timeZoneLabel: string;
  readonly estimateLabel: string;
  readonly totals: {
    readonly pageViews: number;
    readonly waClicks: number;
    readonly externalClicks: number;
    readonly leadSubmits: number;
    readonly totalInterestSignals: number;
    readonly totalActivity: number;
  };
  readonly popularItems: readonly PopularContentItemMetric[];
  readonly popularByKind: Readonly<{
    readonly pages: readonly PopularContentItemMetric[];
    readonly posts: readonly PopularContentItemMetric[];
    readonly offerings: readonly PopularContentItemMetric[];
  }>;
  readonly sources: readonly TrafficSourceMetric[];
  readonly utmCampaigns: readonly UtmCampaignMetric[];
  readonly peakHours: ProjectedPeakHoursResult;
  readonly hasAnyData: boolean;
}

export interface GetTenantInsightsSummaryOptions {
  readonly days?: 7 | 30;
  readonly nowMs?: number;
  /** Optional explicit IANA timezone override; otherwise read live from `site_settings.timezone`. */
  readonly timeZone?: string;
  readonly popularItemsLimit?: number;
}

function toSafeCount(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function shiftIsoDay(isoDay: string, deltaDays: number): string {
  const parts = isoDay.split("-");
  if (parts.length !== 3) return isoDay;
  const dt = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + deltaDays, 12, 0, 0),
  );
  if (Number.isNaN(dt.getTime())) return isoDay;
  return dt.toISOString().slice(0, 10);
}

function buildLocalWindow(
  days: 7 | 30,
  nowMs: number,
  timeZone: string,
): {
  readonly startDay: string;
  readonly endDay: string;
  readonly queryStartDayUtc: string;
  readonly queryEndDayUtc: string;
} {
  const endDay = formatAnalyticsDay(nowMs, timeZone);
  const startDay = shiftIsoDay(endDay, -(days - 1));
  return {
    startDay,
    endDay,
    queryStartDayUtc: shiftIsoDay(startDay, -1),
    queryEndDayUtc: shiftIsoDay(endDay, 1),
  };
}

function fallbackTitleFromPath(path: string, contentKind: InsightContentKind): string {
  if (path === "/") return "Beranda";
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? path;
  const words = last
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  if (words) return words;
  return INSIGHT_CONTENT_KIND_LABELS_ID[contentKind];
}

export interface ContentTitleLookup {
  readonly pagesById: ReadonlyMap<number, string>;
  readonly postsById: ReadonlyMap<number, string>;
  readonly offeringsById: ReadonlyMap<number, string>;
  readonly pagesBySlug: ReadonlyMap<string, string>;
  readonly postsBySlug: ReadonlyMap<string, string>;
  readonly offeringsBySlug: ReadonlyMap<string, string>;
}

function resolveFriendlyTitle(
  kind: InsightContentKind,
  contentId: number,
  path: string,
  titles?: ContentTitleLookup,
): string {
  if (titles) {
    if (contentId > 0) {
      if (kind === "page") {
        const hit = titles.pagesById.get(contentId);
        if (hit) return hit;
      } else if (kind === "post") {
        const hit = titles.postsById.get(contentId);
        if (hit) return hit;
      } else if (kind === "offering") {
        const hit = titles.offeringsById.get(contentId);
        if (hit) return hit;
      }
    }
    const clean = path.replace(/^\/+|\/+$/g, "");
    const parts = clean.split("/");
    if (kind === "post" && parts[0] === "blog" && parts[1]) {
      const hit = titles.postsBySlug.get(parts[1]);
      if (hit) return hit;
    } else if (
      kind === "offering" &&
      (parts[0] === "layanan" ||
        parts[0] === "produk" ||
        parts[0] === "tour" ||
        parts[0] === "kendaraan") &&
      parts[1]
    ) {
      const hit = titles.offeringsBySlug.get(parts[1]);
      if (hit) return hit;
    } else if (kind === "page") {
      if (path === "/") {
        const home = titles.pagesBySlug.get("beranda") ?? titles.pagesBySlug.get("home");
        if (home) return home;
      } else if (parts.length === 1 && parts[0]) {
        const hit = titles.pagesBySlug.get(parts[0]);
        if (hit) return hit;
      }
    }
  }
  return fallbackTitleFromPath(path, kind);
}

/**
 * Pure aggregation over UTC content, source, and hourly rows, dynamically projecting
 * peak hours to the requested tenant IANA timezone without mutating stored rows.
 */
export function aggregateInsightsRows(params: {
  readonly contentRows: readonly AnalyticsContentDailyRow[];
  readonly sourceRows: readonly AnalyticsSourcesDailyRow[];
  readonly hourlyRows: readonly StoredUtcHourRow[];
  readonly days?: 7 | 30;
  readonly nowMs?: number;
  readonly timeZone?: string;
  readonly popularItemsLimit?: number;
  readonly titles?: ContentTitleLookup;
}): TenantInsightsSummary {
  const days: 7 | 30 = params.days === 30 ? 30 : 7;
  const nowMs = Math.floor(params.nowMs ?? Date.now());
  const timeZone = normalizeInsightsTimeZone(params.timeZone ?? DEFAULT_ANALYTICS_TIMEZONE);
  const popularItemsLimit = Math.max(
    1,
    Math.min(50, Math.floor(params.popularItemsLimit ?? 12)),
  );
  const { startDay, endDay } = buildLocalWindow(
    days,
    nowMs,
    timeZone,
  );

  // 1. Dynamically project UTC hourly rows into tenant timezone (zero stored-row rewrite!).
  // Hourly rows are fetched with ±1 UTC day margin and filtered strictly to [startDay, endDay] local days.
  const peakHours = projectUtcHourlyRowsToTimezone(params.hourlyRows, {
    timeZone,
    startLocalDay: startDay,
    endLocalDay: endDay,
  });

  // 2. Aggregate popular content items strictly within the exact [startDay, endDay] UTC-day window
  // (never ±1 days, avoiding 9-day / 32-day over-counting).
  const contentMap = new Map<
    string,
    {
      contentKind: InsightContentKind;
      contentId: number;
      path: string;
      pageViews: number;
      waClicks: number;
      externalClicks: number;
      leadSubmits: number;
    }
  >();

  let totalPageViews = 0;
  let totalWaClicks = 0;
  let totalExternalClicks = 0;
  let totalLeadSubmits = 0;

  for (const row of params.contentRows) {
    if (!row.day_utc || row.day_utc < startDay || row.day_utc > endDay) continue;
    const pv = toSafeCount(row.page_views);
    const wa = toSafeCount(row.wa_clicks);
    const ext = toSafeCount(row.external_clicks);
    const leads = toSafeCount(row.lead_submits);
    if (pv + wa + ext + leads === 0) continue;

    totalPageViews += pv;
    totalWaClicks += wa;
    totalExternalClicks += ext;
    totalLeadSubmits += leads;

    const key = `${row.content_kind}:${row.path}`;
    const existing = contentMap.get(key) ?? {
      contentKind: row.content_kind,
      contentId: toSafeCount(row.content_id),
      path: row.path,
      pageViews: 0,
      waClicks: 0,
      externalClicks: 0,
      leadSubmits: 0,
    };
    if (existing.contentId === 0 && toSafeCount(row.content_id) > 0) {
      existing.contentId = toSafeCount(row.content_id);
    }
    existing.pageViews += pv;
    existing.waClicks += wa;
    existing.externalClicks += ext;
    existing.leadSubmits += leads;
    contentMap.set(key, existing);
  }

  const allPopularItems: PopularContentItemMetric[] = Array.from(contentMap.values())
    .map((entry) => {
      const totalInterestSignals = entry.waClicks + entry.externalClicks + entry.leadSubmits;
      const totalActivity = entry.pageViews + totalInterestSignals;
      return {
        contentKind: entry.contentKind,
        contentKindLabel: INSIGHT_CONTENT_KIND_LABELS_ID[entry.contentKind],
        contentId: entry.contentId,
        path: entry.path,
        title: resolveFriendlyTitle(entry.contentKind, entry.contentId, entry.path, params.titles),
        pageViews: entry.pageViews,
        waClicks: entry.waClicks,
        externalClicks: entry.externalClicks,
        leadSubmits: entry.leadSubmits,
        totalInterestSignals,
        totalActivity,
      };
    })
    .sort((a, b) => {
      if (b.totalActivity !== a.totalActivity) return b.totalActivity - a.totalActivity;
      if (b.totalInterestSignals !== a.totalInterestSignals) {
        return b.totalInterestSignals - a.totalInterestSignals;
      }
      if (b.pageViews !== a.pageViews) return b.pageViews - a.pageViews;
      return a.path.localeCompare(b.path);
    });

  const popularItems = allPopularItems.slice(0, popularItemsLimit);
  const popularByKind = {
    pages: allPopularItems.filter((i) => i.contentKind === "page").slice(0, 5),
    posts: allPopularItems.filter((i) => i.contentKind === "post").slice(0, 5),
    offerings: allPopularItems.filter((i) => i.contentKind === "offering").slice(0, 5),
  } as const;

  // 3. Aggregate coarse traffic sources + coarse UTM campaign breakdown
  const sourceAcc = new Map<
    InsightSourceBucket,
    { pageViews: number; waClicks: number; externalClicks: number; leadSubmits: number }
  >();
  for (const bucket of INSIGHT_SOURCE_BUCKETS) {
    sourceAcc.set(bucket, { pageViews: 0, waClicks: 0, externalClicks: 0, leadSubmits: 0 });
  }

  const utmAcc = new Map<
    string,
    { pageViews: number; waClicks: number; externalClicks: number; leadSubmits: number }
  >();

  let totalSourceActivity = 0;

  for (const row of params.sourceRows) {
    if (!row.day_utc || row.day_utc < startDay || row.day_utc > endDay) continue;
    const acc = sourceAcc.get(row.source_bucket);
    if (!acc) continue;
    const pv = toSafeCount(row.page_views);
    const wa = toSafeCount(row.wa_clicks);
    const ext = toSafeCount(row.external_clicks);
    const leads = toSafeCount(row.lead_submits);
    const act = pv + wa + ext + leads;
    if (act === 0) continue;

    acc.pageViews += pv;
    acc.waClicks += wa;
    acc.externalClicks += ext;
    acc.leadSubmits += leads;
    totalSourceActivity += act;

    const utm = (row.utm_source ?? "").trim();
    if (utm.length > 0) {
      const u = utmAcc.get(utm) ?? {
        pageViews: 0,
        waClicks: 0,
        externalClicks: 0,
        leadSubmits: 0,
      };
      u.pageViews += pv;
      u.waClicks += wa;
      u.externalClicks += ext;
      u.leadSubmits += leads;
      utmAcc.set(utm, u);
    }
  }

  const sources: TrafficSourceMetric[] = INSIGHT_SOURCE_BUCKETS.map((bucket) => {
    const acc = sourceAcc.get(bucket)!;
    const totalActivity = acc.pageViews + acc.waClicks + acc.externalClicks + acc.leadSubmits;
    const sharePercent =
      totalSourceActivity > 0 ? Math.round((totalActivity / totalSourceActivity) * 1000) / 10 : 0;
    return {
      bucket,
      label: INSIGHT_SOURCE_LABELS_ID[bucket],
      pageViews: acc.pageViews,
      waClicks: acc.waClicks,
      externalClicks: acc.externalClicks,
      leadSubmits: acc.leadSubmits,
      totalActivity,
      sharePercent,
    };
  });

  const utmCampaigns: UtmCampaignMetric[] = Array.from(utmAcc.entries())
    .map(([utmSource, acc]) => ({
      utmSource,
      pageViews: acc.pageViews,
      waClicks: acc.waClicks,
      externalClicks: acc.externalClicks,
      leadSubmits: acc.leadSubmits,
      totalActivity: acc.pageViews + acc.waClicks + acc.externalClicks + acc.leadSubmits,
    }))
    .sort((a, b) => {
      if (b.totalActivity !== a.totalActivity) return b.totalActivity - a.totalActivity;
      return a.utmSource.localeCompare(b.utmSource);
    })
    .slice(0, 10);

  const totalInterestSignals = totalWaClicks + totalExternalClicks + totalLeadSubmits;
  const totalActivity = totalPageViews + totalInterestSignals;
  const hasAnyData =
    totalActivity > 0 || totalSourceActivity > 0 || peakHours.maxHourlyActivity > 0;

  return {
    days,
    startDay,
    endDay,
    timeZone,
    timeZoneLabel: peakHours.timeZoneLabel,
    estimateLabel: INSIGHTS_ESTIMATE_LABEL_ID,
    totals: {
      pageViews: totalPageViews,
      waClicks: totalWaClicks,
      externalClicks: totalExternalClicks,
      leadSubmits: totalLeadSubmits,
      totalInterestSignals,
      totalActivity,
    },
    popularItems,
    popularByKind,
    sources,
    utmCampaigns,
    peakHours,
    hasAnyData,
  };
}

/**
 * Deterministic empty insights summary for zero-data states.
 */
export function createEmptyInsightsSummary(
  options?: GetTenantInsightsSummaryOptions,
): TenantInsightsSummary {
  return aggregateInsightsRows({
    contentRows: [],
    sourceRows: [],
    hourlyRows: [],
    days: options?.days,
    nowMs: options?.nowMs,
    timeZone: options?.timeZone,
    popularItemsLimit: options?.popularItemsLimit,
  });
}

/**
 * Reads the tenant's live configured IANA timezone from `site_settings.timezone`,
 * falling back cleanly to `Asia/Jakarta`.
 */
export async function getTenantConfiguredTimezone(tenantDb: D1Database): Promise<string> {
  try {
    const row = await tenantDb
      .prepare("SELECT timezone FROM site_settings WHERE id = 1 LIMIT 1")
      .first<{ timezone: string | null }>();
    return normalizeInsightsTimeZone(row?.timezone);
  } catch {
    return DEFAULT_ANALYTICS_TIMEZONE;
  }
}

async function loadContentTitleLookup(tenantDb: D1Database): Promise<ContentTitleLookup> {
  const pagesById = new Map<number, string>();
  const postsById = new Map<number, string>();
  const offeringsById = new Map<number, string>();
  const pagesBySlug = new Map<string, string>();
  const postsBySlug = new Map<string, string>();
  const offeringsBySlug = new Map<string, string>();

  try {
    const [pagesRes, postsRes, offeringsRes] = await Promise.all([
      tenantDb
        .prepare("SELECT id, slug, title FROM pages WHERE deleted_at IS NULL LIMIT 200")
        .all<{ id: number; slug: string; title: string }>(),
      tenantDb
        .prepare("SELECT id, slug, title FROM posts WHERE deleted_at IS NULL LIMIT 200")
        .all<{ id: number; slug: string; title: string }>(),
      tenantDb
        .prepare("SELECT id, slug, title FROM offerings WHERE deleted_at IS NULL LIMIT 200")
        .all<{ id: number; slug: string; title: string }>(),
    ]);
    for (const r of pagesRes.results ?? []) {
      pagesById.set(r.id, r.title);
      pagesBySlug.set(r.slug, r.title);
    }
    for (const r of postsRes.results ?? []) {
      postsById.set(r.id, r.title);
      postsBySlug.set(r.slug, r.title);
    }
    for (const r of offeringsRes.results ?? []) {
      offeringsById.set(r.id, r.title);
      offeringsBySlug.set(r.slug, r.title);
    }
  } catch {
    // Graceful degradation if content tables are not yet seeded
  }

  return {
    pagesById,
    postsById,
    offeringsById,
    pagesBySlug,
    postsBySlug,
    offeringsBySlug,
  };
}

/**
 * Queries the tenant's isolated `TenantStore` for first-party insights:
 * popular items, coarse traffic sources (plus UTM campaigns), and peak hours dynamically
 * projected to `site_settings.timezone` (or explicit `options.timeZone`).
 *
 * Gracefully degrades to `analytics_daily` + `analytics_hourly_sources` if `0022_insights_aggregates`
 * has not yet been applied on an older tenant DO.
 */
export async function getTenantInsightsSummary(
  tenantDb: D1Database,
  options?: GetTenantInsightsSummaryOptions,
): Promise<TenantInsightsSummary> {
  const days: 7 | 30 = options?.days === 30 ? 30 : 7;
  const nowMs = Math.floor(options?.nowMs ?? Date.now());
  const timeZone = options?.timeZone
    ? normalizeInsightsTimeZone(options.timeZone)
    : await getTenantConfiguredTimezone(tenantDb);

  const { startDay, endDay, queryStartDayUtc, queryEndDayUtc } = buildLocalWindow(
    days,
    nowMs,
    timeZone,
  );

  const tableCheck = await tenantDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_content_daily' LIMIT 1",
    )
    .first<{ name: string }>();

  const titles = await loadContentTitleLookup(tenantDb);

  if (tableCheck?.name === "analytics_content_daily") {
    const [contentRes, sourcesRes, hourlyRes] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits
           FROM analytics_content_daily
           WHERE day_utc >= ? AND day_utc <= ?`,
        )
        .bind(startDay, endDay)
        .all<AnalyticsContentDailyRow>(),
      tenantDb
        .prepare(
          `SELECT day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits
           FROM analytics_sources_daily
           WHERE day_utc >= ? AND day_utc <= ?`,
        )
        .bind(startDay, endDay)
        .all<AnalyticsSourcesDailyRow>(),
      tenantDb
        .prepare(
          `SELECT day_utc, utc_hour, page_views, wa_clicks, external_clicks, lead_submits
           FROM analytics_hourly_utc
           WHERE day_utc >= ? AND day_utc <= ?`,
        )
        .bind(queryStartDayUtc, queryEndDayUtc)
        .all<StoredUtcHourRow>(),
    ]);

    return aggregateInsightsRows({
      contentRows: contentRes.results ?? [],
      sourceRows: sourcesRes.results ?? [],
      hourlyRows: hourlyRes.results ?? [],
      days,
      nowMs,
      timeZone,
      popularItemsLimit: options?.popularItemsLimit,
      titles,
    });
  }

  // Graceful fallback on pre-0022 TenantStore DOs using 0001 `analytics_daily` + `analytics_hourly_sources`
  const [dailyRes, legacySourcesRes] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT day, path, pageviews, unique_visitors, wa_clicks, external_clicks, lead_submits
         FROM analytics_daily
         WHERE day >= ? AND day <= ?`,
      )
      .bind(startDay, endDay)
      .all<AnalyticsDailyRow>(),
    tenantDb
      .prepare(
        `SELECT hour_bucket, source_bucket, utm_source, visits
         FROM analytics_hourly_sources
         WHERE substr(hour_bucket, 1, 10) >= ? AND substr(hour_bucket, 1, 10) <= ?`,
      )
      .bind(queryStartDayUtc, queryEndDayUtc)
      .all<{ hour_bucket: string; source_bucket: string; utm_source: string; visits: number }>(),
  ]);

  const fallbackContentRows: AnalyticsContentDailyRow[] = (dailyRes.results ?? []).map((r) => ({
    day_utc: r.day,
    content_kind: inferInsightContentKind({ path: r.path }),
    content_id: 0,
    path: r.path,
    page_views: r.pageviews,
    wa_clicks: r.wa_clicks,
    external_clicks: r.external_clicks,
    lead_submits: r.lead_submits,
  }));

  const fallbackSourceRows: AnalyticsSourcesDailyRow[] = [];
  const fallbackHourlyRows: StoredUtcHourRow[] = [];

  for (const row of legacySourcesRes.results ?? []) {
    const dayUtc = row.hour_bucket.slice(0, 10);
    const hourNum = Number(row.hour_bucket.slice(11, 13));
    const bucket: InsightSourceBucket =
      row.source_bucket === "organic_search"
        ? "search"
        : row.source_bucket === "social" ||
            row.source_bucket === "campaign" ||
            row.source_bucket === "ai_assistant" ||
            row.source_bucket === "referral" ||
            row.source_bucket === "direct"
          ? row.source_bucket
          : "direct";

    fallbackSourceRows.push({
      day_utc: dayUtc,
      source_bucket: bucket,
      utm_source: row.utm_source,
      page_views: row.visits,
      wa_clicks: 0,
      external_clicks: 0,
      lead_submits: 0,
    });

    if (Number.isInteger(hourNum) && hourNum >= 0 && hourNum <= 23) {
      fallbackHourlyRows.push({
        day_utc: dayUtc,
        utc_hour: hourNum,
        page_views: row.visits,
        wa_clicks: 0,
        external_clicks: 0,
        lead_submits: 0,
      });
    }
  }

  return aggregateInsightsRows({
    contentRows: fallbackContentRows,
    sourceRows: fallbackSourceRows,
    hourlyRows: fallbackHourlyRows,
    days,
    nowMs,
    timeZone,
    popularItemsLimit: options?.popularItemsLimit,
    titles,
  });
}
