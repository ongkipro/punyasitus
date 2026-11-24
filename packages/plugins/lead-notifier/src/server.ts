import {
  definePlugin,
  type PluginDefinition,
  type PluginTenantDb,
} from "@punyasitus/core/plugins/index";
import {
  DEFAULT_TELEGRAM_BOT_USERNAME,
  DEFAULT_TOTAL_DEADLINE_MS,
  LEAD_NOTIFIER_CAPABILITIES,
  LEAD_NOTIFIER_MANIFEST,
  LEAD_NOTIFIER_PLUGIN_ID,
  LEAD_NOTIFIER_TABLES,
  LeadNotifierConfigSchema,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  WEBHOOK_DEFAULT_MAX_RETRIES,
  WEBHOOK_HARD_MAX_RETRIES,
  parseLeadNotifierConfig,
} from "./constants.ts";
import {
  generateDeliveryId,
  generateWebhookSigningSecret,
  maskSigningSecret,
  sha256Hex,
  verifyTelegramWebhookSecret,
} from "./crypto.ts";
import {
  deliverSignedHttpsWebhook,
  deliverTelegramLeadAlert,
  recordDeliveryLogBestEffort,
  type DeliveryTransportOptions,
} from "./delivery.ts";
import { normalizeLeadPayload } from "./formatter.ts";
import { LEAD_NOTIFIER_MIGRATIONS } from "./migrations.ts";
import { validateWebhookTargetUrl } from "./ssrf.ts";
import {
  generateTelegramLinkToken,
  maskTelegramChatLabel,
  parseTelegramLinkToken,
  parseTelegramStartUpdate,
  sanitizeWebhookTargetSummary,
} from "./tokens.ts";

/**
 * `lead-notifier` Server Slots (Admin JSON API, Telegram Webhook, and `lead.created` Queue Hook)
 * (`REQ-101`, `ADR-0010`, `PLAN §19.7`, `TASK-101`).
 */

export interface LeadNotifierServerEntitlementContext {
  readonly webhookEntitled?: boolean;
  readonly capabilities?: readonly string[];
  readonly sourceKind?: string | null;
}

export interface LeadNotifierPluginRuntimeOptions {
  /** Override platform Telegram webhook secret (defaults to env.TELEGRAM_WEBHOOK_SECRET). */
  readonly webhookSecret?: string;
  /** Override platform Telegram Bot API token (falls back to ctx.env.TELEGRAM_BOT_TOKEN -> process.env). */
  readonly telegramBotToken?: string;
  /** Override platform Telegram bot username (falls back to ctx.env -> config -> PunyaSitusBot). */
  readonly telegramBotUsername?: string;
  /** Override Telegram Bot API base URL (defaults to https://api.telegram.org). */
  readonly telegramApiBaseUrl?: string;
  /**
   * Server-owned paid webhook entitlement resolver (NEVER read from tenant-writable config JSON).
   * Used by platform billing/operator grants or deterministic integration tests.
   */
  readonly isWebhookEntitled?: (tenantId: string) => Promise<boolean> | boolean;
  /** Optional static server-owned allowlist of tenant IDs granted the paid webhook capability. */
  readonly webhookEntitledTenantIds?: ReadonlySet<string> | readonly string[];
  /** Override outbound fetch & retry timing for deterministic unit/integration tests. */
  readonly transport?: DeliveryTransportOptions;
}

interface TelegramLinkRow {
  readonly tenant_id: string;
  readonly chat_id: string;
  readonly chat_type: string;
  readonly masked_label: string;
  readonly linked_by_user_id: string;
  readonly linked_at: number;
  readonly active: number;
  readonly revoked_at: number | null;
}

interface WebhookRow {
  readonly tenant_id: string;
  readonly target_url: string;
  readonly signing_secret: string;
  readonly secret_masked: string;
  readonly enabled: number;
  readonly max_retries: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly secret_rotated_at: number;
}

interface DeliveryRow {
  readonly id: number;
  readonly delivery_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly lead_id: number | null;
  readonly channel: string;
  readonly status: string;
  readonly http_status: number | null;
  readonly attempts: number;
  readonly error_code: string | null;
  readonly target_summary: string | null;
  readonly created_at: number;
  readonly completed_at: number;
}

const PRIVATE_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const SETTINGS_WRITE_ROLES = new Set(["owner", "admin", "agency_admin", "super_admin"]);
const PAID_ENTITLEMENT_SOURCES = new Set([
  "paid_once",
  "paid_monthly",
  "paid_yearly",
  "private_grant",
]);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: PRIVATE_JSON_HEADERS,
  });
}

function readOptionalProcessEnv(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const val = process.env[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

function readRuntimeCtxEnvString(ctx: unknown, key: string): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const envBag = (ctx as { readonly env?: Record<string, unknown> }).env;
  if (!envBag || typeof envBag !== "object") return undefined;
  const val = envBag[key];
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;
}

/**
 * Resolves `TELEGRAM_BOT_TOKEN` strictly preferring:
 * 1. Explicit factory option (`options.telegramBotToken`)
 * 2. Workers runtime `ctx.env.TELEGRAM_BOT_TOKEN` / `LEAD_NOTIFIER_TELEGRAM_BOT_TOKEN`
 * 3. Node `process.env.TELEGRAM_BOT_TOKEN` / `LEAD_NOTIFIER_TELEGRAM_BOT_TOKEN` fallback
 */
export function resolveTelegramBotToken(
  ctx?: unknown,
  options?: LeadNotifierPluginRuntimeOptions,
): string {
  return (
    options?.telegramBotToken?.trim() ||
    readRuntimeCtxEnvString(ctx, "TELEGRAM_BOT_TOKEN") ||
    readRuntimeCtxEnvString(ctx, "LEAD_NOTIFIER_TELEGRAM_BOT_TOKEN") ||
    readOptionalProcessEnv("TELEGRAM_BOT_TOKEN") ||
    readOptionalProcessEnv("LEAD_NOTIFIER_TELEGRAM_BOT_TOKEN") ||
    ""
  );
}

function resolveTelegramBotUsername(
  ctx: unknown,
  config: Readonly<Record<string, unknown>>,
  options?: LeadNotifierPluginRuntimeOptions,
): string {
  const parsed = parseLeadNotifierConfig(config);
  return (
    options?.telegramBotUsername?.trim() ||
    readRuntimeCtxEnvString(ctx, "TELEGRAM_BOT_USERNAME") ||
    parsed.botUsername ||
    readOptionalProcessEnv("TELEGRAM_BOT_USERNAME") ||
    DEFAULT_TELEGRAM_BOT_USERNAME
  );
}

export function canViewFullWebhookTargetUrl(actorRole: string): boolean {
  return SETTINGS_WRITE_ROLES.has(actorRole.trim().toLowerCase());
}

/**
 * Evaluates server-owned commercial/grantable entitlement for the Signed HTTPS Webhook capability.
 *
 * SECURITY INVARIANT (HIGH-1):
 * NEVER reads tenant-writable `installed_plugins.config_json` (`config.webhookEntitled` is
 * rejected by `LeadNotifierConfigSchema` and ignored even if forged directly).
 * Entitlement comes EXCLUSIVELY from:
 * 1. Runtime-supplied server entitlement object (`ctx.entitlement`) from `PLATFORM_DB`
 * 2. Server-only factory resolver (`options.isWebhookEntitled(tenantId)` or `options.webhookEntitledTenantIds`)
 */
export async function resolveWebhookEntitlement(input: {
  readonly tenantId: string;
  readonly ctx?: unknown;
  readonly options?: LeadNotifierPluginRuntimeOptions;
}): Promise<boolean> {
  if (input.ctx && typeof input.ctx === "object") {
    const ent = (input.ctx as { readonly entitlement?: LeadNotifierServerEntitlementContext })
      .entitlement;
    if (ent && typeof ent === "object") {
      if (ent.webhookEntitled === true) return true;
      if (Array.isArray(ent.capabilities) && ent.capabilities.includes("signed_https_webhook")) {
        return true;
      }
      if (typeof ent.sourceKind === "string" && PAID_ENTITLEMENT_SOURCES.has(ent.sourceKind)) {
        return true;
      }
    }
  }

  const staticIds = input.options?.webhookEntitledTenantIds;
  if (staticIds) {
    if (staticIds instanceof Set) {
      if (staticIds.has(input.tenantId)) return true;
    } else if (Array.isArray(staticIds) && staticIds.includes(input.tenantId)) {
      return true;
    }
  }

  if (typeof input.options?.isWebhookEntitled === "function") {
    try {
      return Boolean(await input.options.isWebhookEntitled(input.tenantId));
    } catch {
      return false;
    }
  }

  return false;
}

async function readTelegramLink(db: PluginTenantDb, tenantId: string): Promise<TelegramLinkRow | null> {
  try {
    const row = await db
      .prepare(
        `SELECT tenant_id, chat_id, chat_type, masked_label, linked_by_user_id, linked_at, active, revoked_at
         FROM ${LEAD_NOTIFIER_TABLES.telegramLinks}
         WHERE id = 1 AND tenant_id = ?
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<TelegramLinkRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

async function readWebhookConfig(db: PluginTenantDb, tenantId: string): Promise<WebhookRow | null> {
  try {
    const row = await db
      .prepare(
        `SELECT tenant_id, target_url, signing_secret, secret_masked, enabled, max_retries,
                created_at, updated_at, secret_rotated_at
         FROM ${LEAD_NOTIFIER_TABLES.webhooks}
         WHERE id = 1 AND tenant_id = ?
         LIMIT 1`,
      )
      .bind(tenantId)
      .first<WebhookRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

async function readRecentDeliveries(
  db: PluginTenantDb,
  tenantId: string,
  limit = 20,
): Promise<readonly DeliveryRow[]> {
  try {
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const res = await db
      .prepare(
        `SELECT id, delivery_id, event_id, event_name, lead_id, channel, status,
                http_status, attempts, error_code, target_summary, created_at, completed_at
         FROM ${LEAD_NOTIFIER_TABLES.deliveries}
         WHERE tenant_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(tenantId, safeLimit)
      .all<DeliveryRow>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

async function parseJsonObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serializeDeliveryRow(row: DeliveryRow) {
  return {
    deliveryId: row.delivery_id,
    eventId: row.event_id,
    eventName: row.event_name,
    leadId: row.lead_id,
    channel: row.channel,
    status: row.status,
    httpStatus: row.http_status,
    attempts: Number(row.attempts),
    errorCode: row.error_code,
    targetSummary: row.target_summary,
    createdAt: Number(row.created_at),
    completedAt: Number(row.completed_at),
  };
}

/**
 * Factory creating the official `lead-notifier` PluginDefinition.
 * Accepts optional server-only entitlement resolver and transport/secret overrides for tests.
 */
export function createLeadNotifierPlugin(
  options: LeadNotifierPluginRuntimeOptions = {},
): PluginDefinition {
  return definePlugin({
    manifest: LEAD_NOTIFIER_MANIFEST,
    migrations: LEAD_NOTIFIER_MIGRATIONS,

    adminSlots: {
      configSchema: LeadNotifierConfigSchema,
      configFields: [
        {
          key: "telegramEnabled",
          label: "Aktifkan Notifikasi Telegram (Gratis)",
          description:
            "Kirim ringkasan prospek baru ke chat Telegram yang terhubung lengkap dengan tombol balas WhatsApp.",
          kind: "boolean",
        },
        {
          key: "webhookEnabled",
          label: "Aktifkan Webhook HTTPS CRM / Google Sheets",
          description:
            "Memerlukan lisensi add-on Webhook aktif. Payload ditandatangani HMAC-SHA256 dengan proteksi SSRF.",
          kind: "boolean",
        },
        {
          key: "webhookMaxRetries",
          label: "Batas Percobaan Ulang Webhook (1-3)",
          description: "Jumlah maksimal percobaan pengiriman webhook saat endpoint tujuan 5xx/timeout.",
          kind: "number",
          placeholder: "3",
        },
      ],

      async loadState(ctx) {
        const { tenant, db } = ctx;
        const tg = await readTelegramLink(db, tenant.id);
        const wh = await readWebhookConfig(db, tenant.id);
        const deliveries = await readRecentDeliveries(db, tenant.id, 10);
        const entitledWebhook = await resolveWebhookEntitlement({
          tenantId: tenant.id,
          ctx,
          options,
        });

        return {
          telegramLinked: Boolean(tg && tg.active === 1 && tg.chat_id),
          telegramMaskedLabel: tg && tg.active === 1 ? tg.masked_label : null,
          telegramLinkedAt: tg && tg.active === 1 ? Number(tg.linked_at) : null,
          webhookEntitled: entitledWebhook,
          webhookConfigured: Boolean(wh && wh.enabled === 1 && wh.target_url),
          webhookSecretMasked: wh ? wh.secret_masked : null,
          recentDeliveryCount: deliveries.length,
        };
      },

      async apiHandler(ctx) {
        const { tenant, actorUserId, actorRole, request, subPath, config, db, nowMs } = ctx;
        const method = request.method.toUpperCase();
        const normalizedPath = `/${subPath.replace(/^\/+|\/+$/g, "").toLowerCase()}`;
        const parsedConfig = parseLeadNotifierConfig(config);
        const webhookEntitled = await resolveWebhookEntitlement({
          tenantId: tenant.id,
          ctx,
          options,
        });

        // 1. GET /status — complete status snapshot (never leaks raw chat_id or signing_secret;
        //    masks full webhook targetUrl path for non-settings:write roles such as editor)
        if ((normalizedPath === "/status" || normalizedPath === "/") && method === "GET") {
          const tg = await readTelegramLink(db, tenant.id);
          const wh = await readWebhookConfig(db, tenant.id);
          const deliveries = await readRecentDeliveries(db, tenant.id, 20);
          const isLinked = Boolean(tg && tg.active === 1 && tg.chat_id);
          const exposeFullUrl = canViewFullWebhookTargetUrl(actorRole);
          const hasTargetUrl = Boolean(wh && wh.target_url);

          return jsonResponse(200, {
            pluginId: LEAD_NOTIFIER_PLUGIN_ID,
            tenantId: tenant.id,
            capabilities: LEAD_NOTIFIER_CAPABILITIES,
            telegram: {
              enabled: parsedConfig.telegramEnabled,
              linked: isLinked,
              maskedLabel: isLinked && tg ? tg.masked_label : null,
              chatType: isLinked && tg ? tg.chat_type : null,
              linkedAt: isLinked && tg ? Number(tg.linked_at) : null,
              botUsername: resolveTelegramBotUsername(ctx, config, options),
              tokenTtlSeconds: 900,
            },
            webhook: {
              entitled: webhookEntitled,
              configured: hasTargetUrl,
              enabled: Boolean(wh && wh.enabled === 1 && hasTargetUrl && parsedConfig.webhookEnabled),
              targetUrl: exposeFullUrl && wh && hasTargetUrl ? wh.target_url : null,
              targetUrlSummary:
                wh && hasTargetUrl ? sanitizeWebhookTargetSummary(wh.target_url) : null,
              secretMasked: wh ? wh.secret_masked : null,
              maxRetries: wh ? Number(wh.max_retries) : parsedConfig.webhookMaxRetries,
              secretRotatedAt: wh ? Number(wh.secret_rotated_at) : null,
              updatedAt: wh ? Number(wh.updated_at) : null,
            },
            deliveries: deliveries.map(serializeDeliveryRow),
          });
        }

        // 2. POST /telegram/link-token — generate 15m single-use deep link (stores SHA-256 hash only)
        if (normalizedPath === "/telegram/link-token" && method === "POST") {
          const botUsername = resolveTelegramBotUsername(ctx, config, options);
          const generated = await generateTelegramLinkToken({
            tenantId: tenant.id,
            botUsername,
            nowMs,
          });

          await db
            .prepare(
              `INSERT INTO ${LEAD_NOTIFIER_TABLES.linkTokens} (
                 token_hash, tenant_id, user_id, created_at, expires_at, used_at, consumed_chat_id
               ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
            )
            .bind(
              generated.tokenHash,
              tenant.id,
              actorUserId,
              generated.createdAt,
              generated.expiresAt,
            )
            .run();

          return jsonResponse(201, {
            deepLink: generated.deepLink,
            botUsername: generated.botUsername,
            expiresAt: generated.expiresAt,
            expiresInSeconds: generated.expiresInSeconds,
            singleUse: true,
          });
        }

        // 3. POST /telegram/unlink or DELETE /telegram/link — immediate revocation
        if (
          (normalizedPath === "/telegram/unlink" && method === "POST") ||
          (normalizedPath === "/telegram/link" && method === "DELETE")
        ) {
          await db
            .prepare(
              `UPDATE ${LEAD_NOTIFIER_TABLES.telegramLinks}
               SET active = 0, chat_id = '', revoked_at = ?, revoked_by_user_id = ?
               WHERE id = 1 AND tenant_id = ?`,
            )
            .bind(nowMs, actorUserId, tenant.id)
            .run();

          // Invalidate any pending unconsumed link tokens for this tenant
          await db
            .prepare(
              `UPDATE ${LEAD_NOTIFIER_TABLES.linkTokens}
               SET used_at = ?
               WHERE tenant_id = ? AND used_at IS NULL`,
            )
            .bind(nowMs, tenant.id)
            .run();

          return jsonResponse(200, {
            ok: true,
            linked: false,
            revokedAt: nowMs,
          });
        }

        // 4. POST / PUT /webhook — configure SSRF-guarded HTTPS webhook (server entitlement-gated)
        if (normalizedPath === "/webhook" && (method === "POST" || method === "PUT")) {
          if (!webhookEntitled) {
            return jsonResponse(403, {
              error: {
                code: "WEBHOOK_ENTITLEMENT_REQUIRED",
                message:
                  "Fitur Webhook HTTPS CRM/Sheets memerlukan lisensi add-on aktif atau pemberian akses dari operator.",
              },
            });
          }

          const body = await parseJsonObjectBody(request);
          if (!body) {
            return jsonResponse(400, {
              error: { code: "BAD_REQUEST", message: "Body JSON tidak valid." },
            });
          }

          const urlCheck = validateWebhookTargetUrl(body.targetUrl);
          if (!urlCheck.ok) {
            return jsonResponse(422, {
              error: {
                code: urlCheck.code,
                message: urlCheck.message,
              },
            });
          }

          const enabledFlag = body.enabled !== false ? 1 : 0;
          const rawRetries =
            typeof body.maxRetries === "number" && Number.isInteger(body.maxRetries)
              ? Math.min(WEBHOOK_HARD_MAX_RETRIES, Math.max(1, body.maxRetries))
              : WEBHOOK_DEFAULT_MAX_RETRIES;

          const existing = await readWebhookConfig(db, tenant.id);
          const shouldRotate = !existing || body.rotateSecret === true;
          const signingSecret = shouldRotate
            ? generateWebhookSigningSecret()
            : existing.signing_secret;
          const secretMasked = maskSigningSecret(signingSecret);
          const secretRotatedAt = shouldRotate ? nowMs : Number(existing.secret_rotated_at);

          await db
            .prepare(
              `INSERT INTO ${LEAD_NOTIFIER_TABLES.webhooks} (
                 id, tenant_id, target_url, signing_secret, secret_masked,
                 enabled, max_retries, created_at, updated_at, secret_rotated_at
               ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 tenant_id = excluded.tenant_id,
                 target_url = excluded.target_url,
                 signing_secret = excluded.signing_secret,
                 secret_masked = excluded.secret_masked,
                 enabled = excluded.enabled,
                 max_retries = excluded.max_retries,
                 updated_at = excluded.updated_at,
                 secret_rotated_at = excluded.secret_rotated_at`,
            )
            .bind(
              tenant.id,
              urlCheck.normalizedUrl,
              signingSecret,
              secretMasked,
              enabledFlag,
              rawRetries,
              existing ? Number(existing.created_at) : nowMs,
              nowMs,
              secretRotatedAt,
            )
            .run();

          return jsonResponse(200, {
            webhook: {
              entitled: true,
              configured: true,
              enabled: enabledFlag === 1,
              targetUrl: urlCheck.normalizedUrl,
              targetUrlSummary: sanitizeWebhookTargetSummary(urlCheck.normalizedUrl),
              secretMasked,
              maxRetries: rawRetries,
              secretRotatedAt,
              updatedAt: nowMs,
            },
            ...(shouldRotate ? { secretOnce: signingSecret } : {}),
          });
        }

        // 5. DELETE /webhook — disable and clear webhook target immediately
        if (normalizedPath === "/webhook" && method === "DELETE") {
          await db
            .prepare(
              `UPDATE ${LEAD_NOTIFIER_TABLES.webhooks}
               SET enabled = 0, target_url = '', updated_at = ?
               WHERE id = 1 AND tenant_id = ?`,
            )
            .bind(nowMs, tenant.id)
            .run();

          return jsonResponse(200, {
            ok: true,
            configured: false,
            enabled: false,
          });
        }

        // 6. POST /webhook/rotate-secret — rotate HMAC-SHA256 signing secret
        if (normalizedPath === "/webhook/rotate-secret" && method === "POST") {
          if (!webhookEntitled) {
            return jsonResponse(403, {
              error: {
                code: "WEBHOOK_ENTITLEMENT_REQUIRED",
                message: "Fitur Webhook HTTPS CRM/Sheets memerlukan lisensi add-on aktif.",
              },
            });
          }

          const existing = await readWebhookConfig(db, tenant.id);
          if (!existing || !existing.target_url) {
            return jsonResponse(404, {
              error: {
                code: "WEBHOOK_NOT_CONFIGURED",
                message: "Simpan URL webhook terlebih dahulu sebelum memutar rahasia penandatanganan.",
              },
            });
          }

          const newSecret = generateWebhookSigningSecret();
          const masked = maskSigningSecret(newSecret);

          await db
            .prepare(
              `UPDATE ${LEAD_NOTIFIER_TABLES.webhooks}
               SET signing_secret = ?, secret_masked = ?, secret_rotated_at = ?, updated_at = ?
               WHERE id = 1 AND tenant_id = ?`,
            )
            .bind(newSecret, masked, nowMs, nowMs, tenant.id)
            .run();

          return jsonResponse(200, {
            secretOnce: newSecret,
            secretMasked: masked,
            secretRotatedAt: nowMs,
          });
        }

        // 7. POST /webhook/test — send signed test webhook event with SSRF guard
        if (normalizedPath === "/webhook/test" && method === "POST") {
          if (!webhookEntitled) {
            return jsonResponse(403, {
              error: {
                code: "WEBHOOK_ENTITLEMENT_REQUIRED",
                message: "Fitur Webhook HTTPS CRM/Sheets memerlukan lisensi add-on aktif.",
              },
            });
          }

          const body = (await parseJsonObjectBody(request)) ?? {};
          const existing = await readWebhookConfig(db, tenant.id);
          const candidateUrl =
            typeof body.targetUrl === "string" && body.targetUrl.trim().length > 0
              ? body.targetUrl.trim()
              : existing?.target_url ?? "";

          if (!candidateUrl) {
            return jsonResponse(422, {
              error: {
                code: "WEBHOOK_NOT_CONFIGURED",
                message: "URL webhook belum dikonfigurasi.",
              },
            });
          }

          const urlCheck = validateWebhookTargetUrl(candidateUrl);
          if (!urlCheck.ok) {
            return jsonResponse(422, {
              error: {
                code: urlCheck.code,
                message: urlCheck.message,
              },
            });
          }

          const signingSecret = existing?.signing_secret || generateWebhookSigningSecret();
          const testEventId = generateDeliveryId("evt_test");
          const sampleLead = normalizeLeadPayload(
            {
              leadId: 0,
              name: "Budi Santoso (Uji Coba)",
              phoneE164: "+6281234567890",
              email: "uji@contoh.id",
              message: "Ini adalah pengiriman uji webhook dari plugin Lead Notifier PunyaSitus.",
              pagePath: "/kontak",
              sourceCategory: "direct",
              tenantName: tenant.name,
              tenantHandle: tenant.handle,
            },
            {
              tenantId: tenant.id,
              eventId: testEventId,
              nowMs,
              fallbackTenantName: tenant.name,
              fallbackTenantHandle: tenant.handle,
            },
          );

          const delivery = await deliverSignedHttpsWebhook({
            targetUrl: urlCheck.normalizedUrl,
            signingSecret,
            lead: sampleLead,
            eventName: "lead.test",
            maxRetries: existing ? Number(existing.max_retries) : WEBHOOK_DEFAULT_MAX_RETRIES,
            transport: {
              totalDeadlineMs: DEFAULT_TOTAL_DEADLINE_MS,
              ...options.transport,
              nowMs: options.transport?.nowMs ?? (() => nowMs),
            },
          });

          await recordDeliveryLogBestEffort(db, {
            deliveryId: delivery.deliveryId,
            tenantId: tenant.id,
            eventId: testEventId,
            eventName: "lead.test",
            leadId: null,
            channel: "webhook",
            status: delivery.status,
            httpStatus: delivery.httpStatus,
            attempts: delivery.attempts,
            errorCode: delivery.errorCode,
            targetSummary: delivery.targetSummary,
            createdAt: nowMs,
            completedAt: nowMs,
          });

          return jsonResponse(delivery.ok ? 200 : 502, {
            ok: delivery.ok,
            delivery: {
              deliveryId: delivery.deliveryId,
              status: delivery.status,
              httpStatus: delivery.httpStatus,
              attempts: delivery.attempts,
              errorCode: delivery.errorCode,
              targetSummary: delivery.targetSummary,
            },
          });
        }

        // 8. GET /deliveries — recent scrubbed delivery history
        if (normalizedPath === "/deliveries" && method === "GET") {
          const rows = await readRecentDeliveries(db, tenant.id, 30);
          return jsonResponse(200, {
            deliveries: rows.map(serializeDeliveryRow),
          });
        }

        return jsonResponse(404, {
          error: {
            code: "NOT_FOUND",
            message: "Endpoint plugin lead-notifier tidak ditemukan.",
          },
        });
      },
    },

    // Slot 4a: Secret-verified Telegram Bot Webhook (`POST /api/plugins/lead-notifier/webhook`)
    webhook: {
      secretHeaderName: TELEGRAM_WEBHOOK_SECRET_HEADER,

      verifySecret(request, runtimeEnv) {
        return verifyTelegramWebhookSecret(request, runtimeEnv, options.webhookSecret);
      },

      resolveTenantTarget(_request, rawBody) {
        const update = parseTelegramStartUpdate(rawBody);
        if (!update) {
          return null;
        }
        return {
          tenantId: update.tenantId,
          payload: {
            updateId: update.updateId,
            token: update.token,
            chatId: update.chatId,
            chatType: update.chatType,
            username: update.username,
            displayName: update.displayName,
          },
        };
      },

      async handle({ tenant, db, payload, nowMs }) {
        // NOTE (MEDIUM-2): `verifySecret` has ALREADY verified `X-Telegram-Bot-Api-Secret-Token`
        // (returning 401 when missing/wrong). Once authenticated as Telegram traffic, rejected
        // `/start <token>` updates MUST return HTTP 200 `{ ok: false, linked: false, rejected: true, code }`
        // so Telegram does not retry and stall updates for all other tenants sharing the platform bot!
        const rawToken = typeof payload.token === "string" ? payload.token : "";
        const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
        const chatType = typeof payload.chatType === "string" ? payload.chatType : "private";
        const username = typeof payload.username === "string" ? payload.username : null;
        const displayName = typeof payload.displayName === "string" ? payload.displayName : null;

        const parsedToken = parseTelegramLinkToken(rawToken);
        if (!parsedToken || !chatId) {
          return jsonResponse(200, {
            ok: false,
            linked: false,
            rejected: true,
            code: "TOKEN_INVALID",
            message: "Token tautan Telegram tidak valid.",
          });
        }
        if (parsedToken.tenantId !== tenant.id) {
          return jsonResponse(200, {
            ok: false,
            linked: false,
            rejected: true,
            code: "TOKEN_TENANT_MISMATCH",
            message: "Token tautan Telegram tidak cocok dengan situs target.",
          });
        }

        const tokenHash = await sha256Hex(parsedToken.rawToken);

        // Atomic single-use token consumption: succeeds ONLY if unused, unexpired, and same tenant!
        const consumeRes = await db
          .prepare(
            `UPDATE ${LEAD_NOTIFIER_TABLES.linkTokens}
             SET used_at = ?, consumed_chat_id = ?
             WHERE token_hash = ?
               AND tenant_id = ?
               AND used_at IS NULL
               AND expires_at > ?`,
          )
          .bind(nowMs, chatId, tokenHash, tenant.id, nowMs)
          .run();

        const changes = Number(consumeRes.meta?.changes ?? 0);
        if (changes !== 1) {
          const existing = await db
            .prepare(
              `SELECT tenant_id, expires_at, used_at
               FROM ${LEAD_NOTIFIER_TABLES.linkTokens}
               WHERE token_hash = ?
               LIMIT 1`,
            )
            .bind(tokenHash)
            .first<{
              readonly tenant_id: string;
              readonly expires_at: number;
              readonly used_at: number | null;
            }>();

          if (!existing) {
            return jsonResponse(200, {
              ok: false,
              linked: false,
              rejected: true,
              code: "TOKEN_INVALID",
              message: "Token tautan Telegram tidak ditemukan.",
            });
          }

          if (existing.tenant_id !== tenant.id) {
            return jsonResponse(200, {
              ok: false,
              linked: false,
              rejected: true,
              code: "TOKEN_TENANT_MISMATCH",
              message: "Token tautan Telegram tidak sesuai dengan situs ini.",
            });
          }

          if (existing.used_at !== null) {
            return jsonResponse(200, {
              ok: false,
              linked: false,
              rejected: true,
              code: "TOKEN_REPLAYED",
              message: "Token tautan Telegram sudah pernah digunakan (replay ditolak).",
            });
          }

          return jsonResponse(200, {
            ok: false,
            linked: false,
            rejected: true,
            code: "TOKEN_EXPIRED",
            message: "Token tautan Telegram sudah kedaluwarsa (batas 15 menit terlampaui).",
          });
        }

        const tokenOwner = await db
          .prepare(
            `SELECT user_id
             FROM ${LEAD_NOTIFIER_TABLES.linkTokens}
             WHERE token_hash = ?
             LIMIT 1`,
          )
          .bind(tokenHash)
          .first<{ readonly user_id: string }>();

        const maskedLabel = maskTelegramChatLabel({
          username,
          displayName,
          chatId,
        });

        // Upsert active link strictly for this tenant (`ON CONFLICT DO UPDATE`, zero REPLACE keyword)
        await db
          .prepare(
            `INSERT INTO ${LEAD_NOTIFIER_TABLES.telegramLinks} (
               id, tenant_id, chat_id, chat_type, masked_label,
               linked_by_user_id, linked_at, active, revoked_at, revoked_by_user_id
             ) VALUES (1, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
               tenant_id = excluded.tenant_id,
               chat_id = excluded.chat_id,
               chat_type = excluded.chat_type,
               masked_label = excluded.masked_label,
               linked_by_user_id = excluded.linked_by_user_id,
               linked_at = excluded.linked_at,
               active = 1,
               revoked_at = NULL,
               revoked_by_user_id = NULL`,
          )
          .bind(
            tenant.id,
            chatId,
            chatType,
            maskedLabel,
            tokenOwner?.user_id ?? "system",
            nowMs,
          )
          .run();

        return jsonResponse(200, {
          ok: true,
          linked: true,
          rejected: false,
          tenantId: tenant.id,
          maskedLabel,
          linkedAt: nowMs,
        });
      },
    },

    // Slot 4b: Non-Blocking Fault-Isolated `lead.created` Queue Hook
    queueHooks: {
      "lead.created": {
        timeoutMs: 12_000,
        async execute(ctx) {
          // HARD INVARIANT: NEVER throw unhandled errors that block or fail lead persistence!
          // Both channels run concurrently under a shared <= 9.5s global deadline budget.
          try {
            const parsedConfig = parseLeadNotifierConfig(ctx.config);
            const lead = normalizeLeadPayload(ctx.payload, {
              tenantId: ctx.tenantId,
              eventId: ctx.eventId,
              nowMs: ctx.nowMs,
            });
            const sharedTotalDeadlineMs = Math.min(
              DEFAULT_TOTAL_DEADLINE_MS,
              options.transport?.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS,
            );

            const tasks: Promise<void>[] = [];

            // 1. Free tier: Telegram alert with tap-to-WhatsApp CTA (when linked & enabled)
            if (parsedConfig.telegramEnabled) {
              tasks.push(
                (async () => {
                  try {
                    const tgLink = await readTelegramLink(ctx.db, ctx.tenantId);
                    if (tgLink && tgLink.active === 1 && tgLink.chat_id.trim().length > 0) {
                      const botToken = resolveTelegramBotToken(ctx, options);
                      const tgResult = await deliverTelegramLeadAlert({
                        botToken,
                        chatId: tgLink.chat_id,
                        maskedChatLabel: tgLink.masked_label,
                        lead,
                        apiBaseUrl: options.telegramApiBaseUrl,
                        transport: {
                          ...options.transport,
                          totalDeadlineMs: sharedTotalDeadlineMs,
                          nowMs: options.transport?.nowMs ?? (() => ctx.nowMs),
                        },
                      });

                      await recordDeliveryLogBestEffort(ctx.db, {
                        deliveryId: tgResult.deliveryId,
                        tenantId: ctx.tenantId,
                        eventId: ctx.eventId,
                        eventName: "lead.created",
                        leadId: lead.leadId,
                        channel: "telegram",
                        status: tgResult.status,
                        httpStatus: tgResult.httpStatus,
                        attempts: tgResult.attempts,
                        errorCode: tgResult.errorCode,
                        targetSummary: tgResult.targetSummary,
                        createdAt: ctx.nowMs,
                        completedAt: Date.now(),
                      });
                    }
                  } catch {
                    await recordDeliveryLogBestEffort(ctx.db, {
                      deliveryId: generateDeliveryId("tg_err"),
                      tenantId: ctx.tenantId,
                      eventId: ctx.eventId,
                      eventName: "lead.created",
                      leadId: lead.leadId,
                      channel: "telegram",
                      status: "failed",
                      httpStatus: null,
                      attempts: 1,
                      errorCode: "TELEGRAM_HOOK_EXCEPTION",
                      targetSummary: "Telegram",
                      createdAt: ctx.nowMs,
                      completedAt: Date.now(),
                    });
                  }
                })(),
              );
            }

            // 2. Commercial / grantable tier: HMAC-SHA256 signed SSRF-guarded HTTPS Webhook
            //    Requires ALL THREE: server-owned entitlement AND `parsedConfig.webhookEnabled` AND saved `wh.enabled === 1`
            if (parsedConfig.webhookEnabled) {
              tasks.push(
                (async () => {
                  try {
                    const webhookEntitled = await resolveWebhookEntitlement({
                      tenantId: ctx.tenantId,
                      ctx,
                      options,
                    });
                    if (!webhookEntitled) return;

                    const wh = await readWebhookConfig(ctx.db, ctx.tenantId);
                    if (wh && wh.enabled === 1 && wh.target_url.trim().length > 0) {
                      const whResult = await deliverSignedHttpsWebhook({
                        targetUrl: wh.target_url,
                        signingSecret: wh.signing_secret,
                        lead,
                        eventName: "lead.created",
                        maxRetries: Number(wh.max_retries) || parsedConfig.webhookMaxRetries,
                        transport: {
                          ...options.transport,
                          totalDeadlineMs: sharedTotalDeadlineMs,
                          nowMs: options.transport?.nowMs ?? (() => ctx.nowMs),
                        },
                      });

                      await recordDeliveryLogBestEffort(ctx.db, {
                        deliveryId: whResult.deliveryId,
                        tenantId: ctx.tenantId,
                        eventId: ctx.eventId,
                        eventName: "lead.created",
                        leadId: lead.leadId,
                        channel: "webhook",
                        status: whResult.status,
                        httpStatus: whResult.httpStatus,
                        attempts: whResult.attempts,
                        errorCode: whResult.errorCode,
                        targetSummary: whResult.targetSummary,
                        createdAt: ctx.nowMs,
                        completedAt: Date.now(),
                      });
                    }
                  } catch {
                    await recordDeliveryLogBestEffort(ctx.db, {
                      deliveryId: generateDeliveryId("wh_err"),
                      tenantId: ctx.tenantId,
                      eventId: ctx.eventId,
                      eventName: "lead.created",
                      leadId: lead.leadId,
                      channel: "webhook",
                      status: "failed",
                      httpStatus: null,
                      attempts: 1,
                      errorCode: "WEBHOOK_HOOK_EXCEPTION",
                      targetSummary: "webhook-target",
                      createdAt: ctx.nowMs,
                      completedAt: Date.now(),
                    });
                  }
                })(),
              );
            }

            if (tasks.length > 0) {
              await Promise.all(tasks);
            }
          } catch {
            // Absolute fault-isolation barrier: lead creation MUST NEVER be affected
          }
        },
      },
    },
  });
}

export const LEAD_NOTIFIER_PLUGIN: PluginDefinition = createLeadNotifierPlugin();
