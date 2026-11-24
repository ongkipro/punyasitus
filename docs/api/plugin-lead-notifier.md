# Official Plugin API Contract: `lead-notifier` (`TASK-101`, `REQ-101`, `ADR-0010`)

> Companion specification for the official Frozen-Core plugin `packages/plugins/lead-notifier`. Core platform OpenAPI (`docs/api/openapi.json`) remains unchanged per the Frozen Core contract.

## Overview & Commercial Tiers

- **Plugin ID:** `lead-notifier`
- **Default Active on Provision:** `false` (opt-in installation via the `Plugin` sidebar menu)
- **Namespace-Locked SQLite Tables (`TenantStore`):**
  - `plg_lead_notifier__link_tokens` — SHA-256 hashed 15-minute single-use Telegram link tokens
  - `plg_lead_notifier__telegram_links` — per-tenant linked Telegram chat (`chat_id`, masked display label, active/revoked state)
  - `plg_lead_notifier__webhooks` — per-tenant SSRF-validated HTTPS webhook target + HMAC-SHA256 signing secret
  - `plg_lead_notifier__deliveries` — scrubbed delivery audit log (`telegram` and `webhook` channels)
- **Public JS Budget:** `0` bytes (`maxPublicJsBytes: 0`)
- **Capability Tiers:**
  1. **Telegram 1-Click Alerts (`public_free`):** Immediate 1-click Telegram Bot linking (`https://t.me/<PlatformBot>?start=<token>`) with formatted `lead.created` alert and tap-to-WhatsApp follow-up button.
  2. **Signed HTTPS Webhook (`public_paid` / operator-grantable):** Strictly server-entitlement-gated (`PLATFORM_DB` entitlement / operator grant — **never** writable via tenant plugin config JSON) HMAC-SHA256 signed, SSRF-guarded HTTPS webhook delivery for CRM, Google Sheets, Zapier, or n8n with bounded retries and test-send endpoint.

## Cloudflare Workers Runtime Environment Bindings

| Binding / Secret | Required For | Resolution Order |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET` (alias `LEAD_NOTIFIER_TELEGRAM_WEBHOOK_SECRET`) | Inbound `/api/plugins/lead-notifier/webhook` authentication | `runtimeEnv.TELEGRAM_WEBHOOK_SECRET` -> `runtimeEnv.LEAD_NOTIFIER_TELEGRAM_WEBHOOK_SECRET` (fail-closed if absent) |
| `TELEGRAM_BOT_TOKEN` (alias `LEAD_NOTIFIER_TELEGRAM_BOT_TOKEN`) | Outbound Telegram `sendMessage` alerts | Explicit factory override -> `ctx.env.TELEGRAM_BOT_TOKEN` -> `process.env.TELEGRAM_BOT_TOKEN` |
| `TELEGRAM_BOT_USERNAME` | Deep-link bot handle (`https://t.me/<Bot>?start=<token>`) | Explicit factory override -> `ctx.env.TELEGRAM_BOT_USERNAME` -> plugin config `botUsername` -> `process.env.TELEGRAM_BOT_USERNAME` -> `"PunyaSitusBot"` |

## Hard Safety Invariants

1. **Non-Blocking Lead Persistence (`REQ-031`, `REQ-101`):** `queueHooks["lead.created"]` runs asynchronously under a shared `<= 9.5s` global deadline budget (within the `12s` hook timeout) with bounded response stream cancellation, catching all Telegram/webhook 5xx, timeout, network, SSRF, and DB logging errors. Notifier failures **never** fail, delay, or roll back `POST /api/leads`.
2. **Zero Manual `chat_id` & 15-Minute Single-Use Tokens:** Plaintext link tokens are never stored in the database or written to logs. Only the SHA-256 hex digest is persisted and atomically consumed (`UPDATE ... WHERE token_hash = ? AND tenant_id = ? AND used_at IS NULL AND expires_at > ?`, requiring `changes === 1`).
3. **Fail-Closed Telegram Webhook Authentication & Non-Stalling Acknowledgment:** `POST /api/plugins/lead-notifier/webhook` enforces `app` host isolation, `POST` method check, and plugin registry lookup, then verifies `X-Telegram-Bot-Api-Secret-Token` in constant time (`verifySecret`) **before** reading the request body or touching any database (`401 UNAUTHENTICATED` on missing/wrong secret). Once verified as authentic Telegram traffic, rejected `/start <token>` updates (expired, replayed, unknown, or tenant mismatch) return HTTP `200` with `{ ok: false, linked: false, rejected: true, code }` so Telegram does not retry and stall updates for other tenants sharing the platform bot.
4. **Server-Owned Commercial Entitlement:** Paid webhook entitlement is derived exclusively from server/platform entitlement state and is strictly excluded from `LeadNotifierConfigSchema` (tenant attempts to pass `webhookEntitled` in plugin config are rejected with `422 VALIDATION_ERROR`). Delivery also respects the tenant's `webhookEnabled` toggle.
5. **Immediate Revocation on Unlink:** Calling unlink immediately clears the stored `chat_id`, sets `active = 0`, and invalidates pending unused link tokens.
6. **Comprehensive SSRF & Redirect Guard:** Outbound webhook targets (and every `3xx` redirect `Location` hop under `redirect: "manual"`) require `https://`, forbid embedded credentials, restrict ports to `443`/`8443`, block `localhost`, internal suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`), DNS-rebinding wildcard domains (`.nip.io`, `.sslip.io`, `.xip.io`, `.localtest.me`, `.lvh.me`), single-label hostnames, private/loopback/link-local/CGNAT/metadata IPv4 ranges (`0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `240.0.0.0/4`, plus hex/octal/integer encodings), and private/loopback/ULA/link-local/IPv4-mapped IPv6 ranges (`::`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:*`, NAT64, 6to4, Teredo). Cross-origin redirects on signed webhooks are strictly refused (`CROSS_ORIGIN_REDIRECT_BLOCKED`) so `X-PunyaSitus-Signature` and lead payloads never leak to another origin. At runtime, Cloudflare Workers `fetch()` provides the edge DNS/egress isolation boundary preventing connections to RFC1918/loopback destinations.

---

## Tenant Admin API Endpoints

Base path (exclusively on `app.punyasitus.com`, guarded by `app_session`, RBAC, CSRF/Origin, lifecycle gates, and active `lead-notifier` entitlement):

`/api/tenants/{tenantId}/plugins/lead-notifier`

### `GET /status`
Returns Telegram connection state (masked label only, never raw `chat_id`), webhook config (masked secret only, never raw `signing_secret`), entitlement status, and last 20 scrubbed deliveries.
- **Role-based URL masking:** Full `webhook.targetUrl` is returned **only** for roles with `settings:write` (`owner`, `admin`, `agency_admin`). Read-only roles (e.g. `editor`) receive `targetUrl: null` and origin-only `targetUrlSummary` so secret webhook path tokens are never disclosed.

- **Permission:** `content:read`
- **200 Response:**
  ```json
  {
    "pluginId": "lead-notifier",
    "tenantId": "01J...",
    "telegram": {
      "enabled": true,
      "linked": true,
      "maskedLabel": "@bu***so",
      "chatType": "private",
      "linkedAt": 1795410000000,
      "botUsername": "PunyaSitusBot",
      "tokenTtlSeconds": 900
    },
    "webhook": {
      "entitled": true,
      "configured": true,
      "enabled": true,
      "targetUrl": "https://hooks.crm.example.com/leads",
      "targetUrlSummary": "https://hooks.crm.example.com",
      "secretMasked": "whsec_****9a2f",
      "maxRetries": 3,
      "secretRotatedAt": 1795410000000,
      "updatedAt": 1795410000000
    },
    "deliveries": []
  }
  ```

### `POST /telegram/link-token`
Generates a cryptographically random 15-minute single-use link token (`<= 64` chars) bound to `(tenantId, actorUserId)` and persists its SHA-256 hash in `plg_lead_notifier__link_tokens`.

- **Permission:** `settings:write`
- **201 Response:**
  ```json
  {
    "deepLink": "https://t.me/PunyaSitusBot?start=<one_time_token>",
    "botUsername": "PunyaSitusBot",
    "expiresAt": 1795410900000,
    "expiresInSeconds": 900,
    "singleUse": true
  }
  ```

### `POST /telegram/unlink` (alias: `DELETE /telegram/link`)
Immediately revokes the tenant's active Telegram chat link and invalidates pending unused tokens.

- **Permission:** `settings:write`
- **200 Response:** `{ "ok": true, "linked": false, "revokedAt": 1795410100000 }`

### `POST /webhook` (alias: `PUT /webhook`)
Configures the tenant's SSRF-guarded HTTPS webhook target. Generates an HMAC-SHA256 signing secret on initial creation (returned once in `secretOnce`).

- **Permission:** `settings:write` + server webhook entitlement (`403 WEBHOOK_ENTITLEMENT_REQUIRED` when unentitled)
- **Request Body:** `{ "targetUrl": "https://hooks.crm.example.com/leads", "enabled": true, "maxRetries": 3 }`
- **200 Response:** `{ "webhook": { ... }, "secretOnce": "whsec_..." }`
- **Errors:** `403 WEBHOOK_ENTITLEMENT_REQUIRED`, `422 HTTPS_REQUIRED | EMBEDDED_CREDENTIALS_FORBIDDEN | DISALLOWED_PORT | SSRF_HOST_BLOCKED | SSRF_IP_BLOCKED`

### `DELETE /webhook`
Disables and clears the configured webhook target immediately.

- **Permission:** `settings:write`
- **200 Response:** `{ "ok": true, "configured": false, "enabled": false }`

### `POST /webhook/rotate-secret`
Rotates the tenant's HMAC-SHA256 signing secret and returns the new value once (`secretOnce`) alongside `secretMasked`.

- **Permission:** `settings:write` + server webhook entitlement
- **200 Response:** `{ "secretOnce": "whsec_...", "secretMasked": "whsec_****1c4d", "secretRotatedAt": 1795410200000 }`

### `POST /webhook/test`
Sends a signed `lead.test` payload to the saved (or supplied) SSRF-validated HTTPS target URL and logs the outcome to `plg_lead_notifier__deliveries`.

- **Permission:** `settings:write` + server webhook entitlement
- **200 / 502 Response:** `{ "ok": true, "delivery": { "deliveryId": "wh_...", "status": "delivered", "httpStatus": 200, "attempts": 1, "errorCode": null, "targetSummary": "https://hooks.crm.example.com" } }`

### `GET /deliveries`
Lists the 30 most recent scrubbed delivery records.

---

## Inbound Telegram Bot Webhook

### `POST /api/plugins/lead-notifier/webhook`
Served strictly on `app.punyasitus.com`.

- **Required Header:** `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>` (constant-time check; `401 UNAUTHENTICATED` when missing or mismatched)
- **Payload:** Standard Telegram Bot API Update containing `message.text = "/start <one_time_token>"` and `message.chat.id`
- **Responses:**
  - `401 UNAUTHENTICATED`: Missing or invalid `X-Telegram-Bot-Api-Secret-Token` (unauthenticated caller rejected before body read)
  - `200 OK` (linked): `{ "ok": true, "linked": true, "rejected": false, "tenantId": "...", "maskedLabel": "@bu***so", "linkedAt": ... }`
  - `200 OK` (authenticated Telegram update acknowledged, link rejected without retrying): `{ "ok": false, "linked": false, "rejected": true, "code": "TOKEN_EXPIRED" | "TOKEN_REPLAYED" | "TOKEN_INVALID" | "TOKEN_TENANT_MISMATCH", "message": "..." }`

---

## Outbound Webhook Payload & HMAC-SHA256 Verification

### Headers Sent
- `Content-Type: application/json; charset=utf-8`
- `X-PunyaSitus-Event: lead.created` (or `lead.test`)
- `X-PunyaSitus-Delivery-Id: wh_<random_hex>`
- `X-PunyaSitus-Timestamp: <unix_epoch_seconds>`
- `X-PunyaSitus-Signature: t=<unix_epoch_seconds>,v1=<hmac_sha256_hex>`

### Payload Format
```json
{
  "event": "lead.created",
  "deliveryId": "wh_...",
  "eventId": "lead:42",
  "occurredAt": "2026-11-24T01:00:00.000Z",
  "tenant": {
    "id": "01J...",
    "handle": "alpha-studio",
    "name": "Alpha Studio"
  },
  "lead": {
    "id": 42,
    "name": "Rina Wijaya",
    "phoneE164": "+6281234567890",
    "email": "rina@contoh.id",
    "message": "Mohon penawaran renovasi kantor.",
    "pagePath": "/kontak",
    "sourceCategory": "direct",
    "preferredDate": null,
    "preferredTime": null,
    "preferredBranch": null,
    "whatsappFollowUpUrl": "https://wa.me/6281234567890?text=..."
  }
}
```

### Receiver Signature Verification Example (Node.js)
```js
import crypto from "node:crypto";

export function verifyPunyaSitusWebhook(rawBody, signatureHeader, secret, maxSkewSeconds = 300) {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > maxSkewSeconds) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(parts.v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```
