# ADR-0005: Native Lead Capture Form & Structured Analytics IDs over Raw Script Injection

> Review note (2026-09-25): historical decision rationale; implementation contracts and unresolved gates are in ../../PLAN.md. ADR-0006 (accepted for routing, theme loading and public ingestion by DEC-029 on 2026-11-14; tracker item superseded by DEC-027) overrides conflicting historical details below. Accepted status below is inherited, not a new approval.

- **Status:** Accepted
- **Date:** 2026-09-24
- **Author:** Business System Architect
- **Deciders:** Paduka Ongki, System Architecture Team
- **Supersedes:** None

## 1. Context
Company profile and service websites in Indonesia require two essential marketing capabilities:
1. A way for visitors to submit inquiry/contact forms (request quotation, consultation request, general questions) beyond immediate WhatsApp chats.
2. Ad tracking integration (Meta Pixel, Google Tag Manager / GA4, TikTok Pixel) to optimize paid ad campaigns (FB/IG Ads, TikTok Ads) and track conversion events.

In traditional WordPress environments, users install form plugins (WPForms, Contact Form 7) and tracking plugins (PixelYourSite) or paste raw JavaScript into header/footer injection plugins. This introduces major security vulnerabilities (cross-site scripting / XSS attacks, malicious script defacements) and degrades page loading speed.

## 2. Decision
Implement **Native Lead Capture** and **Structured Analytics Tracking** as core platform features while strictly disallowing raw script injection:

1. **Native Lead Capture Form**:
   - Built-in accessible form section in the Default Theme and Astro public site: Name, WhatsApp/Phone, Email (optional), and Message.
   - Form submissions POST to `/api/tenants/:id/leads` with rate limiting and CSRF protection.
   - Submissions are stored in the tenant-scoped `leads` table with status `new`.
   - The admin dashboard provides a dedicated **Leads Inbox** where tenants can review inquiries, update status (`new`, `contacted`, `closed`), and 1-click open a pre-filled WhatsApp chat to respond to the lead.
2. **Structured Analytics IDs (No Raw Scripts)**:
   - Tenants configure only verified tracking identifiers in Tenant Settings: Meta Pixel ID, Google Tag Manager / GA4 ID, and TikTok Pixel ID.
   - The Astro public site safely injects official async tracking snippets using these validated IDs.
   - Raw HTML/JavaScript injection in headers or footers is rejected (enforcing strict Content Security Policy / CSP).
3. **Automated Conversion Event Dispatch**:
   - Both WhatsApp CTA clicks and successful Lead Form submissions automatically trigger client-side `Lead` and `Contact` conversion events to active tracking tags.

## 3. Consequences

### Positive
- **Reduced script surface**: Structured IDs reduce direct injection paths, but GTM governance, sanitization and enforced CSP still need verification.
- **Immediate Lead Visibility**: Inquiries land directly in the tenant's dashboard without relying on third-party form SaaS or external email delivery reliability.
- **Conversion signals**: Configured, consented integrations can report inquiry events; optimization quality and sales outcomes are not guaranteed.

### Negative
- Tenants cannot paste arbitrary third-party JavaScript widgets (e.g. obscure custom chat bots) into the page unless explicitly supported by platform modules.

### Neutral
- Form submission data remains entirely under the tenant's ownership within their dedicated database records.
