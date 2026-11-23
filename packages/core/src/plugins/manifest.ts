import { z } from "zod";
import {
  isValidPluginId,
  pluginIdToTablePrefix,
  validatePluginMigrationSql,
} from "./sql-guard.ts";

/**
 * Frozen-Core First-Party Plugin Manifest & 5-Slot Extension Contracts
 * (REQ-097, ADR-0010, DEC-037, PLAN §19.7, docs/plugins/PLUGIN-DEVELOPMENT.md).
 */

export const PUBLIC_PLUGIN_JS_BUDGET_BYTES = 25 * 1024; // 25 KiB hard ceiling (REQ-040)
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 5_000;

export const PluginVisibilitySchema = z.enum([
  "public_free",
  "public_paid",
  "private_client",
]);
export type PluginVisibility = z.infer<typeof PluginVisibilitySchema>;

export const PluginBillingCycleSchema = z.enum([
  "free",
  "paid_once",
  "paid_monthly",
  "paid_yearly",
  "custom",
]);
export type PluginBillingCycle = z.infer<typeof PluginBillingCycleSchema>;

export const PluginHookEventSchema = z.enum([
  "lead.created",
  "offering.published",
  "post.published",
  "cron.daily",
]);
export type PluginHookEvent = z.infer<typeof PluginHookEventSchema>;

export const PluginPermissionSchema = z.enum([
  "tenant_db:plg_tables",
  "public:section",
  "public:route",
  "public:head",
  "admin:page",
  "admin:api",
  "queue:lead.created",
  "queue:offering.published",
  "queue:post.published",
  "queue:cron.daily",
  "webhook:inbound",
  "mcp:read",
  "mcp:write",
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginIdSchema = z
  .string()
  .refine(isValidPluginId, {
    message:
      "Plugin ID must be 3-48 lowercase ASCII alphanumeric/hyphen chars starting with a letter and never using the 'builtin:' prefix",
  });

export const PluginMigrationSchema = z
  .object({
    version: z.number().int().min(1).max(10_000),
    name: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[0-9]{4}_[a-z0-9_]+$/, "Migration name must follow 0001_snake_case format"),
    sql: z.string().min(1).max(65_536),
    checksum: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PluginMigrationDescriptor = z.infer<typeof PluginMigrationSchema>;

const RESERVED_CORE_PUBLIC_PREFIXES = [
  "/api",
  "/dashboard",
  "/console",
  "/auth",
  "/account",
  "/agency",
  "/affiliate",
  "/onboarding",
  "/billing",
  "/pay",
  "/mcp",
  "/oauth2",
  "/.well-known",
  "/_astro",
  "/blog",
  "/layanan",
  "/produk",
  "/tour",
  "/kendaraan",
] as const;

export function isReservedPluginPublicRoutePath(pathname: string): boolean {
  const normalized = pathname.trim().toLowerCase();
  return RESERVED_CORE_PUBLIC_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export const PluginPublicRouteDeclSchema = z
  .object({
    path: z
      .string()
      .min(2)
      .max(120)
      .regex(/^\/[a-z0-9][a-z0-9/_-]*$/, "Public route path must be a normalized lowercase path")
      .refine((p) => !isReservedPluginPublicRoutePath(p), {
        message: "Plugin public sub-route cannot shadow reserved core CMS or platform paths",
      }),
    maxJsBytes: z.number().int().min(0).max(PUBLIC_PLUGIN_JS_BUDGET_BYTES).default(0),
    description: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PluginPublicRouteDecl = z.infer<typeof PluginPublicRouteDeclSchema>;

export const PluginPublicSectionDeclSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/, "Section ID must be lowercase kebab-case"),
    label: z.string().min(1).max(80),
    maxJsBytes: z.number().int().min(0).max(PUBLIC_PLUGIN_JS_BUDGET_BYTES).default(0),
  })
  .strict();
export type PluginPublicSectionDecl = z.infer<typeof PluginPublicSectionDeclSchema>;

export const PluginMcpToolDeclSchema = z
  .object({
    name: z
      .string()
      .min(5)
      .max(80)
      .regex(/^plg_[a-z0-9_]+$/, "Plugin MCP tool name must start with plg_"),
    description: z.string().min(1).max(300),
    requiredScopes: z.array(z.string().min(1).max(64)).min(1).max(10),
    mode: z.enum(["read", "draft", "publish"]),
  })
  .strict();
export type PluginMcpToolDecl = z.infer<typeof PluginMcpToolDeclSchema>;

export const PluginSlotsManifestSchema = z
  .object({
    hasMigrations: z.boolean().default(false),
    publicSections: z.array(PluginPublicSectionDeclSchema).max(20).default([]),
    publicRoutes: z.array(PluginPublicRouteDeclSchema).max(20).default([]),
    hasAdminPage: z.boolean().default(true),
    hasAdminApi: z.boolean().default(false),
    queueHooks: z.array(PluginHookEventSchema).max(10).default([]),
    hasWebhook: z.boolean().default(false),
    mcpTools: z.array(PluginMcpToolDeclSchema).max(20).default([]),
  })
  .strict();
export type PluginSlotsManifest = z.infer<typeof PluginSlotsManifestSchema>;

export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    name: z.string().min(2).max(80),
    description: z.string().min(4).max(400),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/, "Version must be semantic version (e.g. 1.0.0)"),
    visibility: PluginVisibilitySchema,
    billingCycle: PluginBillingCycleSchema.default("free"),
    priceIdr: z.number().int().min(0).max(999_999_999_999).default(0),
    tablePrefix: z.string().regex(/^plg_[a-z][a-z0-9_]*__$/),
    permissions: z.array(PluginPermissionSchema).max(20).default([]),
    maxPublicJsBytes: z.number().int().min(0).max(PUBLIC_PLUGIN_JS_BUDGET_BYTES).default(0),
    slots: PluginSlotsManifestSchema,
    defaultConfig: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((val, ctx) => {
    const expectedPrefix = pluginIdToTablePrefix(val.id);
    if (val.tablePrefix !== expectedPrefix) {
      ctx.addIssue({
        code: "custom",
        path: ["tablePrefix"],
        message: `tablePrefix must equal "${expectedPrefix}" for plugin "${val.id}"`,
      });
    }
    if (val.visibility === "public_free" && val.priceIdr !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["priceIdr"],
        message: "public_free plugins must have priceIdr = 0",
      });
    }
    const toolPrefix = `plg_${val.id.replace(/-/g, "_")}_`;
    for (let i = 0; i < val.slots.mcpTools.length; i += 1) {
      const tool = val.slots.mcpTools[i]!;
      if (!tool.name.startsWith(toolPrefix)) {
        ctx.addIssue({
          code: "custom",
          path: ["slots", "mcpTools", i, "name"],
          message: `MCP tool "${tool.name}" must start with "${toolPrefix}"`,
        });
      }
    }
  });

export type PluginManifest = Omit<z.infer<typeof PluginManifestSchema>, "tablePrefix"> & {
  readonly tablePrefix: `plg_${string}__`;
};

/**
 * Restricted TenantStore SQL handle passed to plugin runtime slots.
 * Every query is strictly validated by `validatePluginQuerySql` against `plg_<id>__*`.
 */
export interface PluginTenantDb {
  readonly pluginId: string;
  readonly tablePrefix: `plg_${string}__`;
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface PluginTenantSnapshot {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly status: string;
  readonly primaryHost?: string | null;
}

export interface PluginPublicSectionContext {
  readonly tenant: PluginTenantSnapshot;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface PluginPublicRenderResult {
  readonly html: string;
  readonly cssBytes?: number;
  readonly jsBytes?: number;
  readonly inlineJs?: string;
}

export interface PluginPublicRouteContext {
  readonly tenant: PluginTenantSnapshot;
  readonly request: Request;
  readonly pathname: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
}

export interface PluginPublicRouteResponse {
  readonly status?: number;
  readonly html: string;
  readonly title: string;
  readonly description?: string;
  readonly cssBytes?: number;
  readonly jsBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PluginAdminApiContext {
  readonly tenant: PluginTenantSnapshot;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly request: Request;
  readonly subPath: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
  readonly nowMs: number;
}

export interface PluginAdminLoadContext {
  readonly tenant: PluginTenantSnapshot;
  readonly actorUserId: string;
  readonly actorRole: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
}

export interface PluginQueueHookContext {
  readonly tenantId: string;
  readonly pluginId: string;
  readonly event: PluginHookEvent;
  readonly eventId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
  readonly nowMs: number;
}

export interface PluginQueueHookHandler {
  readonly timeoutMs?: number;
  readonly execute: (ctx: PluginQueueHookContext) => Promise<void>;
}

export interface PluginWebhookResolveResult {
  readonly tenantId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PluginWebhookContext {
  readonly tenant: PluginTenantSnapshot;
  readonly pluginId: string;
  readonly request: Request;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
  readonly nowMs: number;
}

export interface PluginWebhookSlot {
  readonly secretHeaderName: string;
  readonly verifySecret: (request: Request, env: Readonly<Record<string, unknown>>) => boolean;
  readonly resolveTenantTarget: (
    request: Request,
    rawBody: string,
  ) => Promise<PluginWebhookResolveResult | null> | PluginWebhookResolveResult | null;
  readonly handle: (ctx: PluginWebhookContext) => Promise<Response>;
}

export interface PluginMcpToolContext {
  readonly tenant: PluginTenantSnapshot;
  readonly actorUserId: string;
  readonly grantedScopes: readonly string[];
  readonly args: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly db: PluginTenantDb;
  readonly nowMs: number;
}

export interface PluginMcpToolHandler {
  readonly name: string;
  readonly description: string;
  readonly requiredScopes: readonly string[];
  readonly mode: "read" | "draft" | "publish";
  readonly execute: (ctx: PluginMcpToolContext) => Promise<Record<string, unknown>>;
}

export interface PluginConfigFieldHint {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: "text" | "boolean" | "number";
  readonly placeholder?: string;
}

export interface PluginConfigSchemaLike {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: Record<string, unknown> }
    | { readonly success: false; readonly error?: unknown };
}

export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly migrations?: readonly PluginMigrationDescriptor[];
  readonly publicSlots?: {
    readonly sections?: Readonly<
      Record<
        string,
        (ctx: PluginPublicSectionContext) => Promise<PluginPublicRenderResult> | PluginPublicRenderResult
      >
    >;
    readonly routes?: Readonly<
      Record<
        string,
        (
          ctx: PluginPublicRouteContext,
        ) => Promise<PluginPublicRouteResponse> | PluginPublicRouteResponse
      >
    >;
  };
  readonly adminSlots?: {
    readonly configFields?: readonly PluginConfigFieldHint[];
    readonly configSchema?: PluginConfigSchemaLike;
    readonly loadState?: (ctx: PluginAdminLoadContext) => Promise<Record<string, unknown>>;
    readonly apiHandler?: (ctx: PluginAdminApiContext) => Promise<Response>;
  };
  readonly queueHooks?: Partial<Record<PluginHookEvent, PluginQueueHookHandler>>;
  readonly webhook?: PluginWebhookSlot;
  readonly mcpTools?: readonly PluginMcpToolHandler[];
}

export function validatePluginManifest(input: unknown): PluginManifest {
  const parsed = PluginManifestSchema.parse(input);
  return parsed as PluginManifest;
}

/**
 * Validates a first-party plugin definition (manifest + all migration SQL + slot declarations)
 * at registration time so invalid namespaces or budget violations fail closed immediately.
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  const manifest = validatePluginManifest(definition.manifest);

  if (definition.migrations && definition.migrations.length > 0) {
    const seenVersions = new Set<number>();
    const seenNames = new Set<string>();
    for (const mig of definition.migrations) {
      const parsedMig = PluginMigrationSchema.parse(mig);
      if (seenVersions.has(parsedMig.version)) {
        throw new Error(
          `Duplicate migration version ${parsedMig.version} in plugin "${manifest.id}"`,
        );
      }
      if (seenNames.has(parsedMig.name)) {
        throw new Error(`Duplicate migration name "${parsedMig.name}" in plugin "${manifest.id}"`);
      }
      seenVersions.add(parsedMig.version);
      seenNames.add(parsedMig.name);
      validatePluginMigrationSql(manifest.id, parsedMig.sql);
    }
  }

  return {
    ...definition,
    manifest,
  };
}
