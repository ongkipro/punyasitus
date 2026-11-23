/**
 * Pure SEO Crawl, HTML `<head>` / Whole-Document XSS, JSON-LD `@graph`, XML Sitemap/RSS,
 * RFC 9309 `robots.txt`, and Internal/Cross-Tenant Link Integrity Auditor for TASK-054
 * (`REQ-055`, `PLAN.md §15`).
 *
 * Runtime-neutral (works in Node unit tests, Cloudflare `workerd` integration tests,
 * and E2E crawl assertions with zero external dependencies).
 */

export const SITEMAP_MAX_URLS_CONTRACT = 50_000 as const;
export const SITEMAP_MAX_BYTES_CONTRACT = 50_000_000 as const;
export const DEFAULT_ALLOWED_MEDIA_ORIGINS: readonly string[] = ["https://media.punyasitus.com"];

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
]);

const ALLOWED_XML_ENTITY_RE = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/;
/**
 * W3C Datetime format accepted by Sitemap 0.9 `<lastmod>`:
 * `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM(:SS(.fff)?)?(Z|[+-]HH:MM)`.
 */
const W3C_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// ---------------------------------------------------------------------------
// 1. Strict XML 1.0 & Sitemap / Sitemap Index Parser
// ---------------------------------------------------------------------------

export interface CrawlXmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly CrawlXmlNode[];
  readonly text: string;
}

function isLegalXml10CodePoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function decodeXmlEntitiesStrict(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "&") {
      const semi = raw.indexOf(";", i + 1);
      if (semi === -1) {
        throw new Error(`Unescaped '&' in XML content near: ${raw.slice(i, i + 24)}`);
      }
      const entity = raw.slice(i, semi + 1);
      if (!ALLOWED_XML_ENTITY_RE.test(entity)) {
        throw new Error(`Invalid XML entity reference '${entity}'`);
      }
      if (entity === "&amp;") out += "&";
      else if (entity === "&lt;") out += "<";
      else if (entity === "&gt;") out += ">";
      else if (entity === "&quot;") out += '"';
      else if (entity === "&apos;") out += "'";
      else {
        const cp = entity.startsWith("&#x")
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10);
        if (!Number.isSafeInteger(cp) || !isLegalXml10CodePoint(cp)) {
          throw new Error(`Invalid XML numeric character reference '${entity}'`);
        }
        out += String.fromCodePoint(cp);
      }
      i = semi + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function parseXmlAttributesStrict(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const trimmed = raw.trim();
  if (!trimmed) return attrs;

  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;
    if (i >= trimmed.length) break;

    const nameStart = i;
    while (i < trimmed.length && /[A-Za-z0-9_.:-]/.test(trimmed[i]!)) i += 1;
    const attrName = trimmed.slice(nameStart, i);
    if (!attrName) {
      throw new Error(`Malformed XML attribute near: ${trimmed.slice(i, i + 20)}`);
    }

    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;
    if (trimmed[i] !== "=") {
      throw new Error(`Expected '=' after XML attribute '${attrName}'`);
    }
    i += 1;
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i += 1;

    const quote = trimmed[i];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Expected quoted value for XML attribute '${attrName}'`);
    }
    i += 1;
    const valStart = i;
    const valEnd = trimmed.indexOf(quote, valStart);
    if (valEnd === -1) {
      throw new Error(`Unterminated XML attribute value for '${attrName}'`);
    }
    const rawVal = trimmed.slice(valStart, valEnd);
    if (rawVal.includes("<")) {
      throw new Error(`Unescaped '<' inside XML attribute '${attrName}'`);
    }
    if (attrName in attrs) {
      throw new Error(`Duplicate XML attribute '${attrName}'`);
    }
    attrs[attrName] = decodeXmlEntitiesStrict(rawVal);
    i = valEnd + 1;
  }

  return attrs;
}

function assertDeclaredXmlPrefixes(
  tagName: string,
  attributes: Readonly<Record<string, string>>,
  inScopePrefixes: ReadonlySet<string>,
): ReadonlySet<string> {
  const nextPrefixes = new Set(inScopePrefixes);
  for (const attrName of Object.keys(attributes)) {
    if (attrName.startsWith("xmlns:")) {
      const prefix = attrName.slice("xmlns:".length);
      if (!prefix || prefix.includes(":")) {
        throw new Error(`Invalid XML namespace declaration '${attrName}'`);
      }
      nextPrefixes.add(prefix);
    }
  }

  const checkPrefix = (qname: string, kind: "element" | "attribute"): void => {
    const colon = qname.indexOf(":");
    if (colon === -1) return;
    const prefix = qname.slice(0, colon);
    if (prefix === "xml" || prefix === "xmlns") return;
    if (!nextPrefixes.has(prefix)) {
      throw new Error(`Undeclared XML namespace prefix '${prefix}' on ${kind} '${qname}'`);
    }
  };

  checkPrefix(tagName, "element");
  for (const attrName of Object.keys(attributes)) {
    checkPrefix(attrName, "attribute");
  }
  return nextPrefixes;
}

export function parseStrictCrawlXml(xml: string): CrawlXmlNode {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    throw new Error("XML document must begin with UTF-8 XML declaration");
  }

  for (let i = 0; i < xml.length; i += 1) {
    const code = xml.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new Error(`Illegal XML 1.0 control char 0x${code.toString(16)} at offset ${i}`);
    }
  }

  let cursor = xml.indexOf("?>") + 2;
  const stack: Array<{
    name: string;
    attributes: Record<string, string>;
    children: CrawlXmlNode[];
    textParts: string[];
    prefixes: ReadonlySet<string>;
  }> = [];
  let root: CrawlXmlNode | null = null;

  while (cursor < xml.length) {
    const lt = xml.indexOf("<", cursor);
    if (lt === -1) {
      const trailing = xml.slice(cursor).trim();
      if (trailing.length > 0) {
        throw new Error(`Unexpected trailing XML text outside root: ${trailing}`);
      }
      break;
    }

    if (lt > cursor) {
      const decoded = decodeXmlEntitiesStrict(xml.slice(cursor, lt));
      const top = stack[stack.length - 1];
      if (!top) {
        if (decoded.trim().length > 0) {
          throw new Error(`Unexpected XML text outside root: ${decoded.trim()}`);
        }
      } else {
        top.textParts.push(decoded);
      }
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) {
      throw new Error(`Unclosed '<' tag near offset ${lt}`);
    }

    const tagContent = xml.slice(lt + 1, gt);
    if (tagContent.includes("<")) {
      throw new Error(`Unescaped '<' inside XML tag: <${tagContent}`);
    }

    if (tagContent.startsWith("/")) {
      const closeName = tagContent.slice(1).trim();
      const popped = stack.pop();
      if (!popped || popped.name !== closeName) {
        throw new Error(
          `Mismatched closing XML tag </${closeName}> (expected </${popped?.name ?? "NONE"}>)`,
        );
      }
      const completed: CrawlXmlNode = {
        name: popped.name,
        attributes: popped.attributes,
        children: popped.children,
        text: popped.textParts.join("").trim(),
      };
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(completed);
      } else {
        if (root !== null) {
          throw new Error("Multiple XML root elements found");
        }
        root = completed;
      }
    } else {
      const selfClosing = tagContent.endsWith("/");
      const inner = (selfClosing ? tagContent.slice(0, -1) : tagContent).trim();
      const firstWs = inner.search(/\s/);
      const tagName = firstWs === -1 ? inner : inner.slice(0, firstWs);
      const rawAttrs = firstWs === -1 ? "" : inner.slice(firstWs + 1);

      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(tagName)) {
        throw new Error(`Invalid XML tag name '${tagName}'`);
      }

      const attributes = parseXmlAttributesStrict(rawAttrs);
      const parentPrefixes = stack[stack.length - 1]?.prefixes ?? new Set<string>();
      const nextPrefixes = assertDeclaredXmlPrefixes(tagName, attributes, parentPrefixes);

      if (selfClosing) {
        const leaf: CrawlXmlNode = { name: tagName, attributes, children: [], text: "" };
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.children.push(leaf);
        } else {
          if (root !== null) {
            throw new Error("Multiple XML root elements found");
          }
          root = leaf;
        }
      } else {
        stack.push({
          name: tagName,
          attributes,
          children: [],
          textParts: [],
          prefixes: nextPrefixes,
        });
      }
    }

    cursor = gt + 1;
  }

  if (stack.length > 0) {
    throw new Error(`Unclosed XML element <${stack[stack.length - 1]!.name}>`);
  }
  if (!root) {
    throw new Error("Empty XML document");
  }
  return root;
}

export interface AuditedSitemapIndexItem {
  readonly loc: string;
  readonly lastmod: string | null;
}

export interface AuditedSitemapIndexResult {
  readonly byteLength: number;
  readonly entries: readonly AuditedSitemapIndexItem[];
  readonly duplicateLocs: readonly string[];
  readonly foreignOriginLocs: readonly string[];
  readonly invalidLastmods: readonly string[];
  readonly exceedsUrlLimit: boolean;
  readonly exceedsByteLimit: boolean;
}

export function auditSitemapIndexXml(
  xml: string,
  expectedOrigin: string,
  limits?: { readonly maxUrls?: number; readonly maxBytes?: number },
): AuditedSitemapIndexResult {
  const maxUrls = limits?.maxUrls ?? SITEMAP_MAX_URLS_CONTRACT;
  const maxBytes = limits?.maxBytes ?? SITEMAP_MAX_BYTES_CONTRACT;
  const byteLength = new TextEncoder().encode(xml).byteLength;
  const root = parseStrictCrawlXml(xml);
  if (root.name !== "sitemapindex") {
    throw new Error(`Expected <sitemapindex> root, got <${root.name}>`);
  }

  const normalizedOrigin = expectedOrigin.replace(/\/+$/, "");
  const entries: AuditedSitemapIndexItem[] = [];
  const seen = new Set<string>();
  const duplicateLocs: string[] = [];
  const foreignOriginLocs: string[] = [];
  const invalidLastmods: string[] = [];

  for (const child of root.children) {
    if (child.name !== "sitemap") {
      throw new Error(`Unexpected child <${child.name}> inside <sitemapindex>`);
    }
    const loc = child.children.find((c) => c.name === "loc")?.text ?? "";
    const lastmod = child.children.find((c) => c.name === "lastmod")?.text ?? null;
    if (!loc) {
      throw new Error("<sitemap> entry is missing <loc>");
    }
    if (seen.has(loc)) {
      duplicateLocs.push(loc);
    }
    seen.add(loc);
    if (!loc.startsWith(`${normalizedOrigin}/`)) {
      foreignOriginLocs.push(loc);
    }
    if (lastmod !== null && !W3C_DATETIME_RE.test(lastmod)) {
      invalidLastmods.push(lastmod);
    }
    entries.push({ loc, lastmod });
  }

  return {
    byteLength,
    entries,
    duplicateLocs,
    foreignOriginLocs,
    invalidLastmods,
    exceedsUrlLimit: entries.length > maxUrls,
    exceedsByteLimit: byteLength > maxBytes,
  };
}

export interface AuditedSitemapUrlItem {
  readonly loc: string;
  readonly lastmod: string | null;
  readonly imageLocs: readonly string[];
}

export interface AuditedUrlsetResult {
  readonly byteLength: number;
  readonly entries: readonly AuditedSitemapUrlItem[];
  readonly duplicateLocs: readonly string[];
  readonly foreignOriginLocs: readonly string[];
  readonly invalidLastmods: readonly string[];
  readonly paginatedOrTrackedLocs: readonly string[];
  readonly exceedsUrlLimit: boolean;
  readonly exceedsByteLimit: boolean;
}

export function auditUrlsetXml(
  xml: string,
  expectedOrigin: string,
  limits?: { readonly maxUrls?: number; readonly maxBytes?: number },
): AuditedUrlsetResult {
  const maxUrls = limits?.maxUrls ?? SITEMAP_MAX_URLS_CONTRACT;
  const maxBytes = limits?.maxBytes ?? SITEMAP_MAX_BYTES_CONTRACT;
  const byteLength = new TextEncoder().encode(xml).byteLength;
  const root = parseStrictCrawlXml(xml);
  if (root.name !== "urlset") {
    throw new Error(`Expected <urlset> root, got <${root.name}>`);
  }

  const normalizedOrigin = expectedOrigin.replace(/\/+$/, "");
  const entries: AuditedSitemapUrlItem[] = [];
  const seen = new Set<string>();
  const duplicateLocs: string[] = [];
  const foreignOriginLocs: string[] = [];
  const invalidLastmods: string[] = [];
  const paginatedOrTrackedLocs: string[] = [];

  for (const child of root.children) {
    if (child.name !== "url") {
      throw new Error(`Unexpected child <${child.name}> inside <urlset>`);
    }
    const loc = child.children.find((c) => c.name === "loc")?.text ?? "";
    const lastmod = child.children.find((c) => c.name === "lastmod")?.text ?? null;
    const imageLocs = child.children
      .filter((c) => c.name === "image:image")
      .map((img) => img.children.find((ic) => ic.name === "image:loc")?.text ?? "")
      .filter(Boolean);

    if (!loc) {
      throw new Error("<url> entry is missing <loc>");
    }
    if (seen.has(loc)) {
      duplicateLocs.push(loc);
    }
    seen.add(loc);

    let parsedLoc: URL;
    try {
      parsedLoc = new URL(loc);
    } catch {
      foreignOriginLocs.push(loc);
      entries.push({ loc, lastmod, imageLocs });
      continue;
    }

    if (parsedLoc.origin !== normalizedOrigin) {
      foreignOriginLocs.push(loc);
    }
    if (parsedLoc.search.length > 0) {
      paginatedOrTrackedLocs.push(loc);
    }
    if (lastmod !== null && !W3C_DATETIME_RE.test(lastmod)) {
      invalidLastmods.push(lastmod);
    }
    entries.push({ loc, lastmod, imageLocs });
  }

  return {
    byteLength,
    entries,
    duplicateLocs,
    foreignOriginLocs,
    invalidLastmods,
    paginatedOrTrackedLocs,
    exceedsUrlLimit: entries.length > maxUrls,
    exceedsByteLimit: byteLength > maxBytes,
  };
}

// ---------------------------------------------------------------------------
// 2. RFC 9309 Compliant `robots.txt` Parser
// ---------------------------------------------------------------------------

export interface ParsedRobotsTxt {
  readonly sitemaps: readonly string[];
  readonly disallowAllWildcard: boolean;
  readonly rulesByAgent: Readonly<
    Record<string, readonly { readonly directive: string; readonly value: string }[]>
  >;
}

/**
 * Parses `robots.txt` per RFC 9309 §2.2.1:
 * - Consecutive `User-agent:` lines share the following rules.
 * - Any `User-agent:` line occurring AFTER one or more rule lines (`Allow`, `Disallow`,
 *   `Crawl-delay`) starts a NEW group (even when there is no blank line separating groups).
 * - Blank lines do not prematurely terminate an active group when followed by rules.
 */
export function parseRobotsTxt(body: string): ParsedRobotsTxt {
  const sitemaps: string[] = [];
  const rulesByAgent: Record<string, Array<{ readonly directive: string; readonly value: string }>> =
    {};
  let currentAgents: string[] = [];
  let sawRuleInCurrentGroup = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      if (sawRuleInCurrentGroup) {
        currentAgents = [];
        sawRuleInCurrentGroup = false;
      }
      currentAgents.push(agent);
      if (!rulesByAgent[agent]) {
        rulesByAgent[agent] = [];
      }
      continue;
    }
    if (key === "allow" || key === "disallow" || key === "crawl-delay") {
      if (currentAgents.length === 0) continue;
      sawRuleInCurrentGroup = true;
      if (key === "allow" || key === "disallow") {
        for (const agent of currentAgents) {
          rulesByAgent[agent]!.push({ directive: key, value });
        }
      }
    }
  }

  const wildcardRules = rulesByAgent["*"] ?? [];
  const disallowAllWildcard = wildcardRules.some(
    (r) => r.directive === "disallow" && r.value === "/",
  );

  return { sitemaps, disallowAllWildcard, rulesByAgent };
}

// ---------------------------------------------------------------------------
// 3. HTML `<head>`, Whole-Document XSS, `X-Robots-Tag`, JSON-LD & Link Audit
// ---------------------------------------------------------------------------

export interface AuditedJsonLdScript {
  readonly raw: string;
  readonly parsed: Record<string, unknown> | null;
  readonly parseError: string | null;
  readonly hasRawScriptBreakout: boolean;
}

export interface RobotsParityCheck {
  readonly consistent: boolean;
  readonly metaIsNoindex: boolean | null;
  readonly headerIsNoindex: boolean | null;
  readonly contradictionReason: string | null;
}

export interface ExtractedDocumentLinks {
  readonly internalHrefs: readonly string[];
  readonly foreignOriginLinks: readonly string[];
}

export interface HttpCrawlPageAudit {
  readonly url: string;
  readonly status: number;
  readonly titleCount: number;
  readonly titleText: string | null;
  readonly descriptionCount: number;
  readonly robotsMetaCount: number;
  readonly robotsMetaValues: readonly string[];
  readonly xRobotsTagHeader: string | null;
  readonly robotsParity: RobotsParityCheck;
  readonly canonicalCount: number;
  readonly canonicalHref: string | null;
  readonly canonicalHasTrackingParams: boolean;
  readonly canonicalMatchesExpectedOrigin: boolean | null;
  readonly rssAlternateHref: string | null;
  readonly verificationTokens: {
    readonly google: string | null;
    readonly bing: string | null;
  };
  readonly jsonLdCount: number;
  readonly jsonLdScripts: readonly AuditedJsonLdScript[];
  readonly jsonLdTypes: readonly string[];
  readonly jsonLdForeignOriginUrls: readonly string[];
  readonly hasForbiddenSchemaProps: boolean;
  readonly hasUnexpectedOffers: boolean;
  readonly hasUnescapedHtmlInjectionInHead: boolean;
  readonly hasUnescapedHtmlInjectionInDocument: boolean;
  readonly internalHrefs: readonly string[];
  readonly foreignOriginLinks: readonly string[];
  readonly h1Count: number;
}

function decodeBasicHtmlAttr(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractHeadSection(html: string): string {
  const match = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  return match?.[1] ?? html;
}

function readTagAttribute(tag: string, attrName: string): string | null {
  const re = new RegExp(
    `\\s${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`/]+))`,
    "i",
  );
  const match = re.exec(tag);
  if (!match) return null;
  return decodeBasicHtmlAttr(match[1] ?? match[2] ?? match[3] ?? "");
}

function parseMetaContentByName(headHtml: string, targetName: string): string[] {
  const results: string[] = [];
  const metaTagRe = /<meta\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = metaTagRe.exec(headHtml)) !== null) {
    const tag = tagMatch[0];
    const name = (readTagAttribute(tag, "name") ?? "").trim().toLowerCase();
    if (name !== targetName.toLowerCase()) continue;
    results.push(readTagAttribute(tag, "content") ?? "");
  }
  return results;
}

function parseCanonicalHrefs(headHtml: string): string[] {
  const results: string[] = [];
  const linkTagRe = /<link\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = linkTagRe.exec(headHtml)) !== null) {
    const tag = tagMatch[0];
    const rel = (readTagAttribute(tag, "rel") ?? "").trim().toLowerCase();
    if (rel !== "canonical") continue;
    results.push(readTagAttribute(tag, "href") ?? "");
  }
  return results;
}

function parseRssAlternateHref(headHtml: string): string | null {
  const linkTagRe = /<link\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = linkTagRe.exec(headHtml)) !== null) {
    const tag = tagMatch[0];
    const type = (readTagAttribute(tag, "type") ?? "").trim().toLowerCase();
    if (type !== "application/rss+xml") continue;
    return readTagAttribute(tag, "href") || null;
  }
  return null;
}

interface ParsedRobotsTokenFlags {
  readonly hasIndex: boolean;
  readonly hasNoindex: boolean;
}

function parseRobotsDirectiveTokens(raw: string): ParsedRobotsTokenFlags {
  let hasIndex = false;
  let hasNoindex = false;
  // Support global directives (`noindex, follow`, `none`, `all`) and bot-prefixed rules
  // (`googlebot: noindex`, `bingbot: none`) in X-Robots-Tag / meta robots values.
  const segments = raw.split(/[\r\n]+/);
  for (const seg of segments) {
    const trimmedSeg = seg.trim();
    if (!trimmedSeg) continue;
    // Strip optional `<bot-name>:` prefix when followed by directive tokens (not `max-snippet:-1`)
    const botPrefixMatch = /^[a-z0-9_-]+\s*:\s*(.+)$/i.exec(trimmedSeg);
    const directivePart =
      botPrefixMatch && !/^max-(?:snippet|image-preview|video-preview)$/i.test(trimmedSeg.split(":")[0]!.trim())
        ? botPrefixMatch[1]!
        : trimmedSeg;

    for (const rawTok of directivePart.split(",")) {
      const tok = rawTok.trim().toLowerCase();
      if (!tok) continue;
      if (tok === "noindex" || tok === "none") {
        hasNoindex = true;
      } else if (tok === "index" || tok === "all") {
        hasIndex = true;
      }
    }
  }
  return { hasIndex, hasNoindex };
}

export function evaluateRobotsHeaderMetaParity(
  robotsMetaValues: readonly string[],
  xRobotsTagHeader: string | null,
): RobotsParityCheck {
  let anyMetaIndex = false;
  let anyMetaNoindex = false;
  for (const val of robotsMetaValues) {
    const flags = parseRobotsDirectiveTokens(val);
    if (flags.hasIndex) anyMetaIndex = true;
    if (flags.hasNoindex) anyMetaNoindex = true;
  }

  const headerFlags = xRobotsTagHeader ? parseRobotsDirectiveTokens(xRobotsTagHeader) : null;
  const metaIsNoindex = robotsMetaValues.length > 0 ? anyMetaNoindex : null;
  const headerIsNoindex = headerFlags !== null ? headerFlags.hasNoindex : null;

  if (robotsMetaValues.length > 1) {
    return {
      consistent: false,
      metaIsNoindex,
      headerIsNoindex,
      contradictionReason: `Duplicate <meta name="robots"> tags (${robotsMetaValues.length})`,
    };
  }

  if (anyMetaIndex && anyMetaNoindex) {
    return {
      consistent: false,
      metaIsNoindex,
      headerIsNoindex,
      contradictionReason: `Contradictory directives inside <meta name="robots">: "${robotsMetaValues.join(" | ")}"`,
    };
  }

  if (headerFlags && headerFlags.hasIndex && headerFlags.hasNoindex) {
    return {
      consistent: false,
      metaIsNoindex,
      headerIsNoindex,
      contradictionReason: `Contradictory directives inside X-Robots-Tag: "${xRobotsTagHeader}"`,
    };
  }

  if (metaIsNoindex === false && headerIsNoindex === true) {
    return {
      consistent: false,
      metaIsNoindex,
      headerIsNoindex,
      contradictionReason: `HTML meta says "${robotsMetaValues[0]}" (index) while X-Robots-Tag says "${xRobotsTagHeader}" (noindex)`,
    };
  }

  if (metaIsNoindex === true && headerFlags?.hasIndex === true) {
    return {
      consistent: false,
      metaIsNoindex,
      headerIsNoindex,
      contradictionReason: `HTML meta says "${robotsMetaValues[0]}" (noindex) while X-Robots-Tag says "${xRobotsTagHeader}" (index)`,
    };
  }

  return {
    consistent: true,
    metaIsNoindex,
    headerIsNoindex,
    contradictionReason: null,
  };
}

function collectHttpUrlsFromJson(
  value: unknown,
  out: Array<{ readonly url: string; readonly isMediaProperty: boolean }>,
  inMediaProperty = false,
): void {
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      out.push({ url: value, isMediaProperty: inMediaProperty });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHttpUrlsFromJson(item, out, inMediaProperty);
    }
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const isImageObj = obj["@type"] === "ImageObject";
    for (const [key, val] of Object.entries(obj)) {
      // Skip external profile/map/vocab properties; inspect entity identity, site URLs, AND media URLs
      if (key === "@context" || key === "sameAs" || key === "hasMap") continue;
      const nextIsMedia = inMediaProperty || isImageObj || key === "image" || key === "logo";
      if (key === "@id" || key === "url" || key === "item" || key === "contentUrl" || key === "image" || key === "logo") {
        collectHttpUrlsFromJson(val, out, nextIsMedia);
      } else if (typeof val === "object" && val !== null) {
        collectHttpUrlsFromJson(val, out, nextIsMedia);
      }
    }
  }
}

/**
 * Extracts internal links (resolved against the **current page URL**) and foreign-origin links
 * from `<a href=...>` and pagination `<link rel="prev|next" href=...>`.
 *
 * - Never matches `data-href` (requires whitespace before `href=`).
 * - Handles both quoted and unquoted attribute values.
 * - Preserves protocol-relative (`//other-host/...`) and foreign-origin URLs in `foreignOriginLinks`
 *   so cross-tenant links cannot slip past silently.
 */
export function extractDocumentLinks(
  html: string,
  pageUrl: string,
  expectedOrigin?: string | null,
): ExtractedDocumentLinks {
  const currentUrl = new URL(pageUrl);
  const targetOrigin = (expectedOrigin ?? currentUrl.origin).replace(/\/+$/, "");
  const internalHrefs: string[] = [];
  const foreignOriginLinks: string[] = [];

  const collectHref = (rawHref: string): void => {
    const trimmed = rawHref.trim();
    if (!trimmed) return;
    if (
      trimmed.startsWith("#") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("tel:") ||
      trimmed.startsWith("javascript:")
    ) {
      return;
    }

    try {
      const resolved = new URL(trimmed, currentUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return;
      }
      if (resolved.origin === targetOrigin) {
        internalHrefs.push(`${resolved.pathname}${resolved.search}`);
      } else {
        foreignOriginLinks.push(resolved.toString());
      }
    } catch {
      // Malformed href — include in internalHrefs so broken-link auditor catches it
      internalHrefs.push(trimmed);
    }
  };

  const anchorTagRe = /<a\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = anchorTagRe.exec(html)) !== null) {
    const href = readTagAttribute(tagMatch[0], "href");
    if (href !== null) collectHref(href);
  }

  const linkTagRe = /<link\b[^>]*>/gi;
  while ((tagMatch = linkTagRe.exec(html)) !== null) {
    const rel = (readTagAttribute(tagMatch[0], "rel") ?? "").trim().toLowerCase();
    if (rel !== "prev" && rel !== "next") continue;
    const href = readTagAttribute(tagMatch[0], "href");
    if (href !== null) collectHref(href);
  }

  return { internalHrefs, foreignOriginLinks };
}

export function extractInternalHrefs(
  html: string,
  pageUrlOrOrigin: string,
  expectedOrigin?: string | null,
): readonly string[] {
  return extractDocumentLinks(html, pageUrlOrOrigin, expectedOrigin).internalHrefs;
}

function detectUnescapedHtmlInjection(htmlFragment: string): boolean {
  // Remove legitimate JSON-LD script blocks, <style> blocks, and <title> text (HTML-escaped text node)
  const stripped = htmlFragment
    .replace(
      /<script\b[^>]*\stype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)(?=[\s/>])[^>]*>[\s\S]*?<\/script>/gi,
      "",
    )
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "");

  // 1. Any remaining <script> tag is unexpected on zero-JS crawlable pages
  if (/<script\b[^>]*>/i.test(stripped)) {
    return true;
  }

  // 2. Inspect actual HTML tags for inline event-handler attributes or `javascript:` URLs
  const tagRe = /<[a-z][a-z0-9-]*\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(stripped)) !== null) {
    const tag = tagMatch[0];
    // Strip quoted attribute values before checking for unquoted/real event-handler attribute names
    const tagWithoutQuotedVals = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    if (/\son[a-z]+\s*=/i.test(tagWithoutQuotedVals)) {
      return true;
    }
    const href = readTagAttribute(tag, "href");
    if (href && /^\s*javascript:/i.test(href)) {
      return true;
    }
    const src = readTagAttribute(tag, "src");
    if (src && /^\s*javascript:/i.test(src)) {
      return true;
    }
  }

  return false;
}

export function auditHttpCrawlPage(input: {
  readonly url: string;
  readonly status: number;
  readonly html: string;
  readonly xRobotsTagHeader?: string | null;
  readonly expectedOrigin?: string | null;
  readonly allowedMediaOrigins?: readonly string[];
  readonly expectNoOffers?: boolean;
}): HttpCrawlPageAudit {
  const headHtml = extractHeadSection(input.html);
  const titleMatches = [...headHtml.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  const titleText = titleMatches[0]?.[1] !== undefined ? titleMatches[0][1].trim() : null;
  const descriptions = parseMetaContentByName(headHtml, "description");
  const robotsMetaValues = parseMetaContentByName(headHtml, "robots");
  const canonicals = parseCanonicalHrefs(headHtml);
  const canonicalHref = canonicals[0] ?? null;
  const rssAlternateHref = parseRssAlternateHref(headHtml);
  const googleTokens = parseMetaContentByName(headHtml, "google-site-verification");
  const bingTokens = parseMetaContentByName(headHtml, "msvalidate.01");

  const allowedMediaOriginSet = new Set(
    (input.allowedMediaOrigins ?? DEFAULT_ALLOWED_MEDIA_ORIGINS).map((o) =>
      o.replace(/\/+$/, "").toLowerCase(),
    ),
  );

  let canonicalHasTrackingParams = false;
  let canonicalMatchesExpectedOrigin: boolean | null = null;
  if (canonicalHref) {
    try {
      const parsedCanonical = new URL(canonicalHref);
      for (const key of parsedCanonical.searchParams.keys()) {
        if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
          canonicalHasTrackingParams = true;
        }
      }
      if (input.expectedOrigin) {
        canonicalMatchesExpectedOrigin =
          parsedCanonical.origin === input.expectedOrigin.replace(/\/+$/, "");
      }
    } catch {
      canonicalMatchesExpectedOrigin = false;
    }
  }

  const jsonLdScripts: AuditedJsonLdScript[] = [];
  const jsonLdTypes = new Set<string>();
  const jsonLdForeignOriginUrls: string[] = [];
  // Match quoted OR unquoted `type=application/ld+json` with any surrounding attributes
  const jsonLdRe =
    /<script\b[^>]*\stype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)(?=[\s/>])[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = jsonLdRe.exec(input.html)) !== null) {
    const raw = (ldMatch[1] ?? "").trim();
    const hasRawScriptBreakout = /<\/script/i.test(raw) || /<!--/.test(raw);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        jsonLdScripts.push({ raw, parsed: obj, parseError: null, hasRawScriptBreakout });
        const graph = Array.isArray(obj["@graph"]) ? obj["@graph"] : [obj];
        for (const node of graph) {
          if (node && typeof node === "object" && !Array.isArray(node)) {
            const typeVal = (node as Record<string, unknown>)["@type"];
            if (typeof typeVal === "string") jsonLdTypes.add(typeVal);
            else if (Array.isArray(typeVal)) {
              for (const t of typeVal) {
                if (typeof t === "string") jsonLdTypes.add(t);
              }
            }
          }
        }
        if (input.expectedOrigin) {
          const normalizedExpected = input.expectedOrigin.replace(/\/+$/, "").toLowerCase();
          const foundUrls: Array<{ readonly url: string; readonly isMediaProperty: boolean }> = [];
          collectHttpUrlsFromJson(obj, foundUrls);
          for (const entry of foundUrls) {
            try {
              const u = new URL(entry.url);
              const originLower = u.origin.toLowerCase();
              const allowed =
                originLower === normalizedExpected ||
                (entry.isMediaProperty && allowedMediaOriginSet.has(originLower));
              if (!allowed) {
                jsonLdForeignOriginUrls.push(entry.url);
              }
            } catch {
              jsonLdForeignOriginUrls.push(entry.url);
            }
          }
        }
      } else {
        jsonLdScripts.push({
          raw,
          parsed: null,
          parseError: "JSON-LD root must be a JSON object",
          hasRawScriptBreakout,
        });
      }
    } catch (err) {
      jsonLdScripts.push({
        raw,
        parsed: null,
        parseError: err instanceof Error ? err.message : "Invalid JSON-LD",
        hasRawScriptBreakout,
      });
    }
  }

  const allJsonLdRaw = jsonLdScripts.map((s) => s.raw).join("\n");
  const hasForbiddenSchemaProps =
    /"(?:AggregateRating|aggregateRating|review|Review|ProfessionalService|shippingDetails|hasMerchantReturnPolicy|checkoutPageURLTemplate)"/.test(
      allJsonLdRaw,
    );
  const hasUnexpectedOffers = Boolean(
    input.expectNoOffers && /"(?:offers|Offer)"/.test(allJsonLdRaw),
  );

  const hasUnescapedHtmlInjectionInHead = detectUnescapedHtmlInjection(headHtml);
  const hasUnescapedHtmlInjectionInDocument = detectUnescapedHtmlInjection(input.html);

  const h1Count = (input.html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) ?? []).length;
  const docLinks = extractDocumentLinks(input.html, input.url, input.expectedOrigin);

  return {
    url: input.url,
    status: input.status,
    titleCount: titleMatches.length,
    titleText,
    descriptionCount: descriptions.length,
    robotsMetaCount: robotsMetaValues.length,
    robotsMetaValues,
    xRobotsTagHeader: input.xRobotsTagHeader ?? null,
    robotsParity: evaluateRobotsHeaderMetaParity(robotsMetaValues, input.xRobotsTagHeader ?? null),
    canonicalCount: canonicals.length,
    canonicalHref,
    canonicalHasTrackingParams,
    canonicalMatchesExpectedOrigin,
    rssAlternateHref,
    verificationTokens: {
      google: googleTokens[0] ?? null,
      bing: bingTokens[0] ?? null,
    },
    jsonLdCount: jsonLdScripts.length,
    jsonLdScripts,
    jsonLdTypes: Array.from(jsonLdTypes),
    jsonLdForeignOriginUrls,
    hasForbiddenSchemaProps,
    hasUnexpectedOffers,
    hasUnescapedHtmlInjectionInHead,
    hasUnescapedHtmlInjectionInDocument,
    internalHrefs: docLinks.internalHrefs,
    foreignOriginLinks: docLinks.foreignOriginLinks,
    h1Count,
  };
}

// ---------------------------------------------------------------------------
// 4. Cross-Tenant Leakage & Broken Internal Link Auditors
// ---------------------------------------------------------------------------

export function findCrossTenantLeaks(
  payloadText: string,
  forbiddenTokens: readonly string[],
): readonly string[] {
  const lower = payloadText.toLowerCase();
  const hits: string[] = [];
  for (const token of forbiddenTokens) {
    const clean = token.trim();
    if (!clean) continue;
    if (lower.includes(clean.toLowerCase())) {
      hits.push(clean);
    }
  }
  return hits;
}

export interface BrokenInternalLinkFinding {
  readonly sourceUrl: string;
  readonly href: string;
  readonly resolvedUrl: string;
  readonly status: number;
  readonly reason: string;
}

export async function auditInternalLinksOverHttp(params: {
  readonly origin: string;
  readonly pages: ReadonlyArray<{
    readonly url: string;
    readonly internalHrefs: readonly string[];
    readonly foreignOriginLinks?: readonly string[];
  }>;
  readonly forbiddenOrigins?: readonly string[];
  readonly fetchRoute: (url: string) => Promise<Response>;
}): Promise<{
  readonly checkedCount: number;
  readonly broken: readonly BrokenInternalLinkFinding[];
}> {
  const normalizedOrigin = params.origin.replace(/\/+$/, "");
  const forbiddenOriginSet = new Set(
    (params.forbiddenOrigins ?? []).map((o) => o.replace(/\/+$/, "").toLowerCase()),
  );
  const checkedCache = new Map<string, { readonly status: number; readonly location: string | null }>();
  const broken: BrokenInternalLinkFinding[] = [];

  for (const page of params.pages) {
    // Flag any foreign link pointing to a forbidden cross-tenant origin
    for (const foreignUrl of page.foreignOriginLinks ?? []) {
      try {
        const parsedForeign = new URL(foreignUrl);
        if (forbiddenOriginSet.has(parsedForeign.origin.toLowerCase())) {
          broken.push({
            sourceUrl: page.url,
            href: foreignUrl,
            resolvedUrl: foreignUrl,
            status: 0,
            reason: `Cross-tenant link to forbidden origin ${parsedForeign.origin}`,
          });
        }
      } catch {
        // Ignore unparseable external URL here
      }
    }

    for (const href of page.internalHrefs) {
      let targetUrl: string;
      try {
        const parsed = new URL(href, page.url);
        if (parsed.origin !== normalizedOrigin) {
          broken.push({
            sourceUrl: page.url,
            href,
            resolvedUrl: parsed.toString(),
            status: 0,
            reason: `Internal link resolved to foreign origin ${parsed.origin}`,
          });
          continue;
        }
        parsed.hash = "";
        targetUrl = parsed.toString();
      } catch {
        broken.push({
          sourceUrl: page.url,
          href,
          resolvedUrl: href,
          status: 0,
          reason: "Malformed internal href",
        });
        continue;
      }

      let outcome = checkedCache.get(targetUrl);
      if (!outcome) {
        const res = await params.fetchRoute(targetUrl);
        outcome = { status: res.status, location: res.headers.get("location") };
        checkedCache.set(targetUrl, outcome);
      }

      // Published internal links MUST resolve cleanly (200) or single-hop permanent redirect to 200 on same origin
      if (outcome.status === 200) {
        continue;
      }
      if ((outcome.status === 301 || outcome.status === 308) && outcome.location) {
        let finalTarget: URL;
        try {
          finalTarget = new URL(outcome.location, `${normalizedOrigin}/`);
        } catch {
          broken.push({
            sourceUrl: page.url,
            href,
            resolvedUrl: targetUrl,
            status: outcome.status,
            reason: `Invalid redirect Location: ${outcome.location}`,
          });
          continue;
        }
        if (finalTarget.origin !== normalizedOrigin) {
          broken.push({
            sourceUrl: page.url,
            href,
            resolvedUrl: targetUrl,
            status: outcome.status,
            reason: `Redirect escaped tenant origin to ${finalTarget.origin}`,
          });
          continue;
        }
        const hopRes = await params.fetchRoute(finalTarget.toString());
        if (hopRes.status !== 200) {
          broken.push({
            sourceUrl: page.url,
            href,
            resolvedUrl: targetUrl,
            status: hopRes.status,
            reason: `Redirect target ${finalTarget.toString()} returned HTTP ${hopRes.status}`,
          });
        }
        continue;
      }

      broken.push({
        sourceUrl: page.url,
        href,
        resolvedUrl: targetUrl,
        status: outcome.status,
        reason: `Broken internal link returned HTTP ${outcome.status}`,
      });
    }
  }

  return {
    checkedCount: checkedCache.size,
    broken,
  };
}
