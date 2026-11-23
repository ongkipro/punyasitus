import { canPerform } from "@punyasitus/auth";
import type { Role, SurfaceKind, TenantStatus } from "@punyasitus/core/schemas";

/**
 * SSR Lifecycle & RBAC Gate for `/dashboard/[handle]/settings/identity/**`
 * (REQ-091, REQ-044, PLAN §4 & §17.1; TASK-091).
 *
 * CRITICAL SECURITY INVARIANT:
 * Executed strictly BEFORE any `TenantStore` DO binding or SQLite read!
 * - Invalid handle / non-`app` surface / unauthenticated / handle mismatch -> neutral `404`
 * - `purging` / `purged` -> neutral `404`
 * - `suspended` / `recovery` / `operatorHold === true` -> `302` `/dashboard/[handle]/service-status`
 * - Missing `settings:read` (including `editor` role) -> `403`
 * - `locked` -> allowed read-only (`isLocked: true`, mutations disabled, API returns `403 SUBSCRIPTION_LOCKED`)
 * - All responses carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const IDENTITY_SSR_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface IdentitySsrGateInput {
  readonly rawHandle: string | undefined;
  readonly surface: SurfaceKind | "unknown" | string;
  readonly isLocalLoopback: boolean;
  readonly isLocalEnv: boolean;
  readonly authUser: { readonly id: string; readonly name?: string | null; readonly email?: string | null } | null;
  readonly authorized: {
    readonly tenantId: string;
    readonly handle: string;
    readonly role: Role;
    readonly tenantStatus: TenantStatus;
  } | null;
  readonly operatorHold?: boolean;
}

export type IdentitySsrGateResult =
  | {
      readonly ok: true;
      readonly readOnly: boolean;
      readonly isLocked: boolean;
      readonly canWriteSettings: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 302 | 403 | 404;
      readonly reason:
        | "invalid_handle_or_surface"
        | "unauthenticated_or_foreign"
        | "purging_or_purged"
        | "suspended_or_recovery_or_hold"
        | "missing_settings_read";
      readonly response: Response;
    };

function neutralNotFoundResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...IDENTITY_SSR_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

function forbiddenSettingsResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses ditolak</title></head><body><main><h1>Akses ditolak</h1><p>Hanya Pemilik Situs (Owner) atau Admin yang dapat mengakses pengaturan identitas dan profil bisnis.</p></main></body></html>`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...IDENTITY_SSR_SECURITY_HEADERS,
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
      ...IDENTITY_SSR_SECURITY_HEADERS,
    },
  });
}

export function serviceUnavailableIdentitySsrResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Layanan sementara tidak tersedia</title></head><body><main><h1>Layanan sementara tidak tersedia</h1><p>Status layanan situs tidak dapat diverifikasi saat ini. Silakan coba lagi beberapa saat lagi.</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...IDENTITY_SSR_SECURITY_HEADERS,
        "Retry-After": "30",
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function evaluateIdentitySettingsSsrGate(
  input: IdentitySsrGateInput,
): IdentitySsrGateResult {
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

  // 1. Purging / purged tenants MUST return neutral 404 BEFORE any TenantStore DB reads
  if (tenantStatus === "purging" || tenantStatus === "purged") {
    return {
      ok: false,
      status: 404,
      reason: "purging_or_purged",
      response: neutralNotFoundResponse(),
    };
  }

  // 2. Suspended / recovery / operatorHold tenants MUST redirect 302 to service-status BEFORE any TenantStore DB reads
  if (tenantStatus === "suspended" || tenantStatus === "recovery" || input.operatorHold === true) {
    return {
      ok: false,
      status: 302,
      reason: "suspended_or_recovery_or_hold",
      response: redirectToServiceStatusResponse(handle),
    };
  }

  // 3. RBAC gate: strictly requires `settings:read` (Editor role is denied with 403 BEFORE any TenantStore DB reads)
  if (!canPerform(role, "settings:read")) {
    return {
      ok: false,
      status: 403,
      reason: "missing_settings_read",
      response: forbiddenSettingsResponse(),
    };
  }

  // 4. Locked tenant -> read-only access (mutations blocked with 403 SUBSCRIPTION_LOCKED)
  const isLocked = tenantStatus === "locked";
  const canWriteSettings = !isLocked && canPerform(role, "settings:write");

  return {
    ok: true,
    readOnly: !canWriteSettings,
    isLocked,
    canWriteSettings,
  };
}
