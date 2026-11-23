import {
  authorizeConsoleRequest,
  consoleNeutralNotFoundResponse,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  resolveConsoleHostContext,
  type AuthorizedConsoleContext,
  type ConsoleHandlerOptions,
} from "@punyasitus/auth/platform/index";
import type { ConsoleTenantsRuntimeEnv } from "../../api/console/tenants/_shared.ts";

/**
 * Server-side SSR page gate for `console.punyasitus.com/console/tenants/**`
 * (TASK-046, REQ-049, REQ-034, REQ-051; PLAN §13).
 *
 * Security invariants:
 * - Non-console hosts (`app.`, tenant hosts, marketing host) ALWAYS receive a bare neutral
 *   `404 Not Found` (`text/plain`) response — NEVER renders "Console Operasional" HTML.
 * - On console host, verifies live session + active `platform_operators` grant + 2FA;
 *   unauthorized / tenant-owner / revoked-operator callers receive a clean `401` / `403`.
 */
export async function authorizeConsoleTenantsPage(
  request: Request,
  runtimeEnv: ConsoleTenantsRuntimeEnv,
  action: string,
  options: ConsoleHandlerOptions = {},
): Promise<
  | {
      readonly ok: true;
      readonly ctx: AuthorizedConsoleContext;
      readonly stepUpFresh: boolean;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    }
> {
  // 1. Strict non-console host boundary FIRST -> bare neutral 404 (zero console copy!)
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return {
      ok: false,
      response: consoleNeutralNotFoundResponse(),
    };
  }

  // 2. Live session + active platform_operators grant + mandatory 2FA
  const authz = await authorizeConsoleRequest(
    request,
    runtimeEnv,
    { action, requireStepUp: false },
    options,
  );

  if (!authz.ok) {
    const status = authz.response.status;
    if (status === 404) {
      return {
        ok: false,
        response: consoleNeutralNotFoundResponse(),
      };
    }

    const title = status === 401 ? "Autentikasi Diperlukan" : "Akses Ditolak";
    const description =
      status === 401
        ? "Masuk dengan akun operator platform terverifikasi 2FA untuk mengakses direktori tenant."
        : "Akun Anda tidak memiliki hak akses operator platform aktif atau belum menyelesaikan verifikasi 2FA.";

    return {
      ok: false,
      response: new Response(
        `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>${title}</title></head><body><main><h1>${title}</h1><p>${description}</p></main></body></html>`,
        {
          status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "private, no-store",
            "x-robots-tag": "noindex, nofollow",
          },
        },
      ),
    };
  }

  const { actor, nowMs } = authz.ctx;
  const stepUpFresh =
    actor.twoFactorVerifiedAtMs !== null &&
    nowMs - actor.twoFactorVerifiedAtMs <= DEFAULT_SECOND_FACTOR_WINDOW_MS;

  return {
    ok: true,
    ctx: authz.ctx,
    stepUpFresh,
  };
}
