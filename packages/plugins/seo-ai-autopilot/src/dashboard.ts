import {
  buildDualLocalListingsCopyCard,
  type B2BBlueprintId,
  type BlueprintLocalListingsCard,
} from "@punyasitus/core/presets/blueprints";
import { buildDirectoryListingCopyText } from "@punyasitus/core/seo/editor";
import {
  buildIndexNowKeyLocation,
  evaluateIndexNowEligibility,
  type IndexNowTenantEligibilityInput,
} from "@punyasitus/core/seo/indexnow";
import {
  AI_TRAINING_CRAWLER_DESCRIPTORS,
  SEARCH_AND_AI_FETCHER_DESCRIPTORS,
  type AiTrainingPolicy,
} from "@punyasitus/core/seo/robots";
import {
  SEO_AI_AUTOPILOT_CAPABILITIES,
  SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
  SEO_AI_AUTOPILOT_TIER,
  type SeoAutopilotCapability,
} from "./autopilot.ts";
import { resolveAutopilotIndexNowKey, SEO_AI_AUTOPILOT_PLUGIN_SLUG } from "./discovery.ts";

/**
 * Zero-Config Plugin Dashboard, Editor Slot & GBP + Bing Places Copy Card Contract
 * (`packages/plugins/seo-ai-autopilot/src/dashboard.ts`; REQ-102, DESIGN.md §8).
 *
 * Pure TypeScript view-model builders consumed by `/dashboard/[handle]/plugins/seo-ai-autopilot`,
 * editor integration slots, and scoped plugin admin API handlers.
 */

export const SEO_OVERRIDE_DRAWER_ACCORDION_LABEL =
  "SEO & AI Otomatis Aktif — Ubah manual (opsional)" as const;

export const SEO_OVERRIDE_DRAWER_TABS = [
  { id: "general", label: "Umum" },
  { id: "social", label: "Sosial" },
  { id: "schema", label: "Skema & Fakta AI" },
  { id: "advanced", label: "Lanjutan" },
] as const;

export interface AutopilotEditorSlotContract {
  readonly pluginId: typeof SEO_AI_AUTOPILOT_PLUGIN_SLUG;
  readonly mounted: boolean;
  readonly visibleFieldCountWhenCollapsed: 0;
  readonly collapsedByDefault: boolean;
  readonly accordionLabel: string | null;
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
  readonly zeroClutterWhenDisabled: true;
}

/**
 * Resolves the editor SEO integration slot state (`DESIGN.md §8`, `REQ-102`):
 * - Disabled (`false`): completely hidden (`mounted: false`, zero SEO form fields).
 * - Enabled (`true`): mounted collapsed by default (`collapsedByDefault: true`, 0 visible fields until clicked).
 */
export function resolveAutopilotEditorSlot(input: {
  readonly seoAutopilotActive: boolean;
}): AutopilotEditorSlotContract {
  if (!input.seoAutopilotActive) {
    return {
      pluginId: SEO_AI_AUTOPILOT_PLUGIN_SLUG,
      mounted: false,
      visibleFieldCountWhenCollapsed: 0,
      collapsedByDefault: false,
      accordionLabel: null,
      tabs: [],
      zeroClutterWhenDisabled: true,
    };
  }
  return {
    pluginId: SEO_AI_AUTOPILOT_PLUGIN_SLUG,
    mounted: true,
    visibleFieldCountWhenCollapsed: 0,
    collapsedByDefault: true,
    accordionLabel: SEO_OVERRIDE_DRAWER_ACCORDION_LABEL,
    tabs: SEO_OVERRIDE_DRAWER_TABS,
    zeroClutterWhenDisabled: true,
  };
}

export interface BuildAutopilotDirectoryCardInput {
  readonly blueprintId?: B2BBlueprintId | null;
  readonly businessName: string;
  readonly primaryOrigin: string;
  readonly categoryLabel?: string | null;
  readonly address?: string | null;
  readonly city?: string | null;
  readonly province?: string | null;
  readonly postalCode?: string | null;
  readonly phone?: string | null;
  readonly whatsappE164?: string | null;
  readonly weekdayHours?: string | null;
  readonly holidayHours?: string | null;
}

export interface AutopilotDirectoryCopyCardPayload {
  readonly title: string;
  readonly platforms: readonly ["Google Business Profile", "Bing Places"];
  readonly copyPlainText: string;
  readonly callsExternalApi: false;
  readonly blueprintCard: BlueprintLocalListingsCard | null;
}

/**
 * Builds the zero-config Google Business Profile + Bing Places copy-ready card
 * strictly from verified tenant facts (never calls external Google/Bing APIs).
 */
export function buildAutopilotDirectoryCopyCard(
  input: BuildAutopilotDirectoryCardInput,
): AutopilotDirectoryCopyCardPayload {
  const factualCopyText = buildDirectoryListingCopyText({
    businessName: input.businessName,
    primaryOrigin: input.primaryOrigin,
    businessCategory: input.categoryLabel ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    province: input.province ?? null,
    postalCode: input.postalCode ?? null,
    phone: input.phone ?? null,
    whatsappE164: input.whatsappE164 ?? null,
    weekdayHours: input.weekdayHours ?? null,
    holidayHours: input.holidayHours ?? null,
  });

  const blueprintCard = input.blueprintId
    ? buildDualLocalListingsCopyCard({
        businessName: input.businessName,
        categoryLabel: input.categoryLabel ?? "Usaha Lokal",
        address: input.address,
        weekdayHours: input.weekdayHours,
        holidayHours: input.holidayHours,
        whatsappE164: input.whatsappE164,
        phone: input.phone,
        websiteUrl: input.primaryOrigin,
      })
    : null;

  return {
    title: "Salin Data untuk Google Business Profile & Bing Places",
    platforms: ["Google Business Profile", "Bing Places"],
    copyPlainText: factualCopyText,
    callsExternalApi: false,
    blueprintCard,
  };
}

export interface BuildAutopilotDashboardModelInput {
  readonly tenantId: string;
  readonly handle: string;
  readonly businessName: string;
  readonly primaryOrigin: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly aiTrainingPolicy: AiTrainingPolicy;
  readonly indexnowEligibility: IndexNowTenantEligibilityInput;
  readonly storedIndexNowKey?: string | null;
  readonly indexNowKeySecret?: string | null;
  readonly savedSettingsVersion?: number;
  readonly hasSavedOverrides?: boolean;
  readonly directoryProfile?: Omit<BuildAutopilotDirectoryCardInput, "businessName" | "primaryOrigin">;
}

export interface AutopilotPluginDashboardModel {
  readonly pluginId: typeof SEO_AI_AUTOPILOT_PLUGIN_SLUG;
  readonly tier: typeof SEO_AI_AUTOPILOT_TIER;
  readonly defaultActiveOnProvision: typeof SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION;
  readonly zeroConfigRequired: true;
  readonly mandatoryFieldCount: 0;
  readonly preservesOverridesOnDisable: true;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly primaryActionLabel: "Pasang (Gratis)" | "Aktifkan kembali" | "Nonaktifkan";
  readonly statusLabel: "Aktif Otomatis" | "Nonaktif (Data Tersimpan)";
  readonly settingsVersion: number;
  readonly hasSavedOverrides: boolean;
  readonly capabilities: readonly SeoAutopilotCapability[];
  readonly sitemapUrl: string | null;
  readonly robotsUrl: string;
  readonly aiBotSplit: {
    readonly aiTrainingPolicy: AiTrainingPolicy;
    readonly searchAndAnswerBotCount: number;
    readonly trainingBotCount: number;
    readonly searchBots: readonly string[];
    readonly trainingBots: readonly string[];
  };
  readonly indexnow: {
    readonly eligible: boolean;
    readonly keyLocation: string | null;
    readonly reason: string | null;
  };
  readonly directoryCard: AutopilotDirectoryCopyCardPayload;
  readonly editorSlot: AutopilotEditorSlotContract;
}

/**
 * Builds the zero-config settings/status view-model for `/dashboard/[handle]/plugins/seo-ai-autopilot`.
 */
export async function buildAutopilotPluginDashboardModel(
  input: BuildAutopilotDashboardModelInput,
): Promise<AutopilotPluginDashboardModel> {
  const normalizedOrigin = input.primaryOrigin.replace(/\/+$/, "");
  const indexnowDecision = evaluateIndexNowEligibility({
    ...input.indexnowEligibility,
    seoAutopilotEnabled: input.enabled,
  });

  let indexnowKeyLocation: string | null = null;
  if (input.enabled && indexnowDecision.eligible) {
    const key = await resolveAutopilotIndexNowKey({
      tenantId: input.tenantId,
      seoAutopilotActive: true,
      storedKey: input.storedIndexNowKey,
      secret: input.indexNowKeySecret,
    });
    if (key) {
      indexnowKeyLocation = buildIndexNowKeyLocation(indexnowDecision.host, key);
    }
  }

  const directoryCard = buildAutopilotDirectoryCopyCard({
    businessName: input.businessName,
    primaryOrigin: normalizedOrigin,
    ...input.directoryProfile,
  });

  const primaryActionLabel: AutopilotPluginDashboardModel["primaryActionLabel"] = input.enabled
    ? "Nonaktifkan"
    : input.installed
      ? "Aktifkan kembali"
      : "Pasang (Gratis)";

  return {
    pluginId: SEO_AI_AUTOPILOT_PLUGIN_SLUG,
    tier: SEO_AI_AUTOPILOT_TIER,
    defaultActiveOnProvision: SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
    zeroConfigRequired: true,
    mandatoryFieldCount: 0,
    preservesOverridesOnDisable: true,
    installed: input.installed,
    enabled: input.enabled,
    primaryActionLabel,
    statusLabel: input.enabled ? "Aktif Otomatis" : "Nonaktif (Data Tersimpan)",
    settingsVersion: input.savedSettingsVersion ?? 0,
    hasSavedOverrides: Boolean(input.hasSavedOverrides),
    capabilities: SEO_AI_AUTOPILOT_CAPABILITIES,
    sitemapUrl: input.enabled ? `${normalizedOrigin}/sitemap.xml` : null,
    robotsUrl: `${normalizedOrigin}/robots.txt`,
    aiBotSplit: {
      aiTrainingPolicy: input.aiTrainingPolicy,
      searchAndAnswerBotCount: SEARCH_AND_AI_FETCHER_DESCRIPTORS.length,
      trainingBotCount: AI_TRAINING_CRAWLER_DESCRIPTORS.length,
      searchBots: SEARCH_AND_AI_FETCHER_DESCRIPTORS.map((b) => b.userAgent),
      trainingBots: AI_TRAINING_CRAWLER_DESCRIPTORS.map((b) => b.userAgent),
    },
    indexnow: {
      eligible: input.enabled && indexnowDecision.eligible,
      keyLocation: indexnowKeyLocation,
      reason: indexnowDecision.eligible ? null : indexnowDecision.reason,
    },
    directoryCard,
    editorSlot: resolveAutopilotEditorSlot({ seoAutopilotActive: input.enabled }),
  };
}
