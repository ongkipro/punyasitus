import type { Role, SurfaceKind, TenantStatus } from "@punyasitus/core/schemas";

/**
 * Owner-Only SSR Lifecycle & RBAC Gate for `/dashboard/[handle]/settings/data`
 * (REQ-107, PLAN §20.4, TASK-107).
 *
 * Security invariants:
 * - Executed strictly BEFORE any `TenantStore` binding or export/deletion queries!
 * - Invalid handle / non-`app` surface / unauthenticated / handle mismatch -> neutral `404`.
 * - `purging` / `purged` -> neutral `404`.
 * - Strictly **Owner ONLY** (`role === "owner"` AND `dbRole === "owner"`);
 *   `admin`, `editor`, `agency_staff`, and `setup_staff` receive `403`.
 * - Owner CAN access `/settings/data` in `active`, `trial`, `grace`, `locked`, AND `suspended`
 *   (so owners can download archives or cancel a pending self-service deletion during the 7-day
 *   undo window!).
 * - All responses carry `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const DATA_SETTINGS_SSR_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export interface DataSettingsSsrGateInput {
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
    readonly dbRole?: "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";
    readonly tenantStatus: TenantStatus;
  } | null;
}

export type DataSettingsSsrGateResult =
  | {
      readonly ok: true;
      readonly tenantId: string;
      readonly handle: string;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404;
      readonly reason:
        | "invalid_handle_or_surface"
        | "unauthenticated_or_foreign"
        | "purging_or_purged"
        | "owner_only_required";
      readonly response: Response;
    };

function neutralNotFoundResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Halaman tidak ditemukan</title></head><body><main><h1>Halaman tidak ditemukan</h1></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...DATA_SETTINGS_SSR_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

function forbiddenOwnerOnlyResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Akses Ditolak</title></head><body><main><h1>Akses Ditolak</h1><p>Hanya Pemilik Situs (Owner) yang dapat mengakses ekspor arsip data penuh dan penghapusan situs.</p></main></body></html>`,
    {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...DATA_SETTINGS_SSR_SECURITY_HEADERS,
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function serviceUnavailableDataSsrResponse(): Response {
  return new Response(
    `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Layanan sementara tidak tersedia</title></head><body><main><h1>Layanan sementara tidak tersedia</h1><p>Status data situs tidak dapat diverifikasi saat ini. Silakan coba lagi beberapa saat lagi.</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...DATA_SETTINGS_SSR_SECURITY_HEADERS,
        "Retry-After": "30",
        "Content-Security-Policy": "default-src 'none'",
      },
    },
  );
}

export function evaluateDataSettingsSsrGate(
  input: DataSettingsSsrGateInput,
): DataSettingsSsrGateResult {
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

  const { tenantId, handle, role, dbRole, tenantStatus } = input.authorized;

  if (tenantStatus === "purging" || tenantStatus === "purged") {
    return {
      ok: false,
      status: 404,
      reason: "purging_or_purged",
      response: neutralNotFoundResponse(),
    };
  }

  // Strictly Owner ONLY (denies admin, editor, agency_staff, setup_staff)
  if (role !== "owner" || (dbRole !== undefined && dbRole !== "owner")) {
    return {
      ok: false,
      status: 403,
      reason: "owner_only_required",
      response: forbiddenOwnerOnlyResponse(),
    };
  }

  return {
    ok: true,
    tenantId,
    handle,
  };
}
