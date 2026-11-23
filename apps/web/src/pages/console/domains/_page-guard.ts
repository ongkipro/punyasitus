import {
  authorizeConsoleRequest,
  consoleNeutralNotFoundResponse,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  resolveConsoleHostContext,
  type AuthorizedConsoleContext,
  type ConsoleHandlerOptions,
} from "@punyasitus/auth/platform/index";
import type { ConsoleDomainsRuntimeEnv } from "../../api/console/domains/_shared.ts";

/**
 * Server-side SSR page gate for `console.punyasitus.com/console/domains/**`
 * (`TASK-047`, `REQ-050`, `REQ-034`, `REQ-051`; `PLAN §13`).
 *
 * Security invariants:
 * - Non-console hosts ALWAYS receive a bare neutral `404 Not Found` (`text/plain`).
 * - Verifies live session + active `platform_operators` grant + mandatory 2FA.
 */
export async function authorizeConsoleDomainsPage(
  request: Request,
  runtimeEnv: ConsoleDomainsRuntimeEnv,
  action = "console.domains.page.view",
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
  const host = resolveConsoleHostContext(request, runtimeEnv);
  if (!host) {
    return {
      ok: false,
      response: consoleNeutralNotFoundResponse(),
    };
  }

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
        ? "Masuk dengan akun operator platform terverifikasi 2FA untuk mengakses antrean pemulihan domain."
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
