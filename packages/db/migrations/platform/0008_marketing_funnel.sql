-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0008_marketing_funnel
-- Cookieless aggregated daily funnel counters (REQ-087, PLAN §19.5, TASK-087).
-- Strictly zero visitor IP, email, cookie, user-agent, or PII columns.

CREATE TABLE IF NOT EXISTS marketing_funnel_daily (
  day_utc TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN ('visit', 'demo_view', 'signup_start', 'email_verified', 'trial_created', 'first_payment')
  ),
  source_channel TEXT NOT NULL DEFAULT 'direct',
  theme_slug TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_utc, stage, source_channel, theme_slug)
);

CREATE INDEX IF NOT EXISTS marketing_funnel_daily_day_stage_idx
  ON marketing_funnel_daily(day_utc, stage);

CREATE INDEX IF NOT EXISTS marketing_funnel_daily_theme_idx
  ON marketing_funnel_daily(theme_slug, day_utc);
