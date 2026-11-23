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

export { SeoAutopilotPluginConfigSchema, type SeoAutopilotPluginConfig };

/**
 * First-Party `public_free` Zero-Config Plugin: `seo-ai-autopilot`
 * (`DEC-039`, `REQ-052..055`, `REQ-066`, `REQ-095`, `REQ-102`, `TASK-052`).
 *
 * - Table prefix strictly isolated to `plg_seo_ai_autopilot__*`.
 * - Zero public JS overhead (`maxPublicJsBytes: 0`).
 * - Works 100% automatically with zero required settings; manual overrides live in
 *   the collapsed-by-default editor drawer and `/dashboard/[handle]/plugins/seo-ai-autopilot`.
 */

export const SEO_AI_AUTOPILOT_PLUGIN_ID = "seo-ai-autopilot" as const;
export const SEO_AI_AUTOPILOT_TABLE_PREFIX = "plg_seo_ai_autopilot__" as const;

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
    "SEO & AI otomatis tanpa setting rumit: template tampilan pencarian, pratinjau Google/WhatsApp, daftar periksa konten, dan verifikasi Google/Bing.",
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
    async loadState({ db }) {
      try {
        const row = await db
          .prepare("SELECT version, published_at, updated_at FROM plg_seo_ai_autopilot__settings WHERE id = 1 LIMIT 1")
          .first<{
            readonly version: number;
            readonly published_at: number | null;
            readonly updated_at: number;
          }>();
        return {
          settingsVersion: row ? Number(row.version) : 0,
          publishedAt: row?.published_at ? new Date(Number(row.published_at)).toISOString() : null,
        };
      } catch {
        return { settingsVersion: 0, publishedAt: null };
      }
    },
  },
});
