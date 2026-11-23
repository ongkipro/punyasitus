import { sanitizeErrorCode } from "@punyasitus/core/jobs/index";
import {
  DEFAULT_TENANT_NOTIFICATION_PREFERENCES,
  buildTenantNotificationPrefsKey,
  parseTenantNotificationPreferencesJson,
  type TenantNotificationPreferences,
} from "@punyasitus/core/reports/index";
import { generatePlatformAuditId } from "@punyasitus/db/platform";

/**
 * Per-Tenant Notification Preference Persistence (`REQ-110`, `TASK-110`).
 *
 * Uses existing `PLATFORM_DB.platform_settings` (namespaced key `tenant_notifications:<tenantId>`)
 * with atomic `platform_audit` logging — requiring ZERO new DB migrations.
 */

export interface TenantMonthlyReportDeliveryHistoryItem {
  readonly reportMonth: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly updatedAt: number;
}

export async function getTenantNotificationPreferences(
  platformDb: D1Database,
  tenantId: string,
): Promise<TenantNotificationPreferences> {
  const key = buildTenantNotificationPrefsKey(tenantId);
  const row = await platformDb
    .prepare("SELECT value_json, updated_at FROM platform_settings WHERE key = ? LIMIT 1")
    .bind(key)
    .first<{ readonly value_json: string; readonly updated_at: number | null }>();

  if (!row) {
    return { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES };
  }
  return parseTenantNotificationPreferencesJson(row.value_json, row.updated_at);
}

export interface SetTenantNotificationPreferencesInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly monthlyPerformanceReportEnabled: boolean;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export async function setTenantNotificationPreferences(
  platformDb: D1Database,
  input: SetTenantNotificationPreferencesInput,
): Promise<TenantNotificationPreferences> {
  const key = buildTenantNotificationPrefsKey(input.tenantId);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const valueJson = JSON.stringify({
    monthlyPerformanceReportEnabled: input.monthlyPerformanceReportEnabled,
    updatedAt: nowMs,
  });

  const auditId = generatePlatformAuditId();
  const metadataJson = JSON.stringify({
    monthlyPerformanceReportEnabled: input.monthlyPerformanceReportEnabled,
  });

  await platformDb.batch([
    platformDb
      .prepare(
        `INSERT INTO platform_settings (key, value_json, version, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           version = platform_settings.version + 1,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(key, valueJson, input.actorUserId, nowMs),
    platformDb
      .prepare(
        `INSERT INTO platform_audit (
           id, actor_user_id, actor_role, action, target_type, target_id,
           tenant_id, reason, outcome, request_id, metadata_json, created_at
         ) VALUES (?, ?, 'owner', 'tenant.notifications.updated', 'tenant_notifications', ?, ?, NULL, 'success', ?, ?, ?)`,
      )
      .bind(
        auditId,
        input.actorUserId,
        input.tenantId,
        input.tenantId,
        input.requestId ?? null,
        metadataJson,
        nowMs,
      ),
  ]);

  return {
    monthlyPerformanceReportEnabled: input.monthlyPerformanceReportEnabled,
    updatedAt: nowMs,
  };
}

/**
 * Atomically records a pre-claim `skipped` row in `email_delivery_claims` ONLY when
 * no claim row already exists for `messageKey`.
 *
 * Invariant: NEVER overwrites an existing terminal claim (`submitted`, `failed`, `unknown`, `skipped`)
 * or an active `claimed` row on subsequent hourly cron sweeps or late owner opt-outs.
 */
export async function recordMonthlyReportPreClaimSkipIfUnclaimed(
  platformDb: D1Database,
  input: {
    readonly messageKey: string;
    readonly template: string;
    readonly errorCode: string;
    readonly nowMs?: number;
  },
): Promise<{ readonly inserted: boolean }> {
  const messageKey = input.messageKey.trim();
  const template = input.template.trim();
  const errorCode = sanitizeErrorCode(input.errorCode);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());

  const res = await platformDb
    .prepare(
      `INSERT OR IGNORE INTO email_delivery_claims (
         message_key,
         template,
         one_shot,
         status,
         provider,
         error_code,
         attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, 1, 'skipped', NULL, ?, 0, ?, ?)`,
    )
    .bind(messageKey, template, errorCode, nowMs, nowMs)
    .run();

  return { inserted: (res.meta?.changes ?? 0) === 1 };
}

/**
 * Reads sanitized recent monthly report delivery statuses from `email_delivery_claims`
 * for the owner's notification settings screen (ZERO recipient email or visitor PII).
 *
 * Uses an index-friendly lexicographical range (`>= prefix AND < upperBound`, where
 * `:` = 0x3A and `;` = 0x3B) so `_` or `%` characters inside `tenantId` are never wildcards.
 */
export async function listRecentMonthlyReportDeliveries(
  platformDb: D1Database,
  tenantId: string,
  limit = 6,
): Promise<readonly TenantMonthlyReportDeliveryHistoryItem[]> {
  const cleanTenantId = tenantId.trim();
  const prefix = `monthly-report:${cleanTenantId}:`;
  const upperBound = `monthly-report:${cleanTenantId};`;
  const safeLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  try {
    const res = await platformDb
      .prepare(
        `SELECT message_key, status, error_code, updated_at
         FROM email_delivery_claims
         WHERE message_key >= ? AND message_key < ?
         ORDER BY message_key DESC
         LIMIT ?`,
      )
      .bind(prefix, upperBound, safeLimit)
      .all<{
        readonly message_key: string;
        readonly status: string;
        readonly error_code: string | null;
        readonly updated_at: number;
      }>();

    return (res.results ?? []).map((row) => ({
      reportMonth: row.message_key.slice(prefix.length),
      status: row.status,
      errorCode: row.error_code,
      updatedAt: row.updated_at,
    }));
  } catch {
    // Graceful degradation if email_delivery_claims migration is not yet applied
    return [];
  }
}
