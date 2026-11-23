# Tenant MCP Server Operations & Staging Verification Runbook (`TASK-075`, `REQ-076`, `ADR-0008`)

## 1. Architecture & Security Controls

- **Single Admin Origin:** `https://app.punyasitus.com/mcp` (Streamable HTTP JSON-RPC 2.0 over Cloudflare Worker).
- **Control Plane (`PLATFORM_DB` D1, migration `0030_mcp_oauth_grants.sql`):**
  - `mcp_oauth_clients` — cached CIMD / static client metadata
  - `mcp_oauth_grants` — one website (`tenant_id`) + RFC 8707 `resource` + scopes per grant
  - `mcp_oauth_auth_codes` — SHA-256 hashed single-use PKCE `S256` codes (replay revokes parent grant)
  - `mcp_oauth_tokens` — SHA-256 hashed short-lived access tokens (`15m`) + rotating refresh tokens (`7d`; replay revokes entire token family & grant)
  - `mcp_publish_approvals` — SHA-256 hashed single-use `15m` human publish approval tokens
  - `mcp_rate_limit_buckets` — atomic per-token (`60/min`) and per-tenant (`120/min`) counters
- **Tenant Data Plane (`TenantStore` Durable Object):** Every tool call opens ONLY the `TenantStore` bound to `grant.tenant_id`, reusing the same server-side services (`pages`, `posts`, `catalog`, `leads`, `settings`, `publishResourceWithScreening`) as the dashboard API.
- **Audit Trail:** All OAuth grant creations, token issuances/refreshes/revocations, replay detections, rate-limit denials, tool calls, and human publish confirmations append redacted rows to `PLATFORM_DB.platform_audit`.

## 2. Deployment & Migration Procedure

1. Apply `0030_mcp_oauth_grants.sql` to `PLATFORM_DB` (`punyasitus-platform`) BEFORE rolling out application traffic (purely additive, safe for rolling deploy and zero-data-loss rollback).
2. Verify discovery endpoints on `https://app.punyasitus.com`:
   - `curl -sS https://app.punyasitus.com/.well-known/oauth-protected-resource | jq .`
   - `curl -sS https://app.punyasitus.com/.well-known/oauth-authorization-server | jq .`
3. Verify tenant & console hosts return `404`:
   - `curl -i https://<synthetic-handle>.situsku.click/mcp` -> `404`
   - `curl -i https://<synthetic-handle>.situsku.click/.well-known/oauth-protected-resource` -> `404`
   - `curl -i https://console.punyasitus.com/mcp` -> `404`

## 3. Incident Response & Revocation

- **User self-service revocation:** `https://app.punyasitus.com/account/connected-apps` -> click **Cabut Akses**. Takes effect immediately on the next `/mcp` request (`401 TOKEN_REVOKED`).
- **Role demotion / member removal:** Demoting an `admin` to `editor` or removing a member from the organization revokes MCP access immediately on the next `/mcp` call (`403 ROLE_INSUFFICIENT` / `403 MEMBERSHIP_REVOKED`).
- **Suspected token compromise / replay:** OAuth code reuse or rotated refresh token replay automatically revokes the entire grant and all tokens in the family, logging `authorization_code_replay_detected` or `refresh_token_replay_detected` in `platform_audit`.
- **Emergency client disable:** Set `mcp_oauth_clients.disabled = 1` for a misbehaving `client_id`; every active token for that client fails closed immediately with `401 TOKEN_REVOKED`.

## 4. Third-Party AI Client Staging Verification Checklist

> Local automated conformance (`tests/task-075/unit.test.ts`, `tests/task-075/workerd.integration.test.ts`, `tests/task-075/e2e.mjs`) verifies the full OAuth 2.1 + PKCE + RFC 8707 + CIMD + MCP JSON-RPC + UI flow against a local `workerd` runtime. Live external AI client connectors require a publicly reachable HTTPS staging deployment (`app.staging.punyasitus.com` / `app.punyasitus.com`).

| AI Client | Connector Protocol | Staging Verification Status | Notes & Required Staging Steps |
|---|---|---|---|
| **ChatGPT** (Custom MCP Server) | Remote Streamable HTTP + OAuth 2.1 (RFC 9728/8414 + PKCE S256 + RFC 8707) | **`UNVERIFIED — REQUIRES STAGING`** | Connect a synthetic staging tenant (`owner` account) via *Add custom MCP server* -> verify discovery, `/auth/consent` single-site binding, `list_pages`, `create_page_draft`, `request_publish_approval` (human browser confirmation), and `/account/connected-apps` immediate revocation. Record screenshots + audit IDs before release (`TASK-038`). |
| **Claude** (Custom Connector) | Remote Streamable HTTP + OAuth 2.1 (RFC 9728/8414 + PKCE S256 + RFC 8707) | **`UNVERIFIED — REQUIRES STAGING`** | Connect a synthetic staging tenant (`owner` account) via Claude Custom Connectors -> verify discovery, `/auth/consent`, read + draft write + human publish link, and immediate revocation. Record staging evidence before release (`TASK-038`). |
| **Grok** (`grok.com/connectors`) | Custom Connectors | **`UNSUPPORTED / UNVERIFIED — REQUIRES STAGING CHECK`** | As recorded in `ADR-0008`, xAI's public `docs.x.ai/grok/connectors` documentation did not specify full OAuth 2.1 + RFC 9728/8707 + CIMD support at specification time. Re-check Grok connector OAuth 2.1 parity during staging; list as unsupported until Grok's connector passes the exact OAuth 2.1 + PKCE + RFC 8707 flow without weakening security (do NOT enable unauthenticated MCP or static long-lived API keys). |
