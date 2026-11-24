import type { CloudflareImagesBinding } from "@punyasitus/core/media/index";
import {
  definePlugin,
  readBoundedRequestBody,
  type PluginDefinition,
  type PluginManifest,
  type PluginMigrationDescriptor,
} from "@punyasitus/core/plugins/index";
import {
  resolveDefaultRuntimeBindings,
  type WorkersRuntimeEnvLike,
} from "./src/adapters.ts";
import {
  executeWpImport,
  getWpImportJobDetail,
  listWpFormerUrls,
  listWpImportJobs,
} from "./src/importer.ts";
import {
  WP_IMPORTER_LIMITS,
  WP_IMPORTER_PLUGIN_ID,
  WP_IMPORTER_TABLE_PREFIX,
  WpImporterError,
  type WpImporterCmsWriterPort,
  type WpImporterFetchPort,
  type WpImporterMediaStoragePort,
  type WpImporterWebpEncoderPort,
} from "./src/types.ts";

export * from "./src/types.ts";
export * from "./src/adapters.ts";
export * from "./src/ssrf.ts";
export * from "./src/tiptap.ts";
export * from "./src/wxr.ts";
export * from "./src/wp-json.ts";
export * from "./src/media.ts";
export * from "./src/importer.ts";

/**
 * Official First-Party `public_free` Plugin: `wp-importer`
 * (`TASK-100`, `REQ-100`, `DEC-038`, `ADR-0010`, `PLAN §19.7`).
 *
 * - Strictly isolated to `packages/plugins/wp-importer/**` (ZERO edits to Frozen Core CMS).
 * - Additive plugin-owned SQLite tables strictly prefixed `plg_wp_importer__*`.
 * - Imports WordPress `/wp-json/wp/v2` or uploaded WXR XML exclusively into unpublished
 *   `draft` posts with sanitized TipTap JSON, categories/tags, public SEO metadata,
 *   SSRF-checked & WebP-normalized R2 images inside website storage quota, and a
 *   former-URL inventory for redirect review.
 * - Zero public JS overhead (`maxPublicJsBytes: 0`).
 * - NOT active by default on new websites (installed on demand via `Plugin -> Gratis`).
 */

export interface WpImporterPluginConfig {
  readonly defaultMaxPosts: number;
  readonly importImagesByDefault: boolean;
}

const ALLOWED_CONFIG_KEYS = new Set(["defaultMaxPosts", "importImagesByDefault"]);

export const WpImporterPluginConfigSchema = {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: WpImporterPluginConfig }
    | { readonly success: false; readonly error: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false, error: "Konfigurasi harus berupa objek JSON." };
    }
    const obj = input as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return { success: false, error: `Field konfigurasi tidak dikenal: ${key}` };
      }
    }
    const rawMax = obj.defaultMaxPosts ?? 50;
    if (
      typeof rawMax !== "number" ||
      !Number.isInteger(rawMax) ||
      rawMax < 1 ||
      rawMax > WP_IMPORTER_LIMITS.maxImportPosts
    ) {
      return {
        success: false,
        error: `defaultMaxPosts harus bilangan bulat 1..${WP_IMPORTER_LIMITS.maxImportPosts}.`,
      };
    }
    const rawImportImages = obj.importImagesByDefault ?? true;
    if (typeof rawImportImages !== "boolean") {
      return { success: false, error: "importImagesByDefault harus boolean." };
    }
    return {
      success: true,
      data: {
        defaultMaxPosts: rawMax,
        importImagesByDefault: rawImportImages,
      },
    };
  },
};

interface ParsedImportActionPayload {
  readonly sourceKind: "wp_json" | "wxr";
  readonly siteUrl?: string;
  readonly wxrXml?: string;
  readonly importImages?: boolean;
  readonly maxPosts?: number;
}

// Strict allowlist: client callers may NEVER pass `allowHttp` to weaken the HTTPS-only SSRF default!
const ALLOWED_ACTION_KEYS = new Set([
  "sourceKind",
  "siteUrl",
  "wxrXml",
  "importImages",
  "maxPosts",
]);

function parseImportActionPayload(
  input: unknown,
):
  | { readonly success: true; readonly data: ParsedImportActionPayload }
  | { readonly success: false; readonly issues: readonly { readonly path: string; readonly message: string }[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      success: false,
      issues: [{ path: "", message: "Payload harus berupa objek JSON." }],
    };
  }
  const obj = input as Record<string, unknown>;
  const issues: { readonly path: string; readonly message: string }[] = [];

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ACTION_KEYS.has(key)) {
      issues.push({ path: key, message: `Field tidak diizinkan: ${key}` });
    }
  }

  const sourceKind = obj.sourceKind;
  if (sourceKind !== "wp_json" && sourceKind !== "wxr") {
    issues.push({ path: "sourceKind", message: "sourceKind harus 'wp_json' atau 'wxr'." });
  }

  if (obj.siteUrl !== undefined) {
    if (typeof obj.siteUrl !== "string" || obj.siteUrl.trim().length > 2048) {
      issues.push({ path: "siteUrl", message: "siteUrl harus string maksimal 2048 karakter." });
    }
  }
  if (obj.wxrXml !== undefined) {
    if (typeof obj.wxrXml !== "string" || obj.wxrXml.length > WP_IMPORTER_LIMITS.maxWxrBytes + 1024) {
      issues.push({ path: "wxrXml", message: "wxrXml harus string dalam batas ukuran maksimal." });
    }
  }
  if (obj.importImages !== undefined && typeof obj.importImages !== "boolean") {
    issues.push({ path: "importImages", message: "importImages harus boolean." });
  }
  if (obj.maxPosts !== undefined) {
    if (
      typeof obj.maxPosts !== "number" ||
      !Number.isInteger(obj.maxPosts) ||
      obj.maxPosts < 1 ||
      obj.maxPosts > WP_IMPORTER_LIMITS.maxImportPosts
    ) {
      issues.push({
        path: "maxPosts",
        message: `maxPosts harus bilangan bulat 1..${WP_IMPORTER_LIMITS.maxImportPosts}.`,
      });
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: {
      sourceKind: sourceKind as "wp_json" | "wxr",
      ...(typeof obj.siteUrl === "string" ? { siteUrl: obj.siteUrl.trim() } : {}),
      ...(typeof obj.wxrXml === "string" ? { wxrXml: obj.wxrXml } : {}),
      ...(typeof obj.importImages === "boolean" ? { importImages: obj.importImages } : {}),
      ...(typeof obj.maxPosts === "number" ? { maxPosts: obj.maxPosts } : {}),
    },
  };
}

export const WP_IMPORTER_MIGRATIONS: readonly PluginMigrationDescriptor[] = [
  {
    version: 1,
    name: "0001_wp_importer_tables",
    sql: `CREATE TABLE IF NOT EXISTS plg_wp_importer__jobs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_label TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  posts_found INTEGER NOT NULL DEFAULT 0,
  posts_imported INTEGER NOT NULL DEFAULT 0,
  posts_skipped INTEGER NOT NULL DEFAULT 0,
  categories_imported INTEGER NOT NULL DEFAULT 0,
  tags_imported INTEGER NOT NULL DEFAULT 0,
  images_imported INTEGER NOT NULL DEFAULT 0,
  images_skipped INTEGER NOT NULL DEFAULT 0,
  bytes_imported INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS plg_wp_importer__idx_jobs_created
  ON plg_wp_importer__jobs (created_at DESC);
CREATE TABLE IF NOT EXISTS plg_wp_importer__url_map (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES plg_wp_importer__jobs(id),
  source_url TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  target_slug TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_post_id INTEGER,
  source_status TEXT NOT NULL,
  imported_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plg_wp_importer__idx_url_map_job
  ON plg_wp_importer__url_map (job_id, created_at DESC);
CREATE TABLE IF NOT EXISTS plg_wp_importer__staged_drafts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES plg_wp_importer__jobs(id),
  source_id TEXT,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  body_json TEXT NOT NULL,
  seo_json TEXT,
  categories_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  media_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plg_wp_importer__idx_staged_drafts_job
  ON plg_wp_importer__staged_drafts (job_id, created_at DESC);`,
  },
] as const;

export const WP_IMPORTER_MANIFEST: PluginManifest = {
  id: WP_IMPORTER_PLUGIN_ID,
  name: "WordPress Importer",
  description:
    "Impor artikel blog, kategori, tag, metadata SEO, dan gambar WebP secara aman dari WordPress (/wp-json atau WXR XML) langsung sebagai Draf tanpa pernah tayang otomatis.",
  version: "1.0.0",
  visibility: "public_free",
  billingCycle: "free",
  priceIdr: 0,
  tablePrefix: WP_IMPORTER_TABLE_PREFIX,
  permissions: ["tenant_db:plg_tables", "admin:page", "admin:api"],
  maxPublicJsBytes: 0,
  slots: {
    hasMigrations: true,
    publicSections: [],
    publicRoutes: [],
    hasAdminPage: true,
    hasAdminApi: true,
    queueHooks: [],
    hasWebhook: false,
    mcpTools: [],
  },
  defaultConfig: {
    defaultMaxPosts: 50,
    importImagesByDefault: true,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Response {
  return jsonResponse(status, {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

export interface CreateWpImporterPluginDeps {
  readonly fetchImpl?: WpImporterFetchPort;
  readonly imagesBinding?: CloudflareImagesBinding | null;
  readonly webpEncoder?: WpImporterWebpEncoderPort;
  readonly resolveMediaPort?: (tenantId: string) => WpImporterMediaStoragePort | undefined;
  readonly resolveCmsWriter?: (tenantId: string) => WpImporterCmsWriterPort | undefined;
  readonly runtimeEnv?: WorkersRuntimeEnvLike | null;
  /** Server-only option (NEVER exposed to API callers). Defaults to `false` (HTTPS only). */
  readonly allowHttp?: boolean;
  readonly allowStagedFallback?: boolean;
}

/**
 * Factory creating the `wp-importer` `PluginDefinition` with optional injected
 * network/storage/CMS writer adapters (used in tests and runtime bindings).
 */
export function createWpImporterPlugin(
  pluginDeps: CreateWpImporterPluginDeps = {},
): PluginDefinition {
  return definePlugin({
    manifest: WP_IMPORTER_MANIFEST,
    migrations: WP_IMPORTER_MIGRATIONS,
    adminSlots: {
      configSchema: {
        safeParse(input: unknown) {
          const parsed = WpImporterPluginConfigSchema.safeParse(input);
          if (!parsed.success) {
            return { success: false as const, error: parsed.error };
          }
          return { success: true as const, data: { ...parsed.data } };
        },
      },
      configFields: [
        {
          key: "defaultMaxPosts",
          label: "Batas Artikel per Impor",
          description: "Jumlah maksimal artikel yang diambil dalam satu sesi impor (1–100).",
          kind: "number",
          placeholder: "50",
        },
        {
          key: "importImagesByDefault",
          label: "Impor & normalisasi gambar ke WebP secara bawaan",
          description:
            "Setiap gambar diverifikasi SSRF & magic-byte lalu dinormalisasi ke WebP dalam kuota penyimpanan situs.",
          kind: "boolean",
        },
      ],
      async loadState({ db, config }) {
        try {
          const jobs = await listWpImportJobs(db, 10);
          const formerUrls = await listWpFormerUrls(db, { limit: 25 });
          return {
            draftOnlyEnforced: true,
            totalJobs: jobs.length,
            lastJobId: jobs[0]?.id ?? null,
            lastJobStatus: jobs[0]?.status ?? null,
            formerUrlCount: formerUrls.length,
            defaultMaxPosts: Number(config.defaultMaxPosts ?? 50),
            importImagesByDefault: config.importImagesByDefault !== false,
            jobs,
            formerUrls,
          };
        } catch {
          return {
            draftOnlyEnforced: true,
            totalJobs: 0,
            lastJobId: null,
            lastJobStatus: null,
            formerUrlCount: 0,
            defaultMaxPosts: Number(config.defaultMaxPosts ?? 50),
            importImagesByDefault: config.importImagesByDefault !== false,
            jobs: [],
            formerUrls: [],
          };
        }
      },
      async apiHandler({ request, subPath, db, config, tenant, actorUserId, nowMs }) {
        const method = request.method.toUpperCase();
        const cleanPath = subPath.replace(/^\/+|\/+$/g, "");
        const lowerPath = cleanPath.toLowerCase();

        // GET /status
        if (lowerPath === "status" && method === "GET") {
          const jobs = await listWpImportJobs(db, 5);
          return jsonResponse(200, {
            pluginId: WP_IMPORTER_PLUGIN_ID,
            tenantId: tenant.id,
            draftOnlyEnforced: true,
            limits: WP_IMPORTER_LIMITS,
            recentJobs: jobs,
          });
        }

        // GET /jobs
        if (lowerPath === "jobs" && method === "GET") {
          const url = new URL(request.url);
          const limit = Number(url.searchParams.get("limit") ?? "20");
          const jobs = await listWpImportJobs(db, Number.isFinite(limit) ? limit : 20);
          return jsonResponse(200, { jobs });
        }

        // GET /jobs/:jobId
        if (lowerPath.startsWith("jobs/") && method === "GET") {
          const jobId = cleanPath.slice("jobs/".length).trim();
          if (!jobId) {
            return errorResponse(404, "NOT_FOUND", "ID pekerjaan impor tidak ditemukan.");
          }
          const detail = await getWpImportJobDetail(db, jobId);
          if (!detail) {
            return errorResponse(404, "NOT_FOUND", "Riwayat impor tidak ditemukan.");
          }
          return jsonResponse(200, detail);
        }

        // GET /url-map
        if (lowerPath === "url-map" && method === "GET") {
          const url = new URL(request.url);
          const jobId = url.searchParams.get("jobId")?.trim() || undefined;
          const limit = Number(url.searchParams.get("limit") ?? "100");
          const items = await listWpFormerUrls(db, {
            jobId,
            limit: Number.isFinite(limit) ? limit : 100,
          });
          return jsonResponse(200, { items });
        }

        // POST /dry-run or POST /import
        if ((lowerPath === "dry-run" || lowerPath === "import") && method === "POST") {
          const mode = lowerPath === "import" ? "import" : "dry_run";
          const maxBodyBytes = WP_IMPORTER_LIMITS.maxWxrBytes + 128 * 1024;
          const bodyRead = await readBoundedRequestBody(request, maxBodyBytes);
          if (!bodyRead.ok) {
            if (bodyRead.reason === "too_large") {
              return errorResponse(
                413,
                "WXR_TOO_LARGE",
                `Ukuran payload impor melebihi batas maksimal ${WP_IMPORTER_LIMITS.maxWxrBytes} byte.`,
              );
            }
            return errorResponse(400, "VALIDATION_ERROR", "Gagal membaca isi permintaan impor.");
          }

          let rawJson: unknown;
          try {
            rawJson = JSON.parse(bodyRead.text || "{}");
          } catch {
            return errorResponse(400, "VALIDATION_ERROR", "Isi permintaan harus berupa JSON valid.");
          }

          const parsed = parseImportActionPayload(rawJson);
          if (!parsed.success) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "Parameter impor WordPress tidak valid.",
              { issues: parsed.issues },
            );
          }

          const defaultMaxPosts =
            typeof config.defaultMaxPosts === "number" && Number.isFinite(config.defaultMaxPosts)
              ? config.defaultMaxPosts
              : 50;
          const defaultImportImages = config.importImagesByDefault !== false;

          try {
            const needsDefaultBindings =
              !pluginDeps.resolveCmsWriter ||
              !pluginDeps.resolveMediaPort ||
              pluginDeps.imagesBinding === undefined;
            const defaultBindings = needsDefaultBindings
              ? await resolveDefaultRuntimeBindings({
                  tenantId: tenant.id,
                  tenantStatus: tenant.status,
                  actorUserId,
                  nowMs,
                  runtimeEnv: pluginDeps.runtimeEnv,
                })
              : null;

            const cmsWriter = pluginDeps.resolveCmsWriter
              ? pluginDeps.resolveCmsWriter(tenant.id)
              : defaultBindings?.cmsWriter;
            const mediaPort = pluginDeps.resolveMediaPort
              ? pluginDeps.resolveMediaPort(tenant.id)
              : defaultBindings?.mediaPort;
            const imagesBinding =
              pluginDeps.imagesBinding !== undefined
                ? pluginDeps.imagesBinding
                : (defaultBindings?.imagesBinding ?? null);

            const report = await executeWpImport(
              {
                mode,
                sourceKind: parsed.data.sourceKind,
                siteUrl: parsed.data.siteUrl,
                wxrXml: parsed.data.wxrXml,
                importImages: parsed.data.importImages ?? defaultImportImages,
                maxPosts: parsed.data.maxPosts ?? defaultMaxPosts,
                allowHttp: pluginDeps.allowHttp === true,
              },
              {
                tenant,
                actorUserId,
                db,
                fetchImpl: pluginDeps.fetchImpl,
                imagesBinding,
                webpEncoder: pluginDeps.webpEncoder,
                mediaPort,
                cmsWriter,
                allowStagedFallback: pluginDeps.allowStagedFallback === true,
                nowMs,
              },
            );

            return jsonResponse(200, { report });
          } catch (err) {
            if (err instanceof WpImporterError) {
              return errorResponse(err.status, err.code, err.message, err.details);
            }
            return errorResponse(
              500,
              "IMPORT_FAILED",
              err instanceof Error ? err.message : "Terjadi kendala saat menjalankan impor WordPress.",
            );
          }
        }

        return errorResponse(
          404,
          "NOT_FOUND",
          "Endpoint plugin wp-importer tidak ditemukan.",
        );
      },
    },
  });
}

export const WP_IMPORTER_PLUGIN: PluginDefinition = createWpImporterPlugin();
