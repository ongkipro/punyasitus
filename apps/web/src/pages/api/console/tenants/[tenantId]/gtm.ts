import { env } from "cloudflare:workers";
import {
  authorizeConsoleRequest,
  consoleErrorResponse,
  consoleJsonResponse,
  consoleNeutralNotFoundResponse,
  createConsoleRequestId,
  parseStrictConsoleJsonBody,
  resolveConsoleHostContext,
} from "@punyasitus/auth/platform/index";
import { normalizeHost, PLATFORM_HOSTS } from "@punyasitus/core";
import { isValidGtmKillSwitchReasonCategory, type GtmKillSwitchReasonCategory } from "@punyasitus/core/analytics/gtm";
import {
  executeConsoleTenantGtmKillSwitch,
  getConsoleTenantGtmStatus,
  GtmSettingsDomainError,
  type ConsoleGtmKillSwitchAction,
} from "@punyasitus/db/analytics-settings/index";
import type { APIRoute } from "astro";
import { resolveAuthEmailPort } from "../../../../../middleware/auth.ts";
import { dispatchGtmKillSwitchOwnerNotice } from "../../../../../worker/queues/dispatch/gtm.ts";
import {
  buildConsoleTenantsRuntimeEnv,
  type ConsoleTenantsHandlerOptions,
  type ConsoleTenantsRuntimeEnv,
} from "../_shared.ts";

/**
 * Superadmin Console Operator GTM Kill Switch API
 * (`GET / POST /api/console/tenants/[tenantId]/gtm`; TASK-076, REQ-027, DEC-027, PLAN §18.1).
 *
 * Security invariants:
 * - Non-console hosts ALWAYS receive a bare neutral `404 Not Found` (`text/plain`).
 * - Requires live console session + active `platform_operators` grant + mandatory 2FA.
 * - `POST` enforces CSRF/Origin, strict field allowlist, 10-minute step-up 2FA (`requireStepUp: true`),
 *   mandatory reason category (`abuse` | `malware` | `performance` for `disable`), audited reason (10-500 chars),
 *   optimistic `expectedVersion`, and `Idempotency-Key`.
 * - Disables tenant GTM while keeping direct GA4/Meta/TikTok tags working, and notifies the owner via email.
 */

const ULID_SELECTOR_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ALLOWED_GTM_KILL_SWITCH_KEYS = new Set([
  "action",
  "reasonCategory",
  "reason",
  "expectedVersion",
  "idempotencyKey",
]);

function parseSelector(raw: string): { readonly tenantId?: string; readonly handle?: string } | null {
  const clean = raw.trim();
  if (!clean) return null;
  if (ULID_SELECTOR_RE.test(clean)) return { tenantId: clean };
  return { handle: clean.toLowerCase() };
}

function resolveIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
  requestId: string,
): { readonly ok: true; readonly key: string } | { readonly ok: false; readonly response: Response } {
  const headerKey = request.headers.get("idempotency-key")?.trim() ?? "";
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

  if (headerKey && bodyKey && headerKey !== bodyKey) {
    return {
      ok: false,
      response: consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key dan field body idempotencyKey tidak cocok.",
        requestId,
      ),
    };
  }
  const resolved = headerKey || bodyKey;
  if (!resolved) {
    return {
      ok: false,
      response: consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key wajib disertakan pada header atau body permintaan.",
        requestId,
      ),
    };
  }
  return { ok: true, key: resolved };
}

export interface ConsoleTenantGtmRuntimeEnv extends ConsoleTenantsRuntimeEnv {
  readonly JOBS_QUEUE?: { send(message: unknown): Promise<unknown> };
}

export async function handleConsoleTenantGtmRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: ConsoleTenantGtmRuntimeEnv,
  options: ConsoleTenantsHandlerOptions = {},
): Promise<Response> {
  // 1. Strict non-console host isolation -> bare neutral 404 (never discloses console copy!)
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return consoleNeutralNotFoundResponse();
  }

  const requestId = options.requestId ?? createConsoleRequestId();
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return consoleErrorResponse(
      405,
      "METHOD_NOT_ALLOWED",
      "Metode HTTP tidak diizinkan.",
      requestId,
      undefined,
      { Allow: "GET, POST" },
    );
  }

  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    {
      action: method === "POST" ? "console.tenant.gtm_kill_switch" : "console.tenant.gtm.read",
      requireStepUp: method === "POST",
    },
    { ...options, requestId },
  );
  if (!authz.ok) {
    return authz.response;
  }

  const selector = parseSelector(tenantSelector);
  if (!selector) {
    return consoleErrorResponse(404, "NOT_FOUND", "Selector tenant tidak valid.", requestId);
  }

  if (method === "GET") {
    try {
      const status = await getConsoleTenantGtmStatus(
        authz.ctx.platformDb,
        selector,
        runtimeEnv.TENANT_STORE ?? null,
      );
      if (!status) {
        return consoleErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId);
      }
      return consoleJsonResponse(200, {
        success: true,
        requestId,
        gtm: status,
      });
    } catch (err) {
      if (err instanceof GtmSettingsDomainError) {
        return consoleErrorResponse(err.status, err.code, err.message, requestId);
      }
      return consoleErrorResponse(
        500,
        "INTERNAL_ERROR",
        "Gagal memuat status GTM tenant.",
        requestId,
      );
    }
  }

  // POST — Audited GTM Kill Switch (`disable` | `lift`)
  const parsedBody = await parseStrictConsoleJsonBody(
    request,
    requestId,
    ALLOWED_GTM_KILL_SWITCH_KEYS,
  );
  if (!parsedBody.ok) {
    return parsedBody.response;
  }
  const body = parsedBody.body;

  const idemp = resolveIdempotencyKey(request, body, requestId);
  if (!idemp.ok) {
    return idemp.response;
  }

  if (body.action !== "disable" && body.action !== "lift") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      'Field action hanya boleh bernilai "disable" atau "lift".',
      requestId,
    );
  }
  const action: ConsoleGtmKillSwitchAction = body.action;

  let reasonCategory: GtmKillSwitchReasonCategory | undefined;
  if (action === "disable") {
    if (!isValidGtmKillSwitchReasonCategory(body.reasonCategory)) {
      return consoleErrorResponse(
        422,
        "VALIDATION_ERROR",
        'Field reasonCategory wajib berupa "abuse", "malware", atau "performance".',
        requestId,
      );
    }
    reasonCategory = body.reasonCategory;
  }

  if (typeof body.reason !== "string") {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Alasan operasional audit (10–500 karakter) wajib diisi.",
      requestId,
    );
  }

  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return consoleErrorResponse(
      422,
      "VALIDATION_ERROR",
      "Field expectedVersion wajib berupa bilangan bulat positif.",
      requestId,
    );
  }

  try {
    const result = await executeConsoleTenantGtmKillSwitch(authz.ctx.platformDb, {
      actorUserId: authz.ctx.actor.userId,
      actorRole: authz.ctx.actor.grant.role,
      tenantId: selector.tenantId,
      handle: selector.handle,
      action,
      reasonCategory,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      idempotencyKey: idemp.key,
      requestId,
      tenantStore: runtimeEnv.TENANT_STORE ?? null,
      nowMs: authz.ctx.nowMs,
    });

    // Notify tenant owner on fresh kill-switch disable (non-blocking, deduplicated)
    let ownerNotification: {
      readonly attempted: boolean;
      readonly enqueued: boolean;
      readonly directSent: boolean;
      readonly messageKey: string | null;
    } = {
      attempted: false,
      enqueued: false,
      directSent: false,
      messageKey: null,
    };

    if (action === "disable" && !result.replayed && reasonCategory) {
      const emailPort = resolveAuthEmailPort(runtimeEnv, options.emailPort);
      const appBaseUrl = host.isLocalLoopback
        ? host.baseURL
        : `https://app.${normalizeHost(runtimeEnv.PLATFORM_DOMAIN) ?? PLATFORM_HOSTS.marketing}`;

      ownerNotification = await dispatchGtmKillSwitchOwnerNotice(
        {
          PLATFORM_DB: authz.ctx.platformDb,
          JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
          PLATFORM_DOMAIN: runtimeEnv.PLATFORM_DOMAIN,
        },
        {
          tenantId: result.tenantId,
          tenantName: result.tenantName,
          tenantHandle: result.handle,
          ownerEmail: result.ownerEmail,
          ownerName: result.ownerName,
          containerId: result.containerId,
          reasonCategory,
          reason: result.killSwitch.reason ?? body.reason.trim(),
          auditId: result.audit?.id ?? null,
          idempotencyKey: idemp.key,
          appBaseUrl,
          emailPort,
          nowMs: authz.ctx.nowMs,
        },
      );
    }

    return consoleJsonResponse(200, {
      success: true,
      requestId,
      replayed: result.replayed,
      action: result.action,
      tenantId: result.tenantId,
      handle: result.handle,
      version: result.version,
      containerId: result.containerId,
      killSwitch: result.killSwitch,
      tenantMirrorSynced: result.tenantMirrorSynced,
      auditId: result.audit?.id ?? null,
      ownerNotification,
    });
  } catch (err) {
    if (err instanceof GtmSettingsDomainError) {
      return consoleErrorResponse(err.status, err.code, err.message, requestId);
    }
    return consoleErrorResponse(
      500,
      "INTERNAL_ERROR",
      "Terjadi kesalahan internal saat memproses kill switch GTM.",
      requestId,
    );
  }
}

export const GET: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly JOBS_QUEUE?: { send(message: unknown): Promise<unknown> };
  };
  return handleConsoleTenantGtmRequest(params.tenantId ?? "", request, {
    ...buildConsoleTenantsRuntimeEnv(runtimeEnv),
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
  });
};

export const POST: APIRoute = ({ params, request }) => {
  const runtimeEnv = env as typeof env & {
    readonly AUTH_SECRET?: string;
    readonly CONSOLE_AUTH_SECRET?: string;
    readonly JOBS_QUEUE?: { send(message: unknown): Promise<unknown> };
  };
  return handleConsoleTenantGtmRequest(params.tenantId ?? "", request, {
    ...buildConsoleTenantsRuntimeEnv(runtimeEnv),
    JOBS_QUEUE: runtimeEnv.JOBS_QUEUE,
  });
};
