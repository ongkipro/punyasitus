import {
  definePlugin,
  isBuiltinPluginId,
  type PluginDefinition,
  type PluginHookEvent,
} from "@punyasitus/core/plugins/index";
import {
  SEO_AI_AUTOPILOT_PLUGIN,
  SEO_AI_AUTOPILOT_PLUGIN_ID,
} from "../../../../packages/plugins/seo-ai-autopilot/index.ts";

/**
 * Explicit First-Party Modular Plugin Registry (REQ-097, ADR-0010, PLAN §19.7).
 *
 * Security invariants:
 * - Zero dynamic `.zip` loading, zero remote `import()`, zero `eval()`.
 * - Every plugin is explicitly code-reviewed and statically registered here.
 * - Rejects `builtin:*` identifiers and duplicate public route paths at registration time.
 */

export interface PluginRegistry {
  readonly list: () => readonly PluginDefinition[];
  readonly get: (pluginId: string) => PluginDefinition | null;
  readonly has: (pluginId: string) => boolean;
  readonly findByPublicRoute: (pathname: string) => PluginDefinition | null;
  readonly findByPublicSection: (sectionId: string) => PluginDefinition | null;
  readonly findByQueueHook: (event: PluginHookEvent) => readonly PluginDefinition[];
  readonly findByMcpTool: (toolName: string) => PluginDefinition | null;
}

function normalizeRoutePath(pathname: string): string {
  const trimmed = pathname.trim().toLowerCase();
  if (trimmed.length > 1 && trimmed.endsWith("/")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function createPluginRegistry(
  definitions: readonly PluginDefinition[] = [],
): PluginRegistry {
  const byId = new Map<string, PluginDefinition>();
  const byPublicRoute = new Map<string, PluginDefinition>();
  const byPublicSection = new Map<string, PluginDefinition>();
  const byMcpTool = new Map<string, PluginDefinition>();

  for (const rawDef of definitions) {
    const def = definePlugin(rawDef);
    const id = def.manifest.id;

    if (byId.has(id)) {
      throw new Error(`PLUGIN_REGISTRY_DUPLICATE_ID: Duplicate plugin ID "${id}"`);
    }
    byId.set(id, def);

    for (const route of def.manifest.slots.publicRoutes) {
      const normalized = normalizeRoutePath(route.path);
      if (byPublicRoute.has(normalized)) {
        throw new Error(
          `PLUGIN_REGISTRY_ROUTE_CONFLICT: Public route "${normalized}" already claimed by "${byPublicRoute.get(normalized)!.manifest.id}"`,
        );
      }
      byPublicRoute.set(normalized, def);
    }

    for (const section of def.manifest.slots.publicSections) {
      if (byPublicSection.has(section.id)) {
        throw new Error(
          `PLUGIN_REGISTRY_SECTION_CONFLICT: Public section "${section.id}" already claimed by "${byPublicSection.get(section.id)!.manifest.id}"`,
        );
      }
      byPublicSection.set(section.id, def);
    }

    for (const tool of def.manifest.slots.mcpTools) {
      if (byMcpTool.has(tool.name)) {
        throw new Error(
          `PLUGIN_REGISTRY_MCP_CONFLICT: MCP tool "${tool.name}" already claimed by "${byMcpTool.get(tool.name)!.manifest.id}"`,
        );
      }
      byMcpTool.set(tool.name, def);
    }
  }

  const ordered = [...byId.values()];

  return {
    list() {
      return ordered;
    },
    get(pluginId: string): PluginDefinition | null {
      if (!pluginId || isBuiltinPluginId(pluginId)) return null;
      return byId.get(pluginId.trim().toLowerCase()) ?? null;
    },
    has(pluginId: string): boolean {
      if (!pluginId || isBuiltinPluginId(pluginId)) return false;
      return byId.has(pluginId.trim().toLowerCase());
    },
    findByPublicRoute(pathname: string): PluginDefinition | null {
      return byPublicRoute.get(normalizeRoutePath(pathname)) ?? null;
    },
    findByPublicSection(sectionId: string): PluginDefinition | null {
      return byPublicSection.get(sectionId.trim().toLowerCase()) ?? null;
    },
    findByQueueHook(event: PluginHookEvent): readonly PluginDefinition[] {
      return ordered.filter(
        (def) =>
          def.manifest.slots.queueHooks.includes(event) &&
          typeof def.queueHooks?.[event]?.execute === "function",
      );
    },
    findByMcpTool(toolName: string): PluginDefinition | null {
      return byMcpTool.get(toolName.trim()) ?? null;
    },
  };
}

/**
 * Official statically registered first-party plugins compiled into this Worker bundle.
 * Future tasks (TASK-099 `bio-links`/`wa-cs-rotator`, TASK-100 `wp-importer`,
 * TASK-101 `lead-notifier`) register here without touching Frozen Core.
 */
export const REGISTERED_FIRST_PARTY_PLUGINS: readonly PluginDefinition[] = [
  SEO_AI_AUTOPILOT_PLUGIN,
] as const;

/**
 * Official free plugins active by default on every newly provisioned website (`DEC-042`, `REQ-102`).
 */
export const DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS = [SEO_AI_AUTOPILOT_PLUGIN_ID] as const;

export function isDefaultActiveOnProvisionPlugin(pluginId: string): boolean {
  const normalized = pluginId.trim().toLowerCase();
  return (DEFAULT_ACTIVE_ON_PROVISION_PLUGIN_IDS as readonly string[]).includes(normalized);
}

export const DEFAULT_PLUGIN_REGISTRY: PluginRegistry = createPluginRegistry(
  REGISTERED_FIRST_PARTY_PLUGINS,
);

export function getRegisteredPlugin(
  pluginId: string,
  registry: PluginRegistry = DEFAULT_PLUGIN_REGISTRY,
): PluginDefinition | null {
  return registry.get(pluginId);
}

export function listRegisteredPlugins(
  registry: PluginRegistry = DEFAULT_PLUGIN_REGISTRY,
): readonly PluginDefinition[] {
  return registry.list();
}
