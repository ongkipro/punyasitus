import { canPerform, isActionAllowedForTenantStatus } from "@punyasitus/auth";
import type { Role, TenantStatus } from "@punyasitus/core/schemas";
import {
  loadTenantPresetState,
  loadVerticalPresetDashboardState,
  type PresetMemberScope,
  type TenantPresetStateDto,
  type VerticalPresetDashboardStateDto,
} from "@punyasitus/db/presets/index";

/**
 * Server-side Lifecycle & RBAC Gate for `/dashboard/[handle]/onboarding` and
 * `/dashboard/[handle]/appearance/presets`
 * (REQ-047, REQ-034, REQ-059, REQ-060; PLAN §11.4 & §17.1; TASK-043).
 *
 * Enforced strictly BEFORE opening `TenantStore` or calling `loadTenantPresetState`:
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

export function createNeutralPresetNotFoundHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export function createPresetServiceStatusRedirectResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function createForbiddenPresetHtmlResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Ditolak</title></head><body><main><h1>Akses Terbatas</h1><p>Hanya Pemilik Situs atau Admin yang dapat mengakses pengaturan Preset Pemula dan Onboarding.</p></main></body></html>`,
    {
      status: 403,
      headers: PRIVATE_HTML_HEADERS,
    },
  );
}

export interface PresetPageGateInput {
  readonly handle: string;
  readonly tenantStatus: TenantStatus;
  readonly role: Role;
  readonly operatorHold?: boolean;
}

export type PresetPageGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly response: Response };

/**
 * Pure lifecycle & RBAC gate evaluated BEFORE touching `TenantStore`.
 */
export function evaluatePresetPageGate(input: PresetPageGateInput): PresetPageGateResult {
  if (input.tenantStatus === "purging" || input.tenantStatus === "purged") {
    return { allowed: false, response: createNeutralPresetNotFoundHtmlResponse() };
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
      response: createPresetServiceStatusRedirectResponse(input.handle),
    };
  }

  if (!canPerform(input.role, "settings:read")) {
    return {
      allowed: false,
      response: createForbiddenPresetHtmlResponse(),
    };
  }

  return { allowed: true };
}

/**
 * Runs `evaluatePresetPageGate` BEFORE invoking `resolveTenantDb` or loading
 * `loadTenantPresetState`. Guarantees ZERO `TenantStore` reads on gated states.
 */
export async function loadPresetPageOrGateResponse(params: {
  readonly platformDb: D1Database | null | undefined;
  readonly member: PresetMemberScope;
  readonly operatorHold?: boolean;
  readonly resolveTenantDb: () => Promise<D1Database | null> | D1Database | null;
}): Promise<
  | { readonly ok: true; readonly initialState: TenantPresetStateDto }
  | { readonly ok: false; readonly response: Response }
> {
  const gate = evaluatePresetPageGate({
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

  const initialState = await loadTenantPresetState(
    params.platformDb,
    tenantDb,
    params.member,
  );
  return { ok: true, initialState };
}

/**
 * Extended SSR lifecycle & RBAC gate for `/dashboard/[handle]/onboarding` (TASK-066, M2).
 * Evaluates `evaluatePresetPageGate` strictly BEFORE opening `TenantStore`, then loads
 * both the M1-compatible `initialState` and the M2 4-vertical `verticalState`.
 */
export async function loadVerticalOnboardingPageOrGateResponse(params: {
  readonly platformDb: D1Database | null | undefined;
  readonly member: PresetMemberScope;
  readonly operatorHold?: boolean;
  readonly resolveTenantDb: () => Promise<D1Database | null> | D1Database | null;
}): Promise<
  | {
      readonly ok: true;
      readonly initialState: TenantPresetStateDto;
      readonly verticalState: VerticalPresetDashboardStateDto;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const gate = evaluatePresetPageGate({
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

  const [initialState, verticalState] = await Promise.all([
    loadTenantPresetState(params.platformDb, tenantDb, params.member),
    loadVerticalPresetDashboardState(params.platformDb, tenantDb, params.member),
  ]);
  return { ok: true, initialState, verticalState };
}
