import {
  buildAuthorBylineAndSchemaParity,
  calculateLinearReadingTimeMinutes,
  extractAndInjectServerToc,
  shouldRenderServerToc,
  type PostTocItem,
  type PublicAuthorBylineModel,
} from "@punyasitus/core/posts/index";
import type { SchemaGraphDocument } from "@punyasitus/core/schema-generator";
import { sanitizeHtmlInternalLinks } from "@punyasitus/core/seo/local-entity";
import { createTenantDb, openTenantStoreStub } from "@punyasitus/db/connections";
import { getPostAuthorById } from "@punyasitus/db/posts/index";
import type { EnrichedPublicBlogDetailData } from "../../components/seo/public-seo-context.ts";
import type {
  PublicBlogDetailRenderResult,
  PublicBreadcrumbItem,
  PublicRouteDeps,
} from "../../core/public-routes.ts";

/**
 * Server-Side Blog Post Detail Enhancer (`apps/web/src/pages/blog/_post-detail-helpers.ts`;
 * REQ-092, PLAN §5.2 & §19.5, TASK-092).
 *
 * Guarantees:
 * 1. Linear O(n) server-rendered TOC extraction & deterministic heading `id` injection (zero client JS).
 * 2. Full tenant-scoped Author Profile resolution including `role_title` (`0020_blog_author_toc_modified.sql`),
 *    `bio`, verified ready `avatar`, and `sameAs` links.
 * 3. Strict 1:1 parity between visible author byline / `content_modified_at` and the `BlogPosting`/`Article`
 *    JSON-LD node inside `<PublicSeoHead>`.
 * 4. Breadcrumbs include primary category archive link when a published category archive exists.
 */

export interface ResolvedBlogDetailPresentation {
  readonly sanitizedHtmlWithAnchors: string;
  readonly toc: readonly PostTocItem[];
  readonly showToc: boolean;
  readonly readingTimeMinutes: number;
  readonly authorByline: PublicAuthorBylineModel | null;
  readonly schemaGraph: SchemaGraphDocument | null;
  readonly breadcrumbs: readonly PublicBreadcrumbItem[];
  readonly primaryCategoryLink: { readonly name: string; readonly href: string } | null;
  readonly showUpdatedDate: boolean;
}

function resolveTenantDbFromDeps(deps: PublicRouteDeps, tenantId: string): D1Database | null {
  if (deps.tenantDb) return deps.tenantDb;
  if (deps.tenantStore && tenantId) {
    try {
      return createTenantDb(openTenantStoreStub(deps.tenantStore, tenantId));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Synchronizes the `Article`/`BlogPosting`/`NewsArticle` node inside a Schema.org `@graph`
 * so `author` (`Person` with `name`, `jobTitle`, `description`, `image`, `sameAs`) and
 * `dateModified` match the visible blog post detail page 1:1.
 */
export function synchronizeBlogSchemaGraphAuthorAndDates(
  schemaGraph: SchemaGraphDocument | null,
  params: {
    readonly authorByline: PublicAuthorBylineModel | null;
    readonly publishedAtIso: string | null;
    readonly modifiedAtIso: string | null;
  },
): SchemaGraphDocument | null {
  if (!schemaGraph || !Array.isArray(schemaGraph["@graph"])) {
    return schemaGraph;
  }

  const { articleAuthorSchema } = buildAuthorBylineAndSchemaParity(params.authorByline);
  const nextGraph = schemaGraph["@graph"].map((node) => {
    const rawType = node["@type"];
    const typeList = Array.isArray(rawType) ? rawType : [rawType];
    const isArticle = typeList.some(
      (t) => t === "BlogPosting" || t === "Article" || t === "NewsArticle",
    );
    if (!isArticle) return node;

    const updated: Record<string, unknown> = { ...node };
    if (articleAuthorSchema) {
      updated.author = articleAuthorSchema;
    } else {
      delete updated.author;
    }
    if (params.publishedAtIso) {
      updated.datePublished = params.publishedAtIso;
    }
    if (params.modifiedAtIso) {
      updated.dateModified = params.modifiedAtIso;
    }
    return updated;
  });

  return {
    ...schemaGraph,
    "@graph": nextGraph,
  };
}

export async function resolveBlogDetailPresentation(
  result: PublicBlogDetailRenderResult,
  enriched: EnrichedPublicBlogDetailData | null,
  deps: PublicRouteDeps,
): Promise<ResolvedBlogDetailPresentation> {
  // 1. Linear O(n) server-side TOC extraction & heading `id` injection (zero client JS)
  const sourceHtml = enriched?.sanitizedHtmlWithAnchors ?? result.post.sanitizedHtml;
  const linearToc = extractAndInjectServerToc(sourceHtml);
  const sanitizedHtmlWithAnchors = sanitizeHtmlInternalLinks(linearToc.html, {
    verifiedOrigin: result.primaryOrigin,
  });
  const showToc = shouldRenderServerToc(result.post.showToc, linearToc.toc);
  const readingTimeMinutes =
    result.post.readingTimeMinutes >= 1
      ? result.post.readingTimeMinutes
      : calculateLinearReadingTimeMinutes(sanitizedHtmlWithAnchors);

  // 2. Resolve full author profile including `role_title` from TenantStore `authors` table
  const baseAuthor = enriched?.authorProfile ?? null;
  let fullAuthorProfile = baseAuthor
    ? {
        id: baseAuthor.id,
        name: baseAuthor.name,
        roleTitle: baseAuthor.roleTitle ?? null,
        bio: baseAuthor.bio ?? null,
        avatar: baseAuthor.avatar ?? null,
        sameAs: baseAuthor.sameAs ?? [],
      }
    : result.post.authorName
      ? {
          name: result.post.authorName,
          roleTitle: null,
          bio: result.post.authorBio ?? null,
          avatar: null,
          sameAs: [] as readonly string[],
        }
      : null;

  const tenantDb = resolveTenantDbFromDeps(deps, result.tenant.id);
  if (tenantDb) {
    try {
      let authorId: number | null = baseAuthor?.id ?? null;
      if (!authorId) {
        const postRow = await tenantDb
          .prepare(
            `SELECT author_id, published_body_json
             FROM posts
             WHERE slug = ? AND status = 'published' AND deleted_at IS NULL
             LIMIT 1`,
          )
          .bind(result.post.slug)
          .first<{ readonly author_id: number | null; readonly published_body_json: string | null }>();

        authorId = postRow?.author_id ?? null;
        if (!authorId && postRow?.published_body_json) {
          try {
            const parsed = JSON.parse(postRow.published_body_json) as {
              readonly data?: { readonly authorId?: number | null };
            };
            if (typeof parsed.data?.authorId === "number") {
              authorId = parsed.data.authorId;
            }
          } catch {
            // Ignore malformed snapshot
          }
        }
      }

      if (authorId) {
        const dbAuthor = await getPostAuthorById(tenantDb, authorId, {
          tenantId: result.tenant.id,
          mediaBaseOrigin: deps.mediaPublicBaseUrl ?? null,
        });
        if (dbAuthor) {
          // Treat the live TenantStore author row as 100% authoritative so clearing
          // bio, avatar, roleTitle, or sameAs never falls back to stale snapshot values.
          fullAuthorProfile = {
            id: dbAuthor.id,
            name: dbAuthor.name,
            roleTitle: dbAuthor.roleTitle,
            bio: dbAuthor.bio,
            avatar: dbAuthor.avatar,
            sameAs: dbAuthor.sameAs,
          };
        }
      }
    } catch {
      // Keep fallback author profile cleanly
    }
  }

  const { byline: authorByline } = buildAuthorBylineAndSchemaParity(fullAuthorProfile);

  // 3. Synchronize Schema.org `Article.author` & `dateModified` with visible facts 1:1
  const baseSchema = enriched?.head.schemaGraph ?? result.schemaGraph;
  const schemaGraph = synchronizeBlogSchemaGraphAuthorAndDates(baseSchema, {
    authorByline,
    publishedAtIso: result.post.publishedAtIso,
    modifiedAtIso: result.post.modifiedAtIso,
  });

  // 4. Primary category link + breadcrumb enhancement
  const primaryCatName = result.post.categoryName;
  const matchedPrimaryCatLink = primaryCatName
    ? (enriched?.categoryLinks.find((c) => c.name === primaryCatName) ?? enriched?.categoryLinks[0] ?? null)
    : (enriched?.categoryLinks[0] ?? null);
  const primaryCategoryLink = matchedPrimaryCatLink
    ? { name: matchedPrimaryCatLink.name, href: matchedPrimaryCatLink.href }
    : null;

  const breadcrumbs: readonly PublicBreadcrumbItem[] = primaryCategoryLink
    ? [
        { label: "Beranda", href: "/" },
        { label: "Blog", href: "/blog" },
        { label: primaryCategoryLink.name, href: primaryCategoryLink.href },
        { label: result.post.title, href: null },
      ]
    : result.breadcrumbs;

  // 5. Show "Diperbarui ..." when `content_modified_at` differs substantively from `published_at`
  const showUpdatedDate = Boolean(
    result.post.modifiedDateLabel &&
      result.post.modifiedAtIso &&
      result.post.modifiedAtIso !== result.post.publishedAtIso,
  );

  return {
    sanitizedHtmlWithAnchors,
    toc: linearToc.toc,
    showToc,
    readingTimeMinutes,
    authorByline,
    schemaGraph,
    breadcrumbs,
    primaryCategoryLink,
    showUpdatedDate,
  };
}
