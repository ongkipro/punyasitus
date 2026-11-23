# AI Writing Suggestions API Contract (`TASK-074`, `REQ-075`, `DEC-026`, `DEC-028`, `DEC-046`)

All endpoints live strictly on the authenticated `app` surface (`app.punyasitus.com`) and enforce:

- **Host isolation:** Tenant hosts (`*.situsku.click` / custom domains), marketing hosts, and `console.` return neutral `404`.
- **Authentication & session ceiling:** Valid `__Host-` session required (`401 UNAUTHENTICATED`).
- **CSRF & `Origin` verification:** Enforced on `POST` (`403 CSRF_FAILED` / `INVALID_ORIGIN`).
- **Tenant isolation:** Non-members or unknown tenant selectors return neutral `404 NOT_FOUND`.
- **Live entitlement gate:**
  - `purging` / `purged` -> neutral `404`.
  - `locked`, `suspended`, `recovery`, or `operatorHold` -> `403 SUBSCRIPTION_LOCKED` on `POST /suggest` (and `suspended`/`recovery`/`operatorHold` on `GET /quota`).
- **RBAC:** `GET /quota` requires `content:read`; `POST /suggest` requires `content:write` (Owner, Admin, Editor, Agency Admin; insufficient role -> `403 FORBIDDEN`).
- **Human-in-the-loop invariant:** Neither endpoint mutates `pages`, `posts`, or `offerings`. Suggestions are returned strictly as editable plain-text drafts; nothing is saved or published automatically.
- **Strict field minimization & pre-send PII blocker:**
  - Only explicitly selected editorial fields (`currentText`, `title`, `summary`, `category`, `keyPoints`) plus the authoritative `tenants.vertical` from `PLATFORM_DB` are forwarded to the provider.
  - Lead records, account fields, and unselected fields are rejected (`422 VALIDATION_ERROR`) or excluded.
  - Linear `O(n)` pre-send PII scanner blocks email addresses, Indonesian/international phone numbers (`+62`, `08xx`, `(021)...`, `wa.me/...`), and NIK/NPWP patterns with `422 AI_PII_DETECTED` **before** calling the AI provider and **without** consuming quota.
- **Zero-prompt logging & audit:** `ai_writing_usage`, `platform_audit`, and structured telemetry store metadata ONLY (`tenantId`, `actorUserId`, `fieldKind`, `vertical`, `selectedFieldKeys`, `status`, `errorCode`, `model`, `tokenCount`, `latencyMs`, `quotaUsed`). Prompt text, selected input values, raw PII, and generated suggestions are NEVER stored or logged.
- **Private response headers:** `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`.

---

## Cloudflare Workers AI Model Selection (`DEC-046`)

Inference runs through the Cloudflare Workers `env.AI` binding behind `AiWritingProviderPort` (`AiWritingPort`) and routes via Cloudflare AI Gateway (`punyasitus-ai-writing`, payload logging disabled).

| Workers AI Catalog Model | Bahasa Indonesia Editorial Quality | Relative Latency & Cost (Neurons / 1k tokens) | Decision |
|---|---|---|---|
| `@cf/meta/llama-3.1-8b-instruct-fast` | Natural formal/friendly Indonesian copy for titles, excerpts, product/service descriptions, and meta descriptions; respects plain-text and length bounds reliably. | Low latency (~0.5–1.5s), very low cost (~$0.045/M input, ~$0.384/M output) — fits `Rp 179.000/mo` margin at `100` suggestions/30d (`DEC-028`). | **Selected default (`DEFAULT_WORKERS_AI_MODEL`)** |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Slightly richer phrasing on long-form descriptions, higher nuance. | ~6–8x higher neuron cost and higher latency for short CMS fields. | Optional future override via server config (no new DEC needed per `DEC-046`). |
| `@cf/mistral/mistral-7b-instruct-v0.2` | Adequate English, noticeably weaker Indonesian register and instruction adherence on length limits. | Low cost, lower Bahasa Indonesia fluency. | Rejected. |

---

## 1. Read Tenant AI Writing Quota

### `GET /api/tenants/:tenantId/ai-writing/quota`

- **Permission:** `content:read` (Owner, Admin, Editor, Agency Admin)
- **Response `200 OK`:**
  ```json
  {
    "quota": {
      "used": 14,
      "limit": 100,
      "remaining": 86,
      "windowDays": 30,
      "nextResetAt": "2026-12-20T08:00:00.000Z"
    },
    "vertical": "compro",
    "canGenerate": true,
    "providerLabel": "Cloudflare Workers AI",
    "requestId": "req_0123456789abcdef"
  }
  ```
- On `locked` tenants: returns `200` with `"canGenerate": false` (read-only visibility while generation remains blocked with `403 SUBSCRIPTION_LOCKED`).

---

## 2. Generate Editorial Draft Suggestion

### `POST /api/tenants/:tenantId/ai-writing/suggest`

- **Permission:** `content:write` (Owner, Admin, Editor, Agency Admin)
- **Content-Type:** `application/json` (body strictly `<= 16 KiB`)
- **Request Body (`.strict()`):**
  ```json
  {
    "fieldKind": "offering_description",
    "selectedFields": ["title", "currentText", "category"],
    "fields": {
      "title": "Jasa Renovasi Kantor Modern",
      "currentText": "Renovasi interior kantor untuk ruang kerja tim 10-50 orang di Jakarta.",
      "category": "Arsitektur & Interior"
    },
    "tone": "profesional"
  }
  ```
  - `fieldKind`: `"title"` (max 120 chars output) | `"excerpt"` (max 300 chars) | `"offering_description"` (max 1,500 chars) | `"meta_description"` (max 160 chars).
  - `selectedFields`: non-empty allowlist subset of `["currentText", "title", "summary", "category", "keyPoints"]`.
  - `fields`: MUST contain ONLY keys listed in `selectedFields` (combined length `<= 4,000` chars). Any unselected key or forbidden key (`leads`, `email`, `phone`, `tenantId`, `userId`, `role`, `prompt`, etc.) returns `422 VALIDATION_ERROR`.
  - `tone` (optional): `"profesional"` (default) | `"ramah"` | `"ringkas"` | `"persuasif"`.

- **Response `200 OK`:**
  ```json
  {
    "suggestion": "Layanan renovasi interior kantor profesional untuk ruang kerja modern berkapasitas 10 hingga 50 orang...",
    "fieldKind": "offering_description",
    "vertical": "compro",
    "tone": "profesional",
    "model": "@cf/meta/llama-3.1-8b-instruct-fast",
    "factCheckReminder": "Periksa kembali fakta, harga, dan izin usaha sebelum menyimpan atau menerbitkan. Saran AI tidak pernah disimpan atau diterbitkan secara otomatis.",
    "quota": {
      "used": 15,
      "limit": 100,
      "remaining": 85,
      "windowDays": 30,
      "nextResetAt": "2026-12-20T08:00:00.000Z"
    },
    "requestId": "req_0123456789abcdef"
  }
  ```

### Error Responses

| HTTP Status | `error.code` | Trigger & Quota Behavior |
|---|---|---|
| `401` | `UNAUTHENTICATED` | Missing/expired session cookie. `0` quota consumed. |
| `403` | `CSRF_FAILED` / `INVALID_ORIGIN` | Missing or mismatched `Origin` / `Sec-Fetch-Site`. `0` quota consumed. |
| `403` | `SUBSCRIPTION_LOCKED` | Tenant is `locked`, `suspended`, `recovery`, or under `operatorHold`. `0` quota consumed. |
| `403` | `FORBIDDEN` | Authenticated member lacks `content:write`. `0` quota consumed. |
| `404` | `NOT_FOUND` | Non-app host, non-member, cross-tenant selector, or purged tenant. `0` quota consumed. |
| `413` | `PAYLOAD_TOO_LARGE` | Request body exceeds `16 KiB`. `0` quota consumed. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Non-JSON `Content-Type`. `0` quota consumed. |
| `422` | `VALIDATION_ERROR` | Schema error, unselected fields provided, or forbidden keys (`leads`, `tenantId`, etc.). `0` quota consumed. |
| `422` | `AI_PII_DETECTED` | Email address, Indonesian/international phone number, WhatsApp number link, or NIK/NPWP detected in selected text. Provider is NEVER called; `0` quota consumed. Response includes `detectedKinds` (category names only, never raw PII). |
| `429` | `AI_RATE_LIMITED` | Per-user (`6/min`) or per-tenant (`15/min`) burst limit exceeded. Includes `Retry-After`. `0` quota consumed. |
| `429` | `AI_QUOTA_EXCEEDED` | Tenant has reached `100/100` active suggestions in the trailing 30-day (720h) rolling window (`DEC-028`). Includes `Retry-After`, Bahasa Indonesia explanation with next reset time, and `error.quota`. |
| `502` / `504` | `AI_PROVIDER_ERROR` / `AI_PROVIDER_TIMEOUT` | Upstream Workers AI failure, timeout (enforced at **`15 s` / `15_000 ms`**, `DEFAULT_WORKERS_AI_TIMEOUT_MS`), or empty output. Reserved quota slot is atomically released (`status = 'failed'`), consuming **`0` quota**. Note: Cloudflare Workers AI `env.AI.run` v1 does not accept an `AbortSignal`, so on `504 AI_PROVIDER_TIMEOUT` after `15 s` (`15_000 ms`) the Worker responds immediately and refunds tenant quota (`0` consumed) while the underlying upstream Workers AI call is not cancelled in-flight and may settle asynchronously. |
