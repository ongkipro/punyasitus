import { PLATFORM_HOSTS } from "@punyasitus/core";
import {
  buildChannelAttributionSummary,
  normalizeStoredSourceToChannel,
  type AttributionChannel,
  type ChannelMetricRow,
} from "@punyasitus/core/analytics/attribution";
import {
  buildIndexNowKeyLocation,
  evaluateIndexNowEligibility,
} from "@punyasitus/core/seo/indexnow";
import {
  generateTenantRobotsTxt,
  type AiTrainingPolicy,
  type SiteVisibility,
  type VerifiedTenantHostInput,
} from "@punyasitus/core/seo/robots";
import {
  createTenantDb,
  openTenantStoreStub,
  orchestrateTenantMigration,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import { bumpTenantCacheVersion, getPublishedResource } from "@punyasitus/db/publication/index";
import { computeEffectiveTenantStatus } from "@punyasitus/db/routing/index";
import type { TenantStatus, TenantVertical } from "@punyasitus/db/platform";
import { TENANT_MIGRATIONS } from "@punyasitus/db/tenant";
import {
  ensureTenantIndexNowKey,
  readTenantSeoPluginConfig,
} from "../../../../worker/queues/seo/indexnow.ts";

export interface SeoVisibilitySnapshot {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly vertical: TenantVertical;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly trialEndsAtMs: number | null;
  readonly primaryHost: string;
  readonly primaryHostKind: "subdomain" | "custom";
  readonly primaryHostVerified: boolean;
  readonly saasZone: string;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly siteVisibility: SiteVisibility;
  readonly seoAutopilotEnabled: boolean;
  readonly robotsTxt: string;
  readonly robotsIndexable: boolean;
  readonly sitemapUrl: string | null;
  readonly indexnowEligible: boolean;
  readonly indexnowSkipReason: string | null;
  readonly indexnowStatusBadge: string;
  readonly indexnowKeyLocation: string | null;
  readonly indexnowLastPingAtMs: number | null;
  readonly indexnowLastStatus: "accepted" | "failed" | null;
  readonly indexnowLastUrlCount: number;
  readonly channels: readonly ChannelMetricRow[];
  readonly totalWaClicks: number;
  readonly totalPageviews: number;
  readonly totalLeads: number;
}

interface TenantPlatformMetaRow {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly vertical: TenantVertical;
  readonly status: TenantStatus;
  readonly operator_hold: number;
  readonly trial_ends_at: number | null;
  readonly paid_through: number | null;
  readonly primary_host: string | null;
  readonly primary_host_kind: "subdomain" | "custom" | null;
  readonly primary_host_status: "pending" | "active" | "failed" | "moved" | "deleting" | null;
  readonly primary_host_ssl_status: string | null;
  readonly primary_host_verified_at: number | null;
}

interface SiteSettingsPolicyRow {
  readonly site_title: string;
  readonly ai_training_policy: AiTrainingPolicy;
  readonly draft_json: string | null;
  readonly published_json: string | null;
  readonly version: number;
}

export async function ensureTenantDbMigrated(params: {
  readonly platformDb: D1Database;
  readonly tenantStore: TenantStoreNamespaceLike;
  readonly tenantId: string;
}): Promise<D1Database> {
  const stub = openTenantStoreStub(params.tenantStore, params.tenantId);
  const tenantDb = createTenantDb(stub);

  try {
    await tenantDb.prepare("SELECT 1 FROM site_settings LIMIT 1").first();
    return tenantDb;
  } catch {
    await orchestrateTenantMigration(
      params.platformDb,
      stub,
      params.tenantId,
      TENANT_MIGRATIONS,
    );
    return tenantDb;
  }
}

export function buildVerifiedTenantHostInput(params: {
  readonly handle: string;
  readonly tenantStatus: TenantStatus;
  readonly operatorHold: boolean;
  readonly primaryHost: string;
  readonly primaryHostKind: "subdomain" | "custom";
  readonly primaryHostVerified: boolean;
  readonly saasZone: string;
}): VerifiedTenantHostInput {
  const fallbackSubdomain = `${params.handle}.${params.saasZone}`;
  const verifiedHosts = new Set<string>([fallbackSubdomain]);
  if (params.primaryHostVerified) {
    verifiedHosts.add(params.primaryHost);
  }
  return {
    tenantHandle: params.handle,
    tenantStatus: params.tenantStatus,
    operatorHold: params.operatorHold,
    primaryHost: params.primaryHost,
    primaryHostKind: params.primaryHostKind,
    primaryHostStatus: params.primaryHostVerified ? "active" : "pending",
    primaryHostSslStatus: params.primaryHostVerified ? "active" : "pending",
    primaryHostVerified: params.primaryHostVerified,
    verifiedTenantHosts: Array.from(verifiedHosts),
    servingHost: params.primaryHost,
  };
}

async function loadChannelAttributionMetrics(tenantDb: D1Database): Promise<{
  readonly channels: readonly ChannelMetricRow[];
  readonly totalWaClicks: number;
  readonly totalPageviews: number;
  readonly totalLeads: number;
}> {
  const visitByChannel = new Map<AttributionChannel, number>();
  const leadsByChannel = new Map<AttributionChannel, number>();
  let totalWaClicks = 0;
  let totalPageviews = 0;
  let totalLeads = 0;

  try {
    const [hourlyRows, leadRows, dailyTotals] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT source_bucket, SUM(visits) AS total_visits
           FROM analytics_hourly_sources
           GROUP BY source_bucket`,
        )
        .all<{ readonly source_bucket: string; readonly total_visits: number }>(),
      tenantDb
        .prepare(
          `SELECT source_category, COUNT(*) AS total_leads
           FROM leads
           GROUP BY source_category`,
        )
        .all<{ readonly source_category: string; readonly total_leads: number }>(),
      tenantDb
        .prepare(
          `SELECT
             COALESCE(SUM(wa_clicks), 0) AS wa_clicks,
             COALESCE(SUM(pageviews), 0) AS pageviews
           FROM analytics_daily`,
        )
        .first<{ readonly wa_clicks: number; readonly pageviews: number }>(),
    ]);

    for (const row of hourlyRows.results) {
      const ch = normalizeStoredSourceToChannel(row.source_bucket);
      visitByChannel.set(ch, (visitByChannel.get(ch) ?? 0) + Number(row.total_visits ?? 0));
    }

    for (const row of leadRows.results) {
      const ch = normalizeStoredSourceToChannel(row.source_category);
      const count = Number(row.total_leads ?? 0);
      leadsByChannel.set(ch, (leadsByChannel.get(ch) ?? 0) + count);
      totalLeads += count;
    }

    totalWaClicks = Number(dailyTotals?.wa_clicks ?? 0);
    totalPageviews = Number(dailyTotals?.pageviews ?? 0);
  } catch {
    // Gracefully return zeroed channels when tables are freshly provisioned
  }

  // Distribute aggregate WA clicks proportionally when hourly visits exist,
  // preserving exact total signals without fabricating unrecorded events.
  const totalHourlyVisits = Array.from(visitByChannel.values()).reduce((a, b) => a + b, 0);
  const waByChannel = new Map<AttributionChannel, number>();
  if (totalWaClicks > 0 && totalHourlyVisits > 0) {
    let remainingWa = totalWaClicks;
    const entries = Array.from(visitByChannel.entries()).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < entries.length; i += 1) {
      const [ch, visits] = entries[i]!;
      const share =
        i === entries.length - 1
          ? remainingWa
          : Math.min(remainingWa, Math.round((visits / totalHourlyVisits) * totalWaClicks));
      waByChannel.set(ch, share);
      remainingWa = Math.max(0, remainingWa - share);
    }
  } else if (totalWaClicks > 0) {
    waByChannel.set("direct", totalWaClicks);
  }

  const allChannels = new Set<AttributionChannel>([
    ...visitByChannel.keys(),
    ...leadsByChannel.keys(),
    ...waByChannel.keys(),
  ]);

  const summary = buildChannelAttributionSummary(
    Array.from(allChannels).map((channel) => ({
      channel,
      visits: visitByChannel.get(channel) ?? 0,
      waClicks: waByChannel.get(channel) ?? 0,
      leads: leadsByChannel.get(channel) ?? 0,
    })),
  );

  return {
    channels: summary,
    totalWaClicks,
    totalPageviews: Math.max(totalPageviews, totalHourlyVisits),
    totalLeads,
  };
}

export async function loadSeoVisibilitySnapshot(params: {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly tenantDb?: D1Database | null;
  readonly tenantId: string;
  readonly saasZone?: string;
  readonly nowMs?: number;
}): Promise<SeoVisibilitySnapshot | null> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const saasZone = (params.saasZone ?? PLATFORM_HOSTS.saasZone).trim().toLowerCase();

  const row = await params.platformDb
    .prepare(
      `SELECT
         t.id AS id,
         t.handle AS handle,
         t.name AS name,
         t.vertical AS vertical,
         t.status AS status,
         t.operator_hold AS operator_hold,
         t.trial_ends_at AS trial_ends_at,
         t.paid_through AS paid_through,
         ph.host AS primary_host,
         ph.kind AS primary_host_kind,
         ph.status AS primary_host_status,
         ph.ssl_status AS primary_host_ssl_status,
         ph.verified_at AS primary_host_verified_at
       FROM tenants t
       LEFT JOIN tenant_hosts ph
         ON ph.tenant_id = t.id
         AND ph.is_primary = 1
       WHERE t.id = ?
       LIMIT 1`,
    )
    .bind(params.tenantId)
    .first<TenantPlatformMetaRow>();

  if (!row) return null;

  const effectiveStatus = computeEffectiveTenantStatus(
    {
      storedStatus: row.status,
      operatorHold: row.operator_hold === 1,
      trialEndsAt: row.trial_ends_at,
      paidThrough: row.paid_through,
    },
    nowMs,
  );

  const fallbackSubdomain = `${row.handle}.${saasZone}`;
  const primaryHost = row.primary_host ?? fallbackSubdomain;
  const primaryHostKind: "subdomain" | "custom" =
    row.primary_host_kind === "custom" ? "custom" : "subdomain";
  const primaryHostVerified =
    row.primary_host_status === "active" && row.primary_host_ssl_status === "active";

  let tenantDb: D1Database | null = params.tenantDb ?? null;
  if (!tenantDb && params.tenantStore) {
    try {
      tenantDb = await ensureTenantDbMigrated({
        platformDb: params.platformDb,
        tenantStore: params.tenantStore,
        tenantId: row.id,
      });
    } catch {
      tenantDb = null;
    }
  }

  let aiTrainingPolicy: AiTrainingPolicy = "allow";
  let siteVisibility: SiteVisibility = "public";
  let seoAutopilotEnabled = true;
  let indexnowKey: string | null = null;
  let indexnowLastPingAtMs: number | null = null;
  let indexnowLastStatus: "accepted" | "failed" | null = null;
  let indexnowLastUrlCount = 0;
  let channelData: {
    readonly channels: readonly ChannelMetricRow[];
    readonly totalWaClicks: number;
    readonly totalPageviews: number;
    readonly totalLeads: number;
  } = {
    channels: buildChannelAttributionSummary([]),
    totalWaClicks: 0,
    totalPageviews: 0,
    totalLeads: 0,
  };

  if (tenantDb) {
    const [siteRow, publishedSite, pluginConfig, loadedChannels] = await Promise.all([
      tenantDb
        .prepare("SELECT ai_training_policy FROM site_settings WHERE id = 1 LIMIT 1")
        .first<{ readonly ai_training_policy: AiTrainingPolicy }>()
        .catch(() => null),
      getPublishedResource(tenantDb, {
        resourceType: "site_settings",
        resourceId: 1,
      }).catch(() => null),
      readTenantSeoPluginConfig(tenantDb),
      loadChannelAttributionMetrics(tenantDb),
    ]);

    aiTrainingPolicy =
      publishedSite?.data.aiTrainingPolicy ?? siteRow?.ai_training_policy ?? "allow";
    siteVisibility = publishedSite?.data.siteVisibility ?? "public";
    seoAutopilotEnabled = pluginConfig.enabled;
    indexnowKey = pluginConfig.indexnowKey;
    indexnowLastPingAtMs = pluginConfig.lastIndexNowPingAt;
    indexnowLastStatus = pluginConfig.lastIndexNowStatus;
    indexnowLastUrlCount = pluginConfig.lastIndexNowUrlCount;
    channelData = loadedChannels;
  }

  const seoTenant = buildVerifiedTenantHostInput({
    handle: row.handle,
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    primaryHost,
    primaryHostKind,
    primaryHostVerified,
    saasZone,
  });

  const robotsEval = generateTenantRobotsTxt({
    tenant: seoTenant,
    aiTrainingPolicy,
    siteVisibility,
  });

  const indexnowEligibility = evaluateIndexNowEligibility({
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    primaryHost,
    primaryHostKind,
    primaryHostStatus: row.primary_host_status,
    primaryHostSslStatus: row.primary_host_ssl_status,
    primaryHostVerified: primaryHostKind === "custom" && primaryHostVerified,
    siteVisibility,
    seoAutopilotEnabled,
    saasZone,
  });

  const indexnowStatusBadge = indexnowEligibility.eligible
    ? "Aktif untuk domain khusus"
    : primaryHostKind === "subdomain" || effectiveStatus === "trial"
      ? `Tidak aktif di subdomain .${saasZone}`
      : "Belum aktif (menunggu domain khusus terverifikasi)";

  const indexnowKeyLocation =
    indexnowEligibility.eligible && indexnowKey
      ? buildIndexNowKeyLocation(indexnowEligibility.host, indexnowKey)
      : null;

  return {
    tenantId: row.id,
    handle: row.handle,
    tenantName: row.name,
    vertical: row.vertical,
    tenantStatus: effectiveStatus,
    operatorHold: row.operator_hold === 1,
    trialEndsAtMs: row.trial_ends_at,
    primaryHost,
    primaryHostKind,
    primaryHostVerified,
    saasZone,
    aiTrainingPolicy,
    siteVisibility,
    seoAutopilotEnabled,
    robotsTxt: robotsEval.body,
    robotsIndexable: robotsEval.indexable,
    sitemapUrl: robotsEval.sitemapUrl,
    indexnowEligible: indexnowEligibility.eligible,
    indexnowSkipReason: indexnowEligibility.eligible ? null : indexnowEligibility.reason,
    indexnowStatusBadge,
    indexnowKeyLocation,
    indexnowLastPingAtMs,
    indexnowLastStatus,
    indexnowLastUrlCount,
    channels: channelData.channels,
    totalWaClicks: channelData.totalWaClicks,
    totalPageviews: channelData.totalPageviews,
    totalLeads: channelData.totalLeads,
  };
}

function patchSiteSettingsEnvelopeJson(
  rawJson: string | null,
  nextPolicy: AiTrainingPolicy,
  fallbackTitle: string,
  nowMs: number,
): string {
  const defaultData = {
    siteTitle: fallbackTitle,
    tagline: null,
    timezone: "Asia/Jakarta",
    locale: "id-ID",
    activeThemeId: "compro",
    faviconMediaId: null,
    ogImageMediaId: null,
    blogEnabled: true,
    catalogEnabled: true,
    aiTrainingPolicy: nextPolicy,
    analyticsConfig: null,
    siteVisibility: "public" as const,
  };

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const innerData =
          parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
            ? { ...(parsed.data as Record<string, unknown>), aiTrainingPolicy: nextPolicy }
            : { ...defaultData, aiTrainingPolicy: nextPolicy };
        return JSON.stringify({
          snapshotVersion: 1,
          resourceType: "site_settings",
          publishedAt: typeof parsed.publishedAt === "number" ? parsed.publishedAt : nowMs,
          contentModifiedAt: nowMs,
          data: innerData,
        });
      }
    } catch {
      // Rebuild cleanly below
    }
  }

  return JSON.stringify({
    snapshotVersion: 1,
    resourceType: "site_settings",
    publishedAt: nowMs,
    contentModifiedAt: nowMs,
    data: defaultData,
  });
}

/**
 * Persists the owner's `aiTrainingPolicy` toggle (`"allow" | "disallow"`) into
 * `TenantStore.site_settings` (both live column and published snapshot) and bumps
 * `PLATFORM_DB.tenants.cache_version` so `/robots.txt` updates immediately.
 */
export async function updateAiTrainingPolicyForTenant(params: {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly tenantDb?: D1Database | null;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly nowMs?: number;
  readonly saasZone?: string;
}): Promise<SeoVisibilitySnapshot> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tenantDb =
    params.tenantDb ??
    (params.tenantStore
      ? await ensureTenantDbMigrated({
          platformDb: params.platformDb,
          tenantStore: params.tenantStore,
          tenantId: params.tenantId,
        })
      : null);

  if (!tenantDb) {
    throw new Error("TENANT_STORE_UNAVAILABLE");
  }

  const existing = await tenantDb
    .prepare(
      `SELECT site_title, ai_training_policy, draft_json, published_json, version
       FROM site_settings
       WHERE id = 1
       LIMIT 1`,
    )
    .first<SiteSettingsPolicyRow>();

  const fallbackTitle = existing?.site_title || params.tenantName || "Situs Bisnis";
  const nextPublishedJson = patchSiteSettingsEnvelopeJson(
    existing?.published_json ?? null,
    params.aiTrainingPolicy,
    fallbackTitle,
    nowMs,
  );
  const nextDraftJson = patchSiteSettingsEnvelopeJson(
    existing?.draft_json ?? existing?.published_json ?? null,
    params.aiTrainingPolicy,
    fallbackTitle,
    nowMs,
  );

  if (!existing) {
    await tenantDb
      .prepare(
        `INSERT INTO site_settings (
           id, site_title, timezone, locale, active_theme_id,
           blog_enabled, catalog_enabled, ai_training_policy,
           draft_json, published_json, published_at, content_modified_at,
           version, updated_at
         )
         VALUES (1, ?, 'Asia/Jakarta', 'id-ID', 'compro', 1, 1, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        fallbackTitle,
        params.aiTrainingPolicy,
        nextDraftJson,
        nextPublishedJson,
        nowMs,
        nowMs,
        nowMs,
      )
      .run();
  } else {
    await tenantDb
      .prepare(
        `UPDATE site_settings
         SET ai_training_policy = ?,
             draft_json = ?,
             published_json = ?,
             content_modified_at = ?,
             version = version + 1,
             updated_at = ?
         WHERE id = 1`,
      )
      .bind(params.aiTrainingPolicy, nextDraftJson, nextPublishedJson, nowMs, nowMs)
      .run();
  }

  await bumpTenantCacheVersion(params.platformDb, params.tenantId, nowMs).catch(() => undefined);

  const snapshot = await loadSeoVisibilitySnapshot({
    platformDb: params.platformDb,
    tenantDb,
    tenantId: params.tenantId,
    saasZone: params.saasZone,
    nowMs,
  });

  if (!snapshot) {
    throw new Error("TENANT_NOT_FOUND");
  }
  return snapshot;
}

export async function ensureIndexNowKeyForVerifiedTenant(params: {
  readonly platformDb: D1Database;
  readonly tenantStore?: TenantStoreNamespaceLike | null;
  readonly tenantDb?: D1Database | null;
  readonly tenantId: string;
  readonly saasZone?: string;
  readonly nowMs?: number;
}): Promise<
  | { readonly ok: true; readonly key: string; readonly keyLocation: string; readonly snapshot: SeoVisibilitySnapshot }
  | { readonly ok: false; readonly reason: string; readonly message: string }
> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tenantDb =
    params.tenantDb ??
    (params.tenantStore
      ? await ensureTenantDbMigrated({
          platformDb: params.platformDb,
          tenantStore: params.tenantStore,
          tenantId: params.tenantId,
        })
      : null);

  if (!tenantDb) {
    return {
      ok: false,
      reason: "service_unavailable",
      message: "Penyimpanan tenant sementara tidak tersedia.",
    };
  }

  const current = await loadSeoVisibilitySnapshot({
    platformDb: params.platformDb,
    tenantDb,
    tenantId: params.tenantId,
    saasZone: params.saasZone,
    nowMs,
  });
  if (!current) {
    return { ok: false, reason: "tenant_not_found", message: "Situs tidak ditemukan." };
  }
  if (!current.indexnowEligible) {
    return {
      ok: false,
      reason: current.indexnowSkipReason ?? "trial_or_subdomain_host",
      message:
        "IndexNow hanya aktif untuk situs berbayar yang telah menghubungkan domain khusus terverifikasi.",
    };
  }

  const { key } = await ensureTenantIndexNowKey(tenantDb, { nowMs });
  const updated = await loadSeoVisibilitySnapshot({
    platformDb: params.platformDb,
    tenantDb,
    tenantId: params.tenantId,
    saasZone: params.saasZone,
    nowMs,
  });

  return {
    ok: true,
    key,
    keyLocation: buildIndexNowKeyLocation(current.primaryHost, key),
    snapshot: updated ?? current,
  };
}
