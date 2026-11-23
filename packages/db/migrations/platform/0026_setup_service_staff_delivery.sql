-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0026_setup_service_staff_delivery
-- Additive columns on custom_theme_requests for Terima Beres setup service
-- owner-approved staff editor membership lifecycle (REQ-070, PLAN §18.2, TASK-069).

ALTER TABLE custom_theme_requests ADD COLUMN staff_user_id TEXT REFERENCES users(id);
ALTER TABLE custom_theme_requests ADD COLUMN staff_email_snapshot TEXT;
ALTER TABLE custom_theme_requests ADD COLUMN staff_name_snapshot TEXT;
ALTER TABLE custom_theme_requests ADD COLUMN staff_access_state TEXT NOT NULL DEFAULT 'none' CHECK (
  staff_access_state IN ('none', 'awaiting_owner_approval', 'waiting_seat', 'active', 'revoked')
);
ALTER TABLE custom_theme_requests ADD COLUMN staff_approved_by_user_id TEXT REFERENCES users(id);
ALTER TABLE custom_theme_requests ADD COLUMN staff_approved_at INTEGER;
ALTER TABLE custom_theme_requests ADD COLUMN staff_member_id TEXT;
ALTER TABLE custom_theme_requests ADD COLUMN staff_joined_at INTEGER;
ALTER TABLE custom_theme_requests ADD COLUMN staff_revoked_at INTEGER;
ALTER TABLE custom_theme_requests ADD COLUMN staff_wait_reason TEXT;

CREATE INDEX IF NOT EXISTS custom_theme_requests_staff_state_idx
  ON custom_theme_requests(tenant_id, service_kind, staff_access_state);
