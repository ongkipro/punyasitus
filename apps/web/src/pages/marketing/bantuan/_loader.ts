import {
  assertHelpRegistryIntegrity,
  getHelpCategoryMeta,
  HELP_CATEGORIES,
  parseHelpArticleMarkdown,
  type HelpArticleRecord,
  type HelpCategoryId,
  type HelpCategoryMeta,
} from "@punyasitus/core/help/index";

/**
 * Static build-time loader for Indonesian Help Center Markdown articles
 * (`apps/web/src/content/bantuan/*.md`).
 *
 * Uses Vite `import.meta.glob` with `?raw` + `eager: true` so all articles are bundled
 * deterministically at build time (zero runtime FS access on Cloudflare Workers).
 * Runs `assertHelpRegistryIntegrity` on module load so builds fail immediately when any
 * dashboard `help_slug` points to a missing article.
 */

const RAW_HELP_MODULES = import.meta.glob<string>("../../../content/bantuan/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

function extractSlugFromModulePath(modulePath: string): string {
  const filename = modulePath.split("/").pop() ?? "";
  return filename.replace(/\.md$/i, "");
}

function loadAndValidateArticles(): readonly HelpArticleRecord[] {
  const parsed: HelpArticleRecord[] = [];
  for (const [modulePath, rawMarkdown] of Object.entries(RAW_HELP_MODULES)) {
    const expectedSlug = extractSlugFromModulePath(modulePath);
    parsed.push(parseHelpArticleMarkdown(rawMarkdown, expectedSlug));
  }

  parsed.sort((a, b) => {
    const catOrderDiff = getHelpCategoryMeta(a.category).order - getHelpCategoryMeta(b.category).order;
    if (catOrderDiff !== 0) return catOrderDiff;
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title, "id");
  });

  // Build-time fail-fast invariant: fails if <20 articles or any dashboard help_slug is missing.
  assertHelpRegistryIntegrity(parsed);

  return parsed;
}

const ALL_HELP_ARTICLES: readonly HelpArticleRecord[] = loadAndValidateArticles();
const ARTICLE_BY_SLUG = new Map<string, HelpArticleRecord>(
  ALL_HELP_ARTICLES.map((article) => [article.slug, article]),
);

export const VALID_HELP_SLUGS: ReadonlySet<string> = new Set(ARTICLE_BY_SLUG.keys());

export function getAllHelpArticles(): readonly HelpArticleRecord[] {
  return ALL_HELP_ARTICLES;
}

export function getFeaturedHelpArticles(): readonly HelpArticleRecord[] {
  return ALL_HELP_ARTICLES.filter((article) => article.featured);
}

export function getHelpArticleBySlug(slug: string): HelpArticleRecord | null {
  const normalized = slug.trim().toLowerCase();
  return ARTICLE_BY_SLUG.get(normalized) ?? null;
}

export function getRelatedHelpArticles(article: HelpArticleRecord): readonly HelpArticleRecord[] {
  const related: HelpArticleRecord[] = [];
  for (const slug of article.relatedSlugs) {
    const found = ARTICLE_BY_SLUG.get(slug);
    if (found) related.push(found);
  }
  return related;
}

export interface HelpCategoryGroup {
  readonly category: HelpCategoryMeta;
  readonly articles: readonly HelpArticleRecord[];
}

export function groupHelpArticlesByCategory(
  articles: readonly HelpArticleRecord[] = ALL_HELP_ARTICLES,
): readonly HelpCategoryGroup[] {
  const byCategory = new Map<HelpCategoryId, HelpArticleRecord[]>();
  for (const article of articles) {
    const bucket = byCategory.get(article.category) ?? [];
    bucket.push(article);
    byCategory.set(article.category, bucket);
  }

  return HELP_CATEGORIES.map((category) => ({
    category,
    articles: byCategory.get(category.id) ?? [],
  })).filter((group) => group.articles.length > 0);
}

export function formatIndonesianDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(dt.getTime())) return isoDate;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(dt);
}
