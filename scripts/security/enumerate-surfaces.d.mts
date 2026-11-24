export interface EnumeratedRoute {
  readonly route: string;
  readonly file: string;
  readonly kind: "page" | "endpoint" | "middleware_endpoint";
  readonly methods: readonly string[];
  readonly category: string;
  readonly tenantScoped: boolean;
  readonly expectedHost: string;
  readonly authModel: string;
}

export interface EnumeratedMcpTool {
  readonly name: string;
  readonly scope: string;
  readonly group: string;
}

export interface EnumeratedPlugin {
  readonly id: string;
  readonly symbol: string;
  readonly entryFile: string;
  readonly publicRoutes: readonly string[];
  readonly hasAdminApi: boolean;
  readonly hasWebhook: boolean;
  readonly adminApiRoute: string;
  readonly webhookRoute: string | null;
}

export interface SurfaceInventory {
  readonly schemaVersion: string;
  readonly generatedBy: string;
  readonly summary: {
    readonly totalRoutes: number;
    readonly countsByCategory: Readonly<Record<string, number>>;
    readonly mcpAllowedToolCount: number;
    readonly mcpExcludedToolCount: number;
    readonly registeredPluginCount: number;
  };
  readonly routes: readonly EnumeratedRoute[];
  readonly mcpTools: {
    readonly source: string;
    readonly allowed: readonly EnumeratedMcpTool[];
    readonly excluded: readonly string[];
  };
  readonly plugins: readonly EnumeratedPlugin[];
}

export const REPO_ROOT: string;
export const INVENTORY_PATH: string;
export function extractHttpMethods(source: string): string[];
export function classifyRoute(
  route: string,
  kind: "page" | "endpoint",
): {
  readonly category: string;
  readonly tenantScoped: boolean;
  readonly expectedHost: string;
  readonly authModel: string;
};
export function enumerateAllSurfaces(): SurfaceInventory;
export function compareInventories(
  actual: SurfaceInventory,
  recorded: SurfaceInventory,
): string[];
