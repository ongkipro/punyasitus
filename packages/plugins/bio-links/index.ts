import {
  definePlugin,
  type PluginDefinition,
  type PluginManifest,
} from "@punyasitus/core/plugins/index";
import { BIO_LINKS_MIGRATIONS } from "./src/migrations.ts";
import { renderBioLinkGoHandoffHtml, renderBioLinksPublicHtml } from "./src/render.ts";
import {
  createBioLink,
  deleteBioLink,
  getBioLinkStats,
  getBioLinksProfile,
  handleBioLinkClickRedirect,
  isNonCountingBioRequest,
  listBioLinks,
  recordBioLinkClick,
  reorderBioLinks,
  updateBioLink,
  upsertBioLinksProfile,
} from "./src/service.ts";
import {
  BIO_LINKS_DEFAULT_ACCENT,
  BioLinksConfigSchema,
  BioLinksValidationError,
  DEFAULT_BIO_LINKS_CONFIG,
  isValidBioLinkId,
} from "./src/validation.ts";

export * from "./src/migrations.ts";
export * from "./src/render.ts";
export * from "./src/service.ts";
export * from "./src/validation.ts";

/**
 * Official First-Party `public_free` Seed Plugin: `bio-links`
 * (`REQ-099`, `ADR-0010`, `PLAN §19.7`, `TASK-099`).
 *
 * - Strictly isolated to `plg_bio_links__*` tables in `TenantStore`.
 * - Zero edits to Frozen Core CMS packages.
 * - Serves `/link` with strictly ZERO (`0`) bytes client JavaScript.
 * - First-party click tracking with strict tenant-owned link lookup (zero open redirects, zero PII).
 */

export const BIO_LINKS_PLUGIN_ID = "bio-links" as const;
export const BIO_LINKS_TABLE_PREFIX = "plg_bio_links__" as const;

export const BIO_LINKS_MANIFEST: PluginManifest = {
  id: BIO_LINKS_PLUGIN_ID,
  name: "Bio Links (/link)",
  description:
    "Halaman /link untuk profil, katalog, dan tautan sosial dengan penghitung klik pihak pertama tanpa JS publik.",
  version: "1.0.0",
  visibility: "public_free",
  billingCycle: "free",
  priceIdr: 0,
  tablePrefix: BIO_LINKS_TABLE_PREFIX,
  permissions: ["tenant_db:plg_tables", "public:route", "admin:page", "admin:api"],
  maxPublicJsBytes: 0,
  slots: {
    hasMigrations: true,
    publicSections: [],
    publicRoutes: [
      {
        path: "/link",
        maxJsBytes: 0,
        description: "Halaman tautan bio 0-JS pada domain situs",
      },
      {
        path: "/link/go",
        maxJsBytes: 0,
        description: "Penghitung klik pihak pertama dan tujuan tautan bio terverifikasi",
      },
    ],
    hasAdminPage: true,
    hasAdminApi: true,
    queueHooks: [],
    hasWebhook: false,
    mcpTools: [],
  },
  defaultConfig: {
    ...DEFAULT_BIO_LINKS_CONFIG,
  },
};

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow",
        ...extraHeaders,
      },
    },
  );
}

function jsonOk(payload: Record<string, unknown>, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const BIO_LINKS_PLUGIN: PluginDefinition = definePlugin({
  manifest: BIO_LINKS_MANIFEST,
  migrations: BIO_LINKS_MIGRATIONS,

  publicSlots: {
    routes: {
      "/link": async ({ tenant, config, db }) => {
        const [profile, items] = await Promise.all([
          getBioLinksProfile(db, tenant, config),
          listBioLinks(db, { activeOnly: true }),
        ]);
        const rendered = renderBioLinksPublicHtml({
          tenant,
          profile,
          items,
          clickPathPrefix: "/link/go",
        });
        return {
          status: 200,
          title: rendered.title,
          description: rendered.description,
          html: rendered.html,
          cssBytes: rendered.cssBytes,
          jsBytes: 0,
          headers: {
            "X-Plugin-Version": BIO_LINKS_MANIFEST.version,
          },
        };
      },

      "/link/go": async ({ tenant, request, db }) => {
        const url = new URL(request.url);
        // Reject open-redirect smuggling parameters
        if (
          url.searchParams.has("url") ||
          url.searchParams.has("target") ||
          url.searchParams.has("next") ||
          url.searchParams.has("redirect")
        ) {
          return {
            status: 400,
            title: "Permintaan Tidak Valid",
            html: `<div data-testid="bio-link-go-error"><h1>Permintaan tidak valid</h1><p>Parameter pengalihan eksternal ditolak.</p><a href="/link">Kembali ke halaman tautan</a></div>`,
            cssBytes: 0,
            jsBytes: 0,
          };
        }

        const linkId = (url.searchParams.get("id") ?? "").trim().toLowerCase();
        const recorded = await recordBioLinkClick(db, linkId, Date.now(), {
          skipCount: isNonCountingBioRequest(request),
        });
        if (!recorded.ok) {
          return {
            status: 404,
            title: "Tautan Tidak Ditemukan",
            html: `<div data-testid="bio-link-go-not-found"><h1>Tautan tidak ditemukan</h1><p>Tautan bio ini tidak tersedia atau sudah dinonaktifkan.</p><a href="/link">Kembali ke halaman tautan</a></div>`,
            cssBytes: 0,
            jsBytes: 0,
          };
        }

        const handoff = renderBioLinkGoHandoffHtml({
          label: recorded.label,
          targetUrl: recorded.targetUrl,
          tenantName: tenant.name,
        });
        return {
          status: 200,
          title: recorded.label,
          description: `Lanjutkan ke ${recorded.label}`,
          html: handoff.html,
          cssBytes: handoff.cssBytes,
          jsBytes: 0,
          headers: {
            "X-Plugin-Version": BIO_LINKS_MANIFEST.version,
          },
        };
      },
    },
  },

  adminSlots: {
    configSchema: BioLinksConfigSchema,
    configFields: [
      {
        key: "displayName",
        label: "Nama Tampilan Bio",
        description: "Nama bisnis atau personal branding yang tampil di bagian atas halaman /link.",
        kind: "text",
        placeholder: "Contoh: Budi Santoso — Konsultan Properti",
      },
      {
        key: "headline",
        label: "Tagline Singkat",
        description: "Keterangan singkat di bawah nama tampilan (maks. 160 karakter).",
        kind: "text",
        placeholder: "Solusi properti terpercaya area Jabodetabek",
      },
      {
        key: "themeAccent",
        label: "Warna Aksen (Hex)",
        description: "Kode warna hex 6 digit untuk tombol dan aksen kartu bio.",
        kind: "text",
        placeholder: BIO_LINKS_DEFAULT_ACCENT,
      },
      {
        key: "whatsappPhone",
        label: "Nomor WhatsApp Bio (Opsional)",
        description: "Format Indonesia (08... atau +628...) untuk tombol WhatsApp di halaman /link.",
        kind: "text",
        placeholder: "081234567890",
      },
      {
        key: "showWhatsappButton",
        label: "Tampilkan tombol WhatsApp di /link",
        description: "Menampilkan tombol CTA WhatsApp di bagian bawah daftar tautan bio.",
        kind: "boolean",
      },
    ],

    async loadState({ db, tenant, config }) {
      const [profile, stats] = await Promise.all([
        getBioLinksProfile(db, tenant, config),
        getBioLinkStats(db),
      ]);
      return {
        publicPath: "/link",
        displayName: profile.displayName,
        totalLinks: stats.totalLinks,
        activeLinks: stats.activeLinks,
        totalClicks: stats.totalClicks,
        publicJsBytes: 0,
      };
    },

    async apiHandler({ request, subPath, db, tenant, config, nowMs }) {
      const method = request.method.toUpperCase();
      const normalized = subPath.replace(/^\/+|\/+$/g, "");
      const segments = normalized.length > 0 ? normalized.split("/") : [];

      try {
        // GET /overview
        if ((normalized === "" || normalized === "overview") && method === "GET") {
          const [profile, links, stats] = await Promise.all([
            getBioLinksProfile(db, tenant, config),
            listBioLinks(db),
            getBioLinkStats(db),
          ]);
          return jsonOk({
            pluginId: BIO_LINKS_PLUGIN_ID,
            publicPath: "/link",
            publicJsBytes: 0,
            profile,
            links,
            stats,
          });
        }

        // GET /profile & PUT /profile
        if (normalized === "profile" && method === "GET") {
          const profile = await getBioLinksProfile(db, tenant, config);
          return jsonOk({ profile });
        }
        if (normalized === "profile" && (method === "PUT" || method === "PATCH")) {
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return jsonError(400, "VALIDATION_ERROR", "Body JSON profil tidak valid.");
          }
          const profile = await upsertBioLinksProfile(db, body, nowMs);
          return jsonOk({ profile });
        }

        // GET /links & POST /links
        if (normalized === "links" && method === "GET") {
          const links = await listBioLinks(db);
          return jsonOk({ links });
        }
        if (normalized === "links" && method === "POST") {
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return jsonError(400, "VALIDATION_ERROR", "Body JSON tautan tidak valid.");
          }
          const link = await createBioLink(db, body, nowMs);
          return jsonOk({ link }, 201);
        }

        // POST /links/reorder
        if (normalized === "links/reorder" && method === "POST") {
          const body = (await request.json().catch(() => null)) as {
            readonly orderedIds?: unknown;
          } | null;
          if (!body || !Array.isArray(body.orderedIds)) {
            return jsonError(422, "VALIDATION_ERROR", "Daftar orderedIds wajib berupa array.");
          }
          const ids = body.orderedIds.filter((v): v is string => typeof v === "string");
          const links = await reorderBioLinks(db, ids, nowMs);
          return jsonOk({ links });
        }

        // PATCH /links/:linkId & DELETE /links/:linkId
        if (segments.length === 2 && segments[0] === "links") {
          const linkId = segments[1]!.toLowerCase();
          if (!isValidBioLinkId(linkId)) {
            return jsonError(404, "NOT_FOUND", "Tautan bio tidak ditemukan.");
          }
          if (method === "PATCH") {
            const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return jsonError(400, "VALIDATION_ERROR", "Body JSON pembaruan tautan tidak valid.");
            }
            const updated = await updateBioLink(db, linkId, body, nowMs);
            if (!updated) {
              return jsonError(404, "NOT_FOUND", "Tautan bio tidak ditemukan.");
            }
            return jsonOk({ link: updated });
          }
          if (method === "DELETE") {
            const deleted = await deleteBioLink(db, linkId);
            if (!deleted) {
              return jsonError(404, "NOT_FOUND", "Tautan bio tidak ditemukan.");
            }
            return jsonOk({ deleted: true, id: linkId });
          }
        }

        // GET /stats
        if (normalized === "stats") {
          if (method !== "GET") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "GET",
            });
          }
          const stats = await getBioLinkStats(db);
          return jsonOk({ stats });
        }

        // POST /click ONLY on admin API (never state-changing GET)
        if (normalized === "click") {
          if (method !== "POST") {
            return jsonError(
              405,
              "METHOD_NOT_ALLOWED",
              "Gunakan metode POST untuk mencatat klik melalui API admin.",
              { Allow: "POST" },
            );
          }
          return handleBioLinkClickRedirect({ db, request, nowMs });
        }

        if (normalized === "" || normalized === "overview") {
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "GET",
          });
        }
        if (normalized === "profile") {
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "GET, PUT, PATCH",
          });
        }
        if (normalized === "links") {
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "GET, POST",
          });
        }
        if (normalized === "links/reorder") {
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "POST",
          });
        }
        if (segments.length === 2 && segments[0] === "links") {
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "PATCH, DELETE",
          });
        }

        return jsonError(404, "NOT_FOUND", "Endpoint plugin bio-links tidak ditemukan.");
      } catch (err) {
        if (err instanceof BioLinksValidationError) {
          return jsonError(422, err.code, err.message);
        }
        return jsonError(500, "INTERNAL_ERROR", "Terjadi kendala saat memproses permintaan bio-links.");
      }
    },
  },
});
