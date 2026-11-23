import {
  MCP_UNTRUSTED_DATA_NOTICE,
  McpToolInputSchemas,
  type McpAllowedToolName,
} from "@punyasitus/core/mcp/index";
import {
  createCatalogOffering,
  getCatalogOfferingById,
  listCatalogOfferings,
  updateCatalogOffering,
} from "../catalog/index.ts";
import { publishResourceWithScreening } from "../content-screening/index.ts";
import { getLeadById, listLeads } from "../leads/index.ts";
import { createPage, getPageById, listPages, updatePage } from "../pages/index.ts";
import { appendPlatformAudit } from "../platform/audit.ts";
import { createPost, getPostById, listPosts, updatePost } from "../posts/index.ts";
import { getGroupedSettingsForAdmin } from "../settings/index.ts";
import {
  claimPendingMcpPublishApprovalAtomically,
  createMcpPublishApproval,
  getMcpPublishApprovalByToken,
  markMcpPublishApprovalExpired,
  releaseClaimedMcpPublishApprovalOnError,
  updateClaimedMcpPublishApprovalToHeld,
} from "./store.ts";

/**
 * Tenant-scoped MCP tool execution layer (`packages/db/src/mcp/tools.ts`).
 *
 * Security invariants (REQ-076, ADR-0008, PLAN §18.3, TASK-075):
 * - Every tool reuses existing server-only services (`pages`, `posts`, `catalog`,
 *   `leads`, `settings`, `publishResourceWithScreening`) with ZERO second business-rule path.
 * - Write tools ALWAYS create or update DRAFTS only; they NEVER publish directly AND
 *   NEVER allow changing the live URL/slug of an already-published resource (`LIVE_SLUG_CHANGE_FORBIDDEN_VIA_MCP`).
 * - `request_publish_approval` ONLY returns a short-lived human confirmation link
 *   (`/auth/consent/publish/{token}`); publishing happens solely after a signed-in
 *   authorized owner/requester confirms in the browser, claiming the token atomically FIRST.
 * - All responses are wrapped with an explicit untrusted-data boundary notice.
 */

export interface McpToolExecutionContext {
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
  readonly adminOrigin: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly tenantHandle: string;
  readonly tenantName: string;
  readonly nowMs: number;
}

export class McpToolExecutionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "McpToolExecutionError";
    this.code = code;
    this.status = status;
  }
}

function assertNoLiveSlugMutationViaMcp(
  resourceLabel: string,
  existing: { readonly status: string; readonly publishedAt: string | null; readonly slug: string },
  requestedSlug: string | undefined,
): void {
  if (requestedSlug === undefined) return;
  const wasEverPublished = existing.publishedAt !== null || existing.status === "published";
  if (!wasEverPublished) return;

  const normalizedNext = requestedSlug.trim().toLowerCase();
  if (normalizedNext !== existing.slug.trim().toLowerCase()) {
    throw new McpToolExecutionError(
      "LIVE_SLUG_CHANGE_FORBIDDEN_VIA_MCP",
      `Perubahan slug pada ${resourceLabel} yang sudah diterbitkan tidak diizinkan melalui MCP; ubah slug langsung melalui dashboard PunyaSitus.`,
      403,
    );
  }
}

export async function executeTenantMcpTool(
  ctx: McpToolExecutionContext,
  toolName: McpAllowedToolName,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const schema = McpToolInputSchemas[toolName];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issueMsg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`)
      .join("; ");
    throw new McpToolExecutionError("INVALID_ARGUMENTS", `Argumen tool tidak valid: ${issueMsg}`, 422);
  }

  const args = parsed.data as Record<string, unknown>;

  switch (toolName) {
    case "get_site_overview": {
      const [settings, pagesRes, postsRes, offeringsRes] = await Promise.all([
        getGroupedSettingsForAdmin(ctx.tenantDb).catch(() => null),
        listPages(ctx.tenantDb, { status: "all", limit: 50 }),
        listPosts(ctx.tenantDb, { status: "all", limit: 50 }),
        listCatalogOfferings(ctx.tenantDb, { limit: 50 }),
      ]);

      return {
        tenant: {
          handle: ctx.tenantHandle,
          name: ctx.tenantName,
        },
        siteTitle: settings?.draft.general.siteTitle ?? ctx.tenantName,
        tagline: settings?.draft.general.tagline ?? null,
        counts: {
          pagesTotal: pagesRes.items.length,
          pagesPublished: pagesRes.items.filter((p) => p.status === "published").length,
          pagesDraft: pagesRes.items.filter((p) => p.status === "draft").length,
          postsTotal: postsRes.items.length,
          postsPublished: postsRes.items.filter((p) => p.status === "published").length,
          postsDraft: postsRes.items.filter((p) => p.status === "draft").length,
          offeringsTotal: offeringsRes.items.length,
          offeringsPublished: offeringsRes.items.filter((o) => o.status === "published").length,
          offeringsDraft: offeringsRes.items.filter((o) => o.status === "draft").length,
        },
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "list_pages": {
      const input = args as {
        readonly status?: "all" | "draft" | "published";
        readonly cursor?: string;
        readonly limit?: number;
      };
      const res = await listPages(ctx.tenantDb, {
        status: input.status ?? "all",
        cursor: input.cursor,
        limit: input.limit ?? 20,
      });
      return {
        items: res.items.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          status: p.status,
          isHomepage: p.isHomepage,
          layoutMode: p.layoutMode,
          hasUnpublishedChanges: p.hasUnpublishedChanges,
          version: p.version,
          updatedAt: p.updatedAt,
        })),
        page: res.page,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "get_page": {
      const { pageId } = args as { readonly pageId: number };
      const page = await getPageById(ctx.tenantDb, pageId);
      if (!page) {
        throw new McpToolExecutionError("NOT_FOUND", `Halaman #${pageId} tidak ditemukan.`, 404);
      }
      return {
        page,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "list_posts": {
      const input = args as {
        readonly status?: "all" | "draft" | "published";
        readonly search?: string;
        readonly categoryId?: number;
        readonly tagId?: number;
        readonly cursor?: string;
        readonly limit?: number;
      };
      const res = await listPosts(ctx.tenantDb, {
        status: input.status ?? "all",
        search: input.search,
        categoryId: input.categoryId,
        tagId: input.tagId,
        cursor: input.cursor,
        limit: input.limit ?? 20,
      });
      return {
        items: res.items.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          excerpt: p.excerpt,
          status: p.status,
          hasUnpublishedChanges: p.hasUnpublishedChanges,
          version: p.version,
          publishedAt: p.publishedAt,
          updatedAt: p.updatedAt,
        })),
        page: res.page,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "get_post": {
      const { postId } = args as { readonly postId: number };
      const post = await getPostById(ctx.tenantDb, postId);
      if (!post) {
        throw new McpToolExecutionError("NOT_FOUND", `Artikel #${postId} tidak ditemukan.`, 404);
      }
      return {
        post,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "list_offerings": {
      const input = args as {
        readonly offeringType?: "service" | "product" | "tour" | "vehicle";
        readonly status?: "draft" | "published";
        readonly categoryId?: number;
        readonly cursor?: number;
        readonly limit?: number;
      };
      const res = await listCatalogOfferings(ctx.tenantDb, {
        offeringType: input.offeringType,
        status: input.status,
        categoryId: input.categoryId,
        cursor: input.cursor,
        limit: input.limit ?? 20,
      });
      return {
        items: res.items.map((o) => ({
          id: o.id,
          offeringType: o.offeringType,
          slug: o.slug,
          title: o.title,
          summary: o.summary,
          priceMode: o.priceMode,
          price: o.price,
          priceMax: o.priceMax,
          ctaMode: o.ctaMode,
          status: o.status,
          version: o.version,
          updatedAt: o.updatedAt,
        })),
        page: res.page,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "get_offering": {
      const { offeringId } = args as { readonly offeringId: number };
      const offering = await getCatalogOfferingById(ctx.tenantDb, offeringId);
      if (!offering) {
        throw new McpToolExecutionError("NOT_FOUND", `Penawaran #${offeringId} tidak ditemukan.`, 404);
      }
      return {
        offering,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "create_page_draft": {
      const input = args as {
        readonly title: string;
        readonly slug?: string;
        readonly layoutMode?: "standard" | "focused";
        readonly sections?: unknown;
        readonly seo?: unknown;
      };
      const created = await createPage(ctx.tenantDb, {
        title: input.title,
        slug: input.slug,
        layoutMode: input.layoutMode,
        sections: input.sections,
        seo: input.seo,
        nowMs: ctx.nowMs,
      });
      return {
        draftOnly: true,
        published: false,
        page: created,
      };
    }

    case "update_page_draft": {
      const input = args as {
        readonly pageId: number;
        readonly expectedVersion: number;
        readonly title?: string;
        readonly slug?: string;
        readonly layoutMode?: "standard" | "focused";
        readonly sections?: unknown;
        readonly seo?: unknown;
      };
      const existing = await getPageById(ctx.tenantDb, input.pageId);
      if (!existing) {
        throw new McpToolExecutionError("NOT_FOUND", `Halaman #${input.pageId} tidak ditemukan.`, 404);
      }
      assertNoLiveSlugMutationViaMcp("halaman", existing, input.slug);

      const updated = await updatePage(
        ctx.tenantDb,
        {
          pageId: input.pageId,
          expectedVersion: input.expectedVersion,
          title: input.title,
          slug: existing.publishedAt !== null || existing.status === "published" ? undefined : input.slug,
          confirmSlugChange: false,
          layoutMode: input.layoutMode,
          sections: input.sections,
          seo: input.seo,
          nowMs: ctx.nowMs,
        },
        { platformDb: ctx.platformDb, tenantId: ctx.tenantId },
      );
      return {
        draftOnly: true,
        page: updated,
      };
    }

    case "create_post_draft": {
      const input = args as {
        readonly title: string;
        readonly slug?: string;
        readonly excerpt?: string | null;
        readonly bodyHtml?: string;
        readonly body?: unknown;
        readonly featuredMediaId?: number | null;
        readonly categoryIds?: readonly number[];
        readonly tagIds?: readonly number[];
        readonly enableToc?: boolean;
        readonly seo?: unknown;
      };
      const created = await createPost(
        ctx.tenantDb,
        {
          title: input.title,
          slug: input.slug,
          excerpt: input.excerpt,
          bodyHtml: input.bodyHtml,
          body: input.body,
          featuredMediaId: input.featuredMediaId,
          categoryIds: input.categoryIds,
          tagIds: input.tagIds,
          enableToc: input.enableToc,
          seo: input.seo,
          nowMs: ctx.nowMs,
        },
        {
          platformDb: ctx.platformDb,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
        },
      );
      return {
        draftOnly: true,
        published: false,
        post: created,
      };
    }

    case "update_post_draft": {
      const input = args as {
        readonly postId: number;
        readonly expectedVersion: number;
        readonly title?: string;
        readonly slug?: string;
        readonly excerpt?: string | null;
        readonly bodyHtml?: string;
        readonly body?: unknown;
        readonly featuredMediaId?: number | null;
        readonly categoryIds?: readonly number[];
        readonly tagIds?: readonly number[];
        readonly enableToc?: boolean;
        readonly seo?: unknown;
      };
      const existing = await getPostById(ctx.tenantDb, input.postId);
      if (!existing) {
        throw new McpToolExecutionError("NOT_FOUND", `Artikel #${input.postId} tidak ditemukan.`, 404);
      }
      assertNoLiveSlugMutationViaMcp("artikel", existing, input.slug);

      const updated = await updatePost(
        ctx.tenantDb,
        {
          postId: input.postId,
          expectedVersion: input.expectedVersion,
          title: input.title,
          slug: existing.publishedAt !== null || existing.status === "published" ? undefined : input.slug,
          confirmSlugChange: false,
          excerpt: input.excerpt,
          bodyHtml: input.bodyHtml,
          body: input.body,
          featuredMediaId: input.featuredMediaId,
          categoryIds: input.categoryIds,
          tagIds: input.tagIds,
          enableToc: input.enableToc,
          seo: input.seo,
          nowMs: ctx.nowMs,
        },
        {
          platformDb: ctx.platformDb,
          tenantId: ctx.tenantId,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
        },
      );
      return {
        draftOnly: true,
        post: updated,
      };
    }

    case "create_offering_draft": {
      const created = await createCatalogOffering(ctx.tenantDb, args, { nowMs: ctx.nowMs });
      return {
        draftOnly: true,
        published: false,
        offering: created,
      };
    }

    case "update_offering_draft": {
      const { offeringId, expectedVersion, slug, ...restPatch } = args as {
        readonly offeringId: number;
        readonly expectedVersion: number;
        readonly slug?: string;
        readonly [key: string]: unknown;
      };
      const existing = await getCatalogOfferingById(ctx.tenantDb, offeringId);
      if (!existing) {
        throw new McpToolExecutionError("NOT_FOUND", `Penawaran #${offeringId} tidak ditemukan.`, 404);
      }
      assertNoLiveSlugMutationViaMcp("penawaran", existing, slug);

      const safePatch: Record<string, unknown> = { ...restPatch };
      if (slug !== undefined && existing.publishedAt === null && existing.status !== "published") {
        safePatch.slug = slug;
      }

      const updated = await updateCatalogOffering(ctx.tenantDb, offeringId, safePatch, {
        expectedVersion,
        nowMs: ctx.nowMs,
      });
      return {
        draftOnly: true,
        offering: updated,
      };
    }

    case "request_publish_approval": {
      const input = args as {
        readonly resourceType: "page" | "post" | "offering";
        readonly resourceId: number;
        readonly expectedVersion: number;
      };

      let title: string;
      let slug: string | null;
      let actualVersion: number;

      if (input.resourceType === "page") {
        const page = await getPageById(ctx.tenantDb, input.resourceId);
        if (!page) {
          throw new McpToolExecutionError(
            "NOT_FOUND",
            `Halaman #${input.resourceId} tidak ditemukan.`,
            404,
          );
        }
        title = page.title;
        slug = page.slug;
        actualVersion = page.version;
      } else if (input.resourceType === "post") {
        const post = await getPostById(ctx.tenantDb, input.resourceId);
        if (!post) {
          throw new McpToolExecutionError(
            "NOT_FOUND",
            `Artikel #${input.resourceId} tidak ditemukan.`,
            404,
          );
        }
        title = post.title;
        slug = post.slug;
        actualVersion = post.version;
      } else {
        const offering = await getCatalogOfferingById(ctx.tenantDb, input.resourceId);
        if (!offering) {
          throw new McpToolExecutionError(
            "NOT_FOUND",
            `Penawaran #${input.resourceId} tidak ditemukan.`,
            404,
          );
        }
        title = offering.title;
        slug = offering.slug;
        actualVersion = offering.version;
      }

      if (actualVersion !== input.expectedVersion) {
        throw new McpToolExecutionError(
          "STALE_VERSION",
          `Versi draf tidak cocok (diharapkan ${input.expectedVersion}, saat ini ${actualVersion}).`,
          409,
        );
      }

      const approval = await createMcpPublishApproval(ctx.platformDb, {
        grantId: ctx.grantId,
        tenantId: ctx.tenantId,
        requestedByUserId: ctx.userId,
        clientId: ctx.clientId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        expectedVersion: input.expectedVersion,
        resourceTitle: title,
        resourceSlug: slug,
        nowMs: ctx.nowMs,
      });

      const cleanOrigin = ctx.adminOrigin.replace(/\/+$/, "");
      const approvalUrl = `${cleanOrigin}/auth/consent/publish/${encodeURIComponent(approval.token)}`;

      return {
        approvalRequired: true,
        published: false,
        status: "pending_human_confirmation",
        approvalId: approval.id,
        approvalUrl,
        expiresAt: new Date(approval.expiresAt).toISOString(),
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        expectedVersion: input.expectedVersion,
        title,
        slug,
        message:
          "Publikasi tidak dilakukan otomatis. Buka tautan persetujuan di browser PunyaSitus sebagai Pemilik atau Admin untuk meninjau dan menerbitkan draf ini.",
      };
    }

    case "list_leads": {
      const input = args as {
        readonly status?: "new" | "contacted" | "closed";
        readonly cursor?: number;
        readonly limit?: number;
      };
      const res = await listLeads(ctx.tenantDb, {
        status: input.status,
        cursor: input.cursor !== undefined ? String(input.cursor) : undefined,
        limit: input.limit ?? 20,
      });
      return {
        items: res.items,
        counts: res.counts,
        page: res.page,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }

    case "get_lead": {
      const { leadId } = args as { readonly leadId: number };
      const lead = await getLeadById(ctx.tenantDb, leadId);
      if (!lead) {
        throw new McpToolExecutionError("NOT_FOUND", `Prospek #${leadId} tidak ditemukan.`, 404);
      }
      return {
        lead,
        _untrustedDataNotice: MCP_UNTRUSTED_DATA_NOTICE,
      };
    }
  }
}

export type ResolvePublishApprovalResult =
  | {
      readonly ok: true;
      readonly decision: "approved";
      readonly outcome: "published" | "held_for_review";
      readonly reviewId?: string;
      readonly ownerNotice?: string;
    }
  | { readonly ok: true; readonly decision: "rejected" }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 410;
      readonly code: string;
      readonly message: string;
    };

/**
 * Executes human browser confirmation (or rejection) of a short-lived MCP publish approval token.
 *
 * Security invariants:
 * - Enforces actor binding: acting human MUST be EITHER the original `requestedByUserId`
 *   OR a live `owner` on `approval.tenantId` (always verified `owner`/`admin` by caller).
 * - Claims the approval token atomically FIRST (`WHERE status = 'pending' AND expires_at > ?`)
 *   BEFORE invoking `publishResourceWithScreening`, preventing TOCTOU double-publish races,
 *   and compensates cleanly if publication throws.
 */
export async function executeHumanPublishApproval(
  platformDb: D1Database,
  tenantDb: D1Database,
  params: {
    readonly rawToken: string;
    readonly actorUserId: string;
    readonly actorRole: "owner" | "admin";
    readonly decision: "approve" | "reject";
    readonly requestId?: string | null;
    readonly nowMs?: number;
  },
): Promise<ResolvePublishApprovalResult> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const approval = await getMcpPublishApprovalByToken(platformDb, params.rawToken);
  if (!approval) {
    return {
      ok: false,
      status: 404,
      code: "APPROVAL_NOT_FOUND",
      message: "Tautan persetujuan publikasi tidak ditemukan atau tidak valid.",
    };
  }

  // Actor binding: only the original requester OR a tenant Owner may approve/reject
  if (params.actorUserId !== approval.requestedByUserId && params.actorRole !== "owner") {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "mcp.publish_approval.denied_actor_binding",
      targetType: approval.resourceType,
      targetId: String(approval.resourceId),
      tenantId: approval.tenantId,
      outcome: "denied",
      requestId: params.requestId ?? null,
      metadata: {
        approvalId: approval.id,
        requestedByUserId: approval.requestedByUserId,
      },
      createdAtMs: nowMs,
    }).catch(() => undefined);

    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message:
        "Hanya peminta asli atau Pemilik (Owner) situs yang dapat memproses tautan persetujuan publikasi ini.",
    };
  }

  if (approval.status !== "pending") {
    return {
      ok: false,
      status: 409,
      code: "APPROVAL_ALREADY_USED",
      message: "Permintaan publikasi ini sudah diproses sebelumnya.",
    };
  }

  if (nowMs >= approval.expiresAt) {
    await markMcpPublishApprovalExpired(platformDb, approval.id, params.actorUserId, nowMs);
    return {
      ok: false,
      status: 410,
      code: "APPROVAL_EXPIRED",
      message: "Tautan persetujuan publikasi telah kedaluwarsa. Minta agen AI membuat tautan baru.",
    };
  }

  // Atomic claim-first BEFORE any side effect!
  const targetStatus = params.decision === "reject" ? "rejected" : "approved";
  const claimed = await claimPendingMcpPublishApprovalAtomically(platformDb, {
    approvalId: approval.id,
    nextStatus: targetStatus,
    resolvedByUserId: params.actorUserId,
    nowMs,
  });
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      code: "APPROVAL_ALREADY_USED",
      message: "Permintaan publikasi ini sudah digunakan atau sedang diproses.",
    };
  }

  if (params.decision === "reject") {
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "mcp.publish_approval.rejected",
      targetType: approval.resourceType,
      targetId: String(approval.resourceId),
      tenantId: approval.tenantId,
      outcome: "success",
      requestId: params.requestId ?? null,
      metadata: {
        approvalId: approval.id,
        clientId: approval.clientId,
        expectedVersion: approval.expectedVersion,
      },
      createdAtMs: nowMs,
    });
    return { ok: true, decision: "rejected" };
  }

  // Publish through the canonical screening gate (`publishSource: "mcp"`) with rollback on failure
  let publishOutcome: Awaited<ReturnType<typeof publishResourceWithScreening>>;
  try {
    publishOutcome = await publishResourceWithScreening(platformDb, tenantDb, {
      tenantId: approval.tenantId,
      resourceType: approval.resourceType,
      resourceId: approval.resourceId,
      expectedVersion: approval.expectedVersion,
      publishSource: "mcp",
      actorUserId: params.actorUserId,
      nowMs,
    });
  } catch (err) {
    // Compensate claim back to pending so a transient/version error never leaves a false 'approved' row
    await releaseClaimedMcpPublishApprovalOnError(platformDb, {
      approvalId: approval.id,
      resolvedByUserId: params.actorUserId,
      nowMs,
    }).catch(() => undefined);

    const errCode =
      err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
        ? String((err as { code: string }).code)
        : null;
    if (errCode === "STALE_VERSION") {
      return {
        ok: false,
        status: 409,
        code: "STALE_VERSION",
        message: "Draf telah berubah sejak tautan persetujuan dibuat. Minta agen AI membuat tautan baru.",
      };
    }
    throw err;
  }

  if (publishOutcome.outcome === "held_for_review") {
    await updateClaimedMcpPublishApprovalToHeld(platformDb, {
      approvalId: approval.id,
      reviewId: publishOutcome.reviewId,
      resolvedByUserId: params.actorUserId,
      nowMs,
    });
    await appendPlatformAudit(platformDb, {
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      action: "mcp.publish_approval.held_for_review",
      targetType: approval.resourceType,
      targetId: String(approval.resourceId),
      tenantId: approval.tenantId,
      outcome: "denied",
      requestId: params.requestId ?? null,
      metadata: {
        approvalId: approval.id,
        clientId: approval.clientId,
        reviewId: publishOutcome.reviewId,
      },
      createdAtMs: nowMs,
    });
    return {
      ok: true,
      decision: "approved",
      outcome: "held_for_review",
      reviewId: publishOutcome.reviewId,
      ownerNotice: publishOutcome.ownerNotice.message,
    };
  }

  await appendPlatformAudit(platformDb, {
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: "mcp.publish_approval.published",
    targetType: approval.resourceType,
    targetId: String(approval.resourceId),
    tenantId: approval.tenantId,
    outcome: "success",
    requestId: params.requestId ?? null,
    metadata: {
      approvalId: approval.id,
      clientId: approval.clientId,
      expectedVersion: approval.expectedVersion,
    },
    createdAtMs: nowMs,
  });

  return {
    ok: true,
    decision: "approved",
    outcome: "published",
  };
}
