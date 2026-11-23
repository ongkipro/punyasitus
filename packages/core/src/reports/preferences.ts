import { z } from "zod";

/**
 * Pure Schema & Key Conventions for Per-Tenant Notification Preferences (`REQ-110`, `TASK-110`).
 *
 * Persisted in existing `PLATFORM_DB.platform_settings` under a strictly tenant-scoped key
 * (`tenant_notifications:<tenantId>`) without requiring any new DB migration.
 */

export const TENANT_NOTIFICATION_PREFS_KEY_PREFIX = "tenant_notifications:" as const;

export const TenantNotificationPreferencesSchema = z.strictObject({
  monthlyPerformanceReportEnabled: z.boolean(),
  updatedAt: z.number().int().nonnegative().nullable().optional(),
});

export type TenantNotificationPreferences = {
  readonly monthlyPerformanceReportEnabled: boolean;
  readonly updatedAt: number | null;
};

export const UpdateTenantNotificationPreferencesSchema = z.strictObject({
  monthlyPerformanceReportEnabled: z.boolean(),
});

export type UpdateTenantNotificationPreferencesInput = z.infer<
  typeof UpdateTenantNotificationPreferencesSchema
>;

export const DEFAULT_TENANT_NOTIFICATION_PREFERENCES: TenantNotificationPreferences = {
  monthlyPerformanceReportEnabled: true,
  updatedAt: null,
} as const;

export function buildTenantNotificationPrefsKey(tenantId: string): string {
  const clean = tenantId.trim();
  if (!clean || clean.length > 128 || /[\r\n\0]/.test(clean)) {
    throw new RangeError("INVALID_TENANT_ID: tenantId must be a non-empty clean identifier");
  }
  return `${TENANT_NOTIFICATION_PREFS_KEY_PREFIX}${clean}`;
}

export function parseTenantNotificationPreferencesJson(
  rawJson: string | null | undefined,
  fallbackUpdatedAt: number | null = null,
): TenantNotificationPreferences {
  if (!rawJson) {
    return { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES };
  }
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const validated = TenantNotificationPreferencesSchema.safeParse(parsed);
    if (!validated.success) {
      return { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES };
    }
    return {
      monthlyPerformanceReportEnabled: validated.data.monthlyPerformanceReportEnabled,
      updatedAt: validated.data.updatedAt ?? fallbackUpdatedAt,
    };
  } catch {
    return { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES };
  }
}
