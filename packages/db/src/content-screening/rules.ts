import {
  DEFAULT_CONTENT_SCREENING_RULES,
  mergeScreeningRules,
  validateScreeningRuleInput,
  type ContentScreeningRule,
  type ScreeningCategory,
  type ScreeningRuleType,
  type ScreeningSeverity,
} from "@punyasitus/core/content-screening/index";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  PlatformAuditError,
  validateOperatorReason,
} from "../platform/audit.ts";
import { ContentScreeningError } from "./errors.ts";

/**
 * Versioned operator-editable screening rule repository (`PLATFORM_DB.content_screening_rules`;
 * REQ-103, PLAN §20.1, TASK-103).
 */

interface ScreeningRuleDbRow {
  readonly id: string;
  readonly rule_type: ScreeningRuleType;
  readonly pattern: string;
  readonly category: ScreeningCategory;
  readonly severity: ScreeningSeverity;
  readonly active: number;
  readonly rule_version: number;
  readonly notes: string | null;
  readonly created_by: string | null;
  readonly updated_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ScreeningRuleRecord extends ContentScreeningRule {
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

function mapDbRowToRule(row: ScreeningRuleDbRow): ScreeningRuleRecord {
  return {
    id: row.id,
    ruleType: row.rule_type,
    pattern: row.pattern,
    category: row.category,
    severity: row.severity,
    active: Number(row.active) === 1,
    ruleVersion: Number(row.rule_version),
    source: "operator",
    notes: row.notes,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Loads the active effective screening ruleset by merging built-in rules with operator rules
 * stored in `PLATFORM_DB.content_screening_rules`.
 */
export async function loadActiveScreeningRuleset(platformDb: D1Database): Promise<{
  readonly rules: readonly ContentScreeningRule[];
  readonly rulesetVersion: number;
}> {
  let operatorRules: ContentScreeningRule[] = [];
  try {
    const res = await platformDb
      .prepare(
        `SELECT id, rule_type, pattern, category, severity, active, rule_version,
                notes, created_by, updated_by, created_at, updated_at
         FROM content_screening_rules
         ORDER BY updated_at DESC, id DESC
         LIMIT 2000`,
      )
      .all<ScreeningRuleDbRow>();
    operatorRules = (res.results ?? []).map(mapDbRowToRule);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Graceful fallback only if migration 0025 has not been applied in legacy test fixtures
    if (!msg.includes("no such table")) {
      throw err;
    }
  }

  return mergeScreeningRules(operatorRules, DEFAULT_CONTENT_SCREENING_RULES);
}

/**
 * Lists all operator-managed rules alongside built-in defaults for the Console UI.
 */
export async function listScreeningRules(platformDb: D1Database): Promise<{
  readonly operatorRules: readonly ScreeningRuleRecord[];
  readonly builtinRulesCount: number;
  readonly effectiveActiveCount: number;
  readonly rulesetVersion: number;
}> {
  const res = await platformDb
    .prepare(
      `SELECT id, rule_type, pattern, category, severity, active, rule_version,
              notes, created_by, updated_by, created_at, updated_at
       FROM content_screening_rules
       ORDER BY active DESC, updated_at DESC, id DESC
       LIMIT 500`,
    )
    .all<ScreeningRuleDbRow>();

  const operatorRules = (res.results ?? []).map(mapDbRowToRule);
  const merged = mergeScreeningRules(operatorRules, DEFAULT_CONTENT_SCREENING_RULES);

  return {
    operatorRules,
    builtinRulesCount: DEFAULT_CONTENT_SCREENING_RULES.length,
    effectiveActiveCount: merged.rules.length,
    rulesetVersion: merged.rulesetVersion,
  };
}

export interface UpsertScreeningRuleInput {
  readonly ruleType: unknown;
  readonly pattern: unknown;
  readonly category: unknown;
  readonly severity?: unknown;
  readonly active?: unknown;
  readonly notes?: unknown;
  readonly reason: unknown;
  readonly actorUserId: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface UpsertScreeningRuleResult {
  readonly rule: ScreeningRuleRecord;
  readonly auditId: string;
  readonly created: boolean;
}

/**
 * Creates or updates a versioned screening rule in `PLATFORM_DB` atomically with `platform_audit`.
 */
export async function upsertScreeningRule(
  platformDb: D1Database,
  input: UpsertScreeningRuleInput,
): Promise<UpsertScreeningRuleResult> {
  const validation = validateScreeningRuleInput({
    ruleType: input.ruleType,
    pattern: input.pattern,
    category: input.category,
    severity: input.severity,
    active: input.active,
    notes: input.notes,
  });
  if (!validation.ok) {
    throw new ContentScreeningError(422, "VALIDATION_ERROR", validation.message, validation.fields);
  }

  let cleanReason: string;
  try {
    cleanReason = validateOperatorReason(input.reason);
  } catch (err) {
    if (err instanceof PlatformAuditError) {
      throw new ContentScreeningError(422, "VALIDATION_ERROR", err.message, [
        { field: "reason", code: "INVALID_REASON", message: err.message },
      ]);
    }
    throw err;
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const data = validation.data;

  const existing = await platformDb
    .prepare(
      `SELECT id, rule_type, pattern, category, severity, active, rule_version,
              notes, created_by, updated_by, created_at, updated_at
       FROM content_screening_rules
       WHERE rule_type = ? AND pattern = ?
       LIMIT 1`,
    )
    .bind(data.ruleType, data.pattern)
    .first<ScreeningRuleDbRow>();

  const ruleId = existing?.id ?? generatePlatformAuditId(nowMs);
  const nextRuleVersion = existing ? Number(existing.rule_version) + 1 : 1;
  const activeInt = data.active ? 1 : 0;

  const { statement: auditStmt, entry: auditRecord } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "platform_operator",
      action: existing ? "console.screening_rule.update" : "console.screening_rule.create",
      targetType: "content_screening_rule",
      targetId: ruleId,
      tenantId: null,
      reason: cleanReason,
      requireReason: true,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        ruleType: data.ruleType,
        category: data.category,
        severity: data.severity,
        active: data.active,
        ruleVersion: nextRuleVersion,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  const mutationStmt = existing
    ? platformDb
        .prepare(
          `UPDATE content_screening_rules
           SET category = ?,
               severity = ?,
               active = ?,
               rule_version = ?,
               notes = ?,
               updated_by = ?,
               updated_at = ?
           WHERE id = ? AND rule_version = ?`,
        )
        .bind(
          data.category,
          data.severity,
          activeInt,
          nextRuleVersion,
          data.notes,
          input.actorUserId,
          nowMs,
          ruleId,
          existing.rule_version,
        )
    : platformDb
        .prepare(
          `INSERT INTO content_screening_rules (
             id, rule_type, pattern, category, severity, active, rule_version,
             notes, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ruleId,
          data.ruleType,
          data.pattern,
          data.category,
          data.severity,
          activeInt,
          nextRuleVersion,
          data.notes,
          input.actorUserId,
          input.actorUserId,
          nowMs,
          nowMs,
        );

  const batchRes = await platformDb.batch([mutationStmt, auditStmt]);
  const mutated = Number(batchRes[0]?.meta?.changes ?? 0);
  const auditWritten = Number(batchRes[1]?.meta?.changes ?? 0);

  if (mutated !== 1) {
    throw new ContentScreeningError(
      409,
      "STALE_VERSION",
      "Aturan penyaringan berubah secara bersamaan. Muat ulang dan coba lagi.",
    );
  }
  if (auditWritten !== 1) {
    throw new ContentScreeningError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal mencatat audit perubahan aturan penyaringan.",
    );
  }

  const saved = await platformDb
    .prepare(
      `SELECT id, rule_type, pattern, category, severity, active, rule_version,
              notes, created_by, updated_by, created_at, updated_at
       FROM content_screening_rules
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(ruleId)
    .first<ScreeningRuleDbRow>();

  if (!saved) {
    throw new ContentScreeningError(500, "SERVICE_UNAVAILABLE", "Gagal membaca aturan tersimpan.");
  }

  return {
    rule: mapDbRowToRule(saved),
    auditId: auditRecord.id,
    created: !existing,
  };
}
