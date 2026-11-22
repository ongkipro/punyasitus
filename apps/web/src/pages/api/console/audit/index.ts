import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  createConsoleRequestId,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import type { CloudflareSendEmailBinding } from "@punyasitus/core/email/index";
import {
  PLATFORM_AUDIT_OUTCOMES,
  queryPlatformAuditPage,
  type ListPlatformAuditFilter,
  type PlatformAuditOutcome,
} from "@punyasitus/db/platform";
import type { APIRoute } from "astro";

/**
 * `/api/console/audit` — Immutable, read-only, redacted platform audit explorer.
 *
 * Security invariants (TASK-048, REQ-051, REQ-039, PLAN §13):
 * - Strictly `console.punyasitus.com` host + active platform operator with verified 2FA.
 * - `GET` returns paginated, filterable, read-side-redacted entries (zero passwords, tokens,
 *   API keys, secrets, raw cookies, or unredacted PII).
 * - ALL mutating methods (`POST`, `PUT`, `PATCH`, `DELETE`) explicitly return `405 METHOD_NOT_ALLOWED`.
 */

function parseOptionalEpochParam(raw: string | null): number | undefined | "invalid" {
  if (raw === null || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const asNum = Number(trimmed);
    return Number.isSafeInteger(asNum) && asNum > 0 ? asNum : "invalid";
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed) || parsed <= 0) return "invalid";
  return Math.trunc(parsed);
}

export async function handleConsoleAuditRequest(
  request: Request,
  runtimeEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  const requestId = options.requestId ?? createConsoleRequestId();

  // Always enforce console host + live operator + 2FA first (don't check CSRF before 405 rejection
  // for non-GET, wait: enforce host & auth, then return 405 METHOD_NOT_ALLOWED for POST/PUT/PATCH/DELETE!)
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: method === "GET" ? "platform_audit.read" : "platform_audit.immutable_reject",
      requireStepUp: false,
      enforceCsrf: false,
    },
    { ...options, requestId },
  );
  if (!authz.ok) return authz.response;

  if (method !== "GET") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Log audit platform bersifat append-only (hanya baca) dan tidak dapat ditambah manual, diubah, atau dihapus.",
      authz.ctx.requestId,
      undefined,
      { Allow: "GET" },
    );
  }

  const url = new URL(request.url);
  const sp = url.searchParams;

  const outcomeRaw = sp.get("outcome")?.trim() || undefined;
  if (
    outcomeRaw &&
    !(PLATFORM_AUDIT_OUTCOMES as readonly string[]).includes(outcomeRaw)
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Filter outcome tidak valid. Gunakan success, denied, atau error.",
      authz.ctx.requestId,
    );
  }

  const fromCreatedAtMs = parseOptionalEpochParam(sp.get("from"));
  const toCreatedAtMs = parseOptionalEpochParam(sp.get("to"));
  const beforeCreatedAtMs = parseOptionalEpochParam(sp.get("beforeCreatedAtMs"));

  if (
    fromCreatedAtMs === "invalid" ||
    toCreatedAtMs === "invalid" ||
    beforeCreatedAtMs === "invalid"
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Format parameter tanggal/timestamp tidak valid.",
      authz.ctx.requestId,
    );
  }

  const rawLimit = sp.get("limit");
  let limit = 25;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    const parsedLimit = Number(rawLimit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Parameter limit harus berupa angka positif (1–100).",
        authz.ctx.requestId,
      );
    }
    limit = Math.min(100, Math.trunc(parsedLimit));
  }

  const filter: ListPlatformAuditFilter = {
    action: sp.get("action")?.trim() || undefined,
    actorUserId: (sp.get("actorUserId") ?? sp.get("actor"))?.trim() || undefined,
    targetType: sp.get("targetType")?.trim() || undefined,
    targetId: (sp.get("targetId") ?? sp.get("target"))?.trim() || undefined,
    tenantId: sp.get("tenantId")?.trim() || undefined,
    outcome: outcomeRaw as PlatformAuditOutcome | undefined,
    requestId: sp.get("requestId")?.trim() || undefined,
    fromCreatedAtMs,
    toCreatedAtMs,
    beforeCreatedAtMs,
    beforeId: sp.get("beforeId")?.trim() || undefined,
    limit,
  };

  const page = await queryPlatformAuditPage(authz.ctx.platformDb, filter);

  return consoleJsonResponse(200, {
    success: true,
    items: page.items,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    immutable: true,
    requestId: authz.ctx.requestId,
  });
}

function getRuntimeEnv(): ConsoleRuntimeEnv {
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
  };
}

export const ALL: APIRoute = ({ request }) =>
  handleConsoleAuditRequest(request, getRuntimeEnv());
