-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0002_email_delivery_claims
-- Additive one-shot email delivery claim ledger and bounce webhook replay ledger (REQ-077, PLAN §17.4).
-- Privacy invariant: stores ZERO recipient email addresses and ZERO email body/text.

CREATE TABLE IF NOT EXISTS email_delivery_claims (
  message_key TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  one_shot INTEGER NOT NULL DEFAULT 1 CHECK (one_shot IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'failed', 'unknown', 'skipped', 'duplicate')),
  provider TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_delivery_claims_status_updated_idx
  ON email_delivery_claims(status, updated_at);

CREATE TABLE IF NOT EXISTS email_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_webhook_events_received_at_idx
  ON email_webhook_events(received_at);
