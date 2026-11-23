import { env } from "cloudflare:workers";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import { THEME_STORE_FORBIDDEN_PRICE_KEYS } from "@punyasitus/core/theme/variants";
import type { TenantStoreNamespaceLike } from "@punyasitus/db/connections";
import { createThemeStoreCheckoutOrder } from "@punyasitus/db/themes/store/index";
import type { APIRoute } from "astro";
import {
  authorizeTenantThemesRequest,
  createThemesRequestId,
  mapThemesDomainErrorToResponse,
  MAX_THEMES_BODY_BYTES,
  THEMES_FORBIDDEN_SELECTOR_KEYS,
  themesErrorResponse,
  themesJsonResponse,
  type TenantThemesHandlerOptions,
  type TenantThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Commercial Theme Store Checkout endpoint:
 * - `POST /api/tenants/:tenantId/themes/checkout`
 *
 * Creates an idempotent `theme_store_orders` checkout for a `paid_once` theme.
 * - Server-authoritative pricing ONLY (client price/amount/discount fields rejected with 422!).
 * - Supports optional single coupon (`TASK-082`) with AutoLaris minimum floor.
 * - Enforces `settings:publish` (Owner/Admin only — Editor -> 403), CSRF/Origin, and tenant isolation.
 *
 * TASK-096 (`REQ-096`, `REQ-056`, `REQ-082`).
 */

const CHECKOUT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "themeId",
  "channelCode",
  "couponCode",
  "idempotencyKey",
]);

const FORBIDDEN_SELECTOR_SET: ReadonlySet<string> = new Set(THEMES_FORBIDDEN_SELECTOR_KEYS);

export async function handleTenantThemeStoreCheckoutRequest(
  tenantId: string,
  request: Request,
  runtimeEnv: TenantThemesRuntimeEnv,
  options: TenantThemesHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createThemesRequestId();

  if (method !== "POST") {
    const auth = await authorizeTenantThemesRequest(
      tenantId,
      request,
      runtimeEnv,
      "settings:read",
      { ...options, requestId },
    );
    if (!auth.ok) return auth.response;
    return themesErrorResponse(
      405,
      "BAD_REQUEST",
      "Gunakan metode POST untuk memulai pembelian tema premium.",
      requestId,
      { extraHeaders: { Allow: "POST" } },
    );
  }

  const auth = await authorizeTenantThemesRequest(
    tenantId,
    request,
    runtimeEnv,
    "settings:publish",
    { ...options, requestId },
  );
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const rawBytes = new Uint8Array(await request.arrayBuffer());
    if (rawBytes.byteLength > MAX_THEMES_BODY_BYTES) {
      return themesErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        "Ukuran payload checkout tema melebihi batas maksimum.",
        requestId,
      );
    }

    const rawText = new TextDecoder().decode(rawBytes).trim();
    if (!rawText) {
      return themesErrorResponse(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return themesErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return themesErrorResponse(422, "VALIDATION_ERROR", "Body harus berupa objek JSON.", requestId);
    }

    const record = parsed as Record<string, unknown>;

    // Explicitly reject ANY client-supplied price/amount/discount override (zero client price trust!)
    for (const key of Object.keys(record)) {
      if (THEME_STORE_FORBIDDEN_PRICE_KEYS.has(key)) {
        return themesErrorResponse(
          422,
          "THEME_CHECKOUT_CLIENT_PRICE_FORBIDDEN",
          `Field harga "${key}" tidak boleh dikirim oleh klien; harga dihitung penuh di server.`,
          requestId,
          {
            fields: [
              {
                field: key,
                code: "THEME_CHECKOUT_CLIENT_PRICE_FORBIDDEN",
                message: "Client-supplied price or discount amounts are forbidden.",
              },
            ],
          },
        );
      }
      if (FORBIDDEN_SELECTOR_SET.has(key)) {
        return themesErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field "${key}" tidak diizinkan dalam body checkout tema.`,
          requestId,
        );
      }
      if (!CHECKOUT_ALLOWED_KEYS.has(key)) {
        return themesErrorResponse(
          422,
          "VALIDATION_ERROR",
          `Field tidak dikenal "${key}".`,
          requestId,
        );
      }
    }

    const rawThemeId = record.themeId;
    if (typeof rawThemeId !== "string" || !rawThemeId.trim()) {
      return themesErrorResponse(
        422,
        "VALIDATION_ERROR",
        "themeId wajib diisi untuk checkout tema premium.",
        requestId,
        { fields: [{ field: "themeId", code: "REQUIRED", message: "themeId is required." }] },
      );
    }

    const headerIdem = request.headers.get("Idempotency-Key")?.trim() || "";
    const bodyIdem = typeof record.idempotencyKey === "string" ? record.idempotencyKey.trim() : "";
    const idempotencyKey = headerIdem || bodyIdem || crypto.randomUUID();

    const tenantRow = await auth.ctx.platformDb
      .prepare("SELECT agency_id FROM tenants WHERE id = ? LIMIT 1")
      .bind(auth.ctx.member.tenantId)
      .first<{ readonly agency_id: string | null }>();

    const created = await createThemeStoreCheckoutOrder(auth.ctx.platformDb, {
      tenantId: auth.ctx.member.tenantId,
      themeId: rawThemeId.trim(),
      payerUserId: auth.ctx.member.userId,
      agencyId: tenantRow?.agency_id ?? null,
      channelCode: typeof record.channelCode === "string" ? record.channelCode : "QRIS",
      couponCode: record.couponCode,
      idempotencyKey,
      nowMs: options.nowMs,
    });

    return themesJsonResponse(created.idempotentReplay ? 200 : 201, {
      order: created.order,
      theme: created.theme,
      idempotentReplay: created.idempotentReplay,
    });
  } catch (err) {
    return mapThemesDomainErrorToResponse(err, requestId);
  }
}

function buildRuntimeEnv(): TenantThemesRuntimeEnv {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
  };
  return {
    APP_ENV: runtimeEnv.APP_ENV,
    PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
    PLATFORM_DB: runtimeEnv.PLATFORM_DB,
    AUTH_SECRET: runtimeEnv.AUTH_SECRET,
    CONSOLE_AUTH_SECRET: runtimeEnv.CONSOLE_AUTH_SECRET,
    EMAIL: runtimeEnv.EMAIL as unknown as CloudflareSendEmailBinding | undefined,
    TENANT_STORE: runtimeEnv.TENANT_STORE as unknown as TenantStoreNamespaceLike | undefined,
  };
}

export const ALL: APIRoute = ({ params, request, locals }) =>
  handleTenantThemeStoreCheckoutRequest(params.tenantId ?? "", request, buildRuntimeEnv(), {
    authenticatedUser: locals.authUser ? { id: locals.authUser.id } : null,
    activeOrganizationId: locals.authSession?.activeOrganizationId ?? null,
  });
