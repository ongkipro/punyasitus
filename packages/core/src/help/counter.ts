import { formatUtcDay } from "../marketing/funnel.ts";
import { HELP_SLUG_RE } from "./markdown.ts";

/**
 * Privacy-preserving Help Center article open counters (REQ-104, TASK-104).
 *
 * Reuses the already-migrated `marketing_funnel_events` table in `PLATFORM_DB`
 * (`0001_initial_platform.sql`) with ZERO runtime DDL, ZERO cookies, ZERO IP/UA storage,
 * ZERO personal data, and bounded cardinality (strictly allowlisted existing article slugs
 * + closed 3-value `source` bucket).
 */

export const HELP_OPEN_EVENT_NAME = "help_article_open" as const;

export const HELP_OPEN_SOURCES = ["direct", "marketing", "dashboard"] as const;
export type HelpOpenSource = (typeof HELP_OPEN_SOURCES)[number];

export interface HelpCounterStatementLike {
  bind(...values: unknown[]): {
    run(): Promise<unknown>;
    all<T = Record<string, unknown>>(): Promise<{ readonly results?: readonly T[] }>;
  };
}

export interface HelpCounterDbLike {
  prepare(query: string): HelpCounterStatementLike;
}

export function sanitizeHelpOpenSource(raw: unknown): HelpOpenSource {
  if (typeof raw !== "string") return "direct";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "dashboard") return "dashboard";
  if (normalized === "marketing") return "marketing";
  return "direct";
}

export function buildHelpOpenEventId(
  dayUtc: string,
  slug: string,
  source: HelpOpenSource,
): string {
  return `help_open:${dayUtc}:${slug}:${source}`;
}

export interface RecordHelpArticleOpenInput {
  readonly slug: string;
  readonly validSlugs: ReadonlySet<string>;
  readonly source?: string | null;
  readonly nowMs?: number;
}

export type RecordHelpArticleOpenResult =
  | {
      readonly recorded: true;
      readonly id: string;
      readonly dayUtc: string;
      readonly slug: string;
      readonly source: HelpOpenSource;
      readonly updatedAt: number;
    }
  | {
      readonly recorded: false;
      readonly reason: "db_unavailable" | "invalid_slug" | "unknown_slug";
    };

/**
 * Atomically increments a daily cookieless open count for a validated help article slug.
 * Stores ONLY `(id, day, event_name='help_article_open', utm_source=source, utm_medium=NULL, utm_campaign=slug, count, updated_at)`.
 */
export async function recordHelpArticleOpen(
  platformDb: HelpCounterDbLike | null | undefined,
  input: RecordHelpArticleOpenInput,
): Promise<RecordHelpArticleOpenResult> {
  if (!platformDb) {
    return { recorded: false, reason: "db_unavailable" };
  }

  const slug = input.slug.trim().toLowerCase();
  if (!HELP_SLUG_RE.test(slug)) {
    return { recorded: false, reason: "invalid_slug" };
  }
  if (!input.validSlugs.has(slug)) {
    return { recorded: false, reason: "unknown_slug" };
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const dayUtc = formatUtcDay(nowMs);
  const source = sanitizeHelpOpenSource(input.source);
  const id = buildHelpOpenEventId(dayUtc, slug, source);

  await platformDb
    .prepare(
      `INSERT INTO marketing_funnel_events (
         id, day, event_name, utm_source, utm_medium, utm_campaign, count, updated_at
       )
       VALUES (?, ?, ?, ?, NULL, ?, 1, ?)
       ON CONFLICT(id)
       DO UPDATE SET
         count = marketing_funnel_events.count + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(id, dayUtc, HELP_OPEN_EVENT_NAME, source, slug, nowMs)
    .run();

  return {
    recorded: true,
    id,
    dayUtc,
    slug,
    source,
    updatedAt: nowMs,
  };
}

export interface HelpArticleOpenCountRow {
  readonly slug: string;
  readonly totalOpens: number;
  readonly dashboardOpens: number;
  readonly marketingOpens: number;
  readonly directOpens: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregates cookieless article open counts over the trailing `days` UTC window (default 30).
 */
export async function getHelpArticleOpenCounts(
  platformDb: HelpCounterDbLike | null | undefined,
  options?: { readonly days?: number; readonly nowMs?: number },
): Promise<readonly HelpArticleOpenCountRow[]> {
  if (!platformDb) return [];
  const days = Math.min(Math.max(1, Math.trunc(options?.days ?? 30)), 365);
  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const endDayUtc = formatUtcDay(nowMs);
  const startDayUtc = formatUtcDay(nowMs - (days - 1) * ONE_DAY_MS);

  const res = await platformDb
    .prepare(
      `SELECT
         utm_campaign AS slug,
         utm_source AS source,
         SUM(count) AS total
       FROM marketing_funnel_events
       WHERE event_name = ?
         AND day >= ?
         AND day <= ?
         AND utm_campaign IS NOT NULL
       GROUP BY utm_campaign, utm_source`,
    )
    .bind(HELP_OPEN_EVENT_NAME, startDayUtc, endDayUtc)
    .all<{ readonly slug: string; readonly source: string | null; readonly total: number }>();

  const map = new Map<
    string,
    { totalOpens: number; dashboardOpens: number; marketingOpens: number; directOpens: number }
  >();

  for (const row of res.results ?? []) {
    if (!row.slug) continue;
    const count = Number(row.total ?? 0);
    const bucket = map.get(row.slug) ?? {
      totalOpens: 0,
      dashboardOpens: 0,
      marketingOpens: 0,
      directOpens: 0,
    };
    bucket.totalOpens += count;
    if (row.source === "dashboard") {
      bucket.dashboardOpens += count;
    } else if (row.source === "marketing") {
      bucket.marketingOpens += count;
    } else {
      bucket.directOpens += count;
    }
    map.set(row.slug, bucket);
  }

  return Array.from(map.entries())
    .map(([slug, counts]) => ({
      slug,
      ...counts,
    }))
    .sort((a, b) => b.totalOpens - a.totalOpens || a.slug.localeCompare(b.slug));
}
