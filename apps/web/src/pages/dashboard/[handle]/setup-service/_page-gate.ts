import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  loadTenantSetupServiceState,
  type TenantSetupServiceStateDto,
} from "../../../api/tenants/[tenantId]/service-requests/_shared.ts";

/**
 * Server-side Lifecycle & Role Gate for `/dashboard/[handle]/setup-service`
 * (REQ-070, REQ-034, REQ-065; PLAN §4, §11.4, §18.2; TASK-069).
 *
 * Enforced strictly BEFORE any database reads:
 * - `purging` / `purged` -> neutral `404` (`private, no-store`, `noindex, nofollow`), ZERO DB reads.
 * - `locked` / `suspended` / `recovery` / `operatorHold` -> `302` redirect to
 *   `/dashboard/{handle}/service-status` (`private, no-store`, `noindex, nofollow`), ZERO DB reads.
 * - Role lacking `theme:custom_request` (e.g. `editor`, `setup_staff`) -> `403`
 *   (`private, no-store`, `noindex, nofollow`), ZERO DB reads.
 */

const PRIVATE_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function createNeutralSetupNotFoundHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><link rel="icon" href="data:,"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export function createSetupServiceStatusRedirectResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function createForbiddenSetupServiceHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><link rel="icon" href="data:,"/><title>Akses Ditolak</title></head><body><main><h1>Akses Terbatas</h1><p>Hanya Pemilik Situs atau Admin yang dapat mengakses halaman Layanan Terima Beres.</p></main></body></html>`,
    {
      status: 403,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export interface SetupServicePageGateInput {
  readonly handle: string;
  readonly tenantStatus: TenantStatus;
  readonly role: Role;
  readonly operatorHold?: boolean;
}

export type SetupServicePageGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly response: Response };

export function evaluateSetupServicePageGate(
  input: SetupServicePageGateInput,
): SetupServicePageGateResult {
  if (input.tenantStatus === "purging" || input.tenantStatus === "purged") {
    return { allowed: false, response: createNeutralSetupNotFoundHtmlResponse() };
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
      response: createSetupServiceStatusRedirectResponse(input.handle),
    };
  }

  if (!canPerform(input.role, "theme:custom_request")) {
    return {
      allowed: false,
      response: createForbiddenSetupServiceHtmlResponse(),
    };
  }

  return { allowed: true };
}

export async function loadSetupServicePageOrGateResponse(params: {
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
  | { readonly ok: true; readonly initialState: TenantSetupServiceStateDto }
  | { readonly ok: false; readonly response: Response }
> {
  const gate = evaluateSetupServicePageGate({
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

  const initialState = await loadTenantSetupServiceState(
    params.platformDb,
    params.member,
    params.nowMs ?? Date.now(),
  );
  return { ok: true, initialState };
}
