import {
  escapeHtmlAttribute,
  INDEXABLE_ROBOTS_DIRECTIVES,
  normalizePublicPath,
  sanitizeSeoText,
  validateCanonicalOrigin,
  type SeoRouteKind,
} from "./index.ts";
import {
  DEFAULT_SEARCH_APPEARANCE_SETTINGS,
  renderSearchAppearanceTemplate,
  renderVerificationMetaTags,
  type SearchAppearanceKind,
  type SearchAppearanceSettings,
  type VerificationTokensConfig,
} from "./editor.ts";
import { renderSeoHeadHtml, type SocialMetadataDto } from "../og-generator.ts";
import type { SchemaGraphDocument } from "../schema-generator.ts";
import type { TocHeadingEntry } from "../content/index.ts";

/**
 * Local Entity Schema & Crawlable Content Integration Helpers
 * (`packages/core/src/seo/local-entity.ts`; REQ-054, PLAN §15.4 & §15.7, TASK-053).
 *
 * Pure, runtime-neutral utilities shared across public Astro pages, unit tests,
 * workerd integration tests, and Playwright no-JS crawl verification.
 *
 * Hard Invariants:
 * - Single `<head>` authority: wraps `renderSeoHeadHtml` (TASK-016) + `renderVerificationMetaTags`
 *   (TASK-052) + optional RSS `<link rel="alternate">` (PLAN §15.7) without ever creating a
 *   second schema engine or emitting duplicate `<title>`, `<meta name="robots">`, or `<link rel="canonical">`.
 * - Author SEO (PLAN §15.7): bio <= 300 chars, up to 5 validated public HTTPS `sameAs` links,
 *   verified ready avatar only, no author archive route in v1.
 * - Server-rendered TOC: deterministic heading `id` injection matching `<nav aria-label="Daftar isi">`
 *   anchors 1:1 with zero JavaScript.
 * - Tenant-local internal links: rejects cross-tenant URLs, draft/preview/admin/API routes,
 *   numeric-ID paths, unsafe schemes (`javascript:`, `data:`), and strips tracking query params.
 */

export const MAX_AUTHOR_BIO_LENGTH = 300 as const;
export const MAX_AUTHOR_SAME_AS_LINKS = 5 as const;

const FORBIDDEN_INTERNAL_PREFIXES = [
  "/dashboard",
  "/agency",
  "/affiliate",
  "/console",
  "/auth",
  "/account",
  "/mcp",
  "/oauth2",
  "/api",
  "/preview",
  "/admin",
] as const;

const TRACKING_QUERY_KEY_SET = new Set<string>([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "yclid",
  "dclid",
  "ref",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "si",
]);

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".localdomain") ||
    lower.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (lower.includes(":") || lower.startsWith("[")) return true;
  const labels = lower.split(".");
  if (labels.length <= 4 && labels.every((l) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(l))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Author SEO Normalization (`PLAN §15.7`)
// ---------------------------------------------------------------------------

export interface PublicAuthorAvatarDto {
  readonly id?: number;
  readonly url: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export interface PublicAuthorProfileDto {
  readonly id?: number;
  readonly name: string;
  readonly slug?: string | null;
  readonly bio: string | null;
  readonly roleTitle?: string | null;
  readonly avatar: PublicAuthorAvatarDto | null;
  readonly sameAs: readonly string[];
}

export function normalizeAuthorBio(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = sanitizeSeoText(raw, { maxLength: MAX_AUTHOR_BIO_LENGTH });
  return cleaned.length > 0 ? cleaned : null;
}

export function validatePublicAuthorSameAsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || hasControlChars(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || !/^https:\/\//i.test(trimmed) || /[\\<>"'\s]/.test(trimmed)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return null;
  }
  if (!parsed.hostname.includes(".") || isPrivateOrLocalHostname(parsed.hostname)) {
    return null;
  }
  return parsed.toString();
}

/**
 * Normalizes up to 5 validated public HTTPS `sameAs` links for an author profile.
 * Accepts a JSON array string, single URL string, or array of URL strings.
 */
export function normalizeAuthorSameAsUrls(
  raw: string | readonly string[] | null | undefined,
): readonly string[] {
  if (!raw) return [];
  let candidates: readonly unknown[] = [];

  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        candidates = Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    } else {
      candidates = [trimmed];
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (out.length >= MAX_AUTHOR_SAME_AS_LINKS) break;
    const valid = validatePublicAuthorSameAsUrl(item);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      out.push(valid);
    }
  }
  return out;
}

const SAME_AS_HOST_LABELS: Readonly<Record<string, string>> = {
  "linkedin.com": "LinkedIn",
  "instagram.com": "Instagram",
  "x.com": "X",
  "twitter.com": "X",
  "facebook.com": "Facebook",
  "youtube.com": "YouTube",
  "tiktok.com": "TikTok",
  "github.com": "GitHub",
  "medium.com": "Medium",
  "orcid.org": "ORCID",
};

export function formatAuthorSameAsLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const [domain, label] of Object.entries(SAME_AS_HOST_LABELS)) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        return label;
      }
    }
    return host;
  } catch {
    return "Profil";
  }
}

// ---------------------------------------------------------------------------
// 2. Server-Rendered Table of Contents Heading Anchor Parity (`PLAN §15.7`)
// ---------------------------------------------------------------------------

function stripHtmlTagsToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeadingText(text: string, fallbackIndex: number): string {
  const base = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return base || `section-${fallbackIndex}`;
}

export interface ServerRenderedTocResult {
  readonly html: string;
  readonly toc: readonly TocHeadingEntry[];
}

/**
 * Deterministically extracts H2/H3 entries from already-sanitized post HTML AND
 * ensures every matched `<h2>`/`<h3>` element carries the exact matching `id="..."`
 * attribute so `<a href="#...">` TOC links work 100% natively without JavaScript.
 */
export function injectTocHeadingAnchors(sanitizedHtml: string): ServerRenderedTocResult {
  if (!sanitizedHtml || typeof sanitizedHtml !== "string") {
    return { html: "", toc: [] };
  }

  const toc: TocHeadingEntry[] = [];
  const usedIds = new Map<string, number>();
  const headingRegex = /<(h[23])(\b[^>]*)>([\s\S]*?)<\/\1>/gi;

  const html = sanitizedHtml.replace(
    headingRegex,
    (fullMatch: string, tagName: string, rawAttrs: string, innerHtml: string) => {
      if (toc.length >= 100) return fullMatch;
      const level: 2 | 3 = tagName.toLowerCase() === "h2" ? 2 : 3;
      const text = stripHtmlTagsToText(innerHtml).slice(0, 200);
      if (!text) return fullMatch;

      const baseId = slugifyHeadingText(text, toc.length + 1);
      const seen = usedIds.get(baseId) ?? 0;
      usedIds.set(baseId, seen + 1);
      const id = seen === 0 ? baseId : `${baseId}-${seen + 1}`;
      toc.push({ id, text, level });

      // Remove any existing `id` attribute cleanly and inject deterministic escaped `id`
      const cleanedAttrs = rawAttrs.replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
      const safeTag = level === 2 ? "h2" : "h3";
      return `<${safeTag}${cleanedAttrs} id="${escapeHtmlAttribute(id)}">${innerHtml}</${safeTag}>`;
    },
  );

  return { html, toc };
}

// ---------------------------------------------------------------------------
// 3. Single Public `<head>` Authority Composer (`PLAN §15.1, §15.4, §15.5, §15.7`)
// ---------------------------------------------------------------------------

export function mapRouteKindToSearchAppearanceKind(routeKind: SeoRouteKind): SearchAppearanceKind | null {
  switch (routeKind) {
    case "homepage":
      return "homepage";
    case "page":
      return "page";
    case "post":
      return "post";
    case "offering":
      return "catalog_item";
    case "blog_index":
      return "blog_index";
    case "catalog_index":
      return "catalog_index";
    case "category_archive":
      return "post_category";
    case "tag_archive":
      return "post_tag";
    case "offering_category_archive":
      return "catalog_category";
    default:
      return null;
  }
}

export interface ComposePublicSeoHeadInput {
  readonly metadata: SocialMetadataDto;
  readonly schemaGraph?: SchemaGraphDocument | null;
  /** Whether the `seo-ai-autopilot` plugin is enabled (default `true`). */
  readonly seoAutopilotEnabled?: boolean;
  /** Published verification tokens from `plg_seo_ai_autopilot__settings.published_json` ONLY. */
  readonly publishedVerificationTokens?: VerificationTokensConfig | null;
  /** Emit `<link rel="alternate" type="application/rss+xml" ...>` ONLY when `true` and canonical origin is verified. */
  readonly blogEnabled?: boolean;
  /** Visible site name used for RSS alternate title and minimal fallback `<title>`. */
  readonly siteName?: string;
  /** Optional explicit Search Appearance title/description template override (published only). */
  readonly searchAppearance?: SearchAppearanceSettings | null;
  /** Optional context values for rendering published Search Appearance templates. */
  readonly templateValues?: {
    readonly routeKind?: SeoRouteKind;
    readonly title?: string | null;
    readonly tagline?: string | null;
    readonly category?: string | null;
    readonly excerpt?: string | null;
    readonly pageNumber?: number | null;
    readonly hasTitleOverride?: boolean;
    readonly hasDescriptionOverride?: boolean;
  };
}

export interface ComposedPublicSeoHead {
  readonly html: string;
  readonly effectiveTitle: string;
  readonly effectiveDescription: string;
  readonly robots: string;
  readonly canonical: string | null;
  readonly rssFeedUrl: string | null;
  readonly verificationMetaTags: readonly string[];
  readonly schemaEmitted: boolean;
}

/**
 * Single authoritative public `<head>` HTML composer (`REQ-054`, `PLAN §15.1` & `§15.7`).
 *
 * - Reuses `renderSeoHeadHtml` (TASK-016) and `renderVerificationMetaTags` (TASK-052).
 * - Never creates a second schema engine or emits duplicate `<title>` / `<meta name="robots">`.
 * - When `seoAutopilotEnabled === false` (DEC-039): emits clean minimal `<title>` + mandatory
 *   robots safety directives (e.g. `trial` / `noindex` / `error`) without autopilot OG/verification/schema clutter.
 * - When `seoAutopilotEnabled === true`: applies published Search Appearance templates (when no
 *   explicit resource override was set), emits full OG/Twitter/canonical/default robots directives,
 *   validated published verification tags, RSS alternate link (only when `blogEnabled === true`),
 *   and the single safely escaped `@graph` JSON-LD payload.
 */
export function composePublicSeoHead(input: ComposePublicSeoHeadInput): ComposedPublicSeoHead {
  const autopilotEnabled = input.seoAutopilotEnabled !== false;
  const baseMeta = input.metadata;

  let effectiveMetadata: SocialMetadataDto = baseMeta;
  if (
    autopilotEnabled &&
    input.searchAppearance &&
    input.templateValues?.routeKind &&
    baseMeta.canonical !== null
  ) {
    const kind = mapRouteKindToSearchAppearanceKind(input.templateValues.routeKind);
    if (kind) {
      const pair =
        input.searchAppearance.templates[kind] ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS.templates[kind];
      const sep = input.searchAppearance.separator ?? DEFAULT_SEARCH_APPEARANCE_SETTINGS.separator;

      const templateCtx = {
        title: input.templateValues.title ?? baseMeta.title,
        site_name: input.siteName ?? baseMeta.og.siteName,
        tagline: input.templateValues.tagline ?? null,
        sep,
        category: input.templateValues.category ?? null,
        excerpt: input.templateValues.excerpt ?? baseMeta.description,
        page: input.templateValues.pageNumber ?? baseMeta.seoDecision.pageNumber ?? null,
      };

      const templatedTitle =
        !input.templateValues.hasTitleOverride && pair.titleTemplate
          ? sanitizeSeoText(renderSearchAppearanceTemplate(pair.titleTemplate, templateCtx), {
              maxLength: 70,
            })
          : "";
      const templatedDesc =
        !input.templateValues.hasDescriptionOverride && pair.descriptionTemplate
          ? sanitizeSeoText(renderSearchAppearanceTemplate(pair.descriptionTemplate, templateCtx), {
              maxLength: 160,
            })
          : "";

      const nextTitle = templatedTitle || baseMeta.title;
      const nextDescription = templatedDesc || baseMeta.description;
      if (nextTitle !== baseMeta.title || nextDescription !== baseMeta.description) {
        effectiveMetadata = {
          ...baseMeta,
          title: nextTitle,
          description: nextDescription,
          og: {
            ...baseMeta.og,
            title: baseMeta.og.title === baseMeta.title ? nextTitle : baseMeta.og.title,
            description:
              baseMeta.og.description === baseMeta.description
                ? nextDescription
                : baseMeta.og.description,
          },
          twitter: {
            ...baseMeta.twitter,
            title: baseMeta.twitter.title === baseMeta.title ? nextTitle : baseMeta.twitter.title,
            description:
              baseMeta.twitter.description === baseMeta.description
                ? nextDescription
                : baseMeta.twitter.description,
          },
        };
      }
    }
  }

  // Minimal safe mode when `seo-ai-autopilot` plugin is disabled (PLAN §15.1, DEC-039)
  if (!autopilotEnabled) {
    const minimalLines: string[] = [
      `<title>${effectiveMetadata.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>`,
    ];
    if (effectiveMetadata.description) {
      minimalLines.push(
        `<meta name="description" content="${escapeHtmlAttribute(effectiveMetadata.description)}" />`,
      );
    }
    // Always preserve mandatory noindex safety rules (trial, error, site noindex, resource noindex)
    if (effectiveMetadata.robots !== INDEXABLE_ROBOTS_DIRECTIVES) {
      minimalLines.push(
        `<meta name="robots" content="${escapeHtmlAttribute(effectiveMetadata.robots)}" />`,
      );
    }
    return {
      html: minimalLines.join("\n"),
      effectiveTitle: effectiveMetadata.title,
      effectiveDescription: effectiveMetadata.description,
      robots: effectiveMetadata.robots,
      canonical: null,
      rssFeedUrl: null,
      verificationMetaTags: [],
      schemaEmitted: false,
    };
  }

  const canEmitDiscoveryExtras =
    effectiveMetadata.canonical !== null &&
    effectiveMetadata.verifiedOrigin !== null &&
    effectiveMetadata.seoDecision.httpStatus === 200;

  // Render authoritative base head (title, description, robots, canonical, prev/next, OG, Twitter, JSON-LD)
  const schemaToEmit = canEmitDiscoveryExtras && input.schemaGraph ? input.schemaGraph : undefined;
  const baseHtml = renderSeoHeadHtml(effectiveMetadata, {
    jsonLd: schemaToEmit,
    includeTitle: true,
    includeDescription: true,
  });

  const extraLines: string[] = [];

  // RSS 2.0 discovery alternate link ONLY when blogEnabled === true on verified public routes (PLAN §15.7)
  let rssFeedUrl: string | null = null;
  if (canEmitDiscoveryExtras && input.blogEnabled === true && effectiveMetadata.verifiedOrigin) {
    try {
      const safeOrigin = validateCanonicalOrigin(effectiveMetadata.verifiedOrigin);
      rssFeedUrl = `${safeOrigin}/blog/feed.xml`;
      const rssTitle = sanitizeSeoText(
        `RSS Feed — ${input.siteName || effectiveMetadata.og.siteName}`,
        { maxLength: 120 },
      );
      extraLines.push(
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtmlAttribute(rssTitle)}" href="${escapeHtmlAttribute(rssFeedUrl)}" />`,
      );
    } catch {
      rssFeedUrl = null;
    }
  }

  // Published webmaster verification meta tags ONLY on verified public serving routes (PLAN §15.5)
  const verificationMetaTags: readonly string[] =
    canEmitDiscoveryExtras && input.publishedVerificationTokens
      ? renderVerificationMetaTags(input.publishedVerificationTokens)
      : [];
  for (const tag of verificationMetaTags) {
    extraLines.push(tag);
  }

  const html = extraLines.length > 0 ? `${baseHtml}\n${extraLines.join("\n")}` : baseHtml;

  return {
    html,
    effectiveTitle: effectiveMetadata.title,
    effectiveDescription: effectiveMetadata.description,
    robots: effectiveMetadata.robots,
    canonical: effectiveMetadata.canonical,
    rssFeedUrl,
    verificationMetaTags,
    schemaEmitted: Boolean(schemaToEmit),
  };
}

// ---------------------------------------------------------------------------
// 4. Published Tenant-Local Internal Link Hygiene & Audits (`PLAN §15.4`)
// ---------------------------------------------------------------------------

export interface TenantLinkSanitizeResult {
  readonly ok: boolean;
  readonly href: string | null;
  readonly reason: string | null;
}

/**
 * Validates and cleans a public internal or external link for crawlable public HTML:
 * - Strips tracking params (`utm_*`, `fbclid`, `gclid`, etc.) from internal links.
 * - Rejects `javascript:`, `data:`, `vbscript:`, protocol-relative `//`, admin/preview/API
 *   paths, numeric-ID segments (`/blog/42`), and (when `publishedPaths` is provided)
 *   unpublished/cross-tenant internal targets.
 */
export function sanitizeTenantLocalHref(
  rawHref: string | null | undefined,
  options: {
    readonly verifiedOrigin?: string | null;
    readonly publishedPaths?: ReadonlySet<string> | null;
    /** When `true`, foreign external HTTPS hosts are rejected (for strictly internal CTA/nav links). */
    readonly requireLocal?: boolean;
  } = {},
): TenantLinkSanitizeResult {
  if (typeof rawHref !== "string" || hasControlChars(rawHref)) {
    return { ok: false, href: null, reason: "invalid_type_or_control_char" };
  }
  const trimmed = rawHref.trim();
  if (!trimmed) {
    return { ok: false, href: null, reason: "empty_href" };
  }

  // Pure fragment anchor (`#section-id`)
  if (trimmed.startsWith("#")) {
    return /^#[A-Za-z0-9_-]{1,100}$/.test(trimmed)
      ? { ok: true, href: trimmed, reason: null }
      : { ok: false, href: null, reason: "invalid_fragment" };
  }

  // Safe contact schemes
  if (/^tel:[+0-9()-]{6,24}$/i.test(trimmed)) {
    return options.requireLocal
      ? { ok: false, href: null, reason: "non_local_scheme" }
      : { ok: true, href: trimmed, reason: null };
  }
  if (/^mailto:[^\s<>"]+$/i.test(trimmed)) {
    return options.requireLocal
      ? { ok: false, href: null, reason: "non_local_scheme" }
      : { ok: true, href: trimmed, reason: null };
  }

  // Reject unsafe schemes and protocol-relative URLs
  if (trimmed.startsWith("//") || /^(?:javascript|data|vbscript|file):/i.test(trimmed)) {
    return { ok: false, href: null, reason: "unsafe_scheme" };
  }

  // Convert same-origin absolute URL to root-relative internal path for inspection
  let internalCandidate: string;
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password || parsed.port || isPrivateOrLocalHostname(parsed.hostname)) {
        return { ok: false, href: null, reason: "unsafe_external_host" };
      }
      const lowerHost = parsed.hostname.toLowerCase();
      if (options.verifiedOrigin && parsed.origin.toLowerCase() === options.verifiedOrigin.toLowerCase()) {
        internalCandidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      } else if (options.requireLocal) {
        return { ok: false, href: null, reason: "foreign_host" };
      } else if (
        lowerHost === "app.punyasitus.com" ||
        lowerHost === "console.punyasitus.com" ||
        (options.verifiedOrigin && lowerHost.endsWith(".situsku.click"))
      ) {
        return { ok: false, href: null, reason: "cross_tenant_or_platform_host" };
      } else {
        return { ok: true, href: parsed.toString(), reason: null };
      }
    } catch {
      return { ok: false, href: null, reason: "malformed_url" };
    }
  } else if (trimmed.startsWith("/")) {
    internalCandidate = trimmed;
  } else {
    return { ok: false, href: null, reason: "unsupported_relative_or_scheme" };
  }

  // Inspect internal path + query + fragment
  const hashIdx = internalCandidate.indexOf("#");
  const hashPart = hashIdx >= 0 ? internalCandidate.slice(hashIdx) : "";
  const withoutHash = hashIdx >= 0 ? internalCandidate.slice(0, hashIdx) : internalCandidate;
  const queryIdx = withoutHash.indexOf("?");
  const rawPath = queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash;
  const rawQuery = queryIdx >= 0 ? withoutHash.slice(queryIdx + 1) : "";

  let normalizedPath: string;
  try {
    normalizedPath = normalizePublicPath(rawPath).normalizedPath;
  } catch {
    return { ok: false, href: null, reason: "invalid_internal_path" };
  }

  // Block private/admin/preview/API prefixes
  for (const forbidden of FORBIDDEN_INTERNAL_PREFIXES) {
    if (normalizedPath === forbidden || normalizedPath.startsWith(`${forbidden}/`)) {
      return { ok: false, href: null, reason: "private_or_admin_path" };
    }
  }

  // Reject numeric ID path segments (REQ-061, PLAN §7.1)
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.some((seg) => /^\d+$/.test(seg))) {
    return { ok: false, href: null, reason: "numeric_id_segment" };
  }

  // Verify against published tenant path set when supplied
  if (options.publishedPaths && !options.publishedPaths.has(normalizedPath)) {
    return { ok: false, href: null, reason: "unpublished_or_foreign_target" };
  }

  // Strip tracking query parameters from internal links (PLAN §15.2)
  let cleanQuery = "";
  if (rawQuery) {
    const inParams = new URLSearchParams(rawQuery);
    const outParams = new URLSearchParams();
    for (const [k, v] of inParams.entries()) {
      const lowerKey = k.toLowerCase();
      if (lowerKey.startsWith("utm_") || TRACKING_QUERY_KEY_SET.has(lowerKey)) continue;
      if (lowerKey === "page" && v.trim() === "1") continue;
      outParams.append(k, v);
    }
    const serialized = outParams.toString();
    if (serialized) cleanQuery = `?${serialized}`;
  }

  return {
    ok: true,
    href: `${normalizedPath}${cleanQuery}${hashPart}`,
    reason: null,
  };
}

/**
 * Enforces published-target & internal-link hygiene on already-sanitized public HTML
 * (`PLAN §15.4`, `REQ-054`, `TASK-053`):
 * - Valid published tenant-local links are normalized (tracking params stripped, same-origin
 *   URLs rewritten to clean root-relative paths).
 * - Valid external public HTTPS / `tel:` / `mailto:` links are preserved.
 * - Draft/unpublished/non-existent tenant paths, admin/preview/API links, numeric-ID paths,
 *   cross-tenant SaaS subdomain links, and unsafe schemes are unwrapped to plain visible text
 *   so rendered public HTML never emits broken or leaked live `<a href>` anchors.
 */
export function sanitizeHtmlInternalLinks(
  sanitizedHtml: string,
  options: {
    readonly verifiedOrigin?: string | null;
    readonly publishedPaths?: ReadonlySet<string> | null;
  } = {},
): string {
  if (!sanitizedHtml || typeof sanitizedHtml !== "string") return "";

  const anchorTagRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  return sanitizedHtml.replace(
    anchorTagRegex,
    (_fullMatch: string, rawAttrs: string, innerHtml: string) => {
      const hrefAttrRegex = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
      const hrefMatch = hrefAttrRegex.exec(rawAttrs);
      if (!hrefMatch) {
        return innerHtml;
      }
      const rawEncodedHref = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
      const decodedHref = rawEncodedHref
        .replace(/&amp;/gi, "&")
        .replace(/&#x26;/gi, "&")
        .replace(/&#38;/gi, "&");

      const checked = sanitizeTenantLocalHref(decodedHref, {
        verifiedOrigin: options.verifiedOrigin,
        publishedPaths: options.publishedPaths,
      });

      if (!checked.ok || !checked.href) {
        return innerHtml;
      }

      const cleanedAttrs = rawAttrs.replace(
        hrefAttrRegex,
        `href="${escapeHtmlAttribute(checked.href)}"`,
      );
      return `<a${cleanedAttrs}>${innerHtml}</a>`;
    },
  );
}

// ---------------------------------------------------------------------------
// 5. Rendered HTML & JSON-LD Single-Authority / Parity Auditor (`TASK-053`)
// ---------------------------------------------------------------------------

export interface ExtractedJsonLdBlock {
  readonly raw: string;
  readonly parsed: Record<string, unknown> | null;
  readonly parseError: string | null;
}

export function extractJsonLdBlocksFromHtml(html: string): readonly ExtractedJsonLdBlock[] {
  const blocks: ExtractedJsonLdBlock[] = [];
  const regex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const raw = (match[1] ?? "").trim();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        blocks.push({ raw, parsed: parsed as Record<string, unknown>, parseError: null });
      } else {
        blocks.push({ raw, parsed: null, parseError: "JSON-LD root must be a JSON object." });
      }
    } catch (err) {
      blocks.push({
        raw,
        parsed: null,
        parseError: err instanceof Error ? err.message : "Invalid JSON-LD",
      });
    }
  }
  return blocks;
}

export interface RenderedPublicPageSeoAudit {
  readonly titleCount: number;
  readonly robotsMetaCount: number;
  readonly canonicalCount: number;
  readonly jsonLdCount: number;
  readonly robotsContents: readonly string[];
  readonly canonicalHref: string | null;
  readonly rssAlternateHref: string | null;
  readonly h1Count: number;
  readonly hasIframeMapBeforeConsent: boolean;
  readonly hasDeprecatedProfessionalService: boolean;
  readonly hasFabricatedRatingOrReview: boolean;
  readonly hasMerchantListingProps: boolean;
  readonly invalidInternalLinks: readonly { readonly href: string; readonly reason: string }[];
  readonly jsonLdBlocks: readonly ExtractedJsonLdBlock[];
}

export function auditRenderedPublicPageSeo(
  html: string,
  options: {
    readonly verifiedOrigin?: string | null;
    readonly publishedPaths?: ReadonlySet<string> | null;
  } = {},
): RenderedPublicPageSeoAudit {
  const titleMatches = html.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) ?? [];
  const robotsMatches = [
    ...html.matchAll(/<meta\b[^>]*name\s*=\s*["']robots["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*\/?>/gi),
    ...html.matchAll(/<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']robots["'][^>]*\/?>/gi),
  ];
  const canonicalMatch =
    /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*\/?>/i.exec(html) ??
    /<link\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*rel\s*=\s*["']canonical["'][^>]*\/?>/i.exec(html);
  const canonicalMatches = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*\/?>/gi) ?? [];
  const rssMatch =
    /<link\b[^>]*type\s*=\s*["']application\/rss\+xml["'][^>]*href\s*=\s*["']([^"']*)["'][^>]*\/?>/i.exec(
      html,
    ) ??
    /<link\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*type\s*=\s*["']application\/rss\+xml["'][^>]*\/?>/i.exec(
      html,
    );
  const h1Matches = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) ?? [];
  const hasIframeMapBeforeConsent =
    /<iframe\b[^>]*src\s*=\s*["'][^"']*(?:google\.com\/maps|maps\.google|openstreetmap|mapbox)[^"']*["']/i.test(
      html,
    );

  const jsonLdBlocks = extractJsonLdBlocksFromHtml(html);
  const allJsonLdRaw = jsonLdBlocks.map((b) => b.raw).join("\n");
  const hasDeprecatedProfessionalService = /"ProfessionalService"/i.test(allJsonLdRaw);
  const hasFabricatedRatingOrReview = /"(?:AggregateRating|aggregateRating|review)"/i.test(
    allJsonLdRaw,
  );
  const hasMerchantListingProps = /"(?:shippingDetails|hasMerchantReturnPolicy|checkoutPageURLTemplate)"/i.test(
    allJsonLdRaw,
  );

  const invalidInternalLinks: { readonly href: string; readonly reason: string }[] = [];
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const href = anchorMatch[1] ?? "";
    const checked = sanitizeTenantLocalHref(href, {
      verifiedOrigin: options.verifiedOrigin,
      publishedPaths: options.publishedPaths,
    });
    if (!checked.ok && checked.reason) {
      invalidInternalLinks.push({ href, reason: checked.reason });
    }
  }

  return {
    titleCount: titleMatches.length,
    robotsMetaCount: robotsMatches.length,
    canonicalCount: canonicalMatches.length,
    jsonLdCount: jsonLdBlocks.length,
    robotsContents: robotsMatches.map((m) => m[1] ?? ""),
    canonicalHref: canonicalMatch?.[1] ?? null,
    rssAlternateHref: rssMatch?.[1] ?? null,
    h1Count: h1Matches.length,
    hasIframeMapBeforeConsent,
    hasDeprecatedProfessionalService,
    hasFabricatedRatingOrReview,
    hasMerchantListingProps,
    invalidInternalLinks,
    jsonLdBlocks,
  };
}
