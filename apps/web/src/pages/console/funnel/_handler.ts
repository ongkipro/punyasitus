import {
  authorizeConsoleRequest,
  DEFAULT_SECOND_FACTOR_WINDOW_MS,
  type ConsoleHandlerOptions,
  type ConsoleRuntimeEnv,
} from "@punyasitus/auth/platform/index";
import {
  parseFunnelRangeDays,
  type FunnelRangeDays,
} from "@punyasitus/core/marketing/index";
import {
  getFunnelSummary,
  type FunnelSummaryReport,
} from "@punyasitus/db/marketing/index";

/**
 * Shared authorized loader & HTTP responder for `console.punyasitus.com/console/funnel`
 * (REQ-087, REQ-051, PLAN §13 & §19.5, TASK-087).
 *
 * Security invariants:
 * - Strictly requires `console` host + active 2FA platform operator via `authorizeConsoleRequest`.
 * - Non-operators get `403`, unauthenticated callers get `401`, wrong hosts get `404`.
 * - Always emits `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

export type ConsoleFunnelLoadResult =
  | {
      readonly ok: true;
      readonly host: string;
      readonly actorName: string;
      readonly actorRoleLabel: string;
      readonly stepUpFresh: boolean;
      readonly rangeDays: FunnelRangeDays;
      readonly summary: FunnelSummaryReport;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly deniedResponse: Response;
    };

export async function loadConsoleFunnelViewData(
  request: Request,
  consoleEnv: ConsoleRuntimeEnv,
  options: ConsoleHandlerOptions = {},
): Promise<ConsoleFunnelLoadResult> {
  const authz = await authorizeConsoleRequest(
    request,
    consoleEnv,
    { action: "console.funnel.view", requireStepUp: false },
    options,
  );

  if (!authz.ok) {
    // On non-console hosts (`404`), return a bare neutral response without disclosing console existence.
    if (authz.response.status === 404) {
      return {
        ok: false,
        status: 404,
        deniedResponse: new Response("Not Found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Robots-Tag": "noindex, nofollow",
          },
        }),
      };
    }

    const deniedResponse = new Response(
      `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Console Operasional Dibatasi</title></head><body><main><h1>Akses Console Operasional Dibatasi</h1><p>Halaman analitik funnel hanya tersedia bagi operator platform aktif dengan 2FA terverifikasi di host console.</p></main></body></html>`,
      {
        status: authz.response.status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
    return {
      ok: false,
      status: authz.response.status,
      deniedResponse,
    };
  }

  const { actor, platformDb, nowMs, host } = authz.ctx;
  const reqUrl = new URL(request.url);
  const rangeDays = parseFunnelRangeDays(reqUrl.searchParams.get("range"));
  const summary = await getFunnelSummary(platformDb, rangeDays, { nowMs });

  const stepUpFresh =
    actor.twoFactorVerifiedAtMs !== null &&
    nowMs - actor.twoFactorVerifiedAtMs <= DEFAULT_SECOND_FACTOR_WINDOW_MS;

  return {
    ok: true,
    host: host.host,
    actorName: actor.grant.name ?? actor.grant.email ?? "Operator Platform",
    actorRoleLabel:
      actor.grant.role === "platform_support" ? "Dukungan Platform" : "Superadmin Platform",
    stepUpFresh,
    rangeDays,
    summary,
  };
}
