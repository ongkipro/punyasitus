import { z } from "zod";
import {
  MCP_ALLOWED_TOOLS,
  MCP_SCOPES,
  MCP_TOOL_REQUIRED_SCOPE,
  type McpAllowedToolName,
  type McpScope,
} from "./constants.ts";

/**
 * Zod schemas for OAuth 2.1 CIMD documents, consent payloads, JSON-RPC 2.0 envelopes,
 * and every strictly allowlisted MCP tool (REQ-076, ADR-0008, PLAN §18.3, TASK-075).
 */

export const McpScopeSchema = z.enum(MCP_SCOPES);

export const CimdMetadataDocumentSchema = z
  .object({
    client_id: z.string().min(1).max(2048),
    client_name: z.string().trim().min(1).max(120),
    client_uri: z.string().url().max(2048).optional(),
    logo_uri: z.string().url().max(2048).optional(),
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    grant_types: z.array(z.string().min(1).max(64)).max(10).optional(),
    response_types: z.array(z.string().min(1).max(32)).max(10).optional(),
    token_endpoint_auth_method: z.string().min(1).max(64).optional(),
    scope: z.string().max(512).optional(),
  })
  .strict();

export type CimdMetadataDocument = z.infer<typeof CimdMetadataDocumentSchema>;

export const McpConsentSubmitSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    clientId: z.string().min(1).max(2048),
    redirectUri: z.string().min(1).max(2048),
    resource: z.string().min(1).max(2048),
    codeChallenge: z.string().min(43).max(128),
    codeChallengeMethod: z.literal("S256"),
    state: z.string().max(512).optional().default(""),
    tenantId: z.string().min(1).max(128).optional(),
    scopes: z.array(z.string().min(1).max(64)).max(10).optional(),
    piiConsentAcked: z.boolean().optional().default(false),
  })
  .strict();

export type McpConsentSubmitInput = z.infer<typeof McpConsentSubmitSchema>;

export const McpPublishApprovalActionSchema = z
  .object({
    token: z.string().min(16).max(256),
    decision: z.enum(["approve", "reject"]),
  })
  .strict();

export type McpPublishApprovalActionInput = z.infer<typeof McpPublishApprovalActionSchema>;

export const McpRevokeGrantSchema = z
  .object({
    grantId: z.string().min(1).max(128),
    reason: z.string().trim().max(240).optional(),
  })
  .strict();

export type McpRevokeGrantInput = z.infer<typeof McpRevokeGrantSchema>;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Envelope Schemas
// ---------------------------------------------------------------------------

export const JsonRpcIdSchema = z.union([z.string().max(128), z.number().int(), z.null()]);

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.optional(),
    method: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const McpToolCallParamsSchema = z
  .object({
    name: z.string().min(1).max(120),
    arguments: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Strict Tool Argument Schemas (forbid tenantId/tenant_id selector injection!)
// ---------------------------------------------------------------------------

const positiveIntId = z.number().int().min(1).max(2_147_483_647);
const nonNegIntVersion = z.number().int().min(0).max(2_147_483_647);
const paginationLimit = z.number().int().min(1).max(50).optional();

export const McpSeoInputSchema = z
  .object({
    metaTitle: z.string().max(120).nullable().optional(),
    metaDescription: z.string().max(320).nullable().optional(),
    ogTitle: z.string().max(120).nullable().optional(),
    ogDescription: z.string().max(320).nullable().optional(),
    ogImageMediaId: positiveIntId.nullable().optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

export const McpToolInputSchemas = {
  get_site_overview: z.object({}).strict(),

  list_pages: z
    .object({
      status: z.enum(["all", "draft", "published"]).optional(),
      cursor: z.string().max(32).optional(),
      limit: paginationLimit,
    })
    .strict(),

  get_page: z
    .object({
      pageId: positiveIntId,
    })
    .strict(),

  list_posts: z
    .object({
      status: z.enum(["all", "draft", "published"]).optional(),
      search: z.string().max(120).optional(),
      categoryId: positiveIntId.optional(),
      tagId: positiveIntId.optional(),
      cursor: z.string().max(32).optional(),
      limit: paginationLimit,
    })
    .strict(),

  get_post: z
    .object({
      postId: positiveIntId,
    })
    .strict(),

  list_offerings: z
    .object({
      offeringType: z.enum(["service", "product", "tour", "vehicle"]).optional(),
      status: z.enum(["draft", "published"]).optional(),
      categoryId: positiveIntId.optional(),
      cursor: positiveIntId.optional(),
      limit: paginationLimit,
    })
    .strict(),

  get_offering: z
    .object({
      offeringId: positiveIntId,
    })
    .strict(),

  create_page_draft: z
    .object({
      title: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(1).max(80).optional(),
      layoutMode: z.enum(["standard", "focused"]).optional(),
      sections: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  update_page_draft: z
    .object({
      pageId: positiveIntId,
      expectedVersion: nonNegIntVersion,
      title: z.string().trim().min(1).max(200).optional(),
      slug: z.string().trim().min(1).max(80).optional(),
      layoutMode: z.enum(["standard", "focused"]).optional(),
      sections: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  create_post_draft: z
    .object({
      title: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(1).max(80).optional(),
      excerpt: z.string().max(500).nullable().optional(),
      bodyHtml: z.string().max(100_000).optional(),
      body: z.record(z.string(), z.unknown()).optional(),
      featuredMediaId: positiveIntId.nullable().optional(),
      categoryIds: z.array(positiveIntId).max(10).optional(),
      tagIds: z.array(positiveIntId).max(20).optional(),
      enableToc: z.boolean().optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  update_post_draft: z
    .object({
      postId: positiveIntId,
      expectedVersion: nonNegIntVersion,
      title: z.string().trim().min(1).max(200).optional(),
      slug: z.string().trim().min(1).max(80).optional(),
      excerpt: z.string().max(500).nullable().optional(),
      bodyHtml: z.string().max(100_000).optional(),
      body: z.record(z.string(), z.unknown()).optional(),
      featuredMediaId: positiveIntId.nullable().optional(),
      categoryIds: z.array(positiveIntId).max(10).optional(),
      tagIds: z.array(positiveIntId).max(20).optional(),
      enableToc: z.boolean().optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  create_offering_draft: z
    .object({
      offeringType: z.enum(["service", "product", "tour", "vehicle"]),
      title: z.string().trim().min(1).max(200),
      slug: z.string().trim().min(1).max(80).optional(),
      summary: z.string().max(500).nullable().optional(),
      description: z.union([z.string().max(20_000), z.record(z.string(), z.unknown())]).optional(),
      priceMode: z.enum(["fixed", "from", "range", "on_request"]).optional().default("on_request"),
      price: z.number().int().min(0).max(999_999_999_999).nullable().optional(),
      priceMax: z.number().int().min(0).max(999_999_999_999).nullable().optional(),
      negotiable: z.boolean().optional(),
      ctaMode: z.enum(["whatsapp", "external_link", "inquiry", "book"]).optional().default("whatsapp"),
      externalUrl: z.string().max(2048).nullable().optional(),
      coverMediaId: positiveIntId.nullable().optional(),
      galleryMediaIds: z.array(positiveIntId).max(12).optional(),
      categoryIds: z.array(positiveIntId).max(10).optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  update_offering_draft: z
    .object({
      offeringId: positiveIntId,
      expectedVersion: nonNegIntVersion,
      title: z.string().trim().min(1).max(200).optional(),
      slug: z.string().trim().min(1).max(80).optional(),
      summary: z.string().max(500).nullable().optional(),
      description: z.union([z.string().max(20_000), z.record(z.string(), z.unknown())]).optional(),
      priceMode: z.enum(["fixed", "from", "range", "on_request"]).optional(),
      price: z.number().int().min(0).max(999_999_999_999).nullable().optional(),
      priceMax: z.number().int().min(0).max(999_999_999_999).nullable().optional(),
      negotiable: z.boolean().optional(),
      ctaMode: z.enum(["whatsapp", "external_link", "inquiry", "book"]).optional(),
      externalUrl: z.string().max(2048).nullable().optional(),
      coverMediaId: positiveIntId.nullable().optional(),
      galleryMediaIds: z.array(positiveIntId).max(12).optional(),
      categoryIds: z.array(positiveIntId).max(10).optional(),
      seo: McpSeoInputSchema.optional(),
    })
    .strict(),

  request_publish_approval: z
    .object({
      resourceType: z.enum(["page", "post", "offering"]),
      resourceId: positiveIntId,
      expectedVersion: nonNegIntVersion,
    })
    .strict(),

  list_leads: z
    .object({
      status: z.enum(["new", "contacted", "closed"]).optional(),
      cursor: positiveIntId.optional(),
      limit: paginationLimit,
    })
    .strict(),

  get_lead: z
    .object({
      leadId: positiveIntId,
    })
    .strict(),
} as const satisfies Record<McpAllowedToolName, z.ZodTypeAny>;

export interface McpToolDefinition {
  readonly name: McpAllowedToolName;
  readonly description: string;
  readonly requiredScope: McpScope;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: false;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
}

export const MCP_TOOL_DEFINITIONS: Readonly<Record<McpAllowedToolName, McpToolDefinition>> = {
  get_site_overview: {
    name: "get_site_overview",
    description:
      "Read a summary of the authorized website: site identity, handle, vertical, and counts of pages, posts, and offerings.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.get_site_overview,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_pages: {
    name: "list_pages",
    description: "List pages (draft and published) in the authorized website.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.list_pages,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "draft", "published"] },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_page: {
    name: "get_page",
    description: "Get full draft and published details for one page by sequential pageId.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.get_page,
    inputSchema: {
      type: "object",
      properties: { pageId: { type: "integer", minimum: 1 } },
      required: ["pageId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_posts: {
    name: "list_posts",
    description: "List blog posts in the authorized website.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.list_posts,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "draft", "published"] },
        search: { type: "string" },
        categoryId: { type: "integer", minimum: 1 },
        tagId: { type: "integer", minimum: 1 },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_post: {
    name: "get_post",
    description: "Get full details for one blog post by sequential postId.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.get_post,
    inputSchema: {
      type: "object",
      properties: { postId: { type: "integer", minimum: 1 } },
      required: ["postId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_offerings: {
    name: "list_offerings",
    description: "List catalog offerings (service, product, tour, vehicle) in the authorized website.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.list_offerings,
    inputSchema: {
      type: "object",
      properties: {
        offeringType: { type: "string", enum: ["service", "product", "tour", "vehicle"] },
        status: { type: "string", enum: ["draft", "published"] },
        categoryId: { type: "integer", minimum: 1 },
        cursor: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_offering: {
    name: "get_offering",
    description: "Get full details for one catalog offering by sequential offeringId.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.get_offering,
    inputSchema: {
      type: "object",
      properties: { offeringId: { type: "integer", minimum: 1 } },
      required: ["offeringId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  create_page_draft: {
    name: "create_page_draft",
    description: "Create a new page as a private DRAFT only (never publishes directly).",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.create_page_draft,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        layoutMode: { type: "string", enum: ["standard", "focused"] },
        sections: { type: "array", items: { type: "object" } },
        seo: { type: "object" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  update_page_draft: {
    name: "update_page_draft",
    description: "Update the DRAFT of an existing page with optimistic concurrency (expectedVersion). Never publishes directly or changes live published slugs.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.update_page_draft,
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "integer", minimum: 1 },
        expectedVersion: { type: "integer", minimum: 0 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        layoutMode: { type: "string", enum: ["standard", "focused"] },
        sections: { type: "array", items: { type: "object" } },
        seo: { type: "object" },
      },
      required: ["pageId", "expectedVersion"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  create_post_draft: {
    name: "create_post_draft",
    description: "Create a new blog post as a private DRAFT only (never publishes directly).",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.create_post_draft,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        excerpt: { type: ["string", "null"], maxLength: 500 },
        bodyHtml: { type: "string" },
        body: { type: "object" },
        featuredMediaId: { type: ["integer", "null"] },
        categoryIds: { type: "array", items: { type: "integer", minimum: 1 } },
        tagIds: { type: "array", items: { type: "integer", minimum: 1 } },
        enableToc: { type: "boolean" },
        seo: { type: "object" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  update_post_draft: {
    name: "update_post_draft",
    description: "Update the DRAFT of an existing blog post with optimistic concurrency (expectedVersion). Never publishes directly or changes live published slugs.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.update_post_draft,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "integer", minimum: 1 },
        expectedVersion: { type: "integer", minimum: 0 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        excerpt: { type: ["string", "null"], maxLength: 500 },
        bodyHtml: { type: "string" },
        body: { type: "object" },
        featuredMediaId: { type: ["integer", "null"] },
        categoryIds: { type: "array", items: { type: "integer", minimum: 1 } },
        tagIds: { type: "array", items: { type: "integer", minimum: 1 } },
        enableToc: { type: "boolean" },
        seo: { type: "object" },
      },
      required: ["postId", "expectedVersion"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  create_offering_draft: {
    name: "create_offering_draft",
    description: "Create a new catalog offering as a private DRAFT only (never publishes directly).",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.create_offering_draft,
    inputSchema: {
      type: "object",
      properties: {
        offeringType: { type: "string", enum: ["service", "product", "tour", "vehicle"] },
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        summary: { type: ["string", "null"], maxLength: 500 },
        description: { type: ["string", "object"] },
        priceMode: { type: "string", enum: ["fixed", "from", "range", "on_request"] },
        price: { type: ["integer", "null"], minimum: 0 },
        priceMax: { type: ["integer", "null"], minimum: 0 },
        negotiable: { type: "boolean" },
        ctaMode: { type: "string", enum: ["whatsapp", "external_link", "inquiry", "book"] },
        externalUrl: { type: ["string", "null"] },
        coverMediaId: { type: ["integer", "null"] },
        galleryMediaIds: { type: "array", items: { type: "integer", minimum: 1 } },
        categoryIds: { type: "array", items: { type: "integer", minimum: 1 } },
        seo: { type: "object" },
      },
      required: ["offeringType", "title"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  update_offering_draft: {
    name: "update_offering_draft",
    description: "Update the DRAFT of an existing catalog offering with optimistic concurrency (expectedVersion). Never publishes directly.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.update_offering_draft,
    inputSchema: {
      type: "object",
      properties: {
        offeringId: { type: "integer", minimum: 1 },
        expectedVersion: { type: "integer", minimum: 0 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        slug: { type: "string", maxLength: 80 },
        summary: { type: ["string", "null"], maxLength: 500 },
        description: { type: ["string", "object"] },
        priceMode: { type: "string", enum: ["fixed", "from", "range", "on_request"] },
        price: { type: ["integer", "null"], minimum: 0 },
        priceMax: { type: ["integer", "null"], minimum: 0 },
        negotiable: { type: "boolean" },
        ctaMode: { type: "string", enum: ["whatsapp", "external_link", "inquiry", "book"] },
        externalUrl: { type: ["string", "null"] },
        coverMediaId: { type: ["integer", "null"] },
        galleryMediaIds: { type: "array", items: { type: "integer", minimum: 1 } },
        categoryIds: { type: "array", items: { type: "integer", minimum: 1 } },
        seo: { type: "object" },
      },
      required: ["offeringId", "expectedVersion"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  request_publish_approval: {
    name: "request_publish_approval",
    description:
      "Create a short-lived one-time human confirmation link to publish a specific draft revision (page, post, or offering). Never publishes without human confirmation in the PunyaSitus browser UI.",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.request_publish_approval,
    inputSchema: {
      type: "object",
      properties: {
        resourceType: { type: "string", enum: ["page", "post", "offering"] },
        resourceId: { type: "integer", minimum: 1 },
        expectedVersion: { type: "integer", minimum: 0 },
      },
      required: ["resourceType", "resourceId", "expectedVersion"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  list_leads: {
    name: "list_leads",
    description: "List leads/inquiries in the authorized website (requires leads:read scope and PII consent).",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.list_leads,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["new", "contacted", "closed"] },
        cursor: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_lead: {
    name: "get_lead",
    description: "Get details for one lead by sequential leadId (requires leads:read scope and PII consent).",
    requiredScope: MCP_TOOL_REQUIRED_SCOPE.get_lead,
    inputSchema: {
      type: "object",
      properties: { leadId: { type: "integer", minimum: 1 } },
      required: ["leadId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
};

export function listToolsForGrantedScopes(
  grantedScopes: ReadonlySet<McpScope>,
  piiConsentAcked: boolean,
): readonly McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  for (const name of MCP_ALLOWED_TOOLS) {
    const def = MCP_TOOL_DEFINITIONS[name];
    if (!grantedScopes.has(def.requiredScope)) continue;
    if (def.requiredScope === "leads:read" && !piiConsentAcked) continue;
    tools.push(def);
  }
  return tools;
}
