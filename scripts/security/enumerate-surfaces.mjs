#!/usr/bin/env node
/* global process, console */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Programmatic Security Surface Enumeration & Drift Check (`TASK-078`, `REQ-078`).
 *
 * Walks the real repository on disk to enumerate:
 *  1. Every Astro page (`.astro`) and HTTP endpoint (`.ts`, `.mts`, `.js`, `.mjs`, `.tsx`
 *     exporting any HTTP verb via declaration or re-export) under `apps/web/src/pages/**`
 *  2. Every middleware-handled OAuth 2.1 / MCP protocol path under `apps/web/src/middleware/mcp-oauth.ts`
 *  3. Every MCP allowed & excluded tool in `packages/core/src/mcp/constants.ts`
 *  4. Every statically registered first-party plugin in `apps/web/src/core/plugin-registry.ts`
 *
 * Usage:
 *   node scripts/security/enumerate-surfaces.mjs --write   # write docs/security/surface-inventory.json
 *   node scripts/security/enumerate-surfaces.mjs --check   # fail (exit 1) on any drift vs inventory
 *   node scripts/security/enumerate-surfaces.mjs --json    # emit current inventory JSON to stdout
 */

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export const PAGES_DIR = path.join(REPO_ROOT, "apps/web/src/pages");
export const INVENTORY_PATH = path.join(REPO_ROOT, "docs/security/surface-inventory.json");
export const MCP_CONSTANTS_PATH = path.join(REPO_ROOT, "packages/core/src/mcp/constants.ts");
export const MCP_OAUTH_MIDDLEWARE_PATH = path.join(
  REPO_ROOT,
  "apps/web/src/middleware/mcp-oauth.ts",
);
export const PLUGIN_REGISTRY_PATH = path.join(REPO_ROOT, "apps/web/src/core/plugin-registry.ts");

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);
const ENDPOINT_EXTS = new Set([".ts", ".mts", ".js", ".mjs", ".tsx"]);

// Matches `export [async] function GET`, `export const|let|var POST`, etc.
const HTTP_METHOD_DECL_RE =
  /\bexport\s+(?:(?:async\s+)?function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\b/g;

// Matches `export { GET, postHandler as POST }` and `export { GET } from "./..."`
const HTTP_METHOD_BRACED_RE = /\bexport\s*\{([^}]+)\}/g;

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function isPrivateAstroSegment(relFromPages) {
  return relFromPages.split("/").some((segment) => segment.startsWith("_"));
}

function filePathToRoutePattern(relFromPages) {
  let route = relFromPages;
  for (const ext of [".astro", ".ts", ".mts", ".js", ".mjs", ".tsx"]) {
    if (route.endsWith(ext)) {
      route = route.slice(0, -ext.length);
      break;
    }
  }
  if (route === "index") {
    return "/";
  }
  if (route.endsWith("/index")) {
    route = route.slice(0, -"/index".length);
  }
  return `/${route}`;
}

export function extractHttpMethods(source) {
  const methods = new Set();

  for (const match of source.matchAll(HTTP_METHOD_DECL_RE)) {
    if (match[1] && HTTP_VERBS.has(match[1])) {
      methods.add(match[1]);
    }
  }

  for (const match of source.matchAll(HTTP_METHOD_BRACED_RE)) {
    const inner = match[1] ?? "";
    for (const part of inner.split(",")) {
      const cleaned = part.replace(/\btype\s+/g, "").trim();
      if (!cleaned) continue;
      const asParts = cleaned.split(/\s+as\s+/);
      const exportedName = (asParts[asParts.length - 1] ?? "").trim();
      if (HTTP_VERBS.has(exportedName)) {
        methods.add(exportedName);
      }
    }
  }

  return [...methods].sort();
}

export function classifyRoute(route, kind) {
  if (
    route === "/mcp" ||
    route.startsWith("/mcp/") ||
    route.startsWith("/oauth2/") ||
    route.startsWith("/.well-known/oauth-")
  ) {
    return {
      category: "mcp_oauth",
      tenantScoped: route === "/mcp" || route.startsWith("/mcp/"),
      expectedHost: "app",
      authModel: route.startsWith("/.well-known/oauth-") ? "public_discovery" : "oauth2_bearer_only",
    };
  }

  if (route.startsWith("/api/console/") || route === "/api/console") {
    return {
      category: "console_api",
      tenantScoped: false,
      expectedHost: "console",
      authModel: "platform_operator_2fa",
    };
  }

  if (route.startsWith("/console/") || route === "/console") {
    return {
      category: "console_page",
      tenantScoped: false,
      expectedHost: "console",
      authModel: "platform_operator_2fa",
    };
  }

  if (route === "/api/tenants" || route.startsWith("/api/tenants/")) {
    return {
      category: "tenant_api",
      tenantScoped: true,
      expectedHost: "app",
      authModel: "session_tenant_member_rbac",
    };
  }

  if (route.startsWith("/dashboard/") && kind === "endpoint") {
    return {
      category: "tenant_api",
      tenantScoped: true,
      expectedHost: "app",
      authModel: "session_tenant_member_rbac",
    };
  }

  if (route.startsWith("/dashboard/")) {
    return {
      category: "tenant_dashboard_page",
      tenantScoped: true,
      expectedHost: "app",
      authModel: "session_tenant_member",
    };
  }

  if (route.startsWith("/api/agency/") || route === "/api/agency") {
    return {
      category: "agency_api",
      tenantScoped: false,
      expectedHost: "app",
      authModel: "session_agency_2fa",
    };
  }

  if (route.startsWith("/agency/") || route === "/agency") {
    return {
      category: "agency_page",
      tenantScoped: false,
      expectedHost: "app",
      authModel: "session_agency_2fa",
    };
  }

  if (
    route.startsWith("/api/affiliate/") ||
    route === "/api/affiliate" ||
    route.startsWith("/api/affiliates/") ||
    route === "/api/affiliates"
  ) {
    return {
      category: "affiliate_api",
      tenantScoped: false,
      expectedHost: "app",
      authModel: "session_affiliate_account",
    };
  }

  if (route.startsWith("/affiliate/") || route === "/affiliate") {
    return {
      category: "affiliate_page",
      tenantScoped: false,
      expectedHost: "app",
      authModel: "session_affiliate_account",
    };
  }

  if (route === "/api/onboarding" || route.startsWith("/api/onboarding/")) {
    return {
      category: "onboarding_api",
      tenantScoped: false,
      expectedHost: "app",
      authModel: "session_app_user",
    };
  }

  if (
    route === "/api/account" ||
    route.startsWith("/api/account/") ||
    route === "/api/auth" ||
    route.startsWith("/api/auth/") ||
    route === "/auth" ||
    route.startsWith("/auth/") ||
    route === "/account" ||
    route.startsWith("/account/")
  ) {
    return {
      category: "auth_account",
      tenantScoped: false,
      expectedHost: "app",
      authModel:
        route.startsWith("/account") || route.startsWith("/api/account")
          ? "session_app_user"
          : "auth_flow",
    };
  }

  if (route.startsWith("/api/plugins/")) {
    return {
      category: "plugin_webhook",
      tenantScoped: true,
      expectedHost: "app",
      authModel: "plugin_webhook_secret",
    };
  }

  if (
    route === "/api/health" ||
    route.startsWith("/api/health/") ||
    route.startsWith("/api/webhooks/") ||
    route.startsWith("/marketing/api/") ||
    route === "/pay/renew" ||
    route === "/.well-known/punyasitus-domain-check"
  ) {
    return {
      category: "platform_public_endpoint",
      tenantScoped: false,
      expectedHost: route.startsWith("/marketing/")
        ? "marketing"
        : route === "/pay/renew"
          ? "app"
          : "platform_or_tenant",
      authModel: route.startsWith("/api/webhooks/") ? "signed_webhook" : "public_bounded",
    };
  }

  if (route === "/api/leads" || route === "/api/events" || route === "/api/abuse-report") {
    return {
      category: "public_tenant_api",
      tenantScoped: true,
      expectedHost: "tenant",
      authModel: "verified_host_public_post",
    };
  }

  // Fail closed: NEVER allow any unknown `/api/**` path to silently fall through to `public_tenant_route`!
  if (route === "/api" || route.startsWith("/api/")) {
    return {
      category: "unclassified_api",
      tenantScoped: false,
      expectedHost: "unknown",
      authModel: "unclassified",
    };
  }

  if (route === "/marketing" || route.startsWith("/marketing/")) {
    return {
      category: "public_marketing_route",
      tenantScoped: false,
      expectedHost: "marketing",
      authModel: "public",
    };
  }

  return {
    category: "public_tenant_route",
    tenantScoped: true,
    expectedHost: "tenant",
    authModel: "verified_host_public",
  };
}

function extractStringArrayConst(source, constName) {
  const re = new RegExp(`export\\s+const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s*const`, "m");
  const match = re.exec(source);
  if (!match || !match[1]) {
    throw new Error(`Could not locate constant array ${constName}`);
  }
  const items = [];
  for (const m of match[1].matchAll(/["']([^"']+)["']/g)) {
    if (m[1]) items.push(m[1]);
  }
  return items;
}

function enumerateMcpTools() {
  const src = fs.readFileSync(MCP_CONSTANTS_PATH, "utf8");
  const readTools = extractStringArrayConst(src, "MCP_ALLOWED_READ_TOOLS");
  const writeDraftTools = extractStringArrayConst(src, "MCP_ALLOWED_WRITE_DRAFT_TOOLS");
  const publishRequestTools = extractStringArrayConst(src, "MCP_ALLOWED_PUBLISH_REQUEST_TOOLS");
  const leadsTools = extractStringArrayConst(src, "MCP_ALLOWED_LEADS_TOOLS");
  const excludedTools = extractStringArrayConst(src, "MCP_EXCLUDED_TOOLS");

  const allowed = [
    ...readTools.map((name) => ({ name, scope: "content:read", group: "read" })),
    ...writeDraftTools.map((name) => ({ name, scope: "content:write_draft", group: "write_draft" })),
    ...publishRequestTools.map((name) => ({
      name,
      scope: "content:publish_request",
      group: "publish_request",
    })),
    ...leadsTools.map((name) => ({ name, scope: "leads:read", group: "leads_read" })),
  ];

  return {
    source: "packages/core/src/mcp/constants.ts",
    allowed,
    excluded: [...excludedTools].sort(),
  };
}

function enumerateMiddlewareOAuthRoutes() {
  const src = fs.readFileSync(MCP_OAUTH_MIDDLEWARE_PATH, "utf8");
  const fnMatch = /export\s+function\s+isMcpOAuthHandledPath[\s\S]*?return\s*\(([\s\S]*?)\);/m.exec(src);
  if (!fnMatch || !fnMatch[1]) {
    throw new Error("Could not extract isMcpOAuthHandledPath routes from mcp-oauth.ts");
  }
  const routes = [];
  for (const m of fnMatch[1].matchAll(/pathnameLower\s*===\s*["']([^"']+)["']/g)) {
    if (m[1]) routes.push(m[1]);
  }
  return routes.sort().map((route) => ({
    route,
    file: "apps/web/src/middleware/mcp-oauth.ts",
    kind: "middleware_endpoint",
    methods: route.startsWith("/.well-known/")
      ? ["GET", "HEAD"]
      : route === "/oauth2/authorize"
        ? ["GET"]
        : ["POST"],
    ...classifyRoute(route, "endpoint"),
  }));
}

function enumeratePlugins() {
  const registrySrc = fs.readFileSync(PLUGIN_REGISTRY_PATH, "utf8");
  const importMap = new Map();
  for (const m of registrySrc.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const relImport = m[2];
    const resolved = path.resolve(path.dirname(PLUGIN_REGISTRY_PATH), relImport);
    const repoRel = path.relative(REPO_ROOT, resolved).replace(/\\/g, "/");
    for (const name of names) {
      importMap.set(name, repoRel);
    }
  }

  const arrayMatch =
    /export\s+const\s+REGISTERED_FIRST_PARTY_PLUGINS[\s\S]*?=\s*\[([\s\S]*?)\]\s*as\s*const/m.exec(
      registrySrc,
    );
  if (!arrayMatch || !arrayMatch[1]) {
    throw new Error("Could not locate REGISTERED_FIRST_PARTY_PLUGINS");
  }

  const symbols = arrayMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return symbols
    .map((sym) => {
      const entryFile = importMap.get(sym);
      if (!entryFile) {
        throw new Error(`Unresolved plugin symbol ${sym} in plugin-registry.ts`);
      }
      const pluginSrc = fs.readFileSync(path.join(REPO_ROOT, entryFile), "utf8");
      const idMatch =
        /PLUGIN_ID\s*=\s*["']([a-z0-9-]+)["']/.exec(pluginSrc) ??
        /manifest:\s*\{[\s\S]*?\bid:\s*["']([a-z0-9-]+)["']/.exec(pluginSrc);
      const id = idMatch?.[1] ?? path.basename(path.dirname(entryFile));

      const publicRoutes = [];
      const publicRoutesBlock = /publicRoutes:\s*\[([\s\S]*?)\]/m.exec(pluginSrc);
      if (publicRoutesBlock && publicRoutesBlock[1]) {
        for (const rm of publicRoutesBlock[1].matchAll(/\bpath:\s*["']([^"']+)["']/g)) {
          if (rm[1]) publicRoutes.push(rm[1]);
        }
      }

      const hasWebhook = /\bhasWebhook:\s*true\b/.test(pluginSrc);
      const hasAdminApi = /\bapiHandler\b/.test(pluginSrc) || /\bhasAdminApi:\s*true\b/.test(pluginSrc);

      return {
        id,
        symbol: sym,
        entryFile,
        publicRoutes: [...new Set(publicRoutes)].sort(),
        hasAdminApi,
        hasWebhook,
        adminApiRoute: `/api/tenants/[tenantId]/plugins/${id}/[...subpath]`,
        webhookRoute: hasWebhook ? `/api/plugins/${id}/webhook` : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function enumerateAllSurfaces() {
  const allFiles = walkFiles(PAGES_DIR).sort();
  const routes = [];

  for (const absPath of allFiles) {
    const relFromPages = path.relative(PAGES_DIR, absPath).replace(/\\/g, "/");
    const relFromRepo = path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");

    if (isPrivateAstroSegment(relFromPages)) continue;

    if (relFromPages.endsWith(".astro")) {
      const route = filePathToRoutePattern(relFromPages);
      routes.push({
        route,
        file: relFromRepo,
        kind: "page",
        methods: ["GET"],
        ...classifyRoute(route, "page"),
      });
      continue;
    }

    const ext = path.extname(relFromPages);
    if (ENDPOINT_EXTS.has(ext)) {
      const src = fs.readFileSync(absPath, "utf8");
      const methods = extractHttpMethods(src);
      if (methods.length === 0) {
        continue;
      }
      const route = filePathToRoutePattern(relFromPages);
      routes.push({
        route,
        file: relFromRepo,
        kind: "endpoint",
        methods,
        ...classifyRoute(route, "endpoint"),
      });
    }
  }

  for (const oauthRoute of enumerateMiddlewareOAuthRoutes()) {
    routes.push(oauthRoute);
  }

  routes.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file));

  const mcpTools = enumerateMcpTools();
  const plugins = enumeratePlugins();

  const countsByCategory = {};
  for (const r of routes) {
    countsByCategory[r.category] = (countsByCategory[r.category] ?? 0) + 1;
  }

  return {
    schemaVersion: "1.0",
    generatedBy: "scripts/security/enumerate-surfaces.mjs",
    summary: {
      totalRoutes: routes.length,
      countsByCategory,
      mcpAllowedToolCount: mcpTools.allowed.length,
      mcpExcludedToolCount: mcpTools.excluded.length,
      registeredPluginCount: plugins.length,
    },
    routes,
    mcpTools,
    plugins,
  };
}

export function compareInventories(actual, recorded) {
  const diffs = [];

  for (const r of actual.routes) {
    if (r.category === "unclassified_api") {
      diffs.push(`UNCLASSIFIED_API_ROUTE: ${r.route} (${r.file})`);
    }
  }

  const actualRouteKeys = new Map(actual.routes.map((r) => [`${r.route}::${r.file}`, r]));
  const recordedRouteKeys = new Map((recorded.routes ?? []).map((r) => [`${r.route}::${r.file}`, r]));

  for (const [key, r] of actualRouteKeys) {
    if (!recordedRouteKeys.has(key)) {
      diffs.push(`MISSING_ROUTE_IN_INVENTORY: ${r.route} (${r.file}) [${r.category}]`);
    } else {
      const rec = recordedRouteKeys.get(key);
      if (rec.category !== r.category || rec.tenantScoped !== r.tenantScoped) {
        diffs.push(
          `CHANGED_ROUTE_CLASSIFICATION: ${r.route} (${r.file}) actual=${r.category}/${r.tenantScoped} recorded=${rec.category}/${rec.tenantScoped}`,
        );
      }
      if (JSON.stringify(rec.methods) !== JSON.stringify(r.methods)) {
        diffs.push(
          `CHANGED_ROUTE_METHODS: ${r.route} (${r.file}) actual=${JSON.stringify(r.methods)} recorded=${JSON.stringify(rec.methods)}`,
        );
      }
    }
  }

  for (const [key, r] of recordedRouteKeys) {
    if (!actualRouteKeys.has(key)) {
      diffs.push(`STALE_ROUTE_IN_INVENTORY: ${r.route} (${r.file})`);
    }
  }

  const actualMcp = new Set(actual.mcpTools.allowed.map((t) => `${t.name}:${t.scope}`));
  const recordedMcp = new Set((recorded.mcpTools?.allowed ?? []).map((t) => `${t.name}:${t.scope}`));
  for (const item of actualMcp) {
    if (!recordedMcp.has(item)) diffs.push(`MISSING_MCP_TOOL_IN_INVENTORY: ${item}`);
  }
  for (const item of recordedMcp) {
    if (!actualMcp.has(item)) diffs.push(`STALE_MCP_TOOL_IN_INVENTORY: ${item}`);
  }

  const actualPlugins = new Set(actual.plugins.map((p) => p.id));
  const recordedPlugins = new Set((recorded.plugins ?? []).map((p) => p.id));
  for (const id of actualPlugins) {
    if (!recordedPlugins.has(id)) diffs.push(`MISSING_PLUGIN_IN_INVENTORY: ${id}`);
  }
  for (const id of recordedPlugins) {
    if (!actualPlugins.has(id)) diffs.push(`STALE_PLUGIN_IN_INVENTORY: ${id}`);
  }

  return diffs;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const actual = enumerateAllSurfaces();

  if (args.has("--json")) {
    console.log(JSON.stringify(actual, null, 2));
    return;
  }

  if (args.has("--write")) {
    fs.mkdirSync(path.dirname(INVENTORY_PATH), { recursive: true });
    fs.writeFileSync(INVENTORY_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    console.log(
      `WROTE ${path.relative(REPO_ROOT, INVENTORY_PATH)}: ${actual.summary.totalRoutes} routes, ${actual.summary.mcpAllowedToolCount} allowed MCP tools, ${actual.summary.registeredPluginCount} plugins`,
    );
    return;
  }

  if (!fs.existsSync(INVENTORY_PATH)) {
    console.error(
      `FAIL: Missing surface inventory at ${path.relative(REPO_ROOT, INVENTORY_PATH)}. Run --write first.`,
    );
    process.exit(1);
  }

  const recorded = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf8"));
  const diffs = compareInventories(actual, recorded);

  if (diffs.length > 0) {
    console.error(`FAIL: Surface inventory drift detected (${diffs.length} discrepancies):`);
    for (const d of diffs) {
      console.error(`  - ${d}`);
    }
    process.exit(1);
  }

  console.log(
    `PASS: Surface inventory matches repository on disk (${actual.summary.totalRoutes} routes, ${actual.summary.mcpAllowedToolCount} allowed MCP tools, ${actual.summary.mcpExcludedToolCount} excluded MCP tools, ${actual.summary.registeredPluginCount} plugins).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
