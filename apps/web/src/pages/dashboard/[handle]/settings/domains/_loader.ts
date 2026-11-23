import {
  canPerform,
  isActionAllowedForTenantStatus,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
} from "@punyasitus/auth";
import { DEFAULT_SAAS_CNAME_TARGET } from "@punyasitus/core/domains/index";
import { listTenantDomains } from "@punyasitus/db/domains/index";
import {
  PLATFORM_CONSOLE_SETTINGS_KEY,
  type TenantStatus,
  type TenantVertical,
} from "@punyasitus/db/platform";
import { formatDomainRecordResponse } from "../../../../api/tenants/[tenantId]/domains/_shared.ts";
import type { PlatformSupportContactDto, TenantDomainItemDto } from "./_types.ts";

/**
 * Server loader for `/dashboard/[handle]/settings/domains` (TASK-039).
 *
 * Security & lifecycle invariants:
 * - Resolves live DB membership (cross-tenant / unknown handle -> neutral `not_found` 404).
 * - Checks tenant lifecycle status (`isActionAllowedForTenantStatus(..., "domain:read")`) BEFORE
 *   reading ANY `tenants`, `platform_settings`, or `tenant_hosts` rows:
 *   - `purged` -> neutral `404`
 *   - `suspended` / `recovery` / `purging` (or any status disallowing `domain:read`) ->
 *     `302` redirect to `/dashboard/<handle>/service-status` with ZERO domain data/tokens loaded!
 * - `editor` (lacks `domain:read`) -> `403` permission denial with ZERO domain records loaded!
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export interface LoadDomainsSettingsPageInput {
  readonly rawHandle: string;
  readonly surface: string;
  readonly isLocalLoopback: boolean;
  readonly platformDb: D1Database | null | undefined;
  readonly authUser: { readonly id: string; readonly name: string } | null | undefined;
  readonly preResolvedMember?: AuthorizedTenantMember | null;
  readonly activeOrganizationId?: string | null;
  readonly saasZone?: string;
  readonly cnameTarget?: string;
  readonly nowMs?: number;
}

export type DomainsSettingsPageLoadResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "redirect"; readonly location: string }
  | {
      readonly kind: "render";
      readonly httpStatus: 200 | 403;
      readonly authorized: AuthorizedTenantMember;
      readonly vertical?: TenantVertical;
      readonly operatorHoldReason: string | null;
      readonly trialEndsAtMs: number | null;
      readonly canReadDomains: boolean;
      readonly canManageDomains: boolean;
      readonly saasZone: string;
      readonly cnameTarget: string;
      readonly supportContact: PlatformSupportContactDto;
      readonly initialItems: readonly TenantDomainItemDto[];
      readonly initialCustomDomainLocked: boolean;
      readonly maxCustomHostnames: number;
    };

export async function loadDomainsSettingsPage(
  input: LoadDomainsSettingsPageInput,
): Promise<DomainsSettingsPageLoadResult> {
  const rawHandle = input.rawHandle.trim().toLowerCase();

  // 1. Strict app-host isolation & valid handle syntax
  if (!HANDLE_RE.test(rawHandle) || (!input.isLocalLoopback && input.surface !== "app")) {
    return { kind: "not_found" };
  }

  if (!input.authUser || !input.platformDb) {
    return { kind: "not_found" };
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  // 2. Live DB membership re-check (neutral 404 on cross-tenant / unknown handle)
  let authorized = input.preResolvedMember ?? null;
  if (!authorized || authorized.handle !== rawHandle) {
    try {
      authorized = await resolveAuthorizedTenantMember(input.platformDb, {
        userId: input.authUser.id,
        handle: rawHandle,
        surface: "app",
        claimedOrganizationId: input.activeOrganizationId ?? null,
        nowMs,
      });
    } catch {
      return { kind: "not_found" };
    }
  }

  if (!authorized) {
    return { kind: "not_found" };
  }

  // 3. LIFECYCLE GATE BEFORE ANY DB READS (prevents leaking domain rows / DCV tokens on suspended/recovery/purging/purged!)
  const tenantStatus: TenantStatus = authorized.tenantStatus;
  if (tenantStatus === "purged") {
    return { kind: "not_found" };
  }

  const lifecycleCheck = isActionAllowedForTenantStatus(tenantStatus, "domain:read");
  if (
    !lifecycleCheck.allowed ||
    tenantStatus === "suspended" ||
    tenantStatus === "recovery" ||
    tenantStatus === "purging"
  ) {
    return {
      kind: "redirect",
      location: `/dashboard/${encodeURIComponent(authorized.handle)}/service-status`,
    };
  }

  // 4. RBAC check BEFORE reading domain tokens/records
  const canReadDomains = canPerform(authorized.role, "domain:read");
  const canManageDomains = canPerform(authorized.role, "domain:connect");

  const saasZone = (input.saasZone ?? "situsku.click").trim().toLowerCase();
  const cnameTarget =
    input.cnameTarget?.trim().toLowerCase().replace(/\.$/, "") ||
    (saasZone ? `cname.${saasZone}` : DEFAULT_SAAS_CNAME_TARGET);

  const tenantMeta = await input.platformDb
    .prepare(
      `SELECT vertical, operator_hold_reason, trial_ends_at
       FROM tenants
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(authorized.tenantId)
    .first<{
      readonly vertical: TenantVertical;
      readonly operator_hold_reason: string | null;
      readonly trial_ends_at: number | null;
    }>();

  // Default support contact; only query platform_settings when user can read domains
  let supportContact: PlatformSupportContactDto = {
    salesWhatsappHref: null,
    salesWhatsappDisplay: null,
    supportEmail: "support@punyasitus.com",
  };

  let initialItems: readonly TenantDomainItemDto[] = [];
  let initialCustomDomainLocked = false;
  let maxCustomHostnames = 2;

  if (canReadDomains) {
    try {
      const settingsRow = await input.platformDb
        .prepare(`SELECT value_json FROM platform_settings WHERE key = ? LIMIT 1`)
        .bind(PLATFORM_CONSOLE_SETTINGS_KEY)
        .first<{ readonly value_json: string }>();
      if (settingsRow?.value_json) {
        const parsed = JSON.parse(settingsRow.value_json) as {
          readonly salesWhatsapp?: string;
          readonly supportEmail?: string;
        };
        const digits = (parsed.salesWhatsapp ?? "").replace(/\D/g, "");
        const message = encodeURIComponent(
          `Halo Admin PunyaSitus, saya ingin mengajukan penggantian/penghapusan domain aktif untuk situs ${authorized.handle}.`,
        );
        supportContact = {
          salesWhatsappHref: digits.length >= 8 ? `https://wa.me/${digits}?text=${message}` : null,
          salesWhatsappDisplay: parsed.salesWhatsapp ?? null,
          supportEmail: parsed.supportEmail?.trim() || "support@punyasitus.com",
        };
      }
    } catch {
      // Keep safe default support email if settings table has no custom row yet
    }

    const listed = await listTenantDomains(input.platformDb, authorized.tenantId);
    initialItems = listed.items.map(
      (record) =>
        formatDomainRecordResponse(record, {
          cnameTarget,
          nowMs,
        }) as unknown as TenantDomainItemDto,
    );
    initialCustomDomainLocked = listed.customDomainLocked;
    maxCustomHostnames = listed.maxCustomHostnames;
  }

  return {
    kind: "render",
    httpStatus: canReadDomains ? 200 : 403,
    authorized,
    vertical: tenantMeta?.vertical,
    operatorHoldReason: tenantMeta?.operator_hold_reason ?? null,
    trialEndsAtMs: tenantMeta?.trial_ends_at ?? null,
    canReadDomains,
    canManageDomains,
    saasZone,
    cnameTarget,
    supportContact,
    initialItems,
    initialCustomDomainLocked,
    maxCustomHostnames,
  };
}
