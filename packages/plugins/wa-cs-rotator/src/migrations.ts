import type { PluginMigrationDescriptor } from "@punyasitus/core/plugins/index";

/**
 * Additive namespace-locked SQLite migrations for `wa-cs-rotator` (`plg_wa_cs_rotator__*`).
 * Strictly validated by `validatePluginMigrationSql` — never touches core CMS tables.
 * Preserves `plg_wa_cs_rotator__agents` table name expected across plugin expiry lifecycle tests.
 */
export const WA_CS_ROTATOR_MIGRATIONS: readonly PluginMigrationDescriptor[] = [
  {
    version: 1,
    name: "0001_init_wa_cs_rotator",
    sql: `CREATE TABLE IF NOT EXISTS plg_wa_cs_rotator__agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_label TEXT NOT NULL DEFAULT 'Sales CS',
  phone_e164 TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 100),
  schedule_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  start_time TEXT NOT NULL DEFAULT '08:00',
  end_time TEXT NOT NULL DEFAULT '17:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  total_clicks INTEGER NOT NULL DEFAULT 0 CHECK (total_clicks >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plg_wa_cs_rotator__agents_active_idx
  ON plg_wa_cs_rotator__agents(is_active, sort_order, id);

CREATE TABLE IF NOT EXISTS plg_wa_cs_rotator__state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  strategy TEXT NOT NULL DEFAULT 'round_robin' CHECK (strategy IN ('round_robin', 'weighted')),
  cursor_index INTEGER NOT NULL DEFAULT 0 CHECK (cursor_index >= 0),
  weighted_state_json TEXT NOT NULL DEFAULT '{}',
  fallback_whatsapp_phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  fallback_clicks INTEGER NOT NULL DEFAULT 0 CHECK (fallback_clicks >= 0),
  last_agent_id TEXT,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plg_wa_cs_rotator__clicks (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  target_phone_e164 TEXT NOT NULL,
  was_fallback INTEGER NOT NULL DEFAULT 0 CHECK (was_fallback IN (0, 1)),
  strategy_used TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '/',
  day_bucket TEXT NOT NULL,
  clicked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plg_wa_cs_rotator__clicks_agent_day_idx
  ON plg_wa_cs_rotator__clicks(agent_id, day_bucket);

CREATE INDEX IF NOT EXISTS plg_wa_cs_rotator__clicks_day_idx
  ON plg_wa_cs_rotator__clicks(day_bucket);

CREATE INDEX IF NOT EXISTS plg_wa_cs_rotator__clicks_ts_idx
  ON plg_wa_cs_rotator__clicks(clicked_at);

CREATE TABLE IF NOT EXISTS plg_wa_cs_rotator__clicks_daily (
  agent_key TEXT NOT NULL,
  day_bucket TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_key, day_bucket)
);

CREATE INDEX IF NOT EXISTS plg_wa_cs_rotator__clicks_daily_bucket_idx
  ON plg_wa_cs_rotator__clicks_daily(day_bucket);`,
  },
] as const;
