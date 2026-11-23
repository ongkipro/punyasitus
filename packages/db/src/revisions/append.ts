import {
  MAX_CONTENT_REVISIONS_PER_RESOURCE,
  type RevisionResourceType,
  type RevisionTriggerKind,
} from "./types.ts";
import { buildRevisionSnapshotEnvelope } from "./validation.ts";

/**
 * Acyclic atomic revision append & latest-20 retention SQL statement builder
 * (`packages/db/src/revisions/append.ts`; TASK-064, REQ-048, PLAN §11.5).
 *
 * Imported by `pages`, `posts`, `catalog`, and `revisions` repositories without circular imports.
 */

export interface RevisionAppendGuard {
  readonly sql: string;
  readonly binds: readonly unknown[];
}

export interface BuildAppendRevisionStatementsParams {
  readonly resourceType: RevisionResourceType;
  readonly resourceId: number;
  readonly triggerKind: RevisionTriggerKind;
  readonly data: Record<string, unknown>;
  readonly actorUserId?: string | null;
  readonly summary?: string;
  readonly nowMs: number;
  readonly hasExtendedColumns: boolean;
  readonly guard?: RevisionAppendGuard;
  readonly maxRetained?: number;
}

/**
 * Builds the atomic `[INSERT INTO content_revisions, DELETE excess beyond latest 20]`
 * statement pair for inclusion in a single `tenantDb.batch([...])`.
 *
 * When `guard` is provided, BOTH the INSERT and retention DELETE are gated on the parent
 * write having succeeded (`WHERE <guard.sql>`), guaranteeing zero orphaned revisions on
 * concurrent `409 STALE_VERSION` races.
 */
export function buildAppendRevisionStatements(
  tenantDb: D1Database,
  params: BuildAppendRevisionStatementsParams,
): readonly D1PreparedStatement[] {
  const maxRetained = Math.max(
    1,
    Math.min(
      MAX_CONTENT_REVISIONS_PER_RESOURCE,
      params.maxRetained ?? MAX_CONTENT_REVISIONS_PER_RESOURCE,
    ),
  );
  const envelope = buildRevisionSnapshotEnvelope({
    resourceType: params.resourceType,
    triggerKind: params.triggerKind,
    data: params.data,
    summary: params.summary,
  });

  const guardWhereSql = params.guard ? `WHERE ${params.guard.sql}` : "";
  const guardBinds = params.guard ? params.guard.binds : [];
  const deleteGuardAndSql = params.guard ? `AND ${params.guard.sql}` : "";

  const insertStmt = params.hasExtendedColumns
    ? tenantDb
        .prepare(
          `INSERT INTO content_revisions (
             resource_type, resource_id, revision_number, snapshot_json,
             created_by, created_at, trigger_kind, schema_version, summary
           )
           SELECT ?, ?,
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = ? AND resource_id = ?), 0) + 1,
                  ?, ?, ?, ?, ?, ?
           ${guardWhereSql}`,
        )
        .bind(
          params.resourceType,
          params.resourceId,
          params.resourceType,
          params.resourceId,
          envelope.json,
          params.actorUserId ?? null,
          params.nowMs,
          params.triggerKind,
          envelope.schemaVersion,
          envelope.summary,
          ...guardBinds,
        )
    : tenantDb
        .prepare(
          `INSERT INTO content_revisions (
             resource_type, resource_id, revision_number, snapshot_json, created_by, created_at
           )
           SELECT ?, ?,
                  COALESCE((SELECT MAX(revision_number) FROM content_revisions WHERE resource_type = ? AND resource_id = ?), 0) + 1,
                  ?, ?, ?
           ${guardWhereSql}`,
        )
        .bind(
          params.resourceType,
          params.resourceId,
          params.resourceType,
          params.resourceId,
          envelope.json,
          params.actorUserId ?? null,
          params.nowMs,
          ...guardBinds,
        );

  const pruneStmt = tenantDb
    .prepare(
      `DELETE FROM content_revisions
       WHERE resource_type = ? AND resource_id = ?
         ${deleteGuardAndSql}
         AND revision_number NOT IN (
           SELECT revision_number
           FROM content_revisions
           WHERE resource_type = ? AND resource_id = ?
           ORDER BY revision_number DESC
           LIMIT ?
         )`,
    )
    .bind(
      params.resourceType,
      params.resourceId,
      ...guardBinds,
      params.resourceType,
      params.resourceId,
      maxRetained,
    );

  return [insertStmt, pruneStmt];
}
