import {
  definePlugin,
  type PluginDefinition,
  type PluginManifest,
} from "@punyasitus/core/plugins/index";
import { WA_CS_ROTATOR_MIGRATIONS } from "./src/migrations.ts";
import {
  renderWaRotatorCtaSectionHtml,
  renderWaRotatorHandoffHtml,
  renderWaRotatorUnavailableHtml,
} from "./src/render.ts";
import { isAgentOnShift, selectNextWaAgent } from "./src/rotator.ts";
import {
  createWaAgent,
  deleteWaAgent,
  getRotatorState,
  getWaAttributionStats,
  isNonCountingWaRequest,
  listWaAgents,
  selectAndRecordWaRotation,
  updateRotatorSettings,
  updateWaAgent,
} from "./src/service.ts";
import {
  DEFAULT_WA_CS_ROTATOR_CONFIG,
  isValidAgentId,
  sanitizeSourcePath,
  sanitizeWaItemTitle,
  WA_CS_DEFAULT_TIMEZONE,
  WaCsRotatorConfigSchema,
  WaCsRotatorValidationError,
} from "./src/validation.ts";

export * from "./src/migrations.ts";
export * from "./src/render.ts";
export * from "./src/rotator.ts";
export * from "./src/service.ts";
export * from "./src/validation.ts";

/**
 * Official First-Party `public_paid` / Operator-Grantable Seed Plugin: `wa-cs-rotator`
 * (`REQ-099`, `REQ-014`, `REQ-040`, `ADR-0010`, `PLAN §19.7`, `TASK-099`).
 *
 * - Strictly isolated to `plg_wa_cs_rotator__*` tables in `TenantStore`.
 * - Zero edits to Frozen Core CMS packages.
 * - Multi-agent WhatsApp distribution supporting round-robin, Smooth Weighted Round-Robin,
 *   timezone-aware active-hour schedules (default `Asia/Jakarta` WIB), fallback to primary
 *   WhatsApp when all agents are off-shift, per-agent click attribution (zero PII),
 *   optimistic CAS cursor updates, and instant revert to single-number base WhatsApp
 *   (`REQ-014`) when disabled or unentitled.
 * - Public JS footprint: `0` bytes (`<= 25 KiB` cap).
 */

export const WA_CS_ROTATOR_PLUGIN_ID = "wa-cs-rotator" as const;
export const WA_CS_ROTATOR_TABLE_PREFIX = "plg_wa_cs_rotator__" as const;

export const WA_CS_ROTATOR_MANIFEST: PluginManifest = {
  id: WA_CS_ROTATOR_PLUGIN_ID,
  name: "WhatsApp CS Rotator",
  description:
    "Rotasi CTA WhatsApp ke banyak agen sales berdasarkan bobot, round-robin, dan jam aktif dengan statistik klik per agen.",
  version: "1.0.0",
  visibility: "public_paid",
  billingCycle: "paid_monthly",
  priceIdr: 49_000,
  tablePrefix: WA_CS_ROTATOR_TABLE_PREFIX,
  permissions: [
    "tenant_db:plg_tables",
    "public:section",
    "public:route",
    "admin:page",
    "admin:api",
  ],
  maxPublicJsBytes: 0,
  slots: {
    hasMigrations: true,
    publicSections: [
      {
        id: "wa-cs-rotator-cta",
        label: "Tombol WhatsApp CS Rotator",
        maxJsBytes: 0,
      },
    ],
    publicRoutes: [
      {
        path: "/wa-rotator",
        maxJsBytes: 0,
        description: "Rute distribusi klik WhatsApp CS multi-agen (0-JS)",
      },
    ],
    hasAdminPage: true,
    hasAdminApi: true,
    queueHooks: [],
    hasWebhook: false,
    mcpTools: [],
  },
  defaultConfig: {
    ...DEFAULT_WA_CS_ROTATOR_CONFIG,
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

export const WA_CS_ROTATOR_PLUGIN: PluginDefinition = definePlugin({
  manifest: WA_CS_ROTATOR_MANIFEST,
  migrations: WA_CS_ROTATOR_MIGRATIONS,

  publicSlots: {
    sections: {
      "wa-cs-rotator-cta": async ({ tenant, config, db, props }) => {
        const nowMs =
          typeof props.nowMs === "number" && Number.isFinite(props.nowMs)
            ? props.nowMs
            : Date.now();
        const agents = await listWaAgents(db);
        const onShiftCount = agents.filter((a) => isAgentOnShift(a, nowMs)).length;
        const ctaLabel =
          typeof props.ctaLabel === "string" && props.ctaLabel.trim().length > 0
            ? props.ctaLabel.trim()
            : typeof config.ctaLabel === "string" && config.ctaLabel.trim().length > 0
              ? config.ctaLabel.trim()
              : DEFAULT_WA_CS_ROTATOR_CONFIG.ctaLabel;
        const safeItem = sanitizeWaItemTitle(props.itemTitle);
        const item = safeItem ? `?item=${encodeURIComponent(safeItem)}` : "";

        return renderWaRotatorCtaSectionHtml({
          tenant,
          ctaLabel,
          onShiftCount,
          href: `/wa-rotator${item}`,
        });
      },
    },

    routes: {
      "/wa-rotator": async (ctx) => {
        const { tenant, request, config, db } = ctx;
        const reqUrl = new URL(request.url);
        const itemTitle = sanitizeWaItemTitle(reqUrl.searchParams.get("item"));
        const sourcePath = sanitizeSourcePath(reqUrl.searchParams.get("from") ?? "/");
        const pageUrl = tenant.primaryHost
          ? `https://${tenant.primaryHost}${sourcePath}`
          : `https://${tenant.handle}.situsku.click${sourcePath}`;
        const nonCounting = isNonCountingWaRequest(request);

        // Frozen-Core compliant extraction of optional host-provided primary WA & base tenantDb
        const extendedTenant = tenant as typeof tenant & {
          readonly whatsappE164?: unknown;
          readonly primaryWhatsappPhone?: unknown;
        };
        const extendedCtx = ctx as typeof ctx & {
          readonly tenantDb?: D1Database | null;
          readonly nowMs?: number;
        };
        const hostPrimaryWhatsappPhone =
          typeof extendedTenant.whatsappE164 === "string" &&
          extendedTenant.whatsappE164.trim().length > 0
            ? extendedTenant.whatsappE164.trim()
            : typeof extendedTenant.primaryWhatsappPhone === "string" &&
                extendedTenant.primaryWhatsappPhone.trim().length > 0
              ? extendedTenant.primaryWhatsappPhone.trim()
              : typeof config.primaryWhatsappPhone === "string" &&
                  config.primaryWhatsappPhone.trim().length > 0
                ? config.primaryWhatsappPhone.trim()
                : undefined;

        const nowMs =
          typeof extendedCtx.nowMs === "number" && Number.isFinite(extendedCtx.nowMs)
            ? extendedCtx.nowMs
            : Date.now();

        try {
          const result = await selectAndRecordWaRotation({
            db,
            tenantDb: extendedCtx.tenantDb ?? null,
            config,
            primaryWhatsappPhone: hostPrimaryWhatsappPhone,
            itemTitle,
            pageUrl,
            sourcePath,
            nowMs,
            recordClick: !nonCounting,
          });

          const ctaLabel =
            typeof config.ctaLabel === "string" && config.ctaLabel.trim().length > 0
              ? config.ctaLabel.trim()
              : DEFAULT_WA_CS_ROTATOR_CONFIG.ctaLabel;

          const rendered = renderWaRotatorHandoffHtml({
            tenant,
            result,
            ctaLabel,
          });

          return {
            status: 200,
            title: rendered.title,
            description: `Lanjutkan ke WhatsApp ${tenant.name}`,
            html: rendered.html,
            cssBytes: rendered.cssBytes,
            jsBytes: 0,
            headers: {
              "X-Plugin-Version": WA_CS_ROTATOR_MANIFEST.version,
            },
          };
        } catch (err) {
          // Graceful degradation: unconfigured fallback WA renders 200 off-hours card;
          // unexpected DB or CAS conflict errors return 503 without hiding real 5xx faults.
          const isUnconfiguredFallback =
            err instanceof WaCsRotatorValidationError && err.code === "INVALID_PHONE";
          const fallbackCard = renderWaRotatorUnavailableHtml({ tenant });
          return {
            status: isUnconfiguredFallback ? 200 : 503,
            title: fallbackCard.title,
            description: `Hubungi ${tenant.name}`,
            html: fallbackCard.html,
            cssBytes: fallbackCard.cssBytes,
            jsBytes: 0,
            headers: {
              "X-Plugin-Version": WA_CS_ROTATOR_MANIFEST.version,
            },
          };
        }
      },
    },
  },

  adminSlots: {
    configSchema: WaCsRotatorConfigSchema,
    configFields: [
      {
        key: "strategy",
        label: "Strategi Rotasi (round_robin / weighted)",
        description:
          "Pilih round_robin untuk giliran merata atau weighted untuk distribusi berbobot antar agen.",
        kind: "text",
        placeholder: "round_robin",
      },
      {
        key: "fallbackWhatsappPhone",
        label: "Nomor WhatsApp Utama (Fallback)",
        description:
          "Nomor tujuan otomatis apabila semua agen CS sedang di luar jam aktif atau nonaktif.",
        kind: "text",
        placeholder: "081234567890",
      },
      {
        key: "timezone",
        label: "Zona Waktu Jadwal Shift",
        description: "Zona waktu IANA untuk evaluasi jam aktif agen (bawaan: Asia/Jakarta).",
        kind: "text",
        placeholder: WA_CS_DEFAULT_TIMEZONE,
      },
      {
        key: "defaultMessage",
        label: "Pesan Bawaan WhatsApp",
        description: "Pesan awal otomatis saat pengunjung menekan tombol WhatsApp rotator.",
        kind: "text",
        placeholder: DEFAULT_WA_CS_ROTATOR_CONFIG.defaultMessage,
      },
      {
        key: "ctaLabel",
        label: "Label Tombol CTA",
        description: "Teks pada tombol WhatsApp rotator di halaman publik.",
        kind: "text",
        placeholder: DEFAULT_WA_CS_ROTATOR_CONFIG.ctaLabel,
      },
    ],

    async loadState({ db, config }) {
      const [state, stats] = await Promise.all([
        getRotatorState(db, config),
        getWaAttributionStats(db, config, Date.now()),
      ]);
      return {
        strategy: state.strategy,
        fallbackWhatsappPhone: state.fallbackWhatsappPhone,
        timezone: state.timezone,
        activeAgents: stats.activeAgentCount,
        onShiftAgents: stats.onShiftAgentCount,
        totalClicks: stats.totalClicks,
        fallbackClicks: stats.fallbackClicks,
        publicJsBytes: 0,
      };
    },

    async apiHandler({ request, subPath, db, config, nowMs }) {
      const method = request.method.toUpperCase();
      const normalized = subPath.replace(/^\/+|\/+$/g, "");
      const segments = normalized.length > 0 ? normalized.split("/") : [];

      try {
        // GET /overview
        if (normalized === "" || normalized === "overview") {
          if (method !== "GET") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "GET",
            });
          }
          const [agents, state, stats] = await Promise.all([
            listWaAgents(db),
            getRotatorState(db, config),
            getWaAttributionStats(db, config, nowMs),
          ]);
          return jsonOk({
            pluginId: WA_CS_ROTATOR_PLUGIN_ID,
            publicJsBytes: 0,
            state,
            agents: agents.map((a) => ({
              ...a,
              isOnShiftNow: isAgentOnShift(a, nowMs),
            })),
            stats,
          });
        }

        // GET /agents & POST /agents
        if (normalized === "agents") {
          if (method === "GET") {
            const agents = await listWaAgents(db);
            return jsonOk({
              agents: agents.map((a) => ({
                ...a,
                isOnShiftNow: isAgentOnShift(a, nowMs),
              })),
            });
          }
          if (method === "POST") {
            const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return jsonError(400, "VALIDATION_ERROR", "Body JSON agen tidak valid.");
            }
            const agent = await createWaAgent(db, body, nowMs);
            return jsonOk(
              {
                agent: {
                  ...agent,
                  isOnShiftNow: isAgentOnShift(agent, nowMs),
                },
              },
              201,
            );
          }
          return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
            Allow: "GET, POST",
          });
        }

        // PATCH /agents/:agentId & DELETE /agents/:agentId
        if (segments.length === 2 && segments[0] === "agents") {
          if (method !== "PATCH" && method !== "DELETE") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "PATCH, DELETE",
            });
          }
          const agentId = segments[1]!.toLowerCase();
          if (!isValidAgentId(agentId)) {
            return jsonError(404, "NOT_FOUND", "Agen sales tidak ditemukan.");
          }
          if (method === "PATCH") {
            const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
              return jsonError(400, "VALIDATION_ERROR", "Body JSON pembaruan agen tidak valid.");
            }
            const updated = await updateWaAgent(db, agentId, body, nowMs);
            if (!updated) {
              return jsonError(404, "NOT_FOUND", "Agen sales tidak ditemukan.");
            }
            return jsonOk({
              agent: {
                ...updated,
                isOnShiftNow: isAgentOnShift(updated, nowMs),
              },
            });
          }
          const deleted = await deleteWaAgent(db, agentId);
          if (!deleted) {
            return jsonError(404, "NOT_FOUND", "Agen sales tidak ditemukan.");
          }
          return jsonOk({ deleted: true, id: agentId });
        }

        // PUT / PATCH /settings
        if (normalized === "settings") {
          if (method !== "PUT" && method !== "PATCH") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "PUT, PATCH",
            });
          }
          const body = (await request.json().catch(() => null)) as {
            readonly strategy?: unknown;
            readonly fallbackWhatsappPhone?: unknown;
            readonly timezone?: unknown;
            readonly resetCursor?: unknown;
          } | null;
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return jsonError(400, "VALIDATION_ERROR", "Body JSON pengaturan tidak valid.");
          }
          if (
            body.strategy !== undefined &&
            body.strategy !== "round_robin" &&
            body.strategy !== "weighted"
          ) {
            return jsonError(
              422,
              "VALIDATION_ERROR",
              'Strategi rotasi harus bernilai "round_robin" atau "weighted".',
            );
          }
          const state = await updateRotatorSettings(
            db,
            {
              strategy: body.strategy as "round_robin" | "weighted" | undefined,
              fallbackWhatsappPhone:
                body.fallbackWhatsappPhone === undefined
                  ? undefined
                  : body.fallbackWhatsappPhone === null
                    ? null
                    : String(body.fallbackWhatsappPhone),
              timezone:
                body.timezone === undefined ? undefined : String(body.timezone),
              resetCursor: body.resetCursor === true,
            },
            nowMs,
            config,
          );
          return jsonOk({ state });
        }

        // GET /stats
        if (normalized === "stats") {
          if (method !== "GET") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "GET",
            });
          }
          const stats = await getWaAttributionStats(db, config, nowMs);
          return jsonOk({ stats });
        }

        // POST /simulate (dry-run without mutating cursor or clicks)
        if (normalized === "simulate") {
          if (method !== "POST") {
            return jsonError(405, "METHOD_NOT_ALLOWED", "Metode HTTP tidak diizinkan.", {
              Allow: "POST",
            });
          }
          const body = (await request.json().catch(() => ({}))) as {
            readonly atMs?: unknown;
            readonly atIso?: unknown;
          };
          let simNow = nowMs;
          if (typeof body.atMs === "number" && Number.isFinite(body.atMs)) {
            simNow = Math.floor(body.atMs);
          } else if (typeof body.atIso === "string") {
            const parsed = Date.parse(body.atIso);
            if (Number.isFinite(parsed)) simNow = parsed;
          }
          const [agents, state] = await Promise.all([
            listWaAgents(db),
            getRotatorState(db, config),
          ]);
          const decision = selectNextWaAgent({ agents, state, nowMs: simNow });
          return jsonOk({
            simulatedAtIso: new Date(simNow).toISOString(),
            strategyUsed: decision.strategyUsed,
            usedFallback: decision.usedFallback,
            eligibleCount: decision.eligibleCount,
            selectedAgent: decision.selectedAgent,
          });
        }

        return jsonError(404, "NOT_FOUND", "Endpoint plugin wa-cs-rotator tidak ditemukan.");
      } catch (err) {
        if (err instanceof WaCsRotatorValidationError) {
          const status = err.code === "CONFLICT" ? 409 : 422;
          return jsonError(status, err.code, err.message);
        }
        return jsonError(
          500,
          "INTERNAL_ERROR",
          "Terjadi kendala saat memproses permintaan wa-cs-rotator.",
        );
      }
    },
  },
});
