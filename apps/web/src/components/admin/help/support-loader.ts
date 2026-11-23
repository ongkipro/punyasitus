import type { DashboardHelpScreenId } from "@punyasitus/core/help/index";
import {
  resolveDashboardSupportModel,
  type AgencySupportContactInput,
  type DashboardSupportViewModel,
  type PlatformSupportSettingsInput,
} from "@punyasitus/core/support/index";
import { getPlatformSettings } from "@punyasitus/db/platform";

const CF_WORKERS_SPECIFIER = `${"cloudflare"}:workers`;

interface AgencySupportLookupRow {
  readonly agency_id: string;
  readonly agency_name: string;
  readonly contact_email: string | null;
}

/**
 * Resolves `PLATFORM_DB` without a static `cloudflare:workers` import so
 * standalone Node Astro builds (such as E2E fixture harnesses) compile cleanly
 * while Cloudflare Workers (`workerd`) resolve `env.PLATFORM_DB` at runtime.
 */
export async function resolvePlatformDbFromRuntime(
  locals: unknown,
): Promise<D1Database | null> {
  try {
    const rec = locals as { platformDb?: D1Database } | null | undefined;
    if (rec?.platformDb) return rec.platformDb;
  } catch {
    // ignore non-standard proxy getters
  }
  try {
    const cf = (await import(/* @vite-ignore */ CF_WORKERS_SPECIFIER)) as {
      env?: { PLATFORM_DB?: D1Database };
    };
    return cf.env?.PLATFORM_DB ?? null;
  } catch {
    return null;
  }
}

/**
 * Read-only lookup of active agency ownership (`agency_client_links` + active `agencies`)
 * for a given tenant in `PLATFORM_DB`.
 *
 * Security invariants:
 * - Strictly requires `agencies.status = 'active'` (suspended/pending agencies NEVER hijack support).
 * - Requires an active `agency_client_links` row (revoked/deleted client links fall back to platform).
 * - Uses ONLY explicit agency contact email from `agency_enrollment_records.billing_email`
 *   via a bounded scalar subquery — NEVER falls back to `users.email` (owner private login email).
 */
export async function lookupTenantAgencySupportContact(
  platformDb: D1Database | null | undefined,
  selector: { readonly tenantId?: string | null; readonly handle?: string | null },
): Promise<AgencySupportContactInput | null> {
  if (!platformDb) return null;

  const tenantId = selector.tenantId?.trim() ?? "";
  const handle = selector.handle?.trim().toLowerCase() ?? "";
  if (!tenantId && !handle) return null;

  const whereClause = tenantId ? "t.id = ?" : "lower(t.handle) = ?";
  const bindValue = tenantId || handle;

  try {
    const row = await platformDb
      .prepare(
        `SELECT
           a.id AS agency_id,
           a.name AS agency_name,
           (
             SELECT aer.billing_email
             FROM agency_enrollment_records aer
             WHERE aer.agency_id = a.id
             ORDER BY aer.updated_at DESC, aer.agency_id DESC
             LIMIT 1
           ) AS contact_email
         FROM tenants t
         INNER JOIN agency_client_links acl ON acl.tenant_id = t.id
         INNER JOIN agencies a ON a.id = acl.agency_id
         WHERE ${whereClause}
           AND t.status != 'purged'
           AND a.status = 'active'
         ORDER BY acl.created_at DESC, acl.tenant_id DESC
         LIMIT 1`,
      )
      .bind(bindValue)
      .first<AgencySupportLookupRow>();

    if (!row) return null;
    return {
      agencyId: row.agency_id,
      agencyName: row.agency_name,
      email: row.contact_email,
    };
  } catch {
    // Fallback for minimal pre-0028 test schemas where `agency_client_links` /
    // `agency_enrollment_records` tables are absent. Still enforces `a.status = 'active'`
    // and NEVER exposes `users.email`.
    try {
      const row = await platformDb
        .prepare(
          `SELECT
             a.id AS agency_id,
             a.name AS agency_name,
             NULL AS contact_email
           FROM tenants t
           INNER JOIN agencies a ON a.id = t.agency_id
           WHERE ${whereClause}
             AND t.status != 'purged'
             AND a.status = 'active'
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT 1`,
        )
        .bind(bindValue)
        .first<AgencySupportLookupRow>();

      if (!row) return null;
      return {
        agencyId: row.agency_id,
        agencyName: row.agency_name,
        email: null,
      };
    } catch {
      return null;
    }
  }
}

export interface LoadDashboardSupportContextOptions {
  readonly tenantId?: string | null;
  readonly handle: string;
  readonly screen: DashboardHelpScreenId | string;
  readonly platformSettingsOverride?: PlatformSupportSettingsInput | null;
  readonly agencyContactOverride?: AgencySupportContactInput | null;
}

/**
 * Server-side read-only loader for the dashboard WhatsApp support entry point
 * (REQ-105, REQ-083, TASK-105).
 *
 * Reads platform WhatsApp number, published hours, and response target from
 * `PLATFORM_DB.platform_settings`, and resolves agency-first routing when the
 * website is linked to an agency via `agency_client_links` / `tenants.agency_id`.
 */
export async function loadDashboardSupportContext(
  platformDb: D1Database | null | undefined,
  options: LoadDashboardSupportContextOptions,
): Promise<DashboardSupportViewModel> {
  let platformSettings: PlatformSupportSettingsInput | null =
    options.platformSettingsOverride ?? null;

  if (!platformSettings && platformDb) {
    try {
      platformSettings = await getPlatformSettings(platformDb);
    } catch {
      platformSettings = null;
    }
  }

  let agencyContact: AgencySupportContactInput | null =
    options.agencyContactOverride ?? null;

  if (!agencyContact && platformDb) {
    agencyContact = await lookupTenantAgencySupportContact(platformDb, {
      tenantId: options.tenantId,
      handle: options.handle,
    });
  }

  return resolveDashboardSupportModel({
    handle: options.handle,
    screen: options.screen,
    platformSettings,
    agencyContact,
  });
}
