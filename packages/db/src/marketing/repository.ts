import {
  BILLING_CURRENCY,
  DEFAULT_MONTHLY_PRICE_IDR,
  DEFAULT_YEARLY_PRICE_IDR,
  MAX_IDR_AMOUNT,
  MIN_AUTOLARIS_CHARGE_IDR,
  NO_REFUND_NOTICE,
  NON_PKP_TAX_NOTICE,
  PLATFORM_BILLING_SETTING_KEYS,
} from "@punyasitus/core/billing/constants";
import {
  computeConversionRatePct,
  DEFAULT_MARKETING_CONTACT,
  DEFAULT_TRIAL_DAYS,
  DEMO_THEME_SLUGS,
  formatUtcDay,
  FUNNEL_STAGE_DESCRIPTIONS,
  FUNNEL_STAGE_LABELS,
  FUNNEL_STAGES,
  getDemoTenantBySlug,
  parseFunnelRangeDays,
  parseFunnelStage,
  sanitizeSourceChannel,
  sanitizeThemeSlug,
  type DemoThemeSlug,
  type FunnelRangeDays,
  type FunnelSourceChannel,
  type FunnelStage,
} from "@punyasitus/core/marketing/index";
import { PLATFORM_CONSOLE_SETTINGS_KEY } from "../platform/settings.ts";

/**
 * Platform Marketing DB repository (REQ-087, PLAN §19.5, TASK-087):
 * - `loadLiveMarketingPricing`: reads live IDR monthly/yearly pricing, trial days, and
 *   public contact metadata directly from `PLATFORM_DB.platform_settings` (zero deploy lag).
 * - `recordFunnelEvent`: atomic cookieless counter upsert in `marketing_funnel_daily` (zero PII).
 * - `getFunnelSummary`: range-filtered stage totals, step-to-step conversion %, source breakdown,
 *   and per-theme demo interest for `console.punyasitus.com/funnel`.
 */

export const MARKETING_TRIAL_DAYS_SETTING_KEY = "marketing.trial_days" as const;

export interface LiveMarketingPricing {
  readonly monthlyPriceIdr: number;
  readonly yearlyPriceIdr: number;
  readonly yearlySavingsIdr: number;
  readonly yearlyEffectiveMonthlyIdr: number;
  readonly trialDays: number;
  readonly currency: typeof BILLING_CURRENCY;
  readonly nonPkpDisclosure: string;
  readonly noRefundDisclosure: string;
  readonly salesWhatsapp: string;
  readonly supportEmail: string;
  readonly supportHours: string;
  readonly supportResponseTarget: string;
  readonly source: "platform_settings" | "default";
}

export interface RecordFunnelEventInput {
  readonly stage: FunnelStage;
  readonly sourceChannel?: string | null;
  readonly themeSlug?: string | null;
  readonly nowMs?: number;
}

export interface RecordFunnelEventResult {
  readonly dayUtc: string;
  readonly stage: FunnelStage;
  readonly sourceChannel: FunnelSourceChannel;
  readonly themeSlug: DemoThemeSlug | "";
  readonly updatedAt: number;
}

export interface FunnelStageSummaryRow {
  readonly stage: FunnelStage;
  readonly label: string;
  readonly description: string;
  readonly count: number;
  readonly stepConversionPct: number | null;
  readonly overallConversionPct: number;
}

export interface FunnelThemeInterestRow {
  readonly themeSlug: DemoThemeSlug;
  readonly themeName: string;
  readonly businessName: string;
  readonly demoViews: number;
  readonly signupStarts: number;
  readonly totalEvents: number;
  readonly sharePct: number;
}

export interface FunnelSourceRow {
  readonly sourceChannel: string;
  readonly totalEvents: number;
  readonly sharePct: number;
}

export interface FunnelSummaryReport {
  readonly rangeDays: FunnelRangeDays;
  readonly startDayUtc: string;
  readonly endDayUtc: string;
  readonly totalEvents: number;
  readonly visitToFirstPaymentPct: number;
  readonly stages: readonly FunnelStageSummaryRow[];
  readonly themes: readonly FunnelThemeInterestRow[];
  readonly sources: readonly FunnelSourceRow[];
}

interface SettingRow {
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: number;
}

function tryParsePrice(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return null;
  if (raw < MIN_AUTOLARIS_CHARGE_IDR || raw > MAX_IDR_AMOUNT) return null;
  return raw;
}

function tryParseTrialDays(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return null;
  if (raw < 1 || raw > 60) return null;
  return raw;
}

function buildDefaultMarketingPricing(): LiveMarketingPricing {
  const monthlyPriceIdr = DEFAULT_MONTHLY_PRICE_IDR;
  const yearlyPriceIdr = DEFAULT_YEARLY_PRICE_IDR;
  return {
    monthlyPriceIdr,
    yearlyPriceIdr,
    yearlySavingsIdr: Math.max(0, monthlyPriceIdr * 12 - yearlyPriceIdr),
    yearlyEffectiveMonthlyIdr: Math.round(yearlyPriceIdr / 12),
    trialDays: DEFAULT_TRIAL_DAYS,
    currency: BILLING_CURRENCY,
    nonPkpDisclosure: NON_PKP_TAX_NOTICE,
    noRefundDisclosure: NO_REFUND_NOTICE,
    salesWhatsapp: DEFAULT_MARKETING_CONTACT.salesWhatsapp,
    supportEmail: DEFAULT_MARKETING_CONTACT.supportEmail,
    supportHours: DEFAULT_MARKETING_CONTACT.supportHours,
    supportResponseTarget: DEFAULT_MARKETING_CONTACT.supportResponseTarget,
    source: "default",
  };
}

/**
 * Loads live marketing pricing & sales contact directly from `PLATFORM_DB.platform_settings`.
 * Supports updates via `console.punyasitus.com/settings` (`platform.public_settings` & mirrored
 * `billing.pricing`) as well as direct `billing.monthly_price_idr` / `billing.yearly_price_idr`
 * keys, ordered by `updated_at ASC` so the latest saved value always takes effect immediately.
 */
export async function loadLiveMarketingPricing(
  platformDb: D1Database | null | undefined,
): Promise<LiveMarketingPricing> {
  if (!platformDb) {
    return buildDefaultMarketingPricing();
  }

  let rows: readonly SettingRow[];
  try {
    const queryResult = await platformDb
      .prepare(
        `SELECT key, value_json, updated_at
         FROM platform_settings
         WHERE key IN (?, ?, ?, ?, ?)
         ORDER BY updated_at ASC, key ASC`,
      )
      .bind(
        PLATFORM_CONSOLE_SETTINGS_KEY,
        PLATFORM_BILLING_SETTING_KEYS.pricing,
        PLATFORM_BILLING_SETTING_KEYS.monthlyPriceIdr,
        PLATFORM_BILLING_SETTING_KEYS.yearlyPriceIdr,
        MARKETING_TRIAL_DAYS_SETTING_KEY,
      )
      .all<SettingRow>();
    rows = queryResult.results ?? [];
  } catch {
    return buildDefaultMarketingPricing();
  }

  let monthlyPriceIdr: number | null = null;
  let yearlyPriceIdr: number | null = null;
  let trialDays: number | null = null;
  let salesWhatsapp: string = DEFAULT_MARKETING_CONTACT.salesWhatsapp;
  let supportEmail: string = DEFAULT_MARKETING_CONTACT.supportEmail;
  let supportHours: string = DEFAULT_MARKETING_CONTACT.supportHours;
  let supportResponseTarget: string = DEFAULT_MARKETING_CONTACT.supportResponseTarget;

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      continue;
    }

    if (row.key === PLATFORM_CONSOLE_SETTINGS_KEY && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      monthlyPriceIdr = tryParsePrice(obj.monthlyPriceIdr) ?? monthlyPriceIdr;
      yearlyPriceIdr = tryParsePrice(obj.yearlyPriceIdr) ?? yearlyPriceIdr;
      trialDays = tryParseTrialDays(obj.trialDays) ?? trialDays;
      if (typeof obj.salesWhatsapp === "string" && obj.salesWhatsapp.trim().length > 0) {
        salesWhatsapp = obj.salesWhatsapp.trim();
      }
      if (typeof obj.supportEmail === "string" && obj.supportEmail.trim().length > 0) {
        supportEmail = obj.supportEmail.trim();
      }
      if (typeof obj.supportHours === "string" && obj.supportHours.trim().length > 0) {
        supportHours = obj.supportHours.trim();
      }
      if (typeof obj.supportResponseTarget === "string" && obj.supportResponseTarget.trim().length > 0) {
        supportResponseTarget = obj.supportResponseTarget.trim();
      }
    } else if (
      row.key === PLATFORM_BILLING_SETTING_KEYS.pricing &&
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const obj = parsed as Record<string, unknown>;
      monthlyPriceIdr = tryParsePrice(obj.monthlyPriceIdr) ?? monthlyPriceIdr;
      yearlyPriceIdr = tryParsePrice(obj.yearlyPriceIdr) ?? yearlyPriceIdr;
    } else if (row.key === PLATFORM_BILLING_SETTING_KEYS.monthlyPriceIdr) {
      monthlyPriceIdr = tryParsePrice(parsed) ?? monthlyPriceIdr;
    } else if (row.key === PLATFORM_BILLING_SETTING_KEYS.yearlyPriceIdr) {
      yearlyPriceIdr = tryParsePrice(parsed) ?? yearlyPriceIdr;
    } else if (row.key === MARKETING_TRIAL_DAYS_SETTING_KEY) {
      trialDays = tryParseTrialDays(parsed) ?? trialDays;
    }
  }

  const resolvedMonthly = monthlyPriceIdr ?? DEFAULT_MONTHLY_PRICE_IDR;
  const resolvedYearly = yearlyPriceIdr ?? DEFAULT_YEARLY_PRICE_IDR;
  const source: "platform_settings" | "default" =
    monthlyPriceIdr !== null || yearlyPriceIdr !== null || trialDays !== null
      ? "platform_settings"
      : "default";

  return {
    monthlyPriceIdr: resolvedMonthly,
    yearlyPriceIdr: resolvedYearly,
    yearlySavingsIdr: Math.max(0, resolvedMonthly * 12 - resolvedYearly),
    yearlyEffectiveMonthlyIdr: Math.round(resolvedYearly / 12),
    trialDays: trialDays ?? DEFAULT_TRIAL_DAYS,
    currency: BILLING_CURRENCY,
    nonPkpDisclosure: NON_PKP_TAX_NOTICE,
    noRefundDisclosure: NO_REFUND_NOTICE,
    salesWhatsapp,
    supportEmail,
    supportHours,
    supportResponseTarget,
    source,
  };
}

/**
 * Atomically increments a cookieless daily funnel counter in `marketing_funnel_daily`.
 * Enforces strict stage allowlist, closed source-channel bucket, allowlisted theme slug,
 * server-derived `dayUtc`, zero runtime DDL, and zero PII.
 */
export async function recordFunnelEvent(
  platformDb: D1Database,
  input: RecordFunnelEventInput,
): Promise<RecordFunnelEventResult> {
  const stage = parseFunnelStage(input.stage);
  if (!stage) {
    throw new Error(`Invalid funnel stage: ${String(input.stage)}`);
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const dayUtc = formatUtcDay(nowMs);
  const sourceChannel = sanitizeSourceChannel(input.sourceChannel);
  const themeSlug = sanitizeThemeSlug(input.themeSlug);

  await platformDb
    .prepare(
      `INSERT INTO marketing_funnel_daily (day_utc, stage, source_channel, theme_slug, count, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(day_utc, stage, source_channel, theme_slug)
       DO UPDATE SET
         count = marketing_funnel_daily.count + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(dayUtc, stage, sourceChannel, themeSlug, nowMs)
    .run();

  return {
    dayUtc,
    stage,
    sourceChannel,
    themeSlug,
    updatedAt: nowMs,
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Computes cookieless funnel stage counts, step-to-step conversion %, per-theme demo interest,
 * and source channel totals for the requested trailing UTC day window (`7`, `30`, or `90` days).
 * Runs read-only queries against migrated `marketing_funnel_daily` with zero runtime DDL.
 */
export async function getFunnelSummary(
  platformDb: D1Database,
  rawRangeDays: number = 30,
  options?: { readonly nowMs?: number },
): Promise<FunnelSummaryReport> {
  const rangeDays = parseFunnelRangeDays(rawRangeDays);
  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const endDayUtc = formatUtcDay(nowMs);
  const startDayUtc = formatUtcDay(nowMs - (rangeDays - 1) * ONE_DAY_MS);

  const [stageResult, themeResult, sourceResult] = await Promise.all([
    platformDb
      .prepare(
        `SELECT stage, SUM(count) AS total
         FROM marketing_funnel_daily
         WHERE day_utc >= ? AND day_utc <= ?
         GROUP BY stage`,
      )
      .bind(startDayUtc, endDayUtc)
      .all<{ readonly stage: FunnelStage; readonly total: number }>(),
    platformDb
      .prepare(
        `SELECT theme_slug, stage, SUM(count) AS total
         FROM marketing_funnel_daily
         WHERE day_utc >= ? AND day_utc <= ? AND theme_slug != ''
         GROUP BY theme_slug, stage`,
      )
      .bind(startDayUtc, endDayUtc)
      .all<{ readonly theme_slug: string; readonly stage: FunnelStage; readonly total: number }>(),
    platformDb
      .prepare(
        `SELECT source_channel, SUM(count) AS total
         FROM marketing_funnel_daily
         WHERE day_utc >= ? AND day_utc <= ?
         GROUP BY source_channel
         ORDER BY total DESC, source_channel ASC
         LIMIT 12`,
      )
      .bind(startDayUtc, endDayUtc)
      .all<{ readonly source_channel: string; readonly total: number }>(),
  ]);

  const stageCounts = new Map<FunnelStage, number>();
  for (const row of stageResult.results ?? []) {
    stageCounts.set(row.stage, Number(row.total ?? 0));
  }

  const visitCount = stageCounts.get("visit") ?? 0;
  const firstPaymentCount = stageCounts.get("first_payment") ?? 0;

  let prevCount = 0;
  let totalEvents = 0;
  const stages: FunnelStageSummaryRow[] = FUNNEL_STAGES.map((stage, index) => {
    const count = stageCounts.get(stage) ?? 0;
    totalEvents += count;
    const stepConversionPct = index === 0 ? null : computeConversionRatePct(count, prevCount);
    const overallConversionPct =
      index === 0 ? (count > 0 ? 100 : 0) : computeConversionRatePct(count, visitCount);
    prevCount = count;
    return {
      stage,
      label: FUNNEL_STAGE_LABELS[stage],
      description: FUNNEL_STAGE_DESCRIPTIONS[stage],
      count,
      stepConversionPct,
      overallConversionPct,
    };
  });

  const themeBuckets = new Map<
    DemoThemeSlug,
    { demoViews: number; signupStarts: number; totalEvents: number }
  >();
  for (const slug of DEMO_THEME_SLUGS) {
    themeBuckets.set(slug, { demoViews: 0, signupStarts: 0, totalEvents: 0 });
  }

  let totalThemeDemoViews = 0;
  for (const row of themeResult.results ?? []) {
    const slug = sanitizeThemeSlug(row.theme_slug);
    if (!slug) continue;
    const bucket = themeBuckets.get(slug);
    if (!bucket) continue;
    const n = Number(row.total ?? 0);
    bucket.totalEvents += n;
    if (row.stage === "demo_view") {
      bucket.demoViews += n;
      totalThemeDemoViews += n;
    } else if (row.stage === "signup_start") {
      bucket.signupStarts += n;
    }
  }

  const themes: FunnelThemeInterestRow[] = DEMO_THEME_SLUGS.map((slug) => {
    const bucket = themeBuckets.get(slug) ?? { demoViews: 0, signupStarts: 0, totalEvents: 0 };
    const fixture = getDemoTenantBySlug(slug);
    return {
      themeSlug: slug,
      themeName: fixture?.themeName ?? slug,
      businessName: fixture?.businessName ?? slug,
      demoViews: bucket.demoViews,
      signupStarts: bucket.signupStarts,
      totalEvents: bucket.totalEvents,
      sharePct: computeConversionRatePct(bucket.demoViews, totalThemeDemoViews),
    };
  }).sort((a, b) => b.demoViews - a.demoViews || b.totalEvents - a.totalEvents);

  const sources: FunnelSourceRow[] = (sourceResult.results ?? []).map((row) => {
    const count = Number(row.total ?? 0);
    return {
      sourceChannel: row.source_channel,
      totalEvents: count,
      sharePct: computeConversionRatePct(count, totalEvents),
    };
  });

  return {
    rangeDays,
    startDayUtc,
    endDayUtc,
    totalEvents,
    visitToFirstPaymentPct: computeConversionRatePct(firstPaymentCount, visitCount),
    stages,
    themes,
    sources,
  };
}
