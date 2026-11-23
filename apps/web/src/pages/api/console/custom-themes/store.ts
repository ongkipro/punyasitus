import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import { ThemeNotFoundError } from "@punyasitus/core/theme/index";
import { ThemeStoreDomainError } from "@punyasitus/core/theme/variants";
import {
  consoleGrantTenantThemeEntitlement,
  listConsoleThemeStoreOverview,
} from "@punyasitus/db/themes/store/index";
import type { APIRoute } from "astro";
import {
  mapConsoleCustomThemeErrorToResponse,
  resolveConsoleCustomThemesRuntimeEnv,
} from "./_shared.ts";

/**
 * Superadmin Console Theme Store Catalog & Entitlements API:
 * - `GET /api/console/custom-themes/store` — lists catalog (`included`, `paid_once`, `custom`),
 *   active per-tenant entitlements, recent theme store orders, and numbered receipts.
 * - `POST /api/console/custom-themes/store` — operator-only audited entitlement grant
 *   (requires 2FA step-up + CSRF/Origin validation + explicit reason + <= 16 KiB body;
 *   restricted strictly to `paid_once` and `custom` themes — `included` themes rejected 422).
 *
 * TASK-096 (`REQ-096`, `REQ-049`, `REQ-051`; ADR-0010).
 */

const MAX_CONSOLE_STORE_BODY_BYTES = 16_384 as const; // 16 KiB hard ceiling

export async function handleConsoleThemeStoreRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  authOptions: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === "GET") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.store.view", requireStepUp: false },
      authOptions,
    );
    if (!authz.ok) return authz.response;

    try {
      const overview = await listConsoleThemeStoreOverview(authz.ctx.platformDb);
      return consoleJsonResponse(200, overview);
    } catch (err) {
      return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
    }
  }

  if (method === "POST") {
    const authz = await authorizeConsoleRequest(
      request,
      runtimeEnv,
      { action: "console.custom_themes.store.grant", requireStepUp: true },
      authOptions,
    );
    if (!authz.ok) return authz.response;

    try {
      const rawBytes = new Uint8Array(await request.arrayBuffer());
      if (rawBytes.byteLength > MAX_CONSOLE_STORE_BODY_BYTES) {
        return consoleErrorResponse(
          413,
          "PAYLOAD_TOO_LARGE",
          `Ukuran payload melebihi batas maksimum ${MAX_CONSOLE_STORE_BODY_BYTES} byte.`,
          authz.ctx.requestId,
        );
      }

      const rawText = new TextDecoder().decode(rawBytes).trim();
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return consoleErrorResponse(
            422,
            "VALIDATION_ERROR",
            "Body permintaan harus berupa objek JSON.",
            authz.ctx.requestId,
          );
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return consoleErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", authz.ctx.requestId);
      }

      const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
      const themeId = typeof body.themeId === "string" ? body.themeId.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";

      if (!tenantId || !themeId || reason.length < 5) {
        return consoleErrorResponse(
          422,
          "VALIDATION_ERROR",
          "tenantId, themeId, dan reason (minimal 5 karakter) wajib diisi.",
          authz.ctx.requestId,
        );
      }

      const granted = await consoleGrantTenantThemeEntitlement(authz.ctx.platformDb, {
        actorUserId: authz.ctx.actor.grant.userId,
        actorRole: authz.ctx.actor.grant.role,
        tenantId,
        themeId,
        reason,
        nowMs: authz.ctx.nowMs,
      });

      return consoleJsonResponse(granted.created ? 201 : 200, granted);
    } catch (err) {
      if (err instanceof ThemeStoreDomainError) {
        return consoleErrorResponse(err.httpStatus, err.code, err.message, authz.ctx.requestId, {
          reasonCode: err.code,
          fields: err.fields,
        });
      }
      if (err instanceof ThemeNotFoundError) {
        return consoleErrorResponse(404, "THEME_NOT_FOUND", err.message, authz.ctx.requestId);
      }
      return mapConsoleCustomThemeErrorToResponse(err, authz.ctx.requestId);
    }
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action: "console.custom_themes.store.view", requireStepUp: false },
    authOptions,
  );
  if (!authz.ok) return authz.response;
  return consoleErrorResponse(
    405,
    "BAD_REQUEST",
    "Metode HTTP tidak diizinkan.",
    authz.ctx.requestId,
    { extraHeaders: { Allow: "GET, POST" } },
  );
}

export const ALL: APIRoute = ({ request, locals }) =>
  handleConsoleThemeStoreRequest(
    request,
    resolveConsoleCustomThemesRuntimeEnv(env as unknown as Record<string, unknown>),
    {
      session: locals.authSession
        ? { id: locals.authSession.id, userId: locals.authSession.userId }
        : null,
      user: locals.authUser ? { id: locals.authUser.id, email: locals.authUser.email } : null,
    },
  );
