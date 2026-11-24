import type { PluginMigrationDescriptor } from "@punyasitus/core/plugins/index";
import { LEAD_NOTIFIER_TABLES, LEAD_NOTIFIER_TABLE_PREFIX } from "./constants.ts";

/**
 * Additive namespace-locked SQLite migrations for `lead-notifier` (`TenantStore`).
 * Every table and index strictly uses the `plg_lead_notifier__*` prefix and contains
 * zero destructive DDL or forbidden SQL keywords (`packages/core/src/plugins/sql-guard.ts`).
 */

export const LEAD_NOTIFIER_MIGRATIONS: readonly PluginMigrationDescriptor[] = [
  {
    version: 1,
    name: "0001_init_lead_notifier",
    sql: `
      CREATE TABLE IF NOT EXISTS ${LEAD_NOTIFIER_TABLES.linkTokens} (
        token_hash TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        consumed_chat_id TEXT
      );
      CREATE INDEX IF NOT EXISTS ${LEAD_NOTIFIER_TABLE_PREFIX}link_tokens_tenant_exp_idx
        ON ${LEAD_NOTIFIER_TABLES.linkTokens}(tenant_id, expires_at);

      CREATE TABLE IF NOT EXISTS ${LEAD_NOTIFIER_TABLES.telegramLinks} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT 'private',
        masked_label TEXT NOT NULL,
        linked_by_user_id TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        revoked_at INTEGER,
        revoked_by_user_id TEXT
      );

      CREATE TABLE IF NOT EXISTS ${LEAD_NOTIFIER_TABLES.webhooks} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tenant_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        signing_secret TEXT NOT NULL,
        secret_masked TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        secret_rotated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${LEAD_NOTIFIER_TABLES.deliveries} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        lead_id INTEGER,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        attempts INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        target_summary TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${LEAD_NOTIFIER_TABLE_PREFIX}deliveries_created_idx
        ON ${LEAD_NOTIFIER_TABLES.deliveries}(created_at DESC);
      CREATE INDEX IF NOT EXISTS ${LEAD_NOTIFIER_TABLE_PREFIX}deliveries_event_channel_idx
        ON ${LEAD_NOTIFIER_TABLES.deliveries}(event_id, channel);
    `,
  },
] as const;
