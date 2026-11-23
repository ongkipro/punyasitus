import {
  constantTimeEqual,
  definePlugin,
  PUBLIC_PLUGIN_JS_BUDGET_BYTES,
  type PluginConfigSchemaLike,
  type PluginDefinition,
} from "@punyasitus/core/plugins/index";

/**
 * Synthetic First-Party Test Plugins for TASK-097 proving all 5 Frozen-Core slots
 * (`plg_*` migrations + PITR bookmark, public section & sub-route <=25 KiB JS,
 * `base-nova` admin page + RBAC scoped JSON API, fault-isolated Queue hooks +
 * secret-verified webhook, and conditional OAuth-scoped MCP tools).
 */

export const SYNTHETIC_WEBHOOK_SECRET = "test-t097-webhook-secret-9f8e7d6c5b4a";

export const SyntheticProbeConfigSchema: PluginConfigSchemaLike = {
  safeParse(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false };
    }
    const obj = input as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(obj, "bannerLabel") &&
      (typeof obj.bannerLabel !== "string" ||
        obj.bannerLabel.trim().length === 0 ||
        obj.bannerLabel.length > 80)
    ) {
      return { success: false };
    }
    const bannerLabel =
      typeof obj.bannerLabel === "string" ? obj.bannerLabel.trim() : "Promo Aktif";
    const throwOnLeadHook = typeof obj.throwOnLeadHook === "boolean" ? obj.throwOnLeadHook : false;
    const delayHookMs =
      typeof obj.delayHookMs === "number" && Number.isInteger(obj.delayHookMs) && obj.delayHookMs >= 0
        ? obj.delayHookMs
        : 0;
    const publicJsBytesOverride =
      typeof obj.publicJsBytesOverride === "number" &&
      Number.isInteger(obj.publicJsBytesOverride) &&
      obj.publicJsBytesOverride >= 0
        ? obj.publicJsBytesOverride
        : 512;
    const emitSneakyOverBudgetScript = obj.emitSneakyOverBudgetScript === true;
    const emitForbiddenHeaders = obj.emitForbiddenHeaders === true;

    return {
      success: true,
      data: {
        bannerLabel,
        throwOnLeadHook,
        delayHookMs,
        publicJsBytesOverride,
        emitSneakyOverBudgetScript,
        emitForbiddenHeaders,
      },
    };
  },
};

export function createSyntheticProbePlugin(options?: {
  readonly id?: string;
  readonly visibility?: "public_free" | "public_paid" | "private_client";
  readonly priceIdr?: number;
}): PluginDefinition {
  const id = options?.id ?? "synthetic-probe";
  const snake = id.replace(/-/g, "_");
  const tablePrefix = `plg_${snake}__` as `plg_${string}__`;
  const itemsTable = `${tablePrefix}items`;
  const eventsTable = `${tablePrefix}events`;
  const publicRoutePath = id === "synthetic-probe" ? "/probe-widget" : `/${id}-widget`;
  const visibility = options?.visibility ?? "public_free";
  const priceIdr = options?.priceIdr ?? (visibility === "public_free" ? 0 : 99_000);

  return definePlugin({
    manifest: {
      id,
      name: "Synthetic Probe Plugin",
      description:
        "Plugin uji terpadu untuk memverifikasi kelima slot isolasi Frozen-Core PunyaSitus.",
      version: "1.0.0",
      visibility,
      billingCycle: visibility === "public_free" ? "free" : "paid_once",
      priceIdr,
      tablePrefix,
      permissions: [
        "tenant_db:plg_tables",
        "public:section",
        "public:route",
        "admin:page",
        "admin:api",
        "queue:lead.created",
        "queue:post.published",
        "webhook:inbound",
        "mcp:read",
        "mcp:write",
      ],
      maxPublicJsBytes: 1024,
      slots: {
        hasMigrations: true,
        publicSections: [
          {
            id: `${id}-banner`,
            label: "Synthetic Probe Banner",
            maxJsBytes: 512,
          },
        ],
        publicRoutes: [
          {
            path: publicRoutePath,
            maxJsBytes: 1024,
            description: "Declared public sub-route within <=25 KiB JS cap",
          },
        ],
        hasAdminPage: true,
        hasAdminApi: true,
        queueHooks: ["lead.created", "post.published"],
        hasWebhook: true,
        mcpTools: [
          {
            name: `plg_${snake}_list_items`,
            description: "List isolated plugin items from plg_* table",
            requiredScopes: [`plugin:${id}:read`],
            mode: "read",
          },
          {
            name: `plg_${snake}_add_item`,
            description: "Insert a new isolated item into plg_* table",
            requiredScopes: [`plugin:${id}:write`],
            mode: "draft",
          },
        ],
      },
      defaultConfig: {
        bannerLabel: "Promo Aktif",
        throwOnLeadHook: false,
        delayHookMs: 0,
        publicJsBytesOverride: 512,
        emitSneakyOverBudgetScript: false,
        emitForbiddenHeaders: false,
      },
    },

    // Slot 1: Additive namespace-locked `plg_*` SQLite migrations
    migrations: [
      {
        version: 1,
        name: "0001_init_probe_tables",
        sql: `
          CREATE TABLE IF NOT EXISTS ${itemsTable} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS ${tablePrefix}items_created_idx
            ON ${itemsTable}(created_at);
          CREATE TABLE IF NOT EXISTS ${eventsTable} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT NOT NULL,
            event_id TEXT NOT NULL UNIQUE,
            payload_json TEXT NOT NULL,
            recorded_at INTEGER NOT NULL
          );
        `,
      },
    ],

    // Slot 2: Public section & declared sub-route within <= 25 KiB JS budget
    publicSlots: {
      sections: {
        [`${id}-banner`]: async ({ config, db }) => {
          const rows = await db
            .prepare(`SELECT COUNT(*) AS total FROM ${itemsTable}`)
            .first<{ readonly total: number }>();
          const label = String(config.bannerLabel ?? "Promo Aktif");
          const jsBytes = Number(config.publicJsBytesOverride ?? 256);
          return {
            html: `<section data-plugin-section="${id}-banner"><h2>${label}</h2><p data-item-count="${Number(rows?.total ?? 0)}">${Number(rows?.total ?? 0)} item aktif</p></section>`,
            cssBytes: 128,
            jsBytes,
          };
        },
      },
      routes: {
        [publicRoutePath]: async ({ config, db }) => {
          const res = await db
            .prepare(`SELECT id, label FROM ${itemsTable} ORDER BY id ASC`)
            .all<{ readonly id: number; readonly label: string }>();
          const itemsHtml = (res.results ?? [])
            .map((row) => `<li>${row.label}</li>`)
            .join("");
          const sneakyScript =
            config.emitSneakyOverBudgetScript === true
              ? `<script>const pad = "${"x".repeat(PUBLIC_PLUGIN_JS_BUDGET_BYTES + 2048)}";</script>`
              : "";
          const jsBytes =
            config.emitSneakyOverBudgetScript === true
              ? 0 // Intentionally under-reported to verify real emitted byte check!
              : Number(config.publicJsBytesOverride ?? 512);
          const headers: Record<string, string> =
            config.emitForbiddenHeaders === true
              ? {
                  Location: "https://evil.example/phish",
                  Refresh: "0; url=https://evil.example",
                  "Set-Cookie": "pwn=1",
                  Link: "<https://evil.example>; rel=preload",
                  "Content-Type": "text/plain",
                  "X-Plugin-Version": "1.0.0",
                }
              : { "X-Plugin-Version": "1.0.0" };

          return {
            status: 200,
            title: "Widget Probe",
            description: "Rute publik plugin terisolasi",
            html: `<div data-probe-widget="ok"><h1>${String(config.bannerLabel ?? "Promo Aktif")}</h1><ul>${itemsHtml}</ul>${sneakyScript}</div>`,
            cssBytes: 240,
            jsBytes,
            headers,
          };
        },
      },
    },

    // Slot 3: Admin page state + config schema + scoped JSON API
    adminSlots: {
      configFields: [
        {
          key: "bannerLabel",
          label: "Label Banner Publik",
          description: "Teks yang tampil pada blok dan rute /probe-widget.",
          kind: "text",
          placeholder: "Promo Aktif",
        },
        {
          key: "throwOnLeadHook",
          label: "Simulasi Galat Hook Prospek",
          description: "Hanya untuk pengujian isolasi kegagalan Queue hook.",
          kind: "boolean",
        },
      ],
      configSchema: SyntheticProbeConfigSchema,
      loadState: async ({ db }) => {
        const items = await db
          .prepare(`SELECT COUNT(*) AS total FROM ${itemsTable}`)
          .first<{ readonly total: number }>();
        const events = await db
          .prepare(`SELECT COUNT(*) AS total FROM ${eventsTable}`)
          .first<{ readonly total: number }>();
        return {
          totalItems: Number(items?.total ?? 0),
          totalHookEvents: Number(events?.total ?? 0),
        };
      },
      apiHandler: async ({ request, subPath, db, nowMs }) => {
        const method = request.method.toUpperCase();
        if (subPath === "/domains" && method === "POST") {
          return Response.json({ ok: true, subpath: "/domains" }, { status: 200 });
        }
        if (subPath === "/items" && method === "GET") {
          const rows = await db
            .prepare(`SELECT id, label, created_at FROM ${itemsTable} ORDER BY id ASC`)
            .all<{ readonly id: number; readonly label: string; readonly created_at: number }>();
          return Response.json({ items: rows.results ?? [] }, { status: 200 });
        }
        if (subPath === "/items" && method === "POST") {
          const body = (await request.json()) as { readonly label?: string };
          const label = typeof body.label === "string" ? body.label.trim() : "";
          if (!label) {
            return Response.json(
              { error: { code: "VALIDATION_ERROR", message: "Label wajib diisi." } },
              { status: 422 },
            );
          }
          await db
            .prepare(`INSERT INTO ${itemsTable} (label, created_at) VALUES (?, ?)`)
            .bind(label, nowMs)
            .run();
          const latest = await db
            .prepare(`SELECT id, label, created_at FROM ${itemsTable} ORDER BY id DESC LIMIT 1`)
            .first<{ readonly id: number; readonly label: string; readonly created_at: number }>();
          return Response.json({ item: latest }, { status: 201 });
        }
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Subpath API plugin tidak ditemukan." } },
          { status: 404 },
        );
      },
    },

    // Slot 4: Fault-isolated Queue hooks & secret-verified platform webhook
    queueHooks: {
      "lead.created": {
        timeoutMs: 1_500,
        execute: async ({ config, db, event, eventId, payload, nowMs }) => {
          const delayMs = Number(config.delayHookMs ?? 0);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (config.throwOnLeadHook === true) {
            throw new Error("SYNTHETIC_PLUGIN_LEAD_HOOK_CRASH");
          }
          await db
            .prepare(
              `INSERT OR IGNORE INTO ${eventsTable} (event_name, event_id, payload_json, recorded_at)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(event, eventId, JSON.stringify(payload), nowMs)
            .run();
        },
      },
      "post.published": {
        timeoutMs: 1_500,
        execute: async ({ db, event, eventId, payload, nowMs }) => {
          await db
            .prepare(
              `INSERT OR IGNORE INTO ${eventsTable} (event_name, event_id, payload_json, recorded_at)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(event, eventId, JSON.stringify(payload), nowMs)
            .run();
        },
      },
    },

    webhook: {
      secretHeaderName: "X-Synthetic-Webhook-Secret",
      verifySecret: (request) => {
        const provided = request.headers.get("X-Synthetic-Webhook-Secret") ?? "";
        return constantTimeEqual(provided, SYNTHETIC_WEBHOOK_SECRET);
      },
      resolveTenantTarget: (_request, rawBody) => {
        try {
          const parsed = JSON.parse(rawBody) as {
            readonly targetTenantId?: string;
            readonly token?: string;
          };
          if (!parsed.targetTenantId) return null;
          return {
            tenantId: parsed.targetTenantId,
            payload: { token: parsed.token ?? "" },
          };
        } catch {
          return null;
        }
      },
      handle: async ({ db, payload, nowMs }) => {
        const token = String(payload.token ?? "linked");
        await db
          .prepare(
            `INSERT OR IGNORE INTO ${eventsTable} (event_name, event_id, payload_json, recorded_at)
             VALUES ('webhook.inbound', ?, ?, ?)`,
          )
          .bind(`wh_${token}_${nowMs}`, JSON.stringify(payload), nowMs)
          .run();
        return Response.json({ ok: true, linkedToken: token }, { status: 200 });
      },
    },

    // Slot 5: Conditional OAuth-scoped MCP tools
    mcpTools: [
      {
        name: `plg_${snake}_list_items`,
        description: "List isolated plugin items from plg_* table",
        requiredScopes: [`plugin:${id}:read`],
        mode: "read",
        execute: async ({ db }) => {
          const rows = await db
            .prepare(`SELECT id, label, created_at FROM ${itemsTable} ORDER BY id ASC`)
            .all<{ readonly id: number; readonly label: string; readonly created_at: number }>();
          return { items: rows.results ?? [] };
        },
      },
      {
        name: `plg_${snake}_add_item`,
        description: "Insert a new isolated item into plg_* table",
        requiredScopes: [`plugin:${id}:write`],
        mode: "draft",
        execute: async ({ db, args, nowMs }) => {
          const label = String(args.label ?? "MCP Item").trim();
          await db
            .prepare(`INSERT INTO ${itemsTable} (label, created_at) VALUES (?, ?)`)
            .bind(label, nowMs)
            .run();
          return { created: true, label };
        },
      },
    ],
  });
}

export const OVER_BUDGET_JS_BYTES = PUBLIC_PLUGIN_JS_BUDGET_BYTES + 1024;
