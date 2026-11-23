import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  loadTenantThemeLibraryState,
  type ThemeLibraryMemberScope,
  type ThemeLibraryStateDto,
} from "../../../../api/tenants/[tenantId]/themes/_shared.ts";

/**
 * Server-side Lifecycle & Role Gate for `/dashboard/[handle]/appearance/themes`
 * (REQ-046, REQ-034, REQ-059, REQ-060; PLAN §4 & §17.1; TASK-042).
 *
 * Enforced strictly BEFORE opening `TenantStore` or calling `loadTenantThemeLibraryState`:
 * - `purging` / `purged` -> neutral `404` (`private, no-store`, `noindex, nofollow`), ZERO tenant DB reads.
 * - `suspended` / `recovery` / `operatorHold` / disallowed lifecycle status -> `302` redirect to
 *   `/dashboard/{handle}/service-status` (`private, no-store`, `noindex, nofollow`), ZERO tenant DB reads.
 * - Role lacking `settings:read` (e.g. `editor`) -> `403` (`private, no-store`, `noindex, nofollow`),
 *   ZERO tenant DB reads.
 */

const PRIVATE_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function createNeutralNotFoundHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
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

export function createForbiddenThemeLibraryHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Ditolak</title></head><body><main><h1>Akses Terbatas</h1><p>Hanya Pemilik Situs atau Admin yang dapat mengakses Perpustakaan Tema.</p></main></body></html>`,
    {
      status: 403,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export interface ThemeLibraryPageGateInput {
  readonly handle: string;
  readonly tenantStatus: TenantStatus;
  readonly role: Role;
  readonly operatorHold?: boolean;
}

export type ThemeLibraryPageGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly response: Response };

/**
 * Pure lifecycle & RBAC gate evaluated BEFORE touching `TenantStore`.
 */
export function evaluateThemeLibraryPageGate(
  input: ThemeLibraryPageGateInput,
): ThemeLibraryPageGateResult {
  if (input.tenantStatus === "purging" || input.tenantStatus === "purged") {
    return { allowed: false, response: createNeutralNotFoundHtmlResponse() };
  }

  const lifecycleCheck = isActionAllowedForTenantStatus(input.tenantStatus, "settings:read");
  if (
    input.operatorHold === true ||
    input.tenantStatus === "suspended" ||
    input.tenantStatus === "recovery" ||
    !lifecycleCheck.allowed
  ) {
    return {
      allowed: false,
      response: createServiceStatusRedirectResponse(input.handle),
    };
  }

  if (!canPerform(input.role, "settings:read")) {
    return {
      allowed: false,
      response: createForbiddenThemeLibraryHtmlResponse(),
    };
  }

  return { allowed: true };
}

/**
 * Runs `evaluateThemeLibraryPageGate` BEFORE invoking `resolveTenantDb` or loading
 * `loadTenantThemeLibraryState`. Guarantees ZERO `TenantStore` reads on gated states.
 */
export async function loadThemeLibraryPageOrGateResponse(params: {
  readonly platformDb: D1Database | null | undefined;
  readonly member: ThemeLibraryMemberScope;
  readonly operatorHold?: boolean;
  readonly resolveTenantDb: () => Promise<D1Database | null> | D1Database | null;
}): Promise<
  | { readonly ok: true; readonly initialState: ThemeLibraryStateDto }
  | { readonly ok: false; readonly response: Response }
> {
  const gate = evaluateThemeLibraryPageGate({
    handle: params.member.handle,
    tenantStatus: params.member.tenantStatus,
    role: params.member.role,
    operatorHold: params.operatorHold,
  });

  if (!gate.allowed) {
    return { ok: false, response: gate.response };
  }

  const tenantDb = await params.resolveTenantDb();
  if (!tenantDb || !params.member.tenantId || !params.platformDb) {
    return {
      ok: false,
      response: new Response("Penyimpanan data tenant sementara tidak tersedia.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      }),
    };
  }

  const initialState = await loadTenantThemeLibraryState(
    params.platformDb,
    tenantDb,
    params.member,
  );
  return { ok: true, initialState };
}
