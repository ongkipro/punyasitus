# ADR-0008: Tenant MCP Server for Customer AI Agents

- **Status:** Accepted
- **Date:** 2026-11-14
- **Author:** Specification review
- **Deciders:** Paduka Ongki
- **Supersedes:** None
- **Consulted / Informed:** Official MCP, OpenAI, Anthropic, xAI and Better Auth documentation (retrieved 2026-11-14)

## 1. Context

Paduka Ongki asked (2026-11-14) that subscribers can manage their website from their own AI agent (ChatGPT, Claude, Grok and similar). These clients connect to remote Model Context Protocol (MCP) servers:

- ChatGPT: "Add custom MCP server" with OAuth or no authentication; transports SSE and streaming HTTP (developers.openai.com/api/docs/guides/custom-mcp-server).
- Claude: custom connectors using remote MCP on Free (one connector), Pro, Max, Team and Enterprise; OAuth 2.0 per user or a static credential (support.claude.com/en/articles/11175166, claude.com/docs/connectors/building/authentication).
- Grok: custom connectors at grok.com/connectors; the server must be reachable over the public internet (docs.x.ai/grok/connectors). Auth details for custom connectors were not documented on that page, so Grok support is conditional until verified.
- MCP authorization for HTTP transports follows OAuth 2.1 and requires OAuth Protected Resource Metadata (RFC 9728) (modelcontextprotocol.io specification).
- Better Auth ships an MCP plugin built on its OAuth 2.1 provider with `/oauth2/*` endpoints and RFC 8414/9728 metadata; dynamic client registration is off by default and Client ID Metadata Documents (CIMD) are recommended (better-auth.com/docs/plugins/mcp).

Decision drivers: tenant isolation (PLAN section 4), one mutation path (ADR-0007), no raw script or plugin surface (NG-1, NG-6), prompt-injection and write-mistake risk that OpenAI explicitly warns about, and the small initial VPS.

Non-goals: a public anonymous content API, operator/platform tools over MCP, billing, domain or member management by agents, media upload from arbitrary URLs.

## 2. Considered Options

- **Option A — Remote MCP endpoint on the admin host, OAuth via Better Auth, tools wrap the existing service layer:** Good, because one auth system, one authorization and validation path, tenant-scoped tokens and per-user consent. Bad, because OAuth provider configuration and client compatibility must be verified per client.
- **Option B — Personal API keys plus a downloadable local (stdio) MCP server:** Good, because simple tokens. Bad, because consumer ChatGPT/Claude/Grok web apps need a remote server, long-lived keys leak easily, and it adds a distributable artifact.
- **Option C — No MCP; document the REST API:** Good, because no new surface. Bad, because it does not meet the requested capability for non-technical owners.

## 3. Decision

Option A. A streamable-HTTP MCP endpoint is served only on the fixed admin host (`https://app.punyasitus.com/mcp`); tenant hosts return 404 for it. Authorization uses the Better Auth MCP plugin (OAuth 2.1, PKCE, RFC 8414/9728 metadata, CIMD first; dynamic client registration only if a supported client requires it, rate-limited and audited).

- Consent screen: the signed-in owner or admin (editors cannot connect agents) selects exactly one website and grants scopes. Tokens are bound to user, tenant and scopes, short-lived with refresh, and revocable from Akun > Aplikasi AI terhubung. Membership, role and entitlement are rechecked on every tool call; a locked or suspended tenant gets an error, no data.
- Scopes and tools (v1): `content:read` (list/get pages, posts, catalog items, categories, media metadata, settings summary), `content:write` (create/update drafts of pages, posts and catalog items, set SEO fields, attach existing media), `content:publish` (publish/unpublish an existing draft), `leads:read` (list/get leads; owner/admin only, separate consent). Tools call the same server-only services and schemas as the OpenAPI endpoints; there is no second business-rule path.
- Excluded tools: delete/trash, media upload from URLs (SSRF), billing, domains, members, theme grants, platform/operator actions, arbitrary HTML or script fields.
- OAuth hardening: tokens carry the canonical MCP resource (RFC 8707 resource indicator) as audience and the server rejects tokens for any other or missing resource; authorization codes are single-use and bound to client, redirect URI and PKCE verifier; refresh tokens rotate and are bound to client; redirect URIs match exactly; consent is CSRF-protected and bound to the requesting client, the chosen tenant and the approved scopes. CIMD metadata fetches are HTTPS-only, block private/loopback/link-local destinations and redirects, and cap size and time. Dynamic client registration stays disabled unless a required client cannot use CIMD, and then is rate-limited, audited and redirect-validated.
- Safety: tool annotations (read-only/destructive hints) are client hints, not a confirmation guarantee. Publishing therefore needs a server-side approval: the `publish` tool returns a one-time approval link for the exact resource and draft revision, and the draft is published only after the signed-in owner or admin confirms in PunyaSitus. Every call is audited with user, tenant, client ID and request ID; per-token and per-tenant rate limits apply; tool results return data only; site content and lead messages are untrusted data. The `leads:read` consent screen states that lead names, phone numbers and messages are sent to the connected AI application.

Milestone M2 (second build phase; DEC-030 makes all phases part of the first production release). Requirement REQ-076, task TASK-075.

## 4. Consequences

- Positive: subscribers can draft and update content from their preferred AI agent; a differentiator against DIY builders and done-for-you services.
- Negative: a new internet-facing authorization surface; OAuth behavior differs per client and must be tested with ChatGPT, Claude and Grok; prompt injection can cause unwanted drafts, mitigated by drafts-first, scoped consent and audit.
- Follow-up: verify the pinned Better Auth MCP plugin API in TASK-023/TASK-075; recheck each client's current connector requirements before launch.

## 5. Confirmation

TASK-075 verification: automated conformance tests with a local MCP client (discovery, OAuth with PKCE and resource binding, consent, tenant/scope isolation, locked-tenant denial, revocation, publish approval, audit, rate limits, excluded tools absent). Live connections from ChatGPT and Claude are recorded as staging evidence before release; Grok is recorded when its connector supports this OAuth flow, otherwise listed as unsupported.
