import {
  MIN_HELP_ARTICLE_COUNT,
  REQUIRED_HELP_LAUNCH_TOPICS,
  type HelpLaunchTopic,
} from "./categories.ts";
import type { HelpArticleRecord } from "./markdown.ts";
import { DASHBOARD_HELP_LINKS, type DashboardHelpMappingEntry } from "./registry.ts";

/**
 * Build-time & unit-test integrity validator for the Indonesian Help Center (REQ-104, TASK-104).
 *
 * Fails loudly when:
 * - Fewer than 20 valid help articles exist.
 * - Any dashboard `help_slug` points to a missing article.
 * - Any article has a duplicate slug or broken `relatedSlugs` target.
 * - Any required launch topic (`signup`, `domain`, `offering`, `whatsapp`, `payment`, `receipts`, `leads`) is uncovered.
 * - Any article contains placeholder or tenant-specific data leaks.
 */

export interface HelpRegistryIntegrityReport {
  readonly ok: boolean;
  readonly articleCount: number;
  readonly mappedScreenCount: number;
  readonly coveredLaunchTopics: readonly HelpLaunchTopic[];
  readonly errors: readonly string[];
}

const TENANT_LEAK_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "Lorem ipsum placeholder", re: /\blorem\s+ipsum\b/i },
  { label: "Test tenant ULID fixture", re: /\b01JTEST[A-Z0-9]+\b/ },
  { label: "Synthetic demo test email", re: /@contoh\.punyasitus\.test\b/i },
];

export function validateHelpRegistryIntegrity(
  articles: readonly HelpArticleRecord[],
  screenMap: Readonly<Record<string, Pick<DashboardHelpMappingEntry, "helpSlug">>> = DASHBOARD_HELP_LINKS,
): HelpRegistryIntegrityReport {
  const errors: string[] = [];
  const slugSet = new Set<string>();
  const coveredTopics = new Set<HelpLaunchTopic>();

  if (articles.length < MIN_HELP_ARTICLE_COUNT) {
    errors.push(
      `Help Center requires at least ${MIN_HELP_ARTICLE_COUNT} articles, found ${articles.length}.`,
    );
  }

  for (const article of articles) {
    if (slugSet.has(article.slug)) {
      errors.push(`Duplicate help article slug: "${article.slug}".`);
    } else {
      slugSet.add(article.slug);
    }

    for (const topic of article.launchTopics) {
      coveredTopics.add(topic);
    }

    for (const pattern of TENANT_LEAK_PATTERNS) {
      if (pattern.re.test(article.bodyMarkdown) || pattern.re.test(article.title)) {
        errors.push(`Article "${article.slug}" contains forbidden pattern (${pattern.label}).`);
      }
    }
  }

  for (const article of articles) {
    for (const related of article.relatedSlugs) {
      if (related === article.slug) {
        errors.push(`Article "${article.slug}" lists itself in relatedSlugs.`);
      } else if (!slugSet.has(related)) {
        errors.push(
          `Article "${article.slug}" references missing related article slug "${related}".`,
        );
      }
    }
  }

  const screenEntries = Object.entries(screenMap);
  for (const [screenId, entry] of screenEntries) {
    if (!slugSet.has(entry.helpSlug)) {
      errors.push(
        `Dashboard screen "${screenId}" maps to missing help_slug "${entry.helpSlug}".`,
      );
    }
  }

  for (const requiredTopic of REQUIRED_HELP_LAUNCH_TOPICS) {
    if (!coveredTopics.has(requiredTopic)) {
      errors.push(`Required launch topic "${requiredTopic}" is not covered by any help article.`);
    }
  }

  return {
    ok: errors.length === 0,
    articleCount: articles.length,
    mappedScreenCount: screenEntries.length,
    coveredLaunchTopics: Array.from(coveredTopics).sort(),
    errors,
  };
}

export function assertHelpRegistryIntegrity(
  articles: readonly HelpArticleRecord[],
  screenMap: Readonly<Record<string, Pick<DashboardHelpMappingEntry, "helpSlug">>> = DASHBOARD_HELP_LINKS,
): HelpRegistryIntegrityReport {
  const report = validateHelpRegistryIntegrity(articles, screenMap);
  if (!report.ok) {
    throw new Error(
      `Help Center registry integrity check failed (${report.errors.length} error(s)):\n- ${report.errors.join("\n- ")}`,
    );
  }
  return report;
}
