-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0021_abuse_moderation
-- Additive public abuse reporting rate limits and append-only console moderation history
-- (REQ-094, REQ-039, REQ-051; PLAN §5.1, §6, §13, §19.5; TASK-094).
-- Privacy invariant: rate-limit keys store only HMAC-SHA256 salted hashes (never raw IPs);
-- moderation action records are append-only and carry redacted operator reasons only.

CREATE TABLE IF NOT EXISTS abuse_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS abuse_rate_limit_buckets_expires_idx
  ON abuse_rate_limit_buckets(expires_at);

CREATE INDEX IF NOT EXISTS abuse_reports_status_created_idx
  ON abuse_reports(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS abuse_moderation_actions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES abuse_reports(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  action TEXT NOT NULL CHECK (action IN ('dismiss', 'unpublish', 'suspend')),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  previous_report_status TEXT NOT NULL CHECK (previous_report_status IN ('open', 'investigating', 'resolved', 'dismissed')),
  next_report_status TEXT NOT NULL CHECK (next_report_status IN ('open', 'investigating', 'resolved', 'dismissed')),
  previous_tenant_status TEXT,
  next_tenant_status TEXT,
  unpublish_target_path TEXT,
  tenant_notified INTEGER NOT NULL DEFAULT 0 CHECK (tenant_notified IN (0, 1)),
  notification_status TEXT NOT NULL DEFAULT 'skipped' CHECK (notification_status IN ('queued', 'sent', 'skipped', 'failed')),
  idempotency_key TEXT,
  audit_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS abuse_moderation_actions_report_idx
  ON abuse_moderation_actions(report_id, created_at DESC);

CREATE INDEX IF NOT EXISTS abuse_moderation_actions_tenant_idx
  ON abuse_moderation_actions(tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS abuse_moderation_actions_report_idemp_idx
  ON abuse_moderation_actions(report_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS abuse_moderation_actions_no_update
BEFORE UPDATE ON abuse_moderation_actions
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.report_id IS NOT OLD.report_id OR
  NEW.tenant_id IS NOT OLD.tenant_id OR
  NEW.action IS NOT OLD.action OR
  NEW.reason IS NOT OLD.reason OR
  NEW.actor_user_id IS NOT OLD.actor_user_id OR
  NEW.previous_report_status IS NOT OLD.previous_report_status OR
  NEW.next_report_status IS NOT OLD.next_report_status OR
  NEW.previous_tenant_status IS NOT OLD.previous_tenant_status OR
  NEW.next_tenant_status IS NOT OLD.next_tenant_status OR
  NEW.unpublish_target_path IS NOT OLD.unpublish_target_path OR
  NEW.idempotency_key IS NOT OLD.idempotency_key OR
  NEW.audit_id IS NOT OLD.audit_id OR
  NEW.created_at IS NOT OLD.created_at OR
  OLD.notification_status != 'queued' OR
  NEW.notification_status NOT IN ('sent', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'abuse_moderation_actions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS abuse_moderation_actions_no_delete
BEFORE DELETE ON abuse_moderation_actions
BEGIN
  SELECT RAISE(ABORT, 'abuse_moderation_actions is append-only');
END;
