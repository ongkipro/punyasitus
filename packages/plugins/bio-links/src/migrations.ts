import type { PluginMigrationDescriptor } from "@punyasitus/core/plugins/index";

/**
 * Additive namespace-locked SQLite migrations for `bio-links` (`plg_bio_links__*`).
 * Strictly validated by `validatePluginMigrationSql` — never touches core CMS tables.
 */
export const BIO_LINKS_MIGRATIONS: readonly PluginMigrationDescriptor[] = [
  {
    version: 1,
    name: "0001_init_bio_links",
    sql: `CREATE TABLE IF NOT EXISTS plg_bio_links__config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  bio_text TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  theme_accent TEXT NOT NULL DEFAULT '#0F766E',
  whatsapp_phone TEXT NOT NULL DEFAULT '',
  whatsapp_label TEXT NOT NULL DEFAULT 'Hubungi via WhatsApp',
  whatsapp_message TEXT NOT NULL DEFAULT '',
  show_whatsapp_button INTEGER NOT NULL DEFAULT 1 CHECK (show_whatsapp_button IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plg_bio_links__items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  badge TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plg_bio_links__items_order_idx
  ON plg_bio_links__items(is_active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS plg_bio_links__clicks_daily (
  link_id TEXT NOT NULL REFERENCES plg_bio_links__items(id),
  day_bucket TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, day_bucket)
);

CREATE INDEX IF NOT EXISTS plg_bio_links__clicks_daily_bucket_idx
  ON plg_bio_links__clicks_daily(day_bucket);`,
  },
] as const;
