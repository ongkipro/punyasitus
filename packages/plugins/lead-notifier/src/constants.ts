import type { PluginConfigSchemaLike, PluginManifest } from "@punyasitus/core/plugins/index";

/**
 * Official First-Party Plugin: `lead-notifier`
 * (`REQ-101`, `ADR-0010`, `DEC-038`, `PLAN §19.7`, `TASK-101`).
 *
 * - Free tier capability (`public_free`): 1-click Telegram Bot linking (`https://t.me/<Bot>?start=<token>`)
 *   and formatted `lead.created` Telegram alert with tap-to-WhatsApp follow-up button.
 * - Commercial / grantable capability (`public_paid` / entitlement-gated): HMAC-SHA256 signed,
 *   SSRF-guarded HTTPS webhook delivery (CRM / Google Sheets / Zapier / n8n) with bounded retries
 *   and test-send endpoint. Entitlement is strictly server-owned and NEVER writable via tenant config.
 */

export const LEAD_NOTIFIER_PLUGIN_ID = "lead-notifier" as const;
export const LEAD_NOTIFIER_TABLE_PREFIX = "plg_lead_notifier__" as const;
export const LEAD_NOTIFIER_DEFAULT_ACTIVE_ON_PROVISION = false as const;

export const LEAD_NOTIFIER_TABLES = {
  linkTokens: `${LEAD_NOTIFIER_TABLE_PREFIX}link_tokens`,
  telegramLinks: `${LEAD_NOTIFIER_TABLE_PREFIX}telegram_links`,
  webhooks: `${LEAD_NOTIFIER_TABLE_PREFIX}webhooks`,
  deliveries: `${LEAD_NOTIFIER_TABLE_PREFIX}deliveries`,
} as const;

export const TELEGRAM_LINK_TOKEN_TTL_MS = 15 * 60 * 1_000; // 15 minutes strict ceiling
export const TELEGRAM_LINK_TOKEN_TTL_SECONDS = 15 * 60;
export const TELEGRAM_START_PARAM_MAX_LEN = 64;
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token" as const;
export const DEFAULT_TELEGRAM_BOT_USERNAME = "PunyaSitusBot" as const;
export const TELEGRAM_API_BASE_URL = "https://api.telegram.org" as const;

export const WEBHOOK_SIGNATURE_HEADER = "X-PunyaSitus-Signature" as const;
export const WEBHOOK_EVENT_HEADER = "X-PunyaSitus-Event" as const;
export const WEBHOOK_DELIVERY_ID_HEADER = "X-PunyaSitus-Delivery-Id" as const;
export const WEBHOOK_TIMESTAMP_HEADER = "X-PunyaSitus-Timestamp" as const;

export const WEBHOOK_DEFAULT_MAX_RETRIES = 3 as const;
export const WEBHOOK_HARD_MAX_RETRIES = 3 as const;
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 3_000 as const;
export const HARD_MAX_OUTBOUND_TIMEOUT_MS = 9_000 as const;
export const DEFAULT_TOTAL_DEADLINE_MS = 9_000 as const;
export const HARD_MAX_TOTAL_DEADLINE_MS = 9_500 as const;
export const DEFAULT_RETRY_BASE_DELAY_MS = 250 as const;
export const MAX_WEBHOOK_REDIRECT_HOPS = 2 as const;
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300 as const;

export interface LeadNotifierCapability {
  readonly id: "telegram_alerts" | "signed_https_webhook";
  readonly tier: "public_free" | "public_paid";
  readonly grantable: boolean;
  readonly label: string;
  readonly description: string;
}

export const LEAD_NOTIFIER_CAPABILITIES: readonly LeadNotifierCapability[] = [
  {
    id: "telegram_alerts",
    tier: "public_free",
    grantable: false,
    label: "Notifikasi Telegram 1-Klik",
    description:
      "Hubungkan chat Telegram pemilik/admin dalam 1 klik tanpa cari chat_id manual, lengkap dengan tombol balas WhatsApp.",
  },
  {
    id: "signed_https_webhook",
    tier: "public_paid",
    grantable: true,
    label: "Webhook HTTPS CRM / Google Sheets",
    description:
      "Kirim data prospek bertanda tangan HMAC-SHA256 dengan proteksi SSRF dan retry terbatas ke CRM, Google Sheets, Zapier, atau n8n.",
  },
] as const;

export interface LeadNotifierConfig {
  readonly telegramEnabled: boolean;
  readonly webhookEnabled: boolean;
  readonly botUsername: string;
  readonly webhookMaxRetries: number;
}

export const DEFAULT_LEAD_NOTIFIER_CONFIG: LeadNotifierConfig = {
  telegramEnabled: true,
  webhookEnabled: false,
  botUsername: DEFAULT_TELEGRAM_BOT_USERNAME,
  webhookMaxRetries: WEBHOOK_DEFAULT_MAX_RETRIES,
};

const BOT_USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

/**
 * Tenant-writable configuration keys ONLY.
 * Entitlement flags (e.g. paid webhook access) are strictly excluded so tenants can NEVER
 * self-grant commercial capabilities via generic plugin config PATCH requests.
 */
const ALLOWED_CONFIG_KEYS = new Set([
  "telegramEnabled",
  "webhookEnabled",
  "botUsername",
  "webhookMaxRetries",
]);

export const LeadNotifierConfigSchema: PluginConfigSchemaLike = {
  safeParse(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false, error: "Konfigurasi plugin harus berupa objek JSON." };
    }
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return { success: false, error: `Kunci konfigurasi "${key}" tidak diizinkan.` };
      }
    }

    if (obj.telegramEnabled !== undefined && typeof obj.telegramEnabled !== "boolean") {
      return { success: false, error: "telegramEnabled harus boolean." };
    }
    if (obj.webhookEnabled !== undefined && typeof obj.webhookEnabled !== "boolean") {
      return { success: false, error: "webhookEnabled harus boolean." };
    }

    let botUsername: string = DEFAULT_TELEGRAM_BOT_USERNAME;
    if (obj.botUsername !== undefined) {
      if (typeof obj.botUsername !== "string" || !BOT_USERNAME_RE.test(obj.botUsername.trim())) {
        return {
          success: false,
          error: "Username bot Telegram harus 5-32 karakter alfanumerik/underscore.",
        };
      }
      botUsername = obj.botUsername.trim();
    }

    let webhookMaxRetries: number = WEBHOOK_DEFAULT_MAX_RETRIES;
    if (obj.webhookMaxRetries !== undefined) {
      if (
        typeof obj.webhookMaxRetries !== "number" ||
        !Number.isInteger(obj.webhookMaxRetries) ||
        obj.webhookMaxRetries < 1 ||
        obj.webhookMaxRetries > WEBHOOK_HARD_MAX_RETRIES
      ) {
        return {
          success: false,
          error: `webhookMaxRetries harus bilangan bulat 1 hingga ${WEBHOOK_HARD_MAX_RETRIES}.`,
        };
      }
      webhookMaxRetries = obj.webhookMaxRetries;
    }

    const data: LeadNotifierConfig = {
      telegramEnabled:
        typeof obj.telegramEnabled === "boolean"
          ? obj.telegramEnabled
          : DEFAULT_LEAD_NOTIFIER_CONFIG.telegramEnabled,
      webhookEnabled:
        typeof obj.webhookEnabled === "boolean"
          ? obj.webhookEnabled
          : DEFAULT_LEAD_NOTIFIER_CONFIG.webhookEnabled,
      botUsername,
      webhookMaxRetries,
    };

    return {
      success: true,
      data: data as unknown as Record<string, unknown>,
    };
  },
};

export const LEAD_NOTIFIER_MANIFEST: PluginManifest = {
  id: LEAD_NOTIFIER_PLUGIN_ID,
  name: "Lead Notifier (Telegram & Webhook)",
  description:
    "Notifikasi prospek masuk otomatis ke Telegram lewat tautan 1 klik (dengan tombol balas WhatsApp) serta webhook HTTPS bertanda tangan HMAC-SHA256 untuk CRM dan Google Sheets.",
  version: "1.0.0",
  visibility: "public_free",
  billingCycle: "free",
  priceIdr: 0,
  tablePrefix: LEAD_NOTIFIER_TABLE_PREFIX,
  permissions: [
    "tenant_db:plg_tables",
    "admin:page",
    "admin:api",
    "queue:lead.created",
    "webhook:inbound",
  ],
  maxPublicJsBytes: 0,
  slots: {
    hasMigrations: true,
    publicSections: [],
    publicRoutes: [],
    hasAdminPage: true,
    hasAdminApi: true,
    queueHooks: ["lead.created"],
    hasWebhook: true,
    mcpTools: [],
  },
  defaultConfig: { ...DEFAULT_LEAD_NOTIFIER_CONFIG },
};

export function parseLeadNotifierConfig(raw: Readonly<Record<string, unknown>>): LeadNotifierConfig {
  const sanitized: Record<string, unknown> = { ...DEFAULT_LEAD_NOTIFIER_CONFIG };
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      sanitized[key] = raw[key];
    }
  }
  const res = LeadNotifierConfigSchema.safeParse(sanitized);
  if (res.success) {
    return res.data as unknown as LeadNotifierConfig;
  }
  return { ...DEFAULT_LEAD_NOTIFIER_CONFIG };
}
