import {
  definePlugin,
  type PluginDefinition,
  type PluginManifest,
  type PluginMigrationDescriptor,
} from "@punyasitus/core/plugins/index";
import {
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  SeoAutopilotPluginConfigSchema,
  type SeoAutopilotPluginConfig,
} from "@punyasitus/core/seo/editor";
import {
  SEO_AI_AUTOPILOT_CAPABILITIES,
  SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
  SEO_AI_AUTOPILOT_TIER,
} from "./src/autopilot.ts";
import {
  SEO_OVERRIDE_DRAWER_ACCORDION_LABEL,
  SEO_OVERRIDE_DRAWER_TABS,
} from "./src/dashboard.ts";

export { SeoAutopilotPluginConfigSchema, type SeoAutopilotPluginConfig };

export * from "./src/autopilot.ts";
export * from "./src/discovery.ts";
export * from "./src/dashboard.ts";

/**
 * Official First-Party `public_free` Zero-Config Plugin: `seo-ai-autopilot`
 * (`DEC-039`, `DEC-042`, `ADR-0010`, `REQ-052..055`, `REQ-066`, `REQ-095`, `REQ-102`, `TASK-102`).
 *
 * - Strictly isolated to `plg_seo_ai_autopilot__*` tables (`TenantStore`).
 * - Zero public JS overhead (`maxPublicJsBytes: 0`).
 * - Pre-installed and active on newly provisioned websites (`defaultActiveOnProvision: true`, DEC-042).
 * - Zero required settings: programmatic Blueprint Meta Title/Description, `< 300 KiB` WhatsApp OG,
 *   Image Sitemap `/sitemap.xml`, AI-split `/robots.txt`, Schema.org `@graph`, deterministic
 *   `IndexNow` key & `/[indexnowKey].txt`, Blog RSS `/blog/feed.xml`, and GBP + Bing Places copy card
 *   all work immediately on 1-click install.
 * - Disabling cleanly hides all editor SEO controls, disables `/sitemap.xml`, `/[indexnowKey].txt`,
 *   `/blog/feed.xml`, JSON-LD `@graph`, and autopilot OG/meta expansion while preserving saved
 *   overrides and keeping mandatory `trial`/`suspended` `noindex` safety headers intact.
 */

export const SEO_AI_AUTOPILOT_PLUGIN_ID = "seo-ai-autopilot" as const;
export const SEO_AI_AUTOPILOT_TABLE_PREFIX = "plg_seo_ai_autopilot__" as const;

export const SEO_AI_AUTOPILOT_METADATA = {
  slug: SEO_AI_AUTOPILOT_PLUGIN_ID,
  tier: SEO_AI_AUTOPILOT_TIER,
  defaultActiveOnProvision: SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
  zeroConfigRequired: true,
  mandatoryFieldCount: 0,
  preservesOverridesOnDisable: true,
  capabilities: SEO_AI_AUTOPILOT_CAPABILITIES,
  discoveryRoutes: [
    "/sitemap.xml",
    "/sitemaps/pages.xml",
    "/sitemaps/posts.xml",
    "/sitemaps/offerings.xml",
    "/robots.txt",
    "/[indexnowKey].txt",
    "/blog/feed.xml",
  ] as const,
  editorSlot: {
    id: "seo-override-drawer",
    collapsedByDefault: true,
    hiddenWhenDisabled: true,
    accordionLabel: SEO_OVERRIDE_DRAWER_ACCORDION_LABEL,
    tabs: SEO_OVERRIDE_DRAWER_TABS,
  },
} as const;

export const SEO_AI_AUTOPILOT_MIGRATIONS: readonly PluginMigrationDescriptor[] = [
  {
    version: 1,
    name: "0001_seo_autopilot_settings",
    sql: `CREATE TABLE IF NOT EXISTS plg_seo_ai_autopilot__settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draft_json TEXT NOT NULL,
  published_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);`,
  },
] as const;

export const SEO_AI_AUTOPILOT_MANIFEST: PluginManifest = {
  id: SEO_AI_AUTOPILOT_PLUGIN_ID,
  name: "SEO & AI Autopilot",
  description:
    "SEO & AI otomatis tanpa setting rumit: sitemap XML + gambar, robots.txt ramah AI, judul/meta otomatis dari Blueprint, OG WhatsApp < 300 KiB, Schema.org @graph, IndexNow, dan kartu salin GBP & Bing Places.",
  version: "1.0.0",
  visibility: "public_free",
  billingCycle: "free",
  priceIdr: 0,
  tablePrefix: SEO_AI_AUTOPILOT_TABLE_PREFIX,
  permissions: ["tenant_db:plg_tables", "public:head", "admin:page", "admin:api"],
  maxPublicJsBytes: 0,
  slots: {
    hasMigrations: true,
    publicSections: [],
    publicRoutes: [],
    hasAdminPage: true,
    hasAdminApi: true,
    queueHooks: [],
    hasWebhook: false,
    mcpTools: [],
  },
  defaultConfig: {
    separator: DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator,
    autoIndexNow: true,
  },
};

export const SEO_AI_AUTOPILOT_PLUGIN: PluginDefinition = definePlugin({
  manifest: SEO_AI_AUTOPILOT_MANIFEST,
  migrations: SEO_AI_AUTOPILOT_MIGRATIONS,
  adminSlots: {
    configSchema: {
      safeParse(input: unknown) {
        const res = SeoAutopilotPluginConfigSchema.safeParse(input);
        if (!res.success) {
          return { success: false as const, error: res.error };
        }
        return { success: true as const, data: res.data as Record<string, unknown> };
      },
    },
    configFields: [
      {
        key: "separator",
        label: "Pemisah Judul Pencarian",
        description: "Pemisah bawaan untuk token {{sep}} pada template judul.",
        kind: "text",
        placeholder: "|",
      },
      {
        key: "autoIndexNow",
        label: "Kirim notifikasi IndexNow otomatis saat terbit",
        description: "Hanya aktif pada situs berbayar dengan domain khusus terverifikasi.",
        kind: "boolean",
      },
    ],
    async loadState({ db, config }) {
      try {
        const row = await db
          .prepare(
            "SELECT version, published_at, updated_at, draft_json, published_json FROM plg_seo_ai_autopilot__settings WHERE id = 1 LIMIT 1",
          )
          .first<{
            readonly version: number;
            readonly published_at: number | null;
            readonly updated_at: number;
            readonly draft_json: string | null;
            readonly published_json: string | null;
          }>();
        return {
          zeroConfigActive: true,
          defaultActiveOnProvision: SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
          preservesOverridesOnDisable: true,
          settingsVersion: row ? Number(row.version) : 0,
          hasSavedOverrides: Boolean(row?.draft_json || row?.published_json),
          publishedAt: row?.published_at ? new Date(Number(row.published_at)).toISOString() : null,
          autoIndexNow: config.autoIndexNow !== false,
          capabilities: SEO_AI_AUTOPILOT_CAPABILITIES,
        };
      } catch {
        return {
          zeroConfigActive: true,
          defaultActiveOnProvision: SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
          preservesOverridesOnDisable: true,
          settingsVersion: 0,
          hasSavedOverrides: false,
          publishedAt: null,
          autoIndexNow: config.autoIndexNow !== false,
          capabilities: SEO_AI_AUTOPILOT_CAPABILITIES,
        };
      }
    },
    async apiHandler({ request, subPath, db, config, tenant }) {
      const method = request.method.toUpperCase();
      const normalizedSubPath = subPath.replace(/^\/+|\/+$/g, "").toLowerCase();

      if (normalizedSubPath === "status" && method === "GET") {
        let settingsVersion = 0;
        let publishedAt: string | null = null;
        let hasSavedOverrides = false;
        try {
          const row = await db
            .prepare(
              "SELECT version, published_at, draft_json, published_json FROM plg_seo_ai_autopilot__settings WHERE id = 1 LIMIT 1",
            )
            .first<{
              readonly version: number;
              readonly published_at: number | null;
              readonly draft_json: string | null;
              readonly published_json: string | null;
            }>();
          if (row) {
            settingsVersion = Number(row.version);
            publishedAt = row.published_at ? new Date(Number(row.published_at)).toISOString() : null;
            hasSavedOverrides = Boolean(row.draft_json || row.published_json);
          }
        } catch {
          // Table may not yet have custom overrides; zero-config still active
        }

        return new Response(
          JSON.stringify({
            pluginId: SEO_AI_AUTOPILOT_PLUGIN_ID,
            tier: SEO_AI_AUTOPILOT_TIER,
            defaultActiveOnProvision: SEO_AI_AUTOPILOT_DEFAULT_ACTIVE_ON_PROVISION,
            zeroConfigRequired: true,
            preservesOverridesOnDisable: true,
            tenantId: tenant.id,
            settingsVersion,
            hasSavedOverrides,
            publishedAt,
            autoIndexNow: config.autoIndexNow !== false,
            capabilities: SEO_AI_AUTOPILOT_CAPABILITIES,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "private, no-store",
              "X-Robots-Tag": "noindex, nofollow",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "NOT_FOUND",
            message: "Endpoint plugin seo-ai-autopilot tidak ditemukan.",
          },
        }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Robots-Tag": "noindex, nofollow",
          },
        },
      );
    },
  },
});
