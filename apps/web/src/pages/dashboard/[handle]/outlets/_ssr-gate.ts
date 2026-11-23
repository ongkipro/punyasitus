import { canPerform } from "@punyasitus/auth";
import type { Role, SurfaceKind, TenantStatus } from "@punyasitus/core/schemas";

/**
 * SSR Lifecycle & RBAC Gate for `/dashboard/[handle]/outlets/**`
 * (REQ-029, REQ-034, PLAN §4 & §17.1; TASK-019).
 *
 * Executed strictly BEFORE any `TenantStore` DO binding or SQLite read:
 * - Invalid handle / non-`app` surface / unauthenticated / foreign handle -> neutral `404`
 * - `provisioning` / `purging` / `purged` -> neutral `404`
 * - `suspended` / `recovery` / `operatorHold === true` -> `302` `/dashboard/[handle]/service-status`
 * - Missing `content:read` -> `403`
 * - `editor` role -> READ-ONLY (`readOnly: true, canManageOutlets: false`)
 * - `locked` tenant -> READ-ONLY (`isLocked: true, canManageOutlets: false`)
 * - All responses carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const OUTLETS_SSR_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface OutletsSsrGateInput {
  readonly rawHandle: string | undefined;
  readonly surface: SurfaceKind | "unknown" | string;
  readonly isLocalLoopback: boolean;
  readonly isLocalEnv: boolean;
  readonly authUser: {
    readonly id: string;
    readonly name?: string | null;
    readonly email?: string | null;
  } | null;
  readonly authorized: {
    readonly tenantId: string;
    readonly handle: string;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  } | null;
  readonly operatorHold?: boolean;
}

export type OutletsSsrGateResult =
  | {
      readonly ok: true;
      readonly readOnly: boolean;
      readonly isLocked: boolean;
      readonly canManageOutlets: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 302 | 403 | 404;
      readonly reason:
        | "invalid_handle_or_surface"
        | "unauthenticated_or_foreign"
        | "provisioning_or_purging_or_purged"
        | "suspended_or_recovery_or_hold"
        | "missing_content_read";
      readonly response: Response;
    };

function neutralNotFoundResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...OUTLETS_SSR_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

function forbiddenOutletsResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses ditolak</title></head><body><main><h1>Akses ditolak</h1><p>Peran akun Anda tidak memiliki izin untuk melihat halaman direktori gerai.</p></main></body></html>`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...OUTLETS_SSR_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

function redirectToServiceStatusResponse(handle: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/dashboard/${encodeURIComponent(handle)}/service-status`,
      ...OUTLETS_SSR_SECURITY_HEADERS,
    },
  });
}

export function serviceUnavailableOutletsSsrResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Layanan sementara tidak tersedia</title></head><body><main><h1>Layanan sementara tidak tersedia</h1><p>Status layanan situs tidak dapat diverifikasi saat ini. Silakan coba lagi beberapa saat lagi.</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...OUTLETS_SSR_SECURITY_HEADERS,
        "Retry-After": "30",
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function evaluateOutletsSsrGate(input: OutletsSsrGateInput): OutletsSsrGateResult {
  const normalizedHandle = (input.rawHandle ?? "").trim().toLowerCase();
  const allowedLocalLoopback = input.isLocalLoopback && input.isLocalEnv;

  if (!HANDLE_RE.test(normalizedHandle) || (!allowedLocalLoopback && input.surface !== "app")) {
    return {
      ok: false,
      status: 404,
      reason: "invalid_handle_or_surface",
      response: neutralNotFoundResponse(),
    };
  }

  if (
    !input.authUser ||
    !input.authorized ||
    input.authorized.handle.toLowerCase() !== normalizedHandle
  ) {
    return {
      ok: false,
      status: 404,
      reason: "unauthenticated_or_foreign",
      response: neutralNotFoundResponse(),
    };
  }

  const { role, tenantStatus, handle } = input.authorized;

  if (
    tenantStatus === "provisioning" ||
    tenantStatus === "purging" ||
    tenantStatus === "purged"
  ) {
    return {
      ok: false,
      status: 404,
      reason: "provisioning_or_purging_or_purged",
      response: neutralNotFoundResponse(),
    };
  }

  if (tenantStatus === "suspended" || tenantStatus === "recovery" || input.operatorHold === true) {
    return {
      ok: false,
      status: 302,
      reason: "suspended_or_recovery_or_hold",
      response: redirectToServiceStatusResponse(handle),
    };
  }

  if (!canPerform(role, "content:read")) {
    return {
      ok: false,
      status: 403,
      reason: "missing_content_read",
      response: forbiddenOutletsResponse(),
    };
  }

  const isLocked = tenantStatus === "locked";
  const canManageOutlets = !isLocked && canPerform(role, "outlet:manage");

  return {
    ok: true,
    readOnly: !canManageOutlets,
    isLocked,
    canManageOutlets,
  };
}
