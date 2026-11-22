/**
 * Frozen-Core modular plugin boundary contract (ADR-0010, DEC-037).
 * Concrete first-party plugins live in packages/plugins/<plugin-id>/.
 */
export type PluginVisibility = "public_free" | "public_paid" | "private_client";

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly visibility: PluginVisibility;
  readonly tablePrefix: `plg_${string}__`;
}

export function assertPluginTablePrefix(pluginId: string, tableName: string): void {
  const normalized = pluginId.replace(/-/g, "_");
  const expectedPrefix = `plg_${normalized}__`;
  if (!tableName.startsWith(expectedPrefix)) {
    throw new Error(
      `Plugin "${pluginId}" table "${tableName}" must start with "${expectedPrefix}"`,
    );
  }
}
