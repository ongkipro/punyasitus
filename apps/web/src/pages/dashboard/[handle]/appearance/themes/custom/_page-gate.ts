import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  loadTenantCustomThemeServiceState,
  type TenantCustomThemeServiceStateDto,
} from "../../../../../api/tenants/[tenantId]/custom-theme-requests/_shared.ts";

/**
 * Server-side Lifecycle & Role Gate for `/dashboard/[handle]/appearance/themes/custom`
 * (REQ-063, REQ-034, REQ-060; PLAN §4, §11.4 & §17.4; TASK-061).
 *
 * Enforced strictly BEFORE any database reads:
 * - `purging` / `purged` -> neutral `404` (`private, no-store`, `noindex, nofollow`), ZERO DB reads.
 * - `locked` / `suspended` / `recovery` / `operatorHold` -> `302` redirect to
 *   `/dashboard/{handle}/service-status` (`private, no-store`, `noindex, nofollow`), ZERO DB reads.
 *   (PLAN §11.4 & TASK-061: locked tenants CANNOT open the custom theme service page!)
 * - Role lacking `theme:custom_request` (e.g. `editor`) -> `403` (`private, no-store`, `noindex, nofollow`),
 *   ZERO DB reads.
 */

const PRIVATE_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function createNeutralNotFoundHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><link rel="icon" href="data:,"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export function createServiceStatusRedirectResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function createForbiddenCustomThemeHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><link rel="icon" href="data:,"/><title>Akses Ditolak</title></head><body><main><h1>Akses Terbatas</h1><p>Hanya Pemilik Situs atau Admin yang dapat mengakses halaman Layanan Tema Kustom.</p></main></body></html>`,
    {
      status: 403,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export interface CustomThemeServicePageGateInput {
  readonly handle: string;
  readonly tenantStatus: TenantStatus;
  readonly role: Role;
  readonly operatorHold?: boolean;
}

export type CustomThemeServicePageGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly response: Response };

/**
 * Pure lifecycle & RBAC gate evaluated strictly BEFORE touching `PLATFORM_DB` or `TenantStore`.
 */
export function evaluateCustomThemeServicePageGate(
  input: CustomThemeServicePageGateInput,
): CustomThemeServicePageGateResult {
  if (input.tenantStatus === "purging" || input.tenantStatus === "purged") {
    return { allowed: false, response: createNeutralNotFoundHtmlResponse() };
  }

  const lifecycleCheck = isActionAllowedForTenantStatus(
    input.tenantStatus,
    "theme:custom_request",
  );
  if (
    input.operatorHold === true ||
    input.tenantStatus === "locked" ||
    input.tenantStatus === "suspended" ||
    input.tenantStatus === "recovery" ||
    !lifecycleCheck.allowed
  ) {
    return {
      allowed: false,
      response: createServiceStatusRedirectResponse(input.handle),
    };
  }

  if (!canPerform(input.role, "theme:custom_request")) {
    return {
      allowed: false,
      response: createForbiddenCustomThemeHtmlResponse(),
    };
  }

  return { allowed: true };
}

/**
 * Runs `evaluateCustomThemeServicePageGate` BEFORE invoking `platformDb` reads.
 * Guarantees ZERO DB reads on gated (`locked`, `suspended`, `purging`, `purged`, `editor`) states.
 */
export async function loadCustomThemeServicePageOrGateResponse(params: {
  readonly platformDb: D1Database | null | undefined;
  readonly member: {
    readonly tenantId: string;
    readonly handle: string;
    readonly tenantName: string;
    readonly userId: string;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  };
  readonly operatorHold?: boolean;
  readonly nowMs?: number;
}): Promise<
  | { readonly ok: true; readonly initialState: TenantCustomThemeServiceStateDto }
  | { readonly ok: false; readonly response: Response }
> {
  const gate = evaluateCustomThemeServicePageGate({
    handle: params.member.handle,
    tenantStatus: params.member.tenantStatus,
    role: params.member.role,
    operatorHold: params.operatorHold,
  });

  if (!gate.allowed) {
    return { ok: false, response: gate.response };
  }

  if (!params.platformDb || !params.member.tenantId) {
    return {
      ok: false,
      response: new Response("Layanan data platform sementara tidak tersedia.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }),
    };
  }

  const initialState = await loadTenantCustomThemeServiceState(
    params.platformDb,
    params.member,
    params.nowMs ?? Date.now(),
  );
  return { ok: true, initialState };
}
