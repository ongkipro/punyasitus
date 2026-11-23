import { inferInsightContentKind } from "@punyasitus/core/analytics/insights";
import {
  buildMonthlyPerformanceReportSummary,
  parseReportMonthPeriod,
  type MonthlyActivityThreshold,
  type MonthlyContentAggregateRow,
  type MonthlyOfferingTitleLookup,
  type MonthlyPerformanceReportSummary,
  type MonthlySourceAggregateRow,
} from "@punyasitus/core/reports/index";

/**
 * TenantStore Monthly Insights Aggregate Loader (`REQ-110`, `TASK-110`).
 *
 * Privacy invariant:
 * - Reads ONLY anonymized aggregate tables (`analytics_content_daily`, `analytics_sources_daily`,
 *   or legacy fallback `analytics_daily` + `analytics_hourly_sources`) and public `offerings` titles.
 * - NEVER reads `leads`, visitor names, emails, phones, messages, IP addresses, or User-Agents.
 */

export interface LoadTenantMonthlyReportOptions {
  readonly reportMonth: string;
  readonly timeZone?: string;
  readonly threshold?: MonthlyActivityThreshold;
}

async function loadOfferingTitleLookup(tenantDb: D1Database): Promise<MonthlyOfferingTitleLookup> {
  const byId = new Map<number, string>();
  const bySlug = new Map<string, string>();
  try {
    const res = await tenantDb
      .prepare("SELECT id, slug, title FROM offerings WHERE deleted_at IS NULL LIMIT 200")
      .all<{ readonly id: number; readonly slug: string; readonly title: string }>();
    for (const row of res.results ?? []) {
      if (typeof row.id === "number" && row.title) {
        byId.set(row.id, row.title);
      }
      if (row.slug && row.title) {
        bySlug.set(row.slug, row.title);
      }
    }
  } catch {
    // Graceful degradation if offerings table is unavailable
  }
  return { byId, bySlug };
}

export async function loadTenantMonthlyReportSummary(
  tenantDb: D1Database,
  options: LoadTenantMonthlyReportOptions,
): Promise<MonthlyPerformanceReportSummary> {
  const period = parseReportMonthPeriod(options.reportMonth, options.timeZone);
  const queryStartDay = period.comparisonStartDay;
  const queryEndDay = period.endDay;

  const [tableCheck, offeringTitles] = await Promise.all([
    tenantDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_content_daily' LIMIT 1",
      )
      .first<{ readonly name: string }>(),
    loadOfferingTitleLookup(tenantDb),
  ]);

  if (tableCheck?.name === "analytics_content_daily") {
    const [contentRes, sourceRes] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT day_utc, content_kind, content_id, path, page_views, wa_clicks, external_clicks, lead_submits
           FROM analytics_content_daily
           WHERE day_utc >= ? AND day_utc <= ?`,
        )
        .bind(queryStartDay, queryEndDay)
        .all<MonthlyContentAggregateRow>(),
      tenantDb
        .prepare(
          `SELECT day_utc, source_bucket, utm_source, page_views, wa_clicks, external_clicks, lead_submits
           FROM analytics_sources_daily
           WHERE day_utc >= ? AND day_utc <= ?`,
        )
        .bind(queryStartDay, queryEndDay)
        .all<MonthlySourceAggregateRow>(),
    ]);

    return buildMonthlyPerformanceReportSummary({
      reportMonth: period.reportMonth,
      timeZone: period.timeZone,
      contentRows: contentRes.results ?? [],
      sourceRows: sourceRes.results ?? [],
      offeringTitles,
      threshold: options.threshold,
    });
  }

  // Graceful fallback for pre-0022 TenantStore DOs using `analytics_daily` + `analytics_hourly_sources`
  const [dailyRes, legacySourcesRes] = await Promise.all([
    tenantDb
      .prepare(
        `SELECT day, path, pageviews, wa_clicks, external_clicks, lead_submits
         FROM analytics_daily
         WHERE day >= ? AND day <= ?`,
      )
      .bind(queryStartDay, queryEndDay)
      .all<{
        readonly day: string;
        readonly path: string;
        readonly pageviews: number;
        readonly wa_clicks: number;
        readonly external_clicks: number;
        readonly lead_submits: number;
      }>(),
    tenantDb
      .prepare(
        `SELECT hour_bucket, source_bucket, utm_source, visits
         FROM analytics_hourly_sources
         WHERE substr(hour_bucket, 1, 10) >= ? AND substr(hour_bucket, 1, 10) <= ?`,
      )
      .bind(queryStartDay, queryEndDay)
      .all<{
        readonly hour_bucket: string;
        readonly source_bucket: string;
        readonly utm_source: string;
        readonly visits: number;
      }>(),
  ]);

  const fallbackContentRows: MonthlyContentAggregateRow[] = (dailyRes.results ?? []).map((r) => ({
    day_utc: r.day,
    content_kind: inferInsightContentKind({ path: r.path }),
    content_id: 0,
    path: r.path,
    page_views: r.pageviews,
    wa_clicks: r.wa_clicks,
    external_clicks: r.external_clicks,
    lead_submits: r.lead_submits,
  }));

  const fallbackSourceRows: MonthlySourceAggregateRow[] = (legacySourcesRes.results ?? []).map(
    (r) => ({
      day_utc: r.hour_bucket.slice(0, 10),
      source_bucket: r.source_bucket === "organic_search" ? "search" : r.source_bucket,
      utm_source: r.utm_source,
      page_views: r.visits,
      wa_clicks: 0,
      external_clicks: 0,
      lead_submits: 0,
    }),
  );

  return buildMonthlyPerformanceReportSummary({
    reportMonth: period.reportMonth,
    timeZone: period.timeZone,
    contentRows: fallbackContentRows,
    sourceRows: fallbackSourceRows,
    offeringTitles,
    threshold: options.threshold,
  });
}
