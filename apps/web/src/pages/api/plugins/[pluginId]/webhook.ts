import { env } from "cloudflare:workers";
import { loadLiveTenantEntitlement } from "@punyasitus/auth/entitlements/index";
import {
  isBuiltinPluginId,
  readBoundedRequestBody,
} from "@punyasitus/core/plugins/index";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import type { ScopedPluginTenantDbOptions } from "@punyasitus/db/plugins/index";
import type { APIRoute } from "astro";
import { DEFAULT_PLUGIN_REGISTRY, type PluginRegistry } from "../../../../core/plugin-registry.ts";
import {
  PluginRuntimeError,
  resolveActivePluginForTenant,
} from "../../../../core/plugin-runtime.ts";
import { resolvePlatformAuthHostContext, type AuthRuntimeEnv } from "../../../../middleware/auth.ts";

/**
 * Slot 4 Secret-Verified Platform Callback Webhook (`POST /api/plugins/:pluginId/webhook`;
 * REQ-097, REQ-101, ADR-0010, TASK-097).
 *
 * Security invariants:
 * - Served ONLY on `app.punyasitus.com` (or local loopback in `APP_ENV=local`); neutral `404` on
 *   tenant, marketing, console, and unknown hosts.
 * - Verifies plugin-declared secret header BEFORE reading body or touching any database.
 * - Enforces hard `128 KiB` body cap via `Content-Length` pre-check + bounded stream reader.
 * - Optional replay protection (`X-Plugin-Event-Id` / `X-Webhook-Event-Id` + `X-Plugin-Timestamp`
 *   5-minute window) backed by `PLATFORM_DB.job_ledger` (409 on replay).
 * - Evaluates live server-clock entitlement (`loadLiveTenantEntitlement`) and explicitly blocks
 *   `locked` (`403 SUBSCRIPTION_LOCKED`), `suspended`, `recovery`, `operatorHold` (`403`), and
 *   `purging`/`purged` (`404`) BEFORE touching `TenantStore`.
 * - Verifies `PLATFORM_DB.tenant_plugin_entitlements` (unentitled -> 403/404 with ZERO TenantStore queries).
 */

export const MAX_WEBHOOK_BODY_BYTES = 131_072; // 128 KiB hard cap
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60_000; // 5 minutes
const WEBHOOK_MUTABLE_TENANT_STATUSES = new Set(["trial", "active", "grace"]);

const WEBHOOK_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export interface PluginWebhookRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
  readonly [key: string]: unknown;
}

export interface PluginWebhookHandlerOptions {
  readonly registry?: PluginRegistry;
  readonly nowMs?: number;
  readonly resolveTenantDb?: (tenantId: string) => D1Database;
  readonly scopedDbOptions?: ScopedPluginTenantDbOptions;
}

function webhookJson(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...WEBHOOK_NO_STORE_HEADERS,
      ...extraHeaders,
    },
  });
}

export async function handlePluginInboundWebhook(
  pluginId: string,
  request: Request,
  runtimeEnv: PluginWebhookRuntimeEnv,
  options: PluginWebhookHandlerOptions = {},
): Promise<Response> {
  // 1. Strict `app` host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return webhookJson(404, { error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan." } });
  }

  if (request.method.toUpperCase() !== "POST") {
    return webhookJson(
      405,
      { error: { code: "BAD_REQUEST", message: "Metode harus POST." } },
      { Allow: "POST" },
    );
  }

  const cleanId = pluginId.trim().toLowerCase();
  if (!cleanId || isBuiltinPluginId(cleanId)) {
    return webhookJson(404, { error: { code: "NOT_FOUND", message: "Plugin tidak ditemukan." } });
  }

  const registry = options.registry ?? DEFAULT_PLUGIN_REGISTRY;
  const plugin = registry.get(cleanId);
  if (!plugin || !plugin.manifest.slots.hasWebhook || !plugin.webhook) {
    return webhookJson(404, { error: { code: "NOT_FOUND", message: "Webhook plugin tidak ditemukan." } });
  }

  // 2. Verify webhook secret STRICTLY BEFORE reading body stream or touching any database
  let secretValid: boolean;
  try {
    secretValid = Boolean(plugin.webhook.verifySecret(request, runtimeEnv));
  } catch {
    secretValid = false;
  }
  if (!secretValid) {
    return webhookJson(401, {
      error: { code: "UNAUTHENTICATED", message: "Token rahasia webhook tidak valid." },
    });
  }

  // 3. Optional timestamp replay-window check (`X-Plugin-Timestamp` in epoch seconds or ms)
  const nowMs = Math.floor(options.nowMs ?? Date.now());
  const rawTimestamp = request.headers.get("X-Plugin-Timestamp");
  if (rawTimestamp !== null && rawTimestamp.trim() !== "") {
    const parsedTs = Number(rawTimestamp.trim());
    if (!Number.isFinite(parsedTs)) {
      return webhookJson(400, {
        error: { code: "BAD_REQUEST", message: "Header timestamp webhook tidak valid." },
      });
    }
    const tsMs = parsedTs < 1e12 ? parsedTs * 1000 : parsedTs;
    if (Math.abs(nowMs - tsMs) > MAX_TIMESTAMP_DRIFT_MS) {
      return webhookJson(409, {
        error: { code: "IDEMPOTENCY_CONFLICT", message: "Timestamp webhook kedaluwarsa." },
      });
    }
  }

  // 4. Bounded body read (pre-checks Content-Length AND aborts oversized streams at 128 KiB)
  const boundedBody = await readBoundedRequestBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (!boundedBody.ok) {
    if (boundedBody.reason === "too_large") {
      return webhookJson(413, {
        error: { code: "PAYLOAD_TOO_LARGE", message: "Ukuran payload webhook melebihi batas 128 KiB." },
      });
    }
    return webhookJson(400, {
      error: { code: "BAD_REQUEST", message: "Body webhook tidak dapat dibaca." },
    });
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return webhookJson(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Layanan sementara tidak tersedia." },
    });
  }

  // 5. Resolve tenant target inside fault-isolated try/catch
  let target: Awaited<ReturnType<typeof plugin.webhook.resolveTenantTarget>>;
  try {
    target = await plugin.webhook.resolveTenantTarget(request, boundedBody.text);
  } catch {
    return webhookJson(400, {
      error: { code: "BAD_REQUEST", message: "Payload webhook tidak dapat diproses." },
    });
  }

  if (!target || !target.tenantId.trim()) {
    return webhookJson(404, {
      error: { code: "NOT_FOUND", message: "Target situs webhook tidak valid atau kedaluwarsa." },
    });
  }

  // 6. Authoritative live server-clock lifecycle gate BEFORE touching TenantStore
  let liveEntitlement: Awaited<ReturnType<typeof loadLiveTenantEntitlement>>;
  try {
    liveEntitlement = await loadLiveTenantEntitlement(
      runtimeEnv.PLATFORM_DB,
      { tenantId: target.tenantId },
      { nowMs },
    );
  } catch {
    return webhookJson(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Gagal memverifikasi status situs target." },
    });
  }

  if (!liveEntitlement) {
    return webhookJson(404, { error: { code: "NOT_FOUND", message: "Situs tidak ditemukan." } });
  }

  const effectiveStatus = liveEntitlement.evaluation.effectiveStatus;
  const storedStatus = liveEntitlement.evaluation.storedStatus;

  if (
    effectiveStatus === "purged" ||
    effectiveStatus === "purging" ||
    storedStatus === "purged" ||
    storedStatus === "purging"
  ) {
    return webhookJson(404, { error: { code: "NOT_FOUND", message: "Situs tidak ditemukan." } });
  }

  // Explicitly deny `locked` (`403 SUBSCRIPTION_LOCKED`), `suspended`, `recovery`, and `operatorHold`
  if (
    liveEntitlement.evaluation.operatorHold ||
    !WEBHOOK_MUTABLE_TENANT_STATUSES.has(effectiveStatus)
  ) {
    return webhookJson(403, {
      error: {
        code: "SUBSCRIPTION_LOCKED",
        message: "Webhook plugin ditolak karena status langganan situs sedang terkunci atau ditangguhkan.",
      },
    });
  }

  // 7. Optional durable replay protection when `X-Plugin-Event-Id` / `X-Webhook-Event-Id` is provided
  const eventIdHeader =
    request.headers.get("X-Plugin-Event-Id") ?? request.headers.get("X-Webhook-Event-Id");
  const eventId = eventIdHeader?.trim() || "";
  if (eventId.length > 0) {
    if (eventId.length > 128) {
      return webhookJson(400, {
        error: { code: "BAD_REQUEST", message: "Header event ID webhook terlalu panjang." },
      });
    }
    try {
      const dedupKey = `plg-wh:${cleanId}:${liveEntitlement.tenantId}:${eventId}`;
      const insertRes = await runtimeEnv.PLATFORM_DB.prepare(
        `INSERT OR IGNORE INTO job_ledger (
           idempotency_key, topic, tenant_id, status, attempts, payload_json, created_at, updated_at
         ) VALUES (?, 'plugin.webhook.dedup', ?, 'completed', 1, NULL, ?, ?)`,
      )
        .bind(dedupKey, liveEntitlement.tenantId, nowMs, nowMs)
        .run();
      if ((insertRes.meta?.changes ?? 0) === 0) {
        return webhookJson(409, {
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "Event webhook duplikat ditolak (replay terdeteksi).",
          },
        });
      }
    } catch {
      return webhookJson(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "Gagal memverifikasi deduplikasi webhook." },
      });
    }
  }

  // 8. Verify active plugin entitlement in PLATFORM_DB BEFORE TenantStore access
  const tenantSnapshot = {
    id: liveEntitlement.tenantId,
    handle: liveEntitlement.handle,
    name: liveEntitlement.tenantName,
    status: effectiveStatus,
  };

  let resolved: Awaited<ReturnType<typeof resolveActivePluginForTenant>>;
  try {
    resolved = await resolveActivePluginForTenant(
      {
        platformDb: runtimeEnv.PLATFORM_DB,
        tenantStore: runtimeEnv.TENANT_STORE,
        resolveTenantDb: options.resolveTenantDb,
        registry,
        nowMs,
        scopedDbOptions: options.scopedDbOptions,
      },
      tenantSnapshot,
      cleanId,
    );
  } catch {
    return webhookJson(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Gagal memverifikasi lisensi plugin situs." },
    });
  }

  if (!resolved.active) {
    if (resolved.reason === "tenant_unavailable") {
      return webhookJson(403, {
        error: { code: "SUBSCRIPTION_LOCKED", message: "Situs sedang tidak aktif." },
      });
    }
    if (resolved.reason === "unentitled") {
      return webhookJson(
        plugin.manifest.visibility === "private_client" ? 404 : 403,
        {
          error: {
            code: plugin.manifest.visibility === "private_client" ? "NOT_FOUND" : "FORBIDDEN",
            message: "Plugin tidak memiliki hak akses aktif pada situs target.",
          },
        },
      );
    }
    return webhookJson(404, {
      error: { code: "NOT_FOUND", message: "Plugin tidak aktif pada situs target." },
    });
  }

  try {
    const res = await plugin.webhook.handle({
      tenant: tenantSnapshot,
      pluginId: cleanId,
      request,
      payload: target.payload,
      config: resolved.installed.config,
      db: resolved.scopedDb,
      nowMs,
    });
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    if (err instanceof PluginRuntimeError) {
      return webhookJson(err.status, { error: { code: err.code, message: err.message } });
    }
    return webhookJson(500, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Gagal memproses webhook plugin." },
    });
  }
}

export const ALL: APIRoute = ({ params, request }) =>
  handlePluginInboundWebhook(
    params.pluginId ?? "",
    request,
    env as unknown as PluginWebhookRuntimeEnv,
  );
