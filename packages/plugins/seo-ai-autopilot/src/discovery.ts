import {
  buildIndexNowKeyLocation,
  buildIndexNowSubmissionPayload,
  constantTimeEqualStrings,
  evaluateIndexNowEligibility,
  isValidIndexNowKey,
  submitIndexNowBatch,
  type IndexNowEligibilityDecision,
  type IndexNowSubmissionPayload,
  type IndexNowSubmissionResult,
  type IndexNowTenantEligibilityInput,
  type SubmitIndexNowOptions,
} from "@punyasitus/core/seo/indexnow";
import {
  escapeXmlText,
  MANAGED_PRIVATE_DISALLOW_PATHS,
  sanitizeSeoText,
  type SeoTenantStatus,
  type SiteVisibility,
} from "@punyasitus/core/seo/index";
import {
  generateTenantRobotsTxt,
  type RobotsTxtPolicyInput,
  type TenantRobotsTxtEvaluation,
} from "@punyasitus/core/seo/robots";

/**
 * Zero-Config Discovery, Sitemap/Image Sitemap, AI-Split Robots.txt, Blog RSS & IndexNow Engine
 * (`packages/plugins/seo-ai-autopilot/src/discovery.ts`; REQ-102, REQ-095, DEC-039, DEC-042).
 *
 * Security & Reliability Invariants:
 * - Fail-CLOSED on TenantStore DB errors (`checkSeoAutopilotActiveInTenantDb` returns
 *   `{ ok: false, active: false, error }` — NEVER fails open to serving sitemap/feed/IndexNow
 *   or full OG/JSON-LD when DB reads throw).
 * - IndexNow key files (`/<key>.txt`) are public domain-control proofs per the IndexNow protocol
 *   (NEVER authentication secrets) and support HMAC-SHA-256 derivation keyed by Worker secret
 *   with deterministic SHA-256 fallback in isolated secretless unit tests.
 * - Zero outbound network calls unless an explicit `fetchImpl` is passed and `dryRun !== true`.
 */

export const SEO_AI_AUTOPILOT_PLUGIN_SLUG = "seo-ai-autopilot" as const;

const INDEXNOW_DERIVATION_DOMAIN = "punyasitus:seo-ai-autopilot:indexnow:v1" as const;

function bytesToLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export type SeoAutopilotDbCheckResult =
  | {
      readonly ok: true;
      readonly active: boolean;
      readonly source: "installed_row" | "default_provisioned";
    }
  | {
      readonly ok: false;
      readonly active: false;
      readonly error: string;
    };

/**
 * Checks whether `seo-ai-autopilot` is active in a tenant's `TenantStore` (`installed_plugins`).
 *
 * - Query succeeds with 0 rows -> `{ ok: true, active: true, source: "default_provisioned" }` (DEC-042).
 * - Query succeeds with a row -> `{ ok: true, active: enabled !== 0, source: "installed_row" }`.
 * - Query throws / DB error -> `{ ok: false, active: false, error }` (**FAILS CLOSED**, never fails open!).
 */
export async function checkSeoAutopilotActiveInTenantDb(
  tenantDb: D1Database,
): Promise<SeoAutopilotDbCheckResult> {
  try {
    const row = await tenantDb
      .prepare("SELECT enabled FROM installed_plugins WHERE plugin_id = ? LIMIT 1")
      .bind(SEO_AI_AUTOPILOT_PLUGIN_SLUG)
      .first<{ readonly enabled: number }>();
    if (!row) {
      return { ok: true, active: true, source: "default_provisioned" };
    }
    return {
      ok: true,
      active: Number(row.enabled) !== 0,
      source: "installed_row",
    };
  } catch (err) {
    return {
      ok: false,
      active: false,
      error: err instanceof Error ? err.message : "TENANT_DB_ERROR",
    };
  }
}

/**
 * Fail-closed boolean wrapper over `checkSeoAutopilotActiveInTenantDb`.
 * Returns `false` if `seo-ai-autopilot` is disabled OR if `TenantStore` throws a DB error.
 */
export async function isSeoAutopilotActiveInTenantDb(tenantDb: D1Database): Promise<boolean> {
  const res = await checkSeoAutopilotActiveInTenantDb(tenantDb);
  return res.ok && res.active;
}

export interface SeoAutopilotLocalsLike {
  readonly tenant?: { readonly id?: string } | null;
  readonly tenantDb?: D1Database | null;
  readonly seoAutopilotEnabled?: boolean;
}

/**
 * Resolves `seo-ai-autopilot` active state for `<SEOHead.astro>` across all platform & custom themes:
 * 1. Explicit boolean `explicitActive` prop always wins.
 * 2. Else if `locals.seoAutopilotEnabled` is boolean, honors it.
 * 3. Else if `locals.tenantDb` is present, queries `installed_plugins` via
 *    `checkSeoAutopilotActiveInTenantDb` (failing **closed** to `false` on DB error!).
 * 4. Else if `locals.tenant` is present without `tenantDb`, fails **closed** to `false`.
 * 5. Only defaults to `true` when NO live tenant context is present on `locals`
 *    (preserving backward compatibility for standalone static/unit renders).
 */
export async function resolveSeoAutopilotActiveFromLocals(input: {
  readonly explicitActive?: boolean;
  readonly locals?: unknown;
}): Promise<{
  readonly active: boolean;
  readonly dbError: boolean;
  readonly source:
    | "explicit_prop"
    | "locals_flag"
    | "tenant_db"
    | "tenant_db_error_fail_closed"
    | "tenant_without_db_fail_closed"
    | "standalone_default";
}> {
  if (typeof input.explicitActive === "boolean") {
    return { active: input.explicitActive, dbError: false, source: "explicit_prop" };
  }

  const locals = (
    input.locals && typeof input.locals === "object" ? input.locals : null
  ) as SeoAutopilotLocalsLike | null;

  if (typeof locals?.seoAutopilotEnabled === "boolean") {
    return { active: locals.seoAutopilotEnabled, dbError: false, source: "locals_flag" };
  }

  if (locals?.tenantDb) {
    const check = await checkSeoAutopilotActiveInTenantDb(locals.tenantDb);
    if (!check.ok) {
      return { active: false, dbError: true, source: "tenant_db_error_fail_closed" };
    }
    return { active: check.active, dbError: false, source: "tenant_db" };
  }

  if (locals?.tenant) {
    return { active: false, dbError: false, source: "tenant_without_db_fail_closed" };
  }

  return { active: true, dbError: false, source: "standalone_default" };
}

// ---------------------------------------------------------------------------
// 1. Sitemap & Image Sitemap Gating + XML Builders
// ---------------------------------------------------------------------------

export interface AutopilotSitemapGateInput {
  readonly seoAutopilotActive: boolean;
  readonly tenantStatus: SeoTenantStatus;
  readonly operatorHold?: boolean;
  readonly siteVisibility?: SiteVisibility | null;
}

export type AutopilotSitemapGateDecision =
  | { readonly allowed: true; readonly httpStatus: 200; readonly reason: "active" }
  | {
      readonly allowed: false;
      readonly httpStatus: 404 | 503;
      readonly reason:
        | "plugin_disabled"
        | "trial_noindex"
        | "site_noindex"
        | "tenant_suspended"
        | "tenant_destroyed";
    };

export function evaluateAutopilotSitemapGate(
  input: AutopilotSitemapGateInput,
): AutopilotSitemapGateDecision {
  const effectiveStatus = input.operatorHold ? "suspended" : input.tenantStatus;
  if (effectiveStatus === "suspended" || effectiveStatus === "recovery") {
    return { allowed: false, httpStatus: 503, reason: "tenant_suspended" };
  }
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return { allowed: false, httpStatus: 404, reason: "tenant_destroyed" };
  }
  if (!input.seoAutopilotActive) {
    return { allowed: false, httpStatus: 404, reason: "plugin_disabled" };
  }
  if (effectiveStatus === "trial") {
    return { allowed: false, httpStatus: 404, reason: "trial_noindex" };
  }
  if (input.siteVisibility === "noindex") {
    return { allowed: false, httpStatus: 404, reason: "site_noindex" };
  }
  return { allowed: true, httpStatus: 200, reason: "active" };
}

export interface AutopilotSitemapImageEntry {
  readonly loc: string;
  readonly title?: string | null;
}

export interface AutopilotSitemapUrlEntry {
  readonly loc: string;
  readonly lastmod?: string | null;
  readonly images?: readonly AutopilotSitemapImageEntry[];
}

export interface AutopilotSitemapIndexEntry {
  readonly loc: string;
  readonly lastmod?: string | null;
}

/**
 * Generates a valid Google Image Sitemap XML (`<urlset>` with `xmlns:image`)
 * with strict XML escaping and URL/image deduplication.
 */
export function buildAutopilotImageSitemapXml(
  entries: readonly AutopilotSitemapUrlEntry[],
): string {
  const seenUrls = new Set<string>();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
  ];

  for (const entry of entries) {
    if (!entry.loc || seenUrls.has(entry.loc)) continue;
    seenUrls.add(entry.loc);
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXmlText(entry.loc)}</loc>`);
    if (entry.lastmod) {
      lines.push(`    <lastmod>${escapeXmlText(entry.lastmod)}</lastmod>`);
    }
    if (entry.images && entry.images.length > 0) {
      const seenImgs = new Set<string>();
      for (const img of entry.images) {
        if (!img.loc || seenImgs.has(img.loc)) continue;
        seenImgs.add(img.loc);
        lines.push("    <image:image>");
        lines.push(`      <image:loc>${escapeXmlText(img.loc)}</image:loc>`);
        const cleanTitle = img.title ? sanitizeSeoText(img.title, { maxLength: 200 }) : "";
        if (cleanTitle) {
          lines.push(`      <image:title>${escapeXmlText(cleanTitle)}</image:title>`);
        }
        lines.push("    </image:image>");
      }
    }
    lines.push("  </url>");
  }

  lines.push("</urlset>");
  return `${lines.join("\n")}\n`;
}

/**
 * Generates a valid XML Sitemap Index (`<sitemapindex>`) document.
 */
export function buildAutopilotSitemapIndexXml(
  entries: readonly AutopilotSitemapIndexEntry[],
): string {
  const seen = new Set<string>();
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const entry of entries) {
    if (!entry.loc || seen.has(entry.loc)) continue;
    seen.add(entry.loc);
    lines.push("  <sitemap>");
    lines.push(`    <loc>${escapeXmlText(entry.loc)}</loc>`);
    if (entry.lastmod) {
      lines.push(`    <lastmod>${escapeXmlText(entry.lastmod)}</lastmod>`);
    }
    lines.push("  </sitemap>");
  }

  lines.push("</sitemapindex>");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 2. AI-Aware `robots.txt` vs Minimal Safe Fallback When Disabled
// ---------------------------------------------------------------------------

/**
 * Clean minimal `robots.txt` fallback emitted on active indexable paid tenants
 * when `seo-ai-autopilot` is disabled (`DEC-039`, `REQ-102`).
 *
 * Keeps mandatory private-path disallows intact (`/api/`, `/dashboard/`, `/console/`, etc.)
 * while omitting `Sitemap:` and AI bot-split directives.
 */
export function buildMinimalFallbackRobotsTxt(): string {
  const lines: string[] = ["User-agent: *", "Allow: /"];
  for (const path of MANAGED_PRIVATE_DISALLOW_PATHS) {
    lines.push(`Disallow: ${path}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface AutopilotRobotsTxtResult extends TenantRobotsTxtEvaluation {
  readonly seoAutopilotActive: boolean;
  readonly mode: "ai_split_autopilot" | "minimal_disabled_fallback" | "safety_disallow_all";
}

/**
 * Generates `/robots.txt` honoring both mandatory platform safety rules (`trial`/`noindex`/`suspended`)
 * and `seo-ai-autopilot` active/disabled state (`PLAN §15.1`, `§15.7`, `§19.6`, `REQ-102`).
 */
export function buildAutopilotRobotsTxt(
  input: RobotsTxtPolicyInput & { readonly seoAutopilotActive?: boolean },
): AutopilotRobotsTxtResult {
  const active = input.seoAutopilotActive !== false;
  const full = generateTenantRobotsTxt(input);

  // Mandatory safety disallow (trial, noindex, suspended, recovery, unknown host) ALWAYS wins
  if (!full.indexable) {
    return {
      ...full,
      seoAutopilotActive: active,
      mode: "safety_disallow_all",
    };
  }

  if (!active) {
    return {
      ...full,
      body: buildMinimalFallbackRobotsTxt(),
      sitemapUrl: null,
      seoAutopilotActive: false,
      mode: "minimal_disabled_fallback",
      botSplit: {
        ...full.botSplit,
        searchBotsAllowed: [],
        trainingBotsAllowed: [],
        trainingBotsDisallowed: [],
        facetedFilterDisallows: [],
      },
    };
  }

  return {
    ...full,
    seoAutopilotActive: true,
    mode: "ai_split_autopilot",
  };
}

// ---------------------------------------------------------------------------
// 3. Keyed HMAC-SHA-256 Tenant-Scoped IndexNow Key & Safe Publish-Ping Builder
// ---------------------------------------------------------------------------

export interface DeriveIndexNowKeyOptions {
  /**
   * Optional Worker secret (`env.INDEXNOW_KEY_SECRET ?? env.BETTER_AUTH_SECRET`).
   * When present, derives the 32-hex key via Web Crypto **HMAC-SHA-256** so tenant IDs
   * cannot be predicted off-box without the Worker key. Falls back to domain-separated
   * SHA-256 only when omitted in isolated unit tests.
   */
  readonly secret?: string | null;
  readonly salt?: string;
}

/**
 * Derives a deterministic, tenant-scoped 32-char lowercase hex IndexNow verification key.
 *
 * Note: IndexNow key files (`/<key>.txt`) are public domain-control proofs defined by the
 * IndexNow protocol — never authentication secrets or bearer credentials. Keying with
 * HMAC-SHA-256 (`options.secret`) prevents trivial offline enumeration from public tenant IDs.
 */
export async function deriveDeterministicTenantIndexNowKey(
  tenantId: string,
  options?: string | DeriveIndexNowKeyOptions,
): Promise<string> {
  const cleanId = tenantId.trim();
  if (!cleanId) {
    throw new RangeError("INVALID_TENANT_ID: tenantId is required to derive IndexNow key.");
  }

  const salt = typeof options === "string" ? options.trim() : (options?.salt ?? "").trim();
  const secret = typeof options === "string" ? "" : (options?.secret ?? "").trim();
  const material = `${INDEXNOW_DERIVATION_DOMAIN}|${cleanId}|${salt}`;
  const encoder = new TextEncoder();

  if (secret.length > 0) {
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(material));
    return bytesToLowerHex(new Uint8Array(mac).slice(0, 16));
  }

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material));
  return bytesToLowerHex(new Uint8Array(digest).slice(0, 16));
}

/**
 * Resolves the active IndexNow key for a tenant:
 * - Returns `null` immediately when `seoAutopilotActive === false`.
 * - Prefers an already-persisted valid `storedKey` (`TASK-095` compatibility).
 * - Falls back to the HMAC-SHA-256 (or deterministic secretless) tenant-scoped zero-config key (`TASK-102`).
 */
export async function resolveAutopilotIndexNowKey(input: {
  readonly tenantId: string;
  readonly seoAutopilotActive: boolean;
  readonly storedKey?: string | null;
  readonly secret?: string | null;
  readonly salt?: string;
}): Promise<string | null> {
  if (!input.seoAutopilotActive) {
    return null;
  }
  if (input.storedKey && isValidIndexNowKey(input.storedKey)) {
    return input.storedKey;
  }
  return deriveDeterministicTenantIndexNowKey(input.tenantId, {
    secret: input.secret,
    salt: input.salt,
  });
}

/**
 * Constant-time verification of `/[indexnowKey].txt` against the tenant's resolved key.
 */
export async function verifyAutopilotIndexNowKeyFile(input: {
  readonly tenantId: string;
  readonly candidateKey: string;
  readonly eligibility: IndexNowTenantEligibilityInput;
  readonly storedKey?: string | null;
  readonly secret?: string | null;
  readonly salt?: string;
}): Promise<
  | { readonly ok: true; readonly key: string; readonly keyLocation: string }
  | { readonly ok: false; readonly status: 404; readonly reason: string }
> {
  const candidate = input.candidateKey.trim();
  if (!isValidIndexNowKey(candidate)) {
    return { ok: false, status: 404, reason: "invalid_key_format" };
  }

  const decision = evaluateIndexNowEligibility(input.eligibility);
  if (!decision.eligible) {
    return { ok: false, status: 404, reason: decision.reason };
  }

  const expectedKey = await resolveAutopilotIndexNowKey({
    tenantId: input.tenantId,
    seoAutopilotActive: input.eligibility.seoAutopilotEnabled !== false,
    storedKey: input.storedKey,
    secret: input.secret,
    salt: input.salt,
  });
  if (!expectedKey || !constantTimeEqualStrings(candidate, expectedKey)) {
    return { ok: false, status: 404, reason: "key_mismatch" };
  }

  return {
    ok: true,
    key: expectedKey,
    keyLocation: buildIndexNowKeyLocation(decision.host, expectedKey),
  };
}

export interface BuildAutopilotIndexNowPingInput {
  readonly tenantId: string;
  readonly eligibility: IndexNowTenantEligibilityInput;
  readonly urls: readonly string[];
  readonly storedKey?: string | null;
  readonly secret?: string | null;
  readonly salt?: string;
}

export type BuildAutopilotIndexNowPingResult =
  | {
      readonly ready: true;
      readonly payload: IndexNowSubmissionPayload;
      readonly decision: Extract<IndexNowEligibilityDecision, { readonly eligible: true }>;
    }
  | {
      readonly ready: false;
      readonly reason: string;
      readonly payload: null;
    };

/**
 * Builds a validated, deduplicated IndexNow publish-ping payload with zero outbound I/O.
 */
export async function buildAutopilotIndexNowPing(
  input: BuildAutopilotIndexNowPingInput,
): Promise<BuildAutopilotIndexNowPingResult> {
  const decision = evaluateIndexNowEligibility(input.eligibility);
  if (!decision.eligible) {
    return { ready: false, reason: decision.reason, payload: null };
  }

  const key = await resolveAutopilotIndexNowKey({
    tenantId: input.tenantId,
    seoAutopilotActive: input.eligibility.seoAutopilotEnabled !== false,
    storedKey: input.storedKey,
    secret: input.secret,
    salt: input.salt,
  });
  if (!key) {
    return { ready: false, reason: "seo_autopilot_disabled", payload: null };
  }

  const payload = buildIndexNowSubmissionPayload({
    host: decision.host,
    key,
    urls: input.urls,
  });
  if (payload.urlList.length === 0) {
    return { ready: false, reason: "no_valid_urls", payload: null };
  }

  return { ready: true, payload, decision };
}

export interface DispatchAutopilotIndexNowOptions extends SubmitIndexNowOptions {
  /** When `true` (default if no `fetchImpl` is supplied), builds payload without any network I/O. */
  readonly dryRun?: boolean;
}

export type DispatchAutopilotIndexNowResult =
  | {
      readonly dispatched: false;
      readonly dryRun: true;
      readonly payload: IndexNowSubmissionPayload;
    }
  | {
      readonly dispatched: false;
      readonly dryRun: false;
      readonly skippedReason: string;
      readonly payload: null;
    }
  | {
      readonly dispatched: true;
      readonly dryRun: false;
      readonly payload: IndexNowSubmissionPayload;
      readonly result: IndexNowSubmissionResult;
    };

/**
 * Safely dispatches an IndexNow ping ONLY when eligible AND explicitly non-dry-run with a fetch port.
 * Defaults to `dryRun: true` when `fetchImpl` is omitted so tests never make accidental live calls.
 */
export async function dispatchAutopilotIndexNowPing(
  input: BuildAutopilotIndexNowPingInput,
  options: DispatchAutopilotIndexNowOptions = {},
): Promise<DispatchAutopilotIndexNowResult> {
  const built = await buildAutopilotIndexNowPing(input);
  if (!built.ready) {
    return {
      dispatched: false,
      dryRun: false,
      skippedReason: built.reason,
      payload: null,
    };
  }

  const isDryRun = options.dryRun ?? !options.fetchImpl;
  if (isDryRun) {
    return {
      dispatched: false,
      dryRun: true,
      payload: built.payload,
    };
  }

  const result = await submitIndexNowBatch(built.payload, {
    fetchImpl: options.fetchImpl,
    endpoint: options.endpoint,
  });

  return {
    dispatched: true,
    dryRun: false,
    payload: built.payload,
    result,
  };
}

// ---------------------------------------------------------------------------
// 4. Blog RSS Feed Policy Gate
// ---------------------------------------------------------------------------

export interface AutopilotBlogFeedGateDecision {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 404 | 503;
  readonly reason: "active" | "plugin_disabled" | "blog_disabled" | "tenant_suspended" | "tenant_destroyed";
}

export function evaluateAutopilotBlogFeedGate(input: {
  readonly seoAutopilotActive: boolean;
  readonly blogEnabled: boolean;
  readonly tenantStatus: SeoTenantStatus;
  readonly operatorHold?: boolean;
}): AutopilotBlogFeedGateDecision {
  const effectiveStatus = input.operatorHold ? "suspended" : input.tenantStatus;
  if (effectiveStatus === "suspended" || effectiveStatus === "recovery") {
    return { allowed: false, httpStatus: 503, reason: "tenant_suspended" };
  }
  if (
    effectiveStatus === "provisioning" ||
    effectiveStatus === "purging" ||
    effectiveStatus === "purged"
  ) {
    return { allowed: false, httpStatus: 404, reason: "tenant_destroyed" };
  }
  if (!input.seoAutopilotActive) {
    return { allowed: false, httpStatus: 404, reason: "plugin_disabled" };
  }
  if (!input.blogEnabled) {
    return { allowed: false, httpStatus: 404, reason: "blog_disabled" };
  }
  return { allowed: true, httpStatus: 200, reason: "active" };
}
