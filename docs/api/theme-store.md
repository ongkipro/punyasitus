# Commercial Theme Store & Style Variants API Contract (`REQ-096`, `TASK-096`)

All tenant endpoints live on `app.punyasitus.com` (returning `404` on tenant/marketing/console hosts), require an authenticated Better Auth session, verify live `PLATFORM_DB` organization membership, and enforce exact same-origin CSRF checks (`Origin` + `Content-Type: application/json`) on every state-changing request.

All console endpoints live on `console.punyasitus.com`, require an active `platform_operators` grant, and require fresh 2FA step-up (`<= 10m`) + explicit audit reason on mutations.

## 1. List Tenant Theme Library, Style Variants & Commercial Theme Store

`GET /api/tenants/:tenantId/themes`

- **Auth:** `content:read` (Owner/Admin/Editor).
- **Headers:** `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`.
- **Response (`200 OK`):**
  - `activeThemeId`: active published theme ID.
  - `activeStyleVariantId`: active style variant key for the active theme.
  - `themes`: granted themes (`6` included platform themes + active `custom-*` grants for THIS tenant only), each including `styleVariants` (4+ WCAG-AA-verified variants with `swatches`, `fontLabel`, `wcagAaPassed`, `minContrastRatio`, `customFontCount`).
  - `premiumThemes`: curated `paid_once` marketplace themes (`premium-atelier-editorial`, `premium-nusantara-flagship`) with server `priceIdr`, `entitled` boolean (strictly per-website), `styleVariants`, `latestOrder`, and `receipt`.
  - `receipts`: numbered receipts (`INV-THM-YYYY-NNNNNN`) belonging exclusively to this website.

## 2. Draft Compatibility & Pre-Purchase Preview

`POST /api/tenants/:tenantId/themes/preview`

- **Auth:** `settings:read` (Owner/Admin; Editor -> `403 FORBIDDEN`).
- **Body:** `{ "themeId": string, "styleVariantId"?: string }`
- **Headers:** `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`.
- **Behavior:**
  - Allows safe draft preview of any included theme, granted custom theme, OR **unpurchased `paid_once` premium theme** before purchase.
  - Output HTML includes `<meta name="robots" content="noindex, nofollow">` and renders in `sandbox=""`.
  - NEVER mutates live `site_settings`, `theme_configs`, or `cache_version`.
  - Ungranted `custom-*` themes remain blocked with `403 THEME_NOT_GRANTED`.

## 3. Atomic Theme Activation (with Strict Per-Website Entitlement Guard)

`POST /api/tenants/:tenantId/themes/activate`

- **Auth:** `settings:publish` (Owner/Admin; Editor -> `403 FORBIDDEN`; locked/suspended -> `403 SUBSCRIPTION_LOCKED`).
- **Body:** `{ "themeId": string, "styleVariantId"?: string, "expectedVersion": number, "confirm": true }`
- **Behavior:**
  - Unpurchased `paid_once` theme -> **`403 FORBIDDEN` (`THEME_NOT_ENTITLED`)** — even if another website owned by the same user purchased the theme.
  - Ungranted `custom-*` theme -> `403 THEME_NOT_GRANTED`.
  - Stale `expectedVersion` -> `409 STALE_VERSION`.
  - On success (`200 OK`): atomically switches theme & style variant while preserving 100% of pages, sections, offerings, posts, menus, and media.

## 4. Instant Style Variant Apply

`POST /api/tenants/:tenantId/themes/variants`

- **Auth:** `settings:publish` (Owner/Admin; Editor -> `403 FORBIDDEN`).
- **Body:** `{ "themeId"?: string, "styleVariantId": string, "expectedVersion": number }`
- **Behavior:**
  - Enforces entitlement on `paid_once` (`403 THEME_NOT_ENTITLED`) and `custom` themes (`403 THEME_NOT_GRANTED`).
  - Validates `styleVariantId` against the closed WCAG-AA catalog (`422 THEME_VARIANT_NOT_FOUND` on unknown key).
  - Applies tokens/variants atomically with 0% content loss and bumps `cache_version`.

## 5. Commercial Theme Store Checkout

`POST /api/tenants/:tenantId/themes/checkout`

- **Auth:** `settings:publish` (Owner/Admin; Editor -> `403 FORBIDDEN`).
- **Headers:** `Idempotency-Key` (optional header or body field; defaults to fresh UUID).
- **Body:** `{ "themeId": string, "channelCode"?: "QRIS" | "VA_BCA" | "VA_BNI" | "VA_BRI" | "VA_MANDIRI" | "VA_PERMATA", "couponCode"?: string, "idempotencyKey"?: string }`
- **Security & Integrity:**
  - Client-supplied price/amount/discount fields (`priceIdr`, `amount`, `totalPayableIdr`, `discountAmountIdr`, etc.) are rejected with `422 THEME_CHECKOUT_CLIENT_PRICE_FORBIDDEN`.
  - Server computes `basePriceIdr - discountAmountIdr + channelFeeIdr = totalPayableIdr` from `PLATFORM_DB.theme_catalog` + `promo_coupons` enforcing `>= Rp 10.000` AutoLaris floor and single-coupon anti-stacking.
  - At most one open order (`status IN ('pending', 'review')`) per `(tenant_id, theme_id)` is enforced via partial unique index (`409 OPEN_ORDER_EXISTS`); a single tenant cannot reserve the same coupon across concurrent open orders.
  - Already-entitled tenant receives `409 THEME_ALREADY_ENTITLED`.
  - Payment instructions emitted before live AutoLaris Create Order (`/submit`) activation are explicitly tagged `mode: "sandbox_stub"`.

## 6. Server-Verified AutoLaris Order Settlement

`POST /api/tenants/:tenantId/themes/orders/:orderId/settle`

- **Auth:** `settings:publish` (Owner/Admin).
- **Body:** Empty or `{ "idempotencyKey"?: string }`. **Client-supplied payment proof fields (`rc`, `paymentStatus`, `paidAmountIdr`, `providerTransactionId`, `reffId`, `settledAtMs`) are NEVER accepted or trusted** — any such fields are ignored.
- **Behavior:**
  - Fetches the authoritative AutoLaris Advice observation strictly via the server-side `ThemeStoreAdvicePort` (`fetchAdvice`). In production without live AutoLaris credentials configured, fails closed with `503 AUTOLARIS_ADVICE_UNCONFIGURED` (zero grant).
  - Evaluates the server observation through `evaluateAdviceSettlement` (rejects generic `"00"`/`"OK"`/`"SUCCESS"` or shipping tokens; verifies exact integer IDR amount, `"IDR"` currency, `providerTransactionId`, and `reffId`).
  - Supports both `pending -> paid` and `review -> paid` transitions; unverified responses never terminalize an order to `failed`/`expired`.
  - Uses server `nowMs` exclusively for `settled_at`, `issued_at`, and fiscal year receipt counters.
  - Pre-existing entitlement for `(tenant_id, theme_id)` returns `409 THEME_ALREADY_OWNED` without burning a receipt sequence number.
  - Coupon redemption (`promo_coupons.redeemed_count < max_redemptions`) is enforced atomically inside the settlement batch; if exhausted concurrently, the order transitions to `review` (`409 COUPON_EXHAUSTED`) with zero burned receipt sequence and zero entitlement grant.
  - Confirmed settlement atomically: marks order `paid`, inserts `tenant_theme_entitlements` scoped to THIS `(tenant_id, theme_id)` only, allocates gap-free `INV-THM-YYYY-NNNNNN`, inserts immutable `theme_store_receipts` (with `tenant_name_snapshot` and `payer_name_snapshot` for bit-identical PDF regeneration), and appends `platform_audit`.
  - Replaying settlement on an already-settled order returns `idempotentReplay: true` with the existing entitlement and receipt (zero double-grant, zero duplicate receipt).

## 7. Download Numbered Theme PDF Receipt

`GET /api/tenants/:tenantId/themes/receipts/:receiptId`

- **Auth:** `settings:read` (Owner/Admin).
- **Headers:** `Content-Type: application/pdf`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`.
- **Behavior:**
  - Strictly scoped to `tenantId` (`404 THEME_RECEIPT_NOT_FOUND` for another tenant's receipt).
  - Returns valid `%PDF-1.4` document with `INV-THM-YYYY-NNNNNN` number, IDR breakdown, and non-PKP disclosure (or JSON metadata with `?format=json`). Fallback regeneration reads immutable `tenant_name_snapshot` & `payer_name_snapshot` so regenerated bytes reproduce the exact stored `pdf_sha256`.

## 8. Console Theme Store Catalog & Entitlements

- `GET /api/console/custom-themes/store` — lists catalog (`included`, `paid_once`, `custom`), active entitlements, recent orders, and receipts.
- `POST /api/console/custom-themes/store` — operator-only (2FA step-up + CSRF + `reason >= 5 chars` + `<= 16 KiB` body) audited grant of a `paid_once` or `custom` theme entitlement to a specific tenant (`included` themes rejected with `422 THEME_GRANT_NOT_APPLICABLE`).
