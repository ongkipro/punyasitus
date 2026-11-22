# infra/cloudflare

Declarative, reviewable Cloudflare topology configuration for PunyaSitus (`PLAN.md` §2, §3, §12, `ADR-0009`, `REQ-041`, `REQ-095`). Protected (R3).

> **Zero live mutations & zero credentials:** Files in this directory describe the target Cloudflare configuration and are statically checked by `scripts/verify/routes.mjs --check-config`. They never invoke the Cloudflare API, never deploy, and never store raw API tokens, zone IDs, or Turnstile keys.

## Contents

- [`topology.json`](./topology.json) — Machine-validated declarative topology covering:
  - **Resource isolation:** Every Cloudflare resource uses the `punyasitus-*` prefix and never references or mutates resources of other projects (`adsbook-*`, etc.) on the same account.
  - **Worker exposure lock:** `workers_dev: false` and `preview_urls: false` (enforced in both `apps/web/wrangler.jsonc` and Worker runtime routing).
  - **Production & Staging separation:** Staging owns a **separate SaaS zone** (`situsku-staging.click`) and its own **separate fallback origin** (`fallback.situsku-staging.click`) because Cloudflare's `fallback_origin` is a per-zone setting.
  - **Platform zone (`punyasitus.com`):** Workers Custom Domains for `punyasitus.com`, `www.punyasitus.com` (`308` -> apex), `app.punyasitus.com`, and `console.punyasitus.com` -> `punyasitus-web`.
  - **SaaS zone (`situsku.click` prod / `situsku-staging.click` staging):** Originless proxied `AAAA @ 100::`, `AAAA * 100::`, `AAAA fallback 100::`, `CNAME cname -> fallback.<saas-zone>`, and Worker routes `*/*` plus explicit `cname.<saas-zone>/*` for Orange-to-Orange (O2O) customers proxied through their own Cloudflare zone.
  - **AI crawler & WAF policy (`REQ-095`):** Free **`Markdown for Agents` enabled**, **Free Bot Fight Mode OFF** (never JS-challenging verified search/AI fetchers), and WAF/rate-limiting rules strictly within Free zone plan limits (`<= 5` custom rules, `<= 1` rate-limiting rule per zone).
  - **Non-Enterprise boundary:** Explicitly disables Enterprise-only features (`wildcard_custom_hostnames: false`, `custom_metadata: false`, `apex_proxying: false`).
  - **Secrets & Turnstile keys by name only:** References `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_AUTH_SITE_KEY`, `TURNSTILE_AUTH_SECRET_KEY`, `CF_SAAS_ZONE_API_TOKEN`, `AUTH_SECRET`, and `CONSOLE_AUTH_SECRET` by variable/secret name only.

## Validation

Run offline configuration verification (zero network calls):

```bash
node scripts/verify/routes.mjs --check-config
```

Operational setup and authorized staging verification steps live in [`docs/operations/hosting.md`](../../docs/operations/hosting.md).
