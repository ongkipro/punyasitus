-- PunyaSitus PLATFORM_DB (Cloudflare D1) — 0030_mcp_oauth_grants
-- Additive Tenant MCP Server OAuth 2.1 + PKCE + RFC 8707 + CIMD grants,
-- single-use auth codes, rotating refresh tokens, short-lived publish approval tokens,
-- and atomic rate-limit buckets (REQ-076, ADR-0008, PLAN §18.3, TASK-075).

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cimd' CHECK (source IN ('cimd', 'static')),
  metadata_json TEXT,
  metadata_fetched_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  pii_consent_acked INTEGER NOT NULL DEFAULT 0 CHECK (pii_consent_acked IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at INTEGER,
  revoked_reason TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_oauth_grants_user_status_idx
  ON mcp_oauth_grants(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS mcp_oauth_grants_tenant_status_idx
  ON mcp_oauth_grants(tenant_id, status);

CREATE INDEX IF NOT EXISTS mcp_oauth_grants_client_user_tenant_idx
  ON mcp_oauth_grants(client_id, user_id, tenant_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_oauth_auth_codes_grant_idx
  ON mcp_oauth_auth_codes(grant_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  resource TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER,
  rotated_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant_idx
  ON mcp_oauth_tokens(grant_id, revoked_at);

CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_family_idx
  ON mcp_oauth_tokens(family_id);

CREATE TABLE IF NOT EXISTS mcp_publish_approvals (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'post', 'offering')),
  resource_id INTEGER NOT NULL,
  expected_version INTEGER NOT NULL,
  resource_title TEXT NOT NULL,
  resource_slug TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'held_for_review')
  ),
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by_user_id TEXT REFERENCES users(id),
  review_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_publish_approvals_tenant_status_idx
  ON mcp_publish_approvals(tenant_id, status, expires_at);

CREATE TABLE IF NOT EXISTS mcp_rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at INTEGER NOT NULL
);
