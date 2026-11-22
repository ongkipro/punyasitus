# ADR-0004: Native Mini-Catalog with WhatsApp CTA & Link-Out over Internal Checkout Cart

> Review note (2026-09-25): historical decision rationale; implementation contracts and unresolved gates are in ../../PLAN.md. ADR-0006 (accepted for routing, theme loading and public ingestion by DEC-029 on 2026-11-14; tracker item superseded by DEC-027) overrides conflicting historical details below. Accepted status below is inherited, not a new approval.

- **Status:** Accepted
- **Date:** 2026-09-24
- **Author:** Business System Architect
- **Deciders:** Paduka Ongki, System Architecture Team
- **Supersedes:** None

## 1. Context
Traditional e-commerce platforms (WooCommerce, Shopify, Magento) force all commerce transactions into a standardized multi-step funnel: Add to Cart → Cart Drawer → Shipping Address → Courier Selection → Payment Gateway → Order Received.

In the Indonesian business landscape (especially for company profiles, tour & Umrah operators, offline retail brands, and professional services):
- Assumption: some target tenants benefit from WhatsApp conversations to confirm availability, specifications and payment details. The original percentage had no supporting source and is not retained as evidence.
- For physical retail products, consumers frequently prefer purchasing via established marketplace ecosystems (Shopee, Tokopedia, TikTok Shop) due to subsidized shipping vouchers and buyer protection.
- Introducing a rigid, mandatory shopping cart introduces severe checkout abandonment and requires maintaining complex third-party courier balance APIs, payment custody, and shipping rate synchronizations.

## 2. Decision
Replace complex internal shopping cart systems with a native **Mini-Catalog Engine** equipped with **WhatsApp Click-to-Chat CTA** and **External Link Out** capabilities:

1. **Catalog Architecture**: Tenants create items with Indonesian Rupiah prices (`Rp 1.500.000`), optional strikethrough original prices, promotional badge labels ("Promo", "Best Seller", "Slot Terbatas"), and custom vertical specifications (e.g. itinerary, branch availability).
2. **Action Dispatcher**: Each item defines an Action Type:
   - `whatsapp`: Dynamically compiles an Indonesian-normalized phone number (`628xxxxxxxxxx`) and a customizable message template containing dynamic tokens `{{item_title}}`, `{{item_price}}`, and `{{page_url}}`, outputting a direct `https://wa.me/...` URL.
   - `external_link`: Validates the destination URL and renders a secure external link with `target="_blank"` and `rel="noopener noreferrer nofollow"`.
3. **Conversion Signals**: Clicking the CTA button emits a non-blocking client-side `Lead` or `Contact` event to active Meta Pixel, TikTok Pixel, and Google Analytics tags.

## 3. Consequences

### Positive
- **Frictionless Conversion**: Direct alignment with real Indonesian consumer buying habits; no internal cart step; conversion uplift remains unverified.
- **No Public site Payment/Courier Maintenance**: Tenant catalog conversions remain WA/link-out without platform checkout or shipment handling. Amendment 2026-09-25: the platform's own tenant subscriptions use AutoLaris under PLAN.md section 16; payment reconciliation overhead exists for that separate flow.
- **Instant Tenant Value**: Enables tenants to start generating qualified WhatsApp leads on day one.

### Negative
- Does not support automated in-platform credit card / VA checkout or automated courier label printing in v1.
- Final order value reconciliation is managed by tenant CS in WhatsApp rather than an internal platform order ledger.

### Neutral
- If an enterprise client eventually requires full automated checkout, it can be added as a specialized module or linked externally.
