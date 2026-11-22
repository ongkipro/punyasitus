/**
 * Operational alert threshold evaluator matching PLAN §9 and TASK-037.
 * Evaluates pure numeric/age snapshots so CI fixtures and production probes
 * share one authoritative decision contract.
 */

export type TelemetryAlertId =
  | "HTTP_5XX_RATE_HIGH"
  | "IMAGE_JOB_BACKLOG_STALE"
  | "DOMAIN_RECONCILIATION_REPEATED_FAILURE"
  | "PLATFORM_BACKUP_STALE"
  | "AUTOLARIS_ADVICE_STALE";

export type TelemetryAlertSeverity = "warning" | "critical";

export interface TelemetryAlert {
  readonly id: TelemetryAlertId;
  readonly severity: TelemetryAlertSeverity;
  readonly metric: string;
  readonly observed: number | null;
  readonly threshold: number;
  readonly unit: string;
  readonly summary: string;
  readonly runbook: string;
}

export interface AlertThresholds {
  /** 5xx ratio threshold (0.01 = 1%). Alert fires strictly above threshold (`>`). */
  readonly http5xxRateRatio: number;
  /** Minimum observation window in minutes (PLAN §9: 5 minutes). */
  readonly http5xxWindowMinutes: number;
  /** Minimum request volume in window (PLAN §9: >= 100 requests). */
  readonly http5xxMinRequests: number;
  /** Maximum age of oldest pending/running image job in minutes (PLAN §9: > 15 minutes). */
  readonly oldestImageJobMaxAgeMinutes: number;
  /** Consecutive domain reconciliation failures before alerting (PLAN §9: repeated failure). */
  readonly domainReconciliationMinFailures: number;
  /** Maximum age of latest daily `PLATFORM_DB` R2 backup in hours (TASK-037: > 26h). */
  readonly backupMaxAgeHours: number;
  /** Maximum age of latest successful AutoLaris Advice sweep in hours (2 missed hourly cycles). */
  readonly autolarisAdviceMaxAgeHours: number;
}

export const DEFAULT_ALERT_THRESHOLDS: Readonly<AlertThresholds> = {
  http5xxRateRatio: 0.01,
  http5xxWindowMinutes: 5,
  http5xxMinRequests: 100,
  oldestImageJobMaxAgeMinutes: 15,
  domainReconciliationMinFailures: 3,
  backupMaxAgeHours: 26,
  autolarisAdviceMaxAgeHours: 2,
};

export interface Http5xxWindowMetric {
  readonly totalRequests: number;
  readonly serverErrors: number;
  readonly windowMinutes: number;
}

export interface ImageJobBacklogMetric {
  readonly oldestPendingAgeMinutes: number;
  readonly pendingCount?: number;
}

export interface DomainReconciliationMetric {
  readonly consecutiveFailures: number;
  readonly failingHostCount?: number;
}

export interface BackupFreshnessMetric {
  /** Age in hours since the latest verified `PLATFORM_DB` backup; `null` if no backup exists. */
  readonly lastBackupAgeHours: number | null;
}

export interface AutolarisAdviceFreshnessMetric {
  /** Age in hours since the latest completed AutoLaris Advice sweep; `null` if missing/never completed. */
  readonly lastSweepAgeHours: number | null;
  readonly consecutiveFailures?: number;
}

export interface AlertEvaluationSnapshot {
  readonly evaluatedAtMs?: number;
  readonly http5xx?: Http5xxWindowMetric;
  readonly imageJobs?: ImageJobBacklogMetric;
  readonly domainReconciliation?: DomainReconciliationMetric;
  readonly backup?: BackupFreshnessMetric;
  readonly autolarisAdvice?: AutolarisAdviceFreshnessMetric;
}

export interface AlertEvaluationResult {
  readonly status: "ok" | "alert";
  readonly evaluatedAt: string;
  readonly alerts: readonly TelemetryAlert[];
}

/**
 * Evaluates operational telemetry snapshots against PLAN §9 alert thresholds:
 * - HTTP 5xx > 1% for >= 5 minutes with >= 100 requests
 * - Oldest image processing job > 15 minutes
 * - Repeated domain reconciliation failure (>= 3 consecutive failures)
 * - Daily `PLATFORM_DB` backup freshness > 26 hours (or missing)
 * - AutoLaris Advice sweep freshness > 2 hours (or missing / repeated failure)
 */
export function evaluateAlertThresholds(
  snapshot: AlertEvaluationSnapshot,
  overrides?: Partial<AlertThresholds>,
): AlertEvaluationResult {
  const thresholds: AlertThresholds = {
    ...DEFAULT_ALERT_THRESHOLDS,
    ...overrides,
  };
  const evaluatedAt = new Date(snapshot.evaluatedAtMs ?? Date.now()).toISOString();
  const alerts: TelemetryAlert[] = [];

  if (snapshot.http5xx) {
    const { totalRequests, serverErrors, windowMinutes } = snapshot.http5xx;
    const safeTotal = Math.max(0, totalRequests);
    const safeErrors = Math.max(0, serverErrors);
    const rate = safeTotal > 0 ? safeErrors / safeTotal : 0;

    if (
      windowMinutes >= thresholds.http5xxWindowMinutes &&
      safeTotal >= thresholds.http5xxMinRequests &&
      rate > thresholds.http5xxRateRatio
    ) {
      const ratePercent = Number((rate * 100).toFixed(2));
      const thresholdPercent = Number((thresholds.http5xxRateRatio * 100).toFixed(2));
      alerts.push({
        id: "HTTP_5XX_RATE_HIGH",
        severity: rate >= thresholds.http5xxRateRatio * 5 ? "critical" : "warning",
        metric: "http.5xx_rate_percent",
        observed: ratePercent,
        threshold: thresholdPercent,
        unit: "percent",
        summary: `HTTP 5xx rate ${ratePercent}% (${safeErrors}/${safeTotal} requests over ${windowMinutes}m) exceeded ${thresholdPercent}% threshold`,
        runbook: "docs/operations/telemetry-release.md",
      });
    }
  }

  if (snapshot.imageJobs) {
    const ageMinutes = snapshot.imageJobs.oldestPendingAgeMinutes;
    if (Number.isFinite(ageMinutes) && ageMinutes > thresholds.oldestImageJobMaxAgeMinutes) {
      alerts.push({
        id: "IMAGE_JOB_BACKLOG_STALE",
        severity: ageMinutes >= thresholds.oldestImageJobMaxAgeMinutes * 2 ? "critical" : "warning",
        metric: "jobs.image.oldest_pending_age_minutes",
        observed: Number(ageMinutes.toFixed(2)),
        threshold: thresholds.oldestImageJobMaxAgeMinutes,
        unit: "minutes",
        summary: `Oldest pending image processing job is ${ageMinutes.toFixed(1)}m old (threshold > ${thresholds.oldestImageJobMaxAgeMinutes}m)`,
        runbook: "docs/operations/telemetry-release.md",
      });
    }
  }

  if (snapshot.domainReconciliation) {
    const failures = Math.max(0, Math.floor(snapshot.domainReconciliation.consecutiveFailures));
    if (failures >= thresholds.domainReconciliationMinFailures) {
      alerts.push({
        id: "DOMAIN_RECONCILIATION_REPEATED_FAILURE",
        severity: failures >= thresholds.domainReconciliationMinFailures * 2 ? "critical" : "warning",
        metric: "domains.reconciliation.consecutive_failures",
        observed: failures,
        threshold: thresholds.domainReconciliationMinFailures,
        unit: "count",
        summary: `Custom domain reconciliation failed ${failures} consecutive times (threshold >= ${thresholds.domainReconciliationMinFailures})`,
        runbook: "docs/operations/telemetry-release.md",
      });
    }
  }

  if (snapshot.backup) {
    const ageHours = snapshot.backup.lastBackupAgeHours;
    if (ageHours === null || !Number.isFinite(ageHours) || ageHours > thresholds.backupMaxAgeHours) {
      const observed = ageHours === null || !Number.isFinite(ageHours) ? null : Number(ageHours.toFixed(2));
      alerts.push({
        id: "PLATFORM_BACKUP_STALE",
        severity: "critical",
        metric: "backup.platform_db.age_hours",
        observed,
        threshold: thresholds.backupMaxAgeHours,
        unit: "hours",
        summary:
          observed === null
            ? `No verified PLATFORM_DB logical backup found (threshold <= ${thresholds.backupMaxAgeHours}h)`
            : `Latest PLATFORM_DB backup is ${observed}h old (threshold > ${thresholds.backupMaxAgeHours}h)`,
        runbook: "docs/operations/backup-restore.md",
      });
    }
  }

  if (snapshot.autolarisAdvice) {
    const ageHours = snapshot.autolarisAdvice.lastSweepAgeHours;
    const failures = Math.max(0, Math.floor(snapshot.autolarisAdvice.consecutiveFailures ?? 0));
    const isStale =
      ageHours === null ||
      !Number.isFinite(ageHours) ||
      ageHours > thresholds.autolarisAdviceMaxAgeHours;
    const repeatedFail = failures >= thresholds.domainReconciliationMinFailures;

    if (isStale || repeatedFail) {
      const observed = ageHours === null || !Number.isFinite(ageHours) ? null : Number(ageHours.toFixed(2));
      alerts.push({
        id: "AUTOLARIS_ADVICE_STALE",
        severity: observed === null || (observed !== null && observed >= thresholds.autolarisAdviceMaxAgeHours * 2)
          ? "critical"
          : "warning",
        metric: "billing.autolaris_advice.age_hours",
        observed,
        threshold: thresholds.autolarisAdviceMaxAgeHours,
        unit: "hours",
        summary:
          observed === null
            ? `AutoLaris Advice reconciliation sweep has no completed run recorded (threshold <= ${thresholds.autolarisAdviceMaxAgeHours}h)`
            : `AutoLaris Advice reconciliation sweep is ${observed}h old (threshold > ${thresholds.autolarisAdviceMaxAgeHours}h)`,
        runbook: "docs/operations/telemetry-release.md",
      });
    }
  }

  return {
    status: alerts.length > 0 ? "alert" : "ok",
    evaluatedAt,
    alerts,
  };
}
