# Tenant MCP Server API Contract (`REQ-076`, `ADR-0008`, `TASK-075`)

> Remote Streamable HTTP Model Context Protocol (MCP) server for PunyaSitus tenant owners and admins (`https://app.punyasitus.com/mcp`).

## 1. Host & Transport Boundaries

- **Admin host only:** `https://app.punyasitus.com` (and `127.0.0.1` loopback when `APP_ENV=local`).
- **Neutral `404` everywhere else:** Every tenant subdomain (`*.situsku.click`), custom domain, `punyasitus.com`, and `console.punyasitus.com` returns a neutral `404` for `/mcp`, `/oauth2/*`, and `/.well-known/oauth-*`.
- **Bearer-only protocol boundary:** `__Host-` session cookies are **never accepted** on `/mcp`, `/oauth2/token`, `/oauth2/revoke`, `/oauth2/register`, or `/.well-known/oauth-*` (returns `401` with `WWW-Authenticate`).
- **Interactive human UI:** `/auth/consent`, `/auth/consent/publish/:token`, `/account/connected-apps`, and `/api/auth/mcp/*` use host-only `__Host-ps_session` cookies plus strict `Content-Type: application/json` + exact `Origin` CSRF enforcement (`403` on mismatch/missing).

## 2. OAuth 2.1 Discovery & Endpoints

| Method & Path | Purpose | Notes |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 Protected Resource Metadata | Declares canonical `resource` (`https://app.punyasitus.com/mcp`), `authorization_servers`, `scopes_supported`, `bearer_methods_supported: ["header"]`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 Authorization Server Metadata | Declares `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `resource_indicators_supported: true`. |
| `GET /oauth2/authorize` | OAuth 2.1 Authorization Request | Validates `response_type=code`, SSRF-safe CIMD `client_id`, exact `redirect_uri`, `code_challenge_method=S256`, RFC 8707 `resource`, and scopes; redirects to `/auth/consent`. |
| `POST /oauth2/token` | OAuth 2.1 Token Exchange & Refresh | Supports `authorization_code` (single-use code + PKCE `S256` + exact `redirect_uri` + RFC 8707 `resource`) and `refresh_token` (rotating refresh token; replay revokes entire grant family). |
| `POST /oauth2/revoke` | RFC 7009 Token Revocation | Immediately revokes the matching grant and all issued tokens. |
| `POST /oauth2/register` | Dynamic Client Registration (Disabled) | Returns `403 registration_not_supported` (ADR-0008: CIMD preferred, DCR off by default). |
| `POST /api/auth/mcp/consent` (and `POST /auth/consent`) | Human Consent Approval / Denial | Cookie + CSRF/Origin protected; Owner/Admin only (`editor` -> `403`); binds **one** `tenantId` and explicit scopes; requires `piiConsentAcked: true` when `leads:read` is chosen. |
| `GET /api/auth/mcp/grants` | Connected Apps List | Returns signed-in user's connected AI grants (never raw tokens). |
| `POST /api/auth/mcp/revoke` | Immediate Grant Revocation | Revokes a user-owned grant and all tokens immediately; audited. |
| `POST /api/auth/mcp/publish-approval` | Human Publish Confirmation | Cookie + CSRF/Origin protected; Owner/Admin only; atomically consumes one-time approval token and runs `publishResourceWithScreening(..., { publishSource: "mcp" })`. |

### CIMD SSRF Protection Rules

When `client_id` is a Client ID Metadata Document URL:
- Must be strict `https://` with a public hostname and non-root pathname (no credentials, fragments, private/loopback/link-local/CGNAT/multicast IPv4 or IPv6 literals, or local suffixes).
- Outbound fetch enforces `redirect: "error"` (zero HTTP redirects followed), `5s` timeout, and `32 KiB` maximum response size.
- Response `Content-Type` must be JSON, `document.client_id` must strictly equal the requested URL, and every `redirect_uri` must be a valid public `https://` or RFC 8252 loopback URI.

## 3. Scopes

| Scope | Aliases Accepted | Capability | Extra Controls |
|---|---|---|---|
| `content:read` | — | Read site overview, pages, posts, and offerings | Tenant-scoped, active entitlement required |
| `content:write_draft` | `content:write` | Create and update **drafts only** for pages, posts, and offerings | Never publishes directly; optimistic `expectedVersion` |
| `content:publish_request` | `content:publish` | Generate a short-lived one-time human publish approval link | Never publishes directly; requires human browser confirmation |
| `leads:read` | — | Read leads/inquiries list and detail | Requires explicit UU PDP PII consent checkbox (`piiConsentAcked: true`) |

## 4. Streamable HTTP MCP Endpoint (`POST /mcp`)

Every `POST /mcp` request performs **live per-call verification**:
1. Bearer token hash lookup (`mcp_oauth_tokens` + `mcp_oauth_grants`); rejects revoked, expired, or rotated tokens (`401`).
2. Strict RFC 8707 `resource` match against `https://app.punyasitus.com/mcp` (`401`).
3. Live `PLATFORM_DB` membership check (`tenants JOIN members`): demoted `editor` or removed member fails immediately (`403`).
4. Live entitlement check (`loadLiveTenantEntitlement`): `locked`, `suspended`, `recovery`, `purging`, or `purged` tenants return `403 SUBSCRIPTION_LOCKED` with **zero tenant data**.
5. Atomic per-token (`60/min`) and per-tenant (`120/min`) rate limiting (`429 RATE_LIMITED` + `Retry-After`).
6. Redacted append-only audit logging in `PLATFORM_DB.platform_audit` (never stores bearer tokens, secrets, or raw lead bodies).

### Strict Tool Allowlist

| Tool | Required Scope | Behavior |
|---|---|---|
| `get_site_overview` | `content:read` | Site identity summary and content counts |
| `list_pages`, `get_page` | `content:read` | Read pages (reuses `@punyasitus/db/pages`) |
| `list_posts`, `get_post` | `content:read` | Read blog posts (reuses `@punyasitus/db/posts`) |
| `list_offerings`, `get_offering` | `content:read` | Read catalog offerings (reuses `@punyasitus/db/catalog`) |
| `create_page_draft`, `update_page_draft` | `content:write_draft` | Draft-only page creation/editing (reuses `@punyasitus/db/pages`) |
| `create_post_draft`, `update_post_draft` | `content:write_draft` | Draft-only post creation/editing (reuses `@punyasitus/db/posts`) |
| `create_offering_draft`, `update_offering_draft` | `content:write_draft` | Draft-only offering creation/editing (reuses `@punyasitus/db/catalog`) |
| `request_publish_approval` | `content:publish_request` | Creates a 15-minute single-use approval link (`/auth/consent/publish/{token}`); never publishes directly |
| `list_leads`, `get_lead` | `leads:read` + PII ack | Read inquiries/leads (reuses `@punyasitus/db/leads`) |

### Explicitly Excluded Tools (Never Exposed, Always Rejected)

- Delete / trash (`delete_*`, `trash_*`)
- Direct publish (`publish_page`, `publish_post`, `publish_offering`, `auto_publish`)
- URL media upload/fetch (`upload_media_from_url`, `fetch_media_url`) — SSRF boundary
- Billing & subscriptions (`get_billing`, `create_payment`, etc.)
- Domains (`connect_domain`, `remove_domain`, `set_primary_domain`)
- Members & invitations (`invite_member`, `remove_member`, `update_member_role`)
- Platform / superadmin console actions (`suspend_tenant`, `list_tenants`, `grant_theme`)
