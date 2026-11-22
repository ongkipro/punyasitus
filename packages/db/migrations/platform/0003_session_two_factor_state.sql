-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0003_session_two_factor_state
-- Additive session-level 2FA verification ledger and Better Auth 1.7.27 two_factors parity
-- (REQ-068, DEC-021, PLAN §13).

CREATE TABLE IF NOT EXISTS session_two_factor_verifications (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('totp', 'backup_code')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_two_factor_verifications_user_id_idx
  ON session_two_factor_verifications(user_id);

ALTER TABLE two_factors ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1));
ALTER TABLE two_factors ADD COLUMN failed_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0);
ALTER TABLE two_factors ADD COLUMN locked_until INTEGER;
