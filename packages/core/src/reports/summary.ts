import {
  parseReportMonthPeriod,
  type MonthlyReportPeriod,
} from "./period.ts";
import { sanitizeReportDisplayText } from "./pii-guard.ts";

/**
 * Pure Monthly Performance Report Aggregation, Activity Threshold, MoM Delta,
 * and Deterministic Indonesian Actionable Tip Engine (`REQ-110`, `TASK-110`, `PLAN.md` §20.5).
 *
 * Strictly aggregates anonymized daily counters from TASK-072 insights tables
 * (`analytics_content_daily`, `analytics_sources_daily`, or fallback `analytics_daily` +
 * `analytics_hourly_sources`). NEVER reads raw leads or visitor PII.
 */

export interface MonthlyActivityThreshold {
  /** Minimum monthly page visits required when there are 0 leads and 0 WA clicks. */
  readonly minVisits: number;
  /** Minimum monthly leads to qualify even when visits are below `minVisits`. */
  readonly minLeads: number;
  /** Minimum monthly WhatsApp clicks to qualify even when visits are below `minVisits`. */
  readonly minWhatsappClicks: number;
}

/**
 * Default minimum activity threshold for sending a monthly owner performance report.
 * Websites with `< 5` visits AND `0` leads AND `0` WhatsApp clicks are skipped
 * (recorded as `skipped` / `E_BELOW_ACTIVITY_THRESHOLD`) to avoid noisy empty reports.
 */
export const DEFAULT_MONTHLY_REPORT_MIN_ACTIVITY_THRESHOLD: MonthlyActivityThreshold = {
  minVisits: 5,
  minLeads: 1,
  minWhatsappClicks: 1,
} as const;

export interface MonthlyContentAggregateRow {
  readonly day_utc: string;
  readonly content_kind: string;
  readonly content_id: number;
  readonly path: string;
  readonly page_views: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
}

export interface MonthlySourceAggregateRow {
  readonly day_utc: string;
  readonly source_bucket: string;
  readonly utm_source?: string;
  readonly page_views: number;
  readonly wa_clicks: number;
  readonly external_clicks: number;
  readonly lead_submits: number;
}

export interface MonthlyOfferingTitleLookup {
  readonly byId?: ReadonlyMap<number, string>;
  readonly bySlug?: ReadonlyMap<string, string>;
}

export type MonthlyDeltaDirection = "up" | "down" | "flat" | "new";

export interface MonthlyMetricDelta {
  readonly current: number;
  readonly previous: number;
  readonly diff: number;
  readonly percentChange: number | null;
  readonly direction: MonthlyDeltaDirection;
  readonly labelId: string;
}

export interface MonthlyTopOffering {
  readonly title: string;
  readonly path: string;
  readonly visits: number;
  readonly whatsappClicks: number;
  readonly leads: number;
  readonly totalActivity: number;
}

export interface MonthlyPerformanceMetrics {
  readonly visits: number;
  readonly leads: number;
  readonly whatsappClicks: number;
  readonly aiAssistantReferrals: number;
}

export interface MonthlyPerformanceReportSummary {
  readonly period: MonthlyReportPeriod;
  readonly current: MonthlyPerformanceMetrics;
  readonly previous: MonthlyPerformanceMetrics;
  readonly mom: {
    readonly visits: MonthlyMetricDelta;
    readonly leads: MonthlyMetricDelta;
    readonly whatsappClicks: MonthlyMetricDelta;
    readonly aiAssistantReferrals: MonthlyMetricDelta;
  };
  readonly topOffering: MonthlyTopOffering | null;
  readonly actionableTip: string;
  readonly meetsActivityThreshold: boolean;
  readonly threshold: MonthlyActivityThreshold;
}

function toSafeCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function formatIntegerId(n: number): string {
  const safe = Math.trunc(n);
  const abs = Math.abs(safe);
  const formatted = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return safe < 0 ? `-${formatted}` : formatted;
}

function isOfferingPath(path: string): boolean {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const first = clean.split("/")[0] ?? "";
  return first === "layanan" || first === "produk" || first === "tour" || first === "kendaraan";
}

function resolveOfferingTitle(
  contentId: number,
  path: string,
  lookup?: MonthlyOfferingTitleLookup,
): string {
  if (lookup) {
    if (contentId > 0) {
      const byId = lookup.byId?.get(contentId);
      if (byId && byId.trim()) {
        return sanitizeReportDisplayText(byId, 100);
      }
    }
    const clean = path.replace(/^\/+|\/+$/g, "");
    const parts = clean.split("/");
    if (parts[1]) {
      const bySlug = lookup.bySlug?.get(parts[1]);
      if (bySlug && bySlug.trim()) {
        return sanitizeReportDisplayText(bySlug, 100);
      }
    }
  }

  const segments = path.split("/").filter(Boolean);
  const slug = segments[segments.length - 1] ?? "Penawaran Utama";
  const words = slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return sanitizeReportDisplayText(words || "Penawaran Utama", 100);
}

/**
 * Evaluates whether a website's monthly metrics meet the minimum activity threshold.
 */
export function isEligibleForMonthlyReport(
  metrics: Pick<MonthlyPerformanceMetrics, "visits" | "leads" | "whatsappClicks">,
  threshold: MonthlyActivityThreshold = DEFAULT_MONTHLY_REPORT_MIN_ACTIVITY_THRESHOLD,
): boolean {
  return (
    metrics.visits >= threshold.minVisits ||
    metrics.leads >= threshold.minLeads ||
    metrics.whatsappClicks >= threshold.minWhatsappClicks
  );
}

/**
 * Computes a deterministic month-over-month delta with a clear Bahasa Indonesia summary label.
 */
export function computeMonthlyDelta(current: number, previous: number): MonthlyMetricDelta {
  const safeCurrent = toSafeCount(current);
  const safePrevious = toSafeCount(previous);
  const diff = safeCurrent - safePrevious;

  if (safePrevious === 0) {
    if (safeCurrent === 0) {
      return {
        current: 0,
        previous: 0,
        diff: 0,
        percentChange: 0,
        direction: "flat",
        labelId: "Tetap 0 dibanding bulan lalu",
      };
    }
    return {
      current: safeCurrent,
      previous: 0,
      diff,
      percentChange: null,
      direction: "new",
      labelId: `+${formatIntegerId(safeCurrent)} baru (bulan lalu 0)`,
    };
  }

  const rawPct = (diff / safePrevious) * 100;
  const percentChange = Math.round(rawPct * 10) / 10;
  const pctAbs = Math.abs(percentChange);
  const pctStr = Number.isInteger(pctAbs) ? String(pctAbs) : pctAbs.toFixed(1).replace(".", ",");

  if (diff === 0) {
    return {
      current: safeCurrent,
      previous: safePrevious,
      diff: 0,
      percentChange: 0,
      direction: "flat",
      labelId: "Sama seperti bulan lalu (0%)",
    };
  }

  if (diff > 0) {
    return {
      current: safeCurrent,
      previous: safePrevious,
      diff,
      percentChange,
      direction: "up",
      labelId: `+${pctStr}% (+${formatIntegerId(diff)} vs bulan lalu)`,
    };
  }

  return {
    current: safeCurrent,
    previous: safePrevious,
    diff,
    percentChange,
    direction: "down",
    labelId: `-${pctStr}% (${formatIntegerId(diff)} vs bulan lalu)`,
  };
}

/**
 * Selects exactly ONE concrete, deterministic, actionable improvement tip in Bahasa Indonesia
 * grounded strictly in the website's monthly performance metrics (no hallucinated claims).
 */
export function selectConcreteMonthlyTip(params: {
  readonly current: MonthlyPerformanceMetrics;
  readonly mom: {
    readonly visits: MonthlyMetricDelta;
    readonly leads: MonthlyMetricDelta;
    readonly whatsappClicks: MonthlyMetricDelta;
    readonly aiAssistantReferrals: MonthlyMetricDelta;
  };
  readonly topOffering: MonthlyTopOffering | null;
}): string {
  const { current, mom, topOffering } = params;

  if (current.visits >= 20 && current.leads === 0 && current.whatsappClicks === 0) {
    return "Pengunjung sudah mulai berdatangan, tetapi belum ada klik WhatsApp atau pesan masuk. Pastikan tombol WhatsApp terlihat jelas di bagian atas halaman dan tambahkan ajakan konsultasi singkat pada penawaran utama Anda.";
  }

  if (
    topOffering &&
    topOffering.visits >= 10 &&
    topOffering.whatsappClicks === 0 &&
    topOffering.leads === 0
  ) {
    return `Penawaran "${topOffering.title}" paling banyak dilihat bulan ini, tetapi belum menghasilkan pertanyaan. Tambahkan kisaran harga, spesifikasi inti, dan tombol WhatsApp khusus di halaman penawaran tersebut.`;
  }

  if (mom.visits.previous >= 10 && mom.visits.percentChange !== null && mom.visits.percentChange <= -20) {
    return "Kunjungan turun dibanding bulan sebelumnya. Bagikan ulang tautan website dan kode QR Anda di profil media sosial, status WhatsApp, serta Google Business Profile agar calon pelanggan mudah kembali menemukan bisnis Anda.";
  }

  if (current.aiAssistantReferrals === 0 && current.visits >= 5) {
    return "Belum ada rujukan dari asisten AI bulan ini. Lengkapi profil bisnis, jam operasional, dan tabel fakta penawaran agar mesin pencari dan asisten AI lebih mudah memahami layanan Anda.";
  }

  if (!topOffering && current.visits >= 5) {
    return "Belum ada halaman penawaran yang mencatat kunjungan bulan ini. Publikasikan minimal satu halaman layanan atau produk utama lalu tautkan langsung dari beranda agar pengunjung cepat melihat penawaran Anda.";
  }

  if (current.whatsappClicks >= 3 && current.leads === 0) {
    return "Calon pelanggan sudah aktif mengklik WhatsApp, namun formulir pesan belum terisi. Tambahkan formulir pertanyaan singkat di bawah penawaran terpopuler agar pengunjung di luar jam kerja tetap bisa meninggalkan kontak.";
  }

  if (mom.visits.diff > 0 && (current.leads > 0 || current.whatsappClicks > 0)) {
    const offeringSuffix = topOffering
      ? ` dengan "${topOffering.title}" sebagai penawaran terpopuler`
      : "";
    return `Performa website Anda bertumbuh bulan ini${offeringSuffix}. Pertahankan momentum dengan memublikasikan satu artikel baru yang menjawab pertanyaan paling sering ditanyakan calon pelanggan Anda.`;
  }

  return "Perbarui foto dan detail penawaran utama Anda secara berkala, lalu bagikan tautan website melalui WhatsApp dan Google Business Profile untuk meningkatkan kunjungan bulan depan.";
}

export interface BuildMonthlyReportSummaryInput {
  readonly reportMonth: string;
  readonly timeZone?: string;
  readonly contentRows: readonly MonthlyContentAggregateRow[];
  readonly sourceRows: readonly MonthlySourceAggregateRow[];
  readonly offeringTitles?: MonthlyOfferingTitleLookup;
  readonly threshold?: MonthlyActivityThreshold;
}

/**
 * Pure aggregator that turns `reportMonth` + `comparisonMonth` rows from TASK-072
 * insights tables into a complete, PII-free `MonthlyPerformanceReportSummary`.
 */
export function buildMonthlyPerformanceReportSummary(
  input: BuildMonthlyReportSummaryInput,
): MonthlyPerformanceReportSummary {
  const period = parseReportMonthPeriod(input.reportMonth, input.timeZone);
  const threshold = input.threshold ?? DEFAULT_MONTHLY_REPORT_MIN_ACTIVITY_THRESHOLD;

  let curVisits = 0;
  let curLeads = 0;
  let curWaClicks = 0;
  let prevVisits = 0;
  let prevLeads = 0;
  let prevWaClicks = 0;

  const offeringMap = new Map<
    string,
    {
      contentId: number;
      path: string;
      visits: number;
      whatsappClicks: number;
      leads: number;
      externalClicks: number;
    }
  >();

  for (const row of input.contentRows) {
    const day = row.day_utc;
    if (!day) continue;
    const pv = toSafeCount(row.page_views);
    const wa = toSafeCount(row.wa_clicks);
    const ext = toSafeCount(row.external_clicks);
    const leads = toSafeCount(row.lead_submits);
    if (pv + wa + ext + leads === 0) continue;

    if (day >= period.startDay && day <= period.endDay) {
      curVisits += pv;
      curWaClicks += wa;
      curLeads += leads;

      if (row.content_kind === "offering" || isOfferingPath(row.path)) {
        const key = row.path;
        const existing = offeringMap.get(key) ?? {
          contentId: toSafeCount(row.content_id),
          path: row.path,
          visits: 0,
          whatsappClicks: 0,
          leads: 0,
          externalClicks: 0,
        };
        if (existing.contentId === 0 && toSafeCount(row.content_id) > 0) {
          existing.contentId = toSafeCount(row.content_id);
        }
        existing.visits += pv;
        existing.whatsappClicks += wa;
        existing.leads += leads;
        existing.externalClicks += ext;
        offeringMap.set(key, existing);
      }
    } else if (day >= period.comparisonStartDay && day <= period.comparisonEndDay) {
      prevVisits += pv;
      prevWaClicks += wa;
      prevLeads += leads;
    }
  }

  let curAiReferrals = 0;
  let prevAiReferrals = 0;

  for (const row of input.sourceRows) {
    const day = row.day_utc;
    if (!day || row.source_bucket !== "ai_assistant") continue;
    const visits = toSafeCount(row.page_views);
    if (visits === 0) continue;

    if (day >= period.startDay && day <= period.endDay) {
      curAiReferrals += visits;
    } else if (day >= period.comparisonStartDay && day <= period.comparisonEndDay) {
      prevAiReferrals += visits;
    }
  }

  const rankedOfferings = Array.from(offeringMap.values())
    .map((entry) => {
      const totalInterest = entry.whatsappClicks + entry.leads + entry.externalClicks;
      const totalActivity = entry.visits + totalInterest;
      return {
        title: resolveOfferingTitle(entry.contentId, entry.path, input.offeringTitles),
        path: entry.path,
        visits: entry.visits,
        whatsappClicks: entry.whatsappClicks,
        leads: entry.leads,
        totalInterest,
        totalActivity,
      };
    })
    .sort((a, b) => {
      if (b.totalActivity !== a.totalActivity) return b.totalActivity - a.totalActivity;
      if (b.totalInterest !== a.totalInterest) return b.totalInterest - a.totalInterest;
      if (b.visits !== a.visits) return b.visits - a.visits;
      return a.path.localeCompare(b.path);
    });

  const bestOffering = rankedOfferings[0]
    ? {
        title: rankedOfferings[0].title,
        path: rankedOfferings[0].path,
        visits: rankedOfferings[0].visits,
        whatsappClicks: rankedOfferings[0].whatsappClicks,
        leads: rankedOfferings[0].leads,
        totalActivity: rankedOfferings[0].totalActivity,
      }
    : null;

  const current: MonthlyPerformanceMetrics = {
    visits: curVisits,
    leads: curLeads,
    whatsappClicks: curWaClicks,
    aiAssistantReferrals: curAiReferrals,
  };

  const previous: MonthlyPerformanceMetrics = {
    visits: prevVisits,
    leads: prevLeads,
    whatsappClicks: prevWaClicks,
    aiAssistantReferrals: prevAiReferrals,
  };

  const mom = {
    visits: computeMonthlyDelta(current.visits, previous.visits),
    leads: computeMonthlyDelta(current.leads, previous.leads),
    whatsappClicks: computeMonthlyDelta(current.whatsappClicks, previous.whatsappClicks),
    aiAssistantReferrals: computeMonthlyDelta(
      current.aiAssistantReferrals,
      previous.aiAssistantReferrals,
    ),
  };

  const meetsActivityThreshold = isEligibleForMonthlyReport(current, threshold);
  const actionableTip = selectConcreteMonthlyTip({
    current,
    mom,
    topOffering: bestOffering,
  });

  return {
    period,
    current,
    previous,
    mom,
    topOffering: bestOffering,
    actionableTip,
    meetsActivityThreshold,
    threshold,
  };
}
